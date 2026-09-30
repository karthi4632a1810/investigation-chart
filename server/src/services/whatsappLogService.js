/**
 * Every WhatsApp message the app sends, and what happened to it afterwards —
 * the data behind the /admin WhatsApp monitor.
 *
 * A record is created as "pending" just before the WATI call, becomes "sent"
 * once WATI accepts it (or "failed" with the error), and then moves on to
 * "delivered" (grey double tick) and "read" (blue double tick) as the status
 * poller below sees WATI report them.
 *
 * WATI's message list gives each message's *current* status but not when it
 * changed, so deliveredAt / readAt are the time the poller first saw the new
 * status — accurate to the poll interval (a minute), not to the second.
 */
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { getMongoCollection } from './mongo.js';

const COLLECTION = 'whatsapp_messages';
const POLL_INTERVAL_MS = 60 * 1000;
// WATI rate-limits its API ("API usage limit exceeded", HTTP 429) and the same
// limit covers sending, so status checks must stay light: each message is
// re-checked on a slowing schedule (below) for 3 days, at most a few numbers
// per minute, and everything pauses after a 429.
const POLL_WINDOW_DAYS = 3;
const MAX_NUMBERS_PER_POLL = 6;
// Minutes after sending at which a message is checked again.
const CHECK_AFTER_MIN = [1, 3, 10, 30, 60, 180, 360, 720, 1440, 2160, 2880, 4320];
const RATE_LIMIT_PAUSE_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000];
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
    department: entry.department || '',
    toNumber: digitsOnly(entry.toNumber),
    liveMode: Boolean(entry.liveMode),
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
export const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [2 * 60_000, 15 * 60_000, 60 * 60_000];
// Errors a resend can't fix — these wait for a person (Retry button) instead.
const PERMANENT_ERROR = /not a whatsapp number|invalid|not valid|does not exist|blocked|template|not configured|required/i;

/** Only patient reports can be re-sent without a person — a results list isn't stored. */
function canAutoRetry(doc, error) {
  return (
    ['lab', 'summary'].includes(doc?.document) &&
    Boolean(doc.ipNo && doc.dischargeDate) &&
    !PERMANENT_ERROR.test(String(error || '')) &&
    (doc.attempts || 1) < MAX_ATTEMPTS
  );
}

/** WATI accepted the message (or refused it). */
export async function logSendResult(id, { ok, error, response }) {
  if (!id) return;
  const now = new Date();
  const c = await collection();
  const _id = new ObjectId(id);
  if (ok) {
    await c.updateOne(
      { _id },
      {
        $set: { status: 'sent', acceptedAt: now, validWhatsAppNumber: response?.validWhatsAppNumber ?? null, nextRetryAt: null },
        $push: { history: { status: 'sent', at: now, source: 'app', note: 'Accepted by WATI' } },
      },
    );
    return;
  }
  const doc = await c.findOne({ _id }, { projection: { document: 1, ipNo: 1, dischargeDate: 1, attempts: 1 } });
  const message = String(error || 'Send failed').slice(0, 500);
  const retry = canAutoRetry(doc, message);
  const nextRetryAt = retry ? new Date(now.getTime() + RETRY_DELAYS_MS[Math.min((doc.attempts || 1) - 1, RETRY_DELAYS_MS.length - 1)]) : null;
  await c.updateOne(
    { _id },
    {
      $set: { status: 'failed', failedAt: now, error: message, nextRetryAt, autoRetry: retry, notOnWhatsApp: isNotOnWhatsApp(message) },
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
        failedDetail: null,
        acceptedAt: null,
        deliveredAt: null,
        readAt: null,
        notOnWhatsApp: false,
      },
      $push: {
        history: { status: 'pending', at: now, source: 'app', note: `Retry ${attempt - 1} — ${auto ? 'automatic' : `by ${triggeredBy || 'staff'}`}` },
      },
    },
  );
  return id;
}

/** Failed messages whose automatic retry is due. */
export async function dueRetries(limit = 10) {
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
  if (res.status === 429) throw new RateLimitedError('WATI API usage limit exceeded (429)');
  if (!res.ok) throw new Error(`WATI getMessages ${res.status}`);
  const data = await res.json();
  return (data.messages?.items || []).filter((m) => m.eventType === 'broadcastMessage' || m.eventType === 'message');
}

/** Picks the WATI message for our record: same document line, patient name, sent within a few minutes. */
function matchWatiItem(doc, items, claimed) {
  const sentAt = new Date(doc.acceptedAt || doc.createdAt).getTime();
  const firstName = String(doc.patientName || '').split(/[\s.]+/).filter((w) => w.length > 2)[0] || '';
  let best = null;
  for (const item of items) {
    if (claimed.has(item.id)) continue;
    const created = new Date(item.created).getTime();
    const delta = created - sentAt;
    if (delta < -120_000 || delta > 10 * 60_000) continue;
    const text = String(item.finalText || '');
    if (doc.documentLabel && !text.includes(`Attached: ${doc.documentLabel}`)) continue;
    if (firstName && !text.toUpperCase().includes(firstName.toUpperCase())) continue;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { item, delta };
  }
  return best?.item || null;
}

let pollRunning = false;
let lastPoll = { at: null, checked: 0, updated: 0, error: null };
let pausedUntil = 0;
let rateLimitStrikes = 0;

export function getPollState() {
  return {
    ...lastPoll,
    intervalSeconds: POLL_INTERVAL_MS / 1000,
    pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil) : null,
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
 * numbers at a time. `force` (the "Check WATI now" button) checks every open
 * message's number once, still capped, and still respects a rate-limit pause.
 */
export async function pollWhatsAppStatuses({ force = false } = {}) {
  if (pollRunning || !config.wati.endpoint || !config.wati.accessToken) return getPollState();
  if (pausedUntil > Date.now()) return getPollState();
  pollRunning = true;
  let checked = 0;
  let updated = 0;
  let error = null;
  try {
    const c = await collection();
    const now = new Date();
    const since = new Date(now.getTime() - POLL_WINDOW_DAYS * 86400_000);
    const due = force
      ? { createdAt: { $gte: since }, status: { $in: ['sent', 'delivered'] } }
      : { createdAt: { $gte: since }, status: { $in: ['sent', 'delivered'] }, $or: [{ nextCheckAt: { $exists: false } }, { nextCheckAt: { $lte: now } }] };
    const open = await c.find(due).sort({ nextCheckAt: 1, createdAt: 1 }).limit(200).toArray();
    const byNumber = new Map();
    for (const doc of open) {
      if (!byNumber.has(doc.toNumber)) byNumber.set(doc.toNumber, []);
      byNumber.get(doc.toNumber).push(doc);
    }
    for (const [number, docs] of [...byNumber].slice(0, force ? MAX_NUMBERS_PER_POLL * 3 : MAX_NUMBERS_PER_POLL)) {
      let items;
      try {
        items = await fetchWatiMessages(number);
        rateLimitStrikes = 0;
      } catch (err) {
        error = err.message;
        if (err instanceof RateLimitedError) {
          pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS[Math.min(rateLimitStrikes, RATE_LIMIT_PAUSE_MS.length - 1)];
          rateLimitStrikes += 1;
          console.warn(`[whatsapp] WATI rate limit hit — pausing status checks until ${new Date(pausedUntil).toISOString()}`);
          break;
        }
        continue;
      }
      const byId = new Map(items.map((m) => [m.id, m]));
      const claimed = new Set((await c.distinct('watiMessageId', { toNumber: number, watiMessageId: { $ne: null } })) || []);
      // Oldest first, so each record claims the nearest-in-time WATI message.
      docs.sort((a, b) => a.createdAt - b.createdAt);
      for (const doc of docs) {
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
          extra.nextRetryAt = null;
          extra.autoRetry = false;
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
    lastPoll = { at: new Date(), checked, updated, error };
    pollRunning = false;
  }
  return getPollState();
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

function rangeFilter(from, to) {
  const f = DATE_RE.test(from || '') ? from : null;
  const t = DATE_RE.test(to || '') ? to : null;
  const createdAt = {};
  if (f) createdAt.$gte = istMidnight(f);
  if (t) createdAt.$lt = new Date(istMidnight(t).getTime() + 86400_000);
  return Object.keys(createdAt).length ? { createdAt } : {};
}

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
  const filter = { ...rangeFilter(q.from, q.to) };
  const and = [];
  const statuses = String(q.status || '')
    .split(',')
    .filter((s) => STATUSES.includes(s) || SPECIAL_STATUS[s]);
  if (statuses.length) {
    const plain = statuses.filter((s) => !SPECIAL_STATUS[s]);
    const either = [];
    if (plain.length) either.push({ status: { $in: plain } });
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

const secs = (a, b) => ({ $divide: [{ $subtract: [a, b] }, 1000] });

export async function whatsappSummary(q = {}) {
  const c = await collection();
  const match = buildFilter(q);
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
          byTrigger: [{ $group: { _id: '$trigger', n: { $sum: 1 } } }],
          series: [
            {
              $group: {
                _id: {
                  bucket: { $dateToString: { date: '$createdAt', format: hourly ? '%H' : '%Y-%m-%d', timezone: TZ } },
                  status: '$status',
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
  const seriesMap = new Map(buckets.map((b) => [b, Object.fromEntries(STATUSES.map((s) => [s, 0]))]));
  for (const r of facets.series) {
    const bucket = seriesMap.get(r._id.bucket);
    if (bucket && r._id.status in bucket) bucket[r._id.status] = r.n;
  }

  return {
    range: { from, to, granularity: hourly ? 'hour' : 'day' },
    total,
    counts,
    funnel: { triggered: total, sent: reachedWati, delivered, read: counts.read },
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
  const filter = buildFilter(q);
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
  const grouped = await c
    .aggregate([
      { $match: buildFilter(q) },
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
  const docs = await c.find(buildFilter(q), { projection: { history: 0 } }).sort({ createdAt: -1 }).limit(max).toArray();
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
async function coverage(from, to) {
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) return null;
  const reports = await (await getMongoCollection('discharge_reports'))
    .find({ date: { $gte: from, $lte: to } }, { projection: { _id: 0, date: 1, ipNo: 1, name: 1, mobile: 1, department: 1, dateCount: 1, hasSummary: 1, summaryDataMissing: 1 } })
    .toArray();
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
  const [f] = await c
    .aggregate([
      { $match: buildFilter(q) },
      {
        $facet: {
          trend: [
            {
              $group: {
                _id: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: TZ } },
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
    const rows = await c.aggregate([{ $match: buildFilter({ ...q, from: prev.from, to: prev.to }) }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
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
        { $match: buildFilter({ ...q, from: fromDay, to: q.to }) },
        {
          $group: {
            _id: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: TZ } },
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
    coverage: await coverage(q.from, q.to),
  };
}
