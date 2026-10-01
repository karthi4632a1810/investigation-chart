/**
 * WATI live-mode toggle, stored in Mongo so it survives restarts and can be
 * flipped from the admin screen without redeploying.
 *
 * - liveEnabled: false (default) — manual "Send WhatsApp" button sends to
 *   fixedNumber instead of the patient's real mobile, and the discharge
 *   automation never sends automatically. Safe default for testing.
 * - liveEnabled: true — the automation auto-sends the lab report and the
 *   discharge summary (two messages) to each patient's own mobile number as
 *   each one is generated, and the manual button also targets the real patient.
 */
import { getMongoCollection } from './mongo.js';

const COLLECTION = 'wati_settings';
const DOC_ID = 'wati';
// A single space, not '' — WATI's API has been inconsistent about accepting a
// truly empty parameter value, so a space is the safer "nothing to say" default.
// confirmBeforeSend: the WhatsApp button on a patient card first shows the
// number (test number or patient's mobile) in a popup, editable, then sends.
// labReportTemplate: the WATI template Ask AI uses for lab reports it looks
// up straight from the EMR (watiService.js DOCUMENT_TEMPLATES).
const DEFAULTS = { liveEnabled: false, fixedNumber: '+919962460782', secondParam: ' ', confirmBeforeSend: true, labReportTemplate: 'mapims_lab_rpt' };
export const LAB_REPORT_TEMPLATES = ['mapims_lab_rpt', 'investigation_report', 'investigation'];

export async function getWatiSettings() {
  const collection = await getMongoCollection(COLLECTION);
  const doc = await collection.findOne({ _id: DOC_ID });
  return doc
    ? {
        liveEnabled: Boolean(doc.liveEnabled),
        fixedNumber: doc.fixedNumber || DEFAULTS.fixedNumber,
        secondParam: doc.secondParam || ' ',
        confirmBeforeSend: doc.confirmBeforeSend ?? DEFAULTS.confirmBeforeSend,
        labReportTemplate: LAB_REPORT_TEMPLATES.includes(doc.labReportTemplate) ? doc.labReportTemplate : DEFAULTS.labReportTemplate,
      }
    : { ...DEFAULTS };
}

export async function updateWatiSettings(patch = {}) {
  const update = {};
  if (typeof patch.liveEnabled === 'boolean') update.liveEnabled = patch.liveEnabled;
  if (typeof patch.fixedNumber === 'string') update.fixedNumber = patch.fixedNumber.trim();
  if (typeof patch.secondParam === 'string') update.secondParam = patch.secondParam || ' ';
  if (typeof patch.confirmBeforeSend === 'boolean') update.confirmBeforeSend = patch.confirmBeforeSend;
  if (LAB_REPORT_TEMPLATES.includes(patch.labReportTemplate)) update.labReportTemplate = patch.labReportTemplate;

  const collection = await getMongoCollection(COLLECTION);
  await collection.updateOne({ _id: DOC_ID }, { $set: update }, { upsert: true });
  return getWatiSettings();
}
