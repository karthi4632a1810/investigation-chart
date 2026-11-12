/**
 * Renders an OP patient's investigation chart to a PDF, in the same visual
 * format as the app's own print view (InvestigationChart.jsx + App.css).
 * Shared by manual tools, API downloads, and the OP lab-report scheduler.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildInvestigationChart, fetchOpLabOrders, fetchOriginalEmrLabPdf, searchInvestigation, toEmrMdy } from './emrService.js';
import { reportObjectKey, uploadPdfBuffer, uploadPdfFile } from './storageService.js';
import { setting } from './appSettingsService.js';
import { BRAND_CSS, cleanPatientName, esc, formatGeneratedDate, letterheadHtml, patientCardHtml } from './pdfBranding.js';

const execFileAsync = promisify(execFile);

// The host dev workflow uses the system's google-chrome; the Docker image installs
// Alpine's chromium package instead (no Chrome package available for Alpine) and
// sets CHROME_PATH so this picks it up without any code change.
const CHROME_BIN = process.env.CHROME_PATH || 'google-chrome';

/** Mirrors InvestigationChart.jsx's getStatusColor exactly. */
export function getStatusColor(val, rangeStr) {
  if (!val || !rangeStr || val === '—' || val === '--') return null;

  const cleanVal = String(val).replace(/[<>=\s]/g, '');
  const numVal = parseFloat(cleanVal);
  if (isNaN(numVal)) return null;

  const strRange = String(rangeStr);
  const rangeMatch = strRange.match(/([0-9.]+)\s*-\s*([0-9.]+)/);
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1]);
    const max = parseFloat(rangeMatch[2]);
    if (numVal < min) return 'red';
    if (numVal > max) return '#e67e22';
    return 'green';
  }

  const greaterMatch = strRange.match(/>\s*([0-9.]+)/);
  if (greaterMatch) {
    const limit = parseFloat(greaterMatch[1]);
    return numVal <= limit ? 'red' : 'green';
  }

  const lessMatch =
    strRange.match(/<\s*([0-9.]+)/) ||
    strRange.match(/upto\s*([0-9.]+)/i) ||
    strRange.match(/up to\s*([0-9.]+)/i);
  if (lessMatch) {
    const limit = parseFloat(lessMatch[1]);
    return numVal > limit ? '#e67e22' : 'green';
  }

  return null;
}

const EMPTY_VALUES = new Set(['', '-', '--', '—']);
const STATUS_NAME = { red: 'low', '#e67e22': 'high', green: 'normal' };

/** "28-09-2026" → "2026-09-28" (chart dates are DD-MM-YYYY). */
function chartDateToIso(d) {
  const m = String(d).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

/**
 * Every non-empty value in a patient's chart as one row per test per date —
 * the shape stored in Mongo for the Lab Finder search (labResultsService.js).
 * `status` uses the same range logic as the PDF's H/L pills.
 */
export function flattenChartResults(chart) {
  const rows = [];
  for (const [sectionName, fields] of Object.entries(chart?.template || {})) {
    const section = ['INDIVIDUAL TESTS', 'OTHER TESTS', 'STANDALONE'].includes(sectionName) ? '' : sectionName || '';
    for (const field of fields) {
      for (const [resultDate, raw] of Object.entries(chart.chartValues?.[field.id] || {})) {
        const value = String(raw ?? '').trim();
        if (EMPTY_VALUES.has(value)) continue;
        const numeric = parseFloat(value.replace(/[<>=\s]/g, ''));
        rows.push({
          section,
          test: field.label,
          range: field.range || '',
          value,
          numeric: Number.isFinite(numeric) ? numeric : null,
          status: STATUS_NAME[getStatusColor(value, field.range)] || null,
          resultDate,
          resultDay: chartDateToIso(resultDate),
        });
      }
    }
  }
  return rows;
}

function chunkArray(array, size) {
  const results = [];
  for (let i = 0; i < array.length; i += size) results.push(array.slice(i, i + size));
  return results;
}

// Status → value treatment. Abnormal values also carry an H/L letter so they
// still read correctly on a black-and-white printout.
const STATUS_CLASS = { red: 'v-low', '#e67e22': 'v-high', green: 'v-ok' };
const STATUS_LETTER = { red: 'L', '#e67e22': 'H' };

const STATUS_LEGEND = `
  <div class="status-legend">
    <span class="lg lg-ok">Within normal</span>
    <span class="lg lg-high"><b>H</b> Above range</span>
    <span class="lg lg-low"><b>L</b> Below range</span>
  </div>`;

function renderValueCell(val, range) {
  if (!val) return '<td class="field-value is-empty">—</td>';
  const color = getStatusColor(val, range);
  const cls = STATUS_CLASS[color] || '';
  const letter = STATUS_LETTER[color];
  // Every value sits in a .v span (bordered or not) so all rows share one height.
  return `<td class="field-value"><span class="v ${cls}">${esc(val)}${letter ? `<i>${letter}</i>` : ''}</span></td>`;
}

function renderChartTable(dates, template, chartValues) {
  const dateColWidth = (56 / Math.max(dates.length, 1)).toFixed(1);

  let body = '';
  for (const [sectionName, fields] of Object.entries(template)) {
    const activeFields = fields.filter((field) =>
      dates.some((d) => {
        const val = chartValues[field.id]?.[d];
        return val && String(val).trim() !== '' && val !== '--' && val !== '-' && val !== '—';
      }),
    );
    if (activeFields.length === 0) continue;

    const isIndividualSection =
      !sectionName || ['INDIVIDUAL TESTS', 'OTHER TESTS', 'STANDALONE'].includes(sectionName);

    // Standalone tests get their own heading too, so they don't read as part
    // of whichever panel happens to come before them.
    body += `<tr class="section-row"><td colspan="${2 + dates.length}">${esc(isIndividualSection ? 'Other Tests' : sectionName)}</td></tr>`;

    for (const field of activeFields) {
      const isNarrativeRange =
        field.range &&
        (field.range.length > 30 ||
          /microcytic|hypochromic|normocytic|anisopoikilocytosis|increased|reduced|smear|granulation|leukocytosis/i.test(
            field.range,
          ));
      const displayRange = isNarrativeRange ? '' : field.range;

      body += `<tr><td class="field-label">${esc(field.label)}</td><td class="field-range">${esc(displayRange)}</td>`;
      for (const d of dates) {
        body += renderValueCell(chartValues[field.id]?.[d] ?? '', field.range);
      }
      body += '</tr>';
    }
  }

  const headCols = dates.map((d) => `<th class="th-date" style="width:${dateColWidth}%;">${esc(d)}</th>`).join('');
  return `${STATUS_LEGEND}<table class="chart"><thead><tr><th style="width:26%;">Parameter</th><th style="width:18%;">Ref. Range</th>${headCols}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Finds the most recent non-empty value for a test whose label matches
 * `labelRegex` (e.g. the "BLOOD GROUPING" row already present in the chart
 * table) — real data already flowing through this patient's chart, just
 * surfaced a second time as a highlighted tag. Returns '' if never ordered.
 */
function findLatestFieldValue(template, chartValues, chartDates, labelRegex) {
  for (const fields of Object.values(template)) {
    for (const field of fields) {
      if (!labelRegex.test(field.label)) continue;
      for (let i = chartDates.length - 1; i >= 0; i--) {
        const val = chartValues[field.id]?.[chartDates[i]];
        if (val && String(val).trim() && val !== '--' && val !== '-' && val !== '—') return val;
      }
    }
  }
  return '';
}

/** UHID leads the OP identifier card along with visit category, token, period, department, and doctor. */
function renderPatientCard(meta, { regNo, bloodGroup, physicianName, department, visitType, tokenNo, reportPeriod }) {
  const ageSex = [meta?.age, meta?.sex].filter((v) => String(v || '').trim()).join(' · ');
  const dept = department || meta?.unit || '';
  const doctor = physicianName || meta?.doctor || '';
  return patientCardHtml({
    name: cleanPatientName(meta?.name),
    tags: [
      { text: ageSex, tone: 'blue' },
      { text: dept, tone: 'green' },
      { text: bloodGroup ? `Blood Group ${bloodGroup}` : '', tone: 'rose' },
    ],
    fields: [
      { label: 'UHID', value: regNo || meta?.regNo, id: true, key: true },
      { label: 'Category', value: visitType ? `OP · ${visitType}` : 'OP' },
      { label: 'Token No.', value: tokenNo },
      { label: 'Report Period', value: reportPeriod },
      { label: 'Ordering Department', value: dept },
      { label: 'Consulting Doctor', value: doctor },
    ],
  });
}

export function buildInvestigationChartHtml({
  hospital,
  regNo,
  chart,
  physicianName,
  department,
  visitType,
  tokenNo,
  subtitle = 'Outpatient laboratory investigation report',
}) {
  const { chartDates, chartValues, patientMeta, template } = chart;
  const pages = chunkArray(chartDates, 4);
  const bloodGroup = findLatestFieldValue(template, chartValues, chartDates, /blood\s*group/i);
  const reportPeriod =
    chartDates.length > 1 ? `${chartDates[0]} – ${chartDates[chartDates.length - 1]}` : chartDates[0] || '';
  const letterhead = letterheadHtml(hospital, {
    title: 'OP Laboratory Report',
    subtitle,
    meta: `Generated ${formatGeneratedDate()}`,
  });
  const patientCard = renderPatientCard(patientMeta, {
    regNo,
    bloodGroup,
    physicianName,
    department,
    visitType,
    tokenNo,
    reportPeriod,
  });

  const pageBlocks = pages
    .map((pageDates, idx) => {
      const isLast = idx === pages.length - 1;
      // The disclaimer only belongs once, at the true end of the document —
      // not repeated on every date-chunk page, and not carrying a "Page X of
      // Y" count that would be wrong whenever a chunk's table overflows onto
      // more physical PDF pages than there are chunks.
      const footer = isLast
        ? `<div class="disclaimer-footer">
            <div class="disclaimer-header">
              <span class="disclaimer-badge">DISCLAIMER</span>
              <span class="disclaimer-sub">• Diagnostic Notice &amp; Legal Advisory</span>
            </div>
            <div class="disclaimer-body">
              This is a digitally generated outpatient diagnostic report for information only and is not a legal document. The signed report issued by the authorised consultant is final and shall prevail. Please consult your treating doctor for interpretation. This WhatsApp copy is not valid for legal, insurance or other claims.
              <div class="disclaimer-ta">
                இது கணினி மூலம் உருவாக்கப்பட்ட பரிசோதனை அறிக்கைச் சுருக்கம்; தகவலுக்காக மட்டுமே வாட்ஸ்அப் மூலம் அனுப்பப்படுகிறது. இது சட்டப்பூர்வ ஆவணம் அல்ல. அங்கீகரிக்கப்பட்ட மருத்துவரால் கையொப்பமிடப்பட்ட அறிக்கையே இறுதியானது. முடிவுகளை உங்கள் சிகிச்சை மருத்துவரிடம் கலந்தாலோசித்து அறிந்து கொள்ளவும். இந்த டிஜிட்டல் பிரதியை சட்ட, காப்பீடு அல்லது வேறு எந்த கோரிக்கைகளுக்கும் பயன்படுத்த இயலாது
              </div>
            </div>
          </div>`
        : '';
      return `
    <div class="chart-page-block">
      ${letterhead}
      ${patientCard}
      ${renderChartTable(pageDates, template, chartValues)}
      ${footer}
    </div>`;
    })
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; background: #ffffff; color: #1e293b; }
  @page { size: A4 portrait; margin: 9mm 10mm; }

  .chart-page-block { width: 100%; page-break-after: always; break-after: page; }
  .chart-page-block:last-child { page-break-after: auto; break-after: auto; }
${BRAND_CSS}
  .status-legend { display: flex; justify-content: flex-end; gap: 6px; margin: 0 0 6px; }
  .lg { font-size: 8px; font-weight: 700; padding: 2px 8px; border-radius: 999px; border: 1px solid; }
  .lg b { font-weight: 900; margin-right: 2px; }
  .lg-ok { color: #047857; background: #ecfdf5; border-color: #a7f3d0; }
  .lg-high { color: #b45309; background: #fff7ed; border-color: #fed7aa; }
  .lg-low { color: #b91c1c; background: #fef2f2; border-color: #fecaca; }

  table.chart { width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0; font-size: 10px; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; }
  table.chart th, table.chart td { padding: 5px 8px; text-align: left; border-bottom: 1px solid #eef2f7; overflow-wrap: anywhere; vertical-align: middle; }
  table.chart thead th { background: #0b2956; color: #ffffff; font-size: 8px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 7px 8px; border-bottom: none; }
  table.chart thead th.th-date { text-align: center; letter-spacing: 0.04em; }
  table.chart tbody tr:last-child td { border-bottom: none; }
  tbody tr:nth-child(even):not(.section-row) td { background: #fbfcfe; }
  tr.section-row td { background: #eff6ff; color: #0b2956; font-size: 8.5px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; padding: 5px 8px; box-shadow: inset 3px 0 0 #1d4ed8; }
  td.field-label { font-weight: 600; color: #1e293b; }
  td.field-range { color: #64748b; font-size: 9px; border-right: 1px solid #eef2f7; }
  td.field-value { text-align: center; font-weight: 600; color: #0f172a; font-variant-numeric: tabular-nums; }
  td.field-value.is-empty { color: #cbd5e1; font-weight: 400; }
  .v { display: inline-block; padding: 1px 7px; border-radius: 999px; border: 1px solid transparent; }
  .v i { font-style: normal; font-size: 7px; font-weight: 900; margin-left: 3px; vertical-align: 1px; }
  .v-ok { color: #047857; font-weight: 700; }
  .v-high { color: #b45309; background: #fff7ed; border-color: #fed7aa; font-weight: 700; }
  .v-low { color: #b91c1c; background: #fef2f2; border-color: #fecaca; font-weight: 700; }

  .disclaimer-footer { margin-top: 10px; padding: 7px 11px; border: 1px solid #fecaca; border-left: 3px solid #dc2626; border-radius: 8px; background: #fffafa; break-inside: avoid; page-break-inside: avoid; }
  .disclaimer-header { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
  .disclaimer-badge { font-size: 9.5px; font-weight: 900; color: #dc2626 !important; letter-spacing: 0.07em; text-transform: uppercase; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 4px; padding: 1.5px 7px; display: inline-block; }
  .disclaimer-sub { font-size: 8px; font-weight: 700; color: #991b1b; text-transform: uppercase; letter-spacing: 0.04em; }
  .disclaimer-body { font-size: 8px; color: #475569; line-height: 1.4; text-align: justify; }
  .disclaimer-ta { font-size: 7.8px; color: #7f1d1d; line-height: 1.35; margin-top: 3px; padding-top: 3px; border-top: 1px dashed #fecaca; }
</style>
</head>
<body>
${pageBlocks}
</body>
</html>`;
}

/**
 * Renders HTML to a PDF file via headless Chrome. Throws on failure.
 *
 * Each call gets its own `--user-data-dir`. Without it, every invocation shares
 * Chrome's default profile directory and its `SingletonLock` file — the first
 * concurrent (or not-yet-cleaned-up) launch wins the lock and every other one
 * fails outright with "Failed to create a ProcessSingleton for your profile
 * directory", which is exactly the kind of failure that looks like a flaky EMR
 * fetch (it happens after the chart data is already fetched) but isn't.
 *
 * `--virtual-time-budget` is a leftover of old headless Chrome and is not
 * reliably honored under `--headless=new` — observed in testing to leave the
 * process running for minutes past its supposed 8-second budget. The hard
 * `timeout` below is what actually bounds this: execFile SIGTERMs (then
 * SIGKILLs) the process if it's still running after RENDER_TIMEOUT_MS, turning
 * a silent multi-minute hang into a fast, clear, retryable failure.
 */
const RENDER_TIMEOUT_MS = 60_000;

export async function renderHtmlToPdf(html, outPath) {
  const tmpHtmlPath = path.join(os.tmpdir(), `investigation-pdf-${crypto.randomUUID()}.html`);
  const profileDir = path.join(os.tmpdir(), `chrome-profile-${crypto.randomUUID()}`);
  fs.writeFileSync(tmpHtmlPath, html, 'utf8');

  try {
    await execFileAsync(
      CHROME_BIN,
      [
        '--headless=new',
        '--disable-gpu',
        // This container has no GPU/Vulkan driver at all. Without these, ANGLE's
        // Vulkan backend probe fails and the GPU process crash-loops retrying
        // (visible in logs as repeated "Exiting GPU process due to errors during
        // initialization") before falling back to software rendering — on a slow
        // host that loop alone can eat the whole render timeout. These flags skip
        // the GPU process and Vulkan probing entirely; this is the standard flag
        // set for running headless Chrome/Chromium in a container.
        '--disable-software-rasterizer',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--no-sandbox',
        `--user-data-dir=${profileDir}`,
        '--virtual-time-budget=8000',
        `--print-to-pdf=${outPath}`,
        '--no-pdf-header-footer',
        `file://${tmpHtmlPath}`,
      ],
      // SIGKILL, not the default SIGTERM: Chromium's multi-process tree (zygote,
      // renderer, gpu-process) doesn't reliably tear itself down on SIGTERM under
      // load, which left orphaned children still writing into the profile dir —
      // causing the *cleanup* below to fail with ENOTEMPTY and mask whatever the
      // real render outcome was.
      { timeout: RENDER_TIMEOUT_MS, killSignal: 'SIGKILL' },
    );

    // Chromium can exit 0 under --headless=new + --virtual-time-budget without
    // ever having written the output file (observed in testing) — silently
    // continuing would surface as a confusing ENOENT from deep inside the MinIO
    // upload instead of a clear, retryable error from the actual point of failure.
    if (!fs.existsSync(outPath)) {
      throw new Error('Chrome exited without producing a PDF file');
    }
  } finally {
    fs.rmSync(tmpHtmlPath, { force: true });
    // Best-effort: a still-unwinding Chromium subprocess can transiently hold
    // files open here. Failing to clean up a temp dir is not worth failing (or
    // masking the result of) the whole PDF generation attempt over.
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[pdf] could not remove temp profile dir ${profileDir}: ${error.message}`);
    }
  }
}

/**
 * Fetches or builds the OP investigation chart for one patient (`regNo`) on a
 * date (`date`, YYYY-MM-DD) or explicit window (`fromDate`..`toDate`).
 */
/**
 * Runs EMR chart retrieval (or uses pre-fetched approved rows) and returns
 * `{ ok: true, chart }` or `{ ok: false, reason, error }`.
 */
export async function fetchPatientChart({ regNo, fromDate, toDate, date, rows = null }) {
  let chart;
  if (Array.isArray(rows) && rows.length) {
    try {
      chart = await buildInvestigationChart(rows);
    } catch (error) {
      return { ok: false, reason: 'TECHNICAL', error: `EMR chart build failed: ${error.message}` };
    }
  } else {
    const mdy = date ? toEmrMdy(date) : '';
    const from = fromDate || (mdy ? `${mdy} 00:00` : '');
    const to = toDate || (mdy ? `${mdy} 23:59` : '');
    const result = await searchInvestigation(regNo, from, to);
    if (!result.ok) {
      return { ok: false, reason: 'TECHNICAL', error: `EMR search failed: ${result.error}` };
    }
    chart = result.chart;
  }

  if (!chart?.chartDates?.length) {
    return {
      ok: false,
      reason: 'NO_DATA',
      error: 'No renderable OP lab orders found for this UHID in the selected window.',
    };
  }
  return { ok: true, chart };
}

/** Active OP lab PDF source mode based on Master Settings (`opReports.usePdfTemplate`). */
export function currentPdfMode() {
  return setting('opReports.usePdfTemplate') ? 'template' : 'emr';
}

async function resolveEmrOrderRows({ regNo, fromDate, toDate, date, rows }) {
  if (Array.isArray(rows) && rows.length) return { ok: true, rows };
  const mdy = date ? toEmrMdy(date) : '';
  const res = await fetchOpLabOrders({
    regNo,
    fromDate: fromDate || (mdy ? `${mdy} 00:00` : undefined),
    toDate: toDate || (mdy ? `${mdy} 23:59` : undefined),
  });
  if (!res.ok) return { ok: false, reason: 'TECHNICAL', error: `EMR search failed: ${res.error}` };
  if (!res.data?.length) return { ok: false, reason: 'NO_DATA', error: 'No OP lab orders found for this UHID in the selected window.' };
  return { ok: true, rows: res.data };
}

async function generateEmrOriginalPdf({ regNo, fromDate, toDate, date, rows, objectKey }) {
  const orders = await resolveEmrOrderRows({ regNo, fromDate, toDate, date, rows });
  if (!orders.ok) return orders;

  const emrPdf = await fetchOriginalEmrLabPdf(orders.rows, { requireAllApproved: true });
  if (!emrPdf.ok) return emrPdf;

  await uploadPdfBuffer(objectKey, emrPdf.pdfBuffer);

  let chart = null;
  try {
    chart = await buildInvestigationChart(orders.rows, { prefetchedHtmlByOrderId: emrPdf.htmlByOrderId });
  } catch (error) {
    console.warn(`[pdf] offline chart indexing skipped for ${regNo}: ${error.message}`);
  }

  return {
    ok: true,
    pdfMode: 'emr',
    dateCount: chart?.chartDates?.length || 1,
    fetchErrors: emrPdf.fetchErrors || [],
    patientMeta: chart?.patientMeta || {},
    reqNos: emrPdf.reqNos || [],
    emrPdfUrls: emrPdf.emrPdfUrls || [],
    results: chart ? flattenChartResults(chart) : [],
    objectKey,
  };
}

export async function generatePatientPdf({
  regNo,
  fromDate,
  toDate,
  rows = null,
  hospital,
  date,
  physicianName,
  department,
  visitType,
  tokenNo,
  usePdfTemplate,
}) {
  const templateMode = typeof usePdfTemplate === 'boolean' ? usePdfTemplate : setting('opReports.usePdfTemplate');
  const objectKey = reportObjectKey(date, regNo);

  if (!templateMode) {
    return generateEmrOriginalPdf({ regNo, fromDate, toDate, date, rows, objectKey });
  }

  const fetched = await fetchPatientChart({ regNo, fromDate, toDate, date, rows });
  if (!fetched.ok) return fetched;
  const result = fetched;

  const html = buildInvestigationChartHtml({
    hospital,
    regNo: regNo || result.chart.patientMeta?.regNo,
    chart: result.chart,
    physicianName,
    department,
    visitType,
    tokenNo,
  });
  const tmpPdfPath = path.join(os.tmpdir(), `op-lab-pdf-${crypto.randomUUID()}.pdf`);

  try {
    await renderHtmlToPdf(html, tmpPdfPath);
    await uploadPdfFile(objectKey, tmpPdfPath);

    return {
      ok: true,
      pdfMode: 'template',
      dateCount: result.chart.chartDates.length,
      fetchErrors: result.chart.fetchErrors || [],
      patientMeta: result.chart.patientMeta,
      reqNos: result.chart.reqNos || [],
      // Every value in the chart as flat rows, stored for the Lab Finder search.
      results: flattenChartResults(result.chart),
      objectKey,
    };
  } finally {
    fs.rmSync(tmpPdfPath, { force: true });
  }
}
