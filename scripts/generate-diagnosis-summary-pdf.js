/**
 * Manual CLI: generate a diagnosis-summary PDF for a single patient by
 * regNo/UHID + an explicit date range, without going through discharge.csv
 * (which is keyed by IP number and only has rows for discharged inpatients).
 *
 * Saves the PDF locally only — no MinIO upload, no Mongo record — for
 * reviewing the report template on a real patient without it showing up in
 * the Discharge Reports list.
 *
 * `searchId` is whatever identifier the EMR's lab-results database actually
 * has orders filed under (often the IP number) — it may differ from the
 * patient's real Reg No/UHID, which the lab EMR doesn't carry at all. The
 * real Reg No and treating physician are auto-fetched from discharge.csv (or,
 * if not there, a live EMR admission-database lookup) — pass `displayUhid`
 * explicitly only to override that.
 *
 *   node --env-file=server/.env scripts/generate-diagnosis-summary-pdf.js IP07024734
 *   node --env-file=server/.env scripts/generate-diagnosis-summary-pdf.js IP07024734 6155146
 *   node --env-file=server/.env scripts/generate-diagnosis-summary-pdf.js IP07024734 6155146 2026-09-14 2026-09-21
 *   node --env-file=server/.env scripts/generate-diagnosis-summary-pdf.js IP07024734 6155146 2026-09-14 2026-09-21 ./output/custom-name.pdf
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../server/src/config.js';
import { searchInvestigation } from '../server/src/services/emrService.js';
import { buildInvestigationChartHtml, renderHtmlToPdf } from '../server/src/services/investigationPdfService.js';
import { findAdmissionByIpNo } from '../server/src/services/dischargeReportService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const csvPath = path.join(__dirname, '..', 'discharge.csv');

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Minimal CSV parser: handles quoted fields with embedded commas/quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((v) => v !== '')) rows.push(row);
  }

  const [header, ...dataRows] = rows;
  return dataRows.map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

/**
 * The lab EMR's own "IP No" field has been observed with a duplicated prefix
 * (e.g. "IP IP07024734") — strip a leading "IP " before using it to look up
 * the front-office database, which expects the plain "IP07024734" form.
 */
function normalizeIpNo(ipNo) {
  return String(ipNo || '').trim().replace(/^IP\s+/i, '');
}

/**
 * Best-effort: tries the local discharge.csv first (fast, no EMR round trip),
 * then falls back to a live lookup against the EMR's front-office admission
 * database (findAdmissionByIpNo) for patients discharged after the CSV's last
 * refresh, or not yet discharged. Returns nulls rather than throwing if
 * neither source has a match, so an ad-hoc lookup like this one just omits
 * the Reg No / Treating Physician fields instead of failing.
 */
async function findAdmissionInfo(ipNo) {
  const cleanIp = normalizeIpNo(ipNo);
  if (!cleanIp) return { regNo: '', physicianName: '' };

  if (fs.existsSync(csvPath)) {
    try {
      const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
      const row = rows.find((r) => r['IP NO']?.trim().toUpperCase() === cleanIp.toUpperCase());
      if (row) return { regNo: row['REG NO']?.trim() || '', physicianName: row['DOCTOR']?.trim() || '' };
    } catch {
      // fall through to the live lookup
    }
  }

  try {
    const row = await findAdmissionByIpNo(cleanIp);
    if (row) return { regNo: row['REG NO']?.trim() || '', physicianName: row['DOCTOR']?.trim() || '' };
  } catch {
    // fall through to the "not found" default below
  }
  return { regNo: '', physicianName: '' };
}

async function main() {
  const searchId = process.argv[2];
  if (!searchId) {
    console.error(
      'Usage: node generate-diagnosis-summary-pdf.js <searchId> [displayUhid] [fromDate YYYY-MM-DD] [toDate YYYY-MM-DD] [outPath]',
    );
    process.exit(1);
  }
  const explicitUhid = process.argv[3] || '';

  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const fromDate = process.argv[4] || formatDate(weekAgo);
  const toDate = process.argv[5] || formatDate(today);
  const explicitOutPath = process.argv[6] || '';

  console.log(`Searching "${searchId}" from ${fromDate} to ${toDate}...`);
  const result = await searchInvestigation(searchId, fromDate, toDate);

  if (!result.ok) {
    throw new Error(`EMR search failed: ${result.error}`);
  }
  if (!result.chart?.chartDates?.length) {
    throw new Error('No lab orders found for this patient in the given date range.');
  }

  const { patientMeta, chartDates, fetchErrors } = result.chart;
  console.log(`Matched patient: ${patientMeta?.name || '(name n/a)'} | IP: ${patientMeta?.ip || '—'} | Ward: ${patientMeta?.ward || '—'}`);
  console.log(`Chart built: ${chartDates.length} date(s) of results.`);
  if (fetchErrors?.length) {
    console.log(`Note: ${fetchErrors.length} fetch warning(s):`, fetchErrors);
  }

  const { regNo: foundRegNo, physicianName } = await findAdmissionInfo(patientMeta?.ip);
  const displayUhid = explicitUhid || foundRegNo || searchId;
  console.log(`Reg No / UHID: ${displayUhid}${foundRegNo ? '' : explicitUhid ? ' (explicit)' : ' (fallback: search identifier, not a real Reg No)'}`);
  console.log(`Treating physician: ${physicianName || '(not found in discharge.csv or live EMR — omitted)'}`);

  const outPath = explicitOutPath || path.join(__dirname, '..', 'output', `${displayUhid}-${formatDate(today)}.pdf`);
  const html = buildInvestigationChartHtml({ hospital: config.hospital, regNo: displayUhid, chart: result.chart, physicianName });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await renderHtmlToPdf(html, outPath);

  console.log(`Saved locally: ${outPath}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Failed to generate diagnosis summary PDF:', error.message);
  process.exit(1);
});
