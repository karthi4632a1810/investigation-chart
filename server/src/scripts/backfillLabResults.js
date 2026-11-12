/**
 * Fills the Lab Finder's search data (`lab_results`) for OP report dates whose
 * reports were generated before values were stored. Re-reads each patient's
 * approved results from the EMR with the same search as the OP lab report;
 * PDFs are not touched and nothing is sent.
 *
 * Patients that already have stored values are skipped unless --force.
 *
 *   docker exec op-lab-backend node src/scripts/backfillLabResults.js 2026-09-01 2026-09-28
 *   docker exec op-lab-backend node src/scripts/backfillLabResults.js 2026-09-27        # one date
 *   docker exec op-lab-backend node src/scripts/backfillLabResults.js --all             # every date on record
 */
import { fetchPatientChart, flattenChartResults } from '../services/investigationPdfService.js';
import { listReportDates, loadReportIndex } from '../services/opReportService.js';
import { getMongoCollection } from '../services/mongo.js';
import { saveLabResults } from '../services/labResultsService.js';

const CONCURRENCY = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function resolveDates(args) {
  const recorded = (await listReportDates()).slice().sort();
  if (args.includes('--all')) return recorded;
  const given = args.filter((a) => DATE_RE.test(a));
  if (!given.length) throw new Error('Give a date, a from/to range (YYYY-MM-DD YYYY-MM-DD) or --all');
  if (given.length === 1) return [given[0]];
  const [from, to] = [given[0], given[1]].sort();
  return recorded.filter((d) => d >= from && d <= to);
}

async function run() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dates = await resolveDates(args);
  console.log(`[backfill] Storing OP lab values for ${dates.length} date(s): ${dates.join(', ') || '—'}`);

  const labResults = await getMongoCollection('lab_results');
  let stored = 0;
  let skipped = 0;
  const failed = [];

  for (const date of dates) {
    const already = new Set(force ? [] : await labResults.distinct('regNo', { reportDate: date }));
    const seen = new Set();
    const patients = (await loadReportIndex(date)).filter(
      (p) => p.regNo && (p.reportStatus === 'ready' || p.dateCount !== undefined) && !seen.has(p.regNo) && seen.add(p.regNo),
    );
    const todo = patients.filter((p) => !already.has(p.regNo));
    skipped += patients.length - todo.length;
    console.log(`\n[backfill] ${date}: ${patients.length} ready OP reports, ${todo.length} to fetch`);

    let next = 0;
    async function worker() {
      while (next < todo.length) {
        const p = todo[next++];
        let result;
        for (let attempt = 1; attempt <= 3; attempt++) {
          result = await fetchPatientChart({ regNo: p.regNo, date }).catch((error) => ({ ok: false, error: error.message }));
          if (result.ok || result.reason === 'NO_DATA') break;
          await new Promise((r) => setTimeout(r, 3_000));
        }
        if (result.ok) {
          const rows = flattenChartResults(result.chart);
          await saveLabResults(date, p, rows);
          stored += 1;
          console.log(`[${date}] ${p.regNo}: ${rows.length} values stored`);
        } else {
          failed.push({ date, regNo: p.regNo, error: result.error });
          console.error(`[${date}] ${p.regNo}: FAILED ${result.error}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  console.log('\n========================================');
  console.log(`Patients stored: ${stored}, already had values: ${skipped}, failed: ${failed.length}`);
  for (const f of failed) console.log(`  FAILED ${f.date} ${f.regNo}: ${f.error}`);
  console.log('========================================');
  process.exit(failed.length ? 1 : 0);
}

run().catch((error) => {
  console.error('[backfill] Fatal error:', error.message);
  process.exit(1);
});
