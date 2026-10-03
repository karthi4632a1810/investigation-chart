/**
 * Master settings (super admin): every tunable of the portal in one place,
 * stored in Mongo ("app_settings") and read from an in-memory copy so services
 * can call setting('retry.everyHours') anywhere, synchronously. A value never
 * set falls back to the server .env (when the setting had one) and then to the
 * built-in default — so nothing changes until someone changes it.
 *
 * Global switches (features.*, maintenance.readOnly) sit above every user's own
 * permissions: effectivePermissions() applies them to staff accounts (never to
 * the super admin, who can't lock themself out).
 */
import { getMongoCollection } from './mongo.js';

const COLLECTION = 'app_settings';
const DOC_ID = 'master';
const HISTORY_KEEP = 100;

const envNum = (name) => (process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : undefined);
const envBool = (name) => (process.env[name] === undefined || process.env[name] === '' ? undefined : !/^(off|false|0|no)$/i.test(process.env[name]));

/** Sections, in the order the screen shows them. */
export const SECTIONS = [
  { id: 'features', title: 'Features for everyone', icon: 'toggle', intro: 'Switch a feature off for all staff at once — above each person’s own permissions. The super admin always keeps everything.' },
  { id: 'whatsapp', title: 'WhatsApp sending', icon: 'whatsapp', intro: 'How reports go out. Live / Test mode, the test number, the extra line and the Ask AI template are on the WATI Settings screen.' },
  { id: 'retry', title: 'Automatic retries', icon: 'retry', intro: 'Re-sending reports that failed or came back “not on WhatsApp” (that tag is sometimes wrong — a phone that’s off or out of data).' },
  { id: 'wati', title: 'WATI API usage', icon: 'gauge', intro: 'Every WATI API call, sends included, uses the account’s monthly quota (shared with the EMR’s own messages).' },
  { id: 'discharge', title: 'Discharge automation', icon: 'clock', intro: 'The check that finds new discharges in the EMR and makes the lab reports and summaries.' },
  { id: 'security', title: 'Sign-in & security', icon: 'lock', intro: 'Sessions, wrong-password lockout and passwords for staff accounts.' },
  { id: 'ai', title: 'Ask AI', icon: 'sparkles', intro: 'What the assistant may do and see.' },
  { id: 'audit', title: 'Audit log', icon: 'shield', intro: 'What is recorded and for how long.' },
  { id: 'notice', title: 'Announcement & maintenance', icon: 'megaphone', intro: 'A message at the top of every screen, and a read-only mode for maintenance.' },
];

/**
 * Every setting. type: bool | number | select | text. `env`: the .env
 * variable it used to come from (its value is the default). `public`: sent to
 * every signed-in browser (switches, banner, refresh timings).
 */
export const SETTINGS = [
  // Features (global switches)
  { key: 'features.whatsappButton', section: 'features', type: 'bool', default: true, public: true, label: 'WhatsApp button on patient cards', help: 'Off hides the round WhatsApp button for all staff, even those whose account allows sending. Automatic sending is separate (below).' },
  { key: 'features.askAi', section: 'features', type: 'bool', default: true, public: true, label: 'Ask AI', help: 'Off removes the Ask AI button for all staff.' },
  { key: 'features.aiSend', section: 'features', type: 'bool', default: true, public: true, label: 'Ask AI can send on WhatsApp', help: 'Off: Ask AI still answers, but can’t share reports, send lab lookups or test messages.' },
  { key: 'features.opLookup', section: 'features', type: 'bool', default: true, public: true, label: 'Ask AI: OP / any patient’s lab report from the EMR', help: 'Lets Ask AI fetch a lab report straight from the EMR for a UHID that isn’t in the discharge list.' },
  { key: 'features.labSearch', section: 'features', type: 'bool', default: true, public: true, label: 'Lab Search screen', help: 'Off hides Lab Search for all staff.' },
  { key: 'features.labFinder', section: 'features', type: 'bool', default: true, public: true, label: 'Lab Finder screen', help: 'Off hides Lab Finder for all staff.' },
  { key: 'features.exports', section: 'features', type: 'bool', default: true, public: true, label: 'Downloads & exports', help: 'Off blocks Excel / PDF / Word / CSV / JSON downloads of lists and reports for all staff (opening a patient’s own PDF still works).' },

  // WhatsApp sending
  { key: 'whatsapp.autoSend', section: 'whatsapp', type: 'bool', default: true, label: 'Send automatically in Live mode', help: 'In Live mode each patient’s reports go out as soon as they are made. Off: Live mode only affects the WhatsApp button (staff send by hand).' },
  { key: 'whatsapp.linkDays', section: 'whatsapp', type: 'number', min: 1, max: 7, step: 1, unit: 'days', default: 2, env: 'WHATSAPP_LINK_DAYS', label: 'PDF link in the message works for', help: 'WhatsApp saves the file on the phone when it arrives; the link matters for opening it from WATI’s inbox later.' },

  // Retries
  { key: 'retry.enabled', section: 'retry', type: 'bool', default: true, public: true, label: 'Retry failed reports automatically', help: 'Off: failed reports wait for someone to press Retry in the WhatsApp Monitor.' },
  { key: 'retry.notOnWhatsApp', section: 'retry', type: 'bool', default: true, public: true, label: 'Also retry “Not on WhatsApp”', help: 'Staff have seen these go through on a retry — the phone was off or out of data.' },
  { key: 'retry.everyHours', section: 'retry', type: 'number', min: 1, max: 24, step: 1, unit: 'hours', default: 6, env: 'WHATSAPP_RETRY_HOURS', public: true, label: 'Retry every', help: '6 hours = 4 tries a day.' },
  { key: 'retry.forDays', section: 'retry', type: 'number', min: 1, max: 7, step: 1, unit: 'days', default: 3, env: 'WHATSAPP_RETRY_DAYS', public: true, label: 'Keep retrying for', help: 'Counted from the first send.' },
  { key: 'retry.quickMinutes', section: 'retry', type: 'number', min: 0, max: 120, step: 5, unit: 'min', default: 15, public: true, label: 'Quick first retry after', help: 'For a plain failure (network, WATI busy) — one fast retry before the hourly rhythm. 0 = no quick retry.' },
  { key: 'retry.dailyCap', section: 'retry', type: 'number', min: 0, max: 5000, step: 50, unit: 'tries / day', default: 300, env: 'WATI_RETRY_CALLS_PER_DAY', label: 'Most automatic tries a day', help: 'A safety cap so retries can never use up WATI’s monthly quota. Retry by hand is never limited.' },

  // WATI
  { key: 'wati.statusPolling', section: 'wati', type: 'bool', default: true, envBool: 'WATI_STATUS_POLL', label: 'Ask WATI for delivered / read ticks', help: 'Not needed once the WATI webhook is connected (it then stops by itself). Off saves quota but ticks only arrive by webhook.' },
  { key: 'wati.statusChecksPerDay', section: 'wati', type: 'number', min: 0, max: 2000, step: 10, unit: 'calls / day', default: 100, env: 'WATI_STATUS_CHECKS_PER_DAY', label: 'Most status checks a day', help: 'Each message is checked 3 times (30 min, 6 h, 24 h after sending), within this allowance.' },

  // Discharge automation
  { key: 'discharge.autoCheck', section: 'discharge', type: 'bool', default: true, label: 'Check the EMR for new discharges automatically', help: 'Off pauses the automation — no new reports until it’s on again (Check Now still works).' },
  { key: 'discharge.checkMinutes', section: 'discharge', type: 'select', options: [5, 10, 15, 30, 60], unit: 'min', default: 15, label: 'Check every', help: 'On the clock (e.g. 15 min = :00, :15, :30, :45). Shorter = reports sooner, more EMR load.' },
  { key: 'reports.refreshSeconds', section: 'discharge', type: 'select', options: [10, 20, 30, 60, 120], unit: 'sec', default: 20, public: true, label: 'Discharge Reports screen refreshes every', help: 'Quietly, without closing popups. It pauses while a WhatsApp popup is open.' },

  // Security
  { key: 'auth.sessionHours', section: 'security', type: 'number', min: 1, max: 24, step: 1, unit: 'hours', default: 12, label: 'Stay signed in for', help: 'After this, everyone signs in again. Applies to new sign-ins.' },
  { key: 'auth.idleSignOutMinutes', section: 'security', type: 'number', min: 0, max: 480, step: 5, unit: 'min', default: 0, public: true, label: 'Sign out after no activity for', help: 'For shared ward computers: no mouse or keyboard for this long signs the person out. 0 = never.' },
  { key: 'auth.maxFailedLogins', section: 'security', type: 'number', min: 3, max: 20, step: 1, unit: 'tries', default: 5, label: 'Lock an account after wrong passwords', help: 'The super admin’s own login is never locked.' },
  { key: 'auth.lockMinutes', section: 'security', type: 'number', min: 5, max: 240, step: 5, unit: 'min', default: 15, label: 'Locked for', help: 'Or unlock it straight away on the Users screen.' },
  { key: 'auth.minPasswordLength', section: 'security', type: 'number', min: 6, max: 32, step: 1, unit: 'characters', default: 8, label: 'Shortest password allowed', help: 'For new and changed passwords.' },

  // Ask AI
  { key: 'ai.sharePatientData', section: 'ai', type: 'bool', default: true, envBool: 'AI_SHARE_PATIENT_DATA', label: 'Let the AI service read patient details to answer', help: 'Needed for answers like “her WhatsApp number” or “compare these two”. Off: Ask AI shows the same cards and files but only gets counts (names, numbers and values stay in the portal). ABHA ID and religion are never sent.' },
  { key: 'ai.lookupDays', section: 'ai', type: 'number', min: 7, max: 365, step: 1, unit: 'days', default: 30, label: 'EMR lab lookup searches back', help: 'When the user gives no dates.' },

  // Audit
  { key: 'audit.retentionDays', section: 'audit', type: 'number', min: 30, max: 1825, step: 30, unit: 'days', default: 365, env: 'AUDIT_RETENTION_DAYS', label: 'Keep audit records for', help: 'Older records are removed automatically.' },
  { key: 'audit.trackPresence', section: 'audit', type: 'bool', default: true, public: true, label: 'Record tab switches and idle time', help: 'Active / idle / away-from-tab time per session. Clicks, PDFs, WhatsApp, Ask AI and settings are always recorded.' },

  // Notice & maintenance
  { key: 'notice.text', section: 'notice', type: 'text', max: 240, default: '', public: true, label: 'Announcement for everyone', help: 'Shown at the top of every screen, e.g. “EMR maintenance tonight 10–11 pm — reports may be delayed.” Empty = none.' },
  { key: 'notice.tone', section: 'notice', type: 'select', options: ['info', 'warning', 'danger'], default: 'info', public: true, label: 'Announcement colour', help: 'Blue (info), amber (warning) or red (urgent).' },
  { key: 'maintenance.readOnly', section: 'notice', type: 'bool', default: false, public: true, label: 'Read-only mode', help: 'Staff can open and view everything but can’t send, retry, change settings or download. Automatic sending is paused too. The super admin is not affected.' },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** The value before anyone changes it: the .env one if set, else the built-in default. */
function baseValue(def) {
  if (def.env) {
    const v = envNum(def.env);
    if (v !== undefined) return clamp(def, v);
  }
  if (def.envBool) {
    const v = envBool(def.envBool);
    if (v !== undefined) return v;
  }
  return def.default;
}

function clamp(def, n) {
  let v = Math.round(Number(n) / (def.step || 1)) * (def.step || 1);
  if (def.min !== undefined) v = Math.max(def.min, v);
  if (def.max !== undefined) v = Math.min(def.max, v);
  return v;
}

/** A valid value for the setting, or throws with a message for the screen. */
function validate(def, value) {
  const fail = (msg) => {
    throw Object.assign(new Error(`${def.label}: ${msg}`), { status: 400 });
  };
  switch (def.type) {
    case 'bool':
      if (typeof value !== 'boolean') fail('must be on or off');
      return value;
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) fail('must be a number');
      if (n < def.min || n > def.max) fail(`must be between ${def.min} and ${def.max}`);
      return clamp(def, n);
    }
    case 'select': {
      const match = def.options.find((o) => String(o) === String(value));
      if (match === undefined) fail(`must be one of ${def.options.join(', ')}`);
      return match;
    }
    case 'text':
      return String(value ?? '').trim().slice(0, def.max || 500);
    default:
      fail('unknown type');
  }
  return value;
}

// ---- The in-memory copy ----------------------------------------------------------

let stored = {};
let meta = { updatedAt: null, updatedBy: null };
const listeners = [];

export function setting(key) {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unknown setting ${key}`);
  return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : baseValue(def);
}

/** Run something when settings change (e.g. the audit log's retention). */
export function onSettingsChange(fn) {
  listeners.push(fn);
}

/**
 * Mongo stores "retry.everyHours" under values.retry.everyHours (a dot is a
 * path), so read the values back as flat "section.name" keys.
 */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !BY_KEY.has(key)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

export async function loadSettings() {
  try {
    const doc = await (await getMongoCollection(COLLECTION)).findOne({ _id: DOC_ID });
    const values = {};
    for (const [key, value] of Object.entries(flatten(doc?.values))) {
      const def = BY_KEY.get(key);
      if (!def) continue;
      try {
        values[key] = validate(def, value);
      } catch {
        // an old / invalid value falls back to the default
      }
    }
    stored = values;
    meta = { updatedAt: doc?.updatedAt || null, updatedBy: doc?.updatedBy || null };
  } catch (error) {
    console.warn(`[settings] using defaults: ${error.message}`);
  }
  return stored;
}

/** Keeps every server process in step (cheap: one small document). */
export function startSettingsRefresh() {
  setInterval(() => loadSettings().catch(() => {}), 60_000).unref?.();
}

const display = (def, v) => (def.type === 'bool' ? (v ? 'on' : 'off') : def.type === 'text' ? (v ? `“${String(v).slice(0, 60)}”` : 'empty') : `${v}${def.unit ? ` ${def.unit}` : ''}`);

/**
 * Saves changes: { key: value } — null (or "default") resets a key.
 * Returns the full screen state. Each change goes into the history.
 */
export async function updateSettings(patch = {}, by) {
  const c = await getMongoCollection(COLLECTION);
  const set = {};
  const unset = {};
  const changes = [];
  for (const [key, raw] of Object.entries(patch)) {
    const def = BY_KEY.get(key);
    if (!def) throw Object.assign(new Error(`Unknown setting ${key}`), { status: 400 });
    const before = setting(key);
    if (raw === null || raw === 'default') {
      unset[`values.${key}`] = '';
      const after = baseValue(def);
      if (after !== before) changes.push({ key, label: def.label, from: display(def, before), to: `${display(def, after)} (default)` });
      continue;
    }
    const value = validate(def, raw);
    set[`values.${key}`] = value;
    if (value !== before) changes.push({ key, label: def.label, from: display(def, before), to: display(def, value) });
  }
  const now = new Date();
  const update = { $set: { ...set, updatedAt: now, updatedBy: by || null } };
  if (Object.keys(unset).length) update.$unset = unset;
  if (changes.length) update.$push = { history: { $each: changes.map((ch) => ({ ...ch, at: now, by: by || null })), $slice: -HISTORY_KEEP } };
  await c.updateOne({ _id: DOC_ID }, update, { upsert: true });
  await loadSettings();
  for (const fn of listeners) {
    try {
      await fn(changes);
    } catch (error) {
      console.warn(`[settings] after change: ${error.message}`);
    }
  }
  return { ...(await settingsScreen()), changes };
}

/** Everything the Master Settings screen needs. */
export async function settingsScreen() {
  const doc = await (await getMongoCollection(COLLECTION)).findOne({ _id: DOC_ID }, { projection: { history: { $slice: -40 } } });
  return {
    sections: SECTIONS,
    settings: SETTINGS.map((def) => ({
      ...def,
      value: setting(def.key),
      baseValue: baseValue(def),
      changed: Object.prototype.hasOwnProperty.call(stored, def.key),
      fromEnv: Boolean((def.env && envNum(def.env) !== undefined) || (def.envBool && envBool(def.envBool) !== undefined)),
    })),
    updatedAt: meta.updatedAt,
    updatedBy: meta.updatedBy,
    history: (doc?.history || []).slice().reverse(),
  };
}

/** What every signed-in browser gets (switches, banner, timings). */
export function publicSettings() {
  return Object.fromEntries(SETTINGS.filter((d) => d.public).map((d) => [d.key, setting(d.key)]));
}

// ---- Global switches over a staff member's permissions ------------------------------

/**
 * A staff member's permissions with the global switches applied — what they
 * can actually do right now. (The super admin isn't passed through this.)
 */
export function applyGlobalSwitches(p) {
  const out = { ...p, screens: { ...p.screens } };
  if (!setting('features.whatsappButton')) out.whatsappButton = false;
  if (!setting('features.askAi')) out.ai = 'none';
  else if (!setting('features.aiSend') && out.ai === 'act') out.ai = 'ask';
  if (!setting('features.labSearch')) out.screens.search = 'none';
  if (!setting('features.labFinder')) out.screens.labFinder = 'none';
  out.exports = setting('features.exports');
  out.opLookup = setting('features.opLookup');
  if (setting('maintenance.readOnly')) {
    for (const id of Object.keys(out.screens)) if (out.screens[id] === 'write') out.screens[id] = 'read';
    if (out.ai === 'act') out.ai = 'ask';
    out.whatsappButton = false;
    out.exports = false;
    out.readOnlyMode = true;
  }
  return out;
}
