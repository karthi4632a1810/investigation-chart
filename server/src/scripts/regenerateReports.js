/**
 * Re-renders already-generated reports — lab report and/or discharge summary —
 * so past dates pick up the current PDF design. New reports need nothing: the
 * scheduler always renders with the current design.
 *
 * Works from the reports already recorded in Mongo for each date (the same
 * list the Discharge Reports screen shows) and only redoes documents that
 * already exist; it never creates reports the scheduler hasn't, and never
 * sends anything on WhatsApp. Each PDF is overwritten in place in MinIO, so the
 * app's links keep working and a failed patient simply keeps its old PDF.
 *
 * Inside the backend container (VPS or local Docker):
 *   docker exec investigation-backend node src/scripts/regenerateReports.js                   # yesterday + today
 *   docker exec investigation-backend node src/scripts/regenerateReports.js 2026-09-27        # one or more dates
 *   docker exec investigation-backend node src/scripts/regenerateReports.js 2026-09-27 --only=summary
 *   (--only=lab | --only=summary; default is both)
 */
import { config } from '../config.js';
import {
  dateFolderName,
  generatePatientPdfWithRetries,
  loadReportIndex,
} from '../services/dischargeReportService.js';
import { generateDischargeSummaryPdf } from '../services/dischargeSummaryService.js';
import { getMongoCollection } from '../services/mongo.js';
import { saveLabResults } from '../services/labResultsService.js';

const CONCURRENCY = 2; // each worker drives its own Chrome; 2 keeps the server responsive
const SUMMARY_ATTEMPTS = 3;

function parseArgs(argv) {
  const dates = argv.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  if (only && !['lab', 'summary'].includes(only)) {
    throw new Error(`--only must be "lab" or "summary", got "${only}"`);
  }
  const bad = argv.filter((a) => !dates.includes(a) && !a.startsWith('--only='));
  if (bad.length) throw new Error(`Unrecognised argument(s): ${bad.join(' ')} — dates must be YYYY-MM-DD`);

  // Same clock as the scheduler (dateFolderName), so "today" matches the
  // folder the scheduler is writing to on this server.
  const now = Date.now();
  return {
    dates: dates.length ? dates : [dateFolderName(new Date(now - 24 * 60 * 60 * 1000)), dateFolderName(new Date(now))],
    doLab: only !== 'summary',
    doSummary: only !== 'lab',
  };
}

async function regenerateLab(p, date) {
  const result = await generatePatientPdfWithRetries(
    {
      ipNo: p.ipNo,
      regNo: p.regNo,
      admissionDate: p.admissionDate,
      dischargeDate: p.dischargeDate,
      hospital: config.hospital,
      date,
      physicianName: p.doctor,
    },
    3,
    5_000,
  );
  if (!result.ok) return { ok: false, error: result.error };
  await saveLabResults(date, p, result.results);
  return { ok: true, update: { dateCount: result.dateCount, reqNos: result.reqNos || [], labUpdatedAt: new Date() } };
}

async function regenerateSummary(p, date) {
  let lastError;
  for (let attempt = 1; attempt <= SUMMARY_ATTEMPTS; attempt++) {
    try {
      // A summary that had patient data is kept as-is if the EMR now returns
      // none (a transient EMR problem shouldn't blank a good PDF).
      const result = await generateDischargeSummaryPdf({
        ipNo: p.ipNo,
        date,
        hospital: config.hospital,
        keepExistingOnNoData: !p.summaryDataMissing,
      });
      if (result.ok) {
        return {
          ok: true,
          dataMissing: Boolean(result.dataMissing),
          update: {
            hasSummary: true,
            summaryDataMissing: Boolean(result.dataMissing),
            summaryApprovedBy: result.approvedBy || '',
            summaryUpdatedAt: new Date(),
          },
        };
      }
      lastError = result.error;
    } catch (error) {
      lastError = error.message;
    }
    if (attempt < SUMMARY_ATTEMPTS) await new Promise((r) => setTimeout(r, 3_000));
  }
  return { ok: false, error: lastError };
}

async function regenerateDate(date, { doLab, doSummary }, collection) {
  const seen = new Set();
  const patients = (await loadReportIndex(date)).filter((p) => p.ipNo && !seen.has(p.ipNo) && seen.add(p.ipNo));
  const tally = { patients: patients.length, lab: 0, summary: 0, failed: [], dataMissing: [] };
  console.log(`\n[regenerate] ${date}: ${patients.length} patient(s) on record`);
  if (!patients.length) return tally;

  let next = 0;
  async function worker() {
    while (next < patients.length) {
      const i = next++;
      const p = patients[i];
      const tag = `[${date} ${i + 1}/${patients.length}] ${p.ipNo} (${p.name || 'Unknown'})`;
      const done = [];

      // dateCount is only recorded once a lab report exists; hasSummary likewise.
      if (doLab && p.dateCount !== undefined) {
        const r = await regenerateLab(p, date);
        if (r.ok) {
          tally.lab += 1;
          done.push('lab report');
          await collection.updateOne({ date, ipNo: p.ipNo }, { $set: r.update });
        } else {
          tally.failed.push({ ipNo: p.ipNo, document: 'lab report', error: r.error });
          console.error(`${tag}: lab report FAILED (old PDF kept): ${r.error}`);
        }
      }

      if (doSummary && p.hasSummary) {
        const r = await regenerateSummary(p, date);
        if (r.ok) {
          tally.summary += 1;
          done.push('discharge summary');
          if (r.dataMissing) tally.dataMissing.push(p.ipNo);
          await collection.updateOne({ date, ipNo: p.ipNo }, { $set: r.update });
        } else {
          tally.failed.push({ ipNo: p.ipNo, document: 'discharge summary', error: r.error });
          console.error(`${tag}: discharge summary FAILED (old PDF kept): ${r.error}`);
        }
      }

      console.log(`${tag}: ${done.length ? `regenerated ${done.join(' + ')}` : 'nothing to regenerate'}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return tally;
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  const what = [opts.doLab && 'lab reports', opts.doSummary && 'discharge summaries'].filter(Boolean).join(' + ');
  console.log(`[regenerate] Re-rendering ${what} for: ${opts.dates.join(', ')}`);

  const collection = await getMongoCollection('discharge_reports');
  const startedAt = Date.now();
  const results = [];
  for (const date of opts.dates) {
    results.push([date, await regenerateDate(date, opts, collection)]);
  }

  console.log('\n========================================');
  let failures = 0;
  for (const [date, t] of results) {
    console.log(`${date}: ${t.patients} patients — ${t.lab} lab reports, ${t.summary} summaries regenerated, ${t.failed.length} failed`);
    if (t.dataMissing.length) console.log(`  summaries with no EMR patient data (check these): ${t.dataMissing.join(', ')}`);
    for (const f of t.failed) console.log(`  FAILED ${f.ipNo} ${f.document}: ${f.error}`);
    failures += t.failed.length;
  }
  console.log(`Done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  console.log('========================================');
  process.exit(failures ? 1 : 0);
}

run().catch((error) => {
  console.error('[regenerate] Fatal error:', error.message);
  process.exit(1);
});
