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
import { reviewDischargeSummary } from './geminiService.js';

const CHROME_BIN = process.env.CHROME_PATH || 'google-chrome';
const SUMMARY_TIMEOUT_MS = 45_000;

function esc(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

/**
 * Same letterhead structure as investigationPdfService.js's Diagnosis Summary
 * (logo/name/address on the left; accreditation badges + document-type badge
 * on the right) for visual consistency between the two documents. The UHID
 * isn't known yet at this point (it only exists inside the EMR's own summary
 * page, extracted later in page.evaluate()) — `.pi-regno-slot` is filled in
 * from there once `regNo` is resolved.
 */
function buildLetterheadHtml(hospital) {
  const logoSrc = defaultLogoDataUri || hospital?.logoPath || '';
  const badges = [
    nablBadgeDataUri ? `<img class="pi-accred-badge-img" src="${nablBadgeDataUri}" alt="NABL Accredited Laboratory" title="NABL Accredited Laboratory" />` : '',
    nabhBadgeDataUri ? `<img class="pi-accred-badge-img" src="${nabhBadgeDataUri}" alt="NABH Accredited Hospital" title="NABH Accredited Hospital" />` : '',
  ].join('');

  // A single root element — the extraction code below only ever moves
  // `letterheadWrap.firstElementChild` into the document, so the ribbon and
  // letterhead must be nested inside one wrapper, not sibling top-level nodes.
  return `
    <div class="pi-letterhead-wrap">
      <div class="pi-top-ribbon"></div>
      <div class="pi-letterhead">
        <div class="pi-letterhead-left">
          <div class="pi-letterhead-logo">${logoSrc ? `<img src="${logoSrc}" onerror="this.style.display='none'" />` : ''}</div>
          <div class="pi-letterhead-name">
            <div class="pi-hosp-name-en">${esc(hospital?.nameEn || 'Adhiparasakthi Hospitals')}</div>
            <div class="pi-hosp-name-ta">${esc(hospital?.nameTa || 'ஆதிபராசக்தி மருத்துவமனை')}</div>
            <div class="pi-hosp-address">${hospital?.address || ''}</div>
          </div>
        </div>
        <div class="pi-letterhead-right">
          ${badges ? `<div class="pi-accred-badges">${badges}<span class="pi-accred-caption">NABL Lab &amp;<br />NABH Accredited</span></div>` : ''}
          <div class="pi-title-badge">
            <span class="pi-title-badge-label">Document Type</span>
            <span class="pi-title-badge-value">DISCHARGE SUMMARY</span>
          </div>
          <div class="pi-regno-slot"></div>
        </div>
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
    margin: 8mm 10mm 9mm 10mm;
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
  .pi-letterhead-wrap {
    margin-bottom: 8px;
    break-inside: avoid;
  }
  .pi-top-ribbon {
    height: 5px;
    background: linear-gradient(90deg, #0b2956 0%, #144385 50%, #2563eb 100%);
    border-radius: 3px;
    margin-bottom: 8px;
  }
  .pi-letterhead {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    padding: 0 0 8px 0;
    border-bottom: 1.5px solid #cbd5e1;
    break-inside: avoid;
  }
  .pi-letterhead-left {
    display: flex;
    align-items: center;
    gap: 14px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .pi-letterhead-logo {
    width: 54px;
    height: 82px;
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
    font-size: 20px;
    font-weight: 800;
    color: #144385;
    letter-spacing: -0.01em;
    line-height: 1.15;
  }
  .pi-hosp-name-ta {
    font-size: 13px;
    font-weight: 700;
    color: #144385;
    margin-top: 1px;
    line-height: 1.2;
  }
  .pi-hosp-address {
    font-size: 8.5px;
    color: #64748b;
    margin-top: 3px;
    line-height: 1.4;
  }
  .pi-letterhead-right {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
  .pi-accred-badges {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pi-accred-badge-img {
    height: 32px;
    width: auto;
    object-fit: contain;
  }
  .pi-accred-caption {
    font-size: 7.5px;
    font-weight: 700;
    line-height: 1.2;
    color: #64748b;
    text-align: left;
  }
  .pi-title-badge {
    background: linear-gradient(135deg, #0b2956, #144385);
    border: 1px solid #0b2956;
    border-radius: 8px;
    padding: 5px 14px;
    text-align: center;
    box-shadow: 0 2px 4px rgba(11, 41, 86, 0.12);
  }
  .pi-title-badge-label {
    display: block;
    font-size: 7.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #93c5fd;
  }
  .pi-title-badge-value {
    display: block;
    font-size: 12px;
    font-weight: 800;
    color: #ffffff;
    letter-spacing: 0.03em;
  }
  .pi-regno-badge {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 1px;
  }
  .pi-regno-label {
    font-size: 8px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #64748b;
  }
  .pi-regno-value {
    font-size: 11.5px;
    font-weight: 800;
    color: #0b2956;
    background: #f0f5fc;
    border: 1px solid #bfdbfe;
    border-radius: 5px;
    padding: 1.5px 7px;
    font-family: 'JetBrains Mono', 'Courier New', monospace;
  }

  /* Executive Patient Demographics Card */
  .pi-patient-card {
    background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%);
    border: 1.5px solid #cbd5e1;
    border-radius: 10px;
    padding: 9px 12px;
    margin-bottom: 7px;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
    break-inside: avoid;
  }
  .pi-patient-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #e2e8f0;
    padding-bottom: 6px;
    margin-bottom: 7px;
  }
  .pi-patient-name {
    font-size: 13.5px;
    font-weight: 800;
    color: #0b2956;
    letter-spacing: -0.01em;
  }
  .pi-patient-tags {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .pi-tag {
    font-size: 9px;
    font-weight: 700;
    padding: 2.5px 9px;
    border-radius: 999px;
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
    color: #334155;
  }
  .pi-tag-blue {
    background: #e0f2fe;
    border-color: #bae6fd;
    color: #0369a1;
  }
  .pi-tag-ward {
    background: #ecfdf5;
    border-color: #a7f3d0;
    color: #047857;
  }
  .pi-patient-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px 8px;
    font-size: 10px;
  }
  .pi-field {
    display: flex;
    flex-direction: column;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 4px 7px;
  }
  .pi-field-label {
    font-size: 7.5px;
    font-weight: 800;
    text-transform: uppercase;
    color: #64748b;
    letter-spacing: 0.04em;
    margin-bottom: 2px;
  }
  .pi-field-val {
    font-weight: 700;
    color: #1e293b;
    font-size: 10.5px;
  }
  .pi-field-val.highlight {
    color: #144385;
    font-family: 'JetBrains Mono', 'Courier New', monospace;
    font-weight: 800;
  }

  /* Consultant Banner */
  .pi-consultant-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: linear-gradient(135deg, #eff6ff 0%, #f8fafc 100%);
    border: 1px solid #bfdbfe;
    border-left: 4px solid #144385;
    border-radius: 8px;
    padding: 5px 12px;
    margin-bottom: 7px;
    break-inside: avoid;
  }
  .pi-cb-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pi-cb-label {
    font-size: 8px;
    font-weight: 800;
    color: #ffffff;
    background: #144385;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-radius: 4px;
    padding: 2px 6px;
  }
  .pi-cb-name {
    font-size: 12px;
    font-weight: 800;
    color: #0f172a;
  }
  .pi-cb-dept {
    font-size: 9px;
    font-weight: 700;
    color: #1e40af;
    background: #dbeafe;
    border: 1px solid #bfdbfe;
    border-radius: 999px;
    padding: 1.5px 8px;
  }

  /* Discharge Status Banner (e.g. AT REQUEST DISCHARGE) */
  .pi-status-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
    border: 1px solid #fde68a;
    border-left: 4.5px solid #d97706;
    border-radius: 8px;
    padding: 4px 10px;
    margin: 5px 0 7px 0;
    break-inside: avoid;
  }
  .pi-status-label {
    font-size: 8px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: #fde68a;
    color: #92400e;
    border: 1px solid #fcd34d;
    border-radius: 4px;
    padding: 1.5px 6px;
  }
  .pi-status-value {
    font-size: 10.5px;
    font-weight: 800;
    color: #92400e;
    letter-spacing: 0.02em;
  }

  /* Diagnosis Card */
  .pi-diagnosis-card {
    background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
    border: 1.5px solid #93c5fd;
    border-left: 5px solid #144385;
    border-radius: 8px;
    padding: 7px 12px;
    margin: 6px 0 8px 0;
    box-shadow: 0 1px 2px rgba(20, 67, 133, 0.05);
    break-inside: avoid;
  }
  .pi-diag-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 3px;
  }
  .pi-diag-label {
    font-size: 8px;
    font-weight: 800;
    color: #ffffff;
    background: #144385;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-radius: 4px;
    padding: 1.5px 6px;
    display: inline-block;
  }
  .pi-diag-val {
    font-size: 11.5px;
    font-weight: 800;
    color: #0f172a;
    line-height: 1.4;
  }

  /* Section Groups */
  .pi-section-block {
    break-inside: avoid !important;
    page-break-inside: avoid !important;
    margin-top: 7px;
    margin-bottom: 4px;
  }

  /* Section Headings */
  .pi-section-heading {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 10px;
    font-weight: 800;
    color: #0b2956;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: linear-gradient(90deg, #f0f5fc 0%, #ffffff 100%);
    border: 1px solid #dbeafe;
    border-left: 4px solid #144385;
    border-radius: 6px;
    padding: 4px 9px;
    margin: 8px 0 4px 0;
    break-after: avoid !important;
    page-break-after: avoid !important;
    break-inside: avoid !important;
  }

  /* Content Reset & Normalization */
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
    margin: 2.5px 0 !important;
    text-align: justify;
  }
  p.MsoNormal *, .sumContent p * {
    font-size: 10px !important;
    font-family: inherit !important;
    letter-spacing: normal !important;
    line-height: inherit !important;
  }
  p.MsoNormal b, p.MsoNormal strong,
  .sumContent p b, .sumContent p strong {
    color: #0f172a !important;
    font-weight: 700 !important;
  }

  /* Tables: General Reset */
  table.MsoNormalTable, .sumContent table {
    width: 100% !important;
    max-width: 100% !important;
    margin: 3px 0 6px 0 !important;
    border-collapse: separate !important;
    border-spacing: 0 !important;
    break-inside: avoid !important;
    page-break-inside: avoid !important;
    font-size: 9.5px !important;
    background: #ffffff !important;
    box-shadow: none !important;
    display: table !important;
    border: 1.5px solid #cbd5e1 !important;
    border-radius: 8px !important;
    overflow: hidden !important;
  }
  table.MsoNormalTable tr, .sumContent table tr {
    display: table-row !important;
    height: auto !important;
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }
  table.MsoNormalTable td, .sumContent table td,
  table.MsoNormalTable th, .sumContent table th {
    border: none !important;
    border-bottom: 1px solid #e2e8f0 !important;
    border-right: 1px solid #e2e8f0 !important;
    padding: 4px 7px !important;
    font-size: 9.5px !important;
    vertical-align: middle !important;
    line-height: 1.3 !important;
    display: table-cell !important;
  }
  table.MsoNormalTable td *, .sumContent table td * {
    margin: 0 !important;
    text-align: left !important;
    text-indent: 0 !important;
  }
  table.MsoNormalTable tr:last-child td,
  .sumContent table tr:last-child td {
    border-bottom: none !important;
  }
  table.MsoNormalTable td:last-child,
  table.MsoNormalTable th:last-child,
  .sumContent table td:last-child,
  .sumContent table th:last-child {
    border-right: none !important;
  }

  /* 2-Column Key/Value Medical Tables (Past History, Examination, etc.) */
  table.pi-kv-table td:first-child {
    background: #f8fafc !important;
    font-weight: 700 !important;
    color: #144385 !important;
    width: 32% !important;
    font-size: 9px !important;
    text-transform: uppercase !important;
    letter-spacing: 0.02em !important;
    border-right: 1px solid #e2e8f0 !important;
  }
  table.pi-kv-table td:last-child {
    background: #ffffff !important;
    color: #1e293b !important;
    font-size: 9.5px !important;
  }

  /* Medication / Data Tables (Treatment Given, Discharge Advice, Anthropometry) */
  table.pi-data-table th,
  table.pi-data-table tr.pi-header-row td {
    background: linear-gradient(135deg, #0b2956, #144385) !important;
    color: #ffffff !important;
    font-weight: 800 !important;
    font-size: 8.5px !important;
    text-transform: uppercase !important;
    letter-spacing: 0.04em !important;
    border-bottom: 1px solid #0b2956 !important;
    border-right: 1px solid rgba(255, 255, 255, 0.15) !important;
    padding: 5px 7px !important;
    text-align: left !important;
  }
  table.pi-data-table th *,
  table.pi-data-table tr.pi-header-row td * {
    color: #ffffff !important;
    font-weight: 800 !important;
  }
  table.pi-data-table tr.pi-header-row td:last-child {
    border-right: none !important;
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
    padding: 4px 6px !important;
  }
  table.pi-vitals-strip tr:first-child td {
    background: #f1f5f9 !important;
    font-weight: 800 !important;
    color: #334155 !important;
    font-size: 8.5px !important;
    text-transform: uppercase !important;
    border-bottom: 1px solid #cbd5e1 !important;
  }
  table.pi-vitals-strip tr:last-child td {
    font-weight: 800 !important;
    color: #144385 !important;
    font-size: 10px !important;
    background: #ffffff !important;
  }

  /* Review Advice container */
  .pi-review-advice-block {
    background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
    border: 1px solid #cbd5e1;
    border-left: 4px solid #144385;
    border-radius: 8px;
    padding: 7px 12px;
    margin: 5px 0 7px 0;
    break-inside: avoid;
  }
  .pi-review-advice-block p {
    margin: 2px 0 !important;
    color: #1e293b !important;
  }

  /* Gemini-assisted list structure */
  .pi-section-list {
    margin: 3px 0 6px 0 !important;
    padding-left: 16px !important;
    list-style: disc;
  }
  .pi-section-list li {
    font-size: 10px !important;
    line-height: 1.45 !important;
    color: #334155 !important;
    margin: 2px 0 !important;
  }

  /* Gemini-flagged possible typo/unclear text */
  .pi-flag {
    text-decoration: underline dotted #b45309 !important;
    text-decoration-thickness: 1.5px !important;
    text-underline-offset: 2px !important;
    cursor: help;
  }

  /* Verification and Signature Block */
  .pi-verif-strip {
    display: flex;
    justify-content: space-between;
    background: #f8fafc;
    border: 1px solid #cbd5e1;
    border-radius: 7px;
    padding: 5px 12px;
    margin: 8px 0 6px 0;
    break-inside: avoid;
  }
  .pi-verif-item {
    font-size: 9.5px;
    color: #475569;
  }
  .pi-verif-item strong {
    color: #0b2956;
    font-weight: 800;
  }

  /* Approved-by line (replaces signature boxes) */
  .pi-approved-by {
    text-align: center;
    font-size: 11px;
    font-weight: 800;
    color: #0b2956;
    margin-top: 10px;
    break-inside: avoid;
  }

  /* Emergency Helpline Box */
  .pi-emergency-banner {
    margin-top: 8px;
    background: linear-gradient(135deg, #fff5f5 0%, #fef2f2 100%);
    border: 1.5px solid #fca5a5;
    border-left: 5px solid #dc2626;
    border-radius: 8px;
    padding: 6px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    break-inside: avoid;
  }
  .pi-em-icon {
    font-size: 15px;
    color: #dc2626;
    flex: 0 0 auto;
  }
  .pi-em-text {
    flex: 1 1 auto;
    font-size: 9px;
    color: #991b1b;
    line-height: 1.35;
  }
  .pi-em-text strong {
    color: #7f1d1d;
    font-size: 9.5px;
  }
  .pi-em-tamil {
    font-size: 8px;
    color: #b91c1c;
    margin-top: 1px;
  }

  /* DISCLAIMER AT THE END - with DISCLAIMER in RED */
  .pi-disclaimer-card {
    margin-top: 8px;
    margin-bottom: 4px;
    background: #fffafa;
    border: 1.5px solid #fecaca;
    border-left: 5px solid #dc2626;
    border-radius: 8px;
    padding: 7px 11px;
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }
  .pi-disclaimer-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 3px;
  }
  .pi-disclaimer-badge {
    font-size: 10px;
    font-weight: 900;
    color: #dc2626 !important;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    background: #fee2e2;
    border: 1px solid #fca5a5;
    border-radius: 4px;
    padding: 1.5px 7px;
    display: inline-block;
  }
  .pi-disclaimer-sub {
    font-size: 8px;
    font-weight: 700;
    color: #991b1b;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pi-disclaimer-body {
    font-size: 8px;
    color: #475569;
    line-height: 1.4;
    text-align: justify;
  }
  .pi-disclaimer-ta {
    font-size: 7.8px;
    color: #7f1d1d;
    line-height: 1.35;
    margin-top: 3px;
    padding-top: 3px;
    border-top: 1px dashed #fecaca;
  }

  /* Audit Footer */
  .pi-audit-footer {
    display: flex;
    justify-content: space-between;
    font-size: 7.5px;
    color: #94a3b8;
    margin-top: 6px;
    padding-top: 2px;
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
 * @returns {Promise<{ok: true, objectKey: string, dataMissing: boolean} | {ok: false, error: string}>}
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
    const extraction = await page.evaluate((letterheadHtml, formattedDate) => {
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

      // UHID badge in the letterhead — added here rather than in
      // buildLetterheadHtml() because regNo only exists on the EMR's own
      // summary page, extracted above, after the letterhead is already inserted.
      const regnoSlot = document.querySelector('.pi-regno-slot');
      if (regnoSlot && regNo) {
        regnoSlot.innerHTML = `<div class="pi-regno-badge"><span class="pi-regno-label">UHID</span><span class="pi-regno-value">${regNo}</span></div>`;
      }

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
            ${ward ? `<span class="pi-tag pi-tag-ward">Ward: <strong>${ward}</strong></span>` : ''}
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
              <span class="pi-cb-label">Treating Consultant</span>
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

      // Side-channel collection for the (optional) Gemini review pass below —
      // purely additive: records which plain-content lines fall under which
      // heading, without changing anything about what gets rendered here.
      let currentSection = null;
      const collectedSections = [];

      for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        if (!p.parentNode) continue;

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

        // Detect Discharge Condition / Status (e.g. "AT REQUEST DISCHARGE", "AT REQUEST DICHARGE", "DISCHARGED STABLE")
        if (/^(AT\s+REQUEST\s+DI?S?CHARGE|DISCHARGE\s+AT\s+REQUEST|DISCHARGED?\s+STABLE|AGAINST\s+MEDICAL\s+ADVICE|LAMA|EXPIRED|TRANSFERRED?)\b/i.test(txt)) {
          const statusBox = document.createElement('div');
          statusBox.className = 'pi-status-banner';
          statusBox.innerHTML = `
            <span class="pi-status-label">Discharge Condition</span>
            <span class="pi-status-value">${txt}</span>
          `;
          p.replaceWith(statusBox);
          continue;
        }

        // Diagnosis Header & Value Capture (handles multi-line or next-line diagnosis text)
        if (/^(FINAL\s+)?DIAGNOSIS\s*:?/i.test(txt)) {
          let diagVal = txt.replace(/^(FINAL\s+)?DIAGNOSIS\s*:?\s*/i, '').trim();

          // If diagnosis value was on following paragraph(s), collect them!
          let nextEl = p.nextElementSibling;
          while (nextEl && nextEl.tagName === 'P') {
            const nextTxt = (nextEl.innerText || '')
              .replace(/[\uFEFF\u200B-\u200D]/g, '')
              .replace(/\u00A0/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();

            if (!nextTxt) {
              const emptyP = nextEl;
              nextEl = nextEl.nextElementSibling;
              emptyP.remove();
              continue;
            }
            if (/^(CHIEF\s+COMPLAINTS|HISTORY|PAST|DURING|ANTHROPOMETRY|COURSE|NUTRITIONAL|TREATMENT|STATUS|DISCHARGE|REVIEW)\s*:?$/i.test(nextTxt)) {
              break;
            }
            if (nextTxt.length <= 45 && /^[A-Z][A-Z0-9 /&,.-]{1,43}:$/.test(nextTxt)) {
              break;
            }

            if (diagVal) diagVal += ' ' + nextTxt;
            else diagVal = nextTxt;

            const toRemove = nextEl;
            nextEl = nextEl.nextElementSibling;
            toRemove.remove();
          }

          const diagBox = document.createElement('div');
          diagBox.className = 'pi-diagnosis-card';
          diagBox.innerHTML = `
            <div class="pi-diag-header">
              <span class="pi-diag-label">Final Diagnosis</span>
            </div>
            <div class="pi-diag-val">${diagVal || '—'}</div>
          `;
          p.replaceWith(diagBox);
          continue;
        }

        // Known Top-level Section Titles
        const secMatch = txt.match(/^(CHIEF\s+COMPLAINTS|HISTORY\s+OF\s+PRESENTING\s+ILLNESS|PAST\s+HISTORY|TREATMENT\s+HISTORY|DURING\s+ADMISSION|ANTHROPOMETRY|COURSE\s+IN\s+HOSPITAL|NUTRITIONAL\s+ADVICE|TREATMENT\s+GIVEN|STATUS\s+DURING\s+DISCHARGE|DISCHARGE\s+ADVICE|REVIEW\s+ADVICE)\s*:?$/i);
        const genericHeadingMatch = !secMatch && txt.length <= 50 && /^[A-Z][A-Z0-9 /&,.-]{1,48}:$/.test(txt);

        if (secMatch || genericHeadingMatch) {
          const titleText = secMatch ? secMatch[1].replace(/\s+/g, ' ') : txt.replace(/\s*:$/, '').trim();
          const heading = document.createElement('div');
          heading.className = 'pi-section-heading';
          heading.innerText = titleText;
          p.replaceWith(heading);

          inReviewAdvice = /^REVIEW\s+ADVICE/i.test(titleText);
          currentSection = { label: titleText, lines: [] };
          collectedSections.push(currentSection);
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

        if (currentSection) {
          currentSection.lines.push(txt);
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

        const firstRowText = validRows[0].innerText.toUpperCase().replace(/[\uFEFF\u200B-\u200D\u00A0]/g, ' ').replace(/\s+/g, ' ');

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
        } else if (firstRowText.includes('OBSERVED')) {
          // Anthropometry table!
          tbl.classList.add('pi-data-table');
          validRows[0].classList.add('pi-header-row');
          const firstCell = validRows[0].cells[0];
          if (firstCell && !firstCell.innerText.replace(/[\uFEFF\u200B-\u200D\u00A0\s]/g, '')) {
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

      // 7. Render Signatures, Emergency, and DISCLAIMER on the end with DISCLAIMER in RED
      const verifHtml = (prepBy || verifBy) ? `
        <div class="pi-verif-strip">
          <div class="pi-verif-item">Prepared By: <strong>${prepBy || '—'}</strong></div>
          <div class="pi-verif-item">Verified By: <strong>${verifBy || '—'}</strong></div>
        </div>
      ` : '';

      const footerContainer = document.createElement('div');
      footerContainer.innerHTML = `
        ${verifHtml}

        <div class="pi-approved-by">Prepared &amp; Approved by ${consultantName || 'Treating Consultant'}</div>

        <div class="pi-emergency-banner">
          <div class="pi-em-icon">☎</div>
          <div class="pi-em-text">
            <div><strong>24/7 EMERGENCY HELPLINE:</strong> 044 2752 8528 &nbsp;|&nbsp; Toll-Free: <strong>1800 599 0999</strong></div>
            <div class="pi-em-tamil">அவசர உதவிக்கு: 044 2752 8528 | கட்டணமில்லா தொலைபேசி எண்: 1800 599 0999</div>
          </div>
        </div>

        <div class="pi-disclaimer-card">
          <div class="pi-disclaimer-header">
            <span class="pi-disclaimer-badge">DISCLAIMER</span>
            <span class="pi-disclaimer-sub">• Hospital Discharge Notice &amp; Legal Advisory</span>
          </div>
          <div class="pi-disclaimer-body">
            This Discharge Summary is an official electronic medical document prepared based on the patient's hospital course, investigations, and clinical status at the time of discharge. It reflects the clinical condition and treatment administered during this admission. In case of any acute medical emergency, persistent or worsening symptoms, or clarification regarding medications, please visit the emergency department immediately or contact the hospital helpline.
            <div class="pi-disclaimer-ta">
              குறிப்பு: இந்நிகழ்வு அறிக்கை மருத்துவமனையில் வழங்கப்பட்ட சிகிச்சையின் மருத்துவ சுருக்கமாகும். ஏதேனும் அவசர மருத்துவ உதவி தேவைப்பட்டால் உடனடியாக மருத்துவமனை அவசர சிகிச்சைப் பிரிவை அணுகவும்.
            </div>
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

      // Handed back to Node for the optional Gemini review pass — only
      // sections that actually collected plain-content lines (table-only
      // sections stay empty and are filtered out here). `patName`/`regNo`/
      // `admitDt`/`dischDt` are also handed back so Node can tell a normal
      // summary apart from one where the EMR page had no patient data at
      // all (e.g. an unresolved ipid) — the extraction above never throws
      // in that case, it just returns empty strings for everything.
      return {
        paragraphSections: collectedSections.filter((s) => s.lines.length > 0),
        patName,
        regNo,
        admitDt,
        dischDt,
      };
    }, buildLetterheadHtml(hospital || config.hospital || {}), date || new Date().toISOString().slice(0, 10));

    const dataMissing = !extraction?.patName && !extraction?.regNo && !extraction?.admitDt && !extraction?.dischDt;

    // Best-effort AI review of the already-rendered content: decides
    // list-vs-paragraph presentation per section and flags suspected typos
    // (never auto-corrects). Never blocks generation — any failure
    // (unconfigured, network, timeout, bad JSON) just means the document
    // renders exactly as it already does above.
    let review = null;
    try {
      review = await reviewDischargeSummary({ sections: extraction?.paragraphSections || [] });
    } catch (error) {
      console.warn(`[discharge-summary] Gemini review skipped for ${ipNo}: ${error.message}`);
    }

    if (review) {
      await page.evaluate((sectionsByLabel) => {
        function wrapFlagText(el, text, title) {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const idx = node.nodeValue.indexOf(text);
            if (idx === -1) continue;
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + text.length);
            const span = document.createElement('span');
            span.className = 'pi-flag';
            span.title = title;
            try {
              range.surroundContents(span);
              return true;
            } catch {
              return false; // would cross an element boundary — skip rather than risk corrupting markup
            }
          }
          return false;
        }

        const headings = Array.from(document.querySelectorAll('.pi-section-heading'));
        for (const heading of headings) {
          const info = sectionsByLabel[heading.innerText.trim()];
          if (!info) continue;

          // Collect the plain-paragraph siblings that belong to this
          // heading (stops at the next non-<p> element — another heading,
          // a diagnosis card, a table, etc.). Headings already wrapped into
          // a .pi-section-block with a table (step 6, above) have no such
          // siblings here and this is naturally a no-op for them.
          const siblings = [];
          let el = heading.nextElementSibling;
          while (el && el.tagName === 'P') {
            siblings.push(el);
            el = el.nextElementSibling;
          }
          if (!siblings.length) continue;

          for (const flag of info.flags || []) {
            for (const p of siblings) {
              if (wrapFlagText(p, flag.text, `AI review: ${flag.reason || 'possible issue'} — verify`)) break;
            }
          }

          if (info.structure === 'list') {
            const list = document.createElement('ul');
            list.className = 'pi-section-list';
            for (const p of siblings) {
              const li = document.createElement('li');
              li.append(...p.childNodes);
              list.appendChild(li);
            }
            siblings[0].replaceWith(list);
            siblings.slice(1).forEach((p) => p.remove());
          }
        }
      }, Object.fromEntries(review.sections));
    }

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
      return { ok: true, objectKey, dataMissing };
    } finally {
      fs.rmSync(tmpPdfPath, { force: true });
    }
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
