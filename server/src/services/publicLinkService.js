/**
 * Links that work without a login — for WhatsApp/WATI, which can't sign in.
 *
 *  - PDF links: /api/public/doc/<signed token>/<file name>.pdf, streamed from
 *    MinIO by this server. Used as the WhatsApp document header when
 *    PUBLIC_BASE_URL is set (e.g. https://reports.example.org). An https link
 *    that stays valid for weeks is what lets WATI's inbox show the PDF — the old
 *    MinIO link was plain http (blocked inside WATI's https page) and expired
 *    after an hour, so the inbox showed "This plugin is not supported".
 *  - The WATI webhook key, part of /api/public/wati-webhook/<key>.
 *
 * Tokens are HMAC-signed (object key + expiry), so a link can't be edited to
 * open another patient's report.
 */
import crypto from 'crypto';
import { config } from '../config.js';
import { getPdfPresignedUrl } from './storageService.js';

const signingKey =
  process.env.PUBLIC_LINK_SECRET ||
  crypto.createHash('sha256').update(`investigation-public-link:${config.auth.username}:${config.auth.password}`).digest();

export const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
// How long a WhatsApp PDF link keeps working (WhatsApp itself fetches it once, at
// send time; this is for opening it later from WATI's inbox). MinIO links max out at 7 days.
const LINK_DAYS = Math.min(7, Math.max(1, Number(process.env.WHATSAPP_LINK_DAYS) || 2));
const LINK_SECONDS = LINK_DAYS * 86400;

function sign(payload) {
  return crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function makeDocToken(objectKey, ttlSeconds = LINK_SECONDS) {
  const payload = Buffer.from(JSON.stringify({ k: objectKey, e: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** The object key a token grants, or null if it's forged or expired. */
export function readDocToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
  try {
    const { k, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof k === 'string' && e > Date.now() / 1000 ? k : null;
  } catch {
    return null;
  }
}

/** File name the patient sees in WhatsApp, e.g. "Discharge-Summary-IP07028433.pdf". */
export function whatsappFileName(label, id) {
  const clean = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${[clean(label), clean(id)].filter(Boolean).join('-') || 'Report'}.pdf`;
}

/** The document link handed to WATI for one WhatsApp message. */
export async function whatsappPdfUrl(objectKey, fileName) {
  // Without PUBLIC_BASE_URL: the MinIO link, as before (plain http until HTTPS is set up).
  if (!PUBLIC_BASE_URL) return getPdfPresignedUrl(objectKey, LINK_SECONDS);
  return `${PUBLIC_BASE_URL}/api/public/doc/${makeDocToken(objectKey)}/${encodeURIComponent(fileName || 'Report.pdf')}`;
}

export function whatsappLinkInfo() {
  return PUBLIC_BASE_URL
    ? { mode: 'app', baseUrl: PUBLIC_BASE_URL, https: PUBLIC_BASE_URL.startsWith('https://'), days: LINK_DAYS }
    : { mode: 'minio', baseUrl: null, https: false, days: LINK_DAYS };
}

/** Secret part of the WATI webhook URL (set WATI_WEBHOOK_KEY to choose it). */
export function webhookKey() {
  return process.env.WATI_WEBHOOK_KEY || sign('wati-webhook').slice(0, 32);
}

export function isWebhookKey(key) {
  return safeEqual(key, webhookKey());
}
