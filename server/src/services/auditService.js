/**
 * Audit log: who did what, when — every sign-in and sign-out, screen, click
 * on a patient's WhatsApp button (and whether the popup was sent or
 * cancelled), PDF opened, export, setting or user change, and every Ask AI
 * question with its answer; plus each session's active, idle and hidden-tab time.
 *
 * Most events are recorded by the server as the API is called (auditMiddleware
 * below), so they can't be skipped. The browser adds what only it can see —
 * screen changes, popups opened and cancelled, the tab hidden, idle time —
 * through POST /api/audit/events (client: utils/audit.js).
 *
 * Kept AUDIT_RETENTION_DAYS (default 365) days, then removed by Mongo (TTL).
 */
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import { getMongoCollection } from './mongo.js';

const EVENTS = 'audit_events';
const SESSIONS = 'audit_sessions';
const RETENTION_DAYS = Math.max(30, Number(process.env.AUDIT_RETENTION_DAYS) || 365);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = 'Asia/Kolkata';

/** Every action, its category (for filters) and whether the browser may report it. */
export const ACTIONS = {
  login: { cat: 'auth' },
  login_failed: { cat: 'auth' },
  logout: { cat: 'auth' },
  password_changed: { cat: 'auth' },
  screen_open: { cat: 'screen', client: true },
  tab_hidden: { cat: 'presence', client: true },
  tab_visible: { cat: 'presence', client: true },
  idle_start: { cat: 'presence', client: true },
  idle_end: { cat: 'presence', client: true },
  tab_closed: { cat: 'presence', client: true },
  search: { cat: 'report' },
  date_change: { cat: 'report', client: true },
  filter_change: { cat: 'report', client: true },
  copy: { cat: 'report', client: true },
  pdf_open: { cat: 'report' },
  lab_detail_open: { cat: 'report' },
  run_now: { cat: 'report' },
  message_open: { cat: 'whatsapp', client: true },
  whatsapp_click: { cat: 'whatsapp', client: true },
  whatsapp_popup_cancel: { cat: 'whatsapp', client: true },
  whatsapp_send: { cat: 'whatsapp' },
  whatsapp_share: { cat: 'whatsapp' },
  whatsapp_retry: { cat: 'whatsapp' },
  whatsapp_check: { cat: 'whatsapp' },
  whatsapp_test: { cat: 'whatsapp' },
  export: { cat: 'export' },
  ai_open: { cat: 'ai', client: true },
  ai_close: { cat: 'ai', client: true },
  ai_new_chat: { cat: 'ai', client: true },
  ai_question: { cat: 'ai' },
  lab_lookup_open: { cat: 'ai' },
  settings_change: { cat: 'settings' },
  user_create: { cat: 'users' },
  user_update: { cat: 'users' },
  user_password_reset: { cat: 'users' },
  user_sign_out: { cat: 'users' },
  user_delete: { cat: 'users' },
  audit_view: { cat: 'audit' },
  audit_export: { cat: 'audit' },
};
export const CATEGORIES = ['auth', 'screen', 'presence', 'report', 'whatsapp', 'export', 'ai', 'settings', 'users', 'audit'];

const SCREEN_NAMES = { search: 'Lab Search', reports: 'Discharge Reports', labFinder: 'Lab Finder', wati: 'WATI Settings', admin: 'WhatsApp Monitor', users: 'Users', audit: 'Audit Log' };

let ready = null;
async function events() {
  const c = await getMongoCollection(EVENTS);
  ready ||= Promise.all([
    c.createIndex({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 }),
    c.createIndex({ user: 1, at: -1 }),
    c.createIndex({ department: 1, at: -1 }),
    c.createIndex({ sessionId: 1, at: 1 }),
    c.createIndex({ category: 1, at: -1 }),
  ]).catch(() => {});
  await ready;
  return c;
}
const sessions = () => getMongoCollection(SESSIONS);

// ---- Who / where ------------------------------------------------------------------

/** "Chrome · Windows" from a user-agent. */
export function device(ua = '') {
  const s = String(ua);
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'Browser';
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

// The whole forwarded chain when there is one ("person, proxy"): behind the
// HTTPS proxy the person's own address is first; X-Real-IP alone would be the proxy.
const clientIp = (req) =>
  String(req?.headers?.['x-forwarded-for'] || req?.headers?.['x-real-ip'] || req?.ip || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(', ')
    .slice(0, 100);

function who(user) {
  if (!user) return { user: null, userName: '', department: '', designation: '' };
  return {
    user: String(user.username || '').toLowerCase(),
    userName: user.name || user.username || '',
    department: user.isSuperAdmin ? 'Administration' : user.department || '—',
    designation: user.isSuperAdmin ? 'Super admin' : user.designation || '',
  };
}

// ---- Describing an event in a sentence -------------------------------------------

const dmy = (iso) => String(iso || '').split('-').reverse().join('-');
const mins = (ms) => {
  const m = Math.round((ms || 0) / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
};
const patient = (t = {}) => {
  if (!t) return '';
  const id = [t.ipNo, t.uhid && `UHID ${t.uhid}`].filter(Boolean).join(', ');
  const name = t.patientName || t.ipNo || t.uhid || 'a patient';
  return `${name}${id && name !== t.ipNo ? ` (${id})` : ''}${t.date ? `, discharged ${dmy(t.date)}` : ''}`;
};

export function describe(e) {
  const d = e.details || {};
  const t = e.target || {};
  switch (e.action) {
    case 'login':
      return `Signed in${e.device ? ` · ${e.device}` : ''}`;
    case 'login_failed':
      return `Sign-in failed as “${d.username || '?'}” — ${d.reason || 'wrong password'}`;
    case 'logout':
      return `Signed out${d.sessionMs ? ` after ${mins(d.sessionMs)}` : ''}`;
    case 'password_changed':
      return 'Changed their own password';
    case 'screen_open':
      return `Opened ${SCREEN_NAMES[e.screen] || e.screen}${d.from ? ` (was on ${SCREEN_NAMES[d.from] || d.from} for ${mins(d.prevMs)})` : ''}`;
    case 'tab_hidden':
      return 'Switched away from the portal tab';
    case 'tab_visible':
      return `Came back to the tab after ${mins(e.durationMs)}`;
    case 'idle_start':
      return 'Went idle (no mouse or keyboard for 5 min)';
    case 'idle_end':
      return `Active again after ${mins(e.durationMs)} idle`;
    case 'tab_closed':
      return 'Closed the tab / browser';
    case 'search':
      return d.regNo ? `Searched Lab Search for ${d.regNo}${d.from ? ` (${d.from} to ${d.to})` : ''}` : `Searched ${SCREEN_NAMES[e.screen] || ''}${d.query ? `: ${d.query}` : ''}`;
    case 'date_change':
      return `Viewed discharges of ${dmy(d.date)}`;
    case 'filter_change':
      return `Changed filters on ${SCREEN_NAMES[e.screen] || e.screen}${d.summary ? ` — ${d.summary}` : ''}`;
    case 'copy':
      return `Copied ${d.label || 'a value'} ${d.value || ''}`.trim();
    case 'pdf_open':
      return `Opened the ${d.document === 'summary' ? 'discharge summary' : 'lab report'} of ${patient(t)}`;
    case 'lab_detail_open':
      return `Opened lab result details (order ${d.orderId || '?'})`;
    case 'run_now':
      return 'Pressed Check Now (discharge check)';
    case 'message_open':
      return `Opened the WhatsApp message of ${patient(t)}`;
    case 'whatsapp_click':
      return `Clicked WhatsApp for ${patient(t)}`;
    case 'whatsapp_popup_cancel':
      return `Cancelled the WhatsApp popup for ${patient(t)}${d.numberEdited ? ' (after changing the number)' : ''}`;
    case 'whatsapp_send':
      return d.ok
        ? `Sent ${d.documents || 'reports'} of ${patient(t)} to ${d.to || 'WhatsApp'}${d.numberEdited ? ' (number edited)' : ''}`
        : `WhatsApp send failed for ${patient(t)}: ${d.error || 'error'}`;
    case 'whatsapp_share':
      return d.ok ? `Shared ${d.what || 'a report'} on WhatsApp to ${d.to || '?'}` : `WhatsApp share failed: ${d.error || 'error'}`;
    case 'whatsapp_retry':
      return d.ok ? `Retried a failed WhatsApp message${t.patientName ? ` of ${patient(t)}` : ''}` : `Retry failed: ${d.error || 'error'}`;
    case 'whatsapp_check':
      return 'Asked WATI for the latest delivery ticks';
    case 'whatsapp_test':
      return d.ok ? `Sent a test WhatsApp to ${d.to || '?'}: “${d.message || ''}”` : `Test WhatsApp failed: ${d.error || 'error'}`;
    case 'export':
      return `Downloaded ${d.what || 'an export'}${d.format ? ` as ${String(d.format).toUpperCase()}` : ''}`;
    case 'ai_open':
      return 'Opened Ask AI';
    case 'ai_close':
      return 'Closed Ask AI';
    case 'ai_new_chat':
      return 'Started a new Ask AI chat';
    case 'ai_question':
      return `Asked AI: “${String(d.question || '').slice(0, 160)}”`;
    case 'lab_lookup_open':
      return `Opened a lab report looked up in the EMR${d.name ? ` (${d.name})` : ''}`;
    case 'settings_change':
      return `Changed WATI Settings: ${d.changes || ''}`;
    case 'user_create':
      return `Created user ${d.username || ''}`;
    case 'user_update':
      return `Changed user ${d.username || ''}${d.changes ? ` — ${d.changes}` : ''}`;
    case 'user_password_reset':
      return `Reset the password of ${d.username || ''}`;
    case 'user_sign_out':
      return `Signed ${d.username || ''} out everywhere`;
    case 'user_delete':
      return `Deleted user ${d.username || ''}`;
    case 'audit_view':
      return 'Viewed the audit log';
    case 'audit_export':
      return `Downloaded the audit log as ${String(d.format || '').toUpperCase()}`;
    default:
      return e.action;
  }
}

// ---- Writing ------------------------------------------------------------------------

/**
 * Records one event. `ctx`: { user, sessionId, req } — user is the account
 * object (req.user), or omit for failed sign-ins.
 */
export async function logAudit(ctx, { action, screen, target, details, at, durationMs, tabId } = {}) {
  if (!ACTIONS[action]) return;
  const c = await events();
  const doc = {
    at: at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date(),
    action,
    category: ACTIONS[action].cat,
    ...who(ctx.user),
    sessionId: ctx.sessionId || null,
    tabId: tabId || null,
    screen: screen || null,
    target: target && Object.keys(target).length ? target : null,
    details: details && Object.keys(details).length ? details : null,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
    ip: clientIp(ctx.req),
    device: device(ctx.req?.headers?.['user-agent']),
  };
  doc.text = describe(doc);
  await c.insertOne(doc);
}

/** A new session at sign-in; its id rides in the session cookie. */
export async function startSession(user, req) {
  const id = crypto.randomBytes(12).toString('hex');
  const now = new Date();
  await (await sessions()).insertOne({ _id: id, ...who(user), startedAt: now, lastSeenAt: now, endedAt: null, endReason: null, ip: clientIp(req), device: device(req.headers['user-agent']), tabs: {} });
  return id;
}

export async function endSession(id, reason) {
  if (!id) return null;
  const c = await sessions();
  const s = await c.findOne({ _id: id });
  if (!s || s.endedAt) return s;
  const now = new Date();
  await c.updateOne({ _id: id }, { $set: { endedAt: now, endReason: reason, lastSeenAt: now } });
  return { ...s, endedAt: now };
}

const lastTouch = new Map();
/** Any signed-in request keeps the session's "last seen" fresh (once a minute at most). */
export function touchSession(id) {
  if (!id || Date.now() - (lastTouch.get(id) || 0) < 60_000) return;
  lastTouch.set(id, Date.now());
  sessions()
    .then((c) => c.updateOne({ _id: id, endedAt: null }, { $set: { lastSeenAt: new Date() } }))
    .catch(() => {});
}

/** The browser's events and its per-tab active / idle / hidden time. */
export async function recordClientEvents(req, body = {}) {
  const ctx = { user: req.user, sessionId: req.sessionId, req };
  const list = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
  for (const e of list) {
    if (!ACTIONS[e?.action]?.client) continue;
    const at = new Date(e.at);
    await logAudit(ctx, {
      action: e.action,
      screen: typeof e.screen === 'string' ? e.screen.slice(0, 30) : null,
      target: clean(e.target),
      details: clean(e.details),
      at: Math.abs(at - Date.now()) < 3600_000 ? at : new Date(),
      durationMs: Number(e.durationMs),
      tabId: String(e.tabId || '').slice(0, 20),
    });
  }
  const hb = body.heartbeat;
  if (req.sessionId && hb && /^[a-z0-9]{4,20}$/i.test(String(hb.tabId || ''))) {
    const num = (v) => Math.max(0, Math.min(Number(v) || 0, 30 * 86400_000));
    await (await sessions()).updateOne(
      { _id: req.sessionId },
      {
        $set: {
          lastSeenAt: new Date(),
          [`tabs.${hb.tabId}`]: { activeMs: num(hb.activeMs), idleMs: num(hb.idleMs), hiddenMs: num(hb.hiddenMs), screen: String(hb.screen || '').slice(0, 30), at: new Date() },
        },
      },
    );
  }
  return list.length;
}

/** Keeps short strings / numbers / booleans from the browser — nothing nested or huge. */
function clean(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 15)) {
    if (!/^[a-zA-Z0-9_]{1,30}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 300);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// ---- Reading --------------------------------------------------------------------------

function range(q) {
  const from = DATE_RE.test(q.from || '') ? q.from : null;
  const to = DATE_RE.test(q.to || '') ? q.to : from;
  const at = {};
  if (from) at.$gte = new Date(`${from}T00:00:00+05:30`);
  if (to) at.$lt = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86400_000);
  return Object.keys(at).length ? at : null;
}

function filterOf(q = {}) {
  const f = {};
  const at = range(q);
  if (at) f.at = at;
  if (q.user) f.user = String(q.user).toLowerCase();
  if (q.department) f.department = String(q.department);
  const cats = String(q.category || '').split(',').filter((c) => CATEGORIES.includes(c));
  if (cats.length) f.category = { $in: cats };
  else if (q.presence !== 'show') f.category = { $ne: 'presence' }; // tab / idle noise hidden unless asked
  if (q.session) f.sessionId = String(q.session);
  const text = String(q.q || '').trim().slice(0, 60);
  if (text) {
    const rx = { $regex: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    f.$or = [{ text: rx }, { 'target.ipNo': rx }, { 'target.patientName': rx }, { 'target.uhid': rx }, { userName: rx }, { user: rx }];
  }
  return f;
}

const publicEvent = ({ _id, ...e }) => ({ id: String(_id), ...e });

export async function listAuditEvents(q = {}) {
  const c = await events();
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 10), 500);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const f = filterOf(q);
  const [total, docs] = await Promise.all([c.countDocuments(f), c.find(f).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).toArray()]);
  return { total, page, limit, items: docs.map(publicEvent) };
}

const tabTotals = (s) => {
  const t = Object.values(s.tabs || {});
  return {
    activeMs: t.reduce((a, x) => a + (x.activeMs || 0), 0),
    idleMs: t.reduce((a, x) => a + (x.idleMs || 0), 0),
    hiddenMs: t.reduce((a, x) => a + (x.hiddenMs || 0), 0),
  };
};

/** A session's end: signed out, or (no sign-out) last seen over 15 min ago. */
function sessionView(s) {
  const open = !s.endedAt && Date.now() - new Date(s.lastSeenAt).getTime() < 15 * 60_000;
  const end = s.endedAt || (open ? null : s.lastSeenAt);
  return {
    id: s._id,
    user: s.user,
    userName: s.userName,
    department: s.department,
    designation: s.designation,
    startedAt: s.startedAt,
    lastSeenAt: s.lastSeenAt,
    endedAt: end,
    open,
    endReason: s.endReason || (open ? null : 'No sign-out (closed or timed out)'),
    durationMs: new Date(end || Date.now()) - new Date(s.startedAt),
    ip: s.ip,
    device: s.device,
    ...tabTotals(s),
  };
}

function sessionFilter(q) {
  const f = {};
  const at = range(q);
  if (at) f.startedAt = at;
  if (q.user) f.user = String(q.user).toLowerCase();
  if (q.department) f.department = String(q.department);
  return f;
}

export async function listAuditSessions(q = {}) {
  const list = await (await sessions()).find(sessionFilter(q)).sort({ startedAt: -1 }).limit(500).toArray();
  const views = list.map(sessionView);
  // Actions per session (not presence).
  const ids = views.map((s) => s.id);
  const counts = await (await events())
    .aggregate([{ $match: { sessionId: { $in: ids }, category: { $ne: 'presence' } } }, { $group: { _id: '$sessionId', n: { $sum: 1 } } }])
    .toArray();
  const byId = new Map(counts.map((c) => [c._id, c.n]));
  return views.map((s) => ({ ...s, actions: byId.get(s.id) || 0 }));
}

/** Tiles + per-user and per-department tables for the filters. */
export async function auditSummary(q = {}) {
  const c = await events();
  const f = filterOf({ ...q, category: '', presence: 'show' });
  const rows = await c
    .aggregate([
      { $match: f },
      { $group: { _id: { user: '$user', action: '$action' }, n: { $sum: 1 }, userName: { $last: '$userName' }, department: { $last: '$department' }, designation: { $last: '$designation' }, last: { $max: '$at' } } },
    ])
    .toArray();
  const sess = await listAuditSessions(q);

  const users = new Map();
  const blank = (r) => ({
    user: r._id.user,
    userName: r.userName,
    department: r.department,
    designation: r.designation,
    lastAt: null,
    sessions: 0,
    activeMs: 0,
    idleMs: 0,
    hiddenMs: 0,
    actions: 0,
    whatsappClicks: 0,
    whatsappSends: 0,
    whatsappCancels: 0,
    pdfs: 0,
    exports: 0,
    aiQuestions: 0,
    failedLogins: 0,
  });
  for (const r of rows) {
    if (!r._id.user) continue;
    const u = users.get(r._id.user) || blank(r);
    if (!u.lastAt || r.last > u.lastAt) u.lastAt = r.last;
    if (ACTIONS[r._id.action]?.cat !== 'presence') u.actions += r.n;
    if (r._id.action === 'whatsapp_click') u.whatsappClicks += r.n;
    if (['whatsapp_send', 'whatsapp_share', 'whatsapp_retry', 'whatsapp_test'].includes(r._id.action)) u.whatsappSends += r.n;
    if (r._id.action === 'whatsapp_popup_cancel') u.whatsappCancels += r.n;
    if (r._id.action === 'pdf_open') u.pdfs += r.n;
    if (r._id.action === 'export') u.exports += r.n;
    if (r._id.action === 'ai_question') u.aiQuestions += r.n;
    users.set(r._id.user, u);
  }
  for (const s of sess) {
    const u = users.get(s.user) || blank({ _id: { user: s.user }, userName: s.userName, department: s.department, designation: s.designation });
    u.sessions += 1;
    u.activeMs += s.activeMs;
    u.idleMs += s.idleMs;
    u.hiddenMs += s.hiddenMs;
    if (!u.firstLoginAt || s.startedAt < u.firstLoginAt) u.firstLoginAt = s.startedAt;
    if (!u.lastAt || s.lastSeenAt > u.lastAt) u.lastAt = s.lastSeenAt;
    users.set(s.user, u);
  }
  const failed = await c.aggregate([{ $match: { ...filterOf({ ...q, category: 'auth' }), action: 'login_failed' } }, { $group: { _id: '$details.username', n: { $sum: 1 } } }]).toArray();
  for (const r of failed) {
    const u = users.get(String(r._id || '').toLowerCase());
    if (u) u.failedLogins += r.n;
  }

  const departments = new Map();
  for (const u of users.values()) {
    const d = departments.get(u.department) || { department: u.department, users: 0, sessions: 0, activeMs: 0, idleMs: 0, actions: 0, whatsappSends: 0, whatsappCancels: 0, pdfs: 0, aiQuestions: 0 };
    d.users += 1;
    for (const k of ['sessions', 'activeMs', 'idleMs', 'actions', 'whatsappSends', 'whatsappCancels', 'pdfs', 'aiQuestions']) d[k] += u[k];
    departments.set(u.department, d);
  }
  const userList = [...users.values()].sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));
  const total = (k) => userList.reduce((a, u) => a + (u[k] || 0), 0);
  return {
    tiles: {
      users: userList.length,
      sessions: sess.length,
      activeNow: sess.filter((s) => s.open).length,
      activeMs: total('activeMs'),
      idleMs: total('idleMs'),
      hiddenMs: total('hiddenMs'),
      actions: total('actions'),
      whatsappSends: total('whatsappSends'),
      whatsappCancels: total('whatsappCancels'),
      pdfs: total('pdfs'),
      aiQuestions: total('aiQuestions'),
      failedLogins: failed.reduce((a, r) => a + r.n, 0),
    },
    users: userList,
    departments: [...departments.values()].sort((a, b) => b.actions - a.actions),
  };
}

/** Ask AI conversations: questions and answers grouped by chat. */
export async function auditAiChats(q = {}) {
  const c = await events();
  const docs = await c.find({ ...filterOf({ ...q, category: 'ai' }), action: 'ai_question' }).sort({ at: 1 }).limit(2000).toArray();
  const chats = new Map();
  for (const d of docs) {
    const key = d.details?.chatId || `${d.user}|${d.sessionId}`;
    const chat = chats.get(key) || { id: key, user: d.user, userName: d.userName, department: d.department, startedAt: d.at, lastAt: d.at, turns: [] };
    chat.lastAt = d.at;
    chat.turns.push({ at: d.at, question: d.details?.question || '', reply: d.details?.reply || '', tools: d.details?.tools || '', fallback: Boolean(d.details?.fallback) });
    chats.set(key, chat);
  }
  return [...chats.values()].sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt)).slice(0, 200);
}

export async function auditFilterOptions() {
  const c = await events();
  const [users, departments] = await Promise.all([
    c.aggregate([{ $match: { user: { $ne: null } } }, { $group: { _id: '$user', userName: { $last: '$userName' }, department: { $last: '$department' } } }, { $sort: { userName: 1 } }]).toArray(),
    c.distinct('department', { department: { $nin: [null, ''] } }),
  ]);
  return { users: users.map((u) => ({ user: u._id, userName: u.userName, department: u.department })), departments: departments.sort() };
}

// ---- Export ----------------------------------------------------------------------------

const istText = (d) =>
  d ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(d)).replace(',', '') : '';

const COLUMNS = [
  { key: 'time', label: 'Time (IST)', width: 21 },
  { key: 'userName', label: 'User', width: 22 },
  { key: 'user', label: 'Username', width: 16 },
  { key: 'department', label: 'Department', width: 20 },
  { key: 'category', label: 'Type', width: 11 },
  { key: 'text', label: 'What happened', width: 70 },
  { key: 'patient', label: 'Patient', width: 26 },
  { key: 'ipNo', label: 'IP No / UHID', width: 14 },
  { key: 'screen', label: 'Screen', width: 16 },
  { key: 'device', label: 'Device', width: 16 },
  { key: 'ip', label: 'IP address', width: 15 },
  { key: 'sessionId', label: 'Session', width: 26 },
];

export async function exportAudit(q = {}, format = 'xlsx') {
  const c = await events();
  const docs = await c.find(filterOf(q)).sort({ at: -1 }).limit(50_000).toArray();
  const rows = docs.map((d) => ({
    time: istText(d.at),
    userName: d.userName,
    user: d.user,
    department: d.department,
    category: d.category,
    text: d.text,
    patient: d.target?.patientName || '',
    ipNo: d.target?.ipNo || d.target?.uhid || '',
    screen: SCREEN_NAMES[d.screen] || d.screen || '',
    device: d.device,
    ip: d.ip,
    sessionId: d.sessionId || '',
  }));
  const stamp = `${q.from || 'all'}${q.to && q.to !== q.from ? `_to_${q.to}` : ''}`;
  if (format === 'csv') {
    const quote = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [COLUMNS.map((col) => quote(col.label)).join(','), ...rows.map((r) => COLUMNS.map((col) => quote(r[col.key])).join(','))];
    return { buffer: Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8'), filename: `audit-log-${stamp}.csv`, mime: 'text/csv; charset=utf-8' };
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Audit log', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((col) => ({ header: col.label, key: col.key, width: col.width }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2956' } };
  for (const r of rows) ws.addRow(r);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: `audit-log-${stamp}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}
