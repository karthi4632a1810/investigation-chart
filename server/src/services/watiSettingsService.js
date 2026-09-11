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
// A single space, not '' — the template's {{2}} slot renders as a blank line
// either way, but WATI's API has been inconsistent about accepting a truly
// empty parameter value, so a space is the safer "nothing to say" default.
const DEFAULTS = { liveEnabled: false, fixedNumber: '', secondParam: ' ' };

export async function getWatiSettings() {
  const collection = await getMongoCollection(COLLECTION);
  const doc = await collection.findOne({ _id: DOC_ID });
  return doc
    ? {
        liveEnabled: Boolean(doc.liveEnabled),
        fixedNumber: doc.fixedNumber || '',
        secondParam: doc.secondParam || ' ',
      }
    : { ...DEFAULTS };
}

export async function updateWatiSettings(patch = {}) {
  const update = {};
  if (typeof patch.liveEnabled === 'boolean') update.liveEnabled = patch.liveEnabled;
  if (typeof patch.fixedNumber === 'string') update.fixedNumber = patch.fixedNumber.trim();
  if (typeof patch.secondParam === 'string') update.secondParam = patch.secondParam || ' ';

  const collection = await getMongoCollection(COLLECTION);
  await collection.updateOne({ _id: DOC_ID }, { $set: update }, { upsert: true });
  return getWatiSettings();
}
