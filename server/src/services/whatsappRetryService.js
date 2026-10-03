/**
 * Re-sending failed WhatsApp messages — automatically every 15 minutes (up to
 * WHATSAPP_RETRY_MAX tries), "not on WhatsApp" ones included since that tag is
 * sometimes wrong; WATI's usage limit: hourly once the pause ends — see
 * whatsappLogService. At most one try per phone number per round, and at most
 * WATI_RETRY_CALLS_PER_DAY automatic tries a day,
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
import { countRetry, retryCallsLeftToday, retryCallsPerDay, watiPausedUntil } from './watiBudget.js';
import { retryEveryMs } from './whatsappLogService.js';
import { setting } from './appSettingsService.js';
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

let capNoticeDay = '';

async function postpone(record) {
  await (await getMongoCollection('whatsapp_messages')).updateOne({ _id: record._id }, { $set: { nextRetryAt: new Date(Date.now() + retryEveryMs()) } });
}

async function runDueRetries() {
  // While WATI answers 429 every retry would just fail again and spend quota.
  // Retries off, or read-only mode (Master Settings): nothing goes out.
  if (running || watiPausedUntil() || !setting('retry.enabled') || setting('maintenance.readOnly')) return;
  running = true;
  try {
    // A number that just failed again: its other report waits for the next round.
    const failedNumbers = new Set();
    for (const id of await dueRetries()) {
      if (watiPausedUntil()) break; // the last one hit the limit — the rest wait
      if ((await retryCallsLeftToday()) <= 0) {
        const day = new Date().toISOString().slice(0, 10);
        if (capNoticeDay !== day) console.warn(`[whatsapp] today's ${retryCallsPerDay()} automatic retries are used up — the rest wait until tomorrow (Retry by hand still works)`);
        capNoticeDay = day;
        break;
      }
      const record = await getWhatsappRecord(id);
      if (!record || record.status !== 'failed') continue;
      if (failedNumbers.has(record.toNumber)) {
        await postpone(record);
        continue;
      }
      await countRetry().catch(() => {});
      try {
        await retryWhatsAppMessage(id, { auto: true });
        const after = await getWhatsappRecord(id);
        if (after?.status === 'failed') failedNumbers.add(record.toNumber);
        else console.log(`[whatsapp] automatic retry ${after?.attempts || ''} sent for message ${id}`);
      } catch (error) {
        failedNumbers.add(record.toNumber);
        console.warn(`[whatsapp] automatic retry failed for ${id}: ${error.message}`);
        // A send that reached WATI already recorded the failure and its next
        // retry time. One that failed before that (PDF gone, WATI not set up)
        // didn't — stop for good, or try again later, so it isn't retried every minute.
        const latest = await getWhatsappRecord(id);
        if (latest?.status === 'failed' && latest.nextRetryAt && latest.nextRetryAt <= new Date()) {
          const permanent = /can't be re-sent|no longer available|no patient data|not found/i.test(error.message);
          await (await getMongoCollection('whatsapp_messages')).updateOne(
            { _id: latest._id },
            { $set: permanent ? { nextRetryAt: null, autoRetry: false, error: error.message } : { nextRetryAt: new Date(Date.now() + retryEveryMs()) } },
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
