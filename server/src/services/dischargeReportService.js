/**
 * Automation: pull today's IP discharge list from the EMR, and for every real
 * (non-ZPATIENT) patient, generate two documents — the full admission-to-discharge
 * lab investigation chart, and the EMR's own discharge summary (diagnosis/history
 * note) — each independently, so one being missing never blocks the other.
 *
 * Storage: PDFs live in MinIO — `<date>/<IP_NO>.pdf` for the lab chart,
 * `<date>/<IP_NO>-summary.pdf` for the discharge summary (storageService.js).
 * Metadata (name, ward, dates, etc.) lives in the Mongo `discharge_reports`
 * collection, one document per (date, ipNo), so the frontend can list/search
 * reports without re-hitting the EMR for past dates.
 *
 * Idempotency is deliberately simple and per-document: if a given PDF already
 * exists in MinIO, that document is skipped; if not (and, for the lab chart,
 * not already confirmed to have no data — see isConfirmedNoData), it's
 * (re)attempted on this cycle. A patient already fully reported from before this
 * feature existed will have its summary generated on its next processing pass
 * without needing a separate backfill step.
 */
import { config } from '../config.js';
import { generatePatientPdf } from './investigationPdfService.js';
import { generateDischargeSummaryPdf } from './dischargeSummaryService.js';
import { pdfExists, reportObjectKey, reportSummaryObjectKey, getPdfPresignedUrl } from './storageService.js';
import { getMongoCollection } from './mongo.js';
import { getWatiSettings } from './watiSettingsService.js';
import { sendInvestigationReportWhatsApp } from './watiService.js';

const REPORTS_COLLECTION = 'discharge_reports';
// Patients confirmed to have zero lab orders anywhere in the EMR (checked by both
// IP and REG number, window widened a week before admission). Tracked separately
// from discharge_reports — there's no PDF for these, just a record that we already
// checked thoroughly, so the scheduler stops re-checking a patient who will never
// have data instead of re-querying the EMR for them forever.
const NO_DATA_COLLECTION = 'discharge_no_data';
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes, aligned to the wall clock — see startDischargeScheduler
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

/**
 * Builds the Mongo document for one generated report, pulling every field the
 * advanced search screen filters on straight from the raw discharge-list row —
 * captured once at generation time rather than re-fetched from the EMR later.
 */
function buildBaselineFields(row) {
  return {
    ipNo: row['IP NO']?.trim(),
    regNo: row['REG NO'] || '',
    name: stripHtml(row['PATIENT NAME']),
    patientType: row['PATIENT TYPE'] || '',
    age: row['AGE'] || '',
    gender: row['GENDER'] || '',
    mobile: row['MOBILE'] || '',
    whatsapp: row['WhatsApp No'] || '',
    department: row['DEPARTMENT'] || '',
    doctor: row['DOCTOR'] || '',
    ward: row['WARD'] || '',
    bedNo: row['BED NO'] || '',
    admissionDate: row['ADMISSION DATE'],
    dischargeDate: row['DISCHARGE DATE'],
    dischargeType: row['DISCHARGE TYPE'] || '',
    createdUser: row['CREATED USER'] || '',
  };
}

export function buildReportRecord(row, result) {
  return {
    ...buildBaselineFields(row),
    dateCount: result.dateCount,
    reqNos: result.reqNos || [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Merges baseline identity fields plus whatever `extra` fields are given (e.g.
 * `{hasSummary: true}`) into a patient's report document — via $set, not a full
 * replace, so this never wipes out dateCount/reqNos a prior lab-success upsert
 * already wrote. Used when only the discharge summary succeeded and there may
 * be no lab-derived `result` object to build a full record from yet.
 */
export async function upsertReportBaseline(dateFolder, row, extra = {}) {
  const collection = await getMongoCollection(REPORTS_COLLECTION);
  await collection.updateOne(
    { date: dateFolder, ipNo: row['IP NO']?.trim() },
    { $set: { date: dateFolder, ...buildBaselineFields(row), ...extra } },
    { upsert: true },
  );
}

export async function fetchDischargeList(fromDate, toDate) {
  // AbortSignal.timeout, not a bare fetch — an unbounded fetch() can hang
  // indefinitely on a connection that never completes, the same failure mode
  // fixed for the EMR client in emrService.js.
  const res = await fetch(config.emr.queryBuilderUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ strQuery: dischargeListQuery(fromDate, toDate), strCon: 'BB_CONSTR' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`EMR responded ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const rows = data?.d ? JSON.parse(data.d) : [];
  return (Array.isArray(rows) ? rows : []).filter(isRealPatient);
}

export async function getReportRecord(dateFolder, ipNo) {
  const collection = await getMongoCollection(REPORTS_COLLECTION);
  const doc = await collection.findOne({ date: dateFolder, ipNo });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

export async function loadReportIndex(dateFolder) {
  const collection = await getMongoCollection(REPORTS_COLLECTION);
  const docs = await collection.find({ date: dateFolder }).sort({ generatedAt: 1 }).toArray();
  return docs.map(({ _id, ...rest }) => rest);
}

/** Case-insensitive "contains" match — used for every free-text filter field. */
function containsFilter(value) {
  // Escaped so a stray regex metacharacter in the search box (e.g. "IP07025(23")
  // can't produce an invalid pattern or match more broadly than intended.
  const escaped = String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $regex: escaped, $options: 'i' };
}

/**
 * Cross-date search over every generated report, for the advanced search screen.
 * Every filter is optional and AND-ed together; text fields match anywhere in
 * the value (not just an exact match), since users search "MOHAN" expecting to
 * find "MOHANRAJ" too.
 */
export async function searchReports(filters = {}) {
  const query = {};

  const textField = (key, filterValue) => {
    if (filterValue?.trim()) query[key] = containsFilter(filterValue);
  };

  textField('ipNo', filters.ipNo);
  textField('regNo', filters.regNo);
  textField('name', filters.name);
  textField('mobile', filters.mobile);
  textField('whatsapp', filters.whatsapp);
  textField('department', filters.department);
  textField('doctor', filters.doctor);
  textField('ward', filters.ward);
  textField('createdUser', filters.createdUser);

  // Exact match — a patient type is a fixed set of values (General/Corporate/...),
  // not free text, so "contains" would be more surprising than helpful here.
  if (filters.patientType?.trim()) query.patientType = filters.patientType.trim();

  // A Req No lives inside the per-report array, not as its own field.
  if (filters.reqNo?.trim()) query.reqNos = filters.reqNo.trim();

  if (filters.fromDate || filters.toDate) {
    query.date = {};
    if (filters.fromDate) query.date.$gte = filters.fromDate;
    if (filters.toDate) query.date.$lte = filters.toDate;
  }

  const collection = await getMongoCollection(REPORTS_COLLECTION);
  const limit = Math.min(Math.max(parseInt(filters.limit ?? '200', 10) || 200, 1), 500);
  const docs = await collection.find(query).sort({ date: -1, generatedAt: -1 }).limit(limit).toArray();
  return docs.map(({ _id, ...rest }) => rest);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a single patient's PDF generation a few times before giving up for
 * this cycle. The EMR is a shared, occasionally slow/loaded production system —
 * a single timeout or connection error shouldn't cost the patient the whole
 * cycle (the next scheduled check would retry anyway, but that's 30 minutes of
 * delay for what's often just a few seconds of EMR load).
 *
 * A `NO_DATA` result (investigationPdfService.js already tried both identifiers
 * and widened the date window) is deliberately NOT retried — the EMR won't have
 * new lab orders appear moments later just because we ask again, so retrying it
 * would only burn 3 more rounds of load against their system for nothing.
 */
export async function generatePatientPdfWithRetries(args, attempts = 4, delayMs = 20_000) {
  let lastResult;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await generatePatientPdf(args);
      if (result.ok) return result;
      lastResult = result;
      if (result.reason === 'NO_DATA') return lastResult;
    } catch (error) {
      lastResult = { ok: false, reason: 'TECHNICAL', error: error.message };
    }

    if (attempt < attempts) {
      console.warn(
        `[discharge] ${args.ipNo}: attempt ${attempt}/${attempts} failed (${lastResult.error}), retrying in ${delayMs / 1000}s`,
      );
      await sleep(delayMs);
    }
  }
  return lastResult;
}

export async function isConfirmedNoData(dateFolder, ipNo) {
  const collection = await getMongoCollection(NO_DATA_COLLECTION);
  return Boolean(await collection.findOne({ date: dateFolder, ipNo }));
}

export async function markNoData(dateFolder, ipNo, name) {
  const collection = await getMongoCollection(NO_DATA_COLLECTION);
  await collection.updateOne(
    { date: dateFolder, ipNo },
    { $set: { date: dateFolder, ipNo, name, checkedAt: new Date().toISOString() } },
    { upsert: true },
  );
}

export async function upsertReportRecord(dateFolder, entry) {
  const collection = await getMongoCollection(REPORTS_COLLECTION);
  await collection.updateOne(
    { date: dateFolder, ipNo: entry.ipNo },
    { $set: { date: dateFolder, ...entry } },
    { upsert: true },
  );
}

/**
 * The actual per-date work: fetch the EMR discharge list for `dateFolder`/`mdy`,
 * and for every real patient ensure both documents exist — generating whichever
 * of the lab chart / discharge summary is still missing. Shared by the live
 * "today" scheduler and the manual backfill path (runBackfillForDate) below, so
 * there is exactly one place that knows how to process a discharge date.
 */
async function processDischargeDate(dateFolder, mdy) {
  const startedAt = Date.now();
  const summary = {
    date: dateFolder,
    found: 0,
    alreadyReported: 0,
    generated: 0,
    noLabData: 0,
    failed: 0,
    summaryGenerated: 0,
    summaryFailed: 0,
  };

  let rows;
  try {
    rows = await fetchDischargeList(mdy, mdy);
  } catch (error) {
    console.error(`[discharge] failed to fetch discharge list for ${dateFolder}: ${error.message}`);
    return { ...summary, error: error.message };
  }

  summary.found = rows.length;

    for (const row of rows) {
      const ipNo = row['IP NO']?.trim();
      if (!ipNo) continue;

      const patientName = stripHtml(row['PATIENT NAME']);
      const labKey = reportObjectKey(dateFolder, ipNo);
      const summaryKey = reportSummaryObjectKey(dateFolder, ipNo);

      let labExists, summaryExists;
      try {
        [labExists, summaryExists] = await Promise.all([pdfExists(labKey), pdfExists(summaryKey)]);
      } catch (error) {
        summary.failed += 1;
        console.error(`[discharge] ${ipNo}: could not check MinIO: ${error.message}`);
        continue;
      }

      const noLabData = labExists ? false : await isConfirmedNoData(dateFolder, ipNo);
      const labDone = labExists || noLabData;

      if (labDone && summaryExists) {
        summary.alreadyReported += 1;
        continue;
      }
      if (noLabData) summary.noLabData += 1;

      const admissionDate = row['ADMISSION DATE'];
      const dischargeDate = row['DISCHARGE DATE'];

      // Lab investigation chart — independent of the summary below, so a
      // failure here doesn't skip attempting the summary (and vice versa).
      if (!labDone) {
        try {
          const result = await generatePatientPdfWithRetries({
            ipNo,
            regNo: row['REG NO'],
            admissionDate,
            dischargeDate,
            hospital: config.hospital,
            date: dateFolder,
          });

          if (!result.ok) {
            if (result.reason === 'NO_DATA') {
              summary.noLabData += 1;
              await markNoData(dateFolder, ipNo, patientName);
              console.log(`[discharge] ${ipNo} (${patientName}): no lab orders — won't recheck`);
            } else {
              summary.failed += 1;
              console.error(`[discharge] ${ipNo}: ${result.error}`);
            }
          } else {
            await upsertReportRecord(dateFolder, buildReportRecord(row, result));
            summary.generated += 1;
            console.log(`[discharge] generated lab report for ${ipNo} (${patientName})`);

            // WhatsApp auto-send — lab report only, never the discharge summary,
            // and only when live mode is on (see watiSettingsService.js). A send
            // failure here shouldn't affect the report itself, which already
            // succeeded — it's logged and left for a manual resend if needed.
            try {
              const watiSettings = await getWatiSettings();
              const mobile = row['MOBILE'];
              if (watiSettings.liveEnabled && mobile) {
                const pdfUrl = await getPdfPresignedUrl(labKey);
                await sendInvestigationReportWhatsApp({
                  toNumber: mobile,
                  name: patientName,
                  note: watiSettings.secondParam,
                  pdfUrl,
                });
                console.log(`[discharge] sent WhatsApp lab report to ${mobile} for ${ipNo}`);
              }
            } catch (error) {
              console.error(`[discharge] ${ipNo}: WhatsApp auto-send failed: ${error.message}`);
            }
          }
        } catch (error) {
          summary.failed += 1;
          console.error(`[discharge] ${ipNo}: unexpected error: ${error.message}`);
        }
      }

      // Discharge summary — attempted for every patient regardless of lab
      // outcome; a patient with no lab orders can still have a valid summary.
      if (!summaryExists) {
        try {
          const result = await generateDischargeSummaryPdf({ ipNo, date: dateFolder, hospital: config.hospital });
          if (result.ok) {
            await upsertReportBaseline(dateFolder, row, { hasSummary: true });
            summary.summaryGenerated += 1;
            console.log(`[discharge] generated discharge summary for ${ipNo} (${patientName})`);
          } else {
            summary.summaryFailed += 1;
            console.error(`[discharge] ${ipNo}: discharge summary failed: ${result.error}`);
          }
        } catch (error) {
          summary.summaryFailed += 1;
          console.error(`[discharge] ${ipNo}: unexpected error generating summary: ${error.message}`);
        }
      }
    }

  console.log(
    `[discharge] check complete for ${dateFolder} in ${Date.now() - startedAt}ms: ` +
      `${summary.found} found, ${summary.alreadyReported} already reported, ` +
      `${summary.generated} lab generated, ${summary.noLabData} no lab data, ${summary.failed} lab failed, ` +
      `${summary.summaryGenerated} summaries generated, ${summary.summaryFailed} summaries failed`,
  );

  return summary;
}

/**
 * Runs one discharge check for "today". Fetches the live EMR discharge list,
 * skips patients that already have both documents for today, and generates
 * whichever is missing for the rest.
 *
 * Safe to call repeatedly (every 30 min) — already-reported patients are always
 * skipped, and a failure on one patient does not stop the others.
 */
export async function runDischargeCheck() {
  if (checkInProgress) {
    console.log('[discharge] check already in progress, skipping this tick');
    return { skipped: true };
  }
  checkInProgress = true;
  lastCheckStartedAt = new Date().toISOString();

  try {
    const today = new Date();
    const summary = await processDischargeDate(dateFolderName(today), mmddyyyy(today));
    lastSummary = summary;
    return summary;
  } finally {
    lastCheckFinishedAt = new Date().toISOString();
    checkInProgress = false;
  }
}

/**
 * Manual backfill for a specific past date (e.g. "2026-09-08") — the live
 * scheduler only ever looks at "today", so a date that's already gone by never
 * gets revisited on its own. Runs the identical per-patient logic as
 * runDischargeCheck, just against a caller-supplied date instead of today.
 *
 * Deliberately does not touch lastSummary/nextCheckAt — those reflect the live
 * "today" scheduler on the dashboard, and a backfill for a past date shouldn't
 * make it look like the automation just checked *today* and found nothing new.
 * Shares the same in-progress guard as runDischargeCheck so the two can never
 * run concurrently and double up load against the EMR.
 */
export async function runBackfillForDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error('Expected date in YYYY-MM-DD format');
  }
  if (checkInProgress) {
    return { skipped: true, reason: 'A check is already in progress, try again shortly' };
  }
  checkInProgress = true;

  try {
    const [year, month, day] = dateStr.split('-');
    const mdy = `${month}/${day}/${year}`;
    return await processDischargeDate(dateStr, mdy);
  } finally {
    checkInProgress = false;
  }
}

/**
 * Milliseconds until the next wall-clock boundary that's a multiple of
 * `intervalMs` since the Unix epoch (UTC). For a 30-minute interval this lands
 * on :00 and :30 of every hour — "1:00, 1:30, 2:00, 2:30", not "whenever the
 * server happened to start, plus 30 minutes, plus 30 minutes...".
 *
 * This also lines up with IST wall-clock halves without any timezone-aware
 * math: IST is UTC+5:30, and 5h30m is itself an exact multiple of 30 minutes,
 * so a UTC :00/:30 boundary is always an IST :00/:30 boundary too.
 */
function msUntilNextAlignedTick(intervalMs) {
  const remainder = Date.now() % intervalMs;
  return remainder === 0 ? intervalMs : intervalMs - remainder;
}

/**
 * Starts the discharge-check loop: once immediately (so a restart doesn't mean
 * waiting up to 30 minutes to see fresh data), then aligned to the wall clock
 * every CHECK_INTERVAL_MS after that. Safe to call once at server startup.
 *
 * Self-scheduling via setTimeout rather than setInterval — setInterval would
 * drift by however long each check itself takes, quietly sliding off the
 * clock-aligned marks over time. Recomputing the delay to the next boundary on
 * every tick keeps it pinned regardless of how long a check runs.
 */
export function startDischargeScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  function scheduleNextTick() {
    const delay = msUntilNextAlignedTick(CHECK_INTERVAL_MS);
    nextCheckAt = new Date(Date.now() + delay).toISOString();
    setTimeout(() => {
      runDischargeCheck().catch((error) => console.error('[discharge] scheduled check failed:', error.message));
      scheduleNextTick();
    }, delay);
  }

  console.log('[discharge] scheduler starting — checking now, then every 30 minutes on the clock (:00/:30)');
  runDischargeCheck().catch((error) => console.error('[discharge] initial check failed:', error.message));
  scheduleNextTick();
}

export async function listReportDates() {
  const collection = await getMongoCollection(REPORTS_COLLECTION);
  const dates = await collection.distinct('date');
  return dates.sort((a, b) => b.localeCompare(a));
}

export async function getReportPdfUrl(dateFolder, ipNo) {
  return getPdfPresignedUrl(reportObjectKey(dateFolder, ipNo));
}

export async function getReportSummaryPdfUrl(dateFolder, ipNo) {
  return getPdfPresignedUrl(reportSummaryObjectKey(dateFolder, ipNo));
}
