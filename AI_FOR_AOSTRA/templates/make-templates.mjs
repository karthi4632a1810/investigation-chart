// Builds the Lab Report and Discharge Summary templates with the portal's real
// rendering code and a made-up patient (no real patient data). Run inside the
// backend container: node make-templates.mjs  → /tmp/aostra/*
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { config } from './src/config.js';
import { buildInvestigationChartHtml, renderHtmlToPdf, flattenChartResults } from './src/services/investigationPdfService.js';
import { BRAND_CSS, formatGeneratedDate, letterheadHtml } from './src/services/pdfBranding.js';

const OUT = '/tmp/aostra';
fs.mkdirSync(OUT, { recursive: true });

// ---------- 1. Lab report (Diagnostics Summary) ----------
const dates = ['29-09-2026', '30-09-2026', '01-10-2026', '02-10-2026'];
const field = (id, label, range) => ({ id, label, range });
const template = {
  'COMPLETE BLOOD COUNT': [field('hb', 'HAEMOGLOBIN', '11 - 14'), field('wbc', 'TOTAL WBC COUNT', '4000 - 11000'), field('plt', 'PLATELET COUNT', '150000 - 450000'), field('pcv', 'PCV', '33 - 42')],
  'RENAL FUNCTION TEST': [field('urea', 'BLOOD UREA', '15 - 40'), field('cr', 'SERUM CREATININE', '0.3 - 0.7')],
  'SERUM ELECTROLYTES': [field('na', 'SODIUM', '135 - 145'), field('k', 'POTASSIUM', '3.5 - 5.1'), field('cl', 'CHLORIDE', '98 - 107')],
  'URINE ROUTINE': [field('ug', 'URINE GLUCOSE', ''), field('up', 'URINE PROTEIN', ''), field('pus', 'PUS CELLS', '0 - 5')],
  '': [field('bg', 'BLOOD GROUP', ''), field('crp', 'C-REACTIVE PROTEIN', '< 6')],
};
const v = (a, b, c, d) => Object.fromEntries([a, b, c, d].map((x, i) => [dates[i], x]).filter(([, x]) => x !== undefined));
const chartValues = {
  hb: v('9.8', '10.2', undefined, '11.4'),
  wbc: v('15600', '12800', '9800', '8400'),
  plt: v('210000', undefined, '245000', undefined),
  pcv: v('30.1', '31.5', undefined, '34.2'),
  urea: v('42', undefined, '28', undefined),
  cr: v('0.6', undefined, '0.5', undefined),
  na: v('132', '136', '138', undefined),
  k: v('4.2', '4.0', '4.4', undefined),
  cl: v('101', '102', undefined, undefined),
  ug: v('NIL', undefined, undefined, 'NIL'),
  up: v('TRACE', undefined, undefined, 'NIL'),
  pus: v('8 - 10', undefined, undefined, '2 - 3'),
  bg: v('O POSITIVE'),
  crp: v('24', undefined, '9', '4'),
};
const chart = {
  chartDates: dates,
  chartValues,
  template,
  patientMeta: { name: 'BABY.ARUN KUMAR', age: '2 Y 4 M', sex: 'MALE', bed: '312', ip: 'IP07000123', ward: 'PAEDIATRIC WARD', unit: 'PAEDIATRICS' },
};
const labHtml = buildInvestigationChartHtml({ hospital: config.hospital, regNo: '6100000', ipNo: 'IP07000123', chart, physicianName: 'ANAND R' });
fs.writeFileSync(path.join(OUT, 'lab-report.template.html'), labHtml);
await renderHtmlToPdf(labHtml, path.join(OUT, 'lab-report.sample.pdf'));
fs.writeFileSync(path.join(OUT, 'lab-report.sample-rows.json'), JSON.stringify(flattenChartResults(chart).slice(0, 12), null, 2));

// ---------- 2. Discharge summary ----------
// The same CSS and DOM rewrite the portal applies to the EMR's pSummary.aspx page,
// taken from dischargeSummaryService.js, run on an EMR-shaped page with made-up content.
const src = fs.readFileSync('./src/services/dischargeSummaryService.js', 'utf8');
const cssStart = src.indexOf('const OVERRIDE_CSS = `') + 'const OVERRIDE_CSS = `'.length;
const cssEnd = src.indexOf('\n`;', cssStart);
const OVERRIDE_CSS = src.slice(cssStart, cssEnd).replace('${BRAND_CSS}', BRAND_CSS);
const fnStart = src.indexOf('await page.evaluate((letterheadHtml, formattedDate) => {') + 'await page.evaluate('.length;
const fnEnd = src.indexOf('}, letterheadHtml(hospital', fnStart) + 1;
const extraction = src.slice(fnStart, fnEnd);

const P = (t) => `<p class="MsoNormal">${t}</p>`;
const emrPage = `<!doctype html><html><head><meta charset="utf-8"><title>pSummary</title></head><body>
<div id="divSummary">
  <table class="tblIPname"><tr><td class="trpatname">BABY.ARUN KUMAR</td></tr><tr><td>2 Y 4 M / MALE</td></tr></table>
  <table class="prHeader">
    <tr><td>Register Number</td><td>:</td><td>6100000</td><td>IP Number</td><td>:</td><td>IP07000123</td></tr>
    <tr><td>Admitted On</td><td>:</td><td>29-09-2026 11:05</td><td>Discharged On</td><td>:</td><td>02-10-2026 10:39</td></tr>
    <tr><td>Ward Name</td><td>:</td><td>PAEDIATRIC WARD</td><td>Bed No</td><td>:</td><td>312</td></tr>
  </table>
  <div class="dochdr"><span class="txtdochdr">Dr. ANAND R</span></div>
  <table id="tblMain"><tr><td><div class="sumContent">
    ${P('<b>FINAL DIAGNOSIS:</b>')}
    ${P('1. ACUTE BRONCHIOLITIS')}
    ${P('2. MILD DEHYDRATION - CORRECTED')}
    ${P('<b>CHIEF COMPLAINTS:</b>')}
    ${P('Fever for 3 days, cough and cold for 4 days, fast breathing for 1 day.')}
    ${P('<b>HISTORY OF PRESENTING ILLNESS:</b>')}
    ${P('Child was apparently normal 4 days back, then developed cough and cold followed by high-grade fever. Reduced oral intake for 1 day. No seizures, no vomiting.')}
    ${P('<b>PAST HISTORY:</b>')}
    ${P('No similar complaints in the past. Immunisation up to date for age.')}
    ${P('<b>COURSE IN HOSPITAL:</b>')}
    ${P('Admitted in the paediatric ward. Started on IV fluids, nebulisation and antipyretics. Fever settled by day 2, oral intake improved, breathing normal on room air.')}
    ${P('<b>TREATMENT GIVEN:</b>')}
    <table class="MsoNormalTable">
      <tr><td>S.NO</td><td>DRUG NAME</td><td>DOSE</td><td>ROUTE</td><td>FREQUENCY</td></tr>
      <tr><td>1</td><td>INJ. CEFTRIAXONE</td><td>500 MG</td><td>IV</td><td>12th hourly</td></tr>
      <tr><td>2</td><td>NEB. SALBUTAMOL</td><td>0.5 ML</td><td>INH</td><td>6th hourly</td></tr>
      <tr><td>3</td><td>SYP. PARACETAMOL</td><td>5 ML</td><td>ORAL</td><td>SOS</td></tr>
    </table>
    ${P('<b>STATUS DURING DISCHARGE:</b>')}
    <table class="MsoNormalTable">
      <tr><td>HEART RATE</td><td>RESPIRATORY RATE</td><td>TEMPERATURE</td><td>SATURATION</td></tr>
      <tr><td>112 /min</td><td>28 /min</td><td>98.4 F</td><td>98 %</td></tr>
    </table>
    ${P('DISCHARGED STABLE')}
    ${P('<b>DISCHARGE ADVICE:</b>')}
    ${P('1. SYP. AMOXICILLIN 5 ML - TWICE A DAY FOR 5 DAYS')}
    ${P('2. SYP. PARACETAMOL 5 ML - IF FEVER ABOVE 100 F')}
    ${P('3. Plenty of oral fluids, continue breast feeding.')}
    ${P('<b>REVIEW ADVICE:</b>')}
    ${P('Review in paediatric OPD after 5 days or earlier if fever, fast breathing or poor feeding.')}
    ${P('SUMMARY PREPARED BY: Dr. PRIYA M')}
    ${P('SUMMARY VERIFIED BY: Dr. ANAND R')}
    ${P('Signature &amp; Seal')}
  </div></td></tr></table>
  <div class="tablerow"><span class="clsUser">ward.user 02-10-2026 10:45</span></div>
</div></body></html>`;
fs.writeFileSync(path.join(OUT, 'discharge-summary.emr-input.example.html'), emrPage);

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setContent(emrPage, { waitUntil: 'load' });
await page.addStyleTag({ content: OVERRIDE_CSS });
const lh = letterheadHtml(config.hospital || {}, { title: 'Discharge Summary', subtitle: 'Clinical summary of the hospital stay', meta: `Generated ${formatGeneratedDate()}` });
const result = await page.evaluate(`(${extraction})(${JSON.stringify(lh)}, ${JSON.stringify('2026-10-02')})`);
await page.evaluate(async () => {
  await Promise.all(Array.from(document.querySelectorAll('img')).map((img) => (img.complete ? null : img.decode().catch(() => {}))));
});
fs.writeFileSync(path.join(OUT, 'discharge-summary.template.html'), await page.content());
await page.pdf({ path: path.join(OUT, 'discharge-summary.sample.pdf'), printBackground: true, format: 'A4' });
await browser.close();
console.log('summary extraction:', JSON.stringify({ patName: result.patName, regNo: result.regNo, sections: result.paragraphSections.map((s) => s.label) }));
console.log(fs.readdirSync(OUT).map((f) => `${f} ${fs.statSync(path.join(OUT, f)).size}`).join('\n'));
process.exit(0);
