/**
 * WATI live-mode toggle, stored in Mongo so it survives restarts and can be
 * flipped from the admin screen without redeploying.
 *
 * - liveEnabled: false (default) — manual "Send WhatsApp" button sends to
 *   fixedNumber instead of the patient's real mobile, and the discharge
 *   automation never sends automatically. Safe default for testing.
 * - liveEnabled: true — the automation auto-sends the lab report to each
 *   patient's own mobile number as soon as it's generated (never for the
 *   discharge summary), and the manual button also targets the real patient.
 */
import { getMongoCollection } from './mongo.js';

const COLLECTION = 'wati_settings';
const DOC_ID = 'wati';
const DEFAULTS = { liveEnabled: false, fixedNumber: '' };

export async function getWatiSettings() {
  const collection = await getMongoCollection(COLLECTION);
  const doc = await collection.findOne({ _id: DOC_ID });
  return doc ? { liveEnabled: Boolean(doc.liveEnabled), fixedNumber: doc.fixedNumber || '' } : { ...DEFAULTS };
}

export async function updateWatiSettings(patch = {}) {
  const update = {};
  if (typeof patch.liveEnabled === 'boolean') update.liveEnabled = patch.liveEnabled;
  if (typeof patch.fixedNumber === 'string') update.fixedNumber = patch.fixedNumber.trim();

  const collection = await getMongoCollection(COLLECTION);
  await collection.updateOne({ _id: DOC_ID }, { $set: update }, { upsert: true });
  return getWatiSettings();
}
