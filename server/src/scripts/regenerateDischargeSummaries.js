/**
 * CLI script to regenerate discharge summaries with the updated UI design.
 * Updates MinIO storage (<date>/<ipNo>-summary.pdf) for all patients on the specified date.
 *
 * Usage inside Docker container:
 *   node src/scripts/regenerateDischargeSummaries.js [YYYY-MM-DD]
 *
 * Example:
 *   docker exec investigation-backend node src/scripts/regenerateDischargeSummaries.js 2026-09-22
 */
import { config } from '../config.js';
import { loadReportIndex } from '../services/dischargeReportService.js';
import { generateDischargeSummaryPdf } from '../services/dischargeSummaryService.js';
import { getMongoCollection } from '../services/mongo.js';

function getYesterdayYMD() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function run() {
  const targetDate = process.argv[2]?.trim() || getYesterdayYMD();
  console.log(`[regenerate] Starting discharge summary regeneration for date: ${targetDate}`);

  let patients;
  try {
    patients = await loadReportIndex(targetDate);
  } catch (err) {
    console.error(`[regenerate] Failed to load report index for ${targetDate}:`, err.message);
    process.exit(1);
  }

  if (!patients || patients.length === 0) {
    console.log(`[regenerate] No patients found in database for date ${targetDate}`);
    process.exit(0);
  }

  // Deduplicate by IP number
  const uniquePatients = [];
  const seenIps = new Set();
  for (const p of patients) {
    if (p.ipNo && !seenIps.has(p.ipNo)) {
      seenIps.add(p.ipNo);
      uniquePatients.push(p);
    }
  }

  const total = uniquePatients.length;
  console.log(`[regenerate] Found ${total} unique patient(s) for ${targetDate}. Beginning processing...`);

  const collection = await getMongoCollection('discharge_reports');

  let successCount = 0;
  let failCount = 0;
  let dataMissingCount = 0;
  const failedIps = [];
  const dataMissingIps = [];

  // Concurrency limit of 2 to balance throughput and server resources
  const CONCURRENCY = 2;
  let index = 0;

  async function worker(workerId) {
    while (index < total) {
      const currentIndex = index++;
      const patient = uniquePatients[currentIndex];
      const { ipNo, name } = patient;
      const progressPrefix = `[${currentIndex + 1}/${total}] [Worker ${workerId}] ${ipNo} (${name || 'Unknown'})`;
      const t0 = Date.now();

      const maxAttempts = 3;
      let lastErr = null;
      let success = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (attempt > 1) {
            console.log(`${progressPrefix}: Retrying (attempt ${attempt}/${maxAttempts})...`);
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            console.log(`${progressPrefix}: Generating summary...`);
          }

          const result = await generateDischargeSummaryPdf({
            ipNo,
            date: targetDate,
            hospital: config.hospital,
            // Don't replace a summary that had patient data with a blank one
            // when the EMR momentarily returns nothing.
            keepExistingOnNoData: !patient.summaryDataMissing,
          });

          const elapsedMs = Date.now() - t0;
          if (result.ok) {
            successCount++;
            success = true;
            const dataMissingNote = result.dataMissing ? ' [DATA MISSING]' : '';
            if (result.dataMissing) {
              dataMissingCount++;
              dataMissingIps.push(ipNo);
            }
            console.log(`${progressPrefix}: SUCCESS in ${elapsedMs}ms -> ${result.objectKey}${dataMissingNote}`);
            await collection.updateOne(
              { date: targetDate, ipNo },
              { $set: { hasSummary: true, summaryDataMissing: Boolean(result.dataMissing), summaryApprovedBy: result.approvedBy || '', summaryUpdatedAt: new Date() } }
            ).catch(() => {});
            break;
          } else {
            lastErr = result.error;
          }
        } catch (err) {
          lastErr = err.message;
        }
      }

      if (!success) {
        const elapsedMs = Date.now() - t0;
        failCount++;
        failedIps.push({ ipNo, error: lastErr });
        console.error(`${progressPrefix}: FAILED after ${maxAttempts} attempts in ${elapsedMs}ms: ${lastErr}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log('\n========================================');
  console.log(`[regenerate] Finished for date: ${targetDate}`);
  console.log(`Total: ${total}`);
  console.log(`Success: ${successCount}`);
  console.log(`Data missing (EMR returned no patient data): ${dataMissingCount}`);
  console.log(`Failed: ${failCount}`);
  if (dataMissingIps.length > 0) {
    console.log('Data-missing IPs:', JSON.stringify(dataMissingIps, null, 2));
  }
  if (failedIps.length > 0) {
    console.log('Failed IPs:', JSON.stringify(failedIps, null, 2));
  }
  console.log('========================================\n');
  process.exit(failCount > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('[regenerate] Fatal error:', err);
  process.exit(1);
});
