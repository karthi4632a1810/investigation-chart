import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { loadSettings, publicSettings, settingsScreen, startSettingsRefresh, updateSettings } from './services/appSettingsService.js';
import { getLabDetail, searchInvestigation } from './services/emrService.js';
import {
  getReportPdfUrl,
  getReportRecord,
  getReportSummaryPdfUrl,
  getSchedulerStatus,
  listReportDates,
  loadReportIndex,
  runBackfillForDate,
  runDischargeCheck,
  searchReports,
  sendReportsWhatsApp,
  startDischargeScheduler,
} from './services/dischargeReportService.js';
import { getPdfStream, pdfExists, reportObjectKey, reportSummaryObjectKey } from './services/storageService.js';
import { isWebhookKey, readDocToken, webhookKey, whatsappLinkInfo } from './services/publicLinkService.js';
import { watiUsage } from './services/watiBudget.js';
import { getWatiSettings, updateWatiSettings } from './services/watiSettingsService.js';
import { clearSessionCookie, getSessionUser, loadSessionAccount, requireSession, setSessionCookie } from './services/sessionService.js';
import { allowedDocuments, effectivePermissions } from './services/accessControl.js';
import { auditMiddleware } from './services/auditMiddleware.js';
import {
  applyRetention,
  auditAiChats,
  auditFilterOptions,
  auditSummary,
  CATEGORIES as AUDIT_CATEGORIES,
  exportAudit,
  listAuditEvents,
  listAuditSessions,
  recordClientEvents,
  startSession,
} from './services/auditService.js';
import {
  accessModel,
  authenticate,
  changeOwnPassword,
  createUser,
  deleteUser,
  listUsers,
  publicUser,
  setPassword,
  signOutEverywhere,
  updateUser,
} from './services/userService.js';
import { hasCriteria, labResultsCoverage, listLabTests, normaliseQuery, searchLabResults } from './services/labResultsService.js';
import { buildExport, EXPORT_FORMATS, exportFileName, shareLabResultsOnWhatsApp } from './services/labExportService.js';
import { checkWhatsAppNumber, toWatiNumber } from './services/watiService.js';
import { runAssistant } from './services/assistantService.js';
import { buildDischargeExport, DISCHARGE_EXPORT_FORMATS } from './services/dischargeReportQuery.js';
import { sendTestWhatsApp } from './services/whatsappTestService.js';
import { lookupKey, sendLookupWhatsApp } from './services/labLookupService.js';
import { chatExportStream, EXPORT_TYPES as CHAT_EXPORT_TYPES } from './services/chatResultsService.js';
import { checkMessageStatus, retryQueueFacts } from './services/whatsappLogService.js';
import {
  getPollState,
  getWhatsappMessage,
  handleWatiWebhook,
  listWhatsappMessages,
  numbersNotOnWhatsApp,
  pollWhatsAppStatuses,
  startWhatsAppStatusPoller,
  whatsappActivity,
  whatsappInsights,
  whatsappPatients,
  whatsappSummary,
} from './services/whatsappLogService.js';
import { buildWhatsappExport, WA_EXPORT_FORMATS } from './services/whatsappExportService.js';
import { retryWhatsAppMessage, startWhatsAppRetryWorker } from './services/whatsappRetryService.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const candidatePaths = [
  path.join(__dirname, '../../client/dist'),
  path.join(__dirname, '../client/dist'),
  path.join(__dirname, '../dist'),
  path.join(__dirname, '../../dist'),
  path.join(__dirname, './dist'),
];

const clientDistPath = candidatePaths.find((p) => fs.existsSync(path.join(p, 'index.html'))) || candidatePaths[0];

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Serve static frontend files (React dist)
  app.use(express.static(clientDistPath));

  /**
   * A report PDF for WhatsApp / WATI, which can't log in: the signed token in
   * the link names one PDF and when the link stops working (publicLinkService.js).
   */
  app.get('/api/public/doc/:token/:filename', async (req, res) => {
    const objectKey = readDocToken(req.params.token);
    if (!objectKey) return res.status(410).type('text/plain').send('This link has expired. Please ask the hospital to send the report again.');
    try {
      const pdf = await getPdfStream(objectKey);
      if (!pdf) return res.status(404).type('text/plain').send('Report not found');
      const name = String(req.params.filename || 'Report.pdf').replace(/[^\w.-]+/g, '-');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', pdf.size);
      res.setHeader('Content-Disposition', `inline; filename="${name}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Robots-Tag', 'noindex');
      if (req.method === 'HEAD') return res.end();
      pdf.stream.on('error', () => res.destroy());
      pdf.stream.pipe(res);
    } catch (error) {
      res.status(503).type('text/plain').send('Report temporarily unavailable');
    }
  });

  /** WATI webhook (Connectors → Webhooks): message sent / delivered / read / failed. */
  app.post('/api/public/wati-webhook/:key', async (req, res) => {
    if (!isWebhookKey(req.params.key)) return res.status(404).json({ ok: false });
    // Always 200 once the key is right, so WATI doesn't keep re-sending an event.
    try {
      const events = Array.isArray(req.body) ? req.body : [req.body];
      const results = [];
      for (const event of events) results.push(await handleWatiWebhook(event || {}));
      res.json({ ok: true, results });
    } catch (error) {
      console.warn(`[whatsapp] webhook event not processed: ${error.message}`);
      res.json({ ok: true, error: error.message });
    }
  });

  // Audit log: records API actions as they finish (auditMiddleware.js) —
  // registered first so sign-in / sign-out are covered too.
  app.use(auditMiddleware);

  // Everything under /api below needs a logged-in session, except the few
  // routes the login screen itself uses (see sessionService.js).
  app.use(requireSession);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Staff accounts and the built-in super admin (userService.js).
  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    try {
      const user = await authenticate(username, password, req.ip);
      // A new audit session (sign-in → sign-out), carried in the cookie.
      const sid = await startSession(user, req).catch(() => null);
      req.sessionId = sid;
      setSessionCookie(req, res, user.username, user.tokenVersion || 0, sid);
      res.json({ ok: true, username: user.username, user: publicUser(user), app: publicSettings() });
    } catch (error) {
      res.status(error.status || 401).json({ ok: false, code: error.code, error: error.message });
    }
  });

  app.get('/api/session', async (req, res) => {
    try {
      const account = await loadSessionAccount(req);
      if (!account) return res.status(401).json({ ok: false, error: 'Not logged in' });
      if (account.blocked) return res.status(401).json({ ok: false, code: 'outside_hours', error: account.blocked });
      res.json({ ok: true, username: account.user.username, user: publicUser(account.user), app: publicSettings() });
    } catch (error) {
      res.status(503).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.get('/api/config/hospital', (_req, res) => {
    res.json(config.hospital);
  });

  app.post('/api/search', async (req, res) => {
  const { regNo, fromDate, toDate } = req.body || {};

  if (!regNo?.trim() || !fromDate || !toDate) {
    return res.status(400).json({ ok: false, error: 'regNo, fromDate, and toDate are required' });
  }

  try {
    const result = await searchInvestigation(regNo.trim(), fromDate, toDate);
    if (!result.ok) {
      return res.status(500).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/detail/:orderid', async (req, res) => {
  const orderid = String(req.params.orderid || '').trim();

  if (!orderid || !/^\d+$/.test(orderid)) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid orderid' });
  }

  try {
    const result = await getLabDetail(orderid);
    if (!result.ok) {
      return res.status(500).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

  /**
   * Discharge report automation (read-only browsing endpoints).
   *
   * PDFs live in MinIO at <YYYY-MM-DD>/<IP_NO>.pdf, generated by the hourly
   * scheduler in dischargeReportService.js; metadata lives in Mongo. Date and IP
   * number are both matched against a strict whitelist before being used to build
   * an object key or Mongo filter from request input.
   */
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const IP_RE = /^[A-Za-z0-9]{1,20}$/;

  app.get('/api/reports/status', (_req, res) => {
    res.json({ ok: true, ...getSchedulerStatus() });
  });

  app.get('/api/reports/dates', async (_req, res) => {
    try {
      res.json({ ok: true, dates: await listReportDates() });
    } catch (error) {
      res.status(503).json({ ok: false, error: `Reports store unavailable: ${error.message}` });
    }
  });

  // Must come before /api/reports/:date — otherwise Express would match "search"
  // as the :date param and reject it as an invalid date.
  app.get('/api/reports/search', async (req, res) => {
    try {
      const patients = await searchReports(req.query);
      res.json({ ok: true, patients });
    } catch (error) {
      res.status(503).json({ ok: false, error: `Reports store unavailable: ${error.message}` });
    }
  });

  app.get('/api/reports/:date', async (req, res) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ ok: false, error: 'Invalid date format, expected YYYY-MM-DD' });
    }
    try {
      res.json({ ok: true, date, patients: await loadReportIndex(date) });
    } catch (error) {
      res.status(503).json({ ok: false, error: `Reports store unavailable: ${error.message}` });
    }
  });

  /**
   * Redirects to a short-lived MinIO presigned URL rather than proxying the PDF
   * bytes through this server — the browser downloads directly from MinIO, and a
   * plain <a href> / target="_blank" still works transparently across the redirect.
   */
  app.get('/api/reports/:date/:ip/pdf', async (req, res) => {
    const { date, ip } = req.params;
    if (!DATE_RE.test(date) || !IP_RE.test(ip)) {
      return res.status(400).json({ ok: false, error: 'Invalid date or IP number' });
    }

    try {
      if (!(await pdfExists(reportObjectKey(date, ip)))) {
        return res.status(404).json({ ok: false, error: 'Report not found' });
      }
      res.redirect(await getReportPdfUrl(date, ip));
    } catch (error) {
      res.status(503).json({ ok: false, error: `Reports store unavailable: ${error.message}` });
    }
  });

  /** The EMR's own discharge summary document — separate from the lab chart above. */
  app.get('/api/reports/:date/:ip/summary-pdf', async (req, res) => {
    const { date, ip } = req.params;
    if (!DATE_RE.test(date) || !IP_RE.test(ip)) {
      return res.status(400).json({ ok: false, error: 'Invalid date or IP number' });
    }

    try {
      if (!(await pdfExists(reportSummaryObjectKey(date, ip)))) {
        return res.status(404).json({ ok: false, error: 'Discharge summary not found' });
      }
      res.redirect(await getReportSummaryPdfUrl(date, ip));
    } catch (error) {
      res.status(503).json({ ok: false, error: `Reports store unavailable: ${error.message}` });
    }
  });

  /** Manual trigger so you don't have to wait up to an hour to see it work. */
  app.post('/api/reports/run-now', async (_req, res) => {
    try {
      const summary = await runDischargeCheck();
      res.json({ ok: true, summary });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  /**
   * Backfill a past date. The live scheduler only ever checks "today", so a
   * date that's already gone by is otherwise never revisited — this runs the
   * identical per-patient logic against a caller-supplied date instead. Can
   * take a while for a busy day (one EMR round-trip per missing document), so
   * this is meant to be fired and then watched via /api/reports/status.
   */
  app.post('/api/reports/backfill/:date', async (req, res) => {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'Invalid date format, expected YYYY-MM-DD' });
    }
    try {
      const summary = await runBackfillForDate(date);
      res.json({ ok: true, summary });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  /**
   * WATI live-mode settings — see watiSettingsService.js. `liveEnabled: false`
   * (the default) routes manual sends to `fixedNumber` instead of real patient
   * numbers, and disables the automation's auto-send entirely.
   */
  app.get('/api/wati/settings', async (_req, res) => {
    try {
      res.json({ ok: true, settings: await getWatiSettings() });
    } catch (error) {
      res.status(503).json({ ok: false, error: `Settings store unavailable: ${error.message}` });
    }
  });

  app.post('/api/wati/settings', async (req, res) => {
    try {
      res.json({ ok: true, settings: await updateWatiSettings(req.body || {}) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  /**
   * Manual "Send WhatsApp" trigger for a patient's lab report (never the
   * discharge summary). Target number depends on WATI live mode: the
   * patient's own mobile on file when live, otherwise the configured fixed
   * test number — same rule the automation's auto-send follows.
   */
  app.post('/api/reports/:date/:ip/send-whatsapp', async (req, res) => {
    const { date, ip } = req.params;
    if (!DATE_RE.test(date) || !IP_RE.test(ip)) {
      return res.status(400).json({ ok: false, error: 'Invalid date or IP number' });
    }
    try {
      const [labExists, summaryExists, record, settings] = await Promise.all([
        pdfExists(reportObjectKey(date, ip)),
        pdfExists(reportSummaryObjectKey(date, ip)),
        getReportRecord(date, ip),
        getWatiSettings(),
      ]);
      // A summary the EMR returned with no patient data is never sent; a user
      // who only sees one kind of report only sends that kind.
      const allowed = allowedDocuments(req.user);
      const kinds = [];
      if (labExists && allowed.includes('lab')) kinds.push('lab');
      if (summaryExists && !record?.summaryDataMissing && allowed.includes('summary')) kinds.push('summary');
      if (!kinds.length) {
        return res.status(404).json({ ok: false, error: 'No lab report or discharge summary to send' });
      }

      // The confirm popup may send an edited number; otherwise the mode decides.
      const defaultNumber = settings.liveEnabled ? record?.mobile : settings.fixedNumber;
      let toNumber = defaultNumber;
      if (req.body?.toNumber) {
        const checked = checkWhatsAppNumber(req.body.toNumber);
        if (!checked.ok) return res.status(400).json({ ok: false, error: checked.error });
        toNumber = checked.digits;
      }
      // For the audit log: the number used, and whether staff changed it.
      res.locals.auditExtra = {
        to: toNumber ? `+${toWatiNumber(toNumber)}` : '',
        numberEdited: Boolean(req.body?.toNumber) && toWatiNumber(req.body.toNumber) !== toWatiNumber(defaultNumber),
      };
      if (!toNumber) {
        return res.status(400).json({
          ok: false,
          error: settings.liveEnabled
            ? 'No mobile number on file for this patient'
            : 'No fixed test number configured — set one in WATI Settings first',
        });
      }

      // Lab report, then discharge summary — two messages (see sendReportsWhatsApp).
      const result = await sendReportsWhatsApp({
        dateFolder: date,
        ipNo: ip,
        toNumber,
        name: record?.name || ip,
        note: settings.secondParam,
        kinds,
        log: {
          trigger: 'manual',
          triggeredBy: getSessionUser(req),
          patientName: record?.name || '',
          department: record?.department || '',
          liveMode: settings.liveEnabled,
          numberEdited: Boolean(req.body?.toNumber) && toWatiNumber(req.body.toNumber) !== toWatiNumber(defaultNumber),
        },
      });
      if (result.failed.length) {
        const sentNote = result.sent.length ? `${result.sent.map((d) => d.label).join(' and ')} sent; ` : '';
        const failedNote = result.failed.map((f) => `${f.label} failed: ${f.error}`).join('; ');
        return res.status(502).json({ ok: false, sentTo: toNumber, ...result, error: sentNote + failedNote });
      }
      res.json({ ok: true, sentTo: toNumber, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  /**
   * Lab Finder — search stored lab values across patients (labResultsService.js),
   * export them, or share them on WhatsApp. All behind the login session.
   */
  function validWhatsAppNumber(raw) {
    const digits = toWatiNumber(raw);
    return digits.length >= 11 && digits.length <= 15 ? digits : null;
  }

  app.get('/api/lab-results/tests', async (req, res) => {
    try {
      res.json({ ok: true, tests: await listLabTests(String(req.query.q || '').slice(0, 80)) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/lab-results/coverage', async (_req, res) => {
    try {
      res.json({ ok: true, ...(await labResultsCoverage()) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/lab-results/search', async (req, res) => {
    const query = normaliseQuery(req.body?.query);
    if (!hasCriteria(query)) {
      return res.status(400).json({ ok: false, error: 'Enter a test name, value or patient to search for' });
    }
    try {
      res.json({ ok: true, ...(await searchLabResults(query)) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/lab-results/export', async (req, res) => {
    const format = String(req.body?.format || '');
    const query = normaliseQuery(req.body?.query);
    if (!EXPORT_FORMATS[format]) return res.status(400).json({ ok: false, error: 'Format must be pdf, xlsx, docx or csv' });
    if (!hasCriteria(query)) return res.status(400).json({ ok: false, error: 'Nothing to export — search first' });
    try {
      const file = await buildExport(await searchLabResults(query), format);
      res.setHeader('Content-Type', EXPORT_FORMATS[format].mime);
      res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(query, format)}"`);
      res.send(file);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/lab-results/share', async (req, res) => {
    const query = normaliseQuery(req.body?.query);
    const toNumber = validWhatsAppNumber(req.body?.toNumber);
    if (!toNumber) return res.status(400).json({ ok: false, error: 'Enter a valid WhatsApp number' });
    if (!hasCriteria(query)) return res.status(400).json({ ok: false, error: 'Nothing to share — search first' });
    try {
      const search = await searchLabResults(query);
      if (!search.total) return res.status(404).json({ ok: false, error: 'No results to share' });
      await shareLabResultsOnWhatsApp(search, {
        toNumber,
        recipientName: String(req.body?.recipientName || '').slice(0, 60),
        log: { trigger: 'share', via: shareVia(req.body?.via), triggeredBy: getSessionUser(req) },
      });
      res.json({ ok: true, sentTo: `+${toNumber}` });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // Staff-chosen number (from the Lab Finder or the assistant) — unlike
  // send-whatsapp above, this ignores live mode because a person typed the
  // destination on purpose. Empty summaries are still never sent.
  app.post('/api/reports/:date/:ip/share', async (req, res) => {
    const { date, ip } = req.params;
    if (!DATE_RE.test(date) || !IP_RE.test(ip)) {
      return res.status(400).json({ ok: false, error: 'Invalid date or IP number' });
    }
    const toNumber = validWhatsAppNumber(req.body?.toNumber);
    if (!toNumber) return res.status(400).json({ ok: false, error: 'Enter a valid WhatsApp number' });
    try {
      const [labExists, summaryExists, record, settings] = await Promise.all([
        pdfExists(reportObjectKey(date, ip)),
        pdfExists(reportSummaryObjectKey(date, ip)),
        getReportRecord(date, ip),
        getWatiSettings(),
      ]);
      const allowed = allowedDocuments(req.user);
      const kinds = [];
      if (labExists && allowed.includes('lab')) kinds.push('lab');
      if (summaryExists && !record?.summaryDataMissing && allowed.includes('summary')) kinds.push('summary');
      if (!kinds.length) return res.status(404).json({ ok: false, error: 'No lab report or discharge summary to send' });
      const result = await sendReportsWhatsApp({
        dateFolder: date,
        ipNo: ip,
        toNumber,
        name: record?.name || ip,
        note: settings.secondParam,
        kinds,
        log: {
          trigger: 'share',
          via: shareVia(req.body?.via),
          triggeredBy: getSessionUser(req),
          patientName: record?.name || '',
          department: record?.department || '',
        },
      });
      if (result.failed.length) {
        return res.status(502).json({ ok: false, ...result, error: result.failed.map((f) => `${f.label}: ${f.error}`).join('; ') });
      }
      res.json({ ok: true, sentTo: `+${toNumber}`, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  function shareVia(via) {
    return ['lab_finder', 'assistant', 'reports'].includes(via) ? via : null;
  }

  /**
   * /admin WhatsApp monitor (whatsappLogService.js): analytics, message list,
   * one message's timeline, the live activity feed, and an on-demand WATI
   * status check. Behind the login like everything else.
   */
  const adminQuery = (req) => ({
    from: req.query.from,
    to: req.query.to,
    basis: req.query.basis === 'report' ? 'report' : 'sent', // "Dates by" (whatsappLogService.js rangeFilter)
    fromTime: req.query.fromTime, // optional HH:MM window (timeWindow)
    toTime: req.query.toTime,
    status: req.query.status,
    document: req.query.document,
    trigger: req.query.trigger,
    q: req.query.q,
    page: req.query.page,
    limit: req.query.limit,
  });

  app.get('/api/admin/whatsapp/summary', async (req, res) => {
    try {
      res.json({ ok: true, ...(await whatsappSummary(adminQuery(req))) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/admin/whatsapp/messages', async (req, res) => {
    try {
      res.json({ ok: true, ...(await listWhatsappMessages(adminQuery(req))) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/admin/whatsapp/messages/:id', async (req, res) => {
    try {
      const message = await getWhatsappMessage(req.params.id);
      if (!message) return res.status(404).json({ ok: false, error: 'Message not found' });
      res.json({ ok: true, message });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/admin/whatsapp/activity', async (req, res) => {
    try {
      res.json({ ok: true, events: await whatsappActivity(parseInt(req.query.limit, 10) || 25) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/admin/whatsapp/insights', async (req, res) => {
    try {
      const [insights, settings] = await Promise.all([whatsappInsights(adminQuery(req)), getWatiSettings()]);
      res.json({ ok: true, liveEnabled: settings.liveEnabled, ...insights });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/admin/whatsapp/patients', async (req, res) => {
    try {
      res.json({ ok: true, ...(await whatsappPatients(adminQuery(req))) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/admin/whatsapp/export', async (req, res) => {
    const format = String(req.query.format || '');
    const view = req.query.view === 'patients' ? 'patients' : 'messages';
    if (!WA_EXPORT_FORMATS[format]) return res.status(400).json({ ok: false, error: 'Format must be xlsx, pdf, csv or json' });
    try {
      const { buffer, filename, mime } = await buildWhatsappExport(adminQuery(req), view, format);
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/admin/whatsapp/messages/:id/retry', async (req, res) => {
    try {
      const message = await retryWhatsAppMessage(req.params.id, { triggeredBy: getSessionUser(req) });
      res.json({ ok: true, message: { ...message, _id: undefined } });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/whatsapp/not-on-whatsapp', async (_req, res) => {
    try {
      res.json({ ok: true, numbers: await numbersNotOnWhatsApp() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  /** WATI API calls made (today / this month), status-check state, webhook and link setup. */
  app.get('/api/admin/whatsapp/wati-usage', async (req, res) => {
    try {
      res.json({
        ok: true,
        usage: await watiUsage(),
        poll: getPollState(),
        link: whatsappLinkInfo(),
        // The webhook URL is a secret — only for those who can change things here.
        webhookPath: effectivePermissions(req.user).screens.monitor === 'write' ? `/api/public/wati-webhook/${webhookKey()}` : null,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/admin/whatsapp/refresh', async (_req, res) => {
    try {
      res.json({ ok: true, poll: await pollWhatsAppStatuses({ force: true }) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  /**
   * AI assistant (assistantService.js): the model only picks read-only tools;
   * the data it finds goes straight to the page as `blocks`, not through the model.
   */
  app.post('/api/assistant', async (req, res) => {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ ok: false, error: 'Ask a question' });
    try {
      res.json({
        ok: true,
        ...(await runAssistant({
          messages,
          context: req.body?.context || {},
          user: getSessionUser(req),
          access: effectivePermissions(req.user),
          superAdmin: Boolean(req.user?.isSuperAdmin),
          chatId: req.body?.chatId,
        })),
      });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  /** Discharge report download (Ask AI's report tables): Excel, PDF or CSV. */
  app.get('/api/discharges/export', async (req, res) => {
    const format = String(req.query.format || '');
    if (!DISCHARGE_EXPORT_FORMATS[format]) return res.status(400).json({ ok: false, error: 'Format must be xlsx, pdf or csv' });
    try {
      const { buffer, filename, mime } = await buildDischargeExport(req.query, format);
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  /**
   * Ask AI lab lookups (labLookupService.js): the PDF found straight in the
   * EMR (OP patients too), its WhatsApp send, and a sent message's status.
   */
  app.get('/api/assistant/lookup/:day/:id.pdf', async (req, res) => {
    const key = lookupKey(req.params.day, req.params.id);
    if (!key) return res.status(400).json({ ok: false, error: 'Invalid lab report link' });
    try {
      const pdf = await getPdfStream(key);
      if (!pdf) return res.status(404).json({ ok: false, error: 'That lab report is no longer available — ask again' });
      const name = String(req.query.name || 'Lab-Report.pdf').replace(/[^\w.-]+/g, '-');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', pdf.size);
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
      pdf.stream.on('error', () => res.destroy());
      pdf.stream.pipe(res);
    } catch (error) {
      res.status(503).json({ ok: false, error: `Reports store unavailable: ${error.message}` });
    }
  });

  /** A file Ask AI made from this chat's results (chatResultsService.js). */
  app.get('/api/assistant/export/:day/:id.:ext', async (req, res) => {
    try {
      const file = await chatExportStream(req.params.day, req.params.id, req.params.ext);
      if (!file) return res.status(404).json({ ok: false, error: 'That file is no longer available — ask again' });
      const name = String(req.query.name || `ask-ai-results.${req.params.ext}`).replace(/[^\w.-]+/g, '-');
      res.setHeader('Content-Type', CHAT_EXPORT_TYPES[req.params.ext]);
      res.setHeader('Content-Length', file.size);
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
      file.stream.on('error', () => res.destroy());
      file.stream.pipe(res);
    } catch (error) {
      res.status(503).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/assistant/lookup/:day/:id/whatsapp', async (req, res) => {
    try {
      const sent = await sendLookupWhatsApp({
        day: req.params.day,
        lookupId: req.params.id,
        toNumber: req.body?.toNumber,
        name: req.body?.name,
        id: req.body?.patientId,
        triggeredBy: getSessionUser(req),
      });
      res.json({ ok: true, ...sent });
    } catch (error) {
      res.status(error.status || 502).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/assistant/message/:id/status', async (req, res) => {
    try {
      const state = await checkMessageStatus(req.params.id, { ask: Boolean(req.body?.check) });
      if (!state) return res.status(404).json({ ok: false, error: 'Message not found' });
      res.json({ ok: true, message: state });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  /**
   * Audit log (auditService.js): the browser's own events (screens, popups,
   * idle / hidden time), and the Audit Log screen's data and downloads.
   */
  app.post('/api/audit/events', async (req, res) => {
    try {
      // sendBeacon posts text/plain — parse it here.
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      res.json({ ok: true, recorded: await recordClientEvents(req, body) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });
  const auditQuery = (req) => ({
    from: req.query.from,
    to: req.query.to,
    user: req.query.user,
    department: req.query.department,
    category: req.query.category,
    session: req.query.session,
    presence: req.query.presence,
    q: req.query.q,
    page: req.query.page,
    limit: req.query.limit,
  });
  const auditRoute = (fn) => async (req, res) => {
    try {
      res.json({ ok: true, ...(await fn(req)) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  };
  app.get('/api/audit/summary', auditRoute(async (req) => auditSummary(auditQuery(req))));
  app.get('/api/audit/events', auditRoute(async (req) => listAuditEvents(auditQuery(req))));
  app.get('/api/audit/sessions', auditRoute(async (req) => ({ sessions: await listAuditSessions(auditQuery(req)) })));
  app.get('/api/audit/ai-chats', auditRoute(async (req) => ({ chats: await auditAiChats(auditQuery(req)) })));
  app.get('/api/audit/options', auditRoute(async () => ({ ...(await auditFilterOptions()), categories: AUDIT_CATEGORIES })));
  app.get('/api/audit/export', async (req, res) => {
    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
    try {
      const { buffer, filename, mime } = await exportAudit(auditQuery(req), format);
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  /** The Send button on an Ask AI test-message card. */
  app.post('/api/assistant/test-whatsapp', async (req, res) => {
    try {
      const sent = await sendTestWhatsApp({ message: req.body?.message, toNumber: req.body?.toNumber, triggeredBy: getSessionUser(req) });
      res.json({ ok: true, ...sent });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  /**
   * User management — super admin only (accessControl.js). Users sign in with
   * their own username; each has screens, Ask AI, WhatsApp button, reports and
   * access hours (userService.js).
   */
  const userRoute = (fn) => async (req, res) => {
    try {
      res.json({ ok: true, ...(await fn(req)) });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  };
  app.get('/api/users', userRoute(async () => ({ users: await listUsers(), model: accessModel() })));
  app.post('/api/users', userRoute(async (req) => ({ user: await createUser(req.body || {}, getSessionUser(req)) })));
  app.put('/api/users/:username', userRoute(async (req) => ({ user: await updateUser(req.params.username, req.body || {}, getSessionUser(req)) })));
  app.post(
    '/api/users/:username/password',
    userRoute(async (req) => {
      await setPassword(req.params.username, req.body?.password, getSessionUser(req), { mustChange: req.body?.mustChange !== false });
      return {};
    }),
  );
  app.post(
    '/api/users/:username/sign-out',
    userRoute(async (req) => {
      await signOutEverywhere(req.params.username, getSessionUser(req));
      return {};
    }),
  );
  app.delete(
    '/api/users/:username',
    userRoute(async (req) => {
      await deleteUser(req.params.username);
      return {};
    }),
  );

  /** The signed-in user's own profile and password. */
  // Also how open pages pick up Master Settings changes (polled every minute).
  app.get('/api/me', userRoute(async (req) => ({ user: publicUser(req.user), app: publicSettings() })));

  /**
   * Master Settings — super admin only (accessControl.js). Every tunable of
   * the portal (appSettingsService.js), with live numbers for context.
   */
  // How many active staff accounts have each feature in their own access —
  // i.e. who a global switch turns it off for.
  const FEATURE_HOLDERS = {
    'features.whatsappButton': (p) => p.whatsappButton && p.screens.reports === 'write',
    'features.askAi': (p) => p.ai !== 'none',
    'features.aiSend': (p) => p.ai === 'act',
    'features.opLookup': (p) => p.ai !== 'none' && p.screens.search !== 'none',
    'features.labSearch': (p) => p.screens.search !== 'none',
    'features.labFinder': (p) => p.screens.labFinder !== 'none',
    'features.exports': (p) => ['reports', 'labFinder', 'monitor'].some((id) => p.screens[id] !== 'none'),
  };
  const settingsLive = async () => {
    const [wati, retries, watiSettings, users] = await Promise.all([
      watiUsage().catch(() => null),
      retryQueueFacts().catch(() => null),
      getWatiSettings().catch(() => null),
      listUsers().catch(() => []),
    ]);
    const staff = users.filter((u) => !u.isSuperAdmin && u.active !== false);
    return {
      wati,
      retries,
      scheduler: getSchedulerStatus(),
      whatsappLive: watiSettings ? Boolean(watiSettings.liveEnabled) : null,
      staffCount: staff.length,
      featureHolders: Object.fromEntries(Object.entries(FEATURE_HOLDERS).map(([key, has]) => [key, staff.filter((u) => has(u.permissions)).length])),
    };
  };
  app.get('/api/settings', userRoute(async () => ({ ...(await settingsScreen()), live: await settingsLive() })));
  app.put(
    '/api/settings',
    userRoute(async (req) => {
      const values = req.body?.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw Object.assign(new Error('Nothing to save'), { status: 400 });
      return { ...(await updateSettings(values, getSessionUser(req))), live: await settingsLive() };
    }),
  );
  app.post('/api/me/password', async (req, res) => {
    try {
      const version = await changeOwnPassword(req.user.username, req.body?.current, req.body?.password);
      // Stay signed in here; sessions on other devices end.
      setSessionCookie(req, res, req.user.username, version, req.sessionId);
      res.json({ ok: true });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  // Fallback for Single Page Application (SPA) routing
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });

  return app;
}

// Master Settings first — the scheduler, retries and sessions read them.
await loadSettings();
startSettingsRefresh();
applyRetention().catch((error) => console.warn(`[audit] retention not updated: ${error.message}`));

const app = createApp();

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
  console.log(`Serving static UI from: ${clientDistPath} (exists: ${fs.existsSync(clientDistPath)})`);
  console.log('Server restarted to load updated .env credentials!');
});

startDischargeScheduler();

// WhatsApp monitor: import earlier test-number messages once, then keep
// delivered / read up to date (webhooks, or sparse status checks).
startWhatsAppRetryWorker();
getWatiSettings()
  .then((settings) => startWhatsAppStatusPoller([settings.fixedNumber]))
  .catch((error) => console.warn(`[whatsapp] status poller not started: ${error.message}`));
