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
import {
  buildChartIndexes,
  getChartTemplate,
  normalizeTestKey,
} from '../templates/chartTemplate.js';
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

    if (data?.d && data.d !== '' && data.d !== '0' && data.d !== '-1') {
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

export async function fetchSearchResults(regNo, fromDate, toDate) {
  const sql = `Use KMCH_Lab EXEC LabTestResultHistoryQB
        @FromDate = '${fromDate}',
        @ToDate = '${toDate}',
        @RegNo = '${regNo}',
        @RequestNo = '',
        @IPNO = '',
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
    return { ok: false, error: error.message };
  }
}

export function extractPatientMeta(rows, cols) {
  const colMap = {
    name: ['patname', 'patientname', 'name'],
    age: ['age'],
    sex: ['sex', 'gender'],
    bed: ['bedno', 'bed'],
    ip: ['ipno', 'ipnumber', 'ip'],
    ward: ['ward'],
    unit: ['unit'],
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
    meta[key] =
      found[key] !== null && rows[0]?.[found[key]] !== undefined
        ? String(rows[0][found[key]]).trim()
        : '';
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

export async function buildInvestigationChart(searchData) {
  const rows = searchData;
  const cols = Object.keys(rows[0]);
  const patientMeta = extractPatientMeta(rows, cols);

  let reqCol = null;
  let dateCol = null;
  for (const c of cols) {
    const n = normCol(c);
    if (!reqCol && (n === 'reqno' || n === 'requestno')) reqCol = c;
    if (!dateCol && n === 'requestdate') dateCol = c;
  }

  const reqDateMap = {};
  if (reqCol) {
    for (const row of rows) {
      const parsed = extractOrderIdFromCell(row[reqCol]);
      if (!parsed.orderid) continue;

      let datePart = 'Unknown';
      if (dateCol && row[dateCol]) {
        datePart = String(row[dateCol]).trim().slice(0, 10);
      }
      reqDateMap[parsed.orderid] = datePart;
    }
  }

  if (Object.keys(reqDateMap).length === 0) {
    return {
      chartDates: [],
      chartValues: {},
      unmapped: [],
      fetchErrors: [],
      patientMeta,
      template: getChartTemplate(),
    };
  }

  const client = createClient();
  const loginResult = await doLogin(client);
  const fetchErrors = [];

  if (!loginResult.ok) {
    fetchErrors.push(
      `Login failed while building chart: ${JSON.stringify(loginResult.raw ?? loginResult.error)}`,
    );
    return {
      chartDates: [],
      chartValues: {},
      unmapped: [],
      fetchErrors,
      patientMeta,
      template: getChartTemplate(),
    };
  }

  const [matchIndex] = buildChartIndexes(getChartTemplate());
  const chartValues = {};
  const unmapped = [];
  const dateSet = new Set();

  for (const [orderid, datePart] of Object.entries(reqDateMap)) {
    dateSet.add(datePart);

    const fullHtml = await fetchLabResultHtml(client, orderid);
    const tableHtml = extractResultTable(fullHtml);

    if (!tableHtml) {
      fetchErrors.push(`Could not load detail for Req No ${orderid}.`);
      continue;
    }

    const detailRows = parseResultTableToArray(tableHtml);

    for (const dr of detailRows) {
      if (dr.section) continue;

      const key = normalizeTestKey(dr.test);
      if (matchIndex[key]) {
        const fieldId = matchIndex[key];
        if (!chartValues[fieldId]) chartValues[fieldId] = {};
        chartValues[fieldId][datePart] = dr.value;
      } else {
        unmapped.push({
          test: dr.test,
          value: dr.value,
          range: dr.range,
          date: datePart,
          orderid,
        });
      }
    }
  }

  return {
    chartDates: sortChartDates([...dateSet]),
    chartValues,
    unmapped,
    fetchErrors,
    patientMeta,
    template: getChartTemplate(),
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
