/**
 * Discharge report: patients discharged in a date (and optional time) range,
 * with filters, totals and downloads (Excel / PDF / CSV). Used by Ask AI
 * ("patients discharged today 10 am – 2 pm in ENT with no summary") and its
 * download buttons (GET /api/discharges/export).
 *
 * Times use the EMR's discharge time ("29-09-2026 12:24", India time).
 */
import { matchPatient } from './patientSearchService.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import { config } from '../config.js';
import { getMongoCollection } from './mongo.js';
import { renderHtmlToPdf } from './investigationPdfService.js';
import { BRAND_CSS, esc, formatGeneratedDate, letterheadHtml } from './pdfBranding.js';
import { dischargeMoment, timeWindow } from './whatsappLogService.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 5000;

export const DISCHARGE_EXPORT_FORMATS = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
};

const dmy = (iso) => String(iso || '').split('-').reverse().join('-');
const contains = (value, needle) => String(value || '').toUpperCase().includes(String(needle).toUpperCase());
const WA_LABEL = { read: 'Read', delivered: 'Delivered', sent: 'Sent', pending: 'Pending', failed: 'Failed', nowa: 'Not on WhatsApp', none: 'Not sent' };

/** Only the filters we know, cleaned — also what the download link carries. */
export function normaliseDischargeQuery(q = {}) {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const from = DATE_RE.test(q.from || '') ? q.from : today;
  const to = DATE_RE.test(q.to || '') ? q.to : from;
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const out = { from: lo, to: hi };
  const win = timeWindow(q);
  if (win) Object.assign(out, win);
  for (const key of ['department', 'doctor', 'patientType', 'q']) {
    const v = String(q[key] || '').trim().slice(0, 60);
    if (v) out[key] = v;
  }
  if (['ready', 'none'].includes(q.lab)) out.lab = q.lab;
  if (['ready', 'no_summary', 'pending'].includes(q.summary)) out.summary = q.summary;
  if (['read', 'delivered', 'sent', 'failed', 'none', 'nowa'].includes(q.whatsapp)) out.whatsapp = q.whatsapp;
  return out;
}

export function describeDischargeQuery(q) {
  const range = q.from === q.to ? dmy(q.from) : `${dmy(q.from)} to ${dmy(q.to)}`;
  const parts = [`Discharged ${range}${q.fromTime ? `, ${q.fromTime}–${q.toTime}` : ''}`];
  if (q.department) parts.push(`Department: ${q.department}`);
  if (q.doctor) parts.push(`Doctor: ${q.doctor}`);
  if (q.patientType) parts.push(`Type: ${q.patientType}`);
  if (q.lab) parts.push(q.lab === 'ready' ? 'With lab report' : 'No lab data');
  if (q.summary) parts.push({ ready: 'With discharge summary', no_summary: 'No Summary (EMR had no data)', pending: 'Summary not available yet' }[q.summary]);
  if (q.whatsapp) parts.push(`WhatsApp: ${WA_LABEL[q.whatsapp]}`);
  if (q.q) parts.push(`Search: "${q.q}"`);
  return parts.join(' · ');
}

/** { query, rows, totals } for the filters. */
export async function dischargeReport(input = {}) {
  const q = normaliseDischargeQuery(input);
  const docs = await (await getMongoCollection('discharge_reports'))
    .find({ date: { $gte: q.from, $lte: q.to } }, { projection: { _id: 0 } })
    .toArray();
  // "Search": any value (name, IP, UHID, mobile in any format, address …) — patientSearchService.js.
  const searchHit = q.q ? new Set(docs.filter((d) => matchPatient(d, q.q)).map((d) => `${d.date}|${d.ipNo}`)) : null;

  // Best WhatsApp status per patient (their reports' messages).
  const msgs = await (await getMongoCollection('whatsapp_messages'))
    .find({ dischargeDate: { $gte: q.from, $lte: q.to }, ipNo: { $ne: null } }, { projection: { dischargeDate: 1, ipNo: 1, status: 1, notOnWhatsApp: 1 } })
    .toArray();
  const RANK = { read: 5, delivered: 4, sent: 3, pending: 2, failed: 1 };
  const wa = new Map();
  for (const m of msgs) {
    const key = `${m.dischargeDate}|${m.ipNo}`;
    const state = m.status === 'failed' && m.notOnWhatsApp ? 'nowa' : m.status;
    const prev = wa.get(key);
    if (!prev || (RANK[m.status] || 0) > (RANK[prev === 'nowa' ? 'failed' : prev] || 0)) wa.set(key, state);
  }

  const win = q.fromTime ? { start: new Date(`${q.from}T${q.fromTime}:00+05:30`).getTime(), end: new Date(`${q.to}T${q.toTime}:00+05:30`).getTime() + 60_000 } : null;

  let rows = docs.map((d) => {
    const at = dischargeMoment(d);
    return {
      date: d.date,
      ipNo: d.ipNo,
      regNo: d.regNo || '',
      name: d.name || '',
      age: d.age || '',
      gender: d.gender || '',
      patientType: d.patientType || 'General',
      department: d.department || '',
      ward: d.ward || '',
      doctor: d.doctor || '',
      mobile: d.mobile || '',
      dischargedAt: d.dischargeDate || dmy(d.date),
      dischargeTime: at ? at.getTime() : null,
      lab: d.dateCount !== undefined && d.dateCount !== null ? 'ready' : 'none',
      labDates: d.dateCount ?? null,
      summary: d.hasSummary && d.summaryDataMissing ? 'no_summary' : d.hasSummary ? 'ready' : 'pending',
      approvedBy: d.summaryApprovedBy || '',
      whatsapp: wa.get(`${d.date}|${d.ipNo}`) || 'none',
    };
  });

  rows = rows.filter((r) => {
    if (win && !(r.dischargeTime >= win.start && r.dischargeTime < win.end)) return false;
    if (q.department && !contains(r.department, q.department)) return false;
    if (q.doctor && !contains(r.doctor, q.doctor)) return false;
    if (q.patientType && !contains(r.patientType, q.patientType)) return false;
    if (q.lab && r.lab !== q.lab) return false;
    if (q.summary && r.summary !== q.summary) return false;
    if (q.whatsapp && r.whatsapp !== q.whatsapp) return false;
    if (searchHit && !searchHit.has(`${r.date}|${r.ipNo}`)) return false;
    return true;
  });
  rows.sort((a, b) => (a.dischargeTime ?? 0) - (b.dischargeTime ?? 0) || a.name.localeCompare(b.name));

  const count = (fn) => rows.filter(fn).length;
  const byDepartment = {};
  for (const r of rows) byDepartment[r.department || 'Unknown'] = (byDepartment[r.department || 'Unknown'] || 0) + 1;
  const totals = {
    patients: rows.length,
    labReady: count((r) => r.lab === 'ready'),
    noLabData: count((r) => r.lab === 'none'),
    summaryReady: count((r) => r.summary === 'ready'),
    noSummary: count((r) => r.summary === 'no_summary'),
    summaryPending: count((r) => r.summary === 'pending'),
    whatsapp: {
      read: count((r) => r.whatsapp === 'read'),
      delivered: count((r) => r.whatsapp === 'delivered'),
      sent: count((r) => r.whatsapp === 'sent'),
      failed: count((r) => r.whatsapp === 'failed' || r.whatsapp === 'nowa'),
      notSent: count((r) => r.whatsapp === 'none'),
    },
    byDepartment: Object.entries(byDepartment)
      .sort((a, b) => b[1] - a[1])
      .map(([department, patients]) => ({ department, patients })),
  };
  return { query: q, description: describeDischargeQuery(q), rows: rows.slice(0, MAX_ROWS), totals };
}

// ---- Downloads -----------------------------------------------------------------

const COLUMNS = [
  { key: 'n', label: '#', width: 5 },
  { key: 'name', label: 'Patient', width: 26 },
  { key: 'ipNo', label: 'IP No', width: 13 },
  { key: 'regNo', label: 'UHID', width: 11 },
  { key: 'ageSex', label: 'Age / Sex', width: 11 },
  { key: 'patientType', label: 'Type', width: 11 },
  { key: 'department', label: 'Department', width: 20 },
  { key: 'doctor', label: 'Doctor', width: 20 },
  { key: 'dischargedAt', label: 'Discharged', width: 17 },
  { key: 'labText', label: 'Lab report', width: 13 },
  { key: 'summaryText', label: 'Discharge summary', width: 18 },
  { key: 'whatsappText', label: 'WhatsApp', width: 15 },
];

function tableRows(rows) {
  return rows.map((r, i) => ({
    ...r,
    n: i + 1,
    ageSex: [r.age, r.gender].filter(Boolean).join(' / '),
    labText: r.lab === 'ready' ? `Ready${r.labDates ? ` (${r.labDates} day${r.labDates === 1 ? '' : 's'})` : ''}` : 'No lab data',
    summaryText: { ready: 'Ready', no_summary: 'No Summary', pending: 'Not yet' }[r.summary],
    whatsappText: WA_LABEL[r.whatsapp],
  }));
}

function totalsLine(t) {
  return `${t.patients} patients · ${t.labReady} lab reports · ${t.summaryReady} summaries${t.noSummary ? ` · ${t.noSummary} No Summary` : ''} · WhatsApp: ${t.whatsapp.read} read, ${t.whatsapp.delivered} delivered, ${t.whatsapp.sent} sent, ${t.whatsapp.failed} failed, ${t.whatsapp.notSent} not sent`;
}

async function toXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = config.hospital?.nameEn || 'Diagnostics Summary Portal';
  const ws = wb.addWorksheet('Discharges', { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.mergeCells(1, 1, 1, COLUMNS.length);
  ws.getCell(1, 1).value = `Discharge report — ${report.description}`;
  ws.getCell(1, 1).font = { bold: true, size: 13, color: { argb: 'FF0B2956' } };
  ws.mergeCells(2, 1, 2, COLUMNS.length);
  ws.getCell(2, 1).value = totalsLine(report.totals);
  ws.getCell(2, 1).font = { size: 10, color: { argb: 'FF64748B' } };
  ws.mergeCells(3, 1, 3, COLUMNS.length);
  ws.getCell(3, 1).value = `Generated ${formatGeneratedDate()}`;
  ws.getCell(3, 1).font = { size: 9, color: { argb: 'FF94A3B8' } };
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  const header = ws.getRow(4);
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2956' } };
  });
  for (const r of tableRows(report.rows)) {
    const row = ws.addRow(COLUMNS.map((c) => r[c.key] ?? ''));
    if (r.summary === 'no_summary') row.getCell(COLUMNS.findIndex((c) => c.key === 'summaryText') + 1).font = { bold: true, color: { argb: 'FFB91C1C' } };
    if (r.whatsapp === 'failed' || r.whatsapp === 'nowa') row.getCell(COLUMNS.length).font = { bold: true, color: { argb: 'FFB91C1C' } };
  }
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: COLUMNS.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toCsv(report) {
  const quote = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.map((c) => quote(c.label)).join(',')];
  for (const r of tableRows(report.rows)) lines.push(COLUMNS.map((c) => quote(r[c.key])).join(','));
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

async function toPdf(report) {
  const body = tableRows(report.rows)
    .map(
      (r) =>
        `<tr>${COLUMNS.map((c) => {
          const cls = c.key === 'summaryText' && r.summary === 'no_summary' ? ' class="bad"' : c.key === 'whatsappText' && (r.whatsapp === 'failed' || r.whatsapp === 'nowa') ? ' class="bad"' : c.key === 'name' ? ' class="name"' : '';
          return `<td${cls}>${esc(r[c.key] ?? '')}</td>`;
        }).join('')}</tr>`,
    )
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; color: #1e293b; }
  @page { size: A4 landscape; margin: 9mm 10mm; }
${BRAND_CSS}
  .criteria { display: flex; justify-content: space-between; gap: 12px; margin: 0 0 8px; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; font-size: 9.5px; }
  .criteria b { color: #0b2956; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 8.6px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  th { background: #0b2956; color: #fff; text-align: left; font-size: 7.5px; letter-spacing: 0.06em; text-transform: uppercase; padding: 6px; }
  td { padding: 4.5px 6px; border-bottom: 1px solid #eef2f7; vertical-align: top; overflow-wrap: anywhere; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  tbody tr:nth-child(even) td { background: #fbfcfe; }
  .name { font-weight: 700; }
  .bad { color: #b91c1c; font-weight: 700; }
  .empty { padding: 30px; text-align: center; color: #64748b; }
  .foot { margin-top: 8px; font-size: 8px; color: #94a3b8; }
</style></head><body>
${letterheadHtml(config.hospital || {}, { title: 'Discharge Report', subtitle: 'Patients, reports and WhatsApp delivery', meta: `Generated ${formatGeneratedDate()}` })}
<div class="criteria"><span><b>${esc(report.description)}</b></span><span>${esc(totalsLine(report.totals))}</span></div>
<table><thead><tr>${COLUMNS.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
<tbody>${body || `<tr><td class="empty" colspan="${COLUMNS.length}">No patients match</td></tr>`}</tbody></table>
<div class="foot">System-generated from the EMR discharge list. Discharge times are as recorded in the EMR (India time).</div>
</body></html>`;
  const out = path.join(os.tmpdir(), `discharges-${crypto.randomUUID()}.pdf`);
  try {
    await renderHtmlToPdf(html, out);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** @returns { buffer, filename, mime } */
export async function buildDischargeExport(input, format) {
  const report = await dischargeReport(input);
  const q = report.query;
  const stamp = `${q.from}${q.to !== q.from ? `_to_${q.to}` : ''}${q.fromTime ? `_${q.fromTime.replace(':', '')}-${q.toTime.replace(':', '')}` : ''}`;
  const buffer = format === 'xlsx' ? await toXlsx(report) : format === 'pdf' ? await toPdf(report) : toCsv(report);
  return { buffer, filename: `discharges-${stamp}.${format}`, mime: DISCHARGE_EXPORT_FORMATS[format] };
}
