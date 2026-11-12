/**
 * Manual CLI: generate one OP patient's Investigation Report PDF for a date,
 * using the same approval gate and EMR lookup as the OP report scheduler
 * (opReportService.js + investigationPdfService.js).
 *
 * Uploads the PDF to MinIO at `<date>/<REG_NO>.pdf` and records its metadata
 * in MongoDB (`op_reports`).
 *
 * Usage (with MONGO_URI / MINIO_* pointing at the running stack):
 *   node --env-file=server/.env scripts/generate-investigation-pdf.js 4625656
 *   node --env-file=server/.env scripts/generate-investigation-pdf.js 4625656 2026-09-07
 *   node --env-file=server/.env scripts/generate-investigation-pdf.js 4625656 2026-09-07 --force
 */
import { config } from '../server/src/config.js';
import { fetchOpLabOrders } from '../server/src/services/emrService.js';
import { generatePatientPdf } from '../server/src/services/investigationPdfService.js';
import { saveLabResults } from '../server/src/services/labResultsService.js';
import {
  dateFolderName,
  fetchOpVisitForRegNo,
  summarizeOpPatient,
  upsertReportRecord,
} from '../server/src/services/opReportService.js';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter((a) => !a.startsWith('--'));
  const regNo = positional[0]?.trim();

  if (!regNo) {
    console.error('Usage: node scripts/generate-investigation-pdf.js <UHID/REG_NO> [date YYYY-MM-DD] [--force]');
    process.exit(1);
  }

  const folderDate = positional[1] || dateFolderName();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(folderDate)) {
    throw new Error(`Invalid date "${folderDate}" — expected YYYY-MM-DD`);
  }

  console.log(`Fetching OP lab orders & visit for UHID ${regNo} on ${folderDate}...`);
  const [ordersRes, visitRow] = await Promise.all([
    fetchOpLabOrders({ date: folderDate, regNo }),
    fetchOpVisitForRegNo(folderDate, regNo),
  ]);
  if (!ordersRes.ok) throw new Error(ordersRes.error || 'Failed to query EMR OP lab orders');
  if (!ordersRes.data.length) throw new Error(`No OP lab orders found for UHID "${regNo}" on ${folderDate}`);

  const summary = summarizeOpPatient(regNo, ordersRes.data, visitRow);
  console.log(
    `Patient: ${summary.recordFields.name || '(name n/a)'} | Orders: ${summary.approvedOrders}/${summary.totalOrders} RESULT APPROVED`,
  );

  if (!summary.allApproved && !force) {
    throw new Error(
      `Orders still pending (${summary.pendingOrders} pending: ${summary.pendingStatuses.join(', ') || 'In Progress'}). Pass --force to render approved orders anyway.`,
    );
  }

  const rowsToRender = force
    ? summary.activeRows.filter((r) => String(r['STATUS'] || '').trim().toUpperCase() === 'RESULT APPROVED')
    : summary.activeRows;

  const result = await generatePatientPdf({
    regNo,
    date: folderDate,
    rows: rowsToRender.length ? rowsToRender : null,
    hospital: config.hospital,
    physicianName: summary.recordFields.doctor,
    department: summary.recordFields.department,
    visitType: summary.recordFields.visitType,
    tokenNo: summary.recordFields.tokenNo,
  });
  if (!result.ok) throw new Error(result.error);

  console.log(`Chart built: ${result.dateCount} date(s) of results.`);
  if (result.fetchErrors?.length) {
    console.log(`Note: ${result.fetchErrors.length} fetch warning(s):`, result.fetchErrors);
  }
  console.log(`Uploaded to MinIO: ${result.objectKey}`);

  const fullRecord = {
    ...summary.recordFields,
    totalOrders: summary.totalOrders,
    approvedOrders: summary.approvedOrders,
    pendingOrders: summary.pendingOrders,
    pendingStatuses: summary.pendingStatuses,
    reportStatus: 'ready',
    dateCount: result.dateCount,
    fetchErrors: result.fetchErrors || [],
    reqNos: result.reqNos?.length ? result.reqNos : summary.recordFields.reqNos,
    objectKey: result.objectKey,
    generatedSig: summary.orderSig,
    generatedAt: new Date(),
    error: null,
  };
  await upsertReportRecord(folderDate, fullRecord);
  await saveLabResults(folderDate, fullRecord, result.results);
  console.log(`Recorded in Mongo (op_reports) & lab_results for ${folderDate}.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Failed to generate OP investigation PDF:', error.message);
  process.exit(1);
});
