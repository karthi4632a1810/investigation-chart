/**
 * Exports the /admin WhatsApp monitor's current view — message by message, or
 * patient-wise (one row per patient, one column group per report) — as Excel,
 * PDF, CSV or JSON. Always scoped by the same filters as the screen.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import { config } from '../config.js';
import { renderHtmlToPdf } from './investigationPdfService.js';
import { BRAND_CSS, esc, formatGeneratedDate, letterheadHtml } from './pdfBranding.js';
import { allWhatsappMessages, whatsappPatients, whatsappSummary } from './whatsappLogService.js';

export const WA_EXPORT_FORMATS = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

const STATUS_LABEL = { pending: 'Pending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };
const TRIGGER_LABEL = { auto: 'Automatic (live)', manual: 'Manual click', share: 'Shared to a number', imported: 'Imported history' };
const DOC_LABEL = { lab: 'Lab Report', summary: 'Discharge Summary', lab_results: 'Lab Results Report' };

function ist(date) {
  if (!date) return '';
  return new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

const dmy = (iso) => (iso ? String(iso).split('-').reverse().join('-') : '');
const phone = (d) => (String(d || '').length === 12 && String(d).startsWith('91') ? `+91 ${String(d).slice(2, 7)} ${String(d).slice(7)}` : d ? `+${d}` : '');
const docLabel = (m) => m.documentLabel || DOC_LABEL[m.document] || 'Message';
const reason = (m) => (m.status === 'failed' ? m.failedDetail || m.error || '' : '');

function describeFilters(q) {
  const range = q.from === q.to ? dmy(q.from) : `${dmy(q.from)} to ${dmy(q.to)}`;
  const parts = [q.basis === 'report' ? `Patients discharged ${range}` : `Sent ${range}`];
  if (q.status) parts.push(`Status: ${String(q.status).split(',').map((s) => STATUS_LABEL[s] || s).join(', ')}`);
  if (q.document) parts.push(`Document: ${DOC_LABEL[q.document] || q.document}`);
  if (q.trigger) parts.push(`Trigger: ${TRIGGER_LABEL[q.trigger] || q.trigger}`);
  if (q.q) parts.push(`Search: "${q.q}"`);
  return parts.filter(Boolean).join(' · ');
}

const MESSAGE_COLUMNS = [
  { key: 'sentAt', label: 'Sent at', width: 20 },
  { key: 'patient', label: 'Patient', width: 26 },
  { key: 'ipNo', label: 'IP No', width: 13 },
  { key: 'discharged', label: 'Discharged', width: 12 },
  { key: 'document', label: 'Report', width: 18 },
  { key: 'to', label: 'To', width: 17 },
  { key: 'status', label: 'Status', width: 11 },
  { key: 'deliveredAt', label: 'Delivered at', width: 20 },
  { key: 'readAt', label: 'Read at', width: 20 },
  { key: 'reason', label: 'Failure reason', width: 34 },
  { key: 'trigger', label: 'Trigger', width: 18 },
  { key: 'by', label: 'By', width: 12 },
  { key: 'attempts', label: 'Attempts', width: 9 },
];

function messageRows(messages) {
  return messages.map((m) => ({
    sentAt: ist(m.acceptedAt || m.createdAt),
    patient: m.patientName || '',
    ipNo: m.ipNo || '',
    discharged: dmy(m.dischargeDate),
    document: docLabel(m),
    to: phone(m.toNumber),
    status: m.status === 'failed' && m.notOnWhatsApp ? 'Not on WhatsApp' : STATUS_LABEL[m.status] || m.status,
    deliveredAt: ist(m.deliveredAt),
    readAt: ist(m.readAt),
    reason: reason(m),
    trigger: `${TRIGGER_LABEL[m.trigger] || m.trigger}${m.via ? ` (via ${m.via.replace('_', ' ')})` : ''}`,
    by: m.triggeredBy || '',
    attempts: m.attempts || 1,
    _status: m.status,
  }));
}

/** Patient-wise columns: patient details, then Status / Read at per report found. */
function patientTable(patients) {
  const reportKeys = [];
  for (const p of patients) for (const r of p.reports) if (!reportKeys.includes(docLabel(r))) reportKeys.push(docLabel(r));
  const columns = [
    { key: 'patient', label: 'Patient', width: 26 },
    { key: 'ipNo', label: 'IP No', width: 13 },
    { key: 'discharged', label: 'Discharged', width: 12 },
    { key: 'to', label: 'To', width: 17 },
    { key: 'overall', label: 'Overall', width: 11 },
    ...reportKeys.flatMap((k) => [
      { key: `${k}|status`, label: `${k} — status`, width: 16 },
      { key: `${k}|when`, label: `${k} — delivered / read`, width: 22 },
    ]),
    { key: 'messages', label: 'Messages sent', width: 10 },
    { key: 'reason', label: 'Failure reason', width: 34 },
    { key: 'lastAt', label: 'Last update', width: 20 },
  ];
  const rows = patients.map((p) => {
    const row = {
      patient: p.patientName || '',
      ipNo: p.ipNo || '',
      discharged: dmy(p.dischargeDate),
      to: phone(p.toNumber),
      overall: STATUS_LABEL[p.status] || p.status,
      messages: p.messages.length,
      reason: p.reports.map(reason).filter(Boolean).join('; '),
      lastAt: ist(p.lastAt),
      _status: p.status,
    };
    for (const r of p.reports) {
      const label = docLabel(r);
      const state = r.status === 'failed' && r.notOnWhatsApp ? 'Not on WhatsApp' : STATUS_LABEL[r.status] || r.status;
      row[`${label}|status`] = `${state}${r.sends > 1 ? ` (${r.sends} sends)` : ''}`;
      row[`${label}|when`] = ist(r.readAt || r.deliveredAt);
    }
    return row;
  });
  return { columns, rows };
}

async function toXlsx({ title, subtitle, columns, rows }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = config.hospital?.nameEn || 'Diagnostics Summary Portal';
  const ws = wb.addWorksheet('WhatsApp report', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.mergeCells(1, 1, 1, columns.length);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { bold: true, size: 13, color: { argb: 'FF0B2956' } };
  ws.mergeCells(2, 1, 2, columns.length);
  ws.getCell(2, 1).value = subtitle;
  ws.getCell(2, 1).font = { size: 10, color: { argb: 'FF64748B' } };
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width }));
  const header = ws.getRow(3);
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2956' } };
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });
  const tint = { failed: 'FFFEF2F2', pending: 'FFFFFBEB' };
  for (const r of rows) {
    const row = ws.addRow(columns.map((c) => r[c.key] ?? ''));
    if (tint[r._status]) row.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tint[r._status] } }));
  }
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function toPdf({ title, subtitle, kpis, columns, rows }) {
  const html = `<!doctype html><html><head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; color: #1e293b; }
  @page { size: A4 landscape; margin: 9mm 10mm; }
${BRAND_CSS}
  .kpis { display: grid; grid-template-columns: repeat(${kpis.length}, 1fr); gap: 6px; margin: 0 0 8px; }
  .kpi { border: 1px solid #e2e8f0; border-radius: 8px; padding: 6px 10px; }
  .kpi span { display: block; font-size: 7.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b; }
  .kpi b { font-size: 15px; color: #0f172a; }
  .kpi i { font-style: normal; font-size: 8px; color: #64748b; margin-left: 4px; }
  .criteria { margin: 0 0 8px; font-size: 9px; color: #475569; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 7.8px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  th { background: #0b2956; color: #fff; text-align: left; font-size: 6.8px; letter-spacing: 0.05em; text-transform: uppercase; padding: 5px; }
  td { padding: 4px 5px; border-bottom: 1px solid #eef2f7; vertical-align: top; overflow-wrap: anywhere; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  tr.is-failed td { background: #fef2f2; }
  tr.is-pending td { background: #fffbeb; }
  .empty { padding: 24px; text-align: center; color: #64748b; }
</style></head><body>
${letterheadHtml(config.hospital || {}, { title, subtitle: 'WhatsApp delivery report', meta: `Generated ${formatGeneratedDate()}` })}
<div class="criteria">${esc(subtitle)}</div>
<div class="kpis">${kpis.map((k) => `<div class="kpi"><span>${esc(k.label)}</span><b>${esc(k.value)}</b>${k.note ? `<i>${esc(k.note)}</i>` : ''}</div>`).join('')}</div>
<table><thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr class="is-${esc(r._status)}">${columns.map((c) => `<td>${esc(r[c.key] ?? '')}</td>`).join('')}</tr>`).join('') || `<tr><td class="empty" colspan="${columns.length}">No messages match these filters</td></tr>`}</tbody></table>
</body></html>`;
  const out = path.join(os.tmpdir(), `wa-report-${crypto.randomUUID()}.pdf`);
  try {
    await renderHtmlToPdf(html, out);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

function toCsv({ columns, rows }) {
  const quote = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => quote(c.label)).join(','), ...rows.map((r) => columns.map((c) => quote(r[c.key])).join(','))];
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

/**
 * @param q      the monitor's filters (from, to, status, document, trigger, q)
 * @param view   'messages' | 'patients'
 * @param format 'xlsx' | 'pdf' | 'csv' | 'json'
 * @returns { buffer, filename, mime }
 */
export async function buildWhatsappExport(q, view, format) {
  const summary = await whatsappSummary(q);
  const pct = (r) => (r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`);
  const kpis = [
    { label: 'Messages', value: summary.total, note: summary.patients ? `${summary.patients} patients` : '' },
    { label: 'Delivered', value: summary.funnel.delivered, note: `${pct(summary.rates.delivered)} of sent` },
    { label: 'Read', value: summary.counts.read, note: `${pct(summary.rates.read)} of delivered` },
    { label: 'Sent, not delivered', value: summary.counts.sent },
    { label: 'Pending', value: summary.counts.pending },
    { label: 'Failed', value: summary.counts.failed, note: pct(summary.rates.failed) },
    { label: 'Not on WhatsApp', value: summary.notOnWhatsApp.numbers, note: 'numbers' },
  ];
  const subtitle = describeFilters(q);
  const stamp = `${q.basis === 'report' ? 'discharged' : 'sent'}-${q.from || 'all'}${q.to && q.to !== q.from ? `_to_${q.to}` : ''}`;
  const filename = `whatsapp-${view}-${stamp}.${format}`;

  let table;
  let data;
  if (view === 'patients') {
    const { items } = await whatsappPatients({ ...q, page: 1, limit: 5000 });
    table = patientTable(items);
    data = items;
  } else {
    const messages = await allWhatsappMessages(q);
    table = { columns: MESSAGE_COLUMNS, rows: messageRows(messages) };
    data = messages;
  }
  const title = view === 'patients' ? 'WhatsApp Report — Patient-wise' : 'WhatsApp Report — All Messages';

  let buffer;
  if (format === 'json') {
    buffer = Buffer.from(
      JSON.stringify({ title, filters: q, generatedAt: new Date().toISOString(), summary: { total: summary.total, counts: summary.counts, rates: summary.rates, patients: summary.patients }, items: data }, null, 2),
    );
  } else if (format === 'csv') buffer = toCsv(table);
  else if (format === 'xlsx') buffer = await toXlsx({ title, subtitle, ...table });
  else if (format === 'pdf') buffer = await toPdf({ title, subtitle, kpis, ...table });
  else throw new Error('Format must be xlsx, pdf, csv or json');
  return { buffer, filename, mime: WA_EXPORT_FORMATS[format] };
}
