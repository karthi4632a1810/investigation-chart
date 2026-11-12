/**
 * External & Internal OP Reports API:
 * Fetch outpatient laboratory investigation report PDFs by patient UHID / Register Number.
 *
 * Parameters supported on GET /api/reports & POST /api/reports:
 *  - uhid / regNo / reg_no: Patient UHID / Registration Number
 *  - fromDate / from: Optional start date (YYYY-MM-DD or DD-MM-YYYY)
 *  - toDate / to: Optional end date (YYYY-MM-DD or DD-MM-YYYY)
 *  - download / direct: boolean ('true' to stream Lab PDF directly)
 *  - format: 'json' | 'pdf'
 *  - base64 / includeBase64: boolean (include base64 encoded PDF string in JSON response)
 *
 * Publicly accessible across CORS (no session cookie required).
 */
import { getMongoCollection } from './mongo.js';
import {
  getPdfStream,
  pdfExists,
  reportObjectKey,
} from './storageService.js';
import { fetchOpLabOrders } from './emrService.js';
import {
  dateFolderName,
  fetchOpVisitForRegNo,
  summarizeOpPatient,
  upsertReportRecord,
} from './opReportService.js';
import { currentPdfMode, generatePatientPdf } from './investigationPdfService.js';
import { config } from '../config.js';
import { readDocToken } from './publicLinkService.js';
import { toEmrMdy } from '../services/emrService.js';

export function parseBool(val, defaultVal = null) {
  if (val === undefined || val === null || val === '') return defaultVal;
  if (typeof val === 'boolean') return val;
  const s = String(val).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return defaultVal;
}

export function cleanName(name) {
  return String(name || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\s,;:]+$/, '')
    .trim();
}

export function normaliseUhid(val) {
  return String(val || '')
    .trim()
    .replace(/^(?:UHID|REG(?:\s*NO)?)\s*[:#-]?\s*/i, '')
    .trim();
}

export function parseDateParam(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parts = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (parts) {
    const [, p1, p2, year] = parts;
    let day = p1;
    let month = p2;
    if (parseInt(p1, 10) <= 12 && parseInt(p2, 10) > 12) {
      month = p1;
      day = p2;
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return s;
}

function subtractDaysIso(isoDate, days) {
  const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDate;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  dt.setDate(dt.getDate() - days);
  return dateFolderName(dt);
}

export function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${protocol}://${host}`;
}

export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export async function getPdfBuffer(objectKey) {
  const pdf = await getPdfStream(objectKey);
  if (!pdf || !pdf.stream) return null;
  return streamToBuffer(pdf.stream);
}

/**
 * Looks up an OP patient in `op_reports`, falling back to live EMR (`LabTestResultHistoryQB`
 * + `Fo_Rpt_OPPatdetailsprint_QB`) when missing or when existing orders are still pending approval.
 */
export async function findPatient({ uhid, fromDate, toDate }) {
  const cleanUhid = normaliseUhid(uhid);
  if (!cleanUhid) return { primary: null, all: [], source: null };

  const collection = await getMongoCollection('op_reports');
  const escaped = cleanUhid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const baseQuery = { regNo: { $regex: `^${escaped}$`, $options: 'i' } };

  const isoFrom = parseDateParam(fromDate);
  const isoTo = parseDateParam(toDate);

  const query = { ...baseQuery };
  if (isoFrom || isoTo) {
    query.date = {};
    if (isoFrom) query.date.$gte = isoFrom;
    if (isoTo) query.date.$lte = isoTo;
  }

  // 1. Check MongoDB op_reports (regenerate if pdfMode changed from emr <-> template)
  const desiredMode = currentPdfMode();
  let docs = await collection.find(query).sort({ date: -1, generatedAt: -1 }).toArray();
  if (docs.length > 0 && docs[0].reportStatus === 'ready' && docs[0].pdfMode === desiredMode) {
    return { primary: docs[0], all: docs, source: 'mongo' };
  }

  // 2. Live EMR lookup (handles brand-new OP orders or pending->approved transitions)
  try {
    const today = dateFolderName(new Date());
    const targetTo = isoTo || today;
    const targetFrom = isoFrom || docs[0]?.date || subtractDaysIso(targetTo, 30);

    const ordersRes = await fetchOpLabOrders({
      fromDate: `${toEmrMdy(targetFrom)} 00:00`,
      toDate: `${toEmrMdy(targetTo)} 23:59`,
      regNo: cleanUhid,
    });

    if (ordersRes.ok && ordersRes.data.length > 0) {
      const rowsByDate = new Map();
      for (const row of ordersRes.data) {
        const d = parseDateParam(row['REQUEST DATE'] || '') || targetTo;
        if (!rowsByDate.has(d)) rowsByDate.set(d, []);
        rowsByDate.get(d).push(row);
      }

      const sortedDates = [...rowsByDate.keys()].sort((a, b) => b.localeCompare(a));
      const emrMatches = [];

      for (const visitIso of sortedDates) {
        const dateRows = rowsByDate.get(visitIso);
        const visitRow = await fetchOpVisitForRegNo(visitIso, cleanUhid).catch(() => null);
        const info = summarizeOpPatient(cleanUhid, dateRows, visitRow);
        if (info.totalOrders === 0) continue; // ignore fully CANCELLED order sets

        const existingForDate = docs.find((d) => d.date === visitIso);
        const status = info.allApproved
          ? (existingForDate?.reportStatus === 'ready' && existingForDate?.generatedSig === info.orderSig && existingForDate?.pdfMode === desiredMode
            ? 'ready'
            : 'approved_pending_pdf')
          : 'pending';

        const baseEntry = {
          date: visitIso,
          ...info.recordFields,
          totalOrders: info.totalOrders,
          approvedOrders: info.approvedOrders,
          pendingOrders: info.pendingOrders,
          pendingStatuses: info.pendingStatuses,
        };

        if (!info.allApproved) {
          await upsertReportRecord(visitIso, { ...baseEntry, reportStatus: 'pending' }).catch(() => {});
        }

        emrMatches.push({
          ...baseEntry,
          allApproved: info.allApproved,
          activeRows: info.activeRows,
          orderSig: info.orderSig,
          reportStatus: status,
          objectKey: existingForDate?.objectKey,
          generatedAt: existingForDate?.generatedAt,
        });
      }

      if (emrMatches.length > 0) {
        return { primary: emrMatches[0], all: emrMatches, source: 'emr' };
      }
    }
  } catch (err) {
    console.warn(`[reports-api] EMR OP lookup failed for ${cleanUhid}: ${err.message}`);
  }

  // Fallback without date range if a date filter yielded nothing in both Mongo and EMR
  if (!docs.length && (isoFrom || isoTo)) {
    docs = await collection.find(baseQuery).sort({ date: -1, generatedAt: -1 }).toArray();
  }

  if (docs.length > 0) {
    return { primary: docs[0], all: docs, source: 'mongo' };
  }

  return { primary: null, all: [], source: null };
}

/**
 * Ensures the OP lab PDF is available in MinIO, strictly waiting until all non-cancelled
 * active orders for that date have `STATUS = 'RESULT APPROVED'`.
 */
export async function ensurePdfAvailable({ patient }) {
  const { date, regNo, doctor, department, visitType, tokenNo } = patient;

  if (patient.allApproved === false || patient.reportStatus === 'pending' || Number(patient.pendingOrders) > 0) {
    const approved = patient.approvedOrders ?? 0;
    const total = patient.totalOrders ?? 0;
    const pendingList = Array.isArray(patient.pendingStatuses) && patient.pendingStatuses.length
      ? ` (${patient.pendingStatuses.join(', ')})`
      : '';
    return {
      ok: false,
      exists: false,
      pending: true,
      error: `Lab results still in process: ${approved}/${total} active orders approved${pendingList}.`,
    };
  }

  const desiredMode = currentPdfMode();
  const key = reportObjectKey(date, regNo);
  if (patient.reportStatus === 'ready' && patient.pdfMode === desiredMode && (await pdfExists(key))) {
    return { ok: true, exists: true, objectKey: key };
  }

  try {
    console.log(`[reports-api] Generating OP lab PDF (${desiredMode}) on-demand for UHID ${regNo} (${date})...`);
    const gen = await generatePatientPdf({
      regNo,
      date,
      rows: patient.activeRows,
      hospital: config.hospital,
      physicianName: doctor || '',
      department: department || '',
      visitType: visitType || '',
      tokenNo: tokenNo || '',
      usePdfTemplate: desiredMode === 'template',
    });

    if (gen.ok) {
      await upsertReportRecord(date, {
        regNo,
        name: patient.name,
        age: patient.age,
        gender: patient.gender,
        mobile: patient.mobile,
        whatsappNo: patient.whatsappNo,
        department,
        doctor,
        visitType,
        tokenNo,
        totalOrders: patient.totalOrders,
        approvedOrders: patient.approvedOrders,
        pendingOrders: patient.pendingOrders || 0,
        pendingStatuses: [],
        reportStatus: 'ready',
        pdfMode: gen.pdfMode || desiredMode,
        dateCount: gen.dateCount,
        reqNos: gen.reqNos,
        objectKey: gen.objectKey || key,
        generatedSig: patient.orderSig,
        generatedAt: new Date(),
        error: null,
      }).catch(() => {});

      return { ok: true, exists: true, objectKey: gen.objectKey || key, generated: true };
    }

    return { ok: false, exists: false, error: gen.error || 'OP lab report could not be generated' };
  } catch (err) {
    return { ok: false, exists: false, error: err.message };
  }
}

export function renderReportsFormHtml(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OP Lab Reports Portal · Outpatient Investigation Chart</title>
  <style>
    :root {
      --primary: #0b2956;
      --primary-hover: #163e7a;
      --accent: #2563eb;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 40px 20px; line-height: 1.5; }
    .container { max-width: 680px; margin: 0 auto; }
    .header { text-align: center; margin-bottom: 28px; }
    .header h1 { font-size: 24px; color: var(--primary); font-weight: 700; margin-bottom: 6px; }
    .header p { color: var(--muted); font-size: 14px; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 28px; box-shadow: 0 4px 16px rgba(0,0,0,0.04); margin-bottom: 24px; }
    .form-group { margin-bottom: 18px; }
    .label { display: block; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 6px; }
    .hint { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .input-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    input[type="text"], input[type="date"] {
      width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; background: #fff; color: var(--text);
    }
    input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }
    .options-box { background: #f1f5f9; border-radius: 8px; padding: 16px; margin: 20px 0; border: 1px solid #e2e8f0; }
    .checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; cursor: pointer; user-select: none; }
    .checkbox-label input { width: 17px; height: 17px; cursor: pointer; accent-color: var(--primary); }
    .btn {
      display: inline-flex; align-items: center; justify-content: center; width: 100%;
      background: var(--primary); color: #fff; font-size: 15px; font-weight: 600;
      padding: 13px 20px; border-radius: 8px; border: none; cursor: pointer; transition: background 0.15s ease;
    }
    .btn:hover { background: var(--primary-hover); }
    .code-card { background: #0f172a; color: #e2e8f0; border-radius: 10px; padding: 18px; font-family: monospace; font-size: 13px; overflow-x: auto; margin-top: 12px; white-space: pre-wrap; }
    .code-card .comment { color: #94a3b8; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div style="font-size:32px; margin-bottom:8px;">🧪</div>
      <h1>OP Lab Reports Portal</h1>
      <p>Fetch Outpatient Laboratory Investigation Report PDF by UHID</p>
    </div>

    <div class="card">
      <form action="/api/reports" method="GET" target="_blank">
        <div class="form-group">
          <label class="label" for="uhid">UHID / Register Number</label>
          <input type="text" id="uhid" name="uhid" placeholder="e.g. 6214201" autocomplete="off" required />
          <div class="hint">Outpatient UHID or registration ID (available once all active lab orders are RESULT APPROVED)</div>
        </div>

        <div class="input-row form-group">
          <div>
            <label class="label" for="fromDate">From Date (Optional)</label>
            <input type="date" id="fromDate" name="fromDate" />
          </div>
          <div>
            <label class="label" for="toDate">To Date (Optional)</label>
            <input type="date" id="toDate" name="toDate" />
          </div>
        </div>

        <div class="options-box">
          <label class="checkbox-label">
            <input type="checkbox" name="download" value="true" />
            <span>⚡ Direct Download (Stream Lab Report PDF instead of JSON)</span>
          </label>
        </div>

        <button type="submit" class="btn">Fetch OP Lab Report ➔</button>
      </form>
    </div>

    <div class="card">
      <h3 style="font-size:15px; font-weight:700; color:var(--primary); margin-bottom:8px;">REST API Integration</h3>
      <p style="font-size:13px; color:var(--muted); margin-bottom:12px;">Publicly accessible from anywhere without a session cookie (CORS enabled):</p>
      <div class="code-card"><span class="comment"># Fetch JSON with patient details &amp; download links:</span>
curl "${baseUrl}/api/reports?uhid=6214201"

<span class="comment"># Directly stream OP Lab Report PDF:</span>
curl -OJ "${baseUrl}/api/reports?uhid=6214201&download=true"

<span class="comment"># POST with base64 PDF payload:</span>
curl -X POST "${baseUrl}/api/reports" \\
  -H "Content-Type: application/json" \\
  -d '{"uhid":"6214201","base64":true}'</div>
    </div>
  </div>
</body>
</html>`;
}

export async function handleReportsApi(req, res) {
  try {
    const params = req.method === 'POST' ? { ...req.query, ...req.body } : req.query;

    const uhid = normaliseUhid(params.uhid || params.regNo || params.reg_no || '');
    const dateParam = String(params.date || '').trim();
    const fromDate = String(params.fromDate || params.from || params.from_date || dateParam || '').trim();
    const toDate = String(params.toDate || params.to || params.to_date || dateParam || '').trim();

    if (!uhid) {
      const isBrowserHtml = Boolean(
        req.headers.accept &&
        req.headers.accept.includes('text/html') &&
        !req.headers.accept.includes('application/json'),
      );

      if (isBrowserHtml && req.method === 'GET') {
        return res.type('html').send(renderReportsFormHtml(getBaseUrl(req)));
      }

      return res.status(400).json({
        ok: false,
        error: "Missing patient identifier. Please provide 'uhid' (or 'regNo').",
        usage: {
          endpoint: '/api/reports',
          parameters: {
            uhid: "Patient UHID / Registration number (e.g. '6214201')",
            fromDate: 'Optional start date filter (YYYY-MM-DD or DD-MM-YYYY)',
            toDate: 'Optional end date filter (YYYY-MM-DD or DD-MM-YYYY)',
            download: 'true | false (directly stream the Lab Report PDF)',
            format: "'json' | 'pdf'",
            base64: 'true | false (include base64 encoded PDF string in JSON response)',
          },
          examples: [
            '/api/reports?uhid=6214201',
            '/api/reports?uhid=6214201&download=true',
            '/api/reports?uhid=6214201&fromDate=2026-11-10&format=pdf',
          ],
        },
      });
    }

    if (params.lab !== undefined && !parseBool(params.lab, true)) {
      return res.status(400).json({
        ok: false,
        error: 'OP reports contain laboratory investigation reports only (set lab=true or omit).',
      });
    }

    const wantDownload = parseBool(params.download, false) || parseBool(params.direct, false);
    const format = String(params.format || '').toLowerCase();
    const wantBase64 = parseBool(params.base64, false) || parseBool(params.includeBase64, false);

    const { primary: patient, all: allMatches } = await findPatient({ uhid, fromDate, toDate });

    if (!patient) {
      return res.status(404).json({
        ok: false,
        error: 'OP patient lab record not found. Please check the UHID and date range.',
        query: { uhid, fromDate: fromDate || undefined, toDate: toDate || undefined },
      });
    }

    const labStatus = await ensurePdfAvailable({ patient });
    const labAvailable = labStatus.exists;

    if (wantDownload || format === 'pdf') {
      if (!labAvailable) {
        return res.status(labStatus.pending ? 409 : 404).json({
          ok: false,
          pending: Boolean(labStatus.pending),
          approvedOrders: patient.approvedOrders,
          totalOrders: patient.totalOrders,
          error: labStatus.pending
            ? 'OP lab report is not ready yet; some active lab orders are still awaiting approval.'
            : 'OP lab report is not available for this patient.',
          detail: labStatus.error,
        });
      }
      const pdfStream = await getPdfStream(labStatus.objectKey);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Lab-Report-${patient.regNo}.pdf"`);
      if (pdfStream.size) res.setHeader('Content-Length', pdfStream.size);
      res.setHeader('Access-Control-Allow-Origin', '*');
      return pdfStream.stream.pipe(res);
    }

    const baseUrl = getBaseUrl(req);
    const streamPath = `/api/reports/download?uhid=${encodeURIComponent(patient.regNo)}&date=${encodeURIComponent(patient.date)}`;
    const labDownloadUrl = `${baseUrl}${streamPath}`;

    let labBase64;
    if (wantBase64 && labAvailable) {
      const buf = await getPdfBuffer(labStatus.objectKey);
      if (buf) labBase64 = buf.toString('base64');
    }

    const filename = `Lab-Report-${patient.regNo}.pdf`;
    const filesList = labAvailable
      ? [{ type: 'lab', name: filename, mimeType: 'application/pdf', url: labDownloadUrl }]
      : [];

    const response = {
      ok: true,
      patient: {
        uhid: patient.regNo || uhid,
        regNo: patient.regNo || uhid,
        name: cleanName(patient.name),
        gender: patient.gender || patient.emr?.gender || '',
        age: patient.age || patient.emr?.age || '',
        date: patient.date,
        visitDate: patient.visitDate || '',
        visitType: patient.visitType || '',
        tokenNo: patient.tokenNo || '',
        doctor: patient.doctor || '',
        department: patient.department || '',
        reportStatus: labAvailable ? 'ready' : (patient.reportStatus || 'pending'),
        totalOrders: patient.totalOrders,
        approvedOrders: patient.approvedOrders,
        pendingOrders: patient.pendingOrders,
      },
      requested: {
        uhid,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        lab: true,
      },
      reports: {
        lab: {
          requested: true,
          available: labAvailable,
          pending: Boolean(labStatus.pending),
          name: filename,
          mimeType: 'application/pdf',
          downloadUrl: labAvailable ? labDownloadUrl : null,
          streamUrl: labAvailable ? streamPath : null,
          error: labAvailable ? undefined : labStatus.error,
          base64: labBase64,
        },
      },
      files: filesList,
      downloadAllUrl: filesList[0]?.url || null,
    };

    if (allMatches && allMatches.length > 1) {
      response.allVisits = allMatches.map((m) => ({
        regNo: m.regNo,
        date: m.date,
        visitDate: m.visitDate,
        visitType: m.visitType,
        tokenNo: m.tokenNo,
        doctor: m.doctor,
        department: m.department,
        reportStatus: m.reportStatus,
      }));
    }

    return res.json(response);
  } catch (error) {
    console.error('[reports-api] Error handling /api/reports:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function handleReportsDownload(req, res) {
  try {
    const params = { ...req.query, ...req.body };
    const { token, type, date, uhid, regNo } = params;

    // 1. Download via signed token (if token provided)
    if (token) {
      const objectKey = readDocToken(token);
      if (!objectKey) {
        return res.status(410).type('text/plain').send('This download token has expired or is invalid.');
      }
      const pdf = await getPdfStream(objectKey);
      if (!pdf) return res.status(404).type('text/plain').send('Report not found');
      const filename = String(params.name || params.filename || 'Report.pdf').replace(/[^\w.-]+/g, '-');
      res.setHeader('Content-Type', 'application/pdf');
      if (pdf.size) res.setHeader('Content-Length', pdf.size);
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      return pdf.stream.pipe(res);
    }

    const cleanUhid = normaliseUhid(uhid || regNo || '');
    const cleanType = String(type || 'lab').trim().toLowerCase();

    if (!cleanUhid) {
      return res.status(400).type('text/plain').send('Missing uhid');
    }
    if (cleanType !== 'lab') {
      return res.status(400).type('text/plain').send("Invalid type parameter. Expected 'lab'.");
    }

    const isoDate = parseDateParam(date);
    const { primary: patient } = await findPatient({
      uhid: cleanUhid,
      fromDate: isoDate || undefined,
      toDate: isoDate || undefined,
    });
    if (!patient) {
      return res.status(404).type('text/plain').send('OP patient lab report not found');
    }

    const status = await ensurePdfAvailable({ patient });
    if (!status.exists) {
      return res
        .status(status.pending ? 409 : 404)
        .type('text/plain')
        .send(status.error || 'Lab report not found');
    }

    const pdf = await getPdfStream(status.objectKey);
    if (!pdf) return res.status(404).type('text/plain').send('Lab report not found');
    res.setHeader('Content-Type', 'application/pdf');
    if (pdf.size) res.setHeader('Content-Length', pdf.size);
    res.setHeader('Content-Disposition', `inline; filename="Lab-Report-${patient.regNo}.pdf"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return pdf.stream.pipe(res);
  } catch (error) {
    console.error('[reports-api] Download error:', error);
    return res.status(500).type('text/plain').send(`Download failed: ${error.message}`);
  }
}
