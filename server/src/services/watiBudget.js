/**
 * WATI API budget. Every WATI API call — sending included — counts toward the
 * account's monthly quota (Growth plan: 10,000 calls a month, reset on the 1st;
 * the EMR's own lab-report messages use the same account). Once it's used up
 * WATI answers 429 "API usage limit exceeded" to everything, so nobody gets
 * reports until the month turns.
 *
 * So: sends always go first, status checks get a small daily allowance
 * (WATI_STATUS_CHECKS_PER_DAY), and a 429 pauses status checks and automatic
 * retries for an hour (then 3 h, 6 h) instead of hammering on.
 * Counts are kept per day (IST) in Mongo for the /admin monitor.
 */
import { getMongoCollection } from './mongo.js';

const COLLECTION = 'wati_api_usage';
export const STATUS_CHECKS_PER_DAY = Math.max(0, parseInt(process.env.WATI_STATUS_CHECKS_PER_DAY || '100', 10) || 0);
const PAUSE_MS = [60, 180, 360].map((min) => min * 60_000);

let pausedUntil = 0;
let strikes = 0;
let lastRateLimit = null;

/** YYYY-MM-DD in India time — the day the counts are filed under. */
export function istDay(date = new Date()) {
  return new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** kind: 'send' | 'status' | 'other' */
export async function countWatiCall(kind, { rateLimited = false } = {}) {
  const inc = { [kind]: 1 };
  if (rateLimited) inc.rateLimited = 1;
  const c = await getMongoCollection(COLLECTION);
  await c.updateOne({ _id: istDay() }, { $inc: inc, $set: { updatedAt: new Date() } }, { upsert: true });
}

export function watiPausedUntil() {
  return pausedUntil > Date.now() ? new Date(pausedUntil) : null;
}

/** WATI said 429: pause checks and automatic retries. Returns when they resume. */
export function noteWatiRateLimited() {
  if (pausedUntil <= Date.now()) {
    pausedUntil = Date.now() + PAUSE_MS[Math.min(strikes, PAUSE_MS.length - 1)];
    strikes += 1;
    console.warn(`[wati] API usage limit (429) — status checks and automatic retries paused until ${new Date(pausedUntil).toISOString()}`);
  }
  lastRateLimit = new Date();
  return new Date(pausedUntil);
}

/** A WATI call went through: the limit has cleared. */
export function noteWatiOk() {
  strikes = 0;
  pausedUntil = 0;
}

export async function statusChecksLeftToday() {
  const c = await getMongoCollection(COLLECTION);
  const today = await c.findOne({ _id: istDay() });
  return Math.max(0, STATUS_CHECKS_PER_DAY - (today?.status || 0));
}

/** Today's and this month's calls, for the monitor. */
export async function watiUsage() {
  const c = await getMongoCollection(COLLECTION);
  const day = istDay();
  const rows = await c.find({ _id: { $gte: `${day.slice(0, 7)}-01`, $lte: day } }).toArray();
  const sum = (list) =>
    list.reduce(
      (acc, r) => ({
        send: acc.send + (r.send || 0),
        status: acc.status + (r.status || 0),
        other: acc.other + (r.other || 0),
        rateLimited: acc.rateLimited + (r.rateLimited || 0),
      }),
      { send: 0, status: 0, other: 0, rateLimited: 0 },
    );
  const withTotal = (s) => ({ ...s, total: s.send + s.status + s.other });
  return {
    today: withTotal(sum(rows.filter((r) => r._id === day))),
    month: withTotal(sum(rows)),
    statusChecksPerDay: STATUS_CHECKS_PER_DAY,
    pausedUntil: watiPausedUntil(),
    lastRateLimitAt: lastRateLimit,
  };
}
