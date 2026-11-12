/**
 * Orchestrates periodic checks of the EMR for Outpatient (OP) lab orders and
 * registration details, tracks per-patient order approval status, generates the
 * OP Investigation Report PDF once ALL active (non-cancelled) lab orders for a
 * patient on that date are RESULT APPROVED, stores metadata in MongoDB
 * (`op_reports`), and auto-sends via WhatsApp in Live Mode.
 */
import { config } from '../config.js';
import { onSettingsChange, setting } from './appSettingsService.js';
import {
  extractPatientMeta,
  fetchOpLabOrders,
  fetchOpVisits,
  parseAgeGender,
  resolveOriginalEmrPdfUrls,
  toEmrMdy,
} from './emrService.js';
import { currentPdfMode, generatePatientPdf } from './investigationPdfService.js';
import { pdfExists, reportObjectKey, getPdfPresignedUrl } from './storageService.js';
import { getMongoCollection } from './mongo.js';
import { getWatiSettings } from './watiSettingsService.js';
import { sendInvestigationReportWhatsApp, documentLine, toWatiNumber } from './watiService.js';
import { watiPausedUntil } from './watiBudget.js';
import { RATE_LIMITED } from './whatsappLogService.js';
import { hasPublicMinioEndpoint, PUBLIC_BASE_URL, whatsappFileName, whatsappPdfUrl } from './publicLinkService.js';
import { saveLabResults } from './labResultsService.js';
import { extractOrderIdFromCell } from '../utils/htmlParser.js';
import { matchPatient, patientSearchFilter } from './patientSearchService.js';

const REPORTS_COLLECTION = 'op_reports';
const WA_LOG_COLLECTION = 'whatsapp_messages';
const CONCURRENCY = 2;

let schedulerStarted = false;
let checkInProgress = false;
let lastCheckStartedAt = null;
let lastCheckFinishedAt = null;
let lastSummary = null;
let nextCheckAt = null;

export function getSchedulerStatus() {
  return {
    checkInProgress,
    lastCheckStartedAt,
    lastCheckFinishedAt,
    lastSummary,
    nextCheckAt,
    paused: !setting('opReports.autoCheck'),
    everyMinutes: setting('opReports.checkMinutes'),
  };
}

/** IST YYYY-MM-DD folder name (consistent across container TZ). */
export function dateFolderName(date = new Date()) {
  const ist = new Date(date.getTime() + 330 * 60_000);
  return ist.toISOString().slice(0, 10);
}

function recentPastDateFolders(todayStr, daysBack = 2) {
  const [y, m, d] = todayStr.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  const out = [];
  for (let i = 1; i <= daysBack; i++) {
    out.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits;
}

const PRIVATE_EMR_KEYS = new Set(['DISCHARGE DATE', 'DISCHARGE TIME', 'DISCHARGE TYPE', 'IP NO', 'WARD', 'BED NO']);

/** Captures every useful field from an EMR OP visit row for Mongo storage and search. */
export function emrDetails(row = {}) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (PRIVATE_EMR_KEYS.has(k.toUpperCase())) continue;
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (!s || /^_+$/.test(s)) continue;
    out[k] = s;
  }
  return out;
}

let indexesEnsured = false;
async function reportsCollection() {
  const col = await getMongoCollection(REPORTS_COLLECTION);
  if (!indexesEnsured) {
    indexesEnsured = true;
    await Promise.all([
      col.createIndex({ date: 1, regNo: 1 }, { unique: true }),
      col.createIndex({ date: -1, updatedAt: -1 }),
      col.createIndex({ regNo: 1, date: -1 }),
      col.createIndex({ reportStatus: 1, date: -1 }),
    ]).catch(() => {
      indexesEnsured = false;
    });
  }
  return col;
}

export async function getReportRecord(dateFolder, regNo) {
  const col = await reportsCollection();
  return col.findOne({ date: dateFolder, regNo: String(regNo || '').trim() });
}

export async function findOpByRegNo(regNo, dateFolder = null) {
  const clean = String(regNo || '').trim();
  if (!clean) return null;
  const col = await reportsCollection();
  if (dateFolder) {
    return col.findOne({ date: dateFolder, regNo: clean });
  }
  return col.find({ regNo: clean }).sort({ date: -1 }).limit(1).next();
}

export async function loadReportIndex(dateFolder) {
  const col = await reportsCollection();
  return col
    .find({ date: dateFolder })
    .sort({ tokenNo: 1, name: 1, regNo: 1 })
    .toArray();
}

function escapeRegex(value) {
  const escaped = String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $regex: escaped, $options: 'i' };
}

export async function searchReports(filters = {}) {
  const col = await reportsCollection();
  const and = [];
  const addText = (field, value) => {
    if (value && String(value).trim()) and.push({ [field]: escapeRegex(value) });
  };

  if (filters.dateFrom || filters.dateTo) {
    const range = {};
    if (filters.dateFrom) range.$gte = filters.dateFrom;
    if (filters.dateTo) range.$lte = filters.dateTo;
    and.push({ date: range });
  } else if (filters.date) {
    and.push({ date: filters.date });
  }

  addText('regNo', filters.regNo || filters.uhid);
  addText('name', filters.name);
  addText('mobile', filters.mobile);
  addText('whatsappNo', filters.whatsapp);
  addText('department', filters.department);
  addText('doctor', filters.doctor);
  addText('visitType', filters.visitType);
  addText('patientType', filters.patientType);
  addText('tokenNo', filters.tokenNo);
  addText('reqNos', filters.reqNo);
  addText('billNos', filters.billNo);
  addText('createdUser', filters.createdUser);
  if (filters.reportStatus) and.push({ reportStatus: filters.reportStatus });

  const freeText = String(filters.any || '').trim();
  const freeFilter = freeText ? patientSearchFilter(freeText) : null;
  if (freeText && !freeFilter) return [];
  if (freeFilter) and.push(freeFilter);

  const query = and.length === 0 ? {} : and.length === 1 ? and[0] : { $and: and };
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  const fetchLimit = freeText ? Math.max(limit, 500) : limit;
  const docs = await col.find(query).sort({ date: -1, updatedAt: -1 }).limit(fetchLimit).toArray();
  if (!freeText) return docs;
  return docs
    .map((d) => ({ ...d, _match: matchPatient(d, freeText) }))
    .filter((d) => d._match)
    .sort((a, b) => b._match.score - a._match.score || String(b.date).localeCompare(String(a.date)))
    .map(({ _match, ...d }) => ({ ...d, matchedOn: _match.on }))
    .slice(0, limit);
}

export async function upsertReportRecord(dateFolder, entry) {
  const regNo = String(entry?.regNo || '').trim();
  if (!regNo) throw new Error('regNo is required');
  const col = await reportsCollection();
  const now = new Date();
  await col.updateOne(
    { date: dateFolder, regNo },
    {
      $set: { ...entry, date: dateFolder, regNo, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

export async function generatePatientPdfWithRetries(args, attempts = 3, delayMs = 15_000) {
  let lastResult;
  for (let i = 1; i <= attempts; i++) {
    lastResult = await generatePatientPdf(args);
    if (lastResult.ok || lastResult.reason !== 'TECHNICAL' || i === attempts) {
      return lastResult;
    }
    console.warn(`[op-reports] ${args.regNo}: attempt ${i}/${attempts} failed (${lastResult.error}), retrying in ${delayMs / 1000}s`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return lastResult;
}

/** OP only sends the OP Lab Report PDF over WhatsApp. */
export const WHATSAPP_DOCUMENTS = [
  { kind: 'lab', label: 'Lab Report', objectKey: reportObjectKey },
];

/**
 * Ensures the cached MinIO PDF for a ready OP patient matches the current
 * `opReports.usePdfTemplate` setting (`'emr'` vs `'template'`), regenerating
 * that single patient on-demand if an admin just toggled the setting.
 */
export async function ensureReportPdfForMode(dateFolder, regNo, existingRecord = null) {
  const desiredMode = currentPdfMode();
  const record = existingRecord || (await getReportRecord(dateFolder, regNo));
  if (!record || record.reportStatus !== 'ready') return { ok: false, record };

  const key = reportObjectKey(dateFolder, regNo);
  if (record.pdfMode === desiredMode && (await pdfExists(key))) {
    return { ok: true, record };
  }

  const [ordersRes, visitRow] = await Promise.all([
    fetchOpLabOrders({ date: dateFolder, regNo }),
    fetchOpVisitForRegNo(dateFolder, regNo).catch(() => null),
  ]);
  if (!ordersRes.ok || !ordersRes.data?.length) return { ok: false, record };

  const info = summarizeOpPatient(regNo, ordersRes.data, visitRow);
  if (!info.allApproved) return { ok: false, record };

  const res = await generatePatientPdfWithRetries({
    regNo,
    date: dateFolder,
    rows: info.activeRows,
    hospital: config.hospital,
    physicianName: info.recordFields.doctor || record.doctor,
    department: info.recordFields.department || record.department,
    visitType: info.recordFields.visitType || record.visitType,
    tokenNo: info.recordFields.tokenNo || record.tokenNo,
    usePdfTemplate: desiredMode === 'template',
  });
  if (!res.ok) return { ok: false, record, error: res.error };

  const updated = {
    ...info.recordFields,
    totalOrders: info.totalOrders,
    approvedOrders: info.approvedOrders,
    pendingOrders: info.pendingOrders,
    pendingStatuses: info.pendingStatuses,
    reportStatus: 'ready',
    pdfMode: res.pdfMode || desiredMode,
    dateCount: res.dateCount,
    fetchErrors: res.fetchErrors || [],
    reqNos: res.reqNos?.length ? res.reqNos : info.recordFields.reqNos,
    emrPdfUrls: res.emrPdfUrls || [],
    objectKey: res.objectKey,
    generatedSig: info.orderSig,
    generatedAt: new Date(),
    error: null,
  };
  await upsertReportRecord(dateFolder, updated);
  await saveLabResults(dateFolder, updated, res.results).catch(() => {});
  return { ok: true, regenerated: true, record: updated };
}

/**
 * Returns the full OP patient card record including per-test approval statuses.
 * Fetches live from the EMR when `tests` has not been stored yet or `refresh` is true.
 */
export async function getReportDetails(dateFolder, regNo, { refresh = false } = {}) {
  const cleanReg = String(regNo || '').trim();
  const record = await getReportRecord(dateFolder, cleanReg);
  const needsFetch = refresh || !record || !Array.isArray(record.tests);
  if (!needsFetch) return { patient: record, source: 'cache' };

  const [ordersRes, visitRow] = await Promise.all([
    fetchOpLabOrders({ date: dateFolder, regNo: cleanReg }),
    fetchOpVisitForRegNo(dateFolder, cleanReg).catch(() => null),
  ]);

  if (!ordersRes.ok || !ordersRes.data?.length) {
    if (!record) return null;
    return {
      patient: record,
      source: 'cache',
      refreshWarning: ordersRes.ok ? 'No active EMR lab rows returned' : ordersRes.error,
    };
  }

  const info = summarizeOpPatient(cleanReg, ordersRes.data, visitRow);
  const patch = {
    ...info.recordFields,
    totalOrders: info.totalOrders,
    approvedOrders: info.approvedOrders,
    pendingOrders: info.pendingOrders,
    pendingStatuses: info.pendingStatuses,
    reportStatus: record?.reportStatus || (info.allApproved ? 'pending' : 'pending'),
  };
  await upsertReportRecord(dateFolder, patch);
  const latest = await getReportRecord(dateFolder, cleanReg);
  return { patient: latest || { ...record, ...patch }, source: 'emr' };
}

/**
 * Picks the PDF URL(s) handed to WATI for an OP lab report:
 * - Whenever `PUBLIC_BASE_URL` or a non-loopback `MINIO_PUBLIC_ENDPOINT` is
 *   configured (VPS), always serves the MinIO-saved PDF via `whatsappPdfUrl`.
 * - Only on local dev (`!PUBLIC_BASE_URL && !hasPublicMinioEndpoint()`) in
 *   original EMR mode, falls back to direct HTTPS EMR URLs because WATI
 *   cannot reach `localhost` MinIO.
 */
export async function resolveWhatsappReportUrls(
  dateFolder,
  regNo,
  { record = null, objectKey = reportObjectKey(dateFolder, regNo), fileName = whatsappFileName('Lab Report', regNo) } = {},
) {
  const rec = record || (await getReportRecord(dateFolder, regNo));
  if (!PUBLIC_BASE_URL && !hasPublicMinioEndpoint() && (rec?.pdfMode || currentPdfMode()) === 'emr') {
    let emrUrls = Array.isArray(rec?.emrPdfUrls) ? rec.emrPdfUrls.filter(Boolean) : [];
    if (!emrUrls.length && rec?.reqNos?.length) {
      emrUrls = await resolveOriginalEmrPdfUrls(rec.reqNos).catch(() => []);
      if (emrUrls.length) await upsertReportRecord(dateFolder, { regNo, emrPdfUrls: emrUrls }).catch(() => {});
    }
    if (emrUrls.length) {
      return emrUrls;
    }
  }
  return [await whatsappPdfUrl(objectKey, fileName)];
}

export async function sendReportsWhatsApp({ dateFolder, regNo, toNumber, name, note, template, log }) {
  const result = { sent: [], missing: [], failed: [] };
  const doc = WHATSAPP_DOCUMENTS[0];
  const key = doc.objectKey(dateFolder, regNo);
  try {
    const ensured = await ensureReportPdfForMode(dateFolder, regNo).catch(() => null);
    if (!(await pdfExists(key))) {
      result.missing.push({ kind: doc.kind, label: doc.label });
      return result;
    }
    const activeTemplate = template || (await getWatiSettings()).labReportTemplate;
    const pdfUrls = await resolveWhatsappReportUrls(dateFolder, regNo, {
      record: ensured?.record || null,
      objectKey: key,
      fileName: whatsappFileName(doc.label, regNo),
    });
    for (const pdfUrl of pdfUrls) {
      await sendInvestigationReportWhatsApp({
        toNumber,
        name,
        note: documentLine(doc.label, note),
        pdfUrl,
        template: activeTemplate,
        log: log && {
          ...log,
          document: doc.kind,
          documentLabel: doc.label,
          reportDate: dateFolder,
          regNo,
        },
      });
    }
    result.sent.push({ kind: doc.kind, label: doc.label });
  } catch (error) {
    result.failed.push({ kind: doc.kind, label: doc.label, error: error.message });
  }
  return result;
}

const bulkSendingDates = new Set();

function isValidTargetMobile(mobile) {
  const digits = toWatiNumber(mobile);
  return digits.length >= 11 && digits.length <= 15;
}

/**
 * Returns ready OP reports for `dateFolder` that have a valid mobile number
 * and have not yet had a Live Mode WhatsApp attempt logged.
 */
export async function listUnsentReadyReports(dateFolder) {
  const reportsCol = await getMongoCollection(REPORTS_COLLECTION);
  const waCol = await getMongoCollection(WA_LOG_COLLECTION);
  const [readyDocs, sentRegNos] = await Promise.all([
    reportsCol
      .find(
        { date: dateFolder, reportStatus: 'ready', mobile: { $type: 'string', $ne: '' } },
        { projection: { _id: 0, date: 1, regNo: 1, name: 1, mobile: 1, department: 1 } },
      )
      .sort({ name: 1 })
      .toArray(),
    waCol.distinct('regNo', { reportDate: dateFolder, regNo: { $ne: null }, liveMode: true }),
  ]);
  const sentSet = new Set(sentRegNos.map((r) => String(r)));
  return readyDocs.filter((r) => !sentSet.has(String(r.regNo)) && isValidTargetMobile(r.mobile));
}

/**
 * Catch-up bulk send for ready reports on `dateFolder` that missed Live auto-send
 * (for example, reports generated while Test mode was active).
 */
export async function sendUnsentReportsWhatsApp(dateFolder, { triggeredBy = 'staff', concurrency = 4 } = {}) {
  if (setting('maintenance.readOnly')) throw new Error('System is in read-only mode');
  const settings = await getWatiSettings();
  if (!settings.liveEnabled) {
    throw new Error('Turn on Live mode in WATI Settings before sending to patients');
  }
  if (bulkSendingDates.has(dateFolder)) {
    throw new Error('A bulk send is already running for this date');
  }

  bulkSendingDates.add(dateFolder);
  try {
    const reportsCol = await getMongoCollection(REPORTS_COLLECTION);
    const targets = await listUnsentReadyReports(dateFolder);
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let stoppedReason = '';
    let cursor = 0;

    async function worker() {
      while (cursor < targets.length && !stoppedReason) {
        if (watiPausedUntil()) {
          stoppedReason = 'WATI API usage limit reached — remaining reports can be sent later';
          break;
        }
        const rec = targets[cursor++];
        const key = reportObjectKey(dateFolder, rec.regNo);
        if (!(await pdfExists(key).catch(() => false))) {
          skipped += 1;
          continue;
        }
        const waResult = await sendReportsWhatsApp({
          dateFolder,
          regNo: rec.regNo,
          toNumber: rec.mobile,
          name: rec.name || rec.regNo,
          note: settings.secondParam,
          template: settings.labReportTemplate,
          log: {
            trigger: 'manual',
            via: 'bulk',
            triggeredBy,
            patientName: rec.name || '',
            department: rec.department || '',
            liveMode: true,
          },
        });
        if (waResult.sent.length) {
          sent += 1;
          await reportsCol.updateOne(
            { date: dateFolder, regNo: rec.regNo },
            { $set: { whatsappSentAt: new Date(), whatsappStatus: 'sent' } },
          );
        } else if (waResult.failed.length) {
          failed += 1;
          const errMsg = waResult.failed[0].error || 'Send failed';
          await reportsCol.updateOne(
            { date: dateFolder, regNo: rec.regNo },
            { $set: { whatsappStatus: 'failed', whatsappError: errMsg } },
          );
          if (RATE_LIMITED.test(errMsg)) {
            stoppedReason = 'WATI API usage limit reached — remaining reports can be sent later';
            break;
          }
        } else {
          skipped += 1;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(targets.length, 1)) }, worker));
    return { date: dateFolder, total: targets.length, sent, failed, skipped, stoppedReason };
  } finally {
    bulkSendingDates.delete(dateFolder);
  }
}

/** Merges OP lab order rows with front-office visit metadata for a single `regNo`. */
export function summarizeOpPatient(regNo, rawOrderRows, visitRow = null) {
  const activeRows = rawOrderRows.filter(
    (r) => String(r['STATUS'] || '').trim().toUpperCase() !== 'CANCELLED',
  );
  const approvedRows = activeRows.filter(
    (r) => String(r['STATUS'] || '').trim().toUpperCase() === 'RESULT APPROVED',
  );
  const pendingRows = activeRows.filter(
    (r) => String(r['STATUS'] || '').trim().toUpperCase() !== 'RESULT APPROVED',
  );
  const allApproved = activeRows.length > 0 && pendingRows.length === 0;

  const cols = activeRows.length ? Object.keys(activeRows[0]) : [];
  const meta = activeRows.length ? extractPatientMeta(activeRows, cols) : {};
  const firstOrder = activeRows[0] || rawOrderRows[0] || {};
  const ageGender = parseAgeGender(firstOrder['AGE / GENDER']);

  const name = cleanName(visitRow?.NAME || meta.name || firstOrder['PATIENT NAME']);
  const age = String(visitRow?.AGE || meta.age || ageGender.age || '').trim();
  const sex = String(visitRow?.GENDER || meta.sex || ageGender.sex || '').trim();
  const whatsappNo = cleanMobile(visitRow?.['WhatsApp No']);
  const mobile = cleanMobile(whatsappNo || visitRow?.MOBILE || firstOrder['MOBILE'] || meta.mobile);
  const department = String(firstOrder['ORDERING DEPARTMENT'] || visitRow?.DEPARTMENT || visitRow?.UNIT || meta.unit || '').trim();
  const doctor = String(firstOrder['ORDERING DOCTOR'] || visitRow?.DOCTOR || meta.doctor || '').trim();

  const reqSet = new Set();
  const billSet = new Set();
  const procSet = new Set();
  const pendingStatusSet = new Set();
  const tests = [];
  const sigParts = [];

  for (const r of activeRows) {
    const parsedReq = extractOrderIdFromCell(r['REQ NO'] || r['REQUEST NO']);
    const reqId = parsedReq.orderid || parsedReq.label || '';
    if (reqId) reqSet.add(reqId);
    const bill = String(r['BILL NO'] || '').trim();
    if (bill) billSet.add(bill);
    const proc = String(r['PROCEDURE'] || '').replace(/<[^>]+>/g, '').trim();
    if (proc) procSet.add(proc);
    const status = String(r['STATUS'] || '').trim();
    const approved = status.toUpperCase() === 'RESULT APPROVED';
    if (!approved && status) pendingStatusSet.add(status);
    if (proc || reqId) {
      tests.push({
        reqNo: reqId,
        name: proc || `Order ${reqId}`,
        status: status || 'PENDING',
        approved,
        billNo: bill,
        requestDate: String(r['REQUEST DATE'] || '').trim(),
        deptReceiveDate: String(r['DEPT RECEIVE DATE'] || '').trim(),
        completedDate: String(r['COMPLETED DATE'] || '').trim(),
        waitingTat: String(r['WAITING TAT'] || '').trim(),
      });
    }
    sigParts.push(`${reqId}:${status}:${String(r['COMPLETED DATE'] || '').trim()}:${proc}`);
  }
  tests.sort((a, b) => Number(a.approved) - Number(b.approved) || a.name.localeCompare(b.name));
  sigParts.sort();

  const visitFields = {
    regNo,
    name,
    age,
    gender: sex,
    mobile,
    whatsappNo,
    department,
    doctor,
    visitType: String(visitRow?.['VISIT TYPE'] || '').trim(),
    tokenNo: String(visitRow?.['TOKEN NO'] || '').trim(),
    visitDate: String(visitRow?.['VISIT DATE'] || firstOrder['REQUEST DATE'] || '').trim(),
    patientType: String(visitRow?.['PATIENT TYPE'] || firstOrder['PATIENT TYPE'] || '').trim(),
    corporate: String(visitRow?.['CORPORATE'] || '').trim(),
    city: String(visitRow?.['AREA / VILLAGE'] || visitRow?.['City'] || visitRow?.['District'] || '').trim(),
    createdUser: String(visitRow?.['CREATED USER'] || '').trim(),
    billNos: [...billSet],
    reqNos: [...reqSet],
    procedures: [...procSet],
    tests,
    emr: visitRow ? emrDetails(visitRow) : {},
  };

  return {
    regNo,
    activeRows,
    totalOrders: activeRows.length,
    approvedOrders: approvedRows.length,
    pendingOrders: pendingRows.length,
    pendingStatuses: [...pendingStatusSet],
    allApproved,
    orderSig: sigParts.join('|'),
    recordFields: visitFields,
  };
}

/** Checks if a WhatsApp send is already recorded for (date, regNo) to prevent double auto-sending. */
async function hasSentOrQueuedWhatsApp(dateFolder, regNo) {
  const col = await getMongoCollection(WA_LOG_COLLECTION);
  const existing = await col.findOne({
    reportDate: dateFolder,
    regNo,
    status: { $in: ['pending', 'sent', 'delivered', 'read'] },
  });
  return Boolean(existing);
}

/** Fetches today's/target date's OP visits row for one regNo (used when EMR metadata missing). */
export async function fetchOpVisitForRegNo(dateFolder, regNo) {
  const res = await fetchOpVisits(dateFolder, regNo);
  if (!res.ok) return null;
  return res.data.find((r) => String(r['REG NO'] || '').trim() === String(regNo).trim()) || null;
}

/**
 * Processes all OP lab-ordered patients for `dateFolder` (YYYY-MM-DD).
 * - Fetches LabTestResultHistoryQB (@PatCategory = '1', excludes ZPATIENT)
 * - Enriches from Fo_Rpt_OPPatdetailsprint_QB (@IncludingDirectIP = '0', excludes ZPATIENT)
 * - Generates PDF & auto-sends WhatsApp ONLY once all active non-cancelled orders
 *   are RESULT APPROVED. Partial/in-process patients are saved with `reportStatus: 'pending'`.
 */
export async function processOpDate(dateFolder, { force = false } = {}) {
  const startedAt = Date.now();
  const summary = {
    date: dateFolder,
    found: 0,
    ready: 0,
    alreadyReported: 0,
    generated: 0,
    pending: 0,
    noLabData: 0,
    failed: 0,
    whatsappSent: 0,
    whatsappFailed: 0,
  };

  const ordersRes = await fetchOpLabOrders({ date: dateFolder });
  if (!ordersRes.ok) {
    console.error(`[op-reports] failed to fetch OP lab orders for ${dateFolder}: ${ordersRes.error}`);
    return { ...summary, error: ordersRes.error };
  }

  let visitsRes = await fetchOpVisits(dateFolder);
  if (!visitsRes.ok) {
    visitsRes = await fetchOpVisits(dateFolder);
  }
  if (!visitsRes.ok) {
    console.warn(`[op-reports] OP visit lookup warning for ${dateFolder}: ${visitsRes.error}`);
  }

  // Index OP front-office visit records by UHID (`REG NO`).
  const visitsByReg = new Map();
  for (const v of visitsRes.ok ? visitsRes.data : []) {
    const regNo = String(v['REG NO'] ?? v['REG No'] ?? '').trim();
    if (regNo) visitsByReg.set(regNo, v);
  }

  // Group lab order lines by UHID (`REG No`).
  const ordersByReg = new Map();
  for (const row of ordersRes.data) {
    const regNo = String(row['REG No'] ?? row['REG NO'] ?? '').trim();
    if (!regNo) continue;
    let list = ordersByReg.get(regNo);
    if (!list) {
      list = [];
      ordersByReg.set(regNo, list);
    }
    list.push(row);
  }

  const patients = [];
  for (const [regNo, rawOrderRows] of ordersByReg.entries()) {
    const info = summarizeOpPatient(regNo, rawOrderRows, visitsByReg.get(regNo) || null);
    if (info.totalOrders === 0) continue; // skip patients whose orders are all CANCELLED
    patients.push(info);
  }
  summary.found = patients.length;

  const existingDocs = await loadReportIndex(dateFolder);
  const existingByReg = new Map(existingDocs.map((d) => [d.regNo, d]));
  const watiSettings = await getWatiSettings();
  const col = await reportsCollection();

  let cursor = 0;
  async function worker() {
    while (cursor < patients.length) {
      const p = patients[cursor++];
      const existing = existingByReg.get(p.regNo);
      const baseFields = {
        ...p.recordFields,
        totalOrders: p.totalOrders,
        approvedOrders: p.approvedOrders,
        pendingOrders: p.pendingOrders,
        pendingStatuses: p.pendingStatuses,
      };

      // Gate: wait until EVERY non-cancelled order for this date is RESULT APPROVED.
      if (!p.allApproved) {
        summary.pending += 1;
        await upsertReportRecord(dateFolder, {
          ...baseFields,
          reportStatus: 'pending',
        });
        continue;
      }

      const key = reportObjectKey(dateFolder, p.regNo);
      const pdfMode = currentPdfMode();
      let hasPdf = false;
      try {
        hasPdf = await pdfExists(key);
      } catch (error) {
        summary.failed += 1;
        console.error(`[op-reports] ${p.regNo}: failed MinIO check: ${error.message}`);
        continue;
      }

      let generatedNow = false;
      let isReady = false;

      if (!force && existing?.reportStatus === 'ready' && existing?.generatedSig === p.orderSig && existing?.pdfMode === pdfMode && hasPdf) {
        summary.alreadyReported += 1;
        summary.ready += 1;
        isReady = true;
        // Refresh metadata (e.g. mobile/visit fields) if visit arrived or changed cleanly.
        await upsertReportRecord(dateFolder, { ...baseFields, reportStatus: 'ready' });
      } else if (!force && existing?.reportStatus === 'no_data' && existing?.generatedSig === p.orderSig && existing?.pdfMode === pdfMode) {
        summary.noLabData += 1;
        await upsertReportRecord(dateFolder, { ...baseFields, reportStatus: 'no_data' });
      } else {
        try {
          const res = await generatePatientPdfWithRetries({
            regNo: p.regNo,
            date: dateFolder,
            rows: p.activeRows,
            hospital: config.hospital,
            physicianName: p.recordFields.doctor,
            department: p.recordFields.department,
            visitType: p.recordFields.visitType,
            tokenNo: p.recordFields.tokenNo,
            usePdfTemplate: pdfMode === 'template',
          });

          if (!res.ok) {
            if (res.reason === 'NO_DATA') {
              summary.noLabData += 1;
              await upsertReportRecord(dateFolder, {
                ...baseFields,
                reportStatus: 'no_data',
                pdfMode,
                generatedSig: p.orderSig,
                error: res.error,
              });
            } else {
              summary.failed += 1;
              await upsertReportRecord(dateFolder, {
                ...baseFields,
                reportStatus: 'failed',
                error: res.error,
              });
              console.error(`[op-reports] ${p.regNo}: ${res.error}`);
            }
          } else {
            generatedNow = true;
            isReady = true;
            summary.generated += 1;
            summary.ready += 1;
            const fullRecord = {
              ...baseFields,
              reportStatus: 'ready',
              pdfMode: res.pdfMode || pdfMode,
              dateCount: res.dateCount,
              fetchErrors: res.fetchErrors || [],
              reqNos: res.reqNos?.length ? res.reqNos : p.recordFields.reqNos,
              objectKey: res.objectKey,
              generatedSig: p.orderSig,
              generatedAt: new Date(),
              error: null,
            };
            await upsertReportRecord(dateFolder, fullRecord);
            await saveLabResults(dateFolder, fullRecord, res.results).catch((error) => {
              console.warn(`[op-reports] ${p.regNo}: failed saving lab index: ${error.message}`);
            });
          }
        } catch (error) {
          summary.failed += 1;
          await upsertReportRecord(dateFolder, {
            ...baseFields,
            reportStatus: 'failed',
            error: error.message,
          }).catch(() => {});
          console.error(`[op-reports] ${p.regNo}: unexpected error: ${error.message}`);
        }
      }

      // Auto-send WhatsApp once ready, only in Live Mode, when autoSend is on, and not yet sent for (date, regNo).
      if (isReady && generatedNow && watiSettings.liveEnabled && setting('whatsapp.autoSend') && !setting('maintenance.readOnly')) {
        const mobile = p.recordFields.mobile;
        if (mobile && !(await hasSentOrQueuedWhatsApp(dateFolder, p.regNo))) {
          try {
            const waResult = await sendReportsWhatsApp({
              dateFolder,
              regNo: p.regNo,
              toNumber: mobile,
              name: p.recordFields.name || p.regNo,
              note: watiSettings.secondParam,
              template: watiSettings.labReportTemplate,
              log: {
                trigger: 'auto',
                patientName: p.recordFields.name,
                template: watiSettings.labReportTemplate,
                liveMode: true,
              },
            });
            if (waResult.sent.length) {
              summary.whatsappSent += 1;
              await col.updateOne(
                { date: dateFolder, regNo: p.regNo },
                { $set: { whatsappSentAt: new Date(), whatsappStatus: 'sent' } },
              );
            } else if (waResult.failed.length) {
              summary.whatsappFailed += 1;
              await col.updateOne(
                { date: dateFolder, regNo: p.regNo },
                { $set: { whatsappStatus: 'failed', whatsappError: waResult.failed[0].error } },
              );
            }
          } catch (error) {
            summary.whatsappFailed += 1;
            console.error(`[op-reports] ${p.regNo}: auto WhatsApp failed: ${error.message}`);
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `[op-reports] ${dateFolder}: ${summary.found} OP patients — ${summary.generated} generated, ${summary.alreadyReported} cached, ${summary.pending} pending, ${summary.failed} failed (${elapsedSec}s)`,
  );
  return summary;
}

/**
 * Runs a full OP check for Today and also catches up recent past days (up to 2 days)
 * that still have `pending` or `failed` reports (e.g. evening samples approved next morning).
 */
export async function runOpReportCheck() {
  if (checkInProgress) {
    console.log('[op-reports] check already in progress, skipping this tick');
    return { skipped: true };
  }
  checkInProgress = true;
  lastCheckStartedAt = new Date().toISOString();

  try {
    const today = dateFolderName(new Date());
    const col = await reportsCollection();
    const recentDates = recentPastDateFolders(today, 2);
    const pendingPastDates = await col.distinct('date', {
      date: { $in: recentDates },
      reportStatus: { $in: ['pending', 'failed'] },
    });

    for (const d of pendingPastDates.sort()) {
      await processOpDate(d).catch((err) => {
        console.error(`[op-reports] catchup check failed for ${d}: ${err.message}`);
      });
    }

    const summary = await processOpDate(today);
    lastSummary = summary;
    return summary;
  } finally {
    lastCheckFinishedAt = new Date().toISOString();
    checkInProgress = false;
  }
}

/** Manual backfill / refresh for any specific YYYY-MM-DD date. */
export async function runBackfillForDate(dateStr, { force = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { ok: false, error: 'Date must be YYYY-MM-DD' };
  }
  if (checkInProgress) {
    return { skipped: true, reason: 'A check is already in progress, try again shortly' };
  }
  checkInProgress = true;
  try {
    return await processOpDate(dateStr, { force });
  } finally {
    checkInProgress = false;
  }
}

function msUntilNextAlignedTick(intervalMs) {
  const remainder = (Date.now() + 330 * 60_000) % intervalMs;
  return remainder === 0 ? intervalMs : intervalMs - remainder;
}

export function startOpReportScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  function scheduleNext() {
    const intervalMs = Math.max(1, Number(setting('opReports.checkMinutes')) || 15) * 60_000;
    const delay = msUntilNextAlignedTick(intervalMs);
    nextCheckAt = new Date(Date.now() + delay).toISOString();
    setTimeout(async () => {
      try {
        if (setting('opReports.autoCheck') && !setting('maintenance.readOnly')) {
          await runOpReportCheck();
        }
      } catch (error) {
        console.error('[op-reports] scheduled tick error:', error.message);
      } finally {
        scheduleNext();
      }
    }, delay);
  }

  if (setting('opReports.autoCheck') && !setting('maintenance.readOnly')) {
    runOpReportCheck().catch((err) => console.error('[op-reports] initial check failed:', err.message));
  }
  onSettingsChange((changes) => {
    if (changes?.some((c) => c.key === 'opReports.usePdfTemplate')) {
      runOpReportCheck().catch((err) => console.error('[op-reports] template mode refresh failed:', err.message));
    }
  });
  scheduleNext();
}

export async function listReportDates() {
  const col = await reportsCollection();
  const dates = await col.distinct('date');
  return dates.filter(Boolean).sort((a, b) => b.localeCompare(a));
}

export async function getReportPdfUrl(dateFolder, regNo) {
  return getPdfPresignedUrl(reportObjectKey(dateFolder, regNo));
}

export { toEmrMdy };
