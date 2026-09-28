/**
 * Individual lab values, stored one row per test per result date, so they can
 * be searched across patients ("everyone with Urine Glucose Negative between
 * two dates") — the PDFs alone can't be queried.
 *
 * Rows are written whenever a lab report is generated (dischargeReportService.js,
 * regenerateReports.js) and for past dates by scripts/backfillLabResults.js.
 * Each save replaces that patient's rows for that discharge date, so reruns
 * never duplicate.
 */
import { getMongoCollection } from './mongo.js';

const COLLECTION = 'lab_results';
const MAX_ROWS = 5000;

let indexesReady = null;
async function collection() {
  const c = await getMongoCollection(COLLECTION);
  indexesReady ||= Promise.all([
    c.createIndex({ dischargeDate: 1, ipNo: 1 }),
    c.createIndex({ searchText: 1 }),
    c.createIndex({ resultDay: 1 }),
  ]).catch(() => {});
  await indexesReady;
  return c;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every word must appear somewhere in "<section> <test>", in any order. */
function testFilter(test) {
  const words = String(test || '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  return words.length ? { $and: words.map((w) => ({ searchText: { $regex: escapeRegex(w) } })) } : {};
}

/**
 * @param patient discharge_reports record fields (ipNo, regNo, name, …)
 * @param rows    flattenChartResults() output
 */
export async function saveLabResults(dischargeDate, patient, rows) {
  const c = await collection();
  await c.deleteMany({ dischargeDate, ipNo: patient.ipNo });
  if (!rows?.length) return 0;
  const base = {
    dischargeDate,
    ipNo: patient.ipNo,
    regNo: patient.regNo || '',
    name: patient.name || '',
    department: patient.department || '',
    doctor: patient.doctor || '',
    ward: patient.ward || '',
    patientType: patient.patientType || '',
  };
  await c.insertMany(
    rows.map((r) => ({ ...base, ...r, searchText: `${r.section} ${r.test}`.toUpperCase() })),
    { ordered: false },
  );
  return rows.length;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['high', 'low', 'normal', 'abnormal']);

/**
 * Validates and normalises a search from the Lab Finder form or the AI
 * assistant — the one place user/model input becomes a Mongo filter.
 */
export function normaliseQuery(q = {}) {
  const query = {};
  for (const key of ['test', 'value', 'ipNo', 'regNo', 'patient', 'department']) {
    const v = String(q[key] ?? '').trim().slice(0, 80);
    if (v) query[key] = v;
  }
  for (const key of ['from', 'to']) {
    if (DATE_RE.test(String(q[key] || ''))) query[key] = q[key];
  }
  if (STATUSES.has(q.status)) query.status = q.status;
  for (const key of ['min', 'max']) {
    const n = Number(q[key]);
    if (q[key] !== '' && q[key] !== null && q[key] !== undefined && Number.isFinite(n)) query[key] = n;
  }
  query.dateBasis = q.dateBasis === 'result' ? 'result' : 'discharge';
  return query;
}

function buildFilter(q) {
  const filter = { ...testFilter(q.test) };
  if (q.value) filter.value = { $regex: escapeRegex(q.value), $options: 'i' };
  if (q.ipNo) filter.ipNo = { $regex: `^${escapeRegex(q.ipNo)}$`, $options: 'i' };
  if (q.regNo) filter.regNo = q.regNo;
  if (q.patient) filter.name = { $regex: escapeRegex(q.patient), $options: 'i' };
  if (q.department) filter.department = { $regex: escapeRegex(q.department), $options: 'i' };
  if (q.status === 'abnormal') filter.status = { $in: ['high', 'low'] };
  else if (q.status) filter.status = q.status;
  if (q.min !== undefined || q.max !== undefined) {
    filter.numeric = {};
    if (q.min !== undefined) filter.numeric.$gte = q.min;
    if (q.max !== undefined) filter.numeric.$lte = q.max;
  }
  const dateField = q.dateBasis === 'result' ? 'resultDay' : 'dischargeDate';
  if (q.from || q.to) {
    filter[dateField] = {};
    if (q.from) filter[dateField].$gte = q.from;
    if (q.to) filter[dateField].$lte = q.to;
  }
  return filter;
}

/** True when a search has at least one real criterion (not just dates). */
export function hasCriteria(q) {
  return Boolean(q.test || q.value || q.ipNo || q.regNo || q.patient || q.department || q.status || q.min !== undefined || q.max !== undefined);
}

export async function searchLabResults(rawQuery) {
  const query = normaliseQuery(rawQuery);
  const c = await collection();
  const filter = buildFilter(query);
  const docs = await c
    .find(filter, { projection: { _id: 0, searchText: 0 } })
    .sort({ dischargeDate: -1, name: 1, test: 1, resultDay: 1 })
    .limit(MAX_ROWS + 1)
    .toArray();
  const truncated = docs.length > MAX_ROWS;
  const rows = truncated ? docs.slice(0, MAX_ROWS) : docs;
  const matchedTests = [...new Set(rows.map((r) => (r.section ? `${r.section} › ${r.test}` : r.test)))].slice(0, 30);
  return {
    query,
    rows,
    total: rows.length,
    patients: new Set(rows.map((r) => `${r.dischargeDate}|${r.ipNo}`)).size,
    matchedTests,
    truncated,
  };
}

/** Distinct test names matching `q`, with how many results each has. */
export async function listLabTests(q, limit = 25) {
  const c = await collection();
  const docs = await c
    .aggregate([
      { $match: testFilter(q) },
      { $group: { _id: { section: '$section', test: '$test' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ])
    .toArray();
  return docs.map((d) => ({ section: d._id.section, test: d._id.test, count: d.count }));
}

/** Discharge dates that have stored lab values — for the Lab Finder's coverage note. */
export async function labResultsCoverage() {
  const c = await collection();
  const dates = await c.distinct('dischargeDate');
  dates.sort();
  return { from: dates[0] || null, to: dates[dates.length - 1] || null, days: dates.length };
}
