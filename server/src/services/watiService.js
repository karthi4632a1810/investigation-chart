/**
 * WATI WhatsApp API — sends the "investigation" template message, which has
 * three parameters: {{1}} recipient name, {{2}} an extra body line, {{3}} the
 * document URL used as the header attachment (confirmed against the live
 * template via GET /api/v1/getMessageTemplates).
 */
import { config } from '../config.js';

// WATI's edge (Cloudflare) rejects requests with no/generic User-Agent with a
// 403 "error code: 1010" bot-block — confirmed while testing this directly.
// Node's fetch doesn't send one by default, so a browser-like one is required.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export async function sendInvestigationReportWhatsApp({ toNumber, name, note, pdfUrl }) {
  if (!config.wati.endpoint || !config.wati.accessToken) {
    throw new Error('WATI is not configured — set API_ENDPOINT and WATI_ACCESS_TOKEN in server/.env');
  }
  if (!toNumber) throw new Error('toNumber is required');
  if (!pdfUrl) throw new Error('pdfUrl is required');

  // WATI expects the WhatsApp number as country-code-prefixed digits only,
  // e.g. "919384508490" — no "+", spaces, or leading zero.
  const digits = String(toNumber).replace(/\D/g, '');

  const payload = {
    template_name: config.wati.templateId,
    broadcast_name: `investigation_${digits}_${Date.now()}`,
    parameters: [
      { name: '1', value: name || 'Patient' },
      { name: '2', value: note || '' },
      { name: '3', value: pdfUrl },
    ],
  };

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

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result !== true) {
    throw new Error(data?.info || data?.message || `WATI responded ${res.status}`);
  }
  return data;
}
