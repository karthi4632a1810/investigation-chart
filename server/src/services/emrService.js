import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { PDFDocument } from 'pdf-lib';
import { config } from '../config.js';
import { normalizeSearchDate } from '../utils/dateUtils.js';
import {
  extractOrderIdFromCell,
  extractResultTable,
  normCol,
  parseResultTableToArray,
} from '../utils/htmlParser.js';
import { normalizeTestKey } from '../templates/chartTemplate.js';
import { sortChartDates } from '../utils/dateUtils.js';

// Without an explicit timeout, axios waits forever on a connection that never
// completes — observed in testing as a login/detail-fetch call hanging for
// minutes with nothing coming back, silently blocking the whole OP check.
const EMR_TIMEOUT_MS = 60_000;

function createClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true, timeout: EMR_TIMEOUT_MS }));
  return client;
}

export async function doLogin(client) {
  const { loginUrl, username, password, logOpt } = config.emr;

  try {
    const { data } = await client.post(
      loginUrl,
      { UsrName: username, UsrPwd: password, LogOpt: logOpt },
      { headers: { 'Content-Type': 'application/json; charset=UTF-8' } },
    );

    let resultValue = data?.d;
    try {
      if (typeof resultValue === 'string') {
        resultValue = JSON.parse(resultValue);
      }
    } catch (e) { }

    if (resultValue && resultValue !== '' && resultValue !== '0' && resultValue !== '-1' && resultValue !== 0 && resultValue !== -1) {
      return { ok: true, raw: data };
    }
    return { ok: false, raw: data };
  } catch (error) {
    return { ok: false, error: error.message, raw: null };
  }
}

const TRANSIENT_CODES = new Set(['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED']);

async function withNetworkRetry(fn, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastErr = error;
      if (!TRANSIENT_CODES.has(error?.code) || i === retries) throw error;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

export async function fetchLabResultHtml(client, orderId) {
  const url = config.emr.labUrlTemplate + encodeURIComponent(orderId);
  const { data } = await withNetworkRetry(() => client.get(url));
  return data;
}

function findColumn(cols, matcher) {
  return cols.find((c) => matcher(normCol(c))) || null;
}

const SMEAR_KEYWORDS = ['PERIPHERAL SMEAR', 'PERIPHERAL BLOOD SMEAR', 'SMEAR STUDY', 'SMEAR'];

/**
 * Extracts unique active (non-cancelled) order requests from EMR lab order rows.
 * `includeSmear: false` preserves the custom chart's numeric-table filter, whereas
 * `includeSmear: true` includes all orders for the hospital's original EMR PDF.
 */
function collectOrderRequests(rows, { includeSmear = true } = {}) {
  if (!rows?.length) {
    return { reqDateMap: {}, reqStatusMap: {}, testCategoryMap: {}, reqIds: [] };
  }
  const cols = Object.keys(rows[0]);
  const reqCol = findColumn(cols, (n) => n === 'reqno' || n === 'requestno');
  const dateCol = findColumn(cols, (n) => n === 'requestdate');
  const procCol = findColumn(cols, (n) => n.includes('proc') || n.includes('test') || n.includes('desc'));
  const statusCol = findColumn(cols, (n) => n === 'status' || n === 'teststatus' || n === 'orderstatus');

  const reqDateMap = {};
  const reqStatusMap = {};
  const testCategoryMap = {};
  if (!reqCol) return { reqDateMap, reqStatusMap, testCategoryMap, reqIds: [] };

  for (const row of rows) {
    const parsed = extractOrderIdFromCell(row[reqCol]);
    if (!parsed.orderid) continue;

    const rowStatus = statusCol && row[statusCol] ? String(row[statusCol]).trim().toUpperCase() : '';
    if (rowStatus === 'CANCELLED') continue;

    if (!includeSmear && procCol && row[procCol]) {
      const procName = String(row[procCol]).toUpperCase();
      if (SMEAR_KEYWORDS.some((kw) => procName.includes(kw))) continue;
    }

    reqDateMap[parsed.orderid] = dateCol && row[dateCol] ? String(row[dateCol]).trim() : 'Unknown';
    if (statusCol && row[statusCol]) reqStatusMap[parsed.orderid] = String(row[statusCol]).trim();

    if (procCol && row[procCol]) {
      const rawProc = String(row[procCol]);
      const match = rawProc.match(/\[([^\]]+)\]/);
      if (match) {
        const testKey = normalizeTestKey(rawProc);
        testCategoryMap[`${parsed.orderid}_${testKey}`] = match[1].trim().toUpperCase();
      }
    }
  }
  return { reqDateMap, reqStatusMap, testCategoryMap, reqIds: Object.keys(reqDateMap) };
}

async function mergePdfBuffers(buffers) {
  if (buffers.length === 1) return buffers[0];
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return Buffer.from(await merged.save());
}

/**
 * Fetches the hospital's original Crystal Reports PDF (`CRReport/LabReport.aspx` with
 * `COMPHDR=1` so the hospital logo & letterhead appear) for one EMR `Orderid`.
 */
async function fetchOriginalEmrOrderPdf(client, orderId) {
  const html = await fetchLabResultHtml(client, orderId);
  const hdnOrderid = (html.match(/id="hdnOrderid"[^>]*value="([^"]*)"/i) || [])[1] || orderId;
  const hdnProcids = (html.match(/id="hdnProcids"[^>]*value="([^"]*)"/i) || [])[1] || '';
  const pdfUrl = new URL(
    `CRReport/LabReport.aspx?action=Search&Orderid=${encodeURIComponent(hdnOrderid)}&Procids=${encodeURIComponent(hdnProcids)}&COMPHDR=1&PatEmail=0`,
    config.emr.labUrlTemplate,
  ).href;

  const resp = await withNetworkRetry(() =>
    client.get(pdfUrl, { responseType: 'arraybuffer', validateStatus: () => true }),
  );
  const buf = Buffer.from(resp.data || []);
  const isPdf = resp.status >= 200 && resp.status < 300 && buf.subarray(0, 5).toString('ascii') === '%PDF-';
  if (!isPdf) {
    return { ok: false, html, error: `Req No ${orderId} returned status ${resp.status} (non-PDF)` };
  }
  return { ok: true, html, pdfBuffer: buf, orderId: hdnOrderid };
}

/**
 * Fetches and merges original EMR Lab Report PDF(s) for active orders in `rows`.
 * Reuses a single logged-in EMR session, retries failed approved orders once with
 * a fresh session, and returns `htmlByOrderId` so callers can index Lab Finder values.
 */
export async function fetchOriginalEmrLabPdf(searchData, { requireAllApproved = false } = {}) {
  const rows = (searchData || []).filter((r) => !isZPatient(r));
  if (!rows.length) {
    return { ok: false, reason: 'NO_DATA', error: 'No OP lab orders found for original EMR PDF.' };
  }
  const { reqIds } = collectOrderRequests(rows, { includeSmear: true });
  if (!reqIds.length) {
    return { ok: false, reason: 'NO_DATA', error: 'No active lab order IDs found.' };
  }

  const approvedOrderIds = new Set(
    rows
      .filter((r) => String(r['STATUS'] || '').trim().toUpperCase() === 'RESULT APPROVED')
      .map((r) => extractOrderIdFromCell(r['REQ NO'] || r['REQUEST NO']).orderid)
      .filter(Boolean),
  );

  let client = createClient();
  const loginResult = await withNetworkRetry(() => doLogin(client));
  if (!loginResult.ok) {
    return { ok: false, reason: 'TECHNICAL', error: `EMR login failed: ${JSON.stringify(loginResult.raw ?? loginResult.error)}` };
  }

  const bufferByOrderId = new Map();
  const htmlByOrderId = {};
  const errorByOrderId = new Map();

  async function tryOrder(orderId) {
    try {
      const res = await fetchOriginalEmrOrderPdf(client, orderId);
      if (res.html) htmlByOrderId[orderId] = res.html;
      if (res.ok && res.pdfBuffer) {
        bufferByOrderId.set(orderId, res.pdfBuffer);
        errorByOrderId.delete(orderId);
      } else {
        errorByOrderId.set(orderId, res.error || `Req No ${orderId}: original PDF unavailable`);
      }
    } catch (error) {
      errorByOrderId.set(orderId, `Error fetching original PDF for Req No ${orderId}: ${error.message}`);
    }
  }

  for (const orderId of reqIds) await tryOrder(orderId);

  // If any approved order returned a transient non-PDF/session hiccup, refresh login and retry once.
  const failedApproved = reqIds.filter((id) => !bufferByOrderId.has(id) && approvedOrderIds.has(id));
  if (failedApproved.length) {
    client = createClient();
    const relogin = await withNetworkRetry(() => doLogin(client)).catch(() => ({ ok: false }));
    if (relogin.ok) {
      for (const orderId of failedApproved) await tryOrder(orderId);
    }
  }

  const buffers = reqIds.map((id) => bufferByOrderId.get(id)).filter(Boolean);
  const fetchedOrderIds = reqIds.filter((id) => bufferByOrderId.has(id));
  const fetchErrors = [...errorByOrderId.values()];
  const missingApproved = reqIds.filter((id) => !bufferByOrderId.has(id) && approvedOrderIds.has(id));

  if (!buffers.length || (requireAllApproved && missingApproved.length)) {
    const firstErr = (missingApproved[0] && errorByOrderId.get(missingApproved[0])) || fetchErrors[0];
    return { ok: false, reason: 'TECHNICAL', error: firstErr || 'Could not download original EMR PDF.' };
  }

  const pdfBuffer = await mergePdfBuffers(buffers);
  return { ok: true, pdfBuffer, reqNos: fetchedOrderIds, htmlByOrderId, fetchErrors };
}

function escapeSql(value) {
  return String(value || '').trim().replace(/'/g, "''");
}

/** Converts YYYY-MM-DD (or MM/DD/YYYY) to MM/DD/YYYY expected by EMR QueryBuilder. */
export function toEmrMdy(dateStr) {
  const s = String(dateStr || '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const mdy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (mdy) return `${mdy[1]}/${mdy[2]}/${mdy[3]}`;
  return s;
}

export function isZPatient(row) {
  return String(row?.['PATIENT TYPE'] ?? row?.patientType ?? '').trim().toUpperCase() === 'ZPATIENT';
}

export function parseAgeGender(raw) {
  const s = String(raw || '').trim();
  if (!s) return { age: '', sex: '' };
  const slashIdx = s.indexOf('/');
  if (slashIdx === -1) return { age: s, sex: '' };
  return {
    age: s.slice(0, slashIdx).trim(),
    sex: s.slice(slashIdx + 1).trim(),
  };
}

async function runQueryBuilder(sql) {
  try {
    const { data: json } = await axios.post(
      config.emr.queryBuilderUrl,
      { strQuery: sql, strCon: 'BB_CONSTR' },
      { headers: { 'Content-Type': 'application/json; charset=UTF-8' }, timeout: EMR_TIMEOUT_MS },
    );

    const rows = json?.d ? JSON.parse(json.d) : [];
    return { ok: true, data: Array.isArray(rows) ? rows : [] };
  } catch (error) {
    return { ok: false, error: error.response?.data ? JSON.stringify(error.response.data) : error.message };
  }
}

export async function queryEMR(regNoVal, ipNoVal, fromDate, toDate, patCategory = '1') {
  const sql = `Use KMCH_Lab EXEC LabTestResultHistoryQB
        @FromDate = '${escapeSql(fromDate)}',
        @ToDate = '${escapeSql(toDate)}',
        @RegNo = '${escapeSql(regNoVal)}',
        @RequestNo = '',
        @IPNO = '${escapeSql(ipNoVal)}',
        @BillNo = '',
        @PatName = '',
        @BedNo = '',
        @Dept = '',
        @Doc = '0',
        @Proc = '0',
        @PatCategory = '${escapeSql(patCategory)}',
        @Status = '0',
        @bDiscaintimation = '1',
        @PatType = '0',
        @Result = '1'`;

  const res = await runQueryBuilder(sql);
  if (!res.ok) return res;
  return { ok: true, data: res.data.filter((r) => !isZPatient(r)) };
}

/**
 * Fetches OP front-office visits for a YYYY-MM-DD (or MM/DD/YYYY) date.
 * Excludes direct IP (`@IncludingDirectIP = '0'`) and camp/dummy ZPATIENT rows.
 */
export async function fetchOpVisits(dateStr, regNo = '') {
  const mdy = escapeSql(toEmrMdy(dateStr));
  const sql = `Use kmch_frontoffice EXEC Fo_Rpt_OPPatdetailsprint_QB
        @frmdate = '${mdy}',
        @todate = '${mdy}',
        @regno = '${escapeSql(regNo)}',
        @patname = '',
        @docid = '0',
        @IncludingDirectIP = '0',
        @Visittype = '0',
        @PatType = '0',
        @MatrixFormat = '0',
        @ReferredSource = '0',
        @Type = '0',
        @ClassId = '0',
        @CorporateId = '0',
        @Corporate_type = '0',
        @depid = '0',
        @RefDocCity = '0',
        @ReligionId = '0',
        @RefDocDays = '0',
        @RefDocId = '0',
        @VisitCategory = ''`;

  const res = await runQueryBuilder(sql);
  if (!res.ok) return res;
  return { ok: true, data: res.data.filter((r) => !isZPatient(r)) };
}

/** Fetches OP-only lab order lines (`@PatCategory = '1'`, non-ZPATIENT) for a date or window. */
export async function fetchOpLabOrders({ date, fromDate, toDate, regNo = '' } = {}) {
  let from = fromDate;
  let to = toDate;
  if (date) {
    const mdy = toEmrMdy(date);
    from = `${mdy} 00:00`;
    to = `${mdy} 23:59`;
  } else {
    from = normalizeSearchDate(fromDate);
    to = normalizeSearchDate(toDate);
  }
  return queryEMR(regNo, '', from, to, '1');
}

export async function fetchSearchResults(searchInput, fromDate, toDate) {
  const cleanInput = String(searchInput || '')
    .trim()
    .replace(/^(?:UHID|REG(?:\s*NO)?)\s*[:#-]?\s*/i, '')
    .trim();
  if (!cleanInput) return { ok: true, data: [] };
  return queryEMR(cleanInput, '', normalizeSearchDate(fromDate), normalizeSearchDate(toDate), '1');
}

export function extractPatientMeta(rows, cols) {
  const colMap = {
    name: ['patname', 'patientname', 'name'],
    age: ['age'],
    sex: ['sex', 'gender'],
    ageGender: ['age/gender', 'agegender'],
    regNo: ['regno', 'uhid'],
    unit: ['orderingdepartment', 'unit', 'dept', 'department'],
    doctor: ['orderingdoctor', 'doctor'],
    mobile: ['whatsappno', 'mobile'],
    patientType: ['patienttype'],
  };

  const found = {};
  for (const [key, aliases] of Object.entries(colMap)) {
    found[key] = null;
    for (const c of cols) {
      if (aliases.includes(normCol(c))) {
        found[key] = c;
        break;
      }
    }
  }

  const meta = {};
  for (const key of Object.keys(colMap)) {
    meta[key] = '';
    const colName = found[key];
    if (colName !== null) {
      for (const row of rows) {
        const val = String(row[colName] || '').trim();
        if (val && val !== '-' && val !== '--' && val.toUpperCase() !== 'OP') {
          meta[key] = val;
          break;
        } else if (val && !meta[key]) {
          meta[key] = val;
        }
      }
    }
  }

  if ((!meta.age || !meta.sex) && meta.ageGender) {
    const parsed = parseAgeGender(meta.ageGender);
    if (!meta.age) meta.age = parsed.age;
    if (!meta.sex) meta.sex = parsed.sex;
  }
  delete meta.ageGender;
  return meta;
}

export async function getLabDetail(orderId) {
  const client = createClient();
  const loginResult = await doLogin(client);

  if (!loginResult.ok) {
    return {
      ok: false,
      error: 'Login failed',
      detail: loginResult.raw ?? loginResult.error,
    };
  }

  const fullHtml = await fetchLabResultHtml(client, orderId);
  const tableHtml = extractResultTable(fullHtml);

  if (!tableHtml) {
    return {
      ok: false,
      error: 'Result table not found (session may be invalid or Orderid has no results)',
    };
  }

  return {
    ok: true,
    orderid: orderId,
    rows: parseResultTableToArray(tableHtml),
  };
}

const DEPARTMENTS = new Set([
  'HAEMATOLOGY',
  'BIOCHEMISTRY',
  'CLINICALPATHOLOGY',
  'CLINICAL PATHOLOGY',
  'SEROLOGY',
  'MICROBIOLOGY',
  'HISTOPATHOLOGY',
  'CYTOLOGY',
  'MOLECULAR BIOLOGY',
  'IMMUNOLOGY',
  'BLOOD BANK',
]);

function isDepartmentName(name) {
  if (!name) return true;
  const clean = String(name).trim().toUpperCase().replace(/[^A-Z]/g, '');
  return DEPARTMENTS.has(clean) || DEPARTMENTS.has(String(name).trim().toUpperCase());
}

// Given a raw EMR datetime string (day portion already stripped off the front),
// pulls out a 12-hour "H:MM AM/PM" to disambiguate multiple orders placed on the same day.
function extractTimePart(dateRaw) {
  if (!dateRaw || dateRaw === 'Unknown') return null;
  const rest = String(dateRaw).slice(10);
  const m = rest.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const period = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${m[2]} ${period}`;
}

let dynamicTestGroups = null;

async function fetchDynamicTestGroups() {
  if (dynamicTestGroups) return dynamicTestGroups;
  try {
    const query = `Use KMCH_Lab;
WITH ProcHierarchy AS (
    SELECT 
        p.iProc_id AS TestId,
        p.cProc_Name AS TestName,
        p.iProc_id AS PkgId,
        p.cProc_Name AS PackageName,
        0 AS Depth
    FROM Mast_Proc p

    UNION ALL

    SELECT 
        ph.TestId,
        ph.TestName,
        parent.iProc_id AS PkgId,
        parent.cProc_Name AS PackageName,
        ph.Depth + 1 AS Depth
    FROM ProcHierarchy ph
    JOIN Mast_SubProc sp ON ph.PkgId = sp.iProc_id
    JOIN Mast_Proc parent ON sp.iReports_To = parent.iProc_id
    WHERE sp.bActive = 1
)
SELECT 
    p.cProc_Name AS TestName, 
    ph.PackageName AS CategoryName
FROM Mast_Proc p
JOIN (
    SELECT TestId, PackageName, Depth 
    FROM (
        SELECT TestId, PackageName, Depth, 
               ROW_NUMBER() OVER(PARTITION BY TestId ORDER BY Depth DESC) as rn 
        FROM ProcHierarchy 
        WHERE Depth > 0
    ) t 
    WHERE rn = 1
) ph ON p.iProc_id = ph.TestId`;

    const payload = {
      strQuery: query,
      strCon: 'BB_CONSTR',
    };
    const response = await axios.post(config.emr.retDatatableUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: EMR_TIMEOUT_MS,
    });
    const records = JSON.parse(response.data.d);
    dynamicTestGroups = {};
    for (const rec of records) {
      if (rec.TestName && rec.CategoryName && !isDepartmentName(rec.CategoryName)) {
        const key = normalizeTestKey(rec.TestName);
        const cat = rec.CategoryName.trim().toUpperCase();
        dynamicTestGroups[key] = cat;

        if (key.includes('TOTAL BILIRUBIN')) {
          dynamicTestGroups[key.replace('TOTAL BILIRUBIN', 'BILIRUBIN - TOTAL')] = cat;
        } else if (key.includes('BILIRUBIN - TOTAL')) {
          dynamicTestGroups[key.replace('BILIRUBIN - TOTAL', 'TOTAL BILIRUBIN')] = cat;
        }
      }
    }
    console.log(`Successfully fetched ${Object.keys(dynamicTestGroups).length} dynamic test package groups.`);
    return dynamicTestGroups;
  } catch (err) {
    console.error('Failed to fetch dynamic test groups:', err.message);
    if (err.response) console.error(err.response.data);
    return {};
  }
}

export async function buildInvestigationChart(searchData, { prefetchedHtmlByOrderId = null } = {}) {
  const rows = (searchData || []).filter((r) => !isZPatient(r));
  if (!rows.length) {
    return { chartDates: [], chartValues: {}, unmapped: [], fetchErrors: [], patientMeta: {}, template: {}, reqNos: [] };
  }
  const dynGroups = await fetchDynamicTestGroups();

  const cols = Object.keys(rows[0]);
  const patientMeta = extractPatientMeta(rows, cols);
  const { reqDateMap, reqStatusMap, testCategoryMap } = collectOrderRequests(rows, { includeSmear: false });

  const fetchErrors = [];
  const chartValues = {};
  const finalTemplate = {};
  const dateSet = new Set();
  const repeatCounts = {}; // `${fieldId}|${dayPart}` -> how many same-day repeat rows exist

  const orderEntries = Object.entries(reqDateMap);
  if (orderEntries.length === 0) {
    return { chartDates: [], chartValues: {}, unmapped: [], fetchErrors, patientMeta, template: {}, reqNos: [] };
  }

  let client = null;
  const needLogin = orderEntries.some(([orderid]) => !prefetchedHtmlByOrderId?.[orderid]);
  if (needLogin) {
    client = createClient();
    const loginResult = await withNetworkRetry(() => doLogin(client));
    if (!loginResult.ok) {
      fetchErrors.push(`Login failed while building chart: ${JSON.stringify(loginResult.raw ?? loginResult.error)}`);
      return { chartDates: [], chartValues: {}, unmapped: [], fetchErrors, patientMeta, template: {}, reqNos: [] };
    }
  }

  for (const [orderid, dateRaw] of orderEntries) {
    const dayPart = dateRaw === 'Unknown' ? 'Unknown' : dateRaw.slice(0, 10);

    let fullHtml = prefetchedHtmlByOrderId?.[orderid] || null;
    if (!fullHtml) {
      try {
        fullHtml = await fetchLabResultHtml(client, orderid);
      } catch (err) {
        fetchErrors.push(`Error fetching detail for Req No ${orderid}: ${err.message}`);
        continue;
      }
    }

    const tableHtml = extractResultTable(fullHtml);
    if (!tableHtml) {
      const status = reqStatusMap[orderid];
      if (status && (status.toLowerCase().includes('pending') || status.toLowerCase().includes('cancel') || status.toLowerCase().includes('yet') || status.toLowerCase().includes('process'))) {
        fetchErrors.push(`Req No ${orderid} — ${status}`);
      }
      continue;
    }

    const detailRows = parseResultTableToArray(tableHtml);

    const isIgnoredText = (str) => {
      if (!str) return false;
      const s = String(str).toUpperCase().trim();
      return (
        s.includes('CLINICAL DETAILS') ||
        s.includes('CRITICAL VALUE') ||
        s.includes('CRITICAL VALUES') ||
        s.includes('IMPRESSION') ||
        s.includes('REMARK') ||
        s.includes('COMMENT') ||
        s.includes('SMEAR') ||
        s.includes('PARASITE') ||
        s.startsWith('NOTE')
      );
    };

    const isNarrativeTextValue = (val) => {
      if (!val) return false;
      const str = String(val).trim();
      if (str.length > 20 && str.split(/\s+/).length > 3) return true;
      const lower = str.toLowerCase();
      const narrativeKeywords = [
        'microcytic', 'hypochromic', 'normocytic', 'normochromic', 'anisopoikilocytosis',
        'increased', 'decreased', 'reduced', 'smear', 'granulation', 'vacuolation',
        'reactive', 'lymphocytes', 'neutrophil', 'metamyelocyte', 'predominantly',
        'admixed', 'echinocytes', 'elliptocytes', 'target cells', 'cells/mm3',
        'cells/cu', 'left shift', 'seen', 'adequate', 'inadequate', 'imprint', 'biopsy'
      ];
      return narrativeKeywords.some((kw) => lower.includes(kw));
    };

    let currentCategory = 'OTHER TESTS';
    for (const dr of detailRows) {
      if (dr.section) {
        if (!isIgnoredText(dr.section)) {
          currentCategory = dr.section;
        }
        continue;
      }

      if (
        isIgnoredText(dr.test) ||
        isIgnoredText(currentCategory) ||
        isNarrativeTextValue(dr.value) ||
        isNarrativeTextValue(dr.range) ||
        (dr.value && String(dr.value).trim().length > 30) ||
        (dr.range && String(dr.range).trim().length > 30)
      ) {
        continue;
      }

      const key = normalizeTestKey(dr.test);
      if (!key) continue;
      const fieldId = `dyn_${key.replace(/[^A-Z0-9]/g, '_')}`;

      let searchKey = key;
      if (searchKey.startsWith('URINE')) {
        searchKey = searchKey.replace(/^URINE\s*/, '').trim();
      } else if (searchKey === 'RATIO') {
        searchKey = 'A/G RATIO';
      } else if (searchKey.includes('HIV') && searchKey.includes('RAPID')) {
        searchKey = 'HIV I & II RAPID';
      }

      // 1. Detailed Grouping from RETDatatable using package name / test name
      let finalCategory = dynGroups[key] || dynGroups[searchKey] || dynGroups[searchKey.replace(/\s+/g, '')];

      if (!finalCategory && key.includes('COLOUR')) {
        console.log(`Failed to find category for key: '${key}', searchKey: '${searchKey}'`);
      }

      // 2. Fallback to bracketed package name from EMR query (if not a department name)
      if (!finalCategory) {
        const bracketCat = testCategoryMap[`${orderid}_${searchKey}`] || testCategoryMap[`${orderid}_${key}`];
        if (bracketCat && !isDepartmentName(bracketCat)) {
          finalCategory = bracketCat;
        }
      }

      // 3. Fallback to current HTML section category ONLY if not a department name
      if (!finalCategory) {
        if (currentCategory && !isDepartmentName(currentCategory)) {
          finalCategory = currentCategory;
        }
      }

      if (!finalCategory || isDepartmentName(finalCategory) || finalCategory === 'OTHER TESTS' || finalCategory === 'INDIVIDUAL TESTS') {
        finalCategory = '';
      }

      if (!finalTemplate[finalCategory]) finalTemplate[finalCategory] = [];

      const baseLabel = dr.test.replace(/<\/a>\s*$/i, '').trim();

      // Same test already has a value for this day from another order — instead of
      // overwriting it, add another row for the same test (tagged with the order time).
      const hasExistingForDay =
        chartValues[fieldId] &&
        chartValues[fieldId][dayPart] !== undefined &&
        String(chartValues[fieldId][dayPart]).trim() !== '';

      let rowFieldId = fieldId;
      let rowLabel = baseLabel;

      if (hasExistingForDay) {
        const repeatKey = `${fieldId}|${dayPart}`;
        const n = (repeatCounts[repeatKey] || 1) + 1;
        repeatCounts[repeatKey] = n;
        const timePart = extractTimePart(dateRaw);
        rowFieldId = `${fieldId}__rep${n}`;
        rowLabel = `${baseLabel} (${timePart || `Repeat ${n}`})`;
      }

      let fieldDef = finalTemplate[finalCategory].find((f) => f.id === rowFieldId);
      if (!fieldDef) {
        fieldDef = {
          id: rowFieldId,
          label: rowLabel,
          range: dr.range,
        };
        if (hasExistingForDay) {
          // Insert right after the original (or latest repeat) row so repeats stay grouped.
          let insertAt = finalTemplate[finalCategory].length;
          for (let i = finalTemplate[finalCategory].length - 1; i >= 0; i--) {
            const fid = finalTemplate[finalCategory][i].id;
            if (fid === fieldId || fid.startsWith(`${fieldId}__rep`)) {
              insertAt = i + 1;
              break;
            }
          }
          finalTemplate[finalCategory].splice(insertAt, 0, fieldDef);
        } else {
          finalTemplate[finalCategory].push(fieldDef);
        }
      }

      if (!chartValues[rowFieldId]) chartValues[rowFieldId] = {};
      chartValues[rowFieldId][dayPart] = dr.value;
      dateSet.add(dayPart);
    }
  }

  return {
    chartDates: sortChartDates([...dateSet]),
    chartValues,
    unmapped: [],
    fetchErrors,
    patientMeta,
    template: finalTemplate,
    reqNos: Object.keys(reqDateMap),
  };
}

export async function searchInvestigation(regNo, fromDateInput, toDateInput) {
  const fromDate = normalizeSearchDate(fromDateInput);
  const toDate = normalizeSearchDate(toDateInput);

  const searchResult = await fetchSearchResults(regNo, fromDate, toDate);

  if (!searchResult.ok) {
    return { ok: false, error: searchResult.error };
  }

  if (!searchResult.data.length) {
    return {
      ok: true,
      data: [],
      chart: null,
      regNo,
      fromDate,
      toDate,
    };
  }

  const chart = await buildInvestigationChart(searchResult.data);

  return {
    ok: true,
    data: searchResult.data,
    chart,
    regNo,
    fromDate,
    toDate,
  };
}
