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
const POLL_WINDOW_DAYS = 7;
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

/** WATI accepted the message (or refused it). */
export async function logSendResult(id, { ok, error, response }) {
  if (!id) return;
  const now = new Date();
  const c = await collection();
  const update = ok
    ? {
        $set: { status: 'sent', acceptedAt: now, validWhatsAppNumber: response?.validWhatsAppNumber ?? null },
        $push: { history: { status: 'sent', at: now, source: 'app', note: 'Accepted by WATI' } },
      }
    : {
        $set: { status: 'failed', failedAt: now, error: String(error || 'Send failed').slice(0, 500) },
        $push: { history: { status: 'failed', at: now, source: 'app', note: String(error || 'Send failed').slice(0, 200) } },
      };
  await c.updateOne({ _id: new ObjectId(id) }, update);
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

async function fetchWatiMessages(number, pageSize = 50) {
  const res = await fetch(`${config.wati.endpoint}/api/v1/getMessages/${number}?pageSize=${pageSize}&pageNumber=1`, {
    headers: watiHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
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

export function getPollState() {
  return { ...lastPoll, intervalSeconds: POLL_INTERVAL_MS / 1000 };
}

/** One pass: every recent message not yet read/failed gets its WATI status refreshed. */
export async function pollWhatsAppStatuses() {
  if (pollRunning || !config.wati.endpoint || !config.wati.accessToken) return lastPoll;
  pollRunning = true;
  let checked = 0;
  let updated = 0;
  try {
    const c = await collection();
    const since = new Date(Date.now() - POLL_WINDOW_DAYS * 86400_000);
    const open = await c.find({ createdAt: { $gte: since }, status: { $in: ['sent', 'delivered'] } }).toArray();
    const byNumber = new Map();
    for (const doc of open) {
      if (!byNumber.has(doc.toNumber)) byNumber.set(doc.toNumber, []);
      byNumber.get(doc.toNumber).push(doc);
    }
    for (const [number, docs] of byNumber) {
      let items;
      try {
        items = await fetchWatiMessages(number);
      } catch (error) {
        lastPoll.error = error.message;
        continue;
      }
      const byId = new Map(items.map((m) => [m.id, m]));
      const claimed = new Set((await c.distinct('watiMessageId', { toNumber: number, watiMessageId: { $ne: null } })) || []);
      // Oldest first, so each record claims the nearest-in-time WATI message.
      docs.sort((a, b) => a.createdAt - b.createdAt);
      for (const doc of docs) {
        checked += 1;
        const item = doc.watiMessageId ? byId.get(doc.watiMessageId) : matchWatiItem(doc, items, claimed);
        if (!item) {
          await c.updateOne({ _id: doc._id }, { $set: { lastCheckedAt: new Date() } });
          continue;
        }
        claimed.add(item.id);
        const status = WATI_STATUS[String(item.statusString || '').toUpperCase()];
        const extra = { watiMessageId: item.id, watiStatus: item.statusString || null, lastCheckedAt: new Date() };
        if (item.failedDetail) extra.failedDetail = String(item.failedDetail).slice(0, 500);
        const changed = await applyStatus(c, doc, status, {
          note: status === 'failed' ? item.failedDetail || 'WATI reported failed' : `WATI: ${item.statusString}`,
          extra,
        });
        if (changed) updated += 1;
      }
    }
    lastPoll = { at: new Date(), checked, updated, error: lastPoll.error && updated ? null : lastPoll.error };
  } catch (error) {
    lastPoll = { at: new Date(), checked, updated, error: error.message };
  } finally {
    pollRunning = false;
  }
  return lastPoll;
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

function buildFilter(q = {}) {
  const filter = { ...rangeFilter(q.from, q.to) };
  const statuses = String(q.status || '')
    .split(',')
    .filter((s) => STATUSES.includes(s));
  if (statuses.length) filter.status = { $in: statuses };
  if (['lab', 'summary', 'lab_results', 'other'].includes(q.document)) filter.document = q.document;
  if (['auto', 'manual', 'share', 'imported'].includes(q.trigger)) filter.trigger = q.trigger;
  const search = String(q.q || '').trim().slice(0, 60);
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ patientName: rx }, { ipNo: rx }, { toNumber: { $regex: escapeRegex(search.replace(/\D/g, '') || search) } }, { triggeredBy: rx }];
  }
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
      { $match: { 'history.at': { $ne: null } } },
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
        },
      },
    ])
    .toArray();
  return rows;
}
