/**
 * Staff accounts and what each one may do (role-based access).
 *
 * - The login in server/.env (APP_USERNAME / APP_PASSWORD) is the one built-in
 *   super admin: full access, manages users, can't be disabled or deleted — so
 *   nobody can ever be locked out of the portal.
 * - Everyone else is a user in Mongo ("users"), with a scrypt-hashed password
 *   and a permission set: each screen off / read only / read & write, Ask AI
 *   off / ask / ask + send, the WhatsApp button on patient cards, which report
 *   PDFs they see, and optional access hours (days + time, India time).
 *
 * Permissions are read on every request (short cache), so a change applies at
 * once; a password reset or "sign out everywhere" bumps tokenVersion, which
 * ends that user's existing sessions.
 */
import crypto from 'crypto';
import { promisify } from 'util';
import { config } from '../config.js';
import { getMongoCollection } from './mongo.js';

const scrypt = promisify(crypto.scrypt);
const COLLECTION = 'users';
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const CACHE_MS = 5_000;
export const MIN_PASSWORD_LENGTH = 8;

// ---- Permission model ------------------------------------------------------

/** Screens, in tab order. `write` says what the higher level ("View & send" / "View & edit") adds on that screen. */
export const SCREENS = [
  { id: 'search', label: 'Lab Search', write: null },
  { id: 'reports', label: 'Discharge Reports', write: 'Check for new discharges now and send reports on WhatsApp' },
  { id: 'labFinder', label: 'Lab Finder', write: 'Share result lists on WhatsApp' },
  { id: 'wati', label: 'WATI Settings', write: 'Change Test / Live mode, the test number and the extra line' },
  { id: 'monitor', label: 'WhatsApp Monitor', write: 'Retry failed messages and ask WATI for the latest ticks' },
];
const SCREEN_IDS = SCREENS.map((s) => s.id);
const LEVELS = ['none', 'read', 'write'];
export const AI_LEVELS = ['none', 'ask', 'act']; // act = may also share on WhatsApp / send test messages
export const DOCUMENT_CHOICES = ['both', 'lab', 'summary'];
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // ISO order: 1 = Mon … 7 = Sun

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const screens = (levels) => Object.fromEntries(SCREEN_IDS.map((id) => [id, levels[id] || 'none']));
const ANY_TIME = { enabled: false, days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };

export const FULL_PERMISSIONS = {
  screens: screens({ search: 'read', reports: 'write', labFinder: 'write', wati: 'write', monitor: 'write' }),
  ai: 'act',
  whatsappButton: true,
  documents: 'both',
  schedule: { ...ANY_TIME },
};

/** Starting points in the user editor; everything stays adjustable. */
export const PRESETS = [
  { id: 'admin', label: 'Admin', description: 'Everything except managing users', permissions: FULL_PERMISSIONS },
  {
    id: 'doctor',
    label: 'Doctor',
    description: 'Reads reports and lab results, can ask AI',
    permissions: {
      screens: screens({ search: 'read', reports: 'read', labFinder: 'read' }),
      ai: 'ask',
      whatsappButton: false,
      documents: 'both',
      schedule: { ...ANY_TIME },
    },
  },
  {
    id: 'nurse',
    label: 'Nurse / ward staff',
    description: 'Opens reports and sends them to patients',
    permissions: {
      screens: screens({ search: 'read', reports: 'write' }),
      ai: 'none',
      whatsappButton: true,
      documents: 'both',
      schedule: { ...ANY_TIME },
    },
  },
  {
    id: 'lab',
    label: 'Lab staff',
    description: 'Lab reports and Lab Finder only',
    permissions: {
      screens: screens({ search: 'read', reports: 'read', labFinder: 'write' }),
      ai: 'ask',
      whatsappButton: false,
      documents: 'lab',
      schedule: { ...ANY_TIME },
    },
  },
  {
    id: 'frontdesk',
    label: 'Front desk',
    description: 'Sends reports on WhatsApp, Mon–Sat 8 am – 8 pm',
    permissions: {
      screens: screens({ reports: 'write' }),
      ai: 'none',
      whatsappButton: true,
      documents: 'both',
      schedule: { enabled: true, days: [1, 2, 3, 4, 5, 6], from: '08:00', to: '20:00' },
    },
  },
  {
    id: 'viewer',
    label: 'View only',
    description: 'Opens reports, changes nothing',
    permissions: {
      screens: screens({ reports: 'read' }),
      ai: 'none',
      whatsappButton: false,
      documents: 'both',
      schedule: { ...ANY_TIME },
    },
  },
];

const DEFAULT_PERMISSIONS = PRESETS.find((p) => p.id === 'viewer').permissions;

/** A complete, valid permission set from whatever the editor sent. */
export function normalizePermissions(input = {}) {
  const base = DEFAULT_PERMISSIONS;
  const out = { screens: {}, ai: base.ai, whatsappButton: base.whatsappButton, documents: base.documents, schedule: { ...base.schedule } };
  for (const id of SCREEN_IDS) {
    let level = LEVELS.includes(input.screens?.[id]) ? input.screens[id] : base.screens[id];
    if (id === 'search' && level === 'write') level = 'read'; // Lab Search has nothing to write
    out.screens[id] = level;
  }
  if (AI_LEVELS.includes(input.ai)) out.ai = input.ai;
  if (typeof input.whatsappButton === 'boolean') out.whatsappButton = input.whatsappButton;
  if (DOCUMENT_CHOICES.includes(input.documents)) out.documents = input.documents;
  const s = input.schedule || {};
  const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => d >= 1 && d <= 7))].sort() : base.schedule.days;
  out.schedule = {
    enabled: Boolean(s.enabled),
    days: days.length ? days : [1, 2, 3, 4, 5],
    from: TIME_RE.test(s.from) ? s.from : '09:00',
    to: TIME_RE.test(s.to) ? s.to : '18:00',
  };
  return out;
}

// ---- Access hours ------------------------------------------------------------

/** India time now: ISO weekday (1 = Mon) and minutes since midnight. */
function istClock(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return { day: ((ist.getUTCDay() + 6) % 7) + 1, minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether the schedule allows access now. Handles overnight windows (e.g. 20:00–08:00). */
export function scheduleAllows(schedule, now = new Date()) {
  if (!schedule?.enabled) return true;
  const { day, minutes } = istClock(now);
  const from = toMinutes(schedule.from);
  const to = toMinutes(schedule.to);
  const days = new Set(schedule.days);
  if (from === to) return days.has(day); // whole day
  if (from < to) return days.has(day) && minutes >= from && minutes < to;
  const yesterday = day === 1 ? 7 : day - 1;
  return (days.has(day) && minutes >= from) || (days.has(yesterday) && minutes < to);
}

/** "Mon–Fri, 09:00–18:00" / "Mon, Wed, Fri, 08:00–14:00" / "Any time". */
export function describeSchedule(schedule) {
  if (!schedule?.enabled) return 'Any time';
  const days = [...schedule.days].sort();
  const runs = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && d === last[1] + 1) last[1] = d;
    else runs.push([d, d]);
  }
  const dayText =
    days.length === 7
      ? 'Every day'
      : runs.map(([a, b]) => (a === b ? DAY_NAMES[a - 1] : b === a + 1 ? `${DAY_NAMES[a - 1]}, ${DAY_NAMES[b - 1]}` : `${DAY_NAMES[a - 1]}–${DAY_NAMES[b - 1]}`)).join(', ');
  const time = schedule.from === schedule.to ? 'all day' : `${schedule.from}–${schedule.to}`;
  return `${dayText}, ${time}`;
}

// ---- Passwords -----------------------------------------------------------------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, 64);
  return `s1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 's1' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function checkPasswordRules(password) {
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    throw Object.assign(new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`), { status: 400 });
  }
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// ---- Users ---------------------------------------------------------------------

const normalizeUsername = (u) => String(u || '').trim().toLowerCase();
const SUPER = () => normalizeUsername(config.auth.username);
export const isSuperAdminName = (username) => normalizeUsername(username) === SUPER();

function superAdminUser() {
  return {
    _id: SUPER(),
    username: config.auth.username,
    name: 'Super Admin',
    designation: 'Super admin',
    isSuperAdmin: true,
    active: true,
    tokenVersion: 0,
    permissions: FULL_PERMISSIONS,
  };
}

let indexReady = null;
async function collection() {
  const c = await getMongoCollection(COLLECTION);
  indexReady ||= c.createIndex({ createdAt: -1 }).catch(() => {});
  await indexReady;
  return c;
}

const PROFILE_FIELDS = ['name', 'designation', 'department', 'phone', 'email'];

function cleanProfile(input = {}) {
  const out = {};
  for (const key of PROFILE_FIELDS) {
    if (input[key] !== undefined) out[key] = String(input[key] || '').trim().slice(0, 120);
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) {
    throw Object.assign(new Error('That email address doesn\'t look right'), { status: 400 });
  }
  return out;
}

/** What the browser gets — never the password hash. */
export function publicUser(user) {
  if (!user) return null;
  const permissions = user.isSuperAdmin ? FULL_PERMISSIONS : normalizePermissions(user.permissions);
  return {
    username: user.username,
    name: user.name || user.username,
    designation: user.designation || '',
    department: user.department || '',
    phone: user.phone || '',
    email: user.email || '',
    isSuperAdmin: Boolean(user.isSuperAdmin),
    active: user.active !== false,
    // Set by the super admin's create / reset: the person must choose their
    // own password before using the portal, so only they know it.
    mustChangePassword: Boolean(user.mustChangePassword),
    permissions,
    scheduleText: describeSchedule(permissions.schedule),
    allowedNow: scheduleAllows(permissions.schedule),
    lockedUntil: user.lockedUntil && user.lockedUntil > new Date() ? user.lockedUntil : null,
    lastLoginAt: user.lastLoginAt || null,
    lastLoginIp: user.lastLoginIp || null,
    loginCount: user.loginCount || 0,
    createdAt: user.createdAt || null,
    createdBy: user.createdBy || null,
    updatedAt: user.updatedAt || null,
    updatedBy: user.updatedBy || null,
  };
}

const cache = new Map();
const forget = (username) => cache.delete(normalizeUsername(username));

/** The account behind a session, or null if it's gone, disabled or signed out everywhere. */
export async function resolveSessionUser(username, tokenVersion = 0) {
  const key = normalizeUsername(username);
  if (!key) return null;
  if (key === SUPER()) return superAdminUser();
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > CACHE_MS) {
    const user = await (await collection()).findOne({ _id: key });
    entry = { at: Date.now(), user };
    cache.set(key, entry);
  }
  const user = entry.user;
  if (!user || (user.tokenVersion || 0) !== (tokenVersion || 0)) return null;
  return user;
}

class LoginError extends Error {
  constructor(message, code, status = 401) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Checks a login. Returns the user, or throws LoginError with a message for the login screen. */
export async function authenticate(username, password, ip) {
  const key = normalizeUsername(username);
  if (!key || !password) throw new LoginError('Username and password are required', 'missing', 400);

  if (key === SUPER()) {
    if (!safeEqual(password, config.auth.password)) throw new LoginError('Invalid username or password', 'invalid');
    return superAdminUser();
  }

  const c = await collection();
  const user = await c.findOne({ _id: key });
  // Same message for an unknown user and a wrong password.
  if (!user) throw new LoginError('Invalid username or password', 'invalid');
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const mins = Math.ceil((user.lockedUntil - Date.now()) / 60_000);
    throw new LoginError(`Too many wrong passwords — try again in ${mins} minute${mins === 1 ? '' : 's'}, or ask the super admin to reset it`, 'locked', 423);
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    const failed = (user.failedLogins || 0) + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await c.updateOne(
      { _id: key },
      { $set: { failedLogins: lock ? 0 : failed, ...(lock ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } : {}) } },
    );
    forget(key);
    if (lock) throw new LoginError(`Too many wrong passwords — the account is locked for ${LOCK_MINUTES} minutes`, 'locked', 423);
    throw new LoginError('Invalid username or password', 'invalid');
  }
  if (user.active === false) throw new LoginError('This account is disabled — ask the super admin', 'disabled', 403);
  const permissions = normalizePermissions(user.permissions);
  if (!scheduleAllows(permissions.schedule)) {
    throw new LoginError(`Your access hours are ${describeSchedule(permissions.schedule)} (India time)`, 'outside_hours', 403);
  }
  await c.updateOne(
    { _id: key },
    { $set: { lastLoginAt: new Date(), lastLoginIp: ip || null, failedLogins: 0, lockedUntil: null }, $inc: { loginCount: 1 } },
  );
  forget(key);
  return user;
}

export async function listUsers() {
  const users = await (await collection()).find({}).sort({ createdAt: 1 }).toArray();
  return [publicUser(superAdminUser()), ...users.map(publicUser)];
}

export async function getUser(username) {
  const key = normalizeUsername(username);
  if (key === SUPER()) return publicUser(superAdminUser());
  return publicUser(await (await collection()).findOne({ _id: key }));
}

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

export async function createUser(input = {}, by) {
  const username = normalizeUsername(input.username);
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw httpError('Username: 3–32 letters, numbers, dot, dash or underscore');
  if (username === SUPER()) throw httpError('That username is reserved for the super admin');
  checkPasswordRules(input.password);
  const c = await collection();
  if (await c.findOne({ _id: username })) throw httpError('That username is already taken', 409);
  const now = new Date();
  const doc = {
    _id: username,
    username,
    ...cleanProfile(input),
    active: input.active !== false,
    permissions: normalizePermissions(input.permissions),
    passwordHash: await hashPassword(input.password),
    mustChangePassword: input.mustChangePassword !== false,
    tokenVersion: 0,
    loginCount: 0,
    failedLogins: 0,
    createdAt: now,
    createdBy: by || null,
    updatedAt: now,
    updatedBy: by || null,
  };
  doc.name ||= username;
  await c.insertOne(doc);
  return publicUser(doc);
}

export async function updateUser(username, input = {}, by) {
  const key = normalizeUsername(username);
  if (key === SUPER()) throw httpError('The super admin is set in the server .env and always has full access');
  const c = await collection();
  const set = { ...cleanProfile(input), updatedAt: new Date(), updatedBy: by || null };
  if (input.permissions) set.permissions = normalizePermissions(input.permissions);
  if (typeof input.active === 'boolean') set.active = input.active;
  if (input.unlock) Object.assign(set, { lockedUntil: null, failedLogins: 0 });
  const res = await c.updateOne({ _id: key }, { $set: set });
  if (!res.matchedCount) throw httpError('User not found', 404);
  forget(key);
  return publicUser(await c.findOne({ _id: key }));
}

/**
 * Sets a new password and signs the user out everywhere. A reset by the super
 * admin (mustChange) makes them choose their own at the next sign-in.
 */
export async function setPassword(username, password, by, { mustChange = false } = {}) {
  const key = normalizeUsername(username);
  if (key === SUPER()) throw httpError('The super admin password is set in the server .env (APP_PASSWORD)');
  checkPasswordRules(password);
  const c = await collection();
  const res = await c.updateOne(
    { _id: key },
    {
      $set: {
        passwordHash: await hashPassword(password),
        passwordChangedAt: new Date(),
        mustChangePassword: Boolean(mustChange),
        updatedAt: new Date(),
        updatedBy: by || null,
        lockedUntil: null,
        failedLogins: 0,
      },
      $inc: { tokenVersion: 1 },
    },
  );
  if (!res.matchedCount) throw httpError('User not found', 404);
  forget(key);
}

export async function changeOwnPassword(username, current, next) {
  const key = normalizeUsername(username);
  if (key === SUPER()) throw httpError('The super admin password is set in the server .env (APP_PASSWORD)');
  const user = await (await collection()).findOne({ _id: key });
  if (!user || !(await verifyPassword(current, user.passwordHash))) throw httpError('Your current password is wrong', 403);
  if (String(current) === String(next)) throw httpError('Choose a new password — not the one you were given');
  await setPassword(key, next, key, { mustChange: false });
  return (await (await collection()).findOne({ _id: key })).tokenVersion || 0;
}

/** Ends every session of this user (their next click shows the login screen). */
export async function signOutEverywhere(username, by) {
  const key = normalizeUsername(username);
  if (key === SUPER()) throw httpError('The super admin can\'t be signed out from here');
  const res = await (await collection()).updateOne({ _id: key }, { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date(), updatedBy: by || null } });
  if (!res.matchedCount) throw httpError('User not found', 404);
  forget(key);
}

export async function deleteUser(username) {
  const key = normalizeUsername(username);
  if (key === SUPER()) throw httpError('The super admin can\'t be deleted');
  const res = await (await collection()).deleteOne({ _id: key });
  if (!res.deletedCount) throw httpError('User not found', 404);
  forget(key);
}

/** For the user editor: screens, presets, choices. */
export function accessModel() {
  return { screens: SCREENS, presets: PRESETS, aiLevels: AI_LEVELS, documentChoices: DOCUMENT_CHOICES, days: DAY_NAMES, minPasswordLength: MIN_PASSWORD_LENGTH };
}
