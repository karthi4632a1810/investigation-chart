import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
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

function createClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));
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
    } catch(e) {}
    
    if (resultValue && resultValue !== '' && resultValue !== '0' && resultValue !== '-1' && resultValue !== 0 && resultValue !== -1) {
      return { ok: true, raw: data };
    }
    return { ok: false, raw: data };
  } catch (error) {
    return { ok: false, error: error.message, raw: null };
  }
}

export async function fetchLabResultHtml(client, orderId) {
  const url = config.emr.labUrlTemplate + encodeURIComponent(orderId);
  const { data } = await client.get(url);
  return data;
}

export async function queryEMR(regNoVal, ipNoVal, fromDate, toDate) {
  const sql = `Use KMCH_Lab EXEC LabTestResultHistoryQB
        @FromDate = '${fromDate}',
        @ToDate = '${toDate}',
        @RegNo = '${regNoVal || ''}',
        @RequestNo = '',
        @IPNO = '${ipNoVal || ''}',
        @BillNo = '',
        @PatName = '',
        @BedNo = '',
        @Dept = '',
        @Doc = '0',
        @Proc = '0',
        @PatCategory = '1,2,3',
        @Status = '0',
        @bDiscaintimation = '1',
        @PatType = '0',
        @Result = '1'`;

  try {
    const { data: json } = await axios.post(
      config.emr.queryBuilderUrl,
      { strQuery: sql, strCon: 'BB_CONSTR' },
      { headers: { 'Content-Type': 'application/json; charset=UTF-8' } },
    );

    const rows = json?.d ? JSON.parse(json.d) : [];
    return { ok: true, data: Array.isArray(rows) ? rows : [] };
  } catch (error) {
    return { ok: false, error: error.response?.data ? JSON.stringify(error.response.data) : error.message };
  }
}

export async function fetchSearchResults(searchInput, fromDate, toDate) {
  const cleanInput = String(searchInput || '').trim();
  const isIpFormat = /IP/i.test(cleanInput);

  if (isIpFormat) {
    // 1st try: as @IPNO with full input string
    let res = await queryEMR('', cleanInput, fromDate, toDate);
    if (res.ok && res.data.length) return res;

    // 2nd try: clean IP number without "IP " or "IP" prefix
    const strippedIp = cleanInput.replace(/^IP\s*/i, '').trim();
    if (strippedIp && strippedIp !== cleanInput) {
      res = await queryEMR('', strippedIp, fromDate, toDate);
      if (res.ok && res.data.length) return res;
    }

    // 3rd try: as @RegNo fallback
    res = await queryEMR(cleanInput, '', fromDate, toDate);
    return res;
  } else {
    // Input does not have "IP" prefix
    // 1st try: as @RegNo
    let res = await queryEMR(cleanInput, '', fromDate, toDate);
    if (res.ok && res.data.length) return res;

    // 2nd try: as @IPNO (e.g. user entered raw IP number without 'IP' prefix)
    res = await queryEMR('', cleanInput, fromDate, toDate);
    if (res.ok && res.data.length) return res;

    // 3rd try: as @IPNO with "IP" prepended
    res = await queryEMR('', `IP${cleanInput}`, fromDate, toDate);
    return res;
  }
}

export function extractPatientMeta(rows, cols) {
  const colMap = {
    name: ['patname', 'patientname', 'name'],
    age: ['age'],
    sex: ['sex', 'gender'],
    bed: ['bedno', 'bed'],
    ip: ['ipno', 'ipnumber', 'ip', 'ipopot'],
    ward: ['ward'],
    unit: ['unit', 'orderingdepartment', 'dept', 'department'],
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

export async function buildInvestigationChart(searchData) {
  const dynGroups = await fetchDynamicTestGroups();

  const rows = searchData;
  const cols = Object.keys(rows[0]);
  const patientMeta = extractPatientMeta(rows, cols);

  let reqCol = null;
  let dateCol = null;
  let procCol = null;
  let statusCol = null;
  for (const c of cols) {
    const n = normCol(c);
    if (!reqCol && (n === 'reqno' || n === 'requestno')) reqCol = c;
    if (!dateCol && n === 'requestdate') dateCol = c;
    if (!procCol && (n.includes('proc') || n.includes('test') || n.includes('desc'))) procCol = c;
    if (!statusCol && (n === 'status' || n === 'teststatus' || n === 'orderstatus')) statusCol = c;
  }

  const reqDateMap = {};
  const reqStatusMap = {};
  const testCategoryMap = {};
  if (reqCol) {
    for (const row of rows) {
      const parsed = extractOrderIdFromCell(row[reqCol]);
      if (!parsed.orderid) continue;

      if (procCol && row[procCol]) {
        const procName = String(row[procCol]).toUpperCase();
        if (
          procName.includes('PERIPHERAL SMEAR') ||
          procName.includes('PERIPHERAL SMEAR STUDY') ||
          procName.includes('PERIPHERAL BLOOD SMEAR') ||
          procName.includes('SMEAR STUDY') ||
          procName.includes('SMEAR')
        ) {
          continue;
        }
      }

      let dateRaw = 'Unknown';
      if (dateCol && row[dateCol]) {
        dateRaw = String(row[dateCol]).trim();
      }
      reqDateMap[parsed.orderid] = dateRaw;

      if (statusCol && row[statusCol]) {
        reqStatusMap[parsed.orderid] = String(row[statusCol]).trim();
      }

      if (procCol && row[procCol]) {
        const rawProc = String(row[procCol]);
        const match = rawProc.match(/\[([^\]]+)\]/);
        if (match) {
          const category = match[1].trim().toUpperCase();
          const testKey = normalizeTestKey(rawProc);
          testCategoryMap[`${parsed.orderid}_${testKey}`] = category;
        }
      }
    }
  }

  const fetchErrors = [];
  const chartValues = {};
  const finalTemplate = {};
  const dateSet = new Set();
  const repeatCounts = {}; // `${fieldId}|${dayPart}` -> how many same-day repeat rows exist

  if (Object.keys(reqDateMap).length === 0) {
    return { chartDates: [], chartValues: {}, unmapped: [], fetchErrors, patientMeta, template: {} };
  }

  const client = createClient();
  const loginResult = await doLogin(client);

  if (!loginResult.ok) {
    fetchErrors.push(`Login failed while building chart: ${JSON.stringify(loginResult.raw ?? loginResult.error)}`);
    return { chartDates: [], chartValues: {}, unmapped: [], fetchErrors, patientMeta, template: {} };
  }

  for (const [orderid, dateRaw] of Object.entries(reqDateMap)) {
    const dayPart = dateRaw === 'Unknown' ? 'Unknown' : dateRaw.slice(0, 10);
    dateSet.add(dayPart);

    let fullHtml;
    try {
      fullHtml = await fetchLabResultHtml(client, orderid);
    } catch (err) {
      fetchErrors.push(`Error fetching detail for Req No ${orderid}: ${err.message}`);
      continue;
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
    }
  }

  return {
    chartDates: sortChartDates([...dateSet]),
    chartValues,
    unmapped: [],
    fetchErrors,
    patientMeta,
    template: finalTemplate,
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
