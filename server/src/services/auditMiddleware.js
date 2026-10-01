/**
 * Records audit events for API calls as they finish (auditService.js) — so a
 * PDF opened, a WhatsApp sent, an export, a setting changed or an Ask AI
 * question is logged by the server no matter what the browser does. Each rule:
 * method, path, action, and what to note (null = don't log, e.g. a 404).
 */
import { endSession, logAudit, touchSession } from './auditService.js';
import { getMongoCollection } from './mongo.js';
import { getSessionClaims } from './sessionService.js';
import { resolveSessionUser } from './userService.js';

const SEG = '[^/]+';
const short = (v, n = 120) => String(v ?? '').slice(0, n);

/** "test: glucose · value: negative · from: 2026-09-01" from a query object. */
function summarise(q = {}) {
  return Object.entries(q || {})
    .filter(([k, v]) => v !== undefined && v !== null && String(v) !== '' && !['page', 'limit', 'format', 'view'].includes(k))
    .slice(0, 10)
    .map(([k, v]) => `${k}: ${short(Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : v, 40)}`)
    .join(' · ');
}

function lastQuestion(messages) {
  return short([...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m?.role === 'user')?.content || '', 500);
}

const SETTING_LABELS = { liveEnabled: 'Live mode', fixedNumber: 'test number', secondParam: 'extra line', confirmBeforeSend: 'confirm number popup', labReportTemplate: 'Ask AI lab template' };
const describeSettings = (body = {}) =>
  Object.entries(body)
    .filter(([k]) => SETTING_LABELS[k])
    .map(([k, v]) => `${SETTING_LABELS[k]} → ${typeof v === 'boolean' ? (v ? 'on' : 'off') : `“${short(v, 60).trim()}”`}`)
    .join(', ');

const auditViewSeen = new Map();

const RULES = [
  ['POST', /^\/api\/login$/, 'login', ({ req, body, ok }) =>
    ok ? { user: body.user } : { action: 'login_failed', details: { username: short(req.body?.username, 40), reason: short(body.error, 120) } }],
  ['POST', /^\/api\/logout$/, 'logout', async ({ claims }) => {
    if (!claims) return null;
    const s = await endSession(claims.sid, 'Signed out');
    return { details: { sessionMs: s?.startedAt ? Date.now() - new Date(s.startedAt).getTime() : null } };
  }],
  ['POST', /^\/api\/me\/password$/, 'password_changed', ({ ok }) => (ok ? {} : null)],

  ['POST', /^\/api\/search$/, 'search', ({ req }) => ({
    screen: 'search',
    details: { regNo: short(req.body?.regNo, 30), from: short(req.body?.fromDate, 10), to: short(req.body?.toDate, 10) },
  })],
  ['GET', /^\/api\/detail\/(.+)$/, 'lab_detail_open', ({ m, ok }) => (ok ? { screen: 'search', details: { orderId: short(m[1], 40) } } : null)],

  ['GET', /^\/api\/reports\/search$/, 'search', ({ req }) => ({ screen: 'reports', details: { query: summarise(req.query) } })],
  ['GET', new RegExp(`^/api/reports/(${SEG})/(${SEG})/(pdf|summary-pdf)$`), 'pdf_open', ({ m, ok }) =>
    ok ? { screen: 'reports', target: { date: m[1], ipNo: m[2] }, details: { document: m[3] === 'pdf' ? 'lab' : 'summary' } } : null],
  ['POST', /^\/api\/reports\/run-now$/, 'run_now', () => ({ screen: 'reports' })],
  ['POST', new RegExp(`^/api/reports/(${SEG})/(${SEG})/send-whatsapp$`), 'whatsapp_send', ({ m, res, body, ok }) => ({
    screen: 'reports',
    target: { date: m[1], ipNo: m[2] },
    details: {
      ok,
      to: res.locals.auditExtra?.to || short(body.sentTo, 20),
      numberEdited: Boolean(res.locals.auditExtra?.numberEdited),
      documents: (body.sent || []).map((d) => d.label).join(' + '),
      error: ok ? undefined : short(body.error, 200),
    },
  })],
  ['POST', new RegExp(`^/api/reports/(${SEG})/(${SEG})/share$`), 'whatsapp_share', ({ m, body, ok }) => ({
    screen: 'reports',
    target: { date: m[1], ipNo: m[2] },
    details: { ok, what: 'patient reports', to: short(body.sentTo, 20), error: ok ? undefined : short(body.error, 200) },
  })],

  ['POST', /^\/api\/lab-results\/search$/, 'search', ({ req }) => ({ screen: 'labFinder', details: { query: summarise(req.body) } })],
  ['POST', /^\/api\/lab-results\/export$/, 'export', ({ req, ok }) =>
    ok ? { screen: 'labFinder', details: { what: req.body?.query?.ipNo ? `lab values of ${short(req.body.query.ipNo, 20)}` : 'lab results list', format: short(req.body?.format, 6), query: summarise(req.body?.query) } } : null],
  ['POST', /^\/api\/lab-results\/share$/, 'whatsapp_share', ({ body, ok }) => ({
    screen: 'labFinder',
    details: { ok, what: 'lab results list', to: short(body.sentTo, 20), error: ok ? undefined : short(body.error, 200) },
  })],

  ['GET', /^\/api\/admin\/whatsapp\/export$/, 'export', ({ req, ok }) =>
    ok ? { screen: 'admin', details: { what: `WhatsApp ${req.query.view === 'patients' ? 'patient-wise' : 'message-wise'} report`, format: short(req.query.format, 6), query: summarise(req.query) } } : null],
  ['POST', new RegExp(`^/api/admin/whatsapp/messages/(${SEG})/retry$`), 'whatsapp_retry', ({ body, ok }) => ({
    screen: 'admin',
    target: body.message ? { patientName: body.message.patientName, ipNo: body.message.ipNo, date: body.message.dischargeDate } : null,
    details: { ok, error: ok ? undefined : short(body.error, 200) },
  })],
  ['POST', /^\/api\/admin\/whatsapp\/refresh$/, 'whatsapp_check', () => ({ screen: 'admin' })],
  ['GET', /^\/api\/discharges\/export$/, 'export', ({ req, ok }) =>
    ok ? { screen: 'ai', details: { what: 'discharge report', format: short(req.query.format, 6), query: summarise(req.query) } } : null],

  ['POST', /^\/api\/wati\/settings$/, 'settings_change', ({ req, ok }) => (ok ? { screen: 'wati', details: { changes: describeSettings(req.body) } } : null)],

  ['POST', /^\/api\/assistant$/, 'ai_question', ({ req, body }) => ({
    screen: 'ai',
    details: {
      chatId: short(req.body?.chatId, 40),
      question: lastQuestion(req.body?.messages),
      reply: short(body.reply || body.error, 1500),
      tools: (body.blocks || []).map((b) => b.type).join(', '),
      fallback: Boolean(body.fallback),
    },
  })],
  ['POST', /^\/api\/assistant\/test-whatsapp$/, 'whatsapp_test', ({ req, body, ok }) => ({
    screen: 'ai',
    details: { ok, to: short(body.sentTo, 20), message: short(req.body?.message, 200), error: ok ? undefined : short(body.error, 200) },
  })],
  ['GET', new RegExp(`^/api/assistant/lookup/${SEG}/${SEG}\\.pdf$`), 'lab_lookup_open', ({ req, ok }) => (ok ? { screen: 'ai', details: { name: short(req.query.name, 60) } } : null)],
  ['POST', new RegExp(`^/api/assistant/lookup/${SEG}/${SEG}/whatsapp$`), 'whatsapp_share', ({ req, body, ok }) => ({
    screen: 'ai',
    target: { uhid: short(req.body?.patientId, 20), patientName: short(req.body?.name, 60) },
    details: { ok, what: 'lab report (Ask AI lookup)', to: short(body.sentTo, 20), error: ok ? undefined : short(body.error, 200) },
  })],

  ['POST', /^\/api\/users$/, 'user_create', ({ req, ok }) => (ok ? { screen: 'users', details: { username: short(req.body?.username, 40) } } : null)],
  ['PUT', new RegExp(`^/api/users/(${SEG})$`), 'user_update', ({ m, req, ok }) =>
    ok ? { screen: 'users', details: { username: short(decodeURIComponent(m[1]), 40), changes: Object.keys(req.body || {}).join(', ') } } : null],
  ['POST', new RegExp(`^/api/users/(${SEG})/password$`), 'user_password_reset', ({ m, ok }) => (ok ? { screen: 'users', details: { username: short(decodeURIComponent(m[1]), 40) } } : null)],
  ['POST', new RegExp(`^/api/users/(${SEG})/sign-out$`), 'user_sign_out', ({ m, ok }) => (ok ? { screen: 'users', details: { username: short(decodeURIComponent(m[1]), 40) } } : null)],
  ['DELETE', new RegExp(`^/api/users/(${SEG})$`), 'user_delete', ({ m, ok }) => (ok ? { screen: 'users', details: { username: short(decodeURIComponent(m[1]), 40) } } : null)],

  // Viewing the audit log is itself logged — once per 10 minutes per user.
  ['GET', /^\/api\/audit\/summary$/, 'audit_view', ({ req, ok }) => {
    const key = req.user?.username;
    if (!ok || !key || Date.now() - (auditViewSeen.get(key) || 0) < 10 * 60_000) return null;
    auditViewSeen.set(key, Date.now());
    return { screen: 'audit' };
  }],
  ['GET', /^\/api\/audit\/export$/, 'audit_export', ({ req, ok }) => (ok ? { screen: 'audit', details: { format: short(req.query.format, 6), query: summarise(req.query) } } : null)],
];

/** Fills in the patient's name and department for a target given by date + IP number. */
async function withPatient(target) {
  if (!target?.ipNo || !target.date || target.patientName) return target;
  const r = await (await getMongoCollection('discharge_reports')).findOne({ date: target.date, ipNo: target.ipNo }, { projection: { _id: 0, name: 1, department: 1 } });
  return r ? { ...target, patientName: r.name, patientDepartment: r.department } : target;
}

export function auditMiddleware(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const rule = RULES.find(([m, re]) => m === method && re.test(req.path));
  if (!rule) return next();

  const claims = getSessionClaims(req); // read now — logout clears the cookie
  const json = res.json.bind(res);
  res.json = (body) => {
    res.locals.auditBody = body;
    return json(body);
  };
  res.on('finish', () => {
    const [, re, action, extract] = rule;
    const ok = res.statusCode < 400;
    Promise.resolve()
      .then(() => extract({ req, res, m: re.exec(req.path), body: res.locals.auditBody || {}, ok, claims }))
      .then(async (out) => {
        if (!out) return;
        const { user: outUser, action: outAction, ...event } = out;
        const user = outUser || req.user || (claims ? await resolveSessionUser(claims.u, claims.v) : null);
        const sessionId = req.sessionId || claims?.sid || null;
        if (event.details) for (const k of Object.keys(event.details)) if (event.details[k] === undefined) delete event.details[k];
        event.target = await withPatient(event.target);
        await logAudit({ user, sessionId, req }, { action: outAction || action, ...event });
      })
      .catch((error) => console.warn(`[audit] ${action}: ${error.message}`));
  });
  next();
}

/** For requireSession: keep the session's "last seen" fresh. */
export { touchSession };
