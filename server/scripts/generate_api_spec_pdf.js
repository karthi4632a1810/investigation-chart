import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { renderHtmlToPdf } from '../src/services/investigationPdfService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>OP Lab Reports API Specification</title>
  <style>
    @page { size: A4 portrait; margin: 12mm 14mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a; line-height: 1.45; font-size: 10pt; margin: 0; padding: 0;
    }
    .header-bar {
      border-bottom: 2.5px solid #0b2956; padding-bottom: 10px; margin-bottom: 14px;
      display: flex; justify-content: space-between; align-items: flex-end;
    }
    .hospital-title { font-size: 16pt; font-weight: 800; color: #0b2956; letter-spacing: -0.02em; }
    .hospital-subtitle { font-size: 8.5pt; color: #475569; margin-top: 1px; }
    .doc-meta { text-align: right; font-size: 8pt; color: #64748b; }
    .badge { display: inline-block; padding: 2.5px 7px; border-radius: 4px; font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge-post { background: #dcfce7; color: #15803d; }
    .badge-get { background: #e0f2fe; color: #0369a1; }
    h1 { font-size: 13pt; color: #0b2956; margin: 12px 0 6px 0; border-bottom: 1.5px solid #e2e8f0; padding-bottom: 3px; }
    h2 { font-size: 11pt; color: #1e3a8a; margin: 10px 0 4px 0; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 12px 0; font-size: 9pt; }
    th { background: #0b2956; color: #fff; text-align: left; padding: 6px 9px; font-size: 8.5pt; font-weight: 600; }
    td { padding: 5.5px 9px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    tr:nth-child(even) td { background: #f8fafc; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 8pt; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; border: 1px solid #e2e8f0; }
    .code-block { background: #0f172a; color: #f8fafc; padding: 10px 12px; border-radius: 6px; font-family: monospace; font-size: 7.8pt; line-height: 1.4; margin: 6px 0 10px 0; white-space: pre-wrap; }
    .code-comment { color: #94a3b8; }
    .code-key { color: #38bdf8; }
    .code-val { color: #fde047; }
    .info-box { background: #eff6ff; border-left: 3.5px solid #2563eb; padding: 8px 12px; font-size: 8.5pt; color: #1e3a8a; margin: 8px 0 12px 0; }
    .footer { margin-top: 18px; padding-top: 6px; border-top: 1px solid #cbd5e1; display: flex; justify-content: space-between; font-size: 7.5pt; color: #94a3b8; }
    .page-break { page-break-before: always; }
  </style>
</head>
<body>
  <div class="header-bar">
    <div>
      <div class="hospital-title">Adhiparasakthi Hospitals</div>
      <div class="hospital-subtitle">Melmaruvathur, Tamil Nadu · Outpatient EMR Laboratory Reports System</div>
    </div>
    <div class="doc-meta">
      <div><strong>OP LAB REPORTS API</strong></div>
      <div>Endpoint: <code>/api/reports</code></div>
    </div>
  </div>

  <div class="info-box">
    <strong>OP Lab Report Fetch API:</strong> Retrieves Outpatient <strong>Laboratory Investigation Report PDFs</strong> by <code>uhid</code>. Reports are generated once all active (non-cancelled) lab orders for the visit date have <code>STATUS = 'RESULT APPROVED'</code>.
  </div>

  <h1>1. API Endpoints</h1>
  <table>
    <thead><tr><th style="width:18%;">Method</th><th style="width:32%;">Path</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td><span class="badge badge-get">GET</span> <span class="badge badge-post">POST</span></td><td><code>/api/reports</code></td><td>Query OP lab report status, metadata, download URL, or base64 PDF payload.</td></tr>
      <tr><td><span class="badge badge-get">GET</span></td><td><code>/api/reports/download</code></td><td>Stream the OP Lab Report PDF (<code>uhid</code> + optional <code>date</code>, or signed <code>token</code>).</td></tr>
      <tr><td><span class="badge badge-get">GET</span></td><td><code>/api/reports/status</code></td><td>Service health and automated OP scheduler status.</td></tr>
    </tbody>
  </table>

  <h1>2. Request Parameters</h1>
  <table>
    <thead><tr><th style="width:22%;">Parameter</th><th style="width:14%;">Type</th><th style="width:14%;">Required</th><th>Details</th></tr></thead>
    <tbody>
      <tr><td><code>uhid</code> / <code>regNo</code></td><td>String</td><td>Yes</td><td>Outpatient Registration Number / UHID (e.g. <code>6214201</code>).</td></tr>
      <tr><td><code>fromDate</code> / <code>from</code></td><td>String</td><td>Optional</td><td>Visit date window start (<code>YYYY-MM-DD</code> or <code>DD-MM-YYYY</code>).</td></tr>
      <tr><td><code>toDate</code> / <code>to</code></td><td>String</td><td>Optional</td><td>Visit date window end (<code>YYYY-MM-DD</code> or <code>DD-MM-YYYY</code>).</td></tr>
      <tr><td><code>download</code> / <code>direct</code></td><td>Boolean</td><td>Optional</td><td>If <code>true</code>, streams <code>application/pdf</code> directly instead of JSON.</td></tr>
      <tr><td><code>format</code></td><td>String</td><td>Optional</td><td><code>json</code> (default) or <code>pdf</code>.</td></tr>
      <tr><td><code>base64</code></td><td>Boolean</td><td>Optional</td><td>If <code>true</code>, includes base64-encoded PDF inside <code>reports.lab.base64</code>.</td></tr>
    </tbody>
  </table>

  <div class="page-break"></div>

  <h1>3. JSON Response Specification</h1>
  <div class="code-block">{
  <span class="code-key">"ok"</span>: <span class="code-val">true</span>,
  <span class="code-key">"patient"</span>: {
    <span class="code-key">"uhid"</span>: <span class="code-val">"6214201"</span>,
    <span class="code-key">"regNo"</span>: <span class="code-val">"6214201"</span>,
    <span class="code-key">"name"</span>: <span class="code-val">"Mrs.PATIENT NAME"</span>,
    <span class="code-key">"gender"</span>: <span class="code-val">"FEMALE"</span>,
    <span class="code-key">"age"</span>: <span class="code-val">"45 Y"</span>,
    <span class="code-key">"date"</span>: <span class="code-val">"2026-11-10"</span>,
    <span class="code-key">"visitType"</span>: <span class="code-val">"OP REVIEW"</span>,
    <span class="code-key">"tokenNo"</span>: <span class="code-val">"14"</span>,
    <span class="code-key">"doctor"</span>: <span class="code-val">"DR. NAME"</span>,
    <span class="code-key">"department"</span>: <span class="code-val">"GENERAL MEDICINE"</span>,
    <span class="code-key">"reportStatus"</span>: <span class="code-val">"ready"</span>
  },
  <span class="code-key">"reports"</span>: {
    <span class="code-key">"lab"</span>: {
      <span class="code-key">"requested"</span>: <span class="code-val">true</span>,
      <span class="code-key">"available"</span>: <span class="code-val">true</span>,
      <span class="code-key">"name"</span>: <span class="code-val">"Lab-Report-6214201.pdf"</span>,
      <span class="code-key">"mimeType"</span>: <span class="code-val">"application/pdf"</span>,
      <span class="code-key">"downloadUrl"</span>: <span class="code-val">"http://emr-host:2021/api/reports/download?uhid=6214201&amp;date=2026-11-10"</span>
    }
  }
}</div>

  <h1>4. cURL Examples</h1>
  <div class="code-block"><span class="code-comment"># Fetch JSON metadata &amp; download link:</span>
curl "http://localhost:2021/api/reports?uhid=6214201"

<span class="code-comment"># Download OP Lab PDF directly:</span>
curl -OJ "http://localhost:2021/api/reports?uhid=6214201&amp;download=true"

<span class="code-comment"># POST with base64 PDF payload:</span>
curl -X POST "http://localhost:2021/api/reports" \\
  -H "Content-Type: application/json" \\
  -d '{"uhid":"6214201","base64":true}'</div>

  <div class="footer">
    <span>Adhiparasakthi Hospitals · OP Lab Reports API</span>
    <span>Hospital EMR Integration Document</span>
  </div>
</body>
</html>`;

async function main() {
  const outPath = path.resolve(__dirname, '../../OP_Lab_Reports_API_Specification.pdf');
  console.log('Rendering PDF to:', outPath);
  await renderHtmlToPdf(html, outPath);
  console.log('PDF rendered successfully! Size:', fs.statSync(outPath).size, 'bytes');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
