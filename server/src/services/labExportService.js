/**
 * Turns a Lab Finder search into a downloadable file — PDF (same letterhead as
 * the patient reports), Excel, Word or CSV — for the Lab Finder screen, the AI
 * assistant, and WhatsApp sharing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  PageOrientation,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { config } from '../config.js';
import { renderHtmlToPdf } from './investigationPdfService.js';
import { BRAND_CSS, esc, formatGeneratedDate, letterheadHtml } from './pdfBranding.js';
import { getPdfPresignedUrl, uploadPdfFile } from './storageService.js';
import { documentLine, sendInvestigationReportWhatsApp } from './watiService.js';

export const EXPORT_FORMATS = {
  pdf: { ext: 'pdf', mime: 'application/pdf' },
  xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  csv: { ext: 'csv', mime: 'text/csv; charset=utf-8' },
};

const COLUMNS = [
  { key: 'n', label: '#', width: 5 },
  { key: 'name', label: 'Patient', width: 26 },
  { key: 'ipNo', label: 'IP No', width: 13 },
  { key: 'regNo', label: 'UHID', width: 11 },
  { key: 'department', label: 'Department', width: 18 },
  { key: 'doctor', label: 'Doctor', width: 18 },
  { key: 'testName', label: 'Test', width: 28 },
  { key: 'value', label: 'Result', width: 14 },
  { key: 'range', label: 'Ref. Range', width: 16 },
  { key: 'flag', label: 'Flag', width: 7 },
  { key: 'resultDate', label: 'Result Date', width: 12 },
  { key: 'discharged', label: 'Discharged', width: 12 },
];

const FLAG = { high: 'High', low: 'Low', normal: 'Normal' };

function isoToDmy(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso || '';
}

function tableRows(rows) {
  return rows.map((r, i) => ({
    n: i + 1,
    name: r.name,
    ipNo: r.ipNo,
    regNo: r.regNo,
    department: r.department,
    doctor: r.doctor,
    testName: r.section ? `${r.test} (${r.section})` : r.test,
    value: r.value,
    range: r.range,
    flag: FLAG[r.status] || '',
    status: r.status,
    resultDate: r.resultDate,
    discharged: isoToDmy(r.dischargeDate),
  }));
}

/** One line describing the search, printed on every export. */
export function describeQuery(q) {
  const parts = [];
  if (q.test) parts.push(`Test: ${q.test}`);
  if (q.value) parts.push(`Result contains "${q.value}"`);
  if (q.status) parts.push(`Result: ${q.status === 'abnormal' ? 'high or low' : q.status}`);
  if (q.min !== undefined || q.max !== undefined) {
    parts.push(`Value ${q.min !== undefined ? `≥ ${q.min}` : ''}${q.min !== undefined && q.max !== undefined ? ' and ' : ''}${q.max !== undefined ? `≤ ${q.max}` : ''}`);
  }
  if (q.patient) parts.push(`Patient: ${q.patient}`);
  if (q.ipNo) parts.push(`IP No: ${q.ipNo}`);
  if (q.regNo) parts.push(`UHID: ${q.regNo}`);
  if (q.department) parts.push(`Department: ${q.department}`);
  const basis = q.dateBasis === 'result' ? 'Result date' : 'Discharged';
  if (q.from && q.to) parts.push(`${basis} ${isoToDmy(q.from)} to ${isoToDmy(q.to)}`);
  else if (q.from) parts.push(`${basis} from ${isoToDmy(q.from)}`);
  else if (q.to) parts.push(`${basis} up to ${isoToDmy(q.to)}`);
  return parts.join(' · ') || 'All stored results';
}

export function exportFileName(q, format) {
  const slug = [q.test, q.value, q.ipNo, q.from, q.to]
    .filter(Boolean)
    .join('-')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `lab-results${slug ? `-${slug}` : ''}.${EXPORT_FORMATS[format].ext}`;
}

async function toPdf(search) {
  const rows = tableRows(search.rows);
  const summary = `${search.total} result${search.total === 1 ? '' : 's'} · ${search.patients} patient${search.patients === 1 ? '' : 's'}`;
  const body = rows
    .map(
      (r) =>
        `<tr>${COLUMNS.map((c) => {
          const v = esc(r[c.key] ?? '');
          if (c.key === 'value' && (r.status === 'high' || r.status === 'low')) return `<td class="v v-${r.status}">${v}</td>`;
          if (c.key === 'flag' && r.flag) return `<td><span class="flag flag-${r.status}">${v}</span></td>`;
          return `<td class="c-${c.key}">${v}</td>`;
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
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 8.8px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  th { background: #0b2956; color: #fff; text-align: left; font-size: 7.5px; letter-spacing: 0.06em; text-transform: uppercase; padding: 6px 6px; }
  td { padding: 4.5px 6px; border-bottom: 1px solid #eef2f7; vertical-align: top; overflow-wrap: anywhere; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  tbody tr:nth-child(even) td { background: #fbfcfe; }
  .c-n { color: #94a3b8; }
  .c-ipNo, .c-regNo { font-variant-numeric: tabular-nums; color: #1d4ed8; font-weight: 600; }
  .c-name { font-weight: 700; }
  .v { font-weight: 700; }
  .v-high { color: #b45309; }
  .v-low { color: #b91c1c; }
  .flag { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 7.5px; font-weight: 800; }
  .flag-high { color: #b45309; background: #fff7ed; border: 1px solid #fed7aa; }
  .flag-low { color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; }
  .flag-normal { color: #047857; background: #ecfdf5; border: 1px solid #a7f3d0; }
  .empty { padding: 30px; text-align: center; color: #64748b; }
  .foot { margin-top: 8px; font-size: 8px; color: #94a3b8; }
</style></head><body>
${letterheadHtml(config.hospital || {}, { title: 'Lab Results Report', subtitle: 'Search across stored laboratory results', meta: `Generated ${formatGeneratedDate()}` })}
<div class="criteria"><span><b>Search:</b> ${esc(describeQuery(search.query))}</span><span><b>${esc(summary)}</b></span></div>
<table><thead><tr>${COLUMNS.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
<tbody>${body || `<tr><td class="empty" colspan="${COLUMNS.length}">No matching results</td></tr>`}</tbody></table>
${search.truncated ? '<div class="foot">Only the first 5,000 results are included — narrow the search to see the rest.</div>' : ''}
<div class="foot">System-generated from stored laboratory records. Verify against the patient's lab report before clinical use.</div>
</body></html>`;

  const out = path.join(os.tmpdir(), `lab-results-${crypto.randomUUID()}.pdf`);
  try {
    await renderHtmlToPdf(html, out);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

async function toXlsx(search) {
  const wb = new ExcelJS.Workbook();
  wb.creator = config.hospital?.nameEn || 'Diagnostics Summary Portal';
  const ws = wb.addWorksheet('Lab results', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.mergeCells(1, 1, 1, COLUMNS.length);
  ws.getCell(1, 1).value = `Lab Results Report — ${describeQuery(search.query)}`;
  ws.getCell(1, 1).font = { bold: true, size: 13, color: { argb: 'FF0B2956' } };
  ws.mergeCells(2, 1, 2, COLUMNS.length);
  ws.getCell(2, 1).value = `${search.total} results · ${search.patients} patients · Generated ${formatGeneratedDate()}`;
  ws.getCell(2, 1).font = { size: 10, color: { argb: 'FF64748B' } };

  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  const header = ws.getRow(3);
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2956' } };
  });
  for (const r of tableRows(search.rows)) {
    const row = ws.addRow(COLUMNS.map((c) => r[c.key] ?? ''));
    if (r.status === 'high' || r.status === 'low') {
      const color = r.status === 'high' ? 'FFB45309' : 'FFB91C1C';
      row.getCell(COLUMNS.findIndex((c) => c.key === 'value') + 1).font = { bold: true, color: { argb: color } };
      row.getCell(COLUMNS.findIndex((c) => c.key === 'flag') + 1).font = { bold: true, color: { argb: color } };
    }
  }
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: COLUMNS.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function toDocx(search) {
  const cell = (text, opts = {}) =>
    new TableCell({
      shading: opts.header ? { type: ShadingType.SOLID, color: '0B2956', fill: '0B2956' } : undefined,
      children: [
        new Paragraph({
          children: [
            new TextRun({
              text: String(text ?? ''),
              bold: Boolean(opts.header || opts.bold),
              color: opts.header ? 'FFFFFF' : opts.color,
              size: opts.header ? 15 : 16,
            }),
          ],
        }),
      ],
    });
  const color = { high: 'B45309', low: 'B91C1C' };
  const rows = [
    new TableRow({ tableHeader: true, children: COLUMNS.map((c) => cell(c.label, { header: true })) }),
    ...tableRows(search.rows).map(
      (r) =>
        new TableRow({
          children: COLUMNS.map((c) =>
            cell(r[c.key], {
              bold: c.key === 'name' || ((c.key === 'value' || c.key === 'flag') && color[r.status]),
              color: c.key === 'value' || c.key === 'flag' ? color[r.status] : undefined,
            }),
          ),
        }),
    ),
  ];
  const doc = new Document({
    creator: config.hospital?.nameEn || 'Diagnostics Summary Portal',
    title: 'Lab Results Report',
    sections: [
      {
        properties: { page: { size: { orientation: PageOrientation.LANDSCAPE }, margin: { top: 720, bottom: 720, left: 600, right: 600 } } },
        children: [
          new Paragraph({ text: config.hospital?.nameEn || 'Adhiparasakthi Hospitals', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: 'Lab Results Report', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun({ text: describeQuery(search.query), size: 18 })] }),
          new Paragraph({
            spacing: { after: 200 },
            children: [
              new TextRun({ text: `${search.total} results · ${search.patients} patients · Generated ${formatGeneratedDate()}`, size: 18, color: '64748B' }),
            ],
          }),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }),
          new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { before: 200 },
            children: [new TextRun({ text: 'System-generated from stored laboratory records. Verify against the patient’s lab report before clinical use.', size: 16, color: '94A3B8' })],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function toCsv(search) {
  const quote = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.map((c) => quote(c.label)).join(',')];
  for (const r of tableRows(search.rows)) lines.push(COLUMNS.map((c) => quote(r[c.key])).join(','));
  // BOM so Excel opens UTF-8 (Tamil names, ≥ signs) correctly.
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

/** @returns {Promise<Buffer>} */
export async function buildExport(search, format) {
  if (format === 'pdf') return toPdf(search);
  if (format === 'xlsx') return toXlsx(search);
  if (format === 'docx') return toDocx(search);
  if (format === 'csv') return toCsv(search);
  throw new Error(`Unsupported format: ${format}`);
}

/**
 * Sends a search's PDF to one WhatsApp number through the approved
 * "investigation" template (one document per message). The PDF is uploaded
 * under exports/ and linked for an hour — long enough for WATI to fetch it.
 */
export async function shareLabResultsOnWhatsApp(search, { toNumber, recipientName, log }) {
  const pdf = await toPdf(search);
  const tmp = path.join(os.tmpdir(), `lab-share-${crypto.randomUUID()}.pdf`);
  const day = new Date().toISOString().slice(0, 10);
  const objectKey = `exports/${day}/${exportFileName(search.query, 'pdf').replace(/\.pdf$/, '')}-${crypto.randomBytes(3).toString('hex')}.pdf`;
  try {
    fs.writeFileSync(tmp, pdf);
    await uploadPdfFile(objectKey, tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return sendInvestigationReportWhatsApp({
    toNumber,
    name: recipientName || 'Sir/Madam',
    note: documentLine('Lab Results Report', `${search.total} results, ${search.patients} patients`),
    pdfUrl: await getPdfPresignedUrl(objectKey, 60 * 60),
    log: log && {
      ...log,
      document: 'lab_results',
      documentLabel: 'Lab Results Report',
      patientName: `${search.total} results · ${search.patients} patients`,
    },
  });
}
