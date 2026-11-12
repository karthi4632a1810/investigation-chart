/**
 * Ask AI: looks up an OP patient's lab report straight from the EMR by UHID.
 * Kept in ephemeral storage (`lookups/<day>/<id>.pdf`) so Ask AI can preview,
 * download, or share an arbitrary UHID range on WhatsApp without altering OP Reports.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';
import { buildInvestigationChart, fetchSearchResults, fetchOriginalEmrLabPdf, searchInvestigation } from './emrService.js';
import { buildInvestigationChartHtml, flattenChartResults, renderHtmlToPdf } from './investigationPdfService.js';
import { whatsappFileName, whatsappPdfUrl } from './publicLinkService.js';
import { pdfExists, uploadPdfBuffer, uploadPdfFile } from './storageService.js';
import { checkWhatsAppNumber, documentLine, sendInvestigationReportWhatsApp } from './watiService.js';
import { getWatiSettings } from './watiSettingsService.js';
import { setting } from './appSettingsService.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^\d{4,12}$/;
const defaultDays = () => setting('ai.lookupDays'); // Master Settings → Ask AI
const MAX_DAYS = 366;

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });
const istDay = (offsetDays = 0) => new Date(Date.now() + 330 * 60_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400_000);

export function cleanLookupId(raw) {
  return String(raw || '')
    .trim()
    .replace(/^(?:UHID|REG(?:\s*NO)?)\s*[:#-]?\s*/i, '')
    .replace(/\s+/g, '');
}

/** The stored PDF for a lookup, or null if the ids don't look right. */
export function lookupKey(day, lookupId) {
  return DATE_RE.test(day || '') && /^[a-f0-9]{12}$/.test(lookupId || '') ? `lookups/${day}/${lookupId}.pdf` : null;
}

/**
 * Searches the EMR for OP `id` (UHID digits) between `from` and `to`
 * (default: the last 30 days) and makes the lab report PDF.
 * @returns { found: false, … } or { found: true, lookupId, day, patient, dates, tests, … }
 */
export async function lookupLabReport({ id, from, to }) {
  const clean = cleanLookupId(id);
  if (!ID_RE.test(clean)) throw httpError('Give a patient UHID (digits), e.g. 6214201');
  const end = DATE_RE.test(to || '') ? to : istDay();
  let start = DATE_RE.test(from || '') ? from : istDay(-(defaultDays() - 1));
  if (start > end) start = end;
  if (daysBetween(start, end) > MAX_DAYS) throw httpError('Pick a range of up to one year');

  const lookupId = crypto.randomBytes(6).toString('hex');
  const day = istDay();
  const key = lookupKey(day, lookupId);

  if (!setting('opReports.usePdfTemplate')) {
    const searchRes = await fetchSearchResults(clean, `${start}T00:00`, `${end}T23:59`);
    if (!searchRes.ok) throw httpError(`The EMR search failed: ${searchRes.error}`, 502);
    if (!searchRes.data?.length) return { found: false, id: clean, from: start, to: end };

    const emrPdf = await fetchOriginalEmrLabPdf(searchRes.data);
    if (!emrPdf.ok) {
      if (emrPdf.reason === 'NO_DATA') return { found: false, id: clean, from: start, to: end };
      throw httpError(`Failed to fetch original EMR PDF: ${emrPdf.error}`, 502);
    }

    await uploadPdfBuffer(key, emrPdf.pdfBuffer);
    const chart = await buildInvestigationChart(searchRes.data, { prefetchedHtmlByOrderId: emrPdf.htmlByOrderId }).catch(() => null);
    const meta = chart?.patientMeta || {};
    const dates = chart?.chartDates || [];

    return {
      found: true,
      lookupId,
      day,
      id: clean,
      from: start,
      to: end,
      patient: { name: meta.name || '', age: meta.age || '', sex: meta.sex || '', regNo: clean, uhid: clean, unit: meta.unit || '', type: 'OP' },
      dates: dates.length || 1,
      firstDate: dates[0] || start.split('-').reverse().join('-'),
      lastDate: dates[dates.length - 1] || end.split('-').reverse().join('-'),
      tests: chart ? flattenChartResults(chart).length : emrPdf.reqNos?.length || 1,
      fileName: whatsappFileName('Lab-Report', clean),
    };
  }

  const result = await searchInvestigation(clean, `${start}T00:00`, `${end}T23:59`);
  if (!result.ok) throw httpError(`The EMR search failed: ${result.error}`, 502);
  if (!result.chart?.chartDates?.length) return { found: false, id: clean, from: start, to: end };

  const meta = result.chart.patientMeta || {};

  const html = buildInvestigationChartHtml({
    hospital: config.hospital,
    regNo: clean,
    physicianName: meta.doctor || '',
    department: meta.unit || '',
    chart: result.chart,
    subtitle: `Outpatient laboratory investigation report · ${start === end ? start.split('-').reverse().join('-') : `${start.split('-').reverse().join('-')} to ${end.split('-').reverse().join('-')}`}`,
  });
  const tmp = path.join(os.tmpdir(), `lookup-${lookupId}.pdf`);
  try {
    await renderHtmlToPdf(html, tmp);
    await uploadPdfFile(key, tmp);
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
    patient: { name: meta.name || '', age: meta.age || '', sex: meta.sex || '', regNo: clean, uhid: clean, unit: meta.unit || '', type: 'OP' },
    dates: result.chart.chartDates.length,
    firstDate: result.chart.chartDates[0],
    lastDate: result.chart.chartDates[result.chart.chartDates.length - 1],
    tests: flattenChartResults(result.chart).length,
    fileName: whatsappFileName('Lab-Report', clean),
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
      uhid: clean,
      regNo: clean,
    },
  });
  const digits = checked.digits;
  return {
    sentTo: /^91\d{10}$/.test(digits) ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}` : `+${digits}`,
    messageId: sent.logId || null,
    template: settings.labReportTemplate,
  };
}
