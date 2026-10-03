/**
 * Ask AI: a patient's lab report straight from the EMR, by UHID or IP number —
 * including OP patients. The rest of the portal is about discharged IP
 * patients, so nothing here is added to Discharge Reports, Lab Finder or the
 * Monitor's patient lists: the PDF is only kept in storage (lookups/<day>/<id>.pdf)
 * so it can be downloaded or sent on WhatsApp from the chat.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';
import { searchInvestigation } from './emrService.js';
import { buildInvestigationChartHtml, flattenChartResults, renderHtmlToPdf } from './investigationPdfService.js';
import { whatsappFileName, whatsappPdfUrl } from './publicLinkService.js';
import { pdfExists, uploadPdfFile } from './storageService.js';
import { checkWhatsAppNumber, documentLine, sendInvestigationReportWhatsApp } from './watiService.js';
import { getWatiSettings } from './watiSettingsService.js';
import { setting } from './appSettingsService.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^(IP)?\d{4,12}$/;
const defaultDays = () => setting('ai.lookupDays'); // Master Settings → Ask AI
const MAX_DAYS = 366;

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });
const istDay = (offsetDays = 0) => new Date(Date.now() + 330 * 60_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400_000);

export function cleanLookupId(raw) {
  return String(raw || '').replace(/\s+/g, '').toUpperCase();
}

/** The stored PDF for a lookup, or null if the ids don't look right. */
export function lookupKey(day, lookupId) {
  return DATE_RE.test(day || '') && /^[a-f0-9]{12}$/.test(lookupId || '') ? `lookups/${day}/${lookupId}.pdf` : null;
}

/**
 * Searches the EMR for `id` (UHID digits, or IP number) between `from` and
 * `to` (default: the last 30 days) and makes the lab report PDF.
 * @returns { found: false, … } or { found: true, lookupId, day, patient, dates, tests, … }
 */
export async function lookupLabReport({ id, from, to }) {
  const clean = cleanLookupId(id);
  if (!ID_RE.test(clean)) throw httpError('Give a UHID (digits) or an IP number, e.g. 6159338 or IP07028148');
  const end = DATE_RE.test(to || '') ? to : istDay();
  let start = DATE_RE.test(from || '') ? from : istDay(-(defaultDays() - 1));
  if (start > end) start = end;
  if (daysBetween(start, end) > MAX_DAYS) throw httpError('Pick a range of up to one year');

  const result = await searchInvestigation(clean, `${start}T00:00`, `${end}T23:59`);
  if (!result.ok) throw httpError(`The EMR search failed: ${result.error}`, 502);
  if (!result.chart?.chartDates?.length) return { found: false, id: clean, from: start, to: end };

  const meta = result.chart.patientMeta || {};
  const metaIp = /^IP/i.test(meta.ip || '') ? String(meta.ip).toUpperCase() : '';
  const ipNo = clean.startsWith('IP') ? clean : metaIp;
  const uhid = clean.startsWith('IP') ? '' : clean;
  const isOp = !ipNo;

  const html = buildInvestigationChartHtml({
    hospital: config.hospital,
    regNo: uhid || clean,
    ipNo: ipNo || 'OP',
    chart: result.chart,
    subtitle: `Laboratory investigation chart · ${start === end ? start.split('-').reverse().join('-') : `${start.split('-').reverse().join('-')} to ${end.split('-').reverse().join('-')}`}`,
  });
  const lookupId = crypto.randomBytes(6).toString('hex');
  const day = istDay();
  const tmp = path.join(os.tmpdir(), `lookup-${lookupId}.pdf`);
  try {
    await renderHtmlToPdf(html, tmp);
    await uploadPdfFile(lookupKey(day, lookupId), tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  return {
    found: true,
    lookupId,
    day,
    id: clean,
    from: start,
    to: end,
    patient: { name: meta.name || '', age: meta.age || '', sex: meta.sex || '', ipNo, uhid, unit: meta.unit || '', type: isOp ? 'OP' : 'IP' },
    dates: result.chart.chartDates.length,
    firstDate: result.chart.chartDates[0],
    lastDate: result.chart.chartDates[result.chart.chartDates.length - 1],
    tests: flattenChartResults(result.chart).length,
    fileName: whatsappFileName('Lab-Report', uhid || ipNo || clean),
  };
}

/**
 * Sends a looked-up lab report on WhatsApp with the template chosen in WATI
 * Settings (Ask AI lab reports). Throws with a message to show the user —
 * a short number, not on WhatsApp, WATI's limit.
 */
export async function sendLookupWhatsApp({ day, lookupId, toNumber, name, id, triggeredBy }) {
  const key = lookupKey(day, lookupId);
  if (!key || !(await pdfExists(key))) throw httpError('That lab report is no longer available — look it up again', 404);
  const checked = checkWhatsAppNumber(toNumber);
  if (!checked.ok) throw httpError(checked.error);
  const settings = await getWatiSettings();
  const clean = cleanLookupId(id);
  const sent = await sendInvestigationReportWhatsApp({
    toNumber: checked.digits,
    name: name || 'Patient',
    note: documentLine('Lab Report', settings.secondParam),
    pdfUrl: await whatsappPdfUrl(key, whatsappFileName('Lab-Report', clean)),
    template: settings.labReportTemplate,
    log: {
      trigger: 'share',
      via: 'assistant',
      triggeredBy: triggeredBy || 'staff',
      document: 'other',
      documentLabel: 'Lab Report (Ask AI)',
      patientName: name || clean,
      recipientName: name || 'Patient',
      uhid: clean.startsWith('IP') ? null : clean,
      ipNo: null,
    },
  });
  const digits = checked.digits;
  return {
    sentTo: /^91\d{10}$/.test(digits) ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}` : `+${digits}`,
    messageId: sent.logId || null,
    template: settings.labReportTemplate,
  };
}
