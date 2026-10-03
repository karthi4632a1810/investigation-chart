/**
 * Every WhatsApp message the app sends, and what happened to it afterwards —
 * the data behind the /admin WhatsApp monitor.
 *
 * A record is created as "pending" just before the WATI call, becomes "sent"
 * once WATI accepts it (or "failed" with the error), and then moves on to
 * "delivered" (grey double tick) and "read" (blue double tick) as the status
 * poller below sees WATI report them.
 *
 * Statuses arrive two ways:
 *  - WATI webhooks (handleWatiWebhook) — instant, exact times, and free: they
 *    don't count toward WATI's monthly API quota. Preferred.
 *  - A status check (getMessages per number) on a sparse schedule, within a daily
 *    allowance (watiBudget.js). WATI's list gives the *current* status, not when
 *    it changed, so deliveredAt / readAt are when the check first saw it.
 *    Checks stop on their own while webhooks are arriving.
 */
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { getMongoCollection } from './mongo.js';
import { countWatiCall, noteWatiOk, noteWatiRateLimited, statusChecksLeftToday, statusChecksPerDay, watiPausedUntil } from './watiBudget.js';
import { setting } from './appSettingsService.js';

const COLLECTION = 'whatsapp_messages';
const POLL_INTERVAL_MS = 60 * 1000;
// Every status check spends WATI's monthly API quota (the same one sending
// needs), so a message is checked only 3 times — 30 min, 6 h and 24 h after
// sending — a few numbers a minute (getMessages allows 10 calls per 10 s), within
// the daily allowance, and not at all while webhooks deliver statuses.
// WATI_STATUS_POLL=off turns scheduled checks off entirely.
const POLL_WINDOW_DAYS = 2;
const MAX_NUMBERS_PER_POLL = 3;
const MAX_NUMBERS_FORCED = 10;
const FORCE_COOLDOWN_MS = 5 * 60_000;
const CHECK_AFTER_MIN = [30, 360, 1440];
const pollEnabled = () => setting('wati.statusPolling'); // Master Settings (default: WATI_STATUS_POLL)
// Webhooks count as working if one arrived within this long.
const WEBHOOK_ACTIVE_MS = 24 * 3600_000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export const STATUSES = ['pending', 'sent', 'delivered', 'read', 'failed'];
const RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };
const WATI_STATUS = { SENT: 'sent', DELIVERED: 'delivered', READ: 'read', FAILED: 'failed' };
const TIMESTAMP_FIELD = { sent: 'acceptedAt', delivered: 'deliveredAt', read: 'readAt', failed: 'failedAt' };

let indexesReady = null;
async function collection() {
  const c = await getMongoCollection(COLLECTION);
  indexesReady ||= Promise.all([
    c.createIndex({ createdAt: -1 }),
    c.createIndex({ status: 1, createdAt: -1 }),
    c.createIndex({ watiMessageId: 1 }, { sparse: true }),
    c.createIndex({ dischargeDate: 1, ipNo: 1 }),
  ]).catch(() => {});
  await indexesReady;
  return c;
}

const digitsOnly = (n) => String(n || '').replace(/\D/g, '');

// ---- Recording sends --------------------------------------------------------

/**
 * @param entry { trigger: 'auto'|'manual'|'share', via?, triggeredBy, document:
 *   'lab'|'summary'|'lab_results', documentLabel, dischargeDate?, ipNo?,
 *   patientName?, department?, toNumber, template, liveMode? }
 * @returns the new record's id (string)
 */
export async function logSendStart(entry) {
  const now = new Date();
  const c = await collection();
  const { insertedId } = await c.insertOne({
    createdAt: now,
    trigger: entry.trigger || 'manual',
    via: entry.via || null,
    triggeredBy: entry.triggeredBy || 'system',
    document: entry.document || 'other',
    documentLabel: entry.documentLabel || '',
    dischargeDate: entry.dischargeDate || null,
    ipNo: entry.ipNo || null,
    patientName: entry.patientName || '',
    // The template's "Dear …" name when it isn't the patient's (test messages).
    recipientName: entry.recipientName || null,
    department: entry.department || '',
    toNumber: digitsOnly(entry.toNumber),
    liveMode: Boolean(entry.liveMode),
    // Staff changed the number in the confirm popup before sending.
    numberEdited: Boolean(entry.numberEdited),
    // A UHID (Ask AI lab lookups have no IP number).
    uhid: entry.uhid || null,
    template: entry.template || '',
    status: 'pending',
    history: [{ status: 'pending', at: now, source: 'app', note: 'Send started' }],
  });
  return String(insertedId);
}

// WATI's "validWhatsAppNumber: false" (raised as "… is not a WhatsApp number" in
// watiService.js), and WhatsApp's own wording when a recipient isn't on it.
const NOT_ON_WHATSAPP = /not (a|on) whatsapp|not a valid whatsapp|invalid whatsapp|not.*whatsapp user|131026/i;
export const isNotOnWhatsApp = (text) => NOT_ON_WHATSAPP.test(String(text || ''));

// Automatic retries for temporary failures: after 2 min, 15 min, then 1 hour.
// Automatic retries — light on WATI's quota, patient enough for a phone that's
// off for days: every few hours for a few days (Master Settings → Automatic retries;
// defaults 6 hours for 3 days, from WHATSAPP_RETRY_HOURS / WHATSAPP_RETRY_DAYS)
// days — 4 tries a day, 12 in all. For "not on WhatsApp" too, which is sometimes
// wrong: WhatsApp's "undeliverable" (131026) is often temporary (phone off or
// data off, old app, new terms not accepted), and staff saw manual retries go
// through. Ordinary failures (network, WATI busy) get one quick retry after 15
// minutes first. The retry worker also caps the calls per day (watiBudget.js).
// All from Master Settings (appSettingsService.js), read when needed so a change applies at once.
export const retryEveryMs = () => setting('retry.everyHours') * 3600_000;
const quickRetryMs = () => setting('retry.quickMinutes') * 60_000;
const retryWindowMs = () => setting('retry.forDays') * 86400_000;
// First send + quick retry + the regular ones over the window.
export const maxAttempts = () => Math.ceil((setting('retry.forDays') * 24) / setting('retry.everyHours')) + 2;
export const retryPolicy = () => ({ hours: setting('retry.everyHours'), days: setting('retry.forDays'), quickMinutes: setting('retry.quickMinutes'), enabled: setting('retry.enabled'), notOnWhatsApp: setting('retry.notOnWhatsApp') });
// Errors a resend can't fix — these wait for a person (Retry button) instead.
const PERMANENT_ERROR = /template|not configured|required|blocked/i;
// WATI's quota / rate limit: nothing is wrong with the message, so it's retried
// hourly (or when the pause ends) for about a day instead of giving up after 4.
export const RATE_LIMITED = /\b429\b|usage limit/i;
const MAX_RATE_LIMITED_ATTEMPTS = 30;
const RATE_LIMITED_RETRY_MS = 60 * 60_000;

/** Only patient reports can be re-sent without a person — a results list isn't stored. */
function canAutoRetry(doc, error) {
  if (!['lab', 'summary'].includes(doc?.document) || !doc.ipNo || !doc.dischargeDate) return false;
  if (!setting('retry.enabled')) return false;
  if (!setting('retry.notOnWhatsApp') && (isNotOnWhatsApp(error) || /undeliverable|131026/i.test(String(error || '')))) return false;
  if (RATE_LIMITED.test(String(error || ''))) return (doc.attempts || 1) < MAX_RATE_LIMITED_ATTEMPTS;
  // Within the retry window (3 days from the first send), under the try limit.
  const age = Date.now() - new Date(doc.createdAt || Date.now()).getTime();
  return !PERMANENT_ERROR.test(String(error || '')) && (doc.attempts || 1) < maxAttempts() && age < retryWindowMs();
}

function retryTime(doc, error, now) {
  if (RATE_LIMITED.test(String(error || ''))) {
    const paused = watiPausedUntil();
    return new Date(Math.max(now.getTime() + RATE_LIMITED_RETRY_MS, paused ? paused.getTime() + 60_000 : 0));
  }
  // A plain failure gets one quick retry; after that (and for "not on WhatsApp") every 6 hours.
  const quick = quickRetryMs() > 0 && (doc.attempts || 1) === 1 && !isNotOnWhatsApp(error) && !/undeliverable|131026/i.test(String(error || ''));
  return new Date(now.getTime() + (quick ? quickRetryMs() : retryEveryMs()));
}

/** WATI accepted the message (or refused it). */
export async function logSendResult(id, { ok, error, response }) {
  if (!id) return;
  const now = new Date();
  const c = await collection();
  const _id = new ObjectId(id);
  if (ok) {
    const ids = [response?.model?.ids, response?.localMessageId, response?.id].flat().filter((v) => typeof v === 'string' && v);
    const accepted = { validWhatsAppNumber: response?.validWhatsAppNumber ?? null, nextRetryAt: null, ...(ids.length ? { watiSendIds: ids } : {}) };
    // A webhook can get here first and move the record past "sent" — don't undo it.
    const moved = await c.updateOne(
      { _id, status: 'pending' },
      {
        $set: { status: 'sent', acceptedAt: now, ...accepted },
        $push: { history: { status: 'sent', at: now, source: 'app', note: 'Accepted by WATI' } },
      },
    );
    if (!moved.matchedCount) await c.updateOne({ _id }, { $set: accepted });
    return;
  }
  const doc = await c.findOne({ _id }, { projection: { document: 1, ipNo: 1, dischargeDate: 1, attempts: 1, createdAt: 1 } });
  const message = String(error || 'Send failed').slice(0, 500);
  const retry = canAutoRetry(doc, message);
  const nextRetryAt = retry ? retryTime(doc, message, now) : null;
  await c.updateOne(
    { _id },
    {
      $set: { status: 'failed', failedAt: now, error: message, nextRetryAt, autoRetry: retry, notOnWhatsApp: isNotOnWhatsApp(message), rateLimited: RATE_LIMITED.test(message) },
      $push: {
        history: {
          status: 'failed',
          at: now,
          source: 'app',
          note: `${message.slice(0, 200)}${retry ? ' — will retry automatically' : ''}`,
        },
      },
    },
  );
}

/** Reuses a failed record for a resend, so one report stays one row. */
export async function logRetryStart(id, { auto = false, triggeredBy } = {}) {
  const c = await collection();
  const _id = new ObjectId(id);
  const doc = await c.findOne({ _id }, { projection: { attempts: 1 } });
  const attempt = (doc?.attempts || 1) + 1;
  const now = new Date();
  await c.updateOne(
    { _id },
    {
      $set: {
        status: 'pending',
        attempts: attempt,
        nextRetryAt: null,
        watiMessageId: null,
        watiStatus: null,
        whatsappMessageId: null,
        watiLocalMessageId: null,
        watiSendIds: null,
        failedDetail: null,
        acceptedAt: null,
        deliveredAt: null,
        readAt: null,
        notOnWhatsApp: false,
        rateLimited: false,
      },
      $unset: { nextCheckAt: '', lastCheckedAt: '' },
      $push: {
        history: { status: 'pending', at: now, source: 'app', note: `Retry ${attempt - 1} — ${auto ? 'automatic' : `by ${triggeredBy || 'staff'}`}` },
      },
    },
  );
  return id;
}

/** Failed messages whose automatic retry is due. */
export async function dueRetries(limit = 30) {
  const c = await collection();
  return c
    .find({ status: 'failed', nextRetryAt: { $ne: null, $lte: new Date() } }, { projection: { _id: 1 } })
    .limit(limit)
    .toArray()
    .then((docs) => docs.map((d) => String(d._id)));
}

/** A raw record (with _id as a string) — for the retry service. */
export async function getWhatsappRecord(id) {
  if (!ObjectId.isValid(id)) return null;
  const c = await collection();
  const doc = await c.findOne({ _id: new ObjectId(id) });
  return doc ? { ...doc, id: String(doc._id) } : null;
}

/** Moves a record forward (never backward); failed ends it. */
async function applyStatus(c, doc, status, { at = new Date(), source = 'wati', note, extra = {} } = {}) {
  if (!status || doc.status === status || doc.status === 'failed') {
    if (Object.keys(extra).length) await c.updateOne({ _id: doc._id }, { $set: extra });
    return false;
  }
  if (status !== 'failed' && RANK[status] <= (RANK[doc.status] ?? -1)) {
    if (Object.keys(extra).length) await c.updateOne({ _id: doc._id }, { $set: extra });
    return false;
  }
  const set = { status, ...extra };
  set[TIMESTAMP_FIELD[status]] = at;
  // Skipped steps (sent → read between two polls) still get a timestamp.
  if (status === 'read' && !doc.deliveredAt) set.deliveredAt = at;
  if ((status === 'read' || status === 'delivered') && !doc.acceptedAt) set.acceptedAt = at;
  await c.updateOne({ _id: doc._id }, { $set: set, $push: { history: { status, at, source, note: note || null } } });
  return true;
}

// ---- Polling WATI for delivered / read ------------------------------------

function watiHeaders() {
  return { Authorization: config.wati.accessToken, Accept: 'application/json', 'User-Agent': UA };
}

class RateLimitedError extends Error {}

async function fetchWatiMessages(number, pageSize = 20) {
  const res = await fetch(`${config.wati.endpoint}/api/v1/getMessages/${number}?pageSize=${pageSize}&pageNumber=1`, {
    headers: watiHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) {
    countWatiCall('status', { rateLimited: true }).catch(() => {});
    noteWatiRateLimited();
    throw new RateLimitedError('WATI API usage limit exceeded (429)');
  }
  countWatiCall('status').catch(() => {});
  if (!res.ok) throw new Error(`WATI getMessages ${res.status}`);
  noteWatiOk();
  const data = await res.json();
  return (data.messages?.items || []).filter((m) => m.eventType === 'broadcastMessage' || m.eventType === 'message');
}

/** Picks the WATI message for our record: same document line, patient name, sent within a few minutes. */
function matchWatiItem(doc, items, claimed) {
  const sentAt = new Date(doc.acceptedAt || doc.createdAt).getTime();
  const firstName = String(doc.recipientName || doc.patientName || '').split(/[\s.]+/).filter((w) => w.length > 2)[0] || '';
  // Reports carry "Attached: <document>"; a test message carries only the typed text.
  const label = ['lab', 'summary', 'lab_results'].includes(doc.document) ? doc.documentLabel : '';
  let best = null;
  for (const item of items) {
    if (claimed.has(item.id)) continue;
    const created = new Date(item.created).getTime();
    const delta = created - sentAt;
    if (delta < -120_000 || delta > 10 * 60_000) continue;
    const text = String(item.finalText ?? item.text ?? '');
    if (label && text && !text.includes(`Attached: ${label}`)) continue;
    if (firstName && text && !text.toUpperCase().includes(firstName.toUpperCase())) continue;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { item, delta };
  }
  return best?.item || null;
}

let pollRunning = false;
let lastPoll = { at: null, checked: 0, updated: 0, error: null, skipped: null };
let lastForcedAt = 0;
let lastWebhookAt = null;
let webhookEventsSinceStart = 0;

const webhookActive = () => Boolean(lastWebhookAt && Date.now() - lastWebhookAt.getTime() < WEBHOOK_ACTIVE_MS);

export function getPollState() {
  return {
    ...lastPoll,
    intervalSeconds: POLL_INTERVAL_MS / 1000,
    enabled: pollEnabled(),
    schedule: CHECK_AFTER_MIN,
    dailyChecks: statusChecksPerDay(),
    pausedUntil: watiPausedUntil(),
    webhook: { active: webhookActive(), lastEventAt: lastWebhookAt, eventsSinceStart: webhookEventsSinceStart },
  };
}

/** When a message should next be checked, given how long ago it was sent. */
function nextCheckTime(doc, now = Date.now()) {
  const sent = new Date(doc.acceptedAt || doc.createdAt).getTime();
  for (const min of CHECK_AFTER_MIN) {
    const at = sent + min * 60_000;
    if (at > now) return new Date(at);
  }
  return null; // past the window — stop checking
}

/**
 * One pass over messages whose next check is due (see CHECK_AFTER_MIN), a few
 * numbers at a time, within the daily allowance. Skipped while webhooks are
 * delivering statuses or WATI has said 429. `force` (the "Check WATI now"
 * button) checks up to 10 open numbers once — at most every 5 minutes.
 */
export async function pollWhatsAppStatuses({ force = false } = {}) {
  if (pollRunning || !config.wati.endpoint || !config.wati.accessToken) return getPollState();
  const skip = (reason) => {
    lastPoll = { ...lastPoll, skipped: reason };
    return getPollState();
  };
  if (watiPausedUntil()) return skip('WATI usage limit — paused');
  if (force && Date.now() - lastForcedAt < FORCE_COOLDOWN_MS) {
    return skip(`Checked less than ${FORCE_COOLDOWN_MS / 60_000} minutes ago`);
  }
  if (!force && !pollEnabled()) return skip('Status checks turned off (Master Settings)');
  if (!force && webhookActive()) return skip('Webhooks deliver statuses');
  let budget = await statusChecksLeftToday().catch(() => 0);
  if (budget <= 0) return skip(`Today's ${statusChecksPerDay()} status checks are used up`);

  pollRunning = true;
  if (force) lastForcedAt = Date.now();
  let checked = 0;
  let updated = 0;
  let error = null;
  try {
    const c = await collection();
    const now = new Date();
    const since = new Date(now.getTime() - POLL_WINDOW_DAYS * 86400_000);
    const open = { createdAt: { $gte: since }, status: { $in: ['sent', 'delivered'] } };
    const due = force ? open : { ...open, $or: [{ nextCheckAt: { $exists: false } }, { nextCheckAt: { $lte: now } }] };
    const docs = await c.find(due).sort({ nextCheckAt: 1, createdAt: 1 }).limit(200).toArray();
    const byNumber = new Map();
    for (const doc of docs) {
      // A new message isn't due until its first check, 30 min after sending.
      const firstDue = new Date(new Date(doc.acceptedAt || doc.createdAt).getTime() + CHECK_AFTER_MIN[0] * 60_000);
      if (!force && !doc.lastCheckedAt && firstDue > now) {
        if (!doc.nextCheckAt) await c.updateOne({ _id: doc._id }, { $set: { nextCheckAt: firstDue } });
        continue;
      }
      if (!byNumber.has(doc.toNumber)) byNumber.set(doc.toNumber, []);
      byNumber.get(doc.toNumber).push(doc);
    }
    const limit = Math.min(force ? MAX_NUMBERS_FORCED : MAX_NUMBERS_PER_POLL, budget);
    for (const [number, list] of [...byNumber].slice(0, limit)) {
      let items;
      try {
        items = await fetchWatiMessages(number);
        budget -= 1;
      } catch (err) {
        error = err.message;
        if (err instanceof RateLimitedError) break;
        continue;
      }
      const byId = new Map(items.map((m) => [m.id, m]));
      const claimed = new Set((await c.distinct('watiMessageId', { toNumber: number, watiMessageId: { $ne: null } })) || []);
      // Oldest first, so each record claims the nearest-in-time WATI message.
      list.sort((a, b) => a.createdAt - b.createdAt);
      for (const doc of list) {
        checked += 1;
        const item = doc.watiMessageId ? byId.get(doc.watiMessageId) : matchWatiItem(doc, items, claimed);
        const schedule = { lastCheckedAt: new Date(), nextCheckAt: nextCheckTime(doc) };
        if (!item) {
          await c.updateOne({ _id: doc._id }, { $set: schedule });
          continue;
        }
        claimed.add(item.id);
        const status = WATI_STATUS[String(item.statusString || '').toUpperCase()];
        const extra = { watiMessageId: item.id, watiStatus: item.statusString || null, ...schedule };
        if (status === 'read' || status === 'failed') extra.nextCheckAt = null; // final — no more checks
        if (item.failedDetail) extra.failedDetail = String(item.failedDetail).slice(0, 500);
        if (status === 'failed') {
          extra.error = String(item.failedDetail || 'WATI reported the message as failed').slice(0, 500);
          extra.notOnWhatsApp = isNotOnWhatsApp(item.failedDetail);
          extra.autoRetry = canAutoRetry(doc, extra.error);
          extra.nextRetryAt = extra.autoRetry ? retryTime(doc, extra.error, new Date()) : null;
        }
        const changed = await applyStatus(c, doc, status, {
          note: status === 'failed' ? item.failedDetail || 'WATI reported failed' : `WATI: ${item.statusString}`,
          extra,
        });
        if (changed) updated += 1;
      }
    }
  } catch (err) {
    error = err.message;
  } finally {
    lastPoll = { at: new Date(), checked, updated, error, skipped: null };
    pollRunning = false;
  }
  return getPollState();
}

// ---- One message, on demand (Ask AI's "Check status") ------------------------

const lastSingleCheck = new Map();

/** A message's current state, short — for a chat card. */
export function messageState(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    status: doc.status,
    notOnWhatsApp: Boolean(doc.notOnWhatsApp),
    error: doc.status === 'failed' ? doc.failedDetail || doc.error || null : null,
    reason: doc.status === 'failed' ? failureCategory(doc) : null,
    toNumber: doc.toNumber,
    sentAt: doc.acceptedAt || doc.createdAt,
    deliveredAt: doc.deliveredAt || null,
    readAt: doc.readAt || null,
    lastCheckedAt: doc.lastCheckedAt || doc.lastWebhookAt || null,
  };
}

/**
 * Asks WATI for this message's number once (at most every 30 s per message,
 * not while WATI is refusing calls) and updates its status. Webhooks make
 * this unnecessary — then it just returns the stored state.
 */
export async function checkMessageStatus(id, { ask = true } = {}) {
  if (!ObjectId.isValid(id)) return null;
  const c = await collection();
  const doc = await c.findOne({ _id: new ObjectId(id) });
  if (!doc) return null;
  const open = ['sent', 'delivered'].includes(doc.status);
  const recent = Date.now() - (lastSingleCheck.get(id) || 0) < 30_000;
  if (ask && open && !recent && !watiPausedUntil() && config.wati.endpoint && config.wati.accessToken) {
    lastSingleCheck.set(id, Date.now());
    try {
      const items = await fetchWatiMessages(doc.toNumber);
      const claimed = new Set((await c.distinct('watiMessageId', { toNumber: doc.toNumber, watiMessageId: { $ne: null }, _id: { $ne: doc._id } })) || []);
      const item = doc.watiMessageId ? items.find((m) => m.id === doc.watiMessageId) : matchWatiItem(doc, items, claimed);
      if (item) {
        const status = WATI_STATUS[String(item.statusString || '').toUpperCase()];
        const extra = { watiMessageId: item.id, watiStatus: item.statusString || null, lastCheckedAt: new Date() };
        if (status === 'failed') {
          extra.error = String(item.failedDetail || 'WATI reported the message as failed').slice(0, 500);
          extra.failedDetail = extra.error;
          extra.notOnWhatsApp = isNotOnWhatsApp(item.failedDetail);
        }
        await applyStatus(c, doc, status, { note: `WATI: ${item.statusString}`, extra });
      } else {
        await c.updateOne({ _id: doc._id }, { $set: { lastCheckedAt: new Date() } });
      }
    } catch {
      // WATI unreachable / refusing — keep the stored state
    }
  }
  return messageState(await c.findOne({ _id: doc._id }));
}

// ---- WATI webhooks ----------------------------------------------------------

const WEBHOOK_FLAG = { _id: 'wati_webhook_last_event' };

/** eventType → our status. "Replied" means they opened it, so it counts as read. */
function webhookStatus(eventType) {
  const t = String(eventType || '');
  if (/^templateMessageSent/i.test(t)) return 'sent';
  if (/^sentMessageDELIVERED/i.test(t)) return 'delivered';
  if (/^sentMessage(READ|REPLIED)/i.test(t)) return 'read';
  if (/^templateMessageFailed/i.test(t) || /failed/i.test(t)) return 'failed';
  return null;
}

function webhookTime(event) {
  if (event.created) {
    const d = new Date(event.created);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const ts = Number(event.timestamp);
  return Number.isFinite(ts) && ts > 0 ? new Date(ts * (ts < 1e12 ? 1000 : 1)) : new Date();
}

/**
 * One WATI webhook event (Connectors → Webhooks in WATI). "Template Message
 * Sent" carries the number and text, so it's matched to our record like a
 * status check would; it brings WhatsApp's message id, which Delivered / Read /
 * Failed then carry. Events for messages we didn't send (the EMR's own
 * templates on the same account) are ignored.
 */
export async function handleWatiWebhook(event) {
  const status = webhookStatus(event?.eventType);
  if (!status) return { matched: false, reason: 'not a message status event' };
  // Only status events count as "webhook connected" — that's what lets the
  // status checks stop (a webhook for incoming messages alone wouldn't do).
  lastWebhookAt = new Date();
  webhookEventsSinceStart += 1;
  getMongoCollection('app_flags')
    .then((f) => f.updateOne(WEBHOOK_FLAG, { $set: { at: lastWebhookAt, eventType: String(event?.eventType || '') } }, { upsert: true }))
    .catch(() => {});

  const c = await collection();
  const ids = [event.whatsappMessageId, event.localMessageId, event.id].filter((v) => typeof v === 'string' && v);
  let doc = ids.length
    ? await c.findOne({
        $or: [{ whatsappMessageId: { $in: ids } }, { watiLocalMessageId: { $in: ids } }, { watiMessageId: { $in: ids } }, { watiSendIds: { $in: ids } }],
      })
    : null;

  const at = webhookTime(event);
  if (!doc && event.waId) {
    const number = digitsOnly(event.waId);
    const candidates = await c
      .find({
        toNumber: number.length === 10 ? `91${number}` : number,
        whatsappMessageId: null,
        status: { $in: ['pending', 'sent'] },
        createdAt: { $gte: new Date(at.getTime() - 15 * 60_000), $lte: new Date(at.getTime() + 2 * 60_000) },
      })
      .sort({ createdAt: 1 })
      .toArray();
    const item = { id: ids[0] || 'webhook', created: at, finalText: event.text ?? '' };
    doc = candidates.find((d) => matchWatiItem(d, [item], new Set())) || null;
  }
  if (!doc) return { matched: false, reason: 'no matching message' };

  const extra = {
    watiStatus: event.statusString || null,
    lastWebhookAt: new Date(),
    ...(event.whatsappMessageId ? { whatsappMessageId: event.whatsappMessageId } : {}),
    ...(event.localMessageId ? { watiLocalMessageId: event.localMessageId } : {}),
    ...(status === 'sent' && event.id && !doc.watiMessageId ? { watiMessageId: event.id } : {}),
  };
  if (status === 'read' || status === 'failed') extra.nextCheckAt = null;
  if (status === 'failed') {
    const detail = [event.failedDetail, event.failedCode && `(code ${event.failedCode})`].filter(Boolean).join(' ') || 'WATI reported the message as failed';
    extra.failedDetail = detail.slice(0, 500);
    extra.error = detail.slice(0, 500);
    extra.notOnWhatsApp = isNotOnWhatsApp(detail) || String(event.failedCode) === '131026';
    extra.autoRetry = canAutoRetry(doc, detail);
    extra.nextRetryAt = extra.autoRetry ? retryTime(doc, detail, new Date()) : null;
  }
  const changed = await applyStatus(c, doc, status, {
    at,
    source: 'webhook',
    note: status === 'failed' ? extra.failedDetail : `WATI webhook: ${event.statusString || status}`,
    extra,
  });
  return { matched: true, id: String(doc._id), status, changed };
}

/**
 * Reports WATI refused only because of its usage limit in the last 2 days go
 * back in the retry queue (at startup — e.g. sends that failed before automatic
 * retries existed). Anything that failed for another reason is left alone.
 */
export async function requeueRateLimitedSends() {
  const c = await collection();
  const docs = await c
    .find(
      {
        status: 'failed',
        createdAt: { $gte: new Date(Date.now() - retryWindowMs()) },
        document: { $in: ['lab', 'summary'] },
        ipNo: { $ne: null },
        dischargeDate: { $ne: null },
        nextRetryAt: null,
      },
      { projection: { document: 1, ipNo: 1, dischargeDate: 1, attempts: 1, error: 1, failedDetail: 1, createdAt: 1 } },
    )
    .toArray();
  // Not on WhatsApp / ordinary failures under the try limit, and WATI-limit refusals.
  const ids = docs.filter((d) => canAutoRetry(d, d.failedDetail || d.error)).map((d) => d._id);
  if (!ids.length) return 0;
  const { modifiedCount } = await c.updateMany({ _id: { $in: ids } }, { $set: { nextRetryAt: new Date(Date.now() + 2 * 60_000), autoRetry: true } });
  return modifiedCount;
}

/** Remembers when the last webhook came in, across restarts. */
async function loadWebhookState() {
  const flag = await (await getMongoCollection('app_flags')).findOne(WEBHOOK_FLAG).catch(() => null);
  if (flag?.at) lastWebhookAt = new Date(flag.at);
}

// ---- One-time import of messages sent before logging existed ---------------

const IMPORT_FLAG = { _id: 'whatsapp_history_imported' };

/**
 * Brings earlier template messages for the given numbers (the test number —
 * live mode has never been on) into the log, marked imported, so the monitor
 * isn't empty on day one. Runs once; later sends are logged as they happen.
 */
export async function importWatiHistory(numbers) {
  if (!config.wati.endpoint || !config.wati.accessToken) return 0;
  const flags = await getMongoCollection('app_flags');
  if (await flags.findOne(IMPORT_FLAG)) return 0;
  const c = await collection();
  let imported = 0;
  for (const raw of numbers) {
    const number = digitsOnly(raw).length === 10 ? `91${digitsOnly(raw)}` : digitsOnly(raw);
    if (number.length < 11) continue;
    let items;
    try {
      items = await fetchWatiMessages(number, 100);
    } catch {
      continue;
    }
    for (const item of items.filter((m) => m.eventType === 'broadcastMessage')) {
      if (await c.findOne({ watiMessageId: item.id })) continue;
      const text = String(item.finalText || '');
      const documentLabel = /Attached: (Lab Report|Discharge Summary|Lab Results Report)/.exec(text)?.[1] || '';
      const document = { 'Lab Report': 'lab', 'Discharge Summary': 'summary', 'Lab Results Report': 'lab_results' }[documentLabel] || 'other';
      const created = new Date(item.created);
      const status = WATI_STATUS[String(item.statusString || '').toUpperCase()] || 'sent';
      // WATI doesn't say when a message was delivered or read, so the one
      // history entry carries the current status at the send time.
      const history = [{ status, at: created, source: 'import', note: `Imported from WATI history — ${item.statusString || 'sent'}` }];
      await c.insertOne({
        createdAt: created,
        trigger: 'imported',
        via: null,
        triggeredBy: 'unknown',
        document,
        documentLabel,
        dischargeDate: null,
        ipNo: null,
        patientName: /^Dear ([^,\n]+),/.exec(text)?.[1]?.trim() || '',
        department: '',
        toNumber: number,
        liveMode: false,
        template: /using "([^"]+)" template/.exec(item.eventDescription || '')?.[1] || '',
        status,
        acceptedAt: created,
        watiMessageId: item.id,
        watiStatus: item.statusString || null,
        failedDetail: item.failedDetail || null,
        imported: true,
        history,
      });
      imported += 1;
    }
  }
  await flags.updateOne(IMPORT_FLAG, { $set: { at: new Date(), imported } }, { upsert: true });
  return imported;
}

export function startWhatsAppStatusPoller(numbersToImport = []) {
  loadWebhookState().catch(() => {});
  requeueRateLimitedSends()
    .then((n) => n && console.log(`[whatsapp] ${n} failed / not-on-WhatsApp report(s) from the last ${setting('retry.forDays')} days put back in the retry queue`))
    .catch(() => {});
  backfillNotOnWhatsAppFlag()
    .then((n) => n && console.log(`[whatsapp] marked ${n} earlier failure(s) as "not on WhatsApp"`))
    .catch(() => {});
  importWatiHistory(numbersToImport)
    .then((n) => n && console.log(`[whatsapp] imported ${n} earlier message(s) from WATI history`))
    .catch((error) => console.warn(`[whatsapp] history import skipped: ${error.message}`))
    .finally(() => {
      pollWhatsAppStatuses().catch(() => {});
      setInterval(() => pollWhatsAppStatuses().catch(() => {}), POLL_INTERVAL_MS).unref?.();
    });
}

// ---- Reading: analytics, list, detail, activity ----------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = 'Asia/Kolkata';

/** YYYY-MM-DD (IST) → Date at that IST midnight. */
function istMidnight(day) {
  return new Date(`${day}T00:00:00+05:30`);
}

/**
 * The date range, by one of two dates (the monitor's "Dates by" switch):
 *  - 'sent' (default): when the message was sent.
 *  - 'report': the patient's discharge date — the date their reports are filed
 *    under. "Today" then means today's patients only, even if some of
 *    yesterday's reports were (re)sent today. Messages that aren't a patient's
 *    report (Lab Finder lists, tests) have no discharge date and drop out.
 */
const isReportBasis = (basis) => basis === 'report';

// Optional time of day (HH:MM, India time): the range then runs from
// `from` at fromTime to `to` at toTime — "today 10:00–14:00", or overnight
// "yesterday 20:00 → today 08:00".
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function timeWindow(q = {}) {
  const fromTime = TIME_RE.test(q.fromTime || '') ? q.fromTime : null;
  const toTime = TIME_RE.test(q.toTime || '') ? q.toTime : null;
  return fromTime || toTime ? { fromTime: fromTime || '00:00', toTime: toTime || '23:59' } : null;
}
const istAt = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);

/** The EMR discharge time ("29-09-2026 12:24", India time) as a Date, or null. */
export function dischargeMoment(record) {
  const m = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(record?.dischargeDate || ''));
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4].padStart(2, '0')}:${m[5]}:00+05:30`) : null;
}

/** IP numbers of patients discharged between `from` fromTime and `to` toTime. */
export async function dischargedInWindow(from, to, win) {
  const start = istAt(from, win.fromTime).getTime();
  const end = istAt(to, win.toTime).getTime() + 60_000;
  const rows = await (await getMongoCollection('discharge_reports'))
    .find({ date: { $gte: from, $lte: to } }, { projection: { _id: 0, ipNo: 1, dischargeDate: 1 } })
    .toArray();
  return rows.filter((r) => {
    const t = dischargeMoment(r)?.getTime();
    return t >= start && t < end;
  });
}

function rangeFilter(from, to, basis, win) {
  const f = DATE_RE.test(from || '') ? from : null;
  const t = DATE_RE.test(to || '') ? to : null;
  if (isReportBasis(basis)) {
    const dischargeDate = { $ne: null };
    if (f) dischargeDate.$gte = f;
    if (t) dischargeDate.$lte = t;
    return { dischargeDate };
  }
  const createdAt = {};
  if (f) createdAt.$gte = win ? istAt(f, win.fromTime) : istMidnight(f);
  if (t) createdAt.$lt = win ? new Date(istAt(t, win.toTime).getTime() + 60_000) : new Date(istMidnight(t).getTime() + 86400_000);
  return Object.keys(createdAt).length ? { createdAt } : {};
}

/** A message's day (YYYY-MM-DD) for charts — by the same date the range uses. */
const dayOf = (basis) => (isReportBasis(basis) ? '$dischargeDate' : { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: TZ } });

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Filter values beyond the plain statuses — the "Needs attention" shortcuts.
const SPECIAL_STATUS = {
  nowa: () => ({ status: 'failed', notOnWhatsApp: true }),
  fixable: () => ({ status: 'failed', notOnWhatsApp: { $ne: true } }),
  unread24: () => ({ status: 'delivered', deliveredAt: { $lte: new Date(Date.now() - 24 * 3600_000) } }),
  stuck6: () => ({ status: 'sent', acceptedAt: { $lte: new Date(Date.now() - 6 * 3600_000) } }),
};

function buildFilter(q = {}) {
  const filter = { ...rangeFilter(q.from, q.to, q.basis, timeWindow(q)) };
  const and = [];
  const statuses = String(q.status || '')
    .split(',')
    .filter((s) => STATUSES.includes(s) || SPECIAL_STATUS[s]);
  if (statuses.length) {
    const plain = statuses.filter((s) => !SPECIAL_STATUS[s]);
    const either = [];
    // "failed" means failed to send — the "not on WhatsApp" ones are their own filter (nowa).
    const others = plain.filter((st) => st !== 'failed');
    if (others.length) either.push({ status: { $in: others } });
    if (plain.includes('failed')) either.push({ status: 'failed', notOnWhatsApp: { $ne: true } });
    for (const s of statuses) if (SPECIAL_STATUS[s]) either.push(SPECIAL_STATUS[s]());
    and.push({ $or: either });
  }
  if (['lab', 'summary', 'lab_results', 'other'].includes(q.document)) filter.document = q.document;
  if (['auto', 'manual', 'share', 'imported'].includes(q.trigger)) filter.trigger = q.trigger;
  const search = String(q.q || '').trim().slice(0, 60);
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    and.push({ $or: [{ patientName: rx }, { ipNo: rx }, { toNumber: { $regex: escapeRegex(search.replace(/\D/g, '') || search) } }, { triggeredBy: rx }] });
  }
  if (and.length) filter.$and = and;
  return filter;
}

/**
 * buildFilter, plus — for "Report date" with a time window — only the
 * patients whose EMR discharge time falls inside it.
 */
async function resolveFilter(q = {}) {
  const filter = buildFilter(q);
  const win = timeWindow(q);
  if (win && isReportBasis(q.basis) && DATE_RE.test(q.from || '') && DATE_RE.test(q.to || '')) {
    filter.ipNo = { $in: (await dischargedInWindow(q.from, q.to, win)).map((r) => r.ipNo) };
  }
  return filter;
}

const secs = (a, b) => ({ $divide: [{ $subtract: [a, b] }, 1000] });

export async function whatsappSummary(q = {}) {
  const c = await collection();
  const match = await resolveFilter(q);
  const from = DATE_RE.test(q.from || '') ? q.from : null;
  const to = DATE_RE.test(q.to || '') ? q.to : null;
  const hourly = from && to && from === to;

  const [facets] = await c
    .aggregate([
      { $match: match },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
          notOnWhatsApp: [
            { $match: { status: 'failed', notOnWhatsApp: true } },
            { $group: { _id: '$toNumber', n: { $sum: 1 } } },
            { $group: { _id: null, messages: { $sum: '$n' }, numbers: { $sum: 1 } } },
          ],
          byDocument: [{ $group: { _id: '$document', n: { $sum: 1 } } }],
          retrying: [{ $match: { status: 'failed', nextRetryAt: { $ne: null } } }, { $count: 'n' }],
          byTrigger: [{ $group: { _id: '$trigger', n: { $sum: 1 } } }],
          series: [
            {
              $group: {
                _id: {
                  // One day: by hour sent. Longer: by day (sent, or the report date).
                  bucket: hourly ? { $dateToString: { date: '$createdAt', format: '%H', timezone: TZ } } : dayOf(q.basis),
                  // "Not on WhatsApp" is its own series, apart from other failures.
                  status: { $cond: [{ $and: [{ $eq: ['$status', 'failed'] }, { $eq: ['$notOnWhatsApp', true] }] }, 'nowa', '$status'] },
                },
                n: { $sum: 1 },
              },
            },
          ],
          timing: [
            { $match: { imported: { $ne: true } } },
            {
              $group: {
                _id: null,
                toDeliver: { $avg: { $cond: [{ $and: ['$deliveredAt', '$acceptedAt'] }, secs('$deliveredAt', '$acceptedAt'), null] } },
                toRead: { $avg: { $cond: [{ $and: ['$readAt', '$acceptedAt'] }, secs('$readAt', '$acceptedAt'), null] } },
              },
            },
          ],
          patients: [{ $match: { ipNo: { $ne: null } } }, { $group: { _id: { d: '$dischargeDate', ip: '$ipNo' } } }, { $count: 'n' }],
        },
      },
    ])
    .toArray();

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of facets.byStatus) if (r._id in counts) counts[r._id] = r.n;
  const total = STATUSES.reduce((sum, s) => sum + counts[s], 0);
  const reachedWati = counts.sent + counts.delivered + counts.read;
  const delivered = counts.delivered + counts.read;

  // Buckets: every hour of the day, or every day in the range (so empty ones show as 0).
  const buckets = [];
  if (hourly) for (let h = 0; h < 24; h++) buckets.push(String(h).padStart(2, '0'));
  else if (from && to) {
    for (let d = istMidnight(from); d <= istMidnight(to); d = new Date(d.getTime() + 86400_000)) {
      buckets.push(new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10));
      if (buckets.length > 400) break;
    }
  } else buckets.push(...[...new Set(facets.series.map((r) => r._id.bucket))].sort());
  const seriesMap = new Map(buckets.map((b) => [b, Object.fromEntries([...STATUSES, 'nowa'].map((s) => [s, 0]))]));
  for (const r of facets.series) {
    const bucket = seriesMap.get(r._id.bucket);
    if (bucket && r._id.status in bucket) bucket[r._id.status] = r.n;
  }

  return {
    range: { from, to, granularity: hourly ? 'hour' : 'day' },
    total,
    counts,
    funnel: { triggered: total, sent: reachedWati, delivered, read: counts.read },
    // Failed split in two: couldn't be sent, and the number isn't on WhatsApp (both retried every 15 min).
    failedToSend: counts.failed - (facets.notOnWhatsApp[0]?.messages || 0),
    retrying: facets.retrying[0]?.n || 0,
    retryPolicy: retryPolicy(),
    rates: {
      delivered: reachedWati ? delivered / reachedWati : null,
      read: delivered ? counts.read / delivered : null,
      failed: total ? counts.failed / total : null,
    },
    avgSeconds: {
      toDeliver: facets.timing[0]?.toDeliver ?? null,
      toRead: facets.timing[0]?.toRead ?? null,
    },
    patients: facets.patients[0]?.n || 0,
    notOnWhatsApp: {
      messages: facets.notOnWhatsApp[0]?.messages || 0,
      numbers: facets.notOnWhatsApp[0]?.numbers || 0,
    },
    byDocument: Object.fromEntries(facets.byDocument.map((r) => [r._id, r.n])),
    byTrigger: Object.fromEntries(facets.byTrigger.map((r) => [r._id, r.n])),
    series: [...seriesMap].map(([bucket, byStatus]) => ({ bucket, ...byStatus })),
    poll: getPollState(),
  };
}

function publicDoc(d) {
  const { _id, ...rest } = d;
  return { id: String(_id), ...rest };
}

export async function listWhatsappMessages(q = {}) {
  const c = await collection();
  const filter = await resolveFilter(q);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 5), 200);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const [total, docs] = await Promise.all([
    c.countDocuments(filter),
    c.find(filter, { projection: { history: 0 } }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
  ]);
  return { total, page, limit, items: docs.map(publicDoc) };
}

export async function getWhatsappMessage(id) {
  if (!ObjectId.isValid(id)) return null;
  const c = await collection();
  const doc = await c.findOne({ _id: new ObjectId(id) });
  return doc ? publicDoc(doc) : null;
}

/** Latest status changes across all messages, newest first — the live feed. */
export async function whatsappActivity(limit = 25) {
  const c = await collection();
  const rows = await c
    .aggregate([
      { $sort: { createdAt: -1 } },
      { $limit: 400 },
      { $unwind: '$history' },
      // "Pending" is only the second before WATI answers — show it only while a message is still stuck there.
      { $match: { 'history.at': { $ne: null }, $or: [{ 'history.status': { $ne: 'pending' } }, { status: 'pending' }] } },
      { $sort: { 'history.at': -1 } },
      { $limit: Math.min(limit, 100) },
      {
        $project: {
          _id: 0,
          id: { $toString: '$_id' },
          at: '$history.at',
          status: '$history.status',
          note: '$history.note',
          patientName: 1,
          ipNo: 1,
          documentLabel: 1,
          toNumber: 1,
          trigger: 1,
          notOnWhatsApp: 1,
        },
      },
    ])
    .toArray();
  return rows;
}

// ---- Patient-wise view -------------------------------------------------------

const MESSAGE_FIELDS = [
  'document', 'documentLabel', 'status', 'createdAt', 'acceptedAt', 'deliveredAt', 'readAt', 'failedAt',
  'error', 'failedDetail', 'trigger', 'via', 'triggeredBy', 'attempts', 'nextRetryAt', 'imported', 'notOnWhatsApp',
];

/** A patient's overall state: the weakest step across their reports' latest messages. */
function overallStatus(reports) {
  const statuses = reports.map((r) => r.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('sent')) return 'sent';
  if (statuses.includes('delivered')) return 'delivered';
  return statuses.length ? 'read' : 'pending';
}

/**
 * One row per patient (discharge date + IP number; imported history, which
 * has no IP, groups by number + name). Each row lists the patient's reports
 * individually — the latest message per report, plus how many were sent —
 * and every message behind them, for the expandable detail.
 */
export async function whatsappPatients(q = {}) {
  const c = await collection();
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 5), 5000);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const project = Object.fromEntries(MESSAGE_FIELDS.map((f) => [f, `$${f}`]));
  const match = await resolveFilter(q);
  const grouped = await c
    .aggregate([
      { $match: match },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: {
            dischargeDate: '$dischargeDate',
            key: { $ifNull: ['$ipNo', { $concat: ['$toNumber', '|', { $ifNull: ['$patientName', ''] }] }] },
          },
          ipNo: { $last: '$ipNo' },
          patientName: { $last: '$patientName' },
          department: { $last: '$department' },
          toNumber: { $last: '$toNumber' },
          firstAt: { $min: '$createdAt' },
          lastAt: { $max: { $ifNull: ['$readAt', { $ifNull: ['$deliveredAt', { $ifNull: ['$acceptedAt', '$createdAt'] }] }] } },
          messages: { $push: { id: { $toString: '$_id' }, ...project } },
        },
      },
      { $sort: { lastAt: -1 } },
      { $facet: { total: [{ $count: 'n' }], rows: [{ $skip: (page - 1) * limit }, { $limit: limit }] } },
    ])
    .toArray();

  const rows = (grouped[0]?.rows || []).map((g) => {
    // Latest message per report (a report sent twice shows its newest attempt).
    const byDoc = new Map();
    for (const m of g.messages) {
      const key = m.document === 'other' ? m.documentLabel || m.id : m.document;
      const entry = byDoc.get(key) || { document: m.document, documentLabel: m.documentLabel, sends: 0 };
      entry.sends += 1;
      entry.latest = m;
      byDoc.set(key, entry);
    }
    const reports = [...byDoc.values()].map((r) => ({
      document: r.document,
      documentLabel: r.latest.documentLabel || r.documentLabel,
      sends: r.sends,
      ...r.latest,
    }));
    const order = { lab: 0, summary: 1, lab_results: 2, other: 3 };
    reports.sort((a, b) => (order[a.document] ?? 9) - (order[b.document] ?? 9));
    return {
      key: `${g._id.dischargeDate || ''}|${g._id.key}`,
      dischargeDate: g._id.dischargeDate,
      ipNo: g.ipNo,
      patientName: g.patientName,
      department: g.department,
      toNumber: g.toNumber,
      firstAt: g.firstAt,
      lastAt: g.lastAt,
      status: overallStatus(reports),
      notOnWhatsApp: reports.some((r) => r.status === 'failed' && r.notOnWhatsApp),
      reports,
      messages: [...g.messages].reverse(),
    };
  });
  return { total: grouped[0]?.total[0]?.n || 0, page, limit, items: rows };
}

/** Every message matching the filters (for exports), newest first. */
export async function allWhatsappMessages(q = {}, max = 10000) {
  const c = await collection();
  const docs = await c.find(await resolveFilter(q), { projection: { history: 0 } }).sort({ createdAt: -1 }).limit(max).toArray();
  return docs.map(publicDoc);
}

/**
 * Numbers whose most recent message failed as "not on WhatsApp" — shown as a
 * warning next to the patient's mobile on Discharge Reports. A later
 * successful send to the number takes it off the list.
 */
export async function numbersNotOnWhatsApp() {
  const c = await collection();
  const rows = await c
    .aggregate([
      { $match: { status: { $in: ['sent', 'delivered', 'read', 'failed'] } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$toNumber', latest: { $first: '$$ROOT' } } },
      { $match: { 'latest.status': 'failed', 'latest.notOnWhatsApp': true } },
      { $project: { _id: 0, number: '$_id', at: '$latest.failedAt' } },
    ])
    .toArray();
  return rows;
}

/** Marks earlier failures (logged before the flag existed) that were "not on WhatsApp". */
export async function backfillNotOnWhatsAppFlag() {
  const c = await collection();
  const failed = await c.find({ status: 'failed', notOnWhatsApp: { $exists: false } }, { projection: { error: 1, failedDetail: 1 } }).toArray();
  let n = 0;
  for (const d of failed) {
    const flag = isNotOnWhatsApp(d.failedDetail) || isNotOnWhatsApp(d.error);
    await c.updateOne({ _id: d._id }, { $set: { notOnWhatsApp: flag } });
    if (flag) n += 1;
  }
  return n;
}

// ---- Insights: the deeper analytics on the /admin monitor --------------------

const TIME_BUCKETS = [
  { max: 60, label: '< 1 min' },
  { max: 300, label: '1–5 min' },
  { max: 900, label: '5–15 min' },
  { max: 3600, label: '15–60 min' },
  { max: 6 * 3600, label: '1–6 h' },
  { max: 24 * 3600, label: '6–24 h' },
  { max: Infinity, label: '> 1 day' },
];

function bucketTimes(seconds) {
  const counts = TIME_BUCKETS.map((b) => ({ label: b.label, value: 0 }));
  for (const s of seconds) {
    const i = TIME_BUCKETS.findIndex((b) => s < b.max);
    if (i >= 0) counts[i].value += 1;
  }
  return counts;
}

/** Why a message failed, in a handful of plain categories. */
export function failureCategory(doc) {
  const t = `${doc.failedDetail || ''} ${doc.error || ''}`;
  if (doc.notOnWhatsApp || isNotOnWhatsApp(t)) return 'Not on WhatsApp';
  if (/429|usage limit/i.test(t)) return 'WATI usage limit';
  if (/timeout|aborted|network|fetch failed|ECONN|socket|50[234]|busy|rate limit/i.test(t)) return 'Network / WATI busy';
  if (/template/i.test(t)) return 'Template rejected';
  if (/no longer available|no patient data|pdf/i.test(t)) return 'Report missing';
  if (/undeliverable|131026|131047|blocked|re-?engage|24 ?hours/i.test(t)) return 'WhatsApp would not deliver';
  return 'Other';
}

const statusSum = (statuses) => ({ $sum: { $cond: [{ $in: ['$status', statuses] }, 1, 0] } });

function previousRange(from, to) {
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) return null;
  const days = Math.round((istMidnight(to) - istMidnight(from)) / 86400_000) + 1;
  const shift = (day, n) => new Date(istMidnight(day).getTime() + n * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
  return { from: shift(from, -days), to: shift(from, -1), days };
}

/**
 * Did every patient discharged in the range get their reports on WhatsApp?
 * Patient-based (by discharge date), so the status / document / trigger
 * filters don't apply here.
 */
async function coverage(from, to, win = null) {
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) return null;
  let reports = await (await getMongoCollection('discharge_reports'))
    .find({ date: { $gte: from, $lte: to } }, { projection: { _id: 0, date: 1, ipNo: 1, name: 1, mobile: 1, department: 1, dateCount: 1, hasSummary: 1, summaryDataMissing: 1, dischargeDate: 1 } })
    .toArray();
  if (win) {
    const start = istAt(from, win.fromTime).getTime();
    const end = istAt(to, win.toTime).getTime() + 60_000;
    reports = reports.filter((r) => {
      const t = dischargeMoment(r)?.getTime();
      return t >= start && t < end;
    });
  }
  const c = await collection();
  const msgs = await c
    .find({ dischargeDate: { $gte: from, $lte: to }, ipNo: { $ne: null } }, { projection: { dischargeDate: 1, ipNo: 1, status: 1, notOnWhatsApp: 1 } })
    .toArray();
  const RANK_BEST = { read: 5, delivered: 4, sent: 3, pending: 2, failed: 1 };
  const best = new Map();
  for (const m of msgs) {
    const key = `${m.dischargeDate}|${m.ipNo}`;
    const prev = best.get(key);
    if (!prev || RANK_BEST[m.status] > RANK_BEST[prev.status]) best.set(key, m);
  }
  const counts = { read: 0, delivered: 0, sent: 0, pending: 0, failed: 0, nowa: 0, noMobile: 0, noReport: 0, notSent: 0 };
  const notReached = [];
  for (const p of reports) {
    const m = best.get(`${p.date}|${p.ipNo}`);
    let state;
    if (m) state = m.status === 'failed' && m.notOnWhatsApp ? 'nowa' : m.status;
    else if (!String(p.mobile || '').replace(/\D/g, '')) state = 'noMobile';
    else if (p.dateCount === undefined && !(p.hasSummary && !p.summaryDataMissing)) state = 'noReport';
    else state = 'notSent';
    counts[state] += 1;
    if (!['read', 'delivered', 'sent'].includes(state)) {
      notReached.push({ date: p.date, ipNo: p.ipNo, name: p.name, department: p.department, mobile: p.mobile || '', state });
    }
  }
  return {
    discharged: reports.length,
    reached: counts.read + counts.delivered + counts.sent,
    counts,
    notReached: notReached.slice(0, 200),
    notReachedTotal: notReached.length,
  };
}

export async function whatsappInsights(q = {}) {
  const c = await collection();
  const now = Date.now();
  const match = await resolveFilter(q);
  const [f] = await c
    .aggregate([
      { $match: match },
      {
        $facet: {
          trend: [
            {
              $group: {
                _id: dayOf(q.basis),
                total: { $sum: 1 },
                accepted: statusSum(['sent', 'delivered', 'read']),
                delivered: statusSum(['delivered', 'read']),
                read: statusSum(['read']),
              },
            },
            { $sort: { _id: 1 } },
          ],
          readHours: [{ $match: { readAt: { $ne: null } } }, { $group: { _id: { $hour: { date: '$readAt', timezone: TZ } }, n: { $sum: 1 } } }],
          sendHours: [{ $group: { _id: { $hour: { date: '$createdAt', timezone: TZ } }, n: { $sum: 1 } } }],
          toRead: [
            { $match: { readAt: { $ne: null }, acceptedAt: { $ne: null }, imported: { $ne: true } } },
            { $project: { _id: 0, s: secs('$readAt', '$acceptedAt') } },
          ],
          toDeliver: [
            { $match: { deliveredAt: { $ne: null }, acceptedAt: { $ne: null }, imported: { $ne: true } } },
            { $project: { _id: 0, s: secs('$deliveredAt', '$acceptedAt') } },
          ],
          byTrigger: [{ $group: { _id: { t: '$trigger', s: '$status' }, n: { $sum: 1 } } }],
          failures: [{ $match: { status: 'failed' } }, { $project: { _id: 0, error: 1, failedDetail: 1, notOnWhatsApp: 1 } }],
          departments: [
            { $match: { department: { $nin: ['', null] } } },
            {
              $group: {
                _id: '$department',
                total: { $sum: 1 },
                delivered: statusSum(['delivered', 'read']),
                read: statusSum(['read']),
                failed: statusSum(['failed']),
              },
            },
            { $sort: { total: -1 } },
            { $limit: 12 },
          ],
          staff: [
            { $match: { trigger: { $in: ['manual', 'share'] } } },
            { $group: { _id: '$triggeredBy', total: { $sum: 1 }, failed: statusSum(['failed']), manual: { $sum: { $cond: [{ $eq: ['$trigger', 'manual'] }, 1, 0] } } } },
            { $sort: { total: -1 } },
            { $limit: 10 },
          ],
          attention: [
            {
              $group: {
                _id: null,
                fixable: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'failed'] }, { $ne: ['$notOnWhatsApp', true] }] }, 1, 0] } },
                nowa: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'failed'] }, { $eq: ['$notOnWhatsApp', true] }] }, 1, 0] } },
                unread24: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'delivered'] }, { $lte: ['$deliveredAt', new Date(now - 24 * 3600_000)] }] }, 1, 0] } },
                stuck6: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'sent'] }, { $lte: ['$acceptedAt', new Date(now - 6 * 3600_000)] }] }, 1, 0] } },
                autoRetrying: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'failed'] }, { $gt: ['$nextRetryAt', null] }] }, 1, 0] } },
              },
            },
          ],
        },
      },
    ])
    .toArray();

  const triggers = new Map();
  for (const r of f.byTrigger) {
    if (!triggers.has(r._id.t)) triggers.set(r._id.t, { trigger: r._id.t, pending: 0, sent: 0, delivered: 0, read: 0, failed: 0 });
    triggers.get(r._id.t)[r._id.s] = r.n;
  }
  const reasons = new Map();
  for (const d of f.failures) reasons.set(failureCategory(d), (reasons.get(failureCategory(d)) || 0) + 1);
  const hours = (rows) => Array.from({ length: 24 }, (_, h) => rows.find((r) => r._id === h)?.n || 0);

  // Same slice, previous period of equal length — for the ↑ / ↓ on the tiles.
  const prev = previousRange(q.from, q.to);
  let previous = null;
  if (prev) {
    const prevMatch = await resolveFilter({ ...q, from: prev.from, to: prev.to });
    const rows = await c.aggregate([{ $match: prevMatch }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
    const counts = Object.fromEntries(STATUSES.map((s) => [s, rows.find((r) => r._id === s)?.n || 0]));
    const total = STATUSES.reduce((sum, s) => sum + counts[s], 0);
    const accepted = counts.sent + counts.delivered + counts.read;
    const delivered = counts.delivered + counts.read;
    previous = {
      from: prev.from,
      to: prev.to,
      total,
      delivered,
      read: counts.read,
      failed: counts.failed,
      rates: { delivered: accepted ? delivered / accepted : null, read: delivered ? counts.read / delivered : null },
    };
  }

  // A one-day range has a single point on the rate chart — show the last 14 days
  // (same filters) so there's always a trend to compare against.
  let trendRows = f.trend;
  let trendRange = { from: q.from, to: q.to };
  if (DATE_RE.test(q.from || '') && q.from === q.to) {
    const fromDay = new Date(istMidnight(q.to).getTime() - 13 * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
    trendRange = { from: fromDay, to: q.to };
    trendRows = await c
      .aggregate([
        // Whole days for the 14-day trend (a time window would only cut each end).
        { $match: buildFilter({ ...q, from: fromDay, to: q.to, fromTime: null, toTime: null }) },
        {
          $group: {
            _id: dayOf(q.basis),
            total: { $sum: 1 },
            accepted: statusSum(['sent', 'delivered', 'read']),
            delivered: statusSum(['delivered', 'read']),
            read: statusSum(['read']),
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();
  }

  // Every day in the range, so the x-axis spacing is true to time (empty days are gaps).
  const byDay = new Map(trendRows.map((t) => [t._id, t]));
  const trendDays = [];
  if (DATE_RE.test(trendRange.from || '') && DATE_RE.test(trendRange.to || '')) {
    for (let d = istMidnight(trendRange.from); d <= istMidnight(trendRange.to) && trendDays.length < 400; d = new Date(d.getTime() + 86400_000)) {
      trendDays.push(new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10));
    }
  } else trendDays.push(...byDay.keys());

  return {
    previous,
    trendRange,
    trend: trendDays.map((day) => {
      const t = byDay.get(day);
      return {
        bucket: day,
        total: t?.total || 0,
        deliveredRate: t?.accepted ? t.delivered / t.accepted : null,
        readRate: t?.delivered ? t.read / t.delivered : null,
      };
    }),
    readHours: hours(f.readHours),
    sendHours: hours(f.sendHours),
    timeToRead: bucketTimes(f.toRead.map((r) => r.s)),
    timeToDeliver: bucketTimes(f.toDeliver.map((r) => r.s)),
    byTrigger: [...triggers.values()],
    failureReasons: [...reasons].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    departments: f.departments.map((d) => ({ department: d._id, total: d.total, delivered: d.delivered, read: d.read, failed: d.failed })),
    staff: f.staff.map((s) => ({ user: s._id || 'unknown', total: s.total, failed: s.failed, manual: s.manual })),
    attention: f.attention[0] ? { ...f.attention[0], _id: undefined } : { fixable: 0, nowa: 0, unread24: 0, stuck6: 0, autoRetrying: 0 },
    coverage: await coverage(q.from, q.to, isReportBasis(q.basis) ? timeWindow(q) : null),
  };
}

// ---- For "Ask AI" (assistantService.js) ------------------------------------

/**
 * A WhatsApp report for Ask AI: totals plus patient-wise and message-wise rows
 * for the same filters as the monitor (dates, "Dates by", time window, status,
 * document, trigger, search).
 */
export async function whatsappReportData(q = {}, maxRows = 100) {
  const [summary, patients, messages] = await Promise.all([
    whatsappSummary(q),
    whatsappPatients({ ...q, page: 1, limit: maxRows }),
    listWhatsappMessages({ ...q, page: 1, limit: Math.min(maxRows, 200) }),
  ]);
  return { summary, patients, messages };
}

/** Reports waiting for an automatic re-send, and how many WATI refused (usage limit) in the last day. */
export async function retryQueueFacts() {
  const c = await collection();
  const [waiting, limited] = await Promise.all([
    c.countDocuments({ status: 'failed', nextRetryAt: { $ne: null } }),
    c.countDocuments({ status: 'failed', rateLimited: true, failedAt: { $gte: new Date(Date.now() - 86400_000) } }),
  ]);
  const next = await c.find({ status: 'failed', nextRetryAt: { $ne: null } }).sort({ nextRetryAt: 1 }).limit(1).next();
  return { waiting, refusedByUsageLimitLast24h: limited, nextRetryAt: next?.nextRetryAt || null };
}
