/**
 * Hourly automation: pull today's IP discharge list from the EMR, and for every
 * real (non-ZPATIENT) patient not already reported, generate their full
 * admission-to-discharge investigation chart PDF.
 *
 * Storage: PDFs live in MinIO at `<date>/<IP_NO>.pdf` (storageService.js); metadata
 * (name, ward, dates, etc.) lives in the Mongo `discharge_reports` collection, one
 * document per (date, ipNo), so the frontend can list reports without re-hitting the
 * EMR for past dates.
 *
 * Idempotency is deliberately simple: if a PDF already exists in MinIO for a given
 * date+IP, that patient is skipped. A patient is only ever reported once per
 * discharge, but a *failed* attempt (e.g. no chart data yet) is retried on the next
 * hourly tick since no PDF was produced.
 */
import { config } from '../config.js';
import { generatePatientPdf } from './investigationPdfService.js';
import { pdfExists, reportObjectKey, getPdfPresignedUrl } from './storageService.js';
import { getMongoCollection } from './mongo.js';

const REPORTS_COLLECTION = 'discharge_reports';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let schedulerStarted = false;
let checkInProgress = false;

// Exposed via GET /api/reports/status so the UI can show a live "next check in"
// countdown instead of the user having to guess when the hourly job last/next runs.
let lastCheckStartedAt = null;
let lastCheckFinishedAt = null;
let lastSummary = null;
let nextCheckAt = null;

export function getSchedulerStatus() {
  return { checkInProgress, lastCheckStartedAt, lastCheckFinishedAt, lastSummary, nextCheckAt };
}

function mmddyyyy(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${date.getFullYear()}`;
}

export function dateFolderName(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dischargeListQuery(fromDate, toDate) {
  return `Use kmch_frontoffice EXEC Fo_Rpt_IPPatdetailsprint_QB  @frmdate = '${fromDate}' , @todate = '${toDate}' , @patname = '' , @regno = '' , @ipno = '' , @docid = '0' , @MatrixFormat = '0' , @wardid = '0' , @Status = '1' , @PatType = '0' , @Corporate_type = '0' , @depid = '0' , @BedId = '0' , @RegDocCity = '0' , @optoip = '0' , @ReligionId = '0' , @RefDocDays = '0' , @VisitCategory = '' , @CorporateId = '' , @unit = '0' , @grpby = '0' `;
}

/** The "PATIENT NAME" column is a raw HTML anchor from the EMR. */
function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').trim();
}

/** "ZPATIENT" is a dummy/test patient type used on the EMR side — never real. */
function isRealPatient(row) {
  return String(row['PATIENT TYPE'] ?? '').trim().toUpperCase() !== 'ZPATIENT';
}

export async function fetchDischargeList(fromDate, toDate) {
  const res = await fetch(config.emr.queryBuilderUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ strQuery: dischargeListQuery(fromDate, toDate), strCon: 'BB_CONSTR' }),
  });
  if (!res.ok) throw new Error(`EMR responded ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const rows = data?.d ? JSON.parse(data.d) : [];
  return (Array.isArray(rows) ? rows : []).filter(isRealPatient);
}

export async function loadReportIndex(dateFolder) {
  const collection = await getMongoCollection(REPORTS_COLLECTION);
  const docs = await collection.find({ date: dateFolder }).sort({ generatedAt: 1 }).toArray();
  return docs.map(({ _id, ...rest }) => rest);
}

async function upsertReportRecord(dateFolder, entry) {
  const collection = await getMongoCollection(REPORTS_COLLECTION);
  await collection.updateOne(
    { date: dateFolder, ipNo: entry.ipNo },
    { $set: { date: dateFolder, ...entry } },
    { upsert: true },
  );
}

/**
 * Runs one discharge check for "today". Fetches the live EMR discharge list,
 * skips patients that already have a PDF for today, and generates the rest.
 *
 * Safe to call repeatedly (hourly) — already-reported patients are always skipped,
 * and a failure on one patient does not stop the others.
 */
export async function runDischargeCheck() {
  if (checkInProgress) {
    console.log('[discharge] check already in progress, skipping this tick');
    return { skipped: true };
  }
  checkInProgress = true;
  lastCheckStartedAt = new Date().toISOString();

  const startedAt = Date.now();
  const today = new Date();
  const dateFolder = dateFolderName(today);
  const todayMdy = mmddyyyy(today);

  const summary = { date: dateFolder, found: 0, alreadyReported: 0, generated: 0, failed: 0 };

  try {
    let rows;
    try {
      rows = await fetchDischargeList(todayMdy, todayMdy);
    } catch (error) {
      console.error(`[discharge] failed to fetch today's discharge list: ${error.message}`);
      lastSummary = { ...summary, error: error.message };
      lastCheckFinishedAt = new Date().toISOString();
      return lastSummary;
    }

    summary.found = rows.length;

    for (const row of rows) {
      const ipNo = row['IP NO']?.trim();
      if (!ipNo) continue;

      const objectKey = reportObjectKey(dateFolder, ipNo);

      let exists;
      try {
        exists = await pdfExists(objectKey);
      } catch (error) {
        summary.failed += 1;
        console.error(`[discharge] ${ipNo}: could not check MinIO: ${error.message}`);
        continue;
      }

      if (exists) {
        summary.alreadyReported += 1;
        continue;
      }

      const admissionDate = row['ADMISSION DATE'];
      const dischargeDate = row['DISCHARGE DATE'];

      try {
        const result = await generatePatientPdf({
          ipNo,
          admissionDate,
          dischargeDate,
          hospital: config.hospital,
          date: dateFolder,
        });

        if (!result.ok) {
          summary.failed += 1;
          console.error(`[discharge] ${ipNo}: ${result.error}`);
          continue;
        }

        await upsertReportRecord(dateFolder, {
          ipNo,
          regNo: row['REG NO'] || '',
          name: stripHtml(row['PATIENT NAME']),
          admissionDate,
          dischargeDate,
          dischargeType: row['DISCHARGE TYPE'] || '',
          ward: row['WARD'] || '',
          unit: row['DEPARTMENT'] || '',
          doctor: row['DOCTOR'] || '',
          dateCount: result.dateCount,
          generatedAt: new Date().toISOString(),
        });

        summary.generated += 1;
        console.log(`[discharge] generated report for ${ipNo} (${stripHtml(row['PATIENT NAME'])})`);
      } catch (error) {
        summary.failed += 1;
        console.error(`[discharge] ${ipNo}: unexpected error: ${error.message}`);
      }
    }

    console.log(
      `[discharge] check complete for ${dateFolder} in ${Date.now() - startedAt}ms: ` +
        `${summary.found} found, ${summary.alreadyReported} already reported, ` +
        `${summary.generated} generated, ${summary.failed} failed`,
    );

    lastSummary = summary;
    lastCheckFinishedAt = new Date().toISOString();
    return summary;
  } finally {
    checkInProgress = false;
  }
}

/** Starts the hourly discharge-check loop. Safe to call once at server startup. */
export function startDischargeScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  console.log('[discharge] scheduler starting — checking now, then every hour');
  nextCheckAt = new Date(Date.now() + CHECK_INTERVAL_MS).toISOString();
  runDischargeCheck().catch((error) => console.error('[discharge] initial check failed:', error.message));

  setInterval(() => {
    nextCheckAt = new Date(Date.now() + CHECK_INTERVAL_MS).toISOString();
    runDischargeCheck().catch((error) => console.error('[discharge] scheduled check failed:', error.message));
  }, CHECK_INTERVAL_MS);
}

export async function listReportDates() {
  const collection = await getMongoCollection(REPORTS_COLLECTION);
  const dates = await collection.distinct('date');
  return dates.sort((a, b) => b.localeCompare(a));
}

export async function getReportPdfUrl(dateFolder, ipNo) {
  return getPdfPresignedUrl(reportObjectKey(dateFolder, ipNo));
}
