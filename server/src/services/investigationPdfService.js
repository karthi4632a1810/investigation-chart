/**
 * Renders a patient's full investigation chart (admission -> discharge) to a PDF,
 * in the same visual format as the app's own print view (InvestigationChart.jsx +
 * App.css). Shared by the manual CLI script and the hourly discharge automation so
 * there is exactly one place that knows what the report looks like.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { searchInvestigation } from './emrService.js';
import { reportObjectKey, uploadPdfFile } from './storageService.js';
import { BRAND_CSS, cleanPatientName, esc, formatGeneratedDate, letterheadHtml, patientCardHtml } from './pdfBranding.js';

/**
 * Pulls the search window's start back by `hoursBack` hours. Confirmed against
 * the live EMR: a patient's lab orders can be timestamped *well before* her
 * recorded admission time (pre-admission / pre-op workup carried into the
 * inpatient record) — two observed cases so far, one 12 hours before admission,
 * another a full 3 days before. An exact admission->discharge window silently
 * misses these even though the search itself "succeeds" with zero rows.
 * Reformats to MM/DD/YYYY HH:mm, one of the formats normalizeSearchDate already
 * accepts.
 */
function widenWindowStart(admissionDateStr, hoursBack) {
  const m = String(admissionDateStr).match(/^(\d{1,2})-(\d{1,2})-(\d{4})[ T](\d{2}):(\d{2})/);
  if (!m) return admissionDateStr;

  const [, day, month, year, hour, minute] = m;
  const d = new Date(+year, +month - 1, +day, +hour, +minute);
  d.setHours(d.getHours() - hoursBack);

  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// A week, not a day: the second real case needed 3 days of headroom, and
// pre-op workups can reasonably be ordered up to about a week ahead of an
// elective admission. Kept bounded (not unbounded) so a patient with an
// unrelated admission months earlier under the same REG NO doesn't have that
// old stay's results folded into this one.
const PRE_ADMISSION_BUFFER_HOURS = 24 * 7;

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

/**
 * UHID leads the identifier row (with IP number, bed and report period), not a
 * separate badge in the letterhead. The EMR's IP column sometimes repeats the
 * prefix ("IP IP07026996"), so the caller's own IP number wins when known.
 */
function renderPatientCard(meta, { regNo, ipNo, bloodGroup, physicianName, reportPeriod }) {
  const ageSex = [meta?.age, meta?.sex].filter((v) => String(v || '').trim()).join(' · ');
  const ip = ipNo || String(meta?.ip || '').replace(/^IP\s+(?=IP)/i, '');
  return patientCardHtml({
    name: cleanPatientName(meta?.name),
    tags: [
      { text: ageSex, tone: 'blue' },
      { text: meta?.unit, tone: 'green' },
      { text: bloodGroup ? `Blood Group ${bloodGroup}` : '', tone: 'rose' },
    ],
    fields: [
      { label: 'UHID', value: regNo, id: true, key: true },
      { label: 'IP Number', value: ip, id: true },
      { label: 'Bed No.', value: meta?.bed },
      { label: 'Report Period', value: reportPeriod },
      { label: 'Assigned Ward', value: meta?.ward, wide: true },
      { label: 'Unit / Specialty', value: meta?.unit },
      { label: 'Treating Physician', value: physicianName },
    ],
  });
}

export function buildInvestigationChartHtml({ hospital, regNo, ipNo, chart, physicianName, subtitle = 'Laboratory investigation chart · admission to discharge' }) {
  const { chartDates, chartValues, patientMeta, template } = chart;
  const pages = chunkArray(chartDates, 4);
  const bloodGroup = findLatestFieldValue(template, chartValues, chartDates, /blood\s*group/i);
  const reportPeriod =
    chartDates.length > 1 ? `${chartDates[0]} – ${chartDates[chartDates.length - 1]}` : chartDates[0] || '';
  const letterhead = letterheadHtml(hospital, {
    title: 'Diagnostics Summary',
    subtitle,
    meta: `Generated ${formatGeneratedDate()}`,
  });
  const patientCard = renderPatientCard(patientMeta, { regNo, ipNo, bloodGroup, physicianName, reportPeriod });

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
              This is a digitally generated diagnostic summary for information only and is not a legal document. The signed report issued by the authorised consultant is final and shall prevail. Please consult your treating doctor for interpretation. This WhatsApp copy is not valid for legal, insurance or other claims.
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
 * Fetches the full chart for one patient across the given date window, renders
 * it to a PDF, and uploads it to MinIO at `<date>/<ipNo>.pdf`.
 *
 * Two corrections over a literal admission->discharge search, both confirmed
 * against the live EMR rather than assumed:
 *
 * 1. The search window starts PRE_ADMISSION_BUFFER_HOURS before the recorded
 *    admission time. A patient's lab orders can predate her official admission
 *    timestamp (ER / pre-admission workup carried into the inpatient record —
 *    one observed case had orders 12 hours earlier), and an exact window
 *    silently excludes them even though the search itself "succeeds" with zero
 *    rows.
 * 2. Tries the IP number first; some patients' lab orders are filed under their
 *    REG NO without a matching IP NO on the order record, which makes an
 *    IP-number search come back empty even though the patient has real results
 *    (confirmed directly: IP-number search 0 rows, REG-number search 24 rows,
 *    same patient, same window). When `regNo` is available and the IP search
 *    finds nothing, retry with it before giving up.
 *
 * @returns {Promise<{ok: true, dateCount: number, fetchErrors: string[], objectKey: string} | {ok: false, error: string}>}
 */
/**
 * The EMR fetch half of generatePatientPdf (window widening + REG NO fallback,
 * see below), shared with the lab-results backfill so both find exactly the
 * same orders. Returns the same shape as generatePatientPdf's failures, or
 * `{ ok: true, chart }`.
 */
export async function fetchPatientChart({ ipNo, regNo, admissionDate, dischargeDate }) {
  const searchFromDate = widenWindowStart(admissionDate, PRE_ADMISSION_BUFFER_HOURS);

  let result = await searchInvestigation(ipNo, searchFromDate, dischargeDate);

  if (regNo && (!result.ok || !result.chart?.chartDates?.length)) {
    const byRegNo = await searchInvestigation(regNo, searchFromDate, dischargeDate);
    if (byRegNo.ok && byRegNo.chart?.chartDates?.length) {
      result = byRegNo;
    }
  }

  if (!result.ok) {
    // A real technical failure (timeout, connection reset, EMR error) — worth
    // retrying, since the same request could well succeed a few seconds later.
    return { ok: false, reason: 'TECHNICAL', error: `EMR search failed: ${result.error}` };
  }
  if (!result.chart?.chartDates?.length) {
    // Not a failure of this system — both identifiers were searched, with the
    // window already widened a week before admission, and the EMR still has
    // zero lab orders for this patient. Some short/observation admissions
    // genuinely never have any labs ordered. Retrying can't produce data that
    // was never entered, so this is a terminal outcome, not a transient one.
    return {
      ok: false,
      reason: 'NO_DATA',
      error: 'No lab orders found for this patient (checked both IP and REG number, admission week onward).',
    };
  }
  return { ok: true, chart: result.chart };
}

export async function generatePatientPdf({ ipNo, regNo, admissionDate, dischargeDate, hospital, date, physicianName }) {
  const fetched = await fetchPatientChart({ ipNo, regNo, admissionDate, dischargeDate });
  if (!fetched.ok) return fetched;
  const result = fetched;

  // Display the real Reg No/UHID when the caller has it — the lab EMR search
  // above only ever needs `ipNo`/`regNo` as alternate *search* identifiers,
  // but the letterhead should show the patient's actual UHID, not whichever
  // one happened to be used to find the results.
  const html = buildInvestigationChartHtml({ hospital, regNo: regNo || ipNo, ipNo, chart: result.chart, physicianName });
  const tmpPdfPath = path.join(os.tmpdir(), `investigation-pdf-${crypto.randomUUID()}.pdf`);

  try {
    await renderHtmlToPdf(html, tmpPdfPath);
    const objectKey = reportObjectKey(date, ipNo);
    await uploadPdfFile(objectKey, tmpPdfPath);

    return {
      ok: true,
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
