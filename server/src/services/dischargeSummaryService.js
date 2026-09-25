/**
 * Fetches the EMR's own discharge summary document (the doctor's clinical note —
 * diagnosis, history, treatment course) for one patient and renders it to a PDF.
 *
 * This is a genuinely different fetch shape from the lab investigation chart:
 * the summary page (pSummary.aspx) renders its content via client-side JS/AJAX
 * after load, so a plain HTTP GET (like emrService.js uses for lab result pages)
 * only returns an empty shell — confirmed directly against the EMR: the raw HTML
 * response contains no patient data at all. Reproducing what the browser does
 * requires an actual browser executing that JS with our session attached, which
 * is why this uses Puppeteer (driving the same Chromium already installed for PDF
 * rendering) instead of the axios+cookiejar client the rest of emrService.js uses.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import puppeteer from 'puppeteer-core';
import { config } from '../config.js';
import { doLogin } from './emrService.js';
import { reportSummaryObjectKey, uploadPdfFile } from './storageService.js';

const CHROME_BIN = process.env.CHROME_PATH || 'google-chrome';
const SUMMARY_TIMEOUT_MS = 45_000;

function esc(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

function buildLetterheadHtml(hospital) {
  const logoSrc = defaultLogoDataUri || hospital?.logoPath || '';
  return `
    <div class="pi-letterhead">
      <div class="pi-letterhead-logo">${logoSrc ? `<img src="${logoSrc}" onerror="this.style.display='none'" />` : ''}</div>
      <div class="pi-letterhead-name">
        <div class="pi-hosp-name-en">${esc(hospital?.nameEn || 'Adhiparasakthi Hospitals')}</div>
        <div class="pi-hosp-name-ta">${esc(hospital?.nameTa || 'ஆதிபராசக்தி மருத்துவமனை')}</div>
        <div class="pi-hosp-address">${hospital?.address || ''}</div>
      </div>
      <div class="pi-letterhead-title">
        <div class="pi-title-badge">DISCHARGE SUMMARY</div>
      </div>
    </div>`;
}

/**
 * The summary content itself is free-text rich content the doctor authored per
 * patient (Word-HTML export style — "MsoNormal" paragraphs, bold inline spans
 * for section headers like "PAST HISTORY" rather than a dedicated heading tag).
 *
 * This styling resets the Word-HTML export styling, fixes fixed-width tables,
 * lays out a modern executive patient demographic card, diagnosis badge,
 * clean responsive clinical narrative typography, styled medical tables, and
 * professional verification, signatures, and emergency helpline blocks.
 */
const OVERRIDE_CSS = `
  @page {
    size: A4 portrait;
    margin: 10mm 12mm 10mm 12mm;
  }
  * {
    box-sizing: border-box !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
    font-size: 10px;
    line-height: 1.45;
    color: #1e293b !important;
    background: #ffffff !important;
    max-width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  font, span, p, td, th, div {
    font-family: inherit !important;
    letter-spacing: normal !important;
  }

  /* Reset outer table container */
  #tblMain {
    width: 100% !important;
    margin: 0 !important;
    border-collapse: collapse !important;
  }
  #tblMain > thead {
    display: none !important;
  }
  #tblMain > tbody > tr > td {
    padding: 0 !important;
    border: none !important;
  }

  /* Letterhead */
  .pi-letterhead {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 0 0 10px 0;
    margin-bottom: 10px;
    border-bottom: 2.5px solid #1d4a8f;
    break-inside: avoid;
  }
  .pi-letterhead-logo {
    width: 66px;
    height: 102px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pi-letterhead-logo img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    image-rendering: -webkit-optimize-contrast;
  }
  .pi-letterhead-name {
    flex: 1 1 auto;
    min-width: 200px;
  }
  .pi-hosp-name-en {
    font-size: 21px;
    font-weight: 800;
    color: #1d4a8f;
    letter-spacing: -0.01em;
    line-height: 1.2;
  }
  .pi-hosp-name-ta {
    font-size: 14px;
    font-weight: 700;
    color: #1d4a8f;
    margin-top: 2px;
    line-height: 1.2;
  }
  .pi-hosp-address {
    font-size: 9.5px;
    color: #64748b;
    margin-top: 4px;
    line-height: 1.45;
  }
  .pi-letterhead-title {
    flex: 0 0 auto;
    text-align: right;
  }
  .pi-title-badge {
    font-size: 12px;
    font-weight: 800;
    color: #ffffff;
    background: linear-gradient(135deg, #1d4a8f, #163d75);
    padding: 6px 14px;
    border-radius: 5px;
    letter-spacing: 0.04em;
    display: inline-block;
    box-shadow: 0 2px 4px rgba(29, 74, 143, 0.15);
  }

  /* Executive Patient Demographics Card */
  .pi-patient-card {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 8px 12px;
    margin-bottom: 8px;
    break-inside: avoid;
  }
  .pi-patient-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #e2e8f0;
    padding-bottom: 5px;
    margin-bottom: 6px;
  }
  .pi-patient-name {
    font-size: 14px;
    font-weight: 800;
    color: #0f172a;
    letter-spacing: -0.01em;
  }
  .pi-patient-tags {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .pi-tag {
    font-size: 9.5px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 4px;
    background: #e2e8f0;
    color: #334155;
  }
  .pi-tag-blue {
    background: #dbeafe;
    color: #1e40af;
  }
  .pi-patient-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px 10px;
    font-size: 10.5px;
  }
  .pi-field {
    display: flex;
    flex-direction: column;
  }
  .pi-field-label {
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
    color: #64748b;
    letter-spacing: 0.03em;
    margin-bottom: 1px;
  }
  .pi-field-val {
    font-weight: 700;
    color: #1e293b;
  }
  .pi-field-val.highlight {
    color: #1d4a8f;
  }

  /* Consultant Banner */
  .pi-consultant-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #eff6ff;
    border-left: 3.5px solid #1d4a8f;
    border-radius: 4px;
    padding: 5px 10px;
    margin-bottom: 8px;
    break-inside: avoid;
  }
  .pi-cb-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .pi-cb-label {
    font-size: 9px;
    font-weight: 800;
    color: #1d4a8f;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pi-cb-name {
    font-size: 12px;
    font-weight: 800;
    color: #0f172a;
  }
  .pi-cb-dept {
    font-size: 9.5px;
    font-weight: 600;
    color: #64748b;
  }

  /* Diagnosis Card */
  .pi-diagnosis-card {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-left: 4px solid #1d4a8f;
    border-radius: 5px;
    padding: 6px 10px;
    margin: 6px 0 8px 0;
    break-inside: avoid;
  }
  .pi-diag-label {
    font-size: 9px;
    font-weight: 800;
    color: #1d4a8f;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    display: block;
    margin-bottom: 2px;
  }
  .pi-diag-val {
    font-size: 12px;
    font-weight: 800;
    color: #0f172a;
    line-height: 1.3;
  }

  /* Section Groups */
  .pi-section-block {
    break-inside: avoid !important;
    page-break-inside: avoid !important;
    margin-top: 8px;
    margin-bottom: 4px;
  }

  /* Section Headings */
  .pi-section-heading {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    font-weight: 800;
    color: #1d4a8f;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 4px 0 3px;
    margin: 6px 0 3px 0;
    border-bottom: 1.5px solid #e2e8f0;
    break-after: avoid !important;
    page-break-after: avoid !important;
    break-inside: avoid !important;
  }
  .pi-section-heading::before {
    content: '';
    display: inline-block;
    width: 3.5px;
    height: 11px;
    background: #1d4a8f;
    border-radius: 2px;
  }

  /* Content Reset */
  .sumContent {
    float: none !important;
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
  }
  p.MsoNormal, .sumContent p {
    font-size: 10px !important;
    line-height: 1.45 !important;
    color: #334155 !important;
    margin: 3px 0 !important;
    text-align: justify;
  }
  p.MsoNormal span, .sumContent span {
    font-size: inherit !important;
    letter-spacing: normal !important;
  }
  /* Bold inside narrative paragraphs: dark charcoal */
  p.MsoNormal b, p.MsoNormal strong,
  .sumContent p b, .sumContent p strong,
  .sumContent p span[style*="font-weight: 700"],
  .sumContent p span[style*="font-weight:700"] {
    color: #1e293b !important;
    font-weight: 600 !important;
  }

  /* Tables: General Reset */
  table.MsoNormalTable, .sumContent table {
    width: 100% !important;
    max-width: 100% !important;
    margin: 3px 0 6px 0 !important;
    border-collapse: collapse !important;
    break-inside: avoid !important;
    page-break-inside: avoid !important;
    font-size: 9.5px !important;
    background: #ffffff !important;
    box-shadow: none !important;
    display: table !important;
  }
  table.MsoNormalTable tr, .sumContent table tr {
    display: table-row !important;
    height: auto !important;
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }
  table.MsoNormalTable td, .sumContent table td,
  table.MsoNormalTable th, .sumContent table th {
    border: 1px solid #cbd5e1 !important;
    padding: 3.5px 6px !important;
    font-size: 9.5px !important;
    vertical-align: middle !important;
    line-height: 1.3 !important;
    display: table-cell !important;
  }

  /* 2-Column Key/Value Medical Tables (Past History, Vitals, etc.) */
  table.pi-kv-table td:first-child {
    background: #f8fafc !important;
    font-weight: 700 !important;
    color: #334155 !important;
    width: 32% !important;
    font-size: 9px !important;
    text-transform: uppercase !important;
  }
  table.pi-kv-table td:last-child {
    background: #ffffff !important;
    color: #1e293b !important;
    font-size: 9.5px !important;
  }

  /* Medication / Data Tables (Treatment Given, Discharge Advice) */
  table.pi-data-table th,
  table.pi-data-table tr.pi-header-row td {
    background: #1d4a8f !important;
    color: #ffffff !important;
    font-weight: 700 !important;
    font-size: 9px !important;
    text-transform: uppercase !important;
    letter-spacing: 0.03em !important;
    border-color: #1d4a8f !important;
    padding: 4px 6px !important;
    text-align: left !important;
  }
  table.pi-data-table tr.pi-header-row td:first-child {
    text-align: center !important;
    width: 34px !important;
  }
  table.pi-data-table tr:not(.pi-header-row) td:first-child {
    text-align: center !important;
    font-weight: 700 !important;
    color: #64748b !important;
    width: 34px !important;
  }
  table.pi-data-table tr:nth-of-type(even) td {
    background: #f8fafc !important;
  }

  /* Vitals Strip Table */
  table.pi-vitals-strip th, table.pi-vitals-strip td {
    text-align: center !important;
    padding: 3px 5px !important;
  }
  table.pi-vitals-strip tr:first-child td {
    background: #f1f5f9 !important;
    font-weight: 700 !important;
    color: #334155 !important;
    font-size: 8.5px !important;
    text-transform: uppercase !important;
  }
  table.pi-vitals-strip tr:last-child td {
    font-weight: 700 !important;
    color: #1d4a8f !important;
    font-size: 10px !important;
  }

  /* Review Advice container */
  .pi-review-advice-block {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 8px 12px;
    margin: 6px 0 8px 0;
    break-inside: avoid;
  }
  .pi-review-advice-block p {
    margin: 2.5px 0 !important;
    color: #1e293b !important;
  }

  /* Verification and Signature Block */
  .pi-verif-strip {
    display: flex;
    justify-content: space-between;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 5px;
    padding: 6px 12px;
    margin: 10px 0 8px 0;
    break-inside: avoid;
  }
  .pi-verif-item {
    font-size: 10px;
    color: #475569;
  }
  .pi-verif-item strong {
    color: #0f172a;
    font-weight: 700;
  }

  /* Signatures Container */
  .pi-signatures-container {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-top: 18px;
    padding-top: 4px;
    break-inside: avoid;
  }
  .pi-sig-block {
    width: 42%;
    text-align: center;
  }
  .pi-sig-line {
    border-bottom: 1px solid #94a3b8;
    height: 30px;
    margin-bottom: 5px;
  }
  .pi-sig-role {
    font-size: 10.5px;
    font-weight: 800;
    color: #0f172a;
  }
  .pi-sig-desc {
    font-size: 8.5px;
    color: #64748b;
    margin-top: 1px;
  }

  /* Emergency Helpline Box */
  .pi-emergency-banner {
    margin-top: 14px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-left: 3.5px solid #ef4444;
    border-radius: 5px;
    padding: 6px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    break-inside: avoid;
  }
  .pi-em-icon {
    font-size: 16px;
    color: #ef4444;
    flex: 0 0 auto;
  }
  .pi-em-text {
    flex: 1 1 auto;
    font-size: 9.5px;
    color: #991b1b;
    line-height: 1.35;
  }
  .pi-em-text strong {
    color: #7f1d1d;
    font-size: 10px;
  }
  .pi-em-tamil {
    font-size: 8.5px;
    color: #b91c1c;
    margin-top: 1px;
  }

  /* Audit Footer */
  .pi-audit-footer {
    display: flex;
    justify-content: space-between;
    font-size: 8px;
    color: #94a3b8;
    margin-top: 8px;
    padding-top: 3px;
    border-top: 1px solid #f1f5f9;
    break-inside: avoid;
  }
`;

/**
 * The ward module identifies a patient by an internal IPID, not by IP number or
 * REG NO directly — this resolves it. Confirmed the service account's own login
 * session is sufficient; no per-user ID is required despite the EMR's own UI
 * sending one (UsrId here is only for the EMR's audit trail, not authorization).
 */
async function resolveIpid(client, ipNo) {
  const payload = {
    Opt: 1,
    Patname: '',
    Relname: '',
    Regno: '',
    IPno: ipNo,
    Wardid: 0,
    Bedtype: 0,
    Bedno: '',
    Phy: 0,
    Age: 0,
    Aflg: 0,
    Agetwo: 0,
    Sex: '',
    Pattype: 1,
    Admfrmdt: '',
    Admtodt: '',
    Disfrmdt: '',
    Distodt: '',
    DOBdt: '',
    UsrId: '0',
    Cityid: '0',
  };

  const { data } = await client.post(
    `${config.emr.baseUrl}/ward/WebService/IPSearchWard.asmx/GetPatdetail`,
    payload,
    { headers: { 'Content-Type': 'application/json; charset=UTF-8' }, timeout: SUMMARY_TIMEOUT_MS },
  );

  const rows = data?.d ? JSON.parse(data.d) : [];
  return rows[0]?.IPID || null;
}

/**
 * Generates the discharge summary PDF for one patient and uploads it to MinIO at
 * `<date>/<ipNo>-summary.pdf`. Single-attempt by design — the automation loop
 * simply retries any patient still missing a summary on its next cycle, rather
 * than this function running its own retry/backoff loop.
 *
 * @returns {Promise<{ok: true, objectKey: string} | {ok: false, error: string}>}
 */
export async function generateDischargeSummaryPdf({ ipNo, date, hospital }) {
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true, timeout: SUMMARY_TIMEOUT_MS }));

  const login = await doLogin(client);
  if (!login.ok) {
    return { ok: false, error: 'EMR login failed while fetching discharge summary' };
  }

  let ipid;
  try {
    ipid = await resolveIpid(client, ipNo);
  } catch (error) {
    return { ok: false, error: `Could not resolve patient ID: ${error.message}` };
  }
  if (!ipid) {
    return { ok: false, error: `No ward record found for ${ipNo}` };
  }

  // The summary page authenticates via cookie, same as any other page on this
  // site — transplanting the axios client's session cookie into Puppeteer lets a
  // real browser load the page as our already-logged-in service account.
  const cookies = await jar.getCookies(config.emr.baseUrl);
  const cookieDomain = new URL(config.emr.baseUrl).hostname;

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_BIN,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
      ],
    });

    const page = await browser.newPage();
    await page.setCookie(
      ...cookies.map((c) => ({ name: c.key, value: c.value, domain: cookieDomain, path: c.path || '/' })),
    );

    const url = `${config.emr.baseUrl}/ward/pSummary.aspx?Action=Print&preview=yes&opt=0&Sign=0&ipid=${ipid}&Companyid=undefined`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: SUMMARY_TIMEOUT_MS });

    await page.addStyleTag({ content: OVERRIDE_CSS });
    await page.evaluate((letterheadHtml, formattedDate) => {
      const container = document.getElementById('divSummary') || document.body;
      const tblMain = document.getElementById('tblMain');

      // 1. Insert Letterhead
      const letterheadWrap = document.createElement('div');
      letterheadWrap.innerHTML = letterheadHtml;
      container.insertBefore(letterheadWrap.firstElementChild, container.firstChild);

      // 2. Extract Patient Demographics
      const patNameEl = document.querySelector('.trpatname');
      const patName = patNameEl ? patNameEl.innerText.trim() : '';

      let ageSex = '';
      if (patNameEl) {
        const tr = patNameEl.closest('tr');
        const nextTr = tr ? tr.nextElementSibling : null;
        if (nextTr) ageSex = nextTr.innerText.trim();
      }

      function findVal(labelText) {
        const cells = Array.from(document.querySelectorAll('td, div'));
        for (const c of cells) {
          if (c.innerText && c.innerText.trim().toLowerCase() === labelText.toLowerCase()) {
            const next = c.nextElementSibling;
            if (next && next.nextElementSibling) {
              return next.nextElementSibling.innerText.trim();
            } else if (next) {
              return next.innerText.replace(/^[:\s]+/, '').trim();
            }
          }
        }
        return '';
      }

      const regNo = findVal('Register Number') || findVal('Reg No');
      const ipNo = findVal('IP Number') || findVal('IP No');
      const admitDt = findVal('Admitted On');
      const dischDt = findVal('Discharged On');
      const ward = findVal('Ward Name');
      const bed = findVal('Bed No');

      // Consultant
      const docEl = document.querySelector('.txtdochdr') || document.querySelector('.Disdochdr');
      const consultantName = docEl ? docEl.innerText.replace(/^Dr\.\s*/i, 'Dr. ').trim() : '';

      // Extract Prepared By & Verified By if available
      let prepBy = '';
      let verifBy = '';
      const allP = Array.from(document.querySelectorAll('p'));
      for (const p of allP) {
        const t = (p.innerText || '').replace(/[\uFEFF\u200B-\u200D]/g, '').trim();
        if (/^SUMMARY\s+PREPARED\s+BY\s*:/i.test(t)) {
          prepBy = t.replace(/^SUMMARY\s+PREPARED\s+BY\s*:\s*/i, '').trim();
        }
        if (/^SUMMARY\s+VERIFIED\s+BY\s*:/i.test(t)) {
          verifBy = t.replace(/^SUMMARY\s+VERIFIED\s+BY\s*:\s*/i, '').trim();
        }
      }

      // Extract Audit user and timestamp
      let auditText = '';
      const clsUserEl = document.querySelector('.clsUser');
      if (clsUserEl) {
        auditText = clsUserEl.innerText.trim();
      }

      // 3. Build Executive Patient Demographics Card
      const card = document.createElement('div');
      card.className = 'pi-patient-card';
      card.innerHTML = `
        <div class="pi-patient-top">
          <div class="pi-patient-name">${patName || 'Patient Record'}</div>
          <div class="pi-patient-tags">
            ${ageSex ? `<span class="pi-tag pi-tag-blue">${ageSex}</span>` : ''}
            ${ward ? `<span class="pi-tag">Ward: <strong>${ward}</strong></span>` : ''}
            ${bed ? `<span class="pi-tag">Bed: <strong>${bed}</strong></span>` : ''}
          </div>
        </div>
        <div class="pi-patient-grid">
          <div class="pi-field">
            <span class="pi-field-label">UHID / Reg No</span>
            <span class="pi-field-val">${regNo || '—'}</span>
          </div>
          <div class="pi-field">
            <span class="pi-field-label">IP Number</span>
            <span class="pi-field-val highlight">${ipNo || '—'}</span>
          </div>
          <div class="pi-field">
            <span class="pi-field-label">Admitted On</span>
            <span class="pi-field-val">${admitDt || '—'}</span>
          </div>
          <div class="pi-field">
            <span class="pi-field-label">Discharged On</span>
            <span class="pi-field-val">${dischDt || '—'}</span>
          </div>
        </div>
      `;

      // 4. Consultant Banner
      let consultantHtml = '';
      if (consultantName) {
        consultantHtml = `
          <div class="pi-consultant-banner">
            <div class="pi-cb-left">
              <span class="pi-cb-label">Primary Consultant:</span>
              <span class="pi-cb-name">${consultantName}</span>
            </div>
            ${ward ? `<div class="pi-cb-dept">${ward}</div>` : ''}
          </div>
        `;
      }
      const consultantWrap = document.createElement('div');
      consultantWrap.innerHTML = consultantHtml;

      // Carefully hide legacy header tables and consultant divs
      document.querySelectorAll('.tblIPname, .prHeader, .dummycell').forEach((el) => {
        el.style.display = 'none';
      });

      document.querySelectorAll('.dochdr, .txtdochdr, .linehdr').forEach((el) => {
        el.style.display = 'none';
      });

      // Insert card and consultant banner right after letterhead
      const letterhead = container.querySelector('.pi-letterhead');
      if (letterhead) {
        letterhead.after(card);
        if (consultantWrap.firstElementChild) {
          card.after(consultantWrap.firstElementChild);
        }
      }

      // 5. Clean up Diagnosis & Section Headers
      const paragraphs = Array.from(document.querySelectorAll('p.MsoNormal, .sumContent p'));
      let inReviewAdvice = false;
      const reviewAdviceParagraphs = [];

      for (const p of paragraphs) {
        // Strip zero-width characters completely, replace non-breaking spaces with space
        const txt = (p.innerText || '')
          .replace(/[\uFEFF\u200B-\u200D]/g, '')
          .replace(/\u00A0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (!txt) {
          p.remove();
          continue;
        }

        // Only process paragraphs in the main body (not inside inner content tables)
        const parentTable = p.closest('table');
        if (parentTable && parentTable !== tblMain) {
          continue;
        }

        // Diagnosis
        if (/^DIAGNOSIS\s*:/i.test(txt)) {
          const diagVal = txt.replace(/^DIAGNOSIS\s*:\s*/i, '').trim();
          const diagBox = document.createElement('div');
          diagBox.className = 'pi-diagnosis-card';
          diagBox.innerHTML = `
            <span class="pi-diag-label">Final Diagnosis</span>
            <div class="pi-diag-val">${diagVal}</div>
          `;
          p.replaceWith(diagBox);
          continue;
        }

        // Known Top-level Section Titles
        const secMatch = txt.match(/^(CHIEF\s+COMPLAINTS|HISTORY\s+OF\s+PRESENTING\s+ILLNESS|PAST\s+HISTORY|TREATMENT\s+HISTORY|DURING\s+ADMISSION|ANTHROPOMETRY|COURSE\s+IN\s+HOSPITAL|NUTRITIONAL\s+ADVICE|TREATMENT\s+GIVEN|STATUS\s+DURING\s+DISCHARGE|DISCHARGE\s+ADVICE|REVIEW\s+ADVICE)\s*:?$/i);
        if (secMatch) {
          const titleText = secMatch[1].replace(/\s+/g, ' ');
          const heading = document.createElement('div');
          heading.className = 'pi-section-heading';
          heading.innerText = titleText;
          p.replaceWith(heading);

          if (/^REVIEW\s+ADVICE/i.test(titleText)) {
            inReviewAdvice = true;
          } else {
            inReviewAdvice = false;
          }
          continue;
        }

        // Summary Prepared / Verified by
        if (/^SUMMARY\s+PREPARED\s+BY/i.test(txt) || /^SUMMARY\s+VERIFIED\s+BY/i.test(txt)) {
          p.style.display = 'none';
          inReviewAdvice = false;
          continue;
        }

        // Signature & Seal text
        if (/^Signature\s*&?\s*Seal/i.test(txt)) {
          p.style.display = 'none';
          inReviewAdvice = false;
          continue;
        }

        // Emergency note
        if (/^NOTE\s*:\s*In\s+case\s+of\s+Emergency/i.test(txt) || /அவசர\s+உதவிக்கு/i.test(txt)) {
          p.style.display = 'none';
          inReviewAdvice = false;
          continue;
        }

        if (inReviewAdvice) {
          reviewAdviceParagraphs.push(p);
        }
      }

      // Wrap Review Advice paragraphs into a neat review card
      if (reviewAdviceParagraphs.length) {
        const reviewBox = document.createElement('div');
        reviewBox.className = 'pi-review-advice-block';
        reviewAdviceParagraphs[0].before(reviewBox);
        reviewAdviceParagraphs.forEach((p) => reviewBox.appendChild(p));
      }

      // 6. Style and classify tables, and wrap headings with following tables
      const tables = Array.from(document.querySelectorAll('table.MsoNormalTable'));
      for (const tbl of tables) {
        tbl.removeAttribute('width');
        tbl.style.width = '100%';
        tbl.style.marginLeft = '0';
        tbl.style.marginRight = '0';

        // Remove completely empty rows
        const rows = Array.from(tbl.querySelectorAll('tr'));
        for (const tr of rows) {
          const rowTxt = (tr.innerText || '').replace(/[\uFEFF\u200B-\u200D\u00A0]/g, '').trim();
          if (!rowTxt) {
            tr.remove();
          }
        }

        const validRows = Array.from(tbl.querySelectorAll('tr'));
        if (!validRows.length) {
          tbl.remove();
          continue;
        }

        const firstRowText = validRows[0].innerText.toUpperCase().replace(/\s+/g, ' ');

        if (firstRowText.includes('DRUG') && (firstRowText.includes('S.NO') || firstRowText.includes('.NO'))) {
          // Medication table!
          tbl.classList.add('pi-data-table');
          validRows[0].classList.add('pi-header-row');
          const firstCell = validRows[0].cells[0];
          if (firstCell && firstCell.innerText.trim() === '.NO') {
            firstCell.innerText = 'S.NO';
          }
        } else if (firstRowText.includes('HEART RATE') && firstRowText.includes('SATURATION')) {
          // Vitals strip table!
          tbl.classList.add('pi-vitals-strip');
        } else if (firstRowText.includes('OBSERVED') && firstRowText.includes('INTERPRETATION')) {
          // Anthropometry table!
          tbl.classList.add('pi-data-table');
          validRows[0].classList.add('pi-header-row');
          const firstCell = validRows[0].cells[0];
          if (firstCell && !firstCell.innerText.trim()) {
            firstCell.innerText = 'PARAMETER';
          }
        } else if (validRows[0].cells.length === 2) {
          tbl.classList.add('pi-kv-table');
        }

        // Wrap heading + table together in a pi-section-block to avoid orphan split!
        let prev = tbl.previousElementSibling;
        while (prev && !prev.classList.contains('pi-section-heading') && (!prev.innerText || !prev.innerText.replace(/[\uFEFF\u200B-\u200D\u00A0\s]/g, ''))) {
          const toRemove = prev;
          prev = prev.previousElementSibling;
          toRemove.remove();
        }
        if (prev && prev.classList.contains('pi-section-heading')) {
          const block = document.createElement('div');
          block.className = 'pi-section-block';
          prev.before(block);
          block.appendChild(prev);
          block.appendChild(tbl);
        }
      }

      // 7. Render Signatures, Emergency, and Footer
      const verifHtml = (prepBy || verifBy) ? `
        <div class="pi-verif-strip">
          <div class="pi-verif-item">Prepared By: <strong>${prepBy || '—'}</strong></div>
          <div class="pi-verif-item">Verified By: <strong>${verifBy || '—'}</strong></div>
        </div>
      ` : '';

      const footerContainer = document.createElement('div');
      footerContainer.innerHTML = `
        ${verifHtml}

        <div class="pi-signatures-container">
          <div class="pi-sig-block">
            <div class="pi-sig-line"></div>
            <div class="pi-sig-role">Patient / Attender Signature</div>
            <div class="pi-sig-desc">Received Discharge Summary & Instructions</div>
          </div>
          <div class="pi-sig-block">
            <div class="pi-sig-line"></div>
            <div class="pi-sig-role">${consultantName || 'Treating Consultant'}</div>
            <div class="pi-sig-desc">Signature & Hospital Seal</div>
          </div>
        </div>

        <div class="pi-emergency-banner">
          <div class="pi-em-icon">☎</div>
          <div class="pi-em-text">
            <div><strong>24/7 EMERGENCY HELPLINE:</strong> 044 2752 8528 &nbsp;|&nbsp; Toll-Free: <strong>1800 599 0999</strong></div>
            <div class="pi-em-tamil">அவசர உதவிக்கு: 044 2752 8528 | கட்டணமில்லா தொலைபேசி எண்: 1800 599 0999</div>
          </div>
        </div>

        <div class="pi-audit-footer">
          <span>Adhiparasakthi Hospitals EMR • Electronic Discharge Summary</span>
          <span>${auditText ? `Audit: ${auditText}` : `Generated: ${formattedDate}`}</span>
        </div>
      `;

      // Hide old bottom elements safely
      const oldDisdoc = document.querySelector('.Disdochdr');
      if (oldDisdoc) oldDisdoc.style.display = 'none';

      const oldClsFooter = document.querySelector('.clsFooter');
      if (oldClsFooter) {
        const row = oldClsFooter.closest('.tablerow') || oldClsFooter;
        row.style.display = 'none';
      }

      const oldClsUser = document.querySelector('.clsUser');
      if (oldClsUser) {
        const row = oldClsUser.closest('.tablerow') || oldClsUser;
        row.style.display = 'none';
      }

      // Append clean footer
      const sumContent = document.querySelector('.sumContent') || container;
      sumContent.appendChild(footerContainer);
    }, buildLetterheadHtml(hospital || config.hospital || {}), date || new Date().toISOString().slice(0, 10));

    // Ensure all images are fully loaded and decoded before rendering PDF
    await page.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll('img'));
      await Promise.all(
        imgs.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => {}))),
      );
    });

    const tmpPdfPath = path.join(os.tmpdir(), `discharge-summary-${crypto.randomUUID()}.pdf`);
    try {
      await page.pdf({ path: tmpPdfPath, printBackground: true, format: 'A4' });

      const objectKey = reportSummaryObjectKey(date, ipNo);
      await uploadPdfFile(objectKey, tmpPdfPath);
      return { ok: true, objectKey };
    } finally {
      fs.rmSync(tmpPdfPath, { force: true });
    }
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
