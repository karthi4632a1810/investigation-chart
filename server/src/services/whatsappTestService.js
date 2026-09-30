/**
 * "Send a test WhatsApp" (Ask AI): staff type a message and a number, and it
 * goes out through the same approved template the reports use — the text as the
 * {{2}} line, with a one-page "WhatsApp test" PDF as the document header.
 * WhatsApp only allows free text inside a 24-hour chat window, so a template is
 * the only way to reach any number — and it tests the real report path.
 * Logged in the WhatsApp Monitor as a "Test message".
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';
import { renderHtmlToPdf } from './investigationPdfService.js';
import { BRAND_CSS, esc, formatGeneratedDate, letterheadHtml } from './pdfBranding.js';
import { whatsappPdfUrl } from './publicLinkService.js';
import { uploadPdfFile } from './storageService.js';
import { sendInvestigationReportWhatsApp, toWatiNumber } from './watiService.js';

export const TEST_MESSAGE_MAX = 300;
// {{1}} of the template ("Dear …,").
const RECIPIENT = 'Sir/Madam';

/** One line (template parameters can't hold line breaks), trimmed and capped. */
export function cleanTestMessage(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .trim()
    .slice(0, TEST_MESSAGE_MAX);
}

/** Digits WATI accepts (91XXXXXXXXXX for Indian mobiles), or '' if it isn't a phone number. */
export function cleanTestNumber(raw) {
  const digits = toWatiNumber(raw);
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  if (digits.length >= 11 && digits.length <= 15 && !digits.startsWith('0') && !digits.startsWith('91')) return digits;
  return '';
}

export const formatNumber = (digits) => (/^91\d{10}$/.test(digits) ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}` : `+${digits}`);

function istNow() {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date());
}

async function testPdf({ message, toNumber, sentBy }) {
  const html = `<!doctype html><html><head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; color: #1e293b; }
  @page { size: A4; margin: 12mm; }
${BRAND_CSS}
  .msg { margin: 14px 0; padding: 16px 18px; border: 1px solid #bfdbfe; border-radius: 10px; background: #eff6ff; font-size: 14px; font-weight: 600; color: #0b2956; line-height: 1.5; overflow-wrap: anywhere; }
  .label { font-size: 8px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: #64748b; margin-bottom: 6px; }
  .rows { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .row { padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; font-size: 11px; font-weight: 700; }
  .note { margin-top: 16px; font-size: 10px; color: #64748b; line-height: 1.6; }
</style></head><body>
${letterheadHtml(config.hospital || {}, { title: 'WhatsApp Test Message', subtitle: 'Diagnostics Summary Portal', meta: `Generated ${formatGeneratedDate()}` })}
<div class="msg"><div class="label">Message</div>${esc(message)}</div>
<div class="rows">
  <div class="row"><div class="label">Sent to</div>${esc(formatNumber(toNumber))}</div>
  <div class="row"><div class="label">Sent by</div>${esc(sentBy || 'Staff')}</div>
  <div class="row"><div class="label">Time</div>${esc(`${formatGeneratedDate()} ${istNow()}`)}</div>
</div>
<div class="note">This is a test message from the hospital's Diagnostics Summary Portal, sent to check WhatsApp delivery. It contains no patient information.</div>
</body></html>`;
  const out = path.join(os.tmpdir(), `wa-test-${crypto.randomUUID()}.pdf`);
  try {
    await renderHtmlToPdf(html, out);
    const objectKey = `tests/${new Date().toISOString().slice(0, 10)}/whatsapp-test-${crypto.randomBytes(4).toString('hex')}.pdf`;
    await uploadPdfFile(objectKey, out);
    return objectKey;
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Sends one test message. Throws with WATI's reason if it's refused. */
export async function sendTestWhatsApp({ message, toNumber, triggeredBy }) {
  const text = cleanTestMessage(message);
  const digits = cleanTestNumber(toNumber);
  if (!text) throw new Error('Type the message to send');
  if (!digits) throw new Error('That doesn\'t look like a WhatsApp number — e.g. +91 99624 60782');

  const objectKey = await testPdf({ message: text, toNumber: digits, sentBy: triggeredBy });
  await sendInvestigationReportWhatsApp({
    toNumber: digits,
    name: RECIPIENT,
    note: text,
    pdfUrl: await whatsappPdfUrl(objectKey, 'WhatsApp-Test.pdf'),
    log: {
      trigger: 'manual',
      via: 'assistant',
      triggeredBy: triggeredBy || 'staff',
      document: 'other',
      documentLabel: 'Test message',
      patientName: 'Test message',
      recipientName: RECIPIENT,
    },
  });
  return { sentTo: formatNumber(digits), message: text };
}
