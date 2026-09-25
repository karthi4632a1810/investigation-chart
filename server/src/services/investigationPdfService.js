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
function getStatusColor(val, rangeStr) {
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

function chunkArray(array, size) {
  const results = [];
  for (let i = 0; i < array.length; i += size) results.push(array.slice(i, i + size));
  return results;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

    if (!isIndividualSection) {
      body += `<tr class="section-row"><td colspan="${2 + dates.length}">${esc(sectionName)}</td></tr>`;
    }

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
        const val = chartValues[field.id]?.[d] ?? '';
        const color = getStatusColor(val, field.range);
        const style = color ? ` style="color:${color};font-weight:bold;"` : '';
        body += `<td class="field-value ${val ? 'filled' : 'empty-val'}"${style}>${esc(val || '—')}</td>`;
      }
      body += '</tr>';
    }
  }

  const headCols = dates.map((d) => `<th style="width:${dateColWidth}%;">${esc(d)}</th>`).join('');
  return `<table class="chart"><thead><tr><th style="width:26%;">Parameter</th><th style="width:18%;">Ref. Range</th>${headCols}</tr></thead><tbody>${body}</tbody></table>`;
}

let defaultLogoDataUri = '';
try {
  const logoFile = new URL('../assets/logo.png', import.meta.url);
  if (fs.existsSync(logoFile)) {
    defaultLogoDataUri = `data:image/png;base64,${fs.readFileSync(logoFile).toString('base64')}`;
  }
} catch {
  // fallback to hospital.logoPath if local asset cannot be read
}

function renderLetterhead(hospital, regNo) {
  const logoSrc = defaultLogoDataUri || hospital.logoPath || '';
  return `
    <div class="letterhead">
      <div class="letterhead-logo">${logoSrc ? `<img src="${esc(logoSrc)}" onerror="this.style.display='none'" />` : ''}</div>
      <div class="letterhead-name">
        <div class="hosp-name-en">${esc(hospital.nameEn)}</div>
        <div class="hosp-name-ta">${esc(hospital.nameTa)}</div>
        <div class="hosp-address">${hospital.address || ''}</div>
      </div>
      <div class="letterhead-title">
        <div class="chart-title-main">INVESTIGATION CHART</div>
        <div class="chart-regno">Reg No: ${esc(regNo)}</div>
      </div>
    </div>`;
}

function pf(label, value) {
  const hasVal = String(value || '').trim() !== '';
  return `<div class="pf"><span>${esc(label)}</span><b class="${hasVal ? '' : 'blank'}">${hasVal ? esc(value) : '—'}</b></div>`;
}

function renderPatientStrip(meta) {
  return `<div class="patient-strip">
    ${pf('Patient Name', meta?.name)}
    ${pf('Age', meta?.age)}
    ${pf('Sex', meta?.sex)}
    ${pf('Bed No', meta?.bed)}
    ${pf('IP No', meta?.ip)}
    ${pf('Ward', meta?.ward)}
    ${pf('Unit', meta?.unit)}
  </div>`;
}

export function buildInvestigationChartHtml({ hospital, regNo, chart }) {
  const { chartDates, chartValues, patientMeta, template } = chart;
  const pages = chunkArray(chartDates, 4);

  const pageBlocks = pages
    .map(
      (pageDates, idx) => `
    <div class="chart-page-block">
      ${renderLetterhead(hospital, regNo)}
      ${renderPatientStrip(patientMeta)}
      <div class="chart-card-body">${renderChartTable(pageDates, template, chartValues)}</div>
      <div class="page-footer">
        <span>Page ${idx + 1} of ${pages.length}</span>
        <span>Dates: ${esc(pageDates[0])} to ${esc(pageDates[pageDates.length - 1])}</span>
        <span>${esc(hospital.nameEn || 'Investigation Chart')}</span>
      </div>
    </div>`,
    )
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root {
    --primary: #2563eb; --bg: #f1f5f9; --card: #ffffff; --border: #e2e8f0;
    --text: #1e293b; --muted: #64748b; --letter-blue: #1d4a8f;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; margin: 0; background: #fff; color: var(--text); }
  @page { size: A4 portrait; margin: 8mm; }

  .chart-page-block {
    background: var(--card);
    border: 1px solid #cbd5e1;
    width: 100%;
    page-break-after: always;
    break-after: page;
  }
  .chart-page-block:last-child { page-break-after: auto; break-after: auto; }

  .letterhead { display: flex; align-items: center; gap: 18px; padding: 18px 20px 14px; border-bottom: 3px solid var(--letter-blue); }
  .letterhead-logo { width: 64px; height: 99px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; }
  .letterhead-logo img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .letterhead-name { flex: 1 1 auto; min-width: 220px; }
  .hosp-name-en { font-size: 22px; font-weight: 800; color: var(--letter-blue); letter-spacing: -0.01em; }
  .hosp-name-ta { font-size: 15px; font-weight: 700; color: var(--letter-blue); margin-top: 1px; }
  .hosp-address { font-size: 10.5px; color: var(--muted); margin-top: 5px; line-height: 1.5; }
  .letterhead-title { flex: 0 0 auto; text-align: right; min-width: 170px; }
  .chart-title-main { font-size: 18px; font-weight: 800; color: var(--letter-blue); background: #dbeafe; padding: 7px 14px; border-radius: 8px; letter-spacing: 0.02em; display: inline-block; }
  .chart-regno { margin-top: 8px; font-size: 15px; font-weight: 700; color: var(--text); }

  .patient-strip { display: flex; flex-wrap: wrap; gap: 22px 30px; padding: 14px 20px 16px; border-bottom: 1px solid var(--border); background: #f8fafc; }
  .patient-strip .pf { font-size: 13px; display: flex; align-items: baseline; gap: 6px; min-width: 140px; }
  .patient-strip .pf span { color: var(--muted); font-weight: 700; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.03em; white-space: nowrap; }
  .patient-strip .pf b { font-weight: 600; color: var(--text); border-bottom: 1px dotted #94a3b8; padding-bottom: 1px; min-width: 60px; display: inline-block; }
  .patient-strip .pf b.blank { color: #cbd5e1; }

  .chart-card-body { padding: 10px; }
  table.chart { min-width: 0; width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 11px; }
  table.chart th, table.chart td { border: 1px solid #cbd5e1; padding: 5px 6px; text-align: left; word-break: break-word; overflow-wrap: break-word; }
  table.chart thead th { background: #1e3a8a; color: #fff; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  tr.section-row td { background: #dbeafe; font-weight: 800; color: #1e3a8a; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.04em; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  td.field-label { font-weight: 600; white-space: nowrap; }
  td.field-range { color: var(--muted); font-size: 10.5px; white-space: nowrap; }
  td.field-value { font-weight: 700; color: #0f172a; }
  td.field-value.filled { background: #f0fdf4; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  td.field-value.empty-val { color: #cbd5e1; }

  .page-footer { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: #f8fafc; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); font-weight: 600; }
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
export async function generatePatientPdf({ ipNo, regNo, admissionDate, dischargeDate, hospital, date }) {
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

  const html = buildInvestigationChartHtml({ hospital, regNo: ipNo, chart: result.chart });
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
      objectKey,
    };
  } finally {
    fs.rmSync(tmpPdfPath, { force: true });
  }
}
