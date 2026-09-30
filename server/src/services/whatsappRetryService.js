/**
 * Re-sending failed WhatsApp messages — automatically for temporary errors
 * (network, WATI busy: after 2 min, 15 min, then 1 h; WATI's usage limit:
 * hourly, once the pause ends — see whatsappLogService),
 * or on demand from the /admin monitor's Retry button. A retry reuses the
 * failed record, so one report stays one row with an attempt count.
 *
 * Only a patient's lab report or discharge summary can be re-sent: the PDF is
 * still in storage and gets a fresh link. A Lab Finder results list isn't
 * stored, so it has to be shared again from Lab Finder.
 */
import { getMongoCollection } from './mongo.js';
import { whatsappFileName, whatsappPdfUrl } from './publicLinkService.js';
import { pdfExists, reportObjectKey, reportSummaryObjectKey } from './storageService.js';
import { documentLine, sendInvestigationReportWhatsApp } from './watiService.js';
import { watiPausedUntil } from './watiBudget.js';
import { getWatiSettings } from './watiSettingsService.js';
import { dueRetries, getWhatsappRecord } from './whatsappLogService.js';

const RETRY_CHECK_MS = 60 * 1000;
const LABELS = { lab: 'Lab Report', summary: 'Discharge Summary' };

export async function retryWhatsAppMessage(id, { auto = false, triggeredBy } = {}) {
  const doc = await getWhatsappRecord(id);
  if (!doc) throw new Error('Message not found');
  if (doc.status !== 'failed') throw new Error('Only failed messages can be retried');
  if (!LABELS[doc.document] || !doc.ipNo || !doc.dischargeDate) {
    throw new Error('This message can\'t be re-sent from here — share it again from Lab Finder or Discharge Reports');
  }

  const key = doc.document === 'lab' ? reportObjectKey(doc.dischargeDate, doc.ipNo) : reportSummaryObjectKey(doc.dischargeDate, doc.ipNo);
  if (!(await pdfExists(key))) throw new Error(`The ${LABELS[doc.document].toLowerCase()} PDF is no longer available`);
  if (doc.document === 'summary') {
    const record = await (await getMongoCollection('discharge_reports')).findOne({ date: doc.dischargeDate, ipNo: doc.ipNo });
    if (record?.summaryDataMissing) throw new Error('The discharge summary has no patient data — it is never sent');
  }

  const settings = await getWatiSettings();
  await sendInvestigationReportWhatsApp({
    toNumber: doc.toNumber,
    name: doc.patientName || doc.ipNo,
    note: documentLine(LABELS[doc.document], settings.secondParam),
    pdfUrl: await whatsappPdfUrl(key, whatsappFileName(LABELS[doc.document], doc.ipNo)),
    log: { existingId: id, auto, triggeredBy: auto ? 'system' : triggeredBy },
  });
  return getWhatsappRecord(id);
}

let running = false;

async function runDueRetries() {
  // While WATI answers 429 every retry would just fail again and spend quota.
  if (running || watiPausedUntil()) return;
  running = true;
  try {
    for (const id of await dueRetries()) {
      if (watiPausedUntil()) break; // the last one hit the limit — the rest wait
      try {
        await retryWhatsAppMessage(id, { auto: true });
        console.log(`[whatsapp] automatic retry sent for message ${id}`);
      } catch (error) {
        console.warn(`[whatsapp] automatic retry failed for ${id}: ${error.message}`);
        // A send that reached WATI already recorded the failure and its next
        // retry time. One that failed before that (PDF gone, WATI not set up)
        // didn't — stop for good, or try again later, so it isn't retried every minute.
        const record = await getWhatsappRecord(id);
        if (record?.status === 'failed' && record.nextRetryAt && record.nextRetryAt <= new Date()) {
          const permanent = /can't be re-sent|no longer available|no patient data|not found/i.test(error.message);
          await (await getMongoCollection('whatsapp_messages')).updateOne(
            { _id: record._id },
            {
              $set: permanent
                ? { nextRetryAt: null, autoRetry: false, error: error.message }
                : { nextRetryAt: new Date(Date.now() + 15 * 60_000) },
            },
          );
        }
      }
    }
  } finally {
    running = false;
  }
}

export function startWhatsAppRetryWorker() {
  setInterval(() => runDueRetries().catch(() => {}), RETRY_CHECK_MS).unref?.();
}
