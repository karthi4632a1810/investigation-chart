/**
 * Ask AI results, numbered per conversation (#1, #2 …) and kept for 2 days, so
 * "put #1 and #2 in one PDF and the rest in a CSV" works: each result becomes
 * one or more tables in a PDF (hospital letterhead), an Excel workbook (a
 * sheet per table) or a CSV (sections one after another).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import { config } from '../config.js';
import { getMongoCollection } from './mongo.js';
import { renderHtmlToPdf } from './investigationPdfService.js';
import { BRAND_CSS, esc, formatGeneratedDate, letterheadHtml } from './pdfBranding.js';
import { getPdfStream, uploadPdfFile } from './storageService.js';

const COLLECTION = 'assistant_results';
const KEEP_SECONDS = 2 * 86400;
const NUMBERED = new Set(['patients', 'labResults', 'whatsappReport', 'dischargeReport', 'status', 'labLookup', 'patientDetails', 'journey', 'compare']);
export const EXPORT_TYPES = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv; charset=utf-8' };

let ready = null;
async function collection() {
  const c = await getMongoCollection(COLLECTION);
  ready ||= Promise.all([c.createIndex({ at: 1 }, { expireAfterSeconds: KEEP_SECONDS }), c.createIndex({ chatId: 1, n: 1 })]).catch(() => {});
  await ready;
  return c;
}

const dmy = (iso) => String(iso || '').split('-').reverse().join('-');

/** A short name for a result, e.g. "WhatsApp report · patients discharged 29-09-2026". */
export function resultTitle(b) {
  switch (b.type) {
    case 'patients':
      return b.title || 'Patients';
    case 'labResults':
      return `Lab results · ${b.total} results, ${b.patients} patients`;
    case 'labLookup':
      return `Lab report · ${b.patient?.name || b.id}${b.found ? '' : ' (not found)'}`;
    default:
      return b.title || b.type;
  }
}

/** Gives a result its number in the conversation (#1, #2 …) and keeps it. */
export async function numberResult({ chatId, user, question, block }) {
  if (!chatId || !NUMBERED.has(block.type) || (block.type === 'labLookup' && !block.found)) return block;
  const c = await collection();
  const last = await c.find({ chatId, kind: 'result' }).sort({ n: -1 }).limit(1).next();
  const n = (last?.n || 0) + 1;
  const numbered = { ...block, n };
  await c.insertOne({ chatId, user, at: new Date(), n, kind: 'result', title: resultTitle(block), question, block: numbered });
  return numbered;
}

/** The question and the AI's answer, for "with answers" files. */
export async function saveReply({ chatId, user, question, reply }) {
  if (!chatId) return;
  await (await collection()).insertOne({ chatId, user, at: new Date(), n: 0, kind: 'turn', question, reply });
}

/** "#1 Discharge report · …" lines for the AI, so it knows what can be exported. */
export async function listResults(chatId) {
  if (!chatId) return [];
  const c = await collection();
  return c.find({ chatId, kind: 'result' }, { projection: { _id: 0, n: 1, title: 1 } }).sort({ n: 1 }).toArray();
}

// ---- Results → tables ------------------------------------------------------------

const FLAG = { high: 'High', low: 'Low', normal: 'Normal' };
const fmtTime = (v) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '');
const table = (title, columns, rows) => ({ title, columns, rows: rows.map((r) => columns.map((c) => String(r[c.key] ?? ''))) });
const col = (key, label) => ({ key, label });

/** One result as one or more tables. */
export function resultTables(b) {
  switch (b.type) {
    case 'patients':
      return [table(resultTitle(b), [col('name', 'Patient'), col('ipNo', 'IP No'), col('regNo', 'UHID'), col('ageSex', 'Age / sex'), col('department', 'Department'), col('doctor', 'Doctor'), col('date', 'Discharged')],
        (b.patients || []).map((p) => ({ ...p, ageSex: [p.age, p.gender].filter(Boolean).join(' / '), date: dmy(p.date) })))];
    case 'labResults':
      return [table(resultTitle(b), [col('name', 'Patient'), col('ipNo', 'IP No'), col('test', 'Test'), col('value', 'Result'), col('range', 'Range'), col('flag', 'Flag'), col('resultDate', 'Result date'), col('discharged', 'Discharged')],
        (b.rows || []).map((r) => ({ ...r, test: r.section ? `${r.test} (${r.section})` : r.test, flag: FLAG[r.status] || '', discharged: dmy(r.dischargeDate) })))];
    case 'dischargeReport':
      return [table(b.title, [col('name', 'Patient'), col('ipNo', 'IP No'), col('regNo', 'UHID'), col('department', 'Department'), col('doctor', 'Doctor'), col('dischargedAt', 'Discharged'), col('lab', 'Lab report'), col('summary', 'Summary'), col('whatsapp', 'WhatsApp')],
        (b.rows || []).map((r) => ({ ...r, lab: r.lab === 'ready' ? 'Ready' : 'No lab data', summary: { ready: 'Ready', no_summary: 'No Summary', pending: 'Not yet' }[r.summary] || '', whatsapp: { none: 'Not sent', nowa: 'Not on WhatsApp' }[r.whatsapp] || r.whatsapp })))];
    case 'whatsappReport':
      return [
        table(`${b.title} — patient-wise`, [col('patientName', 'Patient'), col('ipNo', 'IP No'), col('department', 'Department'), col('dischargeDate', 'Discharged'), col('status', 'Overall'), col('lab', 'Lab report'), col('summary', 'Summary')],
          (b.patients || []).map((p) => ({ ...p, dischargeDate: dmy(p.dischargeDate), status: p.notOnWhatsApp ? 'Not on WhatsApp' : p.status }))),
        table(`${b.title} — message-wise`, [col('patientName', 'Patient'), col('ipNo', 'IP No'), col('document', 'Document'), col('status', 'Status'), col('sentAt', 'Sent'), col('reason', 'Why it failed')],
          (b.messages || []).map((m) => ({ ...m, status: m.notOnWhatsApp ? 'Not on WhatsApp' : m.status, sentAt: fmtTime(m.sentAt) }))),
      ];
    case 'status':
      return (b.sections || []).map((s) => table(s.title, [col('label', 'Item'), col('value', 'Value')], s.rows || []));
    case 'labLookup':
      return [table(resultTitle(b), [col('label', 'Item'), col('value', 'Value')], [
        { label: 'UHID / IP', value: b.patient?.uhid || b.patient?.ipNo || b.id },
        { label: 'Patient type', value: b.patient?.type },
        { label: 'Age / sex', value: [b.patient?.age, b.patient?.sex].filter(Boolean).join(' / ') },
        { label: 'Unit', value: b.patient?.unit },
        { label: 'Results', value: `${b.tests} over ${b.dates} day(s), ${b.firstDate}${b.dates > 1 ? ` – ${b.lastDate}` : ''}` },
      ])];
    case 'patientDetails':
      return [
        table(b.title, [col('label', 'Detail'), col('value', 'Value')], [...(b.fields || []), { label: 'Lab report', value: b.reports?.labReport }, { label: 'Discharge summary', value: b.reports?.dischargeSummary }]),
        ...(b.labs?.abnormal?.length ? [table('Out-of-range lab values', [col('test', 'Test'), col('value', 'Result'), col('range', 'Range'), col('flag', 'Flag'), col('date', 'Date')], b.labs.abnormal.map((l) => ({ ...l, flag: FLAG[l.flag] || l.flag })))] : []),
        ...(b.whatsapp?.length ? [table('WhatsApp', [col('document', 'Document'), col('status', 'Status'), col('to', 'To'), col('sentAt', 'Sent')], b.whatsapp.map((w) => ({ ...w, sentAt: fmtTime(w.sentAt) })))] : []),
      ];
    case 'journey':
      return [table(b.title, [col('time', 'When'), col('lane', 'Stage'), col('title', 'What'), col('detail', 'Details')], (b.steps || []).map((s) => ({ ...s, time: fmtTime(s.at) })))];
    case 'compare':
      return [
        ...(b.demographics?.length ? [table(`${b.title} — patients`, [col('label', ''), col('a', b.labelA), col('b', b.labelB)], b.demographics)] : []),
        table(`${b.title} — lab values`, [col('test', 'Test'), col('range', 'Range'), col('a', b.labelA), col('b', b.labelB), col('diff', 'Change')],
          (b.labs || []).map((l) => ({
            test: l.section ? `${l.test} (${l.section})` : l.test,
            range: l.range,
            a: l.a ? `${l.a.value}${l.a.flag && l.a.flag !== 'normal' ? ` ${FLAG[l.a.flag]}` : ''}` : '—',
            b: l.b ? `${l.b.value}${l.b.flag && l.b.flag !== 'normal' ? ` ${FLAG[l.b.flag]}` : ''}` : '—',
            diff: l.diff === null || l.diff === undefined ? '' : `${l.diff > 0 ? '+' : ''}${l.diff}`,
          }))),
      ];
    default:
      return [];
  }
}

// ---- Building the file -------------------------------------------------------------

async function toPdf(title, sections) {
  const body = sections
    .map((s) => {
      const tables = s.tables
        .map(
          (t) => `<h3>${esc(t.title)}</h3>
          <table><thead><tr>${t.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
          <tbody>${t.rows.length ? t.rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${t.columns.length}" class="empty">Nothing</td></tr>`}</tbody></table>`,
        )
        .join('');
      return `<section>${s.n ? `<div class="num">#${s.n}</div>` : ''}${s.question ? `<div class="q">Asked: “${esc(s.question)}”</div>` : ''}${s.reply ? `<div class="a">${esc(s.reply)}</div>` : ''}${tables}</section>`;
    })
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; color: #1e293b; }
  @page { size: A4 landscape; margin: 9mm 10mm; }
${BRAND_CSS}
  section { margin: 0 0 14px; break-inside: auto; }
  .num { display: inline-block; padding: 2px 8px; margin-bottom: 4px; font-size: 9px; font-weight: 800; color: #fff; background: #0b2956; border-radius: 6px; }
  .q { font-size: 10px; font-weight: 700; color: #1e3a8a; margin-bottom: 3px; }
  .a { font-size: 9.5px; color: #334155; margin-bottom: 6px; white-space: pre-wrap; }
  h3 { margin: 8px 0 4px; font-size: 11px; color: #0b2956; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 8.6px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  th { background: #0b2956; color: #fff; text-align: left; font-size: 7.5px; letter-spacing: 0.06em; text-transform: uppercase; padding: 5px 6px; }
  td { padding: 4px 6px; border-bottom: 1px solid #eef2f7; vertical-align: top; overflow-wrap: anywhere; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  tbody tr:nth-child(even) td { background: #fbfcfe; }
  .empty { text-align: center; color: #94a3b8; }
  .foot { margin-top: 8px; font-size: 8px; color: #94a3b8; }
</style></head><body>
${letterheadHtml(config.hospital || {}, { title: title || 'Ask AI report', subtitle: 'Results from Ask AI', meta: `Generated ${formatGeneratedDate()}` })}
${body}
<div class="foot">System-generated from the Diagnostics Summary Portal. Check against the original reports before clinical use.</div>
</body></html>`;
  const out = path.join(os.tmpdir(), `chat-export-${crypto.randomUUID()}.pdf`);
  try {
    await renderHtmlToPdf(html, out);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

async function toXlsx(sections) {
  const wb = new ExcelJS.Workbook();
  wb.creator = config.hospital?.nameEn || 'Diagnostics Summary Portal';
  const used = new Set();
  for (const s of sections) {
    for (const t of s.tables) {
      let name = `${s.n ? `#${s.n} ` : ''}${t.title}`.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet';
      for (let i = 2; used.has(name); i++) name = `${name.slice(0, 27)} (${i})`;
      used.add(name);
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 2 }] });
      ws.getCell(1, 1).value = `${s.n ? `#${s.n} ` : ''}${t.title}`;
      ws.getCell(1, 1).font = { bold: true, size: 12, color: { argb: 'FF0B2956' } };
      const header = ws.getRow(2);
      t.columns.forEach((c, i) => {
        const cell = header.getCell(i + 1);
        cell.value = c.label;
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2956' } };
        ws.getColumn(i + 1).width = Math.min(45, Math.max(12, c.label.length + 4));
      });
      for (const r of t.rows) ws.addRow(r);
    }
  }
  if (!wb.worksheets.length) wb.addWorksheet('Empty');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toCsv(sections) {
  const quote = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  for (const s of sections) {
    for (const t of s.tables) {
      lines.push(quote(`${s.n ? `#${s.n} ` : ''}${t.title}`));
      lines.push(t.columns.map((c) => quote(c.label)).join(','));
      for (const r of t.rows) lines.push(r.map(quote).join(','));
      lines.push('');
    }
  }
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

/**
 * Builds one file from numbered results of a conversation (`numbers`, or all),
 * optionally with each question and answer. Stored for download.
 * @returns { day, id, format, filename, results: [n…] }
 */
export async function buildChatExport({ chatId, numbers, format = 'pdf', title, withAnswers = false }) {
  if (!EXPORT_TYPES[format]) throw Object.assign(new Error('Format must be pdf, xlsx or csv'), { status: 400 });
  const c = await collection();
  const all = await c.find({ chatId, kind: 'result' }).sort({ n: 1 }).toArray();
  const wanted = Array.isArray(numbers) && numbers.length ? all.filter((r) => numbers.includes(r.n)) : all;
  if (!wanted.length) throw Object.assign(new Error(all.length ? `No results numbered ${numbers.join(', ')} in this chat` : 'There are no results in this chat yet'), { status: 400 });

  let replies = new Map();
  if (withAnswers) {
    const turns = await c.find({ chatId, kind: 'turn' }).toArray();
    replies = new Map(turns.map((t) => [t.question, t.reply]));
  }
  const sections = wanted.map((r) => ({ n: r.n, question: r.question, reply: withAnswers ? replies.get(r.question) : '', tables: resultTables(r.block) }));
  const name = title || (wanted.length === 1 ? wanted[0].title : `Ask AI results ${wanted.map((r) => `#${r.n}`).join(' ')}`);
  const buffer = format === 'pdf' ? await toPdf(name, sections) : format === 'xlsx' ? await toXlsx(sections) : toCsv(sections);

  const id = crypto.randomBytes(6).toString('hex');
  const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const tmp = path.join(os.tmpdir(), `chat-${id}.${format}`);
  try {
    fs.writeFileSync(tmp, buffer);
    await uploadPdfFile(`chat-exports/${day}/${id}.${format}`, tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const safe = name.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 60);
  return { day, id, format, filename: `${safe}.${format}`, results: wanted.map((r) => r.n), size: buffer.length };
}

/** The stored file for download (GET /api/assistant/export/…). */
export async function chatExportStream(day, id, format) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !/^[a-f0-9]{12}$/.test(id || '') || !EXPORT_TYPES[format]) return null;
  return getPdfStream(`chat-exports/${day}/${id}.${format}`);
}
