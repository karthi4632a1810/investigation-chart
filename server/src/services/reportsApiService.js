/**
 * External & Internal Reports API:
 * Fetch lab report PDF and/or discharge summary PDF by patient UHID or IP number.
 *
 * Parameters supported on GET /api/reports & POST /api/reports:
 *  - uhid / regNo: Patient Registration Number / UHID
 *  - ipnumber / ipNo / ip: Inpatient number
 *  - fromDate / from: Filter start date (YYYY-MM-DD or DD-MM-YYYY)
 *  - toDate / to: Filter end date (YYYY-MM-DD or DD-MM-YYYY)
 *  - lab: boolean ('true' / 'false', default true)
 *  - summary: boolean ('true' / 'false', default true)
 *  - download / direct: boolean ('true' to stream file directly - PDF if single, ZIP if both)
 *  - format: 'json' | 'pdf' | 'zip'
 *  - base64 / includeBase64: boolean (include base64 encoded PDF string in JSON response)
 *
 * Publicly accessible from anywhere (CORS enabled, no session cookie required).
 */
import JSZip from 'jszip';
import { getMongoCollection } from './mongo.js';
import {
  getPdfStream,
  pdfExists,
  reportObjectKey,
  reportSummaryObjectKey,
} from './storageService.js';
import {
  findAdmissionByIpNo,
  fetchDischargeList,
  upsertReportBaseline,
} from './dischargeReportService.js';
import { generatePatientPdf } from './investigationPdfService.js';
import { generateDischargeSummaryPdf } from './dischargeSummaryService.js';
import { config } from '../config.js';
import { readDocToken } from './publicLinkService.js';

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

export function parseDateParam(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parts = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
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

export async function findPatient({ uhid, ipnumber, fromDate, toDate }) {
  const collection = await getMongoCollection('discharge_reports');
  const query = {};

  const cleanIp = ipnumber ? String(ipnumber).trim() : null;
  const cleanUhid = uhid ? String(uhid).trim() : null;

  if (cleanIp) {
    const escaped = cleanIp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.ipNo = { $regex: `^${escaped}$`, $options: 'i' };
  }

  if (cleanUhid) {
    const escaped = cleanUhid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.regNo = { $regex: `^${escaped}$`, $options: 'i' };
  }

  const isoFrom = parseDateParam(fromDate);
  const isoTo = parseDateParam(toDate);

  if (isoFrom || isoTo) {
    query.date = {};
    if (isoFrom) query.date.$gte = isoFrom;
    if (isoTo) query.date.$lte = isoTo;
  }

  // 1. Check MongoDB discharge_reports
  let docs = await collection.find(query).sort({ date: -1, generatedAt: -1 }).toArray();

  // If date filter was applied and nothing found, try finding patient without date filter
  if ((!docs || !docs.length) && (isoFrom || isoTo)) {
    const fallbackQuery = { ...query };
    delete fallbackQuery.date;
    docs = await collection.find(fallbackQuery).sort({ date: -1, generatedAt: -1 }).toArray();
  }

  if (docs && docs.length > 0) {
    return {
      primary: docs[0],
      all: docs,
      source: 'mongo',
    };
  }

  // 2. Fallback: Search EMR by IP number
  if (cleanIp) {
    try {
      const emrRow = await findAdmissionByIpNo(cleanIp.toUpperCase());
      if (emrRow) {
        const dateFolder = emrRow['DISCHARGE DATE']
          ? emrRow['DISCHARGE DATE'].slice(0, 10).split('-').reverse().join('-')
          : new Date().toISOString().slice(0, 10);
        const patient = {
          date: dateFolder,
          ipNo: emrRow['IP NO']?.trim() || cleanIp.toUpperCase(),
          regNo: emrRow['REG NO']?.trim() || cleanUhid || '',
          name: cleanName(emrRow['PATIENT NAME']),
          admissionDate: emrRow['ADMISSION DATE'] || '',
          dischargeDate: emrRow['DISCHARGE DATE'] || '',
          doctor: emrRow['DOCTOR1'] || emrRow['DOCTOR'] || '',
          department: emrRow['DEPARTMENT'] || '',
          ward: emrRow['WARD'] || '',
          bedNo: emrRow['BED NO'] || '',
          mobile: emrRow['MOBILE'] || '',
          emr: emrRow,
        };
        await upsertReportBaseline(dateFolder, emrRow).catch(() => {});
        return {
          primary: patient,
          all: [patient],
          source: 'emr',
        };
      }
    } catch (err) {
      console.warn(`[reports-api] EMR lookup by IP failed: ${err.message}`);
    }
  }

  // 3. Fallback: Search EMR by UHID
  if (cleanUhid) {
    try {
      const toD = new Date();
      const fromD = new Date();
      fromD.setMonth(fromD.getMonth() - 6);
      const pad = (n) => String(n).padStart(2, '0');
      const mdy = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
      const rows = await fetchDischargeList(mdy(fromD), mdy(toD));
      const matchedRow = rows.find((r) => String(r['REG NO'] || '').trim() === cleanUhid);
      if (matchedRow) {
        const dateFolder = matchedRow['DISCHARGE DATE']
          ? matchedRow['DISCHARGE DATE'].slice(0, 10).split('-').reverse().join('-')
          : new Date().toISOString().slice(0, 10);
        const patient = {
          date: dateFolder,
          ipNo: matchedRow['IP NO']?.trim(),
          regNo: matchedRow['REG NO']?.trim() || cleanUhid,
          name: cleanName(matchedRow['PATIENT NAME']),
          admissionDate: matchedRow['ADMISSION DATE'] || '',
          dischargeDate: matchedRow['DISCHARGE DATE'] || '',
          doctor: matchedRow['DOCTOR1'] || matchedRow['DOCTOR'] || '',
          department: matchedRow['DEPARTMENT'] || '',
          ward: matchedRow['WARD'] || '',
          bedNo: matchedRow['BED NO'] || '',
          mobile: matchedRow['MOBILE'] || '',
          emr: matchedRow,
        };
        await upsertReportBaseline(dateFolder, matchedRow).catch(() => {});
        return {
          primary: patient,
          all: [patient],
          source: 'emr',
        };
      }
    } catch (err) {
      console.warn(`[reports-api] EMR lookup by UHID failed: ${err.message}`);
    }
  }

  return { primary: null, all: [], source: null };
}

export async function ensurePdfAvailable({ patient, type }) {
  const { date, ipNo, regNo, admissionDate, dischargeDate, doctor } = patient;
  if (type === 'lab') {
    const key = reportObjectKey(date, ipNo);
    const exists = await pdfExists(key);
    if (exists) {
      return { ok: true, exists: true, objectKey: key };
    }
    // Attempt on-demand generation
    try {
      console.log(`[reports-api] Generating lab PDF on-demand for ${ipNo}...`);
      const gen = await generatePatientPdf({
        ipNo,
        regNo,
        admissionDate,
        dischargeDate,
        hospital: config.hospital,
        date,
        physicianName: doctor || '',
      });
      if (gen.ok) {
        return { ok: true, exists: true, objectKey: key, generated: true };
      }
      return { ok: false, exists: false, error: gen.error || 'Lab report could not be generated' };
    } catch (err) {
      return { ok: false, exists: false, error: err.message };
    }
  } else if (type === 'summary') {
    const key = reportSummaryObjectKey(date, ipNo);
    const exists = await pdfExists(key);
    if (exists) {
      return { ok: true, exists: true, objectKey: key };
    }
    // Attempt on-demand generation
    try {
      console.log(`[reports-api] Generating discharge summary PDF on-demand for ${ipNo}...`);
      const gen = await generateDischargeSummaryPdf({
        ipNo,
        date,
        hospital: config.hospital,
      });
      if (gen.ok) {
        return { ok: true, exists: true, objectKey: key, generated: true };
      }
      return { ok: false, exists: false, error: gen.error || 'Discharge summary could not be generated' };
    } catch (err) {
      return { ok: false, exists: false, error: err.message };
    }
  }
  return { ok: false, exists: false, error: `Unknown report type: ${type}` };
}

export async function generateReportsZip({ patient, labBuffer, summaryBuffer }) {
  const zip = new JSZip();
  const cleanId = String(patient.ipNo || patient.regNo || 'Patient').replace(/[^A-Za-z0-9]+/g, '-');
  if (labBuffer) {
    zip.file(`Lab-Report-${cleanId}.pdf`, labBuffer);
  }
  if (summaryBuffer) {
    zip.file(`Discharge-Summary-${cleanId}.pdf`, summaryBuffer);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function handleReportsApi(req, res) {
  try {
    const params = req.method === 'POST' ? { ...req.query, ...req.body } : req.query;

    const uhid = String(params.uhid || params.regNo || params.reg_no || '').trim();
    const ipnumber = String(params.ipnumber || params.ipNo || params.ip_no || params.ip || '').trim();
    const fromDate = String(params.fromDate || params.from || params.from_date || '').trim();
    const toDate = String(params.toDate || params.to || params.to_date || '').trim();

    if (!uhid && !ipnumber) {
      return res.status(400).json({
        ok: false,
        error: "Missing patient identifier. Please provide 'uhid' (or 'regNo') or 'ipnumber' (or 'ipNo').",
        usage: {
          endpoint: '/api/reports',
          parameters: {
            uhid: "Patient UHID / Registration number (e.g. '6213746')",
            ipnumber: "Patient IP number (e.g. 'IP07034897')",
            fromDate: "Optional start date filter (YYYY-MM-DD or DD-MM-YYYY)",
            toDate: "Optional end date filter (YYYY-MM-DD or DD-MM-YYYY)",
            lab: "true | false (include lab investigation chart, default true if neither specified)",
            summary: "true | false (include discharge summary, default true if neither specified)",
            download: "true | false (directly download file - PDF if single, ZIP if both)",
            format: "'json' | 'pdf' | 'zip'",
            base64: "true | false (include base64 encoded PDF string in JSON response)"
          },
          examples: [
            "/api/reports?uhid=6213746&lab=true&summary=true",
            "/api/reports?ipnumber=IP07034897&lab=true&summary=false&download=true",
            "/api/reports?uhid=6213746&download=true"
          ]
        }
      });
    }

    const hasLabParam = params.lab !== undefined;
    const hasSummaryParam = params.summary !== undefined;

    let includeLab = true;
    let includeSummary = true;

    if (hasLabParam && hasSummaryParam) {
      includeLab = parseBool(params.lab, true);
      includeSummary = parseBool(params.summary, true);
    } else if (hasLabParam && !hasSummaryParam) {
      includeLab = parseBool(params.lab, true);
      includeSummary = false;
    } else if (!hasLabParam && hasSummaryParam) {
      includeLab = false;
      includeSummary = parseBool(params.summary, true);
    }

    if (!includeLab && !includeSummary) {
      return res.status(400).json({
        ok: false,
        error: "At least one of 'lab' or 'summary' must be true.",
      });
    }

    const wantDownload = parseBool(params.download, false) || parseBool(params.direct, false);
    const format = String(params.format || '').toLowerCase();
    const wantBase64 = parseBool(params.base64, false) || parseBool(params.includeBase64, false);

    // Look up patient record
    const { primary: patient, all: allMatches } = await findPatient({ uhid, ipnumber, fromDate, toDate });

    if (!patient) {
      return res.status(404).json({
        ok: false,
        error: 'Patient record not found. Please check the UHID / IP number and date range.',
        query: { uhid: uhid || undefined, ipnumber: ipnumber || undefined, fromDate: fromDate || undefined, toDate: toDate || undefined }
      });
    }

    // Verify / generate requested PDFs
    let labStatus = { ok: false, exists: false };
    let summaryStatus = { ok: false, exists: false };

    if (includeLab) {
      labStatus = await ensurePdfAvailable({ patient, type: 'lab' });
    }
    if (includeSummary) {
      summaryStatus = await ensurePdfAvailable({ patient, type: 'summary' });
    }

    const labAvailable = includeLab && labStatus.exists;
    const summaryAvailable = includeSummary && summaryStatus.exists;

    // Handle direct binary download
    if (wantDownload || format === 'pdf' || format === 'zip') {
      if (includeLab && includeSummary) {
        if (labAvailable && summaryAvailable) {
          const [labBuf, summaryBuf] = await Promise.all([
            getPdfBuffer(labStatus.objectKey),
            getPdfBuffer(summaryStatus.objectKey),
          ]);
          const zipBuf = await generateReportsZip({ patient, labBuffer: labBuf, summaryBuffer: summaryBuf });
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', `attachment; filename="Reports-${patient.ipNo}.zip"`);
          res.setHeader('Content-Length', zipBuf.length);
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.send(zipBuf);
        } else if (labAvailable && !summaryAvailable) {
          const pdfStream = await getPdfStream(labStatus.objectKey);
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `inline; filename="Lab-Report-${patient.ipNo}.pdf"`);
          if (pdfStream.size) res.setHeader('Content-Length', pdfStream.size);
          res.setHeader('Access-Control-Allow-Origin', '*');
          return pdfStream.stream.pipe(res);
        } else if (summaryAvailable && !labAvailable) {
          const pdfStream = await getPdfStream(summaryStatus.objectKey);
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `inline; filename="Discharge-Summary-${patient.ipNo}.pdf"`);
          if (pdfStream.size) res.setHeader('Content-Length', pdfStream.size);
          res.setHeader('Access-Control-Allow-Origin', '*');
          return pdfStream.stream.pipe(res);
        } else {
          return res.status(404).json({
            ok: false,
            error: 'Neither lab report nor discharge summary is available for this patient.',
            labError: labStatus.error,
            summaryError: summaryStatus.error,
          });
        }
      } else if (includeLab) {
        if (!labAvailable) {
          return res.status(404).json({
            ok: false,
            error: 'Lab report is not available for this patient.',
            detail: labStatus.error,
          });
        }
        const pdfStream = await getPdfStream(labStatus.objectKey);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Lab-Report-${patient.ipNo}.pdf"`);
        if (pdfStream.size) res.setHeader('Content-Length', pdfStream.size);
        res.setHeader('Access-Control-Allow-Origin', '*');
        return pdfStream.stream.pipe(res);
      } else if (includeSummary) {
        if (!summaryAvailable) {
          return res.status(404).json({
            ok: false,
            error: 'Discharge summary is not available for this patient.',
            detail: summaryStatus.error,
          });
        }
        const pdfStream = await getPdfStream(summaryStatus.objectKey);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Discharge-Summary-${patient.ipNo}.pdf"`);
        if (pdfStream.size) res.setHeader('Content-Length', pdfStream.size);
        res.setHeader('Access-Control-Allow-Origin', '*');
        return pdfStream.stream.pipe(res);
      }
    }

    // JSON response
    const baseUrl = getBaseUrl(req);
    const labDownloadUrl = `${baseUrl}/api/reports/download?type=lab&ipnumber=${encodeURIComponent(patient.ipNo)}&date=${patient.date}`;
    const summaryDownloadUrl = `${baseUrl}/api/reports/download?type=summary&ipnumber=${encodeURIComponent(patient.ipNo)}&date=${patient.date}`;
    const zipDownloadUrl = `${baseUrl}/api/reports/download?type=zip&ipnumber=${encodeURIComponent(patient.ipNo)}&date=${patient.date}`;

    const reportsObj = {};
    const filesList = [];

    if (includeLab) {
      let labBase64 = undefined;
      if (wantBase64 && labAvailable) {
        const buf = await getPdfBuffer(labStatus.objectKey);
        if (buf) labBase64 = buf.toString('base64');
      }

      reportsObj.lab = {
        requested: true,
        available: labAvailable,
        name: `Lab-Report-${patient.ipNo}.pdf`,
        mimeType: 'application/pdf',
        downloadUrl: labAvailable ? labDownloadUrl : null,
        streamUrl: labAvailable ? `/api/reports/download?type=lab&ipnumber=${encodeURIComponent(patient.ipNo)}&date=${patient.date}` : null,
        error: labAvailable ? undefined : labStatus.error,
        base64: labBase64,
      };

      if (labAvailable) {
        filesList.push({
          type: 'lab',
          name: `Lab-Report-${patient.ipNo}.pdf`,
          mimeType: 'application/pdf',
          url: labDownloadUrl,
        });
      }
    }

    if (includeSummary) {
      let summaryBase64 = undefined;
      if (wantBase64 && summaryAvailable) {
        const buf = await getPdfBuffer(summaryStatus.objectKey);
        if (buf) summaryBase64 = buf.toString('base64');
      }

      reportsObj.summary = {
        requested: true,
        available: summaryAvailable,
        name: `Discharge-Summary-${patient.ipNo}.pdf`,
        mimeType: 'application/pdf',
        downloadUrl: summaryAvailable ? summaryDownloadUrl : null,
        streamUrl: summaryAvailable ? `/api/reports/download?type=summary&ipnumber=${encodeURIComponent(patient.ipNo)}&date=${patient.date}` : null,
        error: summaryAvailable ? undefined : summaryStatus.error,
        base64: summaryBase64,
      };

      if (summaryAvailable) {
        filesList.push({
          type: 'summary',
          name: `Discharge-Summary-${patient.ipNo}.pdf`,
          mimeType: 'application/pdf',
          url: summaryDownloadUrl,
        });
      }
    }

    if (includeLab && includeSummary && (labAvailable || summaryAvailable)) {
      reportsObj.zip = {
        available: true,
        name: `Reports-${patient.ipNo}.zip`,
        mimeType: 'application/zip',
        downloadUrl: zipDownloadUrl,
        streamUrl: `/api/reports/download?type=zip&ipnumber=${encodeURIComponent(patient.ipNo)}&date=${patient.date}`,
      };
    }

    const response = {
      ok: true,
      patient: {
        uhid: patient.regNo || uhid,
        ipNo: patient.ipNo,
        name: cleanName(patient.name),
        gender: patient.gender || patient.emr?.GENDER || '',
        age: patient.age || patient.emr?.AGE || '',
        admissionDate: patient.admissionDate,
        dischargeDate: patient.dischargeDate,
        date: patient.date,
        doctor: patient.doctor || patient.emr?.DOCTOR1 || '',
        department: patient.department || patient.emr?.DEPARTMENT || '',
        ward: patient.ward || patient.emr?.WARD || '',
        bedNo: patient.bedNo || patient.emr?.['BED NO'] || '',
      },
      requested: {
        uhid: uhid || undefined,
        ipnumber: ipnumber || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        lab: includeLab,
        summary: includeSummary,
      },
      reports: reportsObj,
      files: filesList,
      downloadAllUrl: (includeLab && includeSummary && (labAvailable || summaryAvailable)) ? zipDownloadUrl : (filesList[0]?.url || null),
    };

    if (allMatches && allMatches.length > 1) {
      response.allStays = allMatches.map((m) => ({
        ipNo: m.ipNo,
        date: m.date,
        admissionDate: m.admissionDate,
        dischargeDate: m.dischargeDate,
        doctor: m.doctor,
        department: m.department,
      }));
    }

    return res.json(response);
  } catch (error) {
    console.error(`[reports-api] Error handling /api/reports:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function handleReportsDownload(req, res) {
  try {
    const params = { ...req.query, ...req.body };
    const { token, type, ipnumber, ipNo, date, uhid, regNo } = params;

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

    const cleanIp = String(ipnumber || ipNo || '').trim();
    const cleanUhid = String(uhid || regNo || '').trim();
    const cleanType = String(type || 'lab').trim().toLowerCase();

    let patientDate = date;
    let targetIp = cleanIp;

    if (!cleanIp || !patientDate) {
      if (!cleanIp && !cleanUhid) {
        return res.status(400).type('text/plain').send('Missing ipnumber or uhid');
      }
      const { primary: patient } = await findPatient({ uhid: cleanUhid, ipnumber: cleanIp });
      if (!patient) {
        return res.status(404).type('text/plain').send('Patient not found');
      }
      targetIp = patient.ipNo;
      patientDate = patient.date;
    }

    if (cleanType === 'lab') {
      const key = reportObjectKey(patientDate, targetIp);
      if (!(await pdfExists(key))) {
        await ensurePdfAvailable({ patient: { date: patientDate, ipNo: targetIp, regNo: cleanUhid }, type: 'lab' });
      }
      const pdf = await getPdfStream(key);
      if (!pdf) return res.status(404).type('text/plain').send('Lab report not found');
      res.setHeader('Content-Type', 'application/pdf');
      if (pdf.size) res.setHeader('Content-Length', pdf.size);
      res.setHeader('Content-Disposition', `inline; filename="Lab-Report-${targetIp}.pdf"`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      return pdf.stream.pipe(res);
    } else if (cleanType === 'summary') {
      const key = reportSummaryObjectKey(patientDate, targetIp);
      if (!(await pdfExists(key))) {
        await ensurePdfAvailable({ patient: { date: patientDate, ipNo: targetIp, regNo: cleanUhid }, type: 'summary' });
      }
      const pdf = await getPdfStream(key);
      if (!pdf) return res.status(404).type('text/plain').send('Discharge summary not found');
      res.setHeader('Content-Type', 'application/pdf');
      if (pdf.size) res.setHeader('Content-Length', pdf.size);
      res.setHeader('Content-Disposition', `inline; filename="Discharge-Summary-${targetIp}.pdf"`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      return pdf.stream.pipe(res);
    } else if (cleanType === 'zip' || cleanType === 'both' || cleanType === 'all') {
      const labKey = reportObjectKey(patientDate, targetIp);
      const summaryKey = reportSummaryObjectKey(patientDate, targetIp);

      const [labPdf, summaryPdf] = await Promise.all([
        getPdfStream(labKey),
        getPdfStream(summaryKey),
      ]);

      if (!labPdf && !summaryPdf) {
        return res.status(404).type('text/plain').send('Neither lab report nor summary report found');
      }

      const [labBuf, summaryBuf] = await Promise.all([
        labPdf ? streamToBuffer(labPdf.stream) : null,
        summaryPdf ? streamToBuffer(summaryPdf.stream) : null,
      ]);

      const zipBuf = await generateReportsZip({
        patient: { ipNo: targetIp, regNo: cleanUhid },
        labBuffer: labBuf,
        summaryBuffer: summaryBuf,
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="Reports-${targetIp}.zip"`);
      res.setHeader('Content-Length', zipBuf.length);
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(zipBuf);
    } else {
      return res.status(400).type('text/plain').send("Invalid type parameter. Expected 'lab', 'summary', or 'zip'.");
    }
  } catch (error) {
    console.error(`[reports-api] Download error:`, error);
    return res.status(500).type('text/plain').send(`Download failed: ${error.message}`);
  }
}

