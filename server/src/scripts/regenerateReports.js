/**
 * Re-renders already-generated OP lab report PDFs so past dates pick up the
 * current PDF design. New reports need nothing: the scheduler always renders
 * with the current design.
 *
 * Works from the ready OP reports already recorded in Mongo (`op_reports`) and
 * only redoes reports that are already `ready`; it never sends WhatsApp
 * messages. Each PDF is overwritten in place in MinIO so links keep working.
 *
 * Inside the backend container:
 *   docker exec op-lab-backend node src/scripts/regenerateReports.js             # yesterday + today
 *   docker exec op-lab-backend node src/scripts/regenerateReports.js 2026-09-27  # one or more dates
 */
import { config } from '../config.js';
import { loadSettings } from '../services/appSettingsService.js';
import { currentPdfMode } from '../services/investigationPdfService.js';
import {
  dateFolderName,
  generatePatientPdfWithRetries,
  loadReportIndex,
} from '../services/opReportService.js';
import { getMongoCollection } from '../services/mongo.js';
import { saveLabResults } from '../services/labResultsService.js';

const CONCURRENCY = 2; // each worker drives its own Chrome; 2 keeps the server responsive

function parseArgs(argv) {
  const dates = argv.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const bad = argv.filter((a) => !dates.includes(a));
  if (bad.length) throw new Error(`Unrecognised argument(s): ${bad.join(' ')} — dates must be YYYY-MM-DD`);

  const now = Date.now();
  return {
    dates: dates.length ? dates : [dateFolderName(new Date(now - 24 * 60 * 60 * 1000)), dateFolderName(new Date(now))],
  };
}

async function regenerateLab(p, date) {
  const result = await generatePatientPdfWithRetries(
    {
      regNo: p.regNo,
      date,
      hospital: config.hospital,
      physicianName: p.doctor,
      department: p.department,
      visitType: p.visitType,
      tokenNo: p.tokenNo,
    },
    3,
    5_000,
  );
  if (!result.ok) return { ok: false, error: result.error };
  await saveLabResults(date, p, result.results);
  return {
    ok: true,
    update: {
      dateCount: result.dateCount,
      pdfMode: result.pdfMode || currentPdfMode(),
      reqNos: result.reqNos || [],
      updatedAt: new Date(),
    },
  };
}

async function regenerateDate(date, collection) {
  const seen = new Set();
  const patients = (await loadReportIndex(date)).filter((p) => p.regNo && !seen.has(p.regNo) && seen.add(p.regNo));
  const tally = { patients: patients.length, lab: 0, skipped: 0, failed: [] };
  console.log(`\n[regenerate] ${date}: ${patients.length} OP patient(s) on record`);
  if (!patients.length) return tally;

  let next = 0;
  async function worker() {
    while (next < patients.length) {
      const i = next++;
      const p = patients[i];
      const tag = `[${date} ${i + 1}/${patients.length}] ${p.regNo} (${p.name || 'Unknown'})`;

      if (p.reportStatus !== 'ready' && p.dateCount === undefined) {
        tally.skipped += 1;
        console.log(`${tag}: skipped (status: ${p.reportStatus || 'pending'})`);
        continue;
      }

      const r = await regenerateLab(p, date);
      if (r.ok) {
        tally.lab += 1;
        await collection.updateOne({ date, regNo: p.regNo }, { $set: r.update });
        console.log(`${tag}: regenerated lab report`);
      } else {
        tally.failed.push({ regNo: p.regNo, error: r.error });
        console.error(`${tag}: lab report FAILED (old PDF kept): ${r.error}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return tally;
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  await loadSettings();
  console.log(`[regenerate] Re-rendering OP lab reports for: ${opts.dates.join(', ')}`);

  const collection = await getMongoCollection('op_reports');
  const startedAt = Date.now();
  const results = [];
  for (const date of opts.dates) {
    results.push([date, await regenerateDate(date, collection)]);
  }

  console.log('\n========================================');
  let failures = 0;
  for (const [date, t] of results) {
    console.log(`${date}: ${t.patients} patients — ${t.lab} regenerated, ${t.skipped} skipped, ${t.failed.length} failed`);
    for (const f of t.failed) console.log(`  FAILED ${f.regNo}: ${f.error}`);
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
