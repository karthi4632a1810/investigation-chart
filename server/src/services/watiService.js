/**
 * WATI WhatsApp API — sends the "investigation" template message, which has
 * three parameters: {{1}} recipient name, {{2}} an extra body line, {{3}} the
 * document URL used as the header attachment (confirmed against the live
 * template via GET /api/v1/getMessageTemplates).
 */
import { config } from '../config.js';
import { countWatiCall, noteWatiOk, noteWatiRateLimited, watiPausedUntil } from './watiBudget.js';
import { logRetryStart, logSendResult, logSendStart } from './whatsappLogService.js';

// WATI's edge (Cloudflare) rejects requests with no/generic User-Agent with a
// 403 "error code: 1010" bot-block — confirmed while testing this directly.
// Node's fetch doesn't send one by default, so a browser-like one is required.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * WATI expects the WhatsApp number as country-code-prefixed digits only, e.g.
 * "919384508490" — no "+", spaces, or leading zero. EMR mobiles and numbers
 * typed into WATI Settings are usually bare 10-digit Indian numbers, which WATI
 * would otherwise reject or route to the wrong country, so those get "91".
 */
export function toWatiNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

/**
 * The template's {{2}} line. Each document goes out as its own message (a
 * WhatsApp template carries at most one document header), so the line names
 * which document this one is, followed by the optional extra text from WATI
 * Settings. Template params can't contain newlines, hence a single line.
 */
export function documentLine(label, extra) {
  const text = String(extra || '').trim();
  return text ? `Attached: ${label} — ${text}` : `Attached: ${label}`;
}

/**
 * @param log optional context for the WhatsApp monitor (whatsappLogService.js):
 *   { trigger, via, triggeredBy, document, documentLabel, dischargeDate, ipNo,
 *     patientName, department, liveMode }. Every send with it is recorded as
 *   pending → sent / failed, and later delivered / read.
 */
export async function sendInvestigationReportWhatsApp({ toNumber, name, note, pdfUrl, log }) {
  if (!config.wati.endpoint || !config.wati.accessToken) {
    throw new Error('WATI is not configured — set API_ENDPOINT and WATI_ACCESS_TOKEN in server/.env');
  }
  if (!toNumber) throw new Error('toNumber is required');
  if (!pdfUrl) throw new Error('pdfUrl is required');

  const digits = toWatiNumber(toNumber);

  const payload = {
    template_name: config.wati.templateId,
    broadcast_name: `investigation_${digits}_${Date.now()}`,
    parameters: [
      { name: '1', value: name || 'Patient' },
      { name: '2', value: note || '' },
      { name: '3', value: pdfUrl },
    ],
  };

  // A retry (log.existingId) reuses the failed record; anything else starts a new one.
  const logId = log?.existingId
    ? await logRetryStart(log.existingId, log).catch(() => null)
    : log
      ? await logSendStart({ ...log, toNumber: digits, template: config.wati.templateId, patientName: log.patientName ?? name }).catch(() => null)
      : null;

  try {
    // While WATI is refusing calls (429), automatic sends don't spend more of the
    // quota: they're recorded as failed and retried once the pause ends.
    // A person clicking Send still tries.
    const paused = watiPausedUntil();
    if (paused && log?.trigger === 'auto') {
      throw new Error(`WATI API usage limit exceeded (429) — sending paused until ${paused.toISOString()}, will retry`);
    }
    const data = await postTemplate(digits, payload);
    await logSendResult(logId, { ok: true, response: data }).catch(() => {});
    return data;
  } catch (error) {
    await logSendResult(logId, { ok: false, error: error.message }).catch(() => {});
    throw error;
  }
}

async function postTemplate(digits, payload) {
  const res = await fetch(`${config.wati.endpoint}/api/v1/sendTemplateMessage?whatsappNumber=${digits}`, {
    method: 'POST',
    headers: {
      Authorization: config.wati.accessToken,
      'Content-Type': 'application/json-patch+json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 429) {
    // WATI's API usage limit (shared by sending and status checks) — temporary.
    countWatiCall('send', { rateLimited: true }).catch(() => {});
    noteWatiRateLimited();
    throw new Error('WATI API usage limit exceeded (429) — will retry later');
  }
  countWatiCall('send').catch(() => {});
  noteWatiOk();
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result !== true) {
    throw new Error(data?.info || data?.message || `WATI responded ${res.status}`);
  }
  if (data.validWhatsAppNumber === false) {
    throw new Error(`+${digits} is not a WhatsApp number`);
  }
  return data;
}
