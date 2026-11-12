/**
 * Filtered OP lab-report breakdown ("OP visits in General Medicine pending or
 * ready today") and its Excel / PDF / CSV export. Used by Ask AI and Admin.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import { getMongoCollection } from './mongo.js';
import { config } from '../config.js';
import { matchPatient } from './patientSearchService.js';
import { renderHtmlToPdf } from './investigationPdfService.js';
import { BRAND_CSS, esc, formatGeneratedDate, letterheadHtml } from './pdfBranding.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WA_SENT_SET = new Set(['sent', 'delivered', 'read']);

export const OP_EXPORT_FORMATS = {
  xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pdf: { ext: 'pdf', mime: 'application/pdf' },
  csv: { ext: 'csv', mime: 'text/csv; charset=utf-8' },
  json: { ext: 'json', mime: 'application/json; charset=utf-8' },
};

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '');

export function normaliseOpReportQuery(q = {}) {
  const out = {};
  const from = DATE_RE.test(q.from || '') ? q.from : DATE_RE.test(q.date || '') ? q.date : todayIst();
  const to = DATE_RE.test(q.to || '') ? q.to : from;
  out.from = from <= to ? from : to;
  out.to = from <= to ? to : from;
  for (const k of ['department', 'doctor', 'visitType', 'q']) {
    const v = String(q[k] ?? '').trim();
    if (v) out[k] = v.slice(0, 80);
  }
  if (['ready', 'pending', 'no_data', 'failed'].includes(q.lab)) out.lab = q.lab;
  if (['sent', 'delivered', 'read', 'failed', 'nowa', 'not_sent', 'any_sent'].includes(q.whatsapp)) {
    out.whatsapp = q.whatsapp;
  }
  return out;
}

export function describeOpReportQuery(q) {
  const parts = [q.from === q.to ? dmy(q.from) : `${dmy(q.from)} to ${dmy(q.to)}`];
  if (q.department) parts.push(`in ${q.department}`);
  if (q.doctor) parts.push(`under Dr. ${q.doctor}`);
  if (q.visitType) parts.push(q.visitType);
  if (q.lab) parts.push({ ready: 'Lab ready', pending: 'Pending approval', no_data: 'No lab results', failed: 'Failed' }[q.lab]);
  if (q.whatsapp) parts.push(`WhatsApp ${q.whatsapp.replace('_', ' ')}`);
  if (q.q) parts.push(`matching "${q.q}"`);
  return parts.join(' · ');
}

/** Counts and per-patient rows matching the OP filters. */
export async function opReportQuery(input = {}) {
  const q = normaliseOpReportQuery(input);
  const docs = await (await getMongoCollection('op_reports'))
    .find({ date: { $gte: q.from, $lte: q.to } })
    .sort({ date: -1, tokenNo: 1, name: 1, regNo: 1 })
    .toArray();

  const searchHit = q.q ? new Set(docs.filter((d) => matchPatient(d, q.q)).map((d) => `${d.date}|${d.regNo}`)) : null;

  const wa = new Map();
  const logs = await (await getMongoCollection('whatsapp_messages'))
    .find(
      { reportDate: { $gte: q.from, $lte: q.to }, regNo: { $ne: null } },
      { projection: { reportDate: 1, regNo: 1, status: 1, notOnWhatsApp: 1 } },
    )
    .sort({ createdAt: 1 })
    .toArray();

  const RANK = { read: 5, delivered: 4, sent: 3, pending: 2, failed: 1 };
  for (const m of logs) {
    const key = `${m.reportDate}|${m.regNo}`;
    const state = m.status === 'failed' && m.notOnWhatsApp ? 'nowa' : m.status;
    if (!wa.has(key) || (RANK[state] || 0) >= (RANK[wa.get(key)] || 0)) wa.set(key, state);
  }

  const rx = (v) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const deptRx = q.department ? rx(q.department) : null;
  const docRx = q.doctor ? rx(q.doctor) : null;
  const vtRx = q.visitType ? rx(q.visitType) : null;

  const rows = docs
    .map((d) => ({
      date: d.date,
      regNo: d.regNo,
      name: d.name || '',
      age: d.age || '',
      gender: d.gender || '',
      department: d.department || '',
      doctor: d.doctor || '',
      visitType: d.visitType || '',
      tokenNo: d.tokenNo || '',
      mobile: d.mobile || '',
      visitDate: d.visitDate || dmy(d.date),
      totalOrders: d.totalOrders ?? 0,
      approvedOrders: d.approvedOrders ?? 0,
      pendingOrders: d.pendingOrders ?? 0,
      dateCount: d.dateCount ?? null,
      lab: d.reportStatus || (d.dateCount != null ? 'ready' : 'pending'),
      whatsapp: wa.get(`${d.date}|${d.regNo}`) || 'none',
    }))
    .filter((r) => {
      if (deptRx && !deptRx.test(r.department)) return false;
      if (docRx && !docRx.test(r.doctor)) return false;
      if (vtRx && !vtRx.test(r.visitType)) return false;
      if (q.lab && r.lab !== q.lab) return false;
      if (q.whatsapp === 'any_sent' && !WA_SENT_SET.has(r.whatsapp)) return false;
      else if (q.whatsapp === 'not_sent' && r.whatsapp !== 'none') return false;
      else if (q.whatsapp && q.whatsapp !== 'any_sent' && q.whatsapp !== 'not_sent' && r.whatsapp !== q.whatsapp) return false;
      if (searchHit && !searchHit.has(`${r.date}|${r.regNo}`)) return false;
      return true;
    });

  const count = (fn) => rows.filter(fn).length;
  const totals = {
    patients: rows.length,
    labReady: count((r) => r.lab === 'ready'),
    labPending: count((r) => r.lab === 'pending'),
    noLabData: count((r) => r.lab === 'no_data'),
    labFailed: count((r) => r.lab === 'failed'),
    whatsapp: {
      read: count((r) => r.whatsapp === 'read'),
      delivered: count((r) => r.whatsapp === 'delivered'),
      sent: count((r) => r.whatsapp === 'sent'),
      failed: count((r) => r.whatsapp === 'failed'),
      nowa: count((r) => r.whatsapp === 'nowa'),
      notSent: count((r) => r.whatsapp === 'none'),
    },
  };

  const deptMap = new Map();
  for (const r of rows) {
    const name = r.department || 'Not specified';
    const d = deptMap.get(name) || { department: name, patients: 0, labReady: 0, labPending: 0, whatsappSent: 0 };
    d.patients += 1;
    if (r.lab === 'ready') d.labReady += 1;
    if (r.lab === 'pending') d.labPending += 1;
    if (WA_SENT_SET.has(r.whatsapp)) d.whatsappSent += 1;
    deptMap.set(name, d);
  }
  const byDepartment = [...deptMap.values()].sort((a, b) => b.patients - a.patients);

  return { query: q, rows, totals, byDepartment };
}

const COLUMNS = [
  { key: 'regNo', label: 'UHID', width: 12 },
  { key: 'name', label: 'Patient name', width: 22 },
  { key: 'age', label: 'Age', width: 8 },
  { key: 'gender', label: 'Gender', width: 9 },
  { key: 'department', label: 'Department', width: 20 },
  { key: 'doctor', label: 'Doctor', width: 20 },
  { key: 'tokenNo', label: 'Token', width: 8 },
  { key: 'visitType', label: 'Visit type', width: 12 },
  { key: 'mobile', label: 'Mobile', width: 13 },
  { key: 'visitDate', label: 'Visit date', width: 16 },
  { key: 'labText', label: 'Lab report', width: 19 },
  { key: 'whatsappText', label: 'WhatsApp', width: 15 },
];

const WA_LABEL = { none: 'Not sent', pending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', nowa: 'Not on WhatsApp' };

function labStatusText(r) {
  if (r.lab === 'ready') return r.dateCount != null ? `Ready (${r.dateCount}d)` : 'Ready';
  if (r.lab === 'pending') return r.totalOrders ? `Pending (${r.approvedOrders}/${r.totalOrders})` : 'Pending';
  if (r.lab === 'no_data') return 'No results';
  if (r.lab === 'failed') return 'Failed';
  return 'Unknown';
}

const tableRows = (rows) =>
  rows.map((r) => ({
    ...r,
    labText: labStatusText(r),
    whatsappText: WA_LABEL[r.whatsapp] || r.whatsapp,
  }));

function summaryLine(t) {
  return `${t.patients} OP patients · ${t.labReady} ready · ${t.labPending} pending${t.noLabData ? ` · ${t.noLabData} no data` : ''} · WhatsApp: ${t.whatsapp.read} read, ${t.whatsapp.delivered} delivered, ${t.whatsapp.sent} sent, ${t.whatsapp.failed} failed, ${t.whatsapp.notSent} not sent`;
}

async function toXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = config.hospital?.nameEn || 'OP Lab Reports Portal';
  const ws = wb.addWorksheet('OP Lab Reports', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.mergeCells(1, 1, 1, COLUMNS.length);
  ws.getCell(1, 1).value = `OP Lab Report — ${describeOpReportQuery(report.query)}`;
  ws.getCell(1, 1).font = { bold: true, size: 13, color: { argb: 'FF0B2956' } };
  ws.mergeCells(2, 1, 2, COLUMNS.length);
  ws.getCell(2, 1).value = `${summaryLine(report.totals)} · Generated ${formatGeneratedDate()}`;
  ws.getCell(2, 1).font = { size: 10, color: { argb: 'FF64748B' } };
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  const header = ws.getRow(3);
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2956' } };
  });
  for (const r of tableRows(report.rows)) {
    const row = ws.addRow(COLUMNS.map((c) => r[c.key] ?? ''));
    if (r.lab === 'failed') row.getCell(COLUMNS.findIndex((c) => c.key === 'labText') + 1).font = { bold: true, color: { argb: 'FFB91C1C' } };
    if (r.whatsapp === 'failed' || r.whatsapp === 'nowa') row.getCell(COLUMNS.findIndex((c) => c.key === 'whatsappText') + 1).font = { bold: true, color: { argb: 'FFB91C1C' } };
  }
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: COLUMNS.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function toPdf(report) {
  const rows = tableRows(report.rows);
  const body = rows
    .map(
      (r) =>
        `<tr>${COLUMNS.map((c) => {
          const cls =
            (c.key === 'labText' && r.lab === 'failed') ||
              (c.key === 'whatsappText' && (r.whatsapp === 'failed' || r.whatsapp === 'nowa'))
              ? ' class="bad"'
              : c.key === 'name'
                ? ' class="name"'
                : '';
          return `<td${cls}>${esc(r[c.key] ?? '')}</td>`;
        }).join('')}</tr>`,
    )
    .join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4 landscape; margin: 10mm 9mm; }
body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; margin: 0; font-size: 9px; }
${BRAND_CSS}
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 8px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
th { background: #0b2956; color: #fff; text-align: left; font-size: 7px; letter-spacing: 0.06em; text-transform: uppercase; padding: 5px 6px; }
td { padding: 4px 6px; border-bottom: 1px solid #eef2f7; vertical-align: top; }
tr { break-inside: avoid; }
thead { display: table-header-group; }
tbody tr:nth-child(even) td { background: #fbfcfe; }
td.name { font-weight: 700; color: #0b2956; }
td.bad { color: #b91c1c; font-weight: 700; }
.empty { text-align: center; padding: 20px; color: #94a3b8; }
</style></head><body>
${letterheadHtml(config.hospital || {}, { title: 'OP lab reports breakdown', subtitle: describeOpReportQuery(report.query), meta: `${summaryLine(report.totals)} · Generated ${formatGeneratedDate()}` })}
<table><thead><tr>${COLUMNS.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
<tbody>${body || `<tr><td class="empty" colspan="${COLUMNS.length}">No matching OP patients</td></tr>`}</tbody></table>
</body></html>`;

  const out = path.join(os.tmpdir(), `op-reports-${crypto.randomUUID()}.pdf`);
  try {
    await renderHtmlToPdf(html, out);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

function toCsv(report) {
  const quote = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.map((c) => quote(c.label)).join(',')];
  for (const r of tableRows(report.rows)) lines.push(COLUMNS.map((c) => quote(r[c.key])).join(','));
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

export async function buildOpReportExport(input, format) {
  const fmt = OP_EXPORT_FORMATS[format];
  if (!fmt) throw new Error(`Unsupported format: ${format}`);
  const report = await opReportQuery(input);
  const { from, to } = report.query;
  const stamp = from === to ? from : `${from}_to_${to}`;
  const filename = `OP-Lab-Reports-${stamp}.${fmt.ext}`;
  let buffer;
  if (format === 'json') buffer = Buffer.from(JSON.stringify(report, null, 2));
  else if (format === 'pdf') buffer = await toPdf(report);
  else if (format === 'xlsx') buffer = await toXlsx(report);
  else if (format === 'csv') buffer = toCsv(report);
  return { buffer, filename, mime: fmt.mime };
}

