/**
 * Manual CLI: generate one patient's full admission-to-discharge Investigation
 * Chart PDF, using the same logic as the hourly automation
 * (server/src/services/dischargeReportService.js + investigationPdfService.js).
 *
 * Looks up ADMISSION DATE / DISCHARGE DATE for the given IP number in
 * discharge.csv (see scripts/fetch-discharge.js), then uploads the PDF to MinIO at
 * <date>/<IP_NO>.pdf and records its metadata in Mongo — exactly what the hourly
 * automation does.
 *
 * Needs MONGO_URI / MINIO_* pointed at the running stack, e.g. the host-published
 * ports from docker-compose.yml:
 *
 *   node --env-file=server/.env scripts/generate-investigation-pdf.js IP07023819
 *   node --env-file=server/.env scripts/generate-investigation-pdf.js IP07023819 2026-09-07  # explicit report date (YYYY-MM-DD)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../server/src/config.js';
import { generatePatientPdf } from '../server/src/services/investigationPdfService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const csvPath = path.join(__dirname, '..', 'discharge.csv');

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

function findDischargeRow(ipNo) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`discharge.csv not found at ${csvPath} — run fetch-discharge.js first`);
  }
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const row = rows.find((r) => r['IP NO']?.trim().toUpperCase() === ipNo.toUpperCase());
  if (!row) throw new Error(`"${ipNo}" not found in discharge.csv`);
  return row;
}

async function main() {
  const ipNo = process.argv[2];
  if (!ipNo) {
    console.error('Usage: node generate-investigation-pdf.js <IP_NO> [output-date YYYY-MM-DD]');
    process.exit(1);
  }

  const row = findDischargeRow(ipNo);
  const admissionDate = row['ADMISSION DATE'];
  const dischargeDate = row['DISCHARGE DATE'];

  console.log(`Found "${ipNo}": ${row['PATIENT NAME']?.trim() || '(name n/a)'}`);
  console.log(`Fetching chart: ${admissionDate} -> ${dischargeDate}`);

  let folderDate = process.argv[3];
  if (!folderDate) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    folderDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const result = await generatePatientPdf({
    ipNo,
    admissionDate,
    dischargeDate,
    hospital: config.hospital,
    date: folderDate,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  console.log(`Chart built: ${result.dateCount} date(s) of results.`);
  if (result.fetchErrors?.length) {
    console.log(`Note: ${result.fetchErrors.length} fetch warning(s):`, result.fetchErrors);
  }
  console.log(`Uploaded to MinIO: ${result.objectKey}`);
}

main().catch((error) => {
  console.error('Failed to generate investigation PDF:', error.message);
  process.exit(1);
});
