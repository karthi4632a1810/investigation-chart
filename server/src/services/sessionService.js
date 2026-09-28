/**
 * Login session for the API: a signed, HttpOnly cookie set by POST /api/login.
 *
 * A cookie rather than a bearer token because the PDF links are plain
 * <a href target="_blank"> navigations, which can't carry an Authorization
 * header but do carry same-origin cookies. SameSite=Lax keeps other sites from
 * riding the session on the state-changing POST endpoints.
 *
 * The signing key defaults to one derived from the app's own login, so no new
 * config is needed and changing APP_PASSWORD signs everyone out. Set
 * SESSION_SECRET to decouple the two.
 */
import crypto from 'crypto';
import { config } from '../config.js';

const COOKIE_NAME = 'inv_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

const signingKey =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(`investigation-session:${config.auth.username}:${config.auth.password}`).digest();

function sign(payload) {
  return crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
}

function createSessionToken(username) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

/** The logged-in username, or null for a missing / tampered / expired session. */
export function getSessionUser(req) {
  const [payload, signature] = readCookie(req, COOKIE_NAME).split('.');
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return exp > Date.now() / 1000 ? u : null;
  } catch {
    return null;
  }
}

function cookieAttributes(req, maxAge) {
  // Secure only when the request really arrived over HTTPS — the VPS currently
  // serves plain HTTP on :1003, where a Secure cookie would never be sent back.
  const https = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
}

export function setSessionCookie(req, res, username) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(username))}; ${cookieAttributes(req, SESSION_TTL_SECONDS)}`,
  );
}

export function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttributes(req, 0)}`);
}

// Reachable without a session: the login screen needs these before anyone is signed in.
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/login', '/api/logout', '/api/session', '/api/config/hospital']);

/** Express middleware: every /api route except the public ones needs a valid session. */
export function requireSession(req, res, next) {
  if (!req.path.startsWith('/api/') || PUBLIC_API_PATHS.has(req.path)) return next();
  if (getSessionUser(req)) return next();
  res.status(401).json({ ok: false, error: 'Please log in again' });
}
