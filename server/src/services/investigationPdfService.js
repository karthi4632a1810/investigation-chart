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

const STATUS_LEGEND = `
  <div class="status-legend">
    <span class="legend-dot legend-dot-normal"></span> Within Normal
    <span class="legend-dot legend-dot-high"></span> High
    <span class="legend-dot legend-dot-low"></span> Low
  </div>`;

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
      body += `<tr class="section-row"><td colspan="${2 + dates.length}">🔬 ${esc(sectionName)}</td></tr>`;
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
        const tint = color === 'red' ? 'tint-low' : color === '#e67e22' ? 'tint-high' : '';
        const style = color ? ` style="color:${color};font-weight:bold;"` : '';
        body += `<td class="field-value ${val ? 'filled' : 'empty-val'} ${tint}"${style}>${esc(val || '—')}</td>`;
      }
      body += '</tr>';
    }
  }

  const headCols = dates.map((d) => `<th style="width:${dateColWidth}%;">${esc(d)}</th>`).join('');
  return `${STATUS_LEGEND}<table class="chart"><thead><tr><th style="width:26%;">Parameter</th><th style="width:18%;">Ref. Range</th>${headCols}</tr></thead><tbody>${body}</tbody></table>`;
}

function loadAssetDataUri(relPath) {
  try {
    const file = new URL(relPath, import.meta.url);
    if (fs.existsSync(file)) {
      return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    }
  } catch {
    // fall through to empty string — caller omits the <img> entirely
  }
  return '';
}

const defaultLogoDataUri = loadAssetDataUri('../assets/logo.png');
const nablBadgeDataUri = loadAssetDataUri('../assets/nabl.png');
const nabhBadgeDataUri = loadAssetDataUri('../assets/nabh.png');

function renderLetterhead(hospital, regNo) {
  const logoSrc = defaultLogoDataUri || hospital.logoPath || '';
  const badges = [
    nablBadgeDataUri ? `<img class="accred-badge-img" src="${nablBadgeDataUri}" alt="NABL Accredited Laboratory" title="NABL Accredited Laboratory" />` : '',
    nabhBadgeDataUri ? `<img class="accred-badge-img" src="${nabhBadgeDataUri}" alt="NABH Accredited Hospital" title="NABH Accredited Hospital" />` : '',
  ].join('');

  return `
    <div class="top-ribbon"></div>
    <div class="letterhead">
      <div class="letterhead-left">
        <div class="letterhead-logo">${logoSrc ? `<img src="${esc(logoSrc)}" onerror="this.style.display='none'" />` : ''}</div>
        <div class="letterhead-name">
          <div class="hosp-name-en">${esc(hospital.nameEn)}</div>
          <div class="hosp-name-ta">${esc(hospital.nameTa)}</div>
          <div class="hosp-address">${hospital.address || ''}</div>
        </div>
      </div>
      <div class="letterhead-right">
        ${badges ? `<div class="accred-badges">${badges}<span class="accred-caption">NABL Lab &amp;<br />NABH Accredited</span></div>` : ''}
        <div class="doc-type-badge">
          <span class="doc-type-label">Document Type</span>
          <span class="doc-type-value">DIAGNOSIS SUMMARY</span>
        </div>
        <div class="regno-badge">
          <span class="regno-label">UHID</span>
          <span class="regno-value">${esc(regNo)}</span>
        </div>
      </div>
    </div>`;
}

function pf(label, value) {
  const hasVal = String(value || '').trim() !== '';
  return `<div class="pf"><span>${esc(label)}</span><b class="${hasVal ? '' : 'blank'}">${hasVal ? esc(value) : '-'}</b></div>`;
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

function renderPatientStrip(meta, { bloodGroup, physicianName, reportPeriod } = {}) {
  const deptTag = String(meta?.unit || '').trim()
    ? `<span class="tag tag-dept">Department: ${esc(meta.unit)}</span>`
    : '';
  const ageSex = [meta?.age, meta?.sex].filter((v) => String(v || '').trim()).join(' | ');
  const clinicalTags = bloodGroup ? `<span class="tag tag-blood">Blood Group: ${esc(bloodGroup)}</span>` : '';

  return `<div class="patient-card">
    <div class="patient-card-header">
      <span class="patient-card-title">Patient Demographics &amp; Admission Info</span>
      <div class="patient-card-tags">${deptTag}</div>
    </div>
    <div class="patient-strip">
      ${pf('Patient Name', meta?.name)}
      ${pf('Age / Sex', ageSex)}
      ${pf('IP Number', meta?.ip)}
      ${pf('Bed No.', meta?.bed)}
      ${pf('Assigned Ward', meta?.ward)}
      ${pf('Unit / Specialty', meta?.unit)}
      ${pf('Treating Physician', physicianName)}
      ${pf('Report Period', reportPeriod)}
    </div>
    ${
      clinicalTags
        ? `<div class="clinical-tags-row"><span class="clinical-tags-label">Clinical Tags:</span>${clinicalTags}</div>`
        : ''
    }
  </div>`;
}

export function buildInvestigationChartHtml({ hospital, regNo, chart, physicianName }) {
  const { chartDates, chartValues, patientMeta, template } = chart;
  const pages = chunkArray(chartDates, 4);
  const bloodGroup = findLatestFieldValue(template, chartValues, chartDates, /blood\s*group/i);
  const reportPeriod =
    chartDates.length > 1 ? `${chartDates[0]} – ${chartDates[chartDates.length - 1]}` : chartDates[0] || '';
  const patientCard = renderPatientStrip(patientMeta, { bloodGroup, physicianName, reportPeriod });

  const pageBlocks = pages
    .map((pageDates, idx) => {
      const isLast = idx === pages.length - 1;
      // The disclaimer only belongs once, at the true end of the document —
      // not repeated on every date-chunk page, and not carrying a "Page X of
      // Y" count that would be wrong whenever a chunk's table overflows onto
      // more physical PDF pages than there are chunks.
      const footer = isLast
        ? `<div class="page-footer disclaimer-footer"><strong class="disclaimer-label">DISCLAIMER:</strong> This is a system-generated diagnosis summary compiled from laboratory records. Please contact ${esc(hospital.nameEn || 'the hospital')} to verify or for clinical correlation.</div>`
        : '';
      return `
    <div class="chart-page-block">
      ${renderLetterhead(hospital, regNo)}
      ${patientCard}
      <div class="chart-card-body">${renderChartTable(pageDates, template, chartValues)}</div>
      ${footer}
    </div>`;
    })
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root {
    --brand-900: #0b2956; --brand-800: #144385; --brand-700: #1b56a7; --brand-50: #f0f5fc;
    --bg: #f1f5f9; --card: #ffffff; --border: #e2e8f0;
    --text: #1e293b; --muted: #64748b;
    --success: #10b981; --warning: #e67e22; --danger: #ef4444;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; margin: 0; background: var(--bg); color: var(--text); }
  @page { size: A4 portrait; margin: 8mm; }

  .chart-page-block {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    width: 100%;
    box-shadow: 0 1px 3px rgba(11, 41, 86, 0.08), 0 4px 14px rgba(11, 41, 86, 0.06);
    page-break-after: always;
    break-after: page;
  }
  .chart-page-block:last-child { page-break-after: auto; break-after: auto; }

  .top-ribbon { height: 6px; background: linear-gradient(90deg, var(--brand-900), var(--brand-800), var(--brand-700)); -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .letterhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px 20px 14px; border-bottom: 1px solid var(--border); }
  .letterhead-left { display: flex; align-items: center; gap: 16px; flex: 1 1 auto; min-width: 0; }
  .letterhead-logo { width: 56px; height: 86px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; }
  .letterhead-logo img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .letterhead-name { flex: 1 1 auto; min-width: 0; }
  .hosp-name-en { font-size: 20px; font-weight: 800; color: var(--brand-800); letter-spacing: -0.01em; }
  .hosp-name-ta { font-size: 13px; font-weight: 700; color: var(--brand-800); margin-top: 1px; }
  .hosp-address { font-size: 7.4px; color: var(--muted); margin-top: 5px; line-height: 1.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .letterhead-right { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 9px; }
  .accred-badges { display: flex; align-items: center; gap: 8px; }
  .accred-badge-img { height: 38px; width: auto; object-fit: contain; }
  .accred-caption { font-size: 8px; font-weight: 700; line-height: 1.25; color: var(--muted); text-align: left; }
  .doc-type-badge { background: var(--brand-50); border: 1px solid #c2dbf3; border-radius: 999px; padding: 5px 16px; text-align: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .doc-type-label { display: block; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--brand-700); }
  .doc-type-value { display: block; font-size: 14px; font-weight: 800; color: var(--brand-900); letter-spacing: 0.02em; }
  .regno-badge { text-align: right; }
  .regno-label { display: block; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .regno-value { display: inline-block; font-size: 13px; font-weight: 800; font-family: 'JetBrains Mono', 'Courier New', monospace; color: var(--brand-900); background: var(--brand-50); border: 1px solid #c2dbf3; border-radius: 5px; padding: 2px 8px; margin-top: 2px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .patient-card { margin: 12px 20px; padding: 12px 15px; background: linear-gradient(135deg, #f8fafc, var(--brand-50)); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 1px 2px rgba(11, 41, 86, 0.05); }
  .patient-card-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; padding-bottom: 7px; margin-bottom: 9px; border-bottom: 1px solid #dbe4ef; }
  .patient-card-title { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.03em; color: var(--brand-800); }
  .patient-card-tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag { font-size: 9.5px; font-weight: 700; border-radius: 999px; padding: 2px 10px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .tag-dept { color: var(--brand-800); background: #e1ecf9; border: 1px solid #c2dbf3; }
  .tag-blood { color: #9f1239; background: #fce7ee; border: 1px solid #fbcfe0; }

  .patient-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 12px; }
  .patient-strip .pf { font-size: 11px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .patient-strip .pf span { color: var(--muted); font-weight: 700; text-transform: uppercase; font-size: 8px; letter-spacing: 0.03em; white-space: nowrap; }
  .patient-strip .pf b { font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .patient-strip .pf:first-child b { font-size: 12.5px; font-weight: 800; }
  .patient-strip .pf b.blank { color: #cbd5e1; font-weight: 500; }

  .clinical-tags-row { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 10px; padding-top: 8px; border-top: 1px solid #dbe4ef; }
  .clinical-tags-label { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }

  .status-legend { display: flex; align-items: center; gap: 14px; padding: 0 4px 8px; font-size: 9.5px; font-weight: 600; color: var(--muted); }
  .legend-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; vertical-align: middle; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .legend-dot-normal { background: var(--success); }
  .legend-dot-high { background: var(--warning); }
  .legend-dot-low { background: var(--danger); }

  .chart-card-body { padding: 0 10px 10px; }
  table.chart { min-width: 0; width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0; font-size: 11px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  table.chart th, table.chart td { border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); padding: 6px 7px; text-align: left; word-break: break-word; overflow-wrap: break-word; }
  table.chart th:last-child, table.chart td:last-child { border-right: none; }
  table.chart thead th { background: var(--brand-800); color: #fff; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 2px solid var(--brand-900); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  tr.section-row td { background: var(--brand-50); font-weight: 800; color: var(--brand-900); text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.04em; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  tbody tr:nth-child(even):not(.section-row) td.field-value { background: #fbfcfe; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  td.field-value.tint-low { background: #fef2f2 !important; }
  td.field-value.tint-high { background: #fff7ed !important; }
  td.field-label { font-weight: 600; white-space: nowrap; }
  td.field-range { color: var(--muted); font-size: 10.5px; white-space: nowrap; }
  td.field-value { font-weight: 700; color: #0f172a; }
  td.field-value.filled { background: #f8fafc; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  td.field-value.empty-val { color: #cbd5e1; }

  .page-footer.disclaimer-footer { display: block; text-align: center; padding: 10px 24px; background: #f8fafc; border-top: 1px solid var(--border); font-size: 9.5px; color: #dc2626; font-weight: 700; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page-footer.disclaimer-footer .disclaimer-label { font-weight: 900; letter-spacing: 0.03em; margin-right: 3px; }
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
export async function generatePatientPdf({ ipNo, regNo, admissionDate, dischargeDate, hospital, date, physicianName }) {
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

  // Display the real Reg No/UHID when the caller has it — the lab EMR search
  // above only ever needs `ipNo`/`regNo` as alternate *search* identifiers,
  // but the letterhead should show the patient's actual UHID, not whichever
  // one happened to be used to find the results.
  const html = buildInvestigationChartHtml({ hospital, regNo: regNo || ipNo, chart: result.chart, physicianName });
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
