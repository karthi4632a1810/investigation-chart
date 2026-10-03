/**
 * Which permission each API route needs (userService.js has the model). The
 * screens hide what a user can't use; this is what actually stops it — a
 * read-only user can't send WhatsApp even by calling the API directly.
 *
 * Every /api route must be listed. One that isn't is super-admin only, so a new
 * route can't be left open by accident.
 */
import { FULL_PERMISSIONS, normalizePermissions } from './userService.js';
import { applyGlobalSwitches } from './appSettingsService.js';

// Staff: their own permissions with the global switches (Master Settings) on top.
const perms = (user) => (user.isSuperAdmin ? null : applyGlobalSwitches(normalizePermissions(user.permissions)));

// Rule helpers: each returns (user) => true | 'reason'
const screen = (id, level) => (user) => {
  const p = perms(user);
  if (!p) return true;
  const have = p.screens[id];
  if (level === 'read' ? have !== 'none' : have === 'write') return true;
  if (p.readOnlyMode && have === 'read') return 'the portal is in read-only mode for maintenance';
  return have === 'none' ? `no access to ${label(id)}` : `${label(id)} is read-only for you`;
};
const ai = (level) => (user) => {
  const p = perms(user);
  if (!p || (level === 'ask' ? p.ai !== 'none' : p.ai === 'act')) return true;
  if (p.readOnlyMode && level === 'act') return 'the portal is in read-only mode for maintenance';
  return level === 'ask' ? 'Ask AI is turned off for you' : 'Ask AI can only answer questions for you, not send';
};
const whatsappButton = (user) => {
  const p = perms(user);
  if (!p || p.whatsappButton) return true;
  return p.readOnlyMode ? 'the portal is in read-only mode for maintenance' : 'sending on WhatsApp is turned off for you';
};
const reportKind = (kind) => (user) => {
  const p = perms(user);
  if (!p || p.documents === 'both' || p.documents === kind) return true;
  return kind === 'lab' ? 'lab reports are hidden for you' : 'discharge summaries are hidden for you';
};
const superAdmin = (user) => (user.isSuperAdmin ? true : 'only the super admin can do this');
const downloads = (user) => {
  const p = perms(user);
  return !p || p.exports !== false ? true : p.readOnlyMode ? 'downloads are paused (read-only mode)' : 'downloads are turned off for everyone';
};
const loggedIn = () => true;
const all = (...rules) => (user) => {
  for (const r of rules) {
    const ok = r(user);
    if (ok !== true) return ok;
  }
  return true;
};
const anyOf = (...rules) => (user) => {
  let reason = 'no access';
  for (const r of rules) {
    const ok = r(user);
    if (ok === true) return true;
    reason = ok;
  }
  return reason;
};

const LABELS = { search: 'Lab Search', reports: 'Discharge Reports', labFinder: 'Lab Finder', wati: 'WATI Settings', monitor: 'the WhatsApp Monitor', audit: 'the Audit Log' };
const label = (id) => LABELS[id] || id;

const SEG = '[^/]+';
const RULES = [
  ['POST', /^\/api\/search$/, screen('search', 'read')],
  ['GET', /^\/api\/detail\//, screen('search', 'read')],

  ['GET', /^\/api\/reports\/(status|dates|search)$/, screen('reports', 'read')],
  ['GET', new RegExp(`^/api/reports/${SEG}/${SEG}/pdf$`), all(anyOf(screen('reports', 'read'), screen('labFinder', 'read')), reportKind('lab'))],
  ['GET', new RegExp(`^/api/reports/${SEG}/${SEG}/summary-pdf$`), all(anyOf(screen('reports', 'read'), screen('labFinder', 'read')), reportKind('summary'))],
  ['GET', new RegExp(`^/api/reports/${SEG}$`), screen('reports', 'read')],
  ['POST', /^\/api\/reports\/run-now$/, screen('reports', 'write')],
  ['POST', /^\/api\/reports\/backfill\//, superAdmin],
  ['POST', new RegExp(`^/api/reports/${SEG}/${SEG}/send-whatsapp$`), all(screen('reports', 'write'), whatsappButton)],
  ['POST', new RegExp(`^/api/reports/${SEG}/${SEG}/share$`), anyOf(all(screen('reports', 'write'), whatsappButton), all(ai('act'), screen('reports', 'read')))],

  // The Discharge Reports screen reads these too (test/live banner).
  ['GET', /^\/api\/wati\/settings$/, loggedIn],
  ['POST', /^\/api\/wati\/settings$/, screen('wati', 'write')],

  ['GET', /^\/api\/lab-results\/(tests|coverage)$/, screen('labFinder', 'read')],
  ['POST', /^\/api\/lab-results\/search$/, screen('labFinder', 'read')],
  // Also one patient's lab values (Ask AI's patient downloads).
  ['POST', /^\/api\/lab-results\/export$/, all(downloads, anyOf(screen('labFinder', 'read'), all(screen('reports', 'read'), reportKind('lab'))))],
  ['POST', /^\/api\/lab-results\/share$/, anyOf(screen('labFinder', 'write'), all(ai('act'), screen('labFinder', 'read')))],

  ['GET', /^\/api\/admin\/whatsapp\/export$/, all(downloads, screen('monitor', 'read'))],
  ['GET', /^\/api\/admin\/whatsapp\//, screen('monitor', 'read')],
  ['POST', /^\/api\/admin\/whatsapp\//, screen('monitor', 'write')],
  ['GET', /^\/api\/whatsapp\/not-on-whatsapp$/, screen('reports', 'read')],
  ['GET', /^\/api\/discharges\/export$/, all(downloads, screen('reports', 'read'))],

  ['POST', /^\/api\/assistant$/, ai('ask')],
  ['POST', /^\/api\/assistant\/test-whatsapp$/, ai('act')],
  // Lab reports looked up straight in the EMR (OP too) — same data as Lab Search.
  ['GET', /^\/api\/assistant\/lookup\/[^/]+\/[^/]+\.pdf$/, all(ai('ask'), screen('search', 'read'))],
  ['POST', /^\/api\/assistant\/lookup\/[^/]+\/[^/]+\/whatsapp$/, all(ai('act'), screen('search', 'read'))],
  ['GET', /^\/api\/assistant\/lookup\/[^/]+\/[^/]+\.pdf$/, all(ai('ask'), screen('search', 'read'))],
  ['POST', /^\/api\/assistant\/message\/[^/]+\/status$/, ai('act')],
  ['GET', /^\/api\/assistant\/export\/[^/]+\/[^/]+\.(pdf|xlsx|csv)$/, all(downloads, ai('ask'))],
  // Master Settings — super admin only (also covered by the default rule).
  [null, /^\/api\/settings(\/|$)/, superAdmin],

  [null, /^\/api\/users(\/|$)/, superAdmin],
  // Every signed-in browser reports its own screens / clicks / idle time; reading the log needs access.
  ['POST', /^\/api\/audit\/events$/, loggedIn],
  ['GET', /^\/api\/audit\/export$/, all(downloads, screen('audit', 'read'))],
  [null, /^\/api\/audit\//, screen('audit', 'read')],
  [null, /^\/api\/me(\/|$)/, loggedIn],
];

/** true, or the reason this user can't call this route. */
export function checkRoute(user, method, path) {
  for (const [m, re, rule] of RULES) {
    if ((m === null || m === method) && re.test(path)) return rule(user);
  }
  return superAdmin(user);
}

/** Express middleware, after requireSession has set req.user. */
export function authorize(req, res, next) {
  if (!req.user) return next();
  const ok = checkRoute(req.user, req.method === 'HEAD' ? 'GET' : req.method, req.path);
  if (ok === true) return next();
  res.status(403).json({ ok: false, code: 'forbidden', error: `Not allowed — ${ok}. Ask the super admin if you need it.` });
}

/** Which report PDFs this user may see / send: ['lab', 'summary'] or one of them. */
export function allowedDocuments(user) {
  const p = perms(user);
  if (!p || p.documents === 'both') return ['lab', 'summary'];
  return [p.documents];
}

/** The permission set to hand the assistant and the page (super admin = everything). */
export function effectivePermissions(user) {
  return perms(user) || FULL_PERMISSIONS;
}
