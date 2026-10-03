/**
 * "Ask AI" — a tool-calling assistant for staff.
 *
 * The model (Groq, falling back to Gemini; both via their OpenAI-compatible
 * chat APIs) only decides which read-only tool to call and with what
 * arguments. Tools run here against Mongo; what they find is returned to the
 * page as `blocks` (patient cards, result tables, download/share options,
 * status cards) and the model is told only counts and non-identifying facts —
 * patient names, phone numbers and lab values never go to the AI provider from
 * tool results. Nothing is sent on WhatsApp without the user confirming: the
 * share tool only prepares a card the user must press Send on, and a test
 * message goes only after its card was shown and the user pressed Send or said
 * yes to exactly that message and number (ctx.pendingTest).
 *
 * Questions about the portal itself — what a button or colour means, why
 * WhatsApp isn't sending, WATI's quota, the 15-minute check — are answered from
 * the built-in manual (appGuide.js) and live status (app_status,
 * whatsapp_report), never guessed.
 */
import { config } from '../config.js';
import { getMongoCollection } from './mongo.js';
import { getSchedulerStatus, loadReportIndex } from './dischargeReportService.js';
import { labResultsCoverage, listLabTests, normaliseQuery, searchLabResults, hasCriteria } from './labResultsService.js';
import { GUIDE, searchGuide } from './appGuide.js';
import { whatsappLinkInfo } from './publicLinkService.js';
import { watiUsage } from './watiBudget.js';
import { getWatiSettings } from './watiSettingsService.js';
import { failureCategory, getPollState, retryQueueFacts, whatsappReportData, whatsappSummary } from './whatsappLogService.js';
import { dischargeReport } from './dischargeReportQuery.js';
import { cleanLookupId, lookupLabReport } from './labLookupService.js';
import { checkWhatsAppNumber } from './watiService.js';
import { comparePatients, detailsForModel, patientDetails, patientJourney } from './patientInsightService.js';
import { buildChatExport, listResults, numberResult, saveReply } from './chatResultsService.js';
import { searchPatients } from './patientSearchService.js';

// Patient details (name, age, mobile, address, lab values…) go to the AI
// service so it can answer with them — "her WhatsApp number", "discharge time
// in 12-hour format", "compare these two". AI_SHARE_PATIENT_DATA=off keeps them
// on screen only (the model then just gets counts). ABHA ID and religion are never sent.
// Master Settings → Ask AI (default from AI_SHARE_PATIENT_DATA, else on).
const SHARE = () => setting('ai.sharePatientData');
import { cleanTestMessage, cleanTestNumber, formatNumber, sendTestWhatsApp } from './whatsappTestService.js';
import { FULL_PERMISSIONS } from './userService.js';
import { setting } from './appSettingsService.js';

const GROQ_KEY = process.env.GROQ_API_KEY || process.env.GROQ_API;
const GROQ_URL = 'https://api.groq.com/openai/v1';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

function listFromEnv(value, fallback) {
  const list = String(value || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return list.length ? list : fallback;
}

// Tried in order. Free tiers limit requests/tokens per model, and each model
// has its own limit — so several models from each provider, before the
// rule-based answer at the very end (ruleBasedAnswer) that needs no AI at all.
// Override with GROQ_MODELS / GEMINI_CHAT_MODELS (comma-separated).
const PROVIDERS = [
  ...listFromEnv(process.env.GROQ_MODELS, ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']).map((model) => ({
    name: `groq:${model}`,
    baseUrl: GROQ_URL,
    key: GROQ_KEY,
    model,
  })),
  ...listFromEnv(process.env.GEMINI_CHAT_MODELS, [
    config.gemini?.model || 'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-flash-lite-latest',
  ]).map((model) => ({
    name: `gemini:${model}`,
    baseUrl: GEMINI_URL,
    key: process.env.GEMINI_API_KEY,
    model,
  })),
].filter((p) => p.key);

const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY = 16;
const BLOCK_ROW_LIMIT = 300;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIst() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { iso: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
}

const SCREEN_LABELS = { reports: 'Discharge Reports', labFinder: 'Lab Finder', search: 'Lab Search', wati: 'WATI Settings', admin: 'WhatsApp Monitor' };

// What each tool needs (the user's permissions, userService.js) — the model is
// only offered tools the user may use, and each call is checked again.
const canRead = (a, screen) => a.screens[screen] !== 'none';
const TOOL_ACCESS = {
  find_patient: (a) => canRead(a, 'reports'),
  list_discharges: (a) => canRead(a, 'reports'),
  search_lab_results: (a) => canRead(a, 'labFinder'),
  list_lab_tests: (a) => canRead(a, 'labFinder'),
  app_help: () => true,
  app_status: (a) => canRead(a, 'monitor') || canRead(a, 'wati'),
  whatsapp_report: (a) => canRead(a, 'monitor'),
  discharge_report: (a) => canRead(a, 'reports'),
  open_screen: () => true,
  offer_download: (a) => a.exports !== false && (canRead(a, 'labFinder') || canRead(a, 'reports')),
  offer_whatsapp_share: (a) => a.ai === 'act',
  send_test_whatsapp: (a) => a.ai === 'act',
  lab_report_lookup: (a) => a.ai !== 'none' && canRead(a, 'search') && a.opLookup !== false,
  patient_details: (a) => canRead(a, 'reports'),
  patient_journey: (a) => canRead(a, 'reports'),
  compare_patients: (a) => canRead(a, 'reports'),
  export_results: (a) => a.exports !== false,
  offer_lookup_whatsapp: (a) => a.ai === 'act' && canRead(a, 'search') && a.opLookup !== false,
};
const SCREEN_OF = { discharge_reports: 'reports', lab_finder: 'labFinder', lab_search: 'search', wati_settings: 'wati', whatsapp_monitor: 'monitor', audit_log: 'audit' };
const NO_ACCESS = "This user's account has no access to that. Tell them to ask the super admin if they need it.";

class NoAccessError extends Error {}

function describeAccess(a) {
  if (!a) return '';
  const names = { search: 'Lab Search', reports: 'Discharge Reports', labFinder: 'Lab Finder', wati: 'WATI Settings', monitor: 'WhatsApp Monitor' };
  const none = Object.entries(a.screens).filter(([, v]) => v === 'none').map(([k]) => names[k]);
  const readOnly = Object.entries(a.screens).filter(([k, v]) => v === 'read' && k !== 'search').map(([k]) => names[k]);
  const lines = [];
  if (none.length) lines.push(`- This user has no access to: ${none.join(', ')}. If they ask for those, say their account doesn't include it and the super admin can add it.`);
  if (readOnly.length) lines.push(`- Read-only for this user: ${readOnly.join(', ')}.`);
  if (a.documents !== 'both') lines.push(`- This user only sees ${a.documents === 'lab' ? 'lab reports' : 'discharge summaries'}.`);
  if (a.ai !== 'act') lines.push('- This user can ask questions but not send or share on WhatsApp from Ask AI.');
  return lines.join('\n');
}

function describeContext(context) {
  const lines = [];
  const access = describeAccess(context.access);
  if (access) lines.push(access);
  if (context.results?.length) {
    lines.push(`- Results so far in this chat: ${context.results.map((r) => `#${r.n} ${r.title}`).join('; ')}.`);
  }
  if (context.view && SCREEN_LABELS[context.view]) {
    lines.push(`- The user is on the ${SCREEN_LABELS[context.view]} screen. "This screen", "here" etc. mean it.`);
  }
  const q = context.lastLabQuery;
  if (q) {
    const parts = [q.test && `test "${q.test}"`, q.value && `result "${q.value}"`, q.status && `flag ${q.status}`, q.from && `from ${q.from}`, q.to && `to ${q.to}`].filter(Boolean);
    lines.push(`- The latest lab results list on screen: ${parts.join(', ') || 'a lab search'}. "That list", "these results" etc. mean this — use target "lab_results".`);
  }
  if (context.lastLookup?.lookupId) {
    lines.push(`- A lab report was just looked up for ${context.lastLookup.id}. "Send it", "that report" mean this — use offer_lookup_whatsapp once you have a number.`);
  }
  if (context.testDraft?.message) {
    lines.push(`- A test WhatsApp message is being prepared: "${context.testDraft.message}" — the number is still needed.`);
  }
  if (context.pendingTest) {
    lines.push(`- A test WhatsApp card is waiting for confirmation: "${context.pendingTest.message}" to +${context.pendingTest.toNumber}. If the user says yes / send / ok, call send_test_whatsapp with that message and number and confirm: true.`);
  }
  if (context.lastPatient?.ipNo) {
    lines.push(`- The latest single patient shown: ${context.lastPatient.ipNo} (discharged ${context.lastPatient.date}). "This patient", "their report" etc. mean this — use target "patient".`);
  }
  return lines.length ? `\nWhat the user is looking at now:\n${lines.join('\n')}\n` : '';
}

function systemPrompt(context = {}) {
  const today = todayIst();
  const hospital = config.hospital?.nameEn || 'Adhiparasakthi Hospitals';
  return `You are the help assistant inside the ${hospital} Diagnostics Summary Portal, used by hospital staff.
Today is ${today.weekday}, ${today.iso} (India time). Resolve "today", "yesterday", "last week", "this month" etc. from this date. Tool dates are YYYY-MM-DD; in replies write dates as DD-MM-YYYY.

Screens: Lab Search (one patient's results from the EMR), Discharge Reports (each discharged patient's Lab Report + Discharge Summary PDFs, made every ${setting('discharge.checkMinutes')} minutes; WhatsApp button), Lab Finder (lab values across patients, exports), WATI Settings (Test mode / Live), WhatsApp Monitor (/admin: every WhatsApp message, delivered/read/failed, WATI quota).

${describeContext(context)}
Rules:
- Use the tools for anything about patients, reports or lab results. Never invent names, IP numbers, values or counts.
- To find a patient by anything — IP number, UHID, mobile / WhatsApp number (any format or its last digits), name or part of it, lab Req No, bed, doctor, ward, address, town, relation's name — call find_patient with exactly what they typed. It searches every date (not just today) and shows their reports with download and WhatsApp options. Use it whenever someone asks "find / who is / which patient has …". Don't use discharge_report to look up one patient, and don't send them to Lab Search for that.
- A question about one patient given by their mobile number, name or anything else ("age and discharge time of the patient with number 89396 05869") goes straight to patient_details with that value as id — it accepts the same values as find_patient. Answer the question itself, not just "details are below".
- If find_patient finds the patient, say who it is and what matched (e.g. "Baby Gugan Priyan, IP07029120, discharged 02-10-2026 — mobile 8939605869 matches"). If several match, say how many and that they're listed best match first.
- If find_patient finds nothing for a UHID or IP number (often an OP / out-patient, who isn't in the discharge data), call lab_report_lookup with that number to search the EMR lab directly (last ${setting('ai.lookupDays')} days unless they give dates). OP patients exist only here in the chat — never say they'll appear in Discharge Reports. Once found, offer: open or download the PDF, or send it on WhatsApp. For WhatsApp ask "Which WhatsApp number should I send it to?", then call offer_lookup_whatsapp; if it says the number is wrong (e.g. only 9 digits), tell them exactly that and ask for the correct number. They press Send on the card, which then shows whether it was sent, not on WhatsApp, delivered or read.
${SHARE()
    ? `- Tool results come to you with the patient data, and also appear on screen as numbered results (#1, #2 …). Answer the question itself from the data — a mobile number, a discharge time, an age, an address, a value — formatted the way the user asks (e.g. "29/09/2026, 12:24 PM", 12-hour time, "3 days 4 hours"). Don't paste long lists; the table is on screen.
- For anything about one discharged patient (mobile / WhatsApp number, age, gender, address, city, relation, email, diagnosis, admission or discharge date and time, length of stay, doctor, ward, bed, reports, WhatsApp status, out-of-range lab values) call patient_details.`
    : "- Tool results are shown to the user on screen; you only get counts. Don't repeat patient details — say briefly what was found and that it's shown below."}
- Patient journey / timeline / flowchart / "what happened to this patient": call patient_journey and describe it in order with dates and times.
- Compare two patients, or one patient's lab values on two dates ("compare this report with the earlier one", "how did her values change"): call compare_patients, then explain the main differences with numbers — which values rose or fell, which are out of range.
- Any other question about patients or data: work out which tools give the data, call them (several if needed), then answer with the numbers. Never say you can't when a tool can get it.
- Each result on screen is numbered #1, #2 … in this chat (listed above). To make files: call export_results with the numbers (empty = all) and a format — pdf, xlsx (Excel) or csv. Several files = several calls (e.g. #1 and #2 as one PDF, #3 as CSV). include_answers adds the questions and your answers. "Everything in one PDF" = all results, pdf.
- For lab questions use search_lab_results. Qualitative results (negative, positive, nil, trace, reactive) go in "value"; "high"/"low"/"abnormal" go in "status"; numbers in "min"/"max". If you're unsure of the test name, or the search finds nothing, call list_lab_tests and ask which test they mean.
- After showing results, offer the options: download as PDF, Excel, Word or CSV, or share on WhatsApp. When they pick a format, call offer_download. When they want WhatsApp, ask for the number if they haven't given it, then call offer_whatsapp_share. Never say a message was sent — the user confirms with the Send button.
- To take the user to a screen, call open_screen.
- Questions about the portal itself — how to do something, what a screen, button, badge, colour, tick or message means, why something happened, what a setting does — call app_help and answer only from what it returns. Never guess how the portal works.
- Reports: for WhatsApp delivery (patient-wise and/or message-wise), call whatsapp_report; for discharged patients (lists, counts, departments, doctors, lab / summary / WhatsApp status) call discharge_report. They take any dates plus an optional time window — "today 10 am to 2 pm" = from and to today, from_time 10:00, to_time 14:00; "yesterday evening" = 16:00–20:00. WhatsApp reports count patients by discharge date/time unless the user says "sent" (then date_basis sent). "patient and message wise" = view both. The table and downloads (Excel, PDF, CSV) appear on screen — summarise the totals in a sentence or two.
- Live questions — is WhatsApp working, why reports aren't sending, WATI usage limit / 429, Test or Live mode, webhook, PDF links, when the next discharge check runs — call app_status. For WhatsApp counts, failures or one patient's messages, call whatsapp_report. Combine with app_help to explain what to do. Give times as shown (India time). Report watiApi as given — if it says UNKNOWN, say it isn't known yet whether WATI is accepting messages.
- Only mention buttons, icons, menus and settings that app_help describes — never invent UI. Never mention tool names; offer to do it instead (e.g. "Shall I open the WhatsApp Monitor?").
- To send a test WhatsApp message, call send_test_whatsapp with whatever the user gave. If it says the message or the number is missing, ask for that one thing (message first, then number) and nothing else. When it shows the confirmation card, tell the user to press Send or say yes. Only say it was sent when the tool returns sent: true.
- For "how do I…" answers use short numbered steps with the screen names, and open the screen if it helps.
- Keep replies short (1-4 sentences, or a few steps). Reply in English, unless the user writes in Tamil or another language — then use that language.`;
}

const TOOLS = [
  {
    name: 'find_patient',
    description:
      'Find discharged patients by anything about them, across every date: IP number, UHID, mobile / WhatsApp number (any format, or its last digits), name or part of it (any order), lab Req No, bed, doctor, department, ward, staff who created it, relation name, address, town or village. Shows their report cards on screen, best match first, and says what matched.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Exactly what the user gave, e.g. "8939605869", "+91 89396 05869", "IP07028148", "6181354", "gugan priyan", "tindivanam"' },
        date: { type: 'string', description: 'Optional discharge date YYYY-MM-DD — only if the user named one' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_discharges',
    description: 'List patients discharged on a date (optionally one department). Shows them on screen.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Discharge date YYYY-MM-DD' },
        department: { type: 'string', description: 'Optional department name, e.g. PAEDIATRICS' },
      },
      required: ['date'],
    },
  },
  {
    name: 'search_lab_results',
    description: 'Search stored lab results across patients. Shows a results table on screen with download and WhatsApp options.',
    parameters: {
      type: 'object',
      properties: {
        test: { type: 'string', description: 'Test name words, e.g. "urine glucose", "haemoglobin", "creatinine"' },
        value: { type: 'string', description: 'Text the result must contain, e.g. "negative", "positive", "nil"' },
        status: { type: 'string', enum: ['high', 'low', 'abnormal', 'normal'], description: 'Compared with the reference range' },
        min: { type: 'number', description: 'Numeric result at least this' },
        max: { type: 'number', description: 'Numeric result at most this' },
        from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to: { type: 'string', description: 'End date YYYY-MM-DD' },
        date_basis: { type: 'string', enum: ['discharge', 'result'], description: 'Whether from/to are discharge dates (default) or test result dates' },
        ip_no: { type: 'string', description: 'Only this patient (IP number)' },
        patient: { type: 'string', description: 'Only patients whose name contains this' },
        department: { type: 'string', description: 'Only this department' },
      },
    },
  },
  {
    name: 'list_lab_tests',
    description: 'List lab test names available for searching that match some words, with result counts.',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string', description: 'Words from the test name, e.g. "glucose"' } },
      required: ['q'],
    },
  },
  {
    name: 'app_help',
    description:
      "The portal's manual: what every screen, button, badge, colour, status and tick means, how reports and WhatsApp sending work, retries, WATI usage limit, webhook, PDF links, and IT/deploy notes. Use for any question about the portal itself.",
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: "The user's question or its key words, e.g. 'red No Summary button', 'blue top line on card', '429'" } },
      required: ['question'],
    },
  },
  {
    name: 'app_status',
    description:
      'Live status of the portal: WhatsApp/WATI (Test or Live mode, test number, extra line, template, whether WATI is refusing calls and until when, API calls used today/this month, webhook, PDF links, messages today, reports waiting to retry) and the 15-minute discharge check (last run, result, next run). Shows a status card.',
    parameters: {
      type: 'object',
      properties: { area: { type: 'string', enum: ['whatsapp', 'scheduler', 'all'], description: 'Default all' } },
    },
  },
  {
    name: 'whatsapp_report',
    description:
      "WhatsApp report for any dates and time of day, patient-wise and message-wise, like the WhatsApp Monitor: totals (patients, messages, sent / delivered / read / failed / pending), failure reasons, and a table on screen with Excel / PDF / CSV / JSON downloads. With ip_no, one patient's messages.",
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (default today)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (default = from)' },
        from_time: { type: 'string', description: 'Optional start time HH:MM, 24-hour India time (10 am = 10:00)' },
        to_time: { type: 'string', description: 'Optional end time HH:MM, 24-hour (2 pm = 14:00)' },
        date_basis: {
          type: 'string',
          enum: ['report', 'sent'],
          description: "report (default) = patients discharged in the range (their discharge time for a time window); sent = messages sent in the range",
        },
        view: { type: 'string', enum: ['both', 'patients', 'messages'], description: 'patient-wise, message-wise, or both (default)' },
        status: { type: 'string', enum: ['pending', 'sent', 'delivered', 'read', 'failed'] },
        document: { type: 'string', enum: ['lab', 'summary'] },
        trigger: { type: 'string', enum: ['auto', 'manual', 'share'] },
        search: { type: 'string', description: 'Patient name, IP number, phone or staff name' },
        ip_no: { type: 'string', description: "One patient's IP number" },
      },
    },
  },
  {
    name: 'discharge_report',
    description:
      "Report of patients discharged in a date and optional time range, with filters (department, doctor, patient type, lab report / discharge summary status, WhatsApp status, search). Shows totals and a table with Excel / PDF / CSV downloads. Use for any discharge / patient report, counts or list with a time window or filters.",
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (default today)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (default = from)' },
        from_time: { type: 'string', description: 'Optional discharge time from, HH:MM 24-hour' },
        to_time: { type: 'string', description: 'Optional discharge time to, HH:MM 24-hour' },
        department: { type: 'string' },
        doctor: { type: 'string' },
        patient_type: { type: 'string', description: 'General or Corporate' },
        lab: { type: 'string', enum: ['ready', 'none'], description: 'ready = has a lab report; none = no lab data' },
        summary: { type: 'string', enum: ['ready', 'no_summary', 'pending'], description: 'no_summary = the red No Summary (EMR had no data)' },
        whatsapp: { type: 'string', enum: ['read', 'delivered', 'sent', 'failed', 'none', 'nowa'], description: 'none = not sent; nowa = not on WhatsApp' },
        search: { type: 'string', description: 'Patient name, IP number, UHID or mobile' },
      },
    },
  },
  {
    name: 'patient_details',
    description:
      'Everything about one discharged patient: mobile / WhatsApp number, age, gender, address, city, district, relation, email, diagnosis, admission and discharge date-time, length of stay, doctor, ward, bed, patient type, reports, WhatsApp status, out-of-range lab values. Shows a details card.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Anything that identifies the patient: IP number, UHID, mobile / WhatsApp number (any format), or name' },
        date: { type: 'string', description: 'Optional discharge date YYYY-MM-DD (if they had several stays)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'patient_journey',
    description: "A patient's journey as a timeline / flowchart: admission, lab test days (with out-of-range values), discharge, reports made, WhatsApp sent / delivered / read, staff actions.",
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Anything that identifies the patient: IP number, UHID, mobile / WhatsApp number (any format), or name' }, date: { type: 'string', description: 'Optional discharge date YYYY-MM-DD' } },
      required: ['id'],
    },
  },
  {
    name: 'compare_patients',
    description:
      "Compare two patients side by side (a and b), or one patient's lab values on two dates (only a, plus a_date / b_date; default first vs last lab day). Lab values matched test by test with the change, plus demographics for two patients.",
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'IP number, UHID, mobile number or name' },
        b: { type: 'string', description: 'Second patient (leave empty to compare one patient over time)' },
        a_date: { type: 'string', description: 'Optional lab result date for a, YYYY-MM-DD' },
        b_date: { type: 'string', description: 'Optional lab result date for b, YYYY-MM-DD' },
      },
      required: ['a'],
    },
  },
  {
    name: 'export_results',
    description: 'Make one downloadable file from numbered results of this chat (#1, #2 …): pdf, xlsx (Excel) or csv. Empty results = all of them.',
    parameters: {
      type: 'object',
      properties: {
        results: { type: 'array', items: { type: 'integer' }, description: 'Result numbers, e.g. [1, 2]; empty for all' },
        format: { type: 'string', enum: ['pdf', 'xlsx', 'csv'] },
        title: { type: 'string', description: 'Optional file title' },
        include_answers: { type: 'boolean', description: 'Also include each question and the answer' },
      },
      required: ['format'],
    },
  },
  {
    name: 'lab_report_lookup',
    description:
      "Find a patient's lab report straight in the EMR lab by UHID or IP number — including OP (out-patient) patients who aren't in the discharge data. Makes the lab report PDF and shows it with open / download / WhatsApp options. Default range: the last 30 days.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UHID (digits, e.g. 6159338) or IP number (e.g. IP07028148)' },
        from: { type: 'string', description: 'Optional start date YYYY-MM-DD' },
        to: { type: 'string', description: 'Optional end date YYYY-MM-DD' },
      },
      required: ['id'],
    },
  },
  {
    name: 'offer_lookup_whatsapp',
    description:
      'Prepare sending the lab report just looked up (lab_report_lookup) on WhatsApp to the number the user gave. Checks the number first; shows a card the user confirms with Send.',
    parameters: {
      type: 'object',
      properties: { to_number: { type: 'string', description: 'WhatsApp number the user gave' } },
      required: ['to_number'],
    },
  },
  {
    name: 'send_test_whatsapp',
    description:
      "Send a test WhatsApp message (the user's text) to a number, through the hospital's approved template with a small test PDF. Call it with whatever the user gave; it asks for anything missing and shows a confirmation card. Use confirm: true only after the card was shown and the user said yes/send.",
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The text to send, exactly as the user wrote it (without surrounding quotes)' },
        to_number: { type: 'string', description: 'WhatsApp number, e.g. +919962460782' },
        confirm: { type: 'boolean', description: 'true only when the user confirmed the card that was shown' },
      },
    },
  },
  {
    name: 'open_screen',
    description: 'Take the user to a screen of the portal.',
    parameters: {
      type: 'object',
      properties: {
        screen: { type: 'string', enum: ['discharge_reports', 'lab_finder', 'lab_search', 'wati_settings', 'whatsapp_monitor', 'audit_log', 'users', 'master_settings'] },
        date: { type: 'string', description: 'For discharge_reports: the date to show, YYYY-MM-DD' },
        filter: { type: 'string', description: 'For discharge_reports: text to filter the list by (name, IP, doctor, ward)' },
      },
      required: ['screen'],
    },
  },
  {
    name: 'offer_download',
    description: 'Show a download button for the latest lab results or for one patient, in the chosen format.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['pdf', 'xlsx', 'docx', 'csv'] },
        target: { type: 'string', enum: ['lab_results', 'patient'], description: 'Latest lab results table (default) or one patient' },
        ip_no: { type: 'string', description: 'For target=patient' },
        date: { type: 'string', description: 'For target=patient: discharge date YYYY-MM-DD' },
      },
      required: ['format'],
    },
  },
  {
    name: 'offer_whatsapp_share',
    description: 'Prepare a WhatsApp share (latest lab results PDF, or one patient\'s lab report + discharge summary) for the user to confirm and send.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['lab_results', 'patient'] },
        to_number: { type: 'string', description: 'WhatsApp number the user gave, if any' },
        ip_no: { type: 'string', description: 'For target=patient' },
        date: { type: 'string', description: 'For target=patient: discharge date YYYY-MM-DD' },
      },
      required: ['target'],
    },
  },
];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PATIENT_FIELDS = ['date', 'ipNo', 'regNo', 'name', 'age', 'gender', 'patientType', 'department', 'doctor', 'ward', 'dateCount', 'hasSummary', 'summaryDataMissing', 'summaryApprovedBy'];
const patientCard = (r) => Object.fromEntries(PATIENT_FIELDS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
const patientFacts = (r) => ({
  ipNo: r.ipNo,
  dischargeDate: r.date,
  hasLabReport: r.dateCount !== undefined,
  hasDischargeSummary: Boolean(r.hasSummary && !r.summaryDataMissing),
  ...(SHARE()
    ? {
        name: r.name,
        uhid: r.regNo,
        age: r.age,
        gender: r.gender,
        mobile: r.mobile,
        department: r.department,
        doctor: r.doctor,
        ward: r.ward,
        admitted: r.admissionDate,
        discharged: r.dischargeDate,
        dischargeType: r.dischargeType,
      }
    : {}),
});

async function findPatientRecord(ipNo, date) {
  const c = await getMongoCollection('discharge_reports');
  const filter = { ipNo: { $regex: `^${escapeRegex(ipNo)}$`, $options: 'i' } };
  if (DATE_RE.test(date || '')) filter.date = date;
  return c.find(filter, { projection: { _id: 0 } }).sort({ date: -1 }).limit(1).next();
}

// ---- Live status (app_status) -------------------------------------------------

const dmy = (iso) => String(iso || '').split('-').reverse().join('-');

/** A time the model or user gave ("10:00", "10", "10am", "2 pm", "14:30") as HH:MM, or null. */
function toHHMM(value) {
  const m = /^\s*(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(String(value || ''));
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h <= 23 && min <= 59 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
}

/** from / to dates (default today) and an optional time window from the tool arguments. */
function reportDates(args = {}) {
  const today = todayIst().iso;
  const start = DATE_RE.test(args.from || '') ? args.from : today;
  const end = DATE_RE.test(args.to || '') ? args.to : start;
  const [from, to] = start <= end ? [start, end] : [end, start];
  const fromTime = toHHMM(args.from_time);
  const toTime = toHHMM(args.to_time);
  if (!fromTime && !toTime) return { from, to };
  // "8 pm to 8 am" on one day means overnight: from the evening before.
  const overnight = from === to && fromTime && toTime && fromTime > toTime;
  const firstDay = overnight ? new Date(new Date(`${from}T12:00:00+05:30`).getTime() - 86400_000 + 330 * 60_000).toISOString().slice(0, 10) : from;
  return { from: firstDay, to, fromTime: fromTime || '00:00', toTime: toTime || '23:59' };
}

function describeRange(q) {
  const days = q.from === q.to ? dmy(q.from) : `${dmy(q.from)} to ${dmy(q.to)}`;
  const time = q.fromTime ? `, ${q.fromTime}–${q.toTime}` : '';
  return `${q.basis === 'sent' ? 'sent' : 'patients discharged'} ${days}${time}`;
}

/** A time as India time, e.g. "30-09-2026 10:32". */
function istTime(date) {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(d)
    .replace(/\//g, '-')
    .replace(',', '');
}

async function whatsappStatusFacts() {
  const today = todayIst().iso;
  const [settings, usage, queue, todaySummary] = await Promise.all([
    getWatiSettings(),
    watiUsage(),
    retryQueueFacts(),
    whatsappSummary({ from: today, to: today }),
  ]);
  const poll = getPollState();
  const link = whatsappLinkInfo();
  const configured = Boolean(config.wati.endpoint && config.wati.accessToken);
  const extraLine = String(settings.secondParam || '').trim();
  // Only what this app has seen: its latest WATI call was refused (or it's pausing after one).
  const lastOk = usage.lastOkAt ? new Date(usage.lastOkAt) : null;
  const lastRefused = usage.lastRefusedAt ? new Date(usage.lastRefusedAt) : null;
  const refusing = Boolean(usage.pausedUntil) || Boolean(lastRefused && (!lastOk || lastRefused > lastOk));
  const c = todaySummary.counts;
  const updates = poll.webhook.active ? 'WATI webhook (instant)' : poll.enabled ? `Status checks (max ${poll.dailyChecks}/day)` : 'Off';

  const facts = {
    watiConfigured: configured,
    mode: settings.liveEnabled ? 'Live — sent automatically to patients' : 'Test mode — nothing automatic; manual sends go to the test number',
    extraLine: extraLine || null,
    template: config.wati.templateId,
    liveMode: Boolean(settings.liveEnabled),
    // The app can't ask WATI for free whether it's accepting calls — it only knows what its own calls got back.
    watiApi: refusing
      ? `REFUSING calls — WATI API usage limit (429) since ${istTime(lastRefused || usage.pausedUntil)}. Refused reports are re-sent automatically.`
      : lastOk && Date.now() - lastOk.getTime() < 6 * 3600_000
        ? `Accepting calls — the latest call went through at ${istTime(lastOk)}`
        : 'UNKNOWN — this app has made no WATI calls in the last few hours, so it cannot tell whether WATI is accepting. Do not say WhatsApp is working.',
    callsRefusedToday: usage.today.rateLimited,
    pausedUntil: istTime(usage.pausedUntil),
    lastUsageLimitAt: istTime(usage.lastRateLimitAt),
    refusedByUsageLimitLast24h: queue.refusedByUsageLimitLast24h,
    apiCallsToday: usage.today,
    apiCallsThisMonth: usage.month,
    statusUpdates: updates,
    lastWebhookEvent: istTime(poll.webhook.lastEventAt),
    lastStatusCheck: istTime(poll.at),
    pdfLinks: link.https ? `https via ${link.baseUrl}, valid ${link.days} days` : `plain http (MinIO), valid ${link.days} days — WATI inbox can't preview them`,
    messagesToday: { ...c, total: todaySummary.total },
    waitingForAutomaticRetry: queue.waiting,
    nextRetryAt: istTime(queue.nextRetryAt),
  };

  const rows = [
    { label: 'WATI', value: configured ? 'Configured' : 'Not configured', tone: configured ? 'ok' : 'bad' },
    { label: 'Mode', value: settings.liveEnabled ? 'Live (to patients)' : 'Test mode', tone: settings.liveEnabled ? 'ok' : 'warn' },
    ...(settings.liveEnabled ? [] : [{ label: 'Test number', value: settings.fixedNumber }]),
    ...(extraLine ? [{ label: 'Extra line', value: extraLine, tone: settings.liveEnabled ? 'warn' : undefined }] : []),
    {
      label: 'WATI API',
      value: usage.pausedUntil
        ? `Refusing calls (usage limit) · paused until ${istTime(usage.pausedUntil)}`
        : refusing
          ? `Refusing calls (usage limit) since ${istTime(lastRefused)}`
          : lastOk && Date.now() - lastOk.getTime() < 6 * 3600_000
            ? `Accepting calls · last OK ${istTime(lastOk)}`
            : 'No recent calls, so not known yet',
      tone: refusing ? 'bad' : lastOk && Date.now() - lastOk.getTime() < 6 * 3600_000 ? 'ok' : undefined,
    },
    { label: 'API calls', value: `Today ${usage.today.total} · this month ${usage.month.total}` },
    { label: 'Delivery updates', value: updates, tone: poll.webhook.active ? 'ok' : 'warn' },
    { label: 'PDF links', value: link.https ? `https · ${link.days} days` : `http · ${link.days} days`, tone: link.https ? 'ok' : 'warn' },
    { label: 'Today', value: `${todaySummary.total} messages · ${c.sent + c.delivered + c.read} sent · ${c.delivered + c.read} delivered · ${c.read} read · ${c.failed} failed` },
    ...(queue.waiting ? [{ label: 'Retry queue', value: `${queue.waiting} waiting · next ${istTime(queue.nextRetryAt)}`, tone: 'warn' }] : []),
  ];
  return { facts, section: { title: 'WhatsApp / WATI', rows, link: { view: 'admin', label: 'Open WhatsApp Monitor' } } };
}

function schedulerStatusFacts() {
  const s = getSchedulerStatus();
  const last = s.lastSummary || {};
  const facts = {
    runsEvery: '15 minutes (:00, :15, :30, :45)',
    checking: Boolean(s.checkInProgress),
    lastCheckFinished: istTime(s.lastCheckFinishedAt),
    nextCheck: istTime(s.nextCheckAt),
    lastResult: s.lastSummary
      ? {
          date: last.date,
          found: last.found,
          alreadyReady: last.alreadyReported,
          labReportsMade: last.generated,
          noLabData: last.noLabData,
          failed: last.failed,
          summariesMade: last.summaryGenerated,
          summaryIssues: last.summaryFailed,
        }
      : null,
  };
  const rows = [
    { label: 'Discharge check', value: s.checkInProgress ? 'Running now' : 'Every 15 minutes', tone: 'ok' },
    { label: 'Last finished', value: istTime(s.lastCheckFinishedAt) || 'Not yet' },
    { label: 'Next check', value: istTime(s.nextCheckAt) || '—' },
    ...(s.lastSummary
      ? [
          {
            label: 'Last result',
            value: `${last.found ?? 0} found · ${last.alreadyReported ?? 0} ready · ${last.generated ?? 0} new lab · ${last.summaryGenerated ?? 0} new summaries${last.failed ? ` · ${last.failed} failed` : ''}`,
            tone: last.failed || last.summaryFailed ? 'warn' : 'ok',
          },
        ]
      : []),
  ];
  return { facts, section: { title: 'Discharge check', rows, link: { view: 'reports', label: 'Open Discharge Reports' } } };
}

/** Each tool returns { forModel, block? }. */
const handlers = {
  async find_patient({ query, date }) {
    const q = String(query || '').trim().slice(0, 80);
    if (!q) return { forModel: { error: 'Give a name, IP number, UHID, mobile number or anything else about the patient' } };
    // Any value, every date (patientSearchService.js); a date the user named narrows it.
    let docs = await searchPatients(q, { date: DATE_RE.test(date || '') ? date : undefined });
    let note;
    if (!docs.length && DATE_RE.test(date || '')) {
      docs = await searchPatients(q);
      if (docs.length) note = `Not discharged on ${date} — these are from other dates.`;
    }
    const on = [...new Set(docs.map((d) => d.match.on))];
    return {
      forModel: {
        count: docs.length,
        searchedFor: q,
        searchedAllDates: !note && !DATE_RE.test(date || ''),
        matchedOn: on.join(', '),
        ...(note ? { note } : {}),
        patients: docs.slice(0, 5).map((d) => ({ ...patientFacts(d), matchedOn: d.match.on })),
        ...(docs.length ? {} : { hint: 'Nothing in the discharge data on any date. For a UHID or IP number of an OP patient, try lab_report_lookup.' }),
      },
      block: docs.length
        ? {
            type: 'patients',
            title: `Found ${docs.length} match${docs.length === 1 ? '' : 'es'} for “${q}” · by ${on.slice(0, 2).join(', ')}${note ? ' · other dates' : ''}`,
            patients: docs.map(patientCard),
          }
        : undefined,
    };
  },

  async list_discharges({ date, department }) {
    if (!DATE_RE.test(date || '')) return { forModel: { error: 'date must be YYYY-MM-DD' } };
    let docs = await loadReportIndex(date);
    if (department) docs = docs.filter((d) => String(d.department || '').toUpperCase().includes(String(department).toUpperCase()));
    const byDepartment = {};
    for (const d of docs) byDepartment[d.department || 'Unknown'] = (byDepartment[d.department || 'Unknown'] || 0) + 1;
    const labReports = docs.filter((d) => d.dateCount !== undefined && d.dateCount !== null).length;
    const summaries = docs.filter((d) => d.hasSummary && !d.summaryDataMissing).length;
    const noSummary = docs.filter((d) => d.summaryDataMissing).length;
    return {
      forModel: {
        date,
        count: docs.length,
        byDepartment,
        labReports,
        noLabData: docs.length - labReports,
        dischargeSummaries: summaries,
        noSummaryRedButton: noSummary,
        summaryNotYetAvailable: docs.length - summaries - noSummary,
      },
      block: docs.length ? { type: 'patients', title: `${docs.length} discharged on ${date}${department ? ` · ${department}` : ''}`, patients: docs.map(patientCard) } : undefined,
    };
  },

  async search_lab_results(args) {
    const query = normaliseQuery({
      test: args.test,
      value: args.value,
      status: args.status,
      min: args.min,
      max: args.max,
      from: args.from,
      to: args.to,
      dateBasis: args.date_basis,
      ipNo: args.ip_no,
      patient: args.patient,
      department: args.department,
    });
    if (!hasCriteria(query)) return { forModel: { error: 'Give at least a test name, result value or patient' } };
    const search = await searchLabResults(query);
    const forModel = { total: search.total, patients: search.patients, matchedTests: search.matchedTests.slice(0, 12) };
    if (SHARE() && search.total) {
      forModel.rows = search.rows.slice(0, 80).map((r) => `${r.name} ${r.ipNo} | ${r.test} = ${r.value} (${r.range || 'no range'}) ${r.status || ''} | ${r.resultDate}`);
      if (search.total > 80) forModel.note = `first 80 of ${search.total} rows`;
    }
    if (!search.total) {
      forModel.coverage = await labResultsCoverage();
      if (query.test) forModel.similarTests = (await listLabTests(query.test.split(/\s+/).pop(), 10)).map((t) => (t.section ? `${t.section} › ${t.test}` : t.test));
    }
    return {
      forModel,
      block: {
        type: 'labResults',
        query: search.query,
        total: search.total,
        patients: search.patients,
        matchedTests: search.matchedTests,
        truncated: search.truncated || search.total > BLOCK_ROW_LIMIT,
        rows: search.rows.slice(0, BLOCK_ROW_LIMIT),
      },
    };
  },

  async list_lab_tests({ q }) {
    const tests = await listLabTests(String(q || '').slice(0, 60), 20);
    return { forModel: { tests: tests.map((t) => ({ name: t.section ? `${t.section} › ${t.test}` : t.test, results: t.count })) } };
  },

  async app_help({ question }) {
    const sections = searchGuide(question, 2);
    return {
      forModel: sections.length
        ? { sections: sections.map((s) => ({ title: s.title, text: s.text })) }
        : { note: 'Nothing in the manual matches. Topics available:', topics: GUIDE.map((s) => s.title) },
    };
  },

  async app_status({ area = 'all' }) {
    const facts = {};
    const sections = [];
    if (area === 'whatsapp' || area === 'all') {
      const w = await whatsappStatusFacts();
      facts.whatsapp = w.facts;
      sections.push(w.section);
    }
    if (area === 'scheduler' || area === 'all') {
      const s = schedulerStatusFacts();
      facts.dischargeCheck = s.facts;
      sections.push(s.section);
    }
    return { forModel: facts, block: { type: 'status', title: 'Portal status', sections } };
  },

  async whatsapp_report(args) {
    const q = reportDates(args);
    const ipNo = /^ip\s*\d+$/i.test(String(args.ip_no || '').trim()) ? String(args.ip_no).replace(/\s+/g, '').toUpperCase() : null;
    const query = ipNo
      ? { q: ipNo, basis: 'sent' }
      : {
          from: q.from,
          to: q.to,
          ...(q.fromTime ? { fromTime: q.fromTime, toTime: q.toTime } : {}),
          basis: args.date_basis === 'sent' ? 'sent' : 'report',
          ...(['pending', 'sent', 'delivered', 'read', 'failed'].includes(args.status) ? { status: args.status } : {}),
          ...(['lab', 'summary'].includes(args.document) ? { document: args.document } : {}),
          ...(['auto', 'manual', 'share'].includes(args.trigger) ? { trigger: args.trigger } : {}),
          ...(args.search ? { q: String(args.search).slice(0, 60) } : {}),
        };
    const { summary, patients, messages } = await whatsappReportData(query, 100);
    const c = summary.counts;
    const totals = {
      patients: summary.patients,
      messages: summary.total,
      sent: summary.funnel.sent,
      delivered: summary.funnel.delivered,
      read: c.read,
      pending: c.pending,
      failed: c.failed,
      notOnWhatsAppNumbers: summary.notOnWhatsApp.numbers,
    };
    const reasons = {};
    for (const m of messages.items) if (m.status === 'failed') reasons[failureCategory(m)] = (reasons[failureCategory(m)] || 0) + 1;
    const patientRows = patients.items.map((p) => ({
      key: p.key,
      patientName: p.patientName,
      ipNo: p.ipNo,
      dischargeDate: p.dischargeDate,
      department: p.department,
      status: p.status,
      notOnWhatsApp: p.notOnWhatsApp,
      lab: p.reports.find((r) => r.document === 'lab')?.status || null,
      summary: p.reports.find((r) => r.document === 'summary')?.status || null,
      lastAt: p.lastAt,
    }));
    const messageRows = messages.items.map((m) => ({
      id: m.id,
      patientName: m.patientName,
      ipNo: m.ipNo,
      document: m.documentLabel || m.document,
      status: m.status,
      notOnWhatsApp: Boolean(m.notOnWhatsApp),
      sentAt: m.acceptedAt || m.createdAt,
      trigger: m.trigger,
      reason: m.status === 'failed' ? failureCategory(m) : null,
      nextRetryAt: m.status === 'failed' ? m.nextRetryAt || null : null,
    }));
    const view = ['patients', 'messages'].includes(args.view) ? args.view : 'both';
    return {
      forModel: {
        range: ipNo ? `all messages for ${ipNo}` : describeRange(query),
        totals,
        note: 'sent includes delivered and read; delivered includes read',
        failureReasons: reasons,
        shownOnScreen: `${patientRows.length} patient rows, ${messageRows.length} message rows, with downloads`,
      },
      block: {
        type: 'whatsappReport',
        title: ipNo ? `WhatsApp · ${ipNo}` : `WhatsApp report · ${describeRange(query)}`,
        query,
        view,
        totals,
        patients: patientRows,
        patientsTotal: patients.total,
        messages: messageRows,
        messagesTotal: messages.total,
      },
    };
  },

  async discharge_report(args) {
    const q = reportDates(args);
    const report = await dischargeReport({
      ...q,
      department: args.department,
      doctor: args.doctor,
      patientType: args.patient_type,
      lab: args.lab,
      summary: args.summary,
      whatsapp: args.whatsapp,
      q: args.search,
    });
    // A search with nothing in these dates: say where that patient is instead.
    const elsewhere = args.search && !report.rows.length ? await searchPatients(args.search, { limit: 5 }) : [];
    return {
      forModel: {
        range: report.description,
        totals: report.totals,
        shownOnScreen: `${report.rows.length} patients in a table with downloads`,
        ...(elsewhere.length
          ? {
              notInThisRange: `"${args.search}" isn't in these dates, but matches ${elsewhere.length} patient(s) discharged on other dates — call find_patient with "${args.search}" to show them.`,
              otherDates: elsewhere.map((d) => ({ ipNo: d.ipNo, dischargeDate: d.date, matchedOn: d.match.on, ...(SHARE() ? { name: d.name } : {}) })),
            }
          : {}),
      },
      block: {
        type: 'dischargeReport',
        title: `Discharge report · ${report.description}`,
        query: report.query,
        totals: report.totals,
        rows: report.rows.slice(0, 300).map(({ dischargeTime, ...r }) => r),
        total: report.rows.length,
      },
    };
  },

  async patient_details({ id, date }) {
    const d = await patientDetails(id, DATE_RE.test(date || '') ? date : undefined);
    if (!d.found) return { forModel: { found: false, hint: 'Not in the discharge data — for an OP patient, use lab_report_lookup with the UHID.' } };
    return {
      forModel: SHARE() ? { ...detailsForModel(d), record: undefined } : { found: true, ipNo: d.record.ipNo, dischargeDate: d.record.date, shownOnScreen: true },
      block: { type: 'patientDetails', title: `${d.record.name} · ${d.record.ipNo}`, ...d },
    };
  },

  async patient_journey({ id, date }) {
    const j = await patientJourney(id, DATE_RE.test(date || '') ? date : undefined);
    if (!j.found) return { forModel: { found: false, hint: 'Not in the discharge data.' } };
    return {
      forModel: SHARE()
        ? { patient: `${j.record.name} (${j.record.ipNo})`, steps: j.steps.map((st) => `${istTime(st.at)} · ${st.lane} · ${st.title}${st.detail ? ` — ${st.detail}` : ''}`) }
        : { steps: j.steps.length, shownOnScreen: true },
      block: { type: 'journey', title: `Journey · ${j.record.name} (${j.record.ipNo})`, ...j },
    };
  },

  async compare_patients({ a, b, a_date, b_date }) {
    const r = await comparePatients({ a, b, dateA: a_date, dateB: b_date });
    if (!r.found) return { forModel: { found: false, notFound: r.missing } };
    const both = r.labs.filter((l) => l.a && l.b);
    return {
      forModel: SHARE()
        ? {
            a: r.labelA,
            b: r.labelB,
            demographics: r.demographics,
            summary: r.summary,
            labs: both.slice(0, 80).map((l) => `${l.test}: ${l.a.value}${l.a.flag && l.a.flag !== 'normal' ? ` ${l.a.flag}` : ''} → ${l.b.value}${l.b.flag && l.b.flag !== 'normal' ? ` ${l.b.flag}` : ''}${l.diff !== null ? ` (${l.diff > 0 ? '+' : ''}${l.diff})` : ''} [${l.range}]`),
            labDays: r.days,
          }
        : { summary: r.summary, shownOnScreen: true },
      block: { type: 'compare', title: `Compare · ${r.labelA} vs ${r.labelB}`, ...r },
    };
  },

  async export_results({ results, format, title, include_answers }, context) {
    if (!context.chatId) return { forModel: { error: 'This chat has no saved results yet.' } };
    const numbers = Array.isArray(results) ? results.map(Number).filter(Number.isInteger) : [];
    const file = await buildChatExport({
      chatId: context.chatId,
      numbers,
      format: ['pdf', 'xlsx', 'csv'].includes(format) ? format : 'pdf',
      title: title ? String(title).slice(0, 80) : undefined,
      withAnswers: Boolean(include_answers),
    });
    return { forModel: { ready: true, file: file.filename, results: file.results }, block: { type: 'chatExport', ...file } };
  },

  async lab_report_lookup({ id, from, to }) {
    const clean = cleanLookupId(id);
    if (!/^(IP)?\d{4,12}$/.test(clean)) return { forModel: { error: 'Ask for a UHID (digits) or an IP number' } };
    const r = await lookupLabReport({ id: clean, from: DATE_RE.test(from || '') ? from : undefined, to: DATE_RE.test(to || '') ? to : undefined });
    const range = r.from === r.to ? dmy(r.from) : `${dmy(r.from)} to ${dmy(r.to)}`;
    if (!r.found) {
      return {
        forModel: { found: false, searched: clean, range, hint: 'Nothing in the EMR lab for this number in that range — offer a wider range (up to a year) or check the number.' },
        block: { type: 'labLookup', found: false, id: clean, range },
      };
    }
    return {
      forModel: {
        found: true,
        patientType: r.patient.type,
        range,
        testDays: r.dates,
        results: r.tests,
        next: 'The PDF is on screen with Open, Download and WhatsApp. To send on WhatsApp, ask for the number, then call offer_lookup_whatsapp.',
      },
      block: { type: 'labLookup', found: true, ...r, range },
    };
  },

  async offer_lookup_whatsapp({ to_number }, context) {
    const lookup = context.lastLookup;
    if (!lookup) return { forModel: { error: 'Look the lab report up first (lab_report_lookup).' } };
    const checked = checkWhatsAppNumber(to_number);
    if (!checked.ok) return { forModel: { error: `${checked.error}. Ask the user for the correct number.` } };
    const d = checked.digits;
    return {
      forModel: { readyForConfirmation: true, to: `+${d}` },
      block: { type: 'lookupShare', lookup, toNumber: d, display: /^91\d{10}$/.test(d) ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : `+${d}` },
    };
  },

  async send_test_whatsapp({ message, to_number, confirm }, context) {
    const text = cleanTestMessage(message) || context.testDraft?.message || '';
    const number = cleanTestNumber(to_number) || (text && context.pendingTest?.message === text ? context.pendingTest.toNumber : '');
    if (!text) return { forModel: { missing: 'message', askUser: 'What message should I send?' } };
    if (!number) {
      return {
        forModel: { missing: 'number', message: text, askUser: 'Which WhatsApp number should I send it to?' },
        block: { type: 'testDraft', message: text },
      };
    }
    const pending = context.pendingTest;
    if (confirm && pending && pending.message === text && pending.toNumber === number) {
      try {
        const sent = await sendTestWhatsApp({ message: text, toNumber: number, triggeredBy: context.user });
        return { forModel: { sent: true, to: sent.sentTo }, block: { type: 'testMessage', status: 'sent', message: text, toNumber: number, display: sent.sentTo } };
      } catch (error) {
        return {
          forModel: { sent: false, error: error.message },
          block: { type: 'testMessage', status: 'failed', message: text, toNumber: number, display: formatNumber(number), error: error.message },
        };
      }
    }
    return {
      forModel: { readyForConfirmation: true, message: text, to: formatNumber(number) },
      block: { type: 'testMessage', status: 'ready', message: text, toNumber: number, display: formatNumber(number) },
    };
  },

  async open_screen({ screen, date, filter }, context) {
    const views = { discharge_reports: 'reports', lab_finder: 'labFinder', lab_search: 'search', wati_settings: 'wati', whatsapp_monitor: 'admin', audit_log: 'audit', users: 'users', master_settings: 'settings' };
    if (!views[screen]) return { forModel: { error: 'Unknown screen' } };
    if (['users', 'master_settings'].includes(screen) ? !context.superAdmin : context.access && !canRead(context.access, SCREEN_OF[screen])) {
      return { forModel: { error: screen === 'master_settings' || screen === 'users' ? 'Only the super admin can open that screen.' : NO_ACCESS } };
    }
    return {
      forModel: { opened: screen },
      block: { type: 'navigate', view: views[screen], date: DATE_RE.test(date || '') ? date : undefined, filter: filter ? String(filter).slice(0, 60) : undefined },
    };
  },

  async offer_download({ format, target, ip_no, date }, context) {
    if (!['pdf', 'xlsx', 'docx', 'csv'].includes(format)) return { forModel: { error: 'format must be pdf, xlsx, docx or csv' } };
    const a = context.access;
    if (a && (target === 'patient' ? !canRead(a, 'reports') || a.documents === 'summary' : !canRead(a, 'labFinder'))) {
      return { forModel: { error: NO_ACCESS } };
    }
    if (target === 'patient') {
      const ipNo = ip_no || context.lastPatient?.ipNo;
      const record = ipNo && (await findPatientRecord(ipNo, date || context.lastPatient?.date));
      if (!record) return { forModel: { error: 'Which patient? Give the IP number.' } };
      return { forModel: { ready: true }, block: { type: 'download', target: 'patient', format, patient: patientCard(record) } };
    }
    const query = context.lastLabQuery && normaliseQuery(context.lastLabQuery);
    if (!query || !hasCriteria(query)) return { forModel: { error: 'There are no lab results to download yet — search first' } };
    return { forModel: { ready: true }, block: { type: 'download', target: 'lab_results', format, query } };
  },

  async offer_whatsapp_share({ target, to_number, ip_no, date }, context) {
    const a = context.access;
    if (a && !canRead(a, target === 'patient' ? 'reports' : 'labFinder')) return { forModel: { error: NO_ACCESS } };
    const toNumber = String(to_number || '').replace(/[^\d+]/g, '');
    if (target === 'patient') {
      const ipNo = ip_no || context.lastPatient?.ipNo;
      const record = ipNo && (await findPatientRecord(ipNo, date || context.lastPatient?.date));
      if (!record) return { forModel: { error: 'Which patient? Give the IP number.' } };
      return { forModel: { readyForConfirmation: true }, block: { type: 'share', target: 'patient', toNumber, patient: patientCard(record) } };
    }
    const query = context.lastLabQuery && normaliseQuery(context.lastLabQuery);
    if (!query || !hasCriteria(query)) return { forModel: { error: 'There are no lab results to share yet — search first' } };
    return { forModel: { readyForConfirmation: true }, block: { type: 'share', target: 'lab_results', toNumber, query } };
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A model that just said "rate limited" / "overloaded" is skipped for a while,
// so the next question goes straight to one that works instead of waiting on it.
const cooldownUntil = new Map();

class ProviderError extends Error {
  constructor(message, { busy = false, retryAfter = 0 } = {}) {
    super(message);
    this.busy = busy;
    this.retryAfter = retryAfter;
  }
}

async function callProvider(provider, messages, tools) {
  // One retry when the provider says the limit clears within a few seconds.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: provider.model, messages, tools, tool_choice: 'auto', temperature: 0.2 }),
      signal: AbortSignal.timeout(25_000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const message = data.choices?.[0]?.message;
      if (!message) throw new ProviderError('empty response');
      return message;
    }
    const detail = data?.error?.message || data?.[0]?.error?.message || `HTTP ${res.status}`;
    const wait = parseFloat(/try again in ([\d.]+)s/i.exec(detail)?.[1]) || 0;
    if (res.status === 429 && attempt === 1 && wait > 0 && wait <= 4) {
      await sleep(wait * 1000 + 250);
      continue;
    }
    const busy = res.status === 429 || res.status === 503;
    throw new ProviderError(detail, { busy, retryAfter: wait });
  }
}

/** First model that answers wins; returns null if none could. */
async function chatCompletion(messages, toolDefs = TOOLS) {
  const tools = toolDefs.map((t) => ({ type: 'function', function: t }));
  const now = Date.now();
  const ready = PROVIDERS.filter((p) => (cooldownUntil.get(p.name) || 0) <= now);
  // If every model is cooling down, try them anyway rather than give up.
  for (const provider of ready.length ? ready : PROVIDERS) {
    try {
      const message = await callProvider(provider, messages, tools);
      cooldownUntil.delete(provider.name);
      return message;
    } catch (error) {
      const seconds = error.busy ? Math.max(error.retryAfter || 0, 45) : 20;
      cooldownUntil.set(provider.name, Date.now() + seconds * 1000);
      console.warn(`[assistant] ${provider.name}: ${String(error.message).slice(0, 160)}`);
    }
  }
  return null;
}

function sanitiseHistory(messages) {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

/**
 * @param messages [{ role: 'user'|'assistant', content }] — the visible chat
 * @param context  { lastLabQuery, lastPatient: { ipNo, date } } from the page,
 *                 so "download that as Excel" knows what "that" is
 * @returns { reply, blocks }
 */
// ---- Rule-based answer: used only when no AI model responds ----------------

const HOW_TO = `Here's how to do the common tasks:
1. Reports for a patient: open Discharge Reports, pick the discharge date, and type the name or IP number in the filter box.
2. Send reports on WhatsApp: press the green WhatsApp button on the patient's card (lab report + discharge summary go as two messages).
3. Find patients by lab result: open Lab Finder, enter the test (e.g. urine glucose), the result (e.g. Negative) and dates, then Search. Download as PDF, Excel, Word or CSV, or share on WhatsApp.
4. Test or live WhatsApp sending: WATI Settings.`;

const FORMAT_WORDS = { pdf: 'pdf', excel: 'xlsx', xlsx: 'xlsx', xls: 'xlsx', spreadsheet: 'xlsx', word: 'docx', docx: 'docx', doc: 'docx', csv: 'csv' };
const VALUE_WORDS = ['non reactive', 'non-reactive', 'negative', 'positive', 'reactive', 'absent', 'present', 'trace', 'nil'];
const STATUS_WORDS = { high: 'high', raised: 'high', elevated: 'high', low: 'low', abnormal: 'abnormal', normal: 'normal' };
const STOP_WORDS = new Set(
  'a an the of in on at to for from with and or by is are was were who which what whose had has have show list find get give me all any patient patients their his her result results report reports lab labs test tests value values level levels between during date dates discharged discharge last this past week weeks month months day days today yesterday please can you i want need see search who find check'.split(' '),
);

function isoDaysAgo(days) {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000 - days * 86400 * 1000);
  return now.toISOString().slice(0, 10);
}

/** Dates mentioned in the text, as YYYY-MM-DD, in order. */
function findDates(text) {
  const dates = [];
  const re = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b|\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g;
  let m;
  while ((m = re.exec(text))) {
    const [y, mo, d] = m[1] ? [m[1], m[2], m[3]] : [m[6], m[5], m[4]];
    dates.push(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  if (/\btoday\b/i.test(text)) dates.push(isoDaysAgo(0));
  if (/\byesterday\b/i.test(text)) dates.push(isoDaysAgo(1));
  return dates;
}

/** "10am to 2pm", "10:00-14:00", "10 to 2 pm", "from 9.30 am till 1 pm" → { from: 'HH:MM', to: 'HH:MM' } */
function timeRangeIn(text) {
  const m = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:to|-|–|till|until|upto|up to)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (!m || (!m[3] && !m[6] && !m[2] && !m[5])) return null; // bare "3 to 5" isn't a time
  const conv = (h, min, ap) => {
    let hour = Number(h);
    if (ap?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (ap?.toLowerCase() === 'am' && hour === 12) hour = 0;
    return hour <= 23 && Number(min || 0) <= 59 ? `${String(hour).padStart(2, '0')}:${String(min || '00').padStart(2, '0')}` : null;
  };
  let from = conv(m[1], m[2], m[3] || (m[6] && Number(m[1]) > Number(m[4]) ? 'am' : m[6]));
  const to = conv(m[4], m[5], m[6]);
  if (!m[3] && m[6] && from && to && from > to) from = conv(m[1], m[2], 'am');
  return from && to ? { from, to } : null;
}

const labLikeText = (lower) => /\b(glucose|haemoglobin|hemoglobin|creatinine|sodium|potassium|platelet|urea|wbc|rbc|negative|positive)\b/.test(lower);

function dateRange(text) {
  const dates = findDates(text).sort();
  if (dates.length >= 2) return { from: dates[0], to: dates[dates.length - 1] };
  if (dates.length === 1) return { from: dates[0], to: dates[0] };
  if (/\b(last|past)\s+week\b/i.test(text)) return { from: isoDaysAgo(7), to: isoDaysAgo(0) };
  if (/\b(last|past)\s+month\b|\bthis month\b/i.test(text)) return { from: isoDaysAgo(30), to: isoDaysAgo(0) };
  return {};
}

async function ruleBasedAnswer(messages, ctx) {
  const text = String([...messages].reverse().find((m) => m.role === 'user')?.content || '');
  const lower = text.toLowerCase();
  const blocks = [];
  const run = async (tool, args) => {
    if (ctx.allowedTools && !ctx.allowedTools.has(tool)) throw new NoAccessError(tool);
    const outcome = await handlers[tool](args, ctx);
    if (outcome.block) blocks.push(outcome.block);
    return outcome.forModel;
  };
  const busyNote = 'The AI helper is busy right now, so I ran a direct search.';

  // Test WhatsApp message: "send a test message" → message? → number? → card → Send / yes.
  const lastAssistant = String(
    [...messages]
      .slice(0, -1)
      .reverse()
      .find((m) => m.role === 'assistant')?.content || '',
  );
  const testReply = (r) => {
    if (r.missing === 'message') return 'Sure — what message should I send?';
    if (r.missing === 'number') return `Got it — “${r.message}”. Which WhatsApp number should I send it to?`;
    if (r.readyForConfirmation) return `Ready to send “${r.message}” to ${r.to}. Press Send below, or type yes.`;
    if (r.sent) return `Sent — WATI accepted the test message to ${r.to}. Check that phone.`;
    return `WATI didn't accept it: ${r.error}`;
  };
  const numberInText = /(?:\+|=)?\s*(?:91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/.exec(text)?.[0];
  const quoted = /["“‘']([^"”’']{1,300})["”’']/.exec(text)?.[1];
  if (/^\s*(cancel|stop|never ?mind|no)\b/i.test(text) && (ctx.pendingTest || ctx.testDraft)) {
    return { reply: 'Okay, cancelled — nothing was sent.', blocks: [{ type: 'testDraft', message: null }] };
  }
  if (ctx.pendingTest && /^\s*(yes|y|ok|okay|send|send it|confirm|go|go ahead|proceed|sure|do it)\b/i.test(text)) {
    const r = await run('send_test_whatsapp', { ...ctx.pendingTest, to_number: ctx.pendingTest.toNumber, confirm: true });
    return { reply: testReply(r), blocks };
  }
  if (/what message should i send/i.test(lastAssistant)) {
    const r = await run('send_test_whatsapp', { message: quoted || text.replace(numberInText || '', ''), to_number: numberInText });
    return { reply: testReply(r), blocks };
  }
  if (ctx.testDraft && numberInText) {
    const r = await run('send_test_whatsapp', { to_number: numberInText });
    return { reply: testReply(r), blocks };
  }
  if (
    /\b(send|sent|test)\b[^\n]*\b(message|msg)\b|\btest\s+(whats\s*app|wa)\b/i.test(text) &&
    !/\bip\s*\d/i.test(text) &&
    !/\b(why|not|isn'?t|status|fail|failed|failing|how many)\b/i.test(text)
  ) {
    const r = await run('send_test_whatsapp', { message: quoted, to_number: numberInText });
    return { reply: testReply(r), blocks };
  }
  // "Why isn't WhatsApp sending?" is a status question, not a request to send.
  const statusQuestion = /\b(why|not|isn'?t|failed|fail|failing|status|quota|limit|429|tick|ticks|delivered|read|working|stuck|pending|refus)/i.test(text);

  // A lab report looked up in the EMR, then a number: prepare the WhatsApp card.
  const anyNumber = /(?:\+|=)?\s*\d[\d\s-]{7,15}\d/.exec(text)?.[0];
  if (ctx.lastLookup && anyNumber && !/\bip\s*\d|uhid/i.test(text) && !statusQuestion) {
    const r = await run('offer_lookup_whatsapp', { to_number: anyNumber });
    return { reply: r.error ? r.error.replace('. Ask the user for the correct number.', '.') : `Check the number ${r.to}, then press Send.`, blocks };
  }

  // WhatsApp share with a number
  const phone = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/.exec(text)?.[0];
  // Only an explicit "send / share / forward" — "give me the WhatsApp number of IP…" is a question.
  if (!statusQuestion && /\b(send|share|forward)\b/i.test(text) && (ctx.lastLabQuery || ctx.lastPatient || /\bip\s*\d/i.test(text))) {
    const ipNo = /\bip\s*0?\d{6,}\b/i.exec(text)?.[0]?.replace(/\s+/g, '').toUpperCase();
    const target = ipNo || (!ctx.lastLabQuery && ctx.lastPatient) ? 'patient' : 'lab_results';
    const r = await run('offer_whatsapp_share', { target, to_number: phone, ip_no: ipNo });
    if (!r.error) return { reply: `${busyNote} Check the number, then press Send.`, blocks };
  }

  // Download in a format
  const formatWord = Object.keys(FORMAT_WORDS).find((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));
  if (formatWord && /download|export|\bas\b|file|get/i.test(text) && (ctx.lastLabQuery || ctx.lastPatient || /\bip\s*\d/i.test(text))) {
    const ipNo = /\bip\s*0?\d{6,}\b/i.exec(text)?.[0]?.replace(/\s+/g, '').toUpperCase();
    const target = ipNo || (!ctx.lastLabQuery && ctx.lastPatient) ? 'patient' : 'lab_results';
    const r = await run('offer_download', { format: FORMAT_WORDS[formatWord], target, ip_no: ipNo });
    if (!r.error) return { reply: `${busyNote} Your download is below.`, blocks };
  }

  // A specific patient by IP number or UHID
  const ip = /\bip\s*0?\d{6,}\b/i.exec(text)?.[0]?.replace(/\s+/g, '').toUpperCase();
  const aboutWhatsApp = /whats\s*app|wati|message|tick|deliver|\bread\b|\bsent\b|sending|429|quota|usage limit|webhook/i.test(text);
  const pid = ip || /\b(?:uhid|reg(?:istration)?\s*(?:no|number)?|op)\D{0,4}(\d{5,})/i.exec(text)?.[1] || /\b(\d{6,9})\b/.exec(text)?.[1] || null;

  // A file of earlier results: "all results in one pdf", "#1 and #2 as csv", "first two in excel"
  const fileFormat = /\bpdf\b/i.test(text) ? 'pdf' : /\b(excel|xlsx|xls)\b/i.test(text) ? 'xlsx' : /\bcsv\b/i.test(text) ? 'csv' : null;
  if (fileFormat && ctx.results?.length && /#\s*\d|\ball\b|result|everything|above|these|those|combine|group|single|first|last|both/i.test(text)) {
    let numbers = [...text.matchAll(/#\s*(\d+)/g)].map((m) => Number(m[1]));
    const firstN = /\bfirst\s+(two|2|three|3|four|4)\b/i.exec(text);
    if (!numbers.length && firstN) numbers = ctx.results.slice(0, { two: 2, three: 3, four: 4 }[firstN[1].toLowerCase()] || Number(firstN[1])).map((r) => r.n);
    const asFormat = (w) => ({ excel: 'xlsx', xls: 'xlsx', xlsx: 'xlsx' })[w.toLowerCase()] || w.toLowerCase();
    const formats = [...new Set([...text.matchAll(/\b(pdf|excel|xlsx|xls|csv)\b/gi)].map((m) => asFormat(m[1])))];
    const withAnswers = /answer|question|chat/i.test(text);
    const label = (f) => (f === 'xlsx' ? 'Excel' : f.toUpperCase());
    try {
      // "#1 and #2 in a PDF and the rest in a CSV" — two files.
      if (formats.length >= 2 && numbers.length && /\b(rest|remaining|others?|other results)\b/i.test(text)) {
        const rest = ctx.results.map((r) => r.n).filter((n) => !numbers.includes(n));
        const a = await run('export_results', { results: numbers, format: formats[0], include_answers: withAnswers });
        const parts = [`${label(formats[0])} with ${a.results.map((n) => `#${n}`).join(', ')}`];
        if (rest.length) {
          const b = await run('export_results', { results: rest, format: formats[1], include_answers: withAnswers });
          parts.push(`${label(formats[1])} with ${b.results.map((n) => `#${n}`).join(', ')}`);
        }
        return { reply: `Ready below: ${parts.join(' and ')}.`, blocks };
      }
      const r = await run('export_results', { results: numbers, format: fileFormat, include_answers: withAnswers });
      return { reply: `Your ${label(fileFormat)} file with ${r.results.map((n) => `#${n}`).join(', ')} is ready below.`, blocks };
    } catch (error) {
      if (error instanceof NoAccessError) throw error;
      return { reply: error.message, blocks };
    }
  }

  // Journey / flowchart of one patient
  if (pid && /journey|flow\s*chart|timeline|what happened/i.test(text)) {
    const r = await run('patient_journey', { id: pid });
    return { reply: r.found === false ? `${pid} isn't in the discharge data.` : `Here is the journey of ${pid}, step by step.`, blocks };
  }

  // Compare two patients, or one patient over time
  if (/compare|versus|\bvs\b|difference|changed/i.test(text)) {
    const ids = [...text.matchAll(/\bip\s*0?\d{6,}\b|\b\d{6,9}\b/gi)].map((m) => m[0].replace(/\s+/g, '').toUpperCase());
    if (ids.length) {
      const r = await run('compare_patients', { a: ids[0], b: ids[1] });
      if (r.found === false) return { reply: `I couldn't find ${r.notFound} in the discharge data.`, blocks };
      const sum = r.summary;
      return {
        reply: `Compared ${sum.testsCompared} lab tests — ${sum.changed} changed; out of range: ${sum.abnormalA} in the first, ${sum.abnormalB} in the second. The side-by-side table is below.`,
        blocks,
      };
    }
  }

  // Details of one patient: "WhatsApp number of IP…", "discharge time", "age", "address"
  const DETAIL_WORDS = [
    [/whats\s*app\s*(no|number)/i, 'WhatsApp No'],
    [/mobile|phone|contact|\bnumber\b/i, 'Mobile'],
    [/\bage\b/i, 'Age'],
    [/gender|\bsex\b/i, 'Gender'],
    [/address/i, 'ADDRESS'],
    [/city|town|district|state|village|area/i, 'City'],
    [/discharg\w*\s*(time|date|at|on)|when.*discharg/i, 'Discharged'],
    [/admi(t|ssion)/i, 'Admitted'],
    [/length of stay|how long|\bstay\b|duration/i, 'Length of stay'],
    [/diagnos/i, 'IP_Diagnosis'],
    [/doctor|consultant/i, 'Doctor'],
    [/\bward\b|\bbed\b/i, 'Ward'],
    [/email/i, 'EMAIL'],
    [/relation|father|husband|mother|wife|guardian/i, 'RELATION NAME'],
  ];
  const asked = DETAIL_WORDS.filter(([re]) => re.test(text)).map(([, label]) => label);
  // "age and address of 89396 05869" — a mobile number works as the patient too.
  const did = pid || (phone && (asked.some((l) => !['Mobile', 'WhatsApp No'].includes(l)) || /details|about|info/i.test(text)) ? phone : null);
  if (did && (asked.length || /details|about|info/i.test(text)) && !/lab\s*report|summary\s*pdf|\bpdf\b/i.test(text)) {
    const r = await run('patient_details', { id: did });
    if (r.found === false) return { reply: `${did} isn't in the discharge data${ctx.allowedTools?.has('lab_report_lookup') ? ' — for an OP patient ask for their lab report by UHID' : ''}.`, blocks };
    if (r.fields && asked.length) {
      const pick = (label) => r.fields.find((f) => f.label === label || (label === 'City' && ['City', 'District', 'State', 'AREA / VILLAGE'].includes(f.label)));
      const answers = [...new Set(asked)].map((label) => {
        const f = label === 'Ward' ? r.fields.filter((x) => ['Ward', 'Bed'].includes(x.label)) : [pick(label)].filter(Boolean);
        return f.length ? f.map((x) => `${x.label}: ${x.value}`).join(', ') : `${label}: not recorded`;
      });
      return { reply: `${did} — ${answers.join(' · ')}. All details are below.`, blocks };
    }
    return { reply: `Details of ${did} are below.`, blocks };
  }

  const summarise = (t) =>
    `${t.patients} patient${t.patients === 1 ? '' : 's'}, ${t.messages} message${t.messages === 1 ? '' : 's'} — ${t.read} read, ${t.delivered} delivered, ${t.sent} sent${t.pending ? `, ${t.pending} pending` : ''}, ${t.failed} failed`;

  // One patient's WhatsApp messages
  if (ip && aboutWhatsApp) {
    const r = await run('whatsapp_report', { ip_no: ip });
    if (!r.totals.messages) return { reply: `No WhatsApp messages recorded for ${ip}.`, blocks };
    const failed = Object.entries(r.failureReasons || {}).map(([k, n]) => `${n} × ${k}`).join(', ');
    return { reply: `${ip}: ${summarise(r.totals)}.${failed ? ` Failed because: ${failed}.` : ''} Details below.`, blocks };
  }

  // Reports for a date / time window: "today 10am to 2pm patient and message wise"
  const timeWin = timeRangeIn(text);
  const reportRange = dateRange(text);
  const wantsReport = Boolean(timeWin) || /\breport|wise\b|\blist\b|export|download|excel|pdf|csv|how many|count/i.test(text);
  if (!ip && wantsReport && (aboutWhatsApp || /\bwise\b/i.test(text)) && (!statusQuestion || timeWin || /\breport\b/i.test(text))) {
    const waStatus = /\bfailed\b/i.test(text) ? 'failed' : /\bpending\b/i.test(text) ? 'pending' : undefined;
    const r = await run('whatsapp_report', {
      from: reportRange.from,
      to: reportRange.to,
      from_time: timeWin?.from,
      to_time: timeWin?.to,
      status: waStatus,
      date_basis: /\bsent\b/i.test(text) && !/discharg/i.test(text) ? 'sent' : 'report',
      view: /message\s*wise/i.test(text) && !/patient\s*wise/i.test(text) ? 'messages' : /patient\s*wise/i.test(text) && !/message\s*wise/i.test(text) ? 'patients' : 'both',
    });
    return { reply: `${r.range}: ${summarise(r.totals)}. The report and downloads are below.`, blocks };
  }
  if (!ip && wantsReport && /discharg|patients?\b/i.test(text) && !labLikeText(lower)) {
    const r = await run('discharge_report', { from: reportRange.from, to: reportRange.to, from_time: timeWin?.from, to_time: timeWin?.to });
    const t = r.totals;
    return {
      reply: `${r.range}: ${t.patients} patient${t.patients === 1 ? '' : 's'} — ${t.labReady} lab reports, ${t.summaryReady} summaries${t.noSummary ? `, ${t.noSummary} No Summary` : ''}. The report and downloads are below.`,
      blocks,
    };
  }

  // Live WhatsApp / WATI status
  if (!ip && aboutWhatsApp && (statusQuestion || /status|how many|today|mode|live|test/i.test(text))) {
    const r = await run('app_status', { area: 'whatsapp' });
    const w = r.whatsapp;
    const m = w.messagesToday;
    const parts = [
      w.liveMode
        ? 'WhatsApp is in Live mode: reports go to patients automatically as they are made.'
        : 'WhatsApp is in Test mode: nothing is sent automatically — reports only go out when someone presses the WhatsApp button, and then to the test number. Turn on Live in WATI Settings to send to patients.',
    ];
    if (!w.watiConfigured) parts.push('WATI is not configured on the server.');
    if (w.watiApi.startsWith('REFUSING')) {
      parts.push(
        `WATI is refusing calls (its API usage limit)${w.pausedUntil ? `; the app tries again after ${w.pausedUntil}` : ''}. Refused reports are re-sent automatically — no need to click again.`,
      );
    }
    parts.push(`Today: ${m.total} message${m.total === 1 ? '' : 's'} — ${m.sent + m.delivered + m.read} sent, ${m.read} read, ${m.failed} failed.`);
    if (w.waitingForAutomaticRetry) parts.push(`${w.waitingForAutomaticRetry} waiting to retry${w.nextRetryAt ? ` (next ${w.nextRetryAt})` : ''}.`);
    return { reply: parts.join(' '), blocks };
  }

  // The 15-minute discharge check
  if (/schedul|cron|next check|last check|discharge check|sync|automation|every 15/i.test(text)) {
    const r = await run('app_status', { area: 'scheduler' });
    const d = r.dischargeCheck;
    const last = d.lastResult;
    return {
      reply: `The discharge check runs every 15 minutes${d.checking ? ' and is running now' : ''}. ${d.lastCheckFinished ? `Last finished ${d.lastCheckFinished}` : 'It has not finished a check since the server started'}${last ? `: ${last.found ?? 0} found, ${last.labReportsMade ?? 0} new lab reports, ${last.summariesMade ?? 0} new summaries${last.failed ? `, ${last.failed} failed` : ''}` : ''}. ${d.nextCheck ? `Next check ${d.nextCheck}.` : ''}`.trim(),
      blocks,
    };
  }
  // A patient by mobile number ("find the patient with 89396 05869") or by name
  // / place ("find patient gugan priyan", "who is from tindivanam") — every date.
  const findWords = /\b(find|search|look\s*up|lookup|who\s+is|which\s+patient|whose|belongs?|patient\s+(?:with|named|called|of|by)|details?\s+of)\b/i;
  if (!ip && phone && !/\b(send|share|forward)\b/i.test(text)) {
    const r = await run('find_patient', { query: phone });
    return {
      reply: r.count
        ? `${busyNote} Found ${r.count} patient${r.count === 1 ? '' : 's'} with ${phone} (matched on ${r.matchedOn}) — shown below.`
        : `${busyNote} No discharged patient has the number ${phone} on any date. If they're an OP patient, give me their UHID and I'll check the EMR lab.`,
      blocks,
    };
  }
  const named = findWords.test(text) && !ip ? /\b(?:find|search|look\s*up|lookup|who\s+is|named|called|details?\s+of)\s+(?:for\s+)?(?:the\s+)?(?:patient\s+)?(?:named\s+|called\s+|with\s+(?:name\s+)?)?([a-z][a-z .'-]{2,40}?)\s*(?:\?|$|'s|\b(?:report|lab|summary|details|discharged)\b)/i.exec(text)?.[1]?.trim() : null;
  if (named && !/^(patient|patients|a patient|the patient|report|reports|discharge|discharges|lab|today|yesterday)$/i.test(named)) {
    const r = await run('find_patient', { query: named });
    if (r.count) return { reply: `${busyNote} Found ${r.count} match${r.count === 1 ? '' : 'es'} for “${named}” (by ${r.matchedOn}) — shown below.`, blocks };
  }

  const uhid =
    /\b(?:uhid|reg(?:istration)?\s*(?:no|number)?|op)\D{0,4}(\d{5,})/i.exec(text)?.[1] ||
    (/\b(find|lab|report|search|look|check|result)/i.test(text) ? /\b(\d{6,9})\b/.exec(text)?.[1] : undefined);
  if (ip || uhid) {
    const r = await run('find_patient', { query: ip || uhid });
    if (r.count) return { reply: `${busyNote} Found ${r.count} match${r.count === 1 ? '' : 'es'} — shown below.`, blocks };
    // Not a discharged patient (e.g. OP) — look in the EMR lab directly, if allowed.
    if (ctx.allowedTools?.has('lab_report_lookup')) {
      const range = dateRange(text);
      const l = await run('lab_report_lookup', { id: ip || uhid, from: range.from, to: range.to });
      return {
        reply: l.found
          ? `${ip || uhid} isn't in the discharge list, so I checked the EMR lab directly: found ${l.results} results over ${l.testDays} day${l.testDays === 1 ? '' : 's'} (${l.range}). Open or download the PDF below, or tell me a WhatsApp number to send it to.`
          : `${ip || uhid} isn't in the discharge list, and the EMR lab has nothing for it between ${l.range}. Try a wider range (e.g. "last 6 months") or check the number.`,
        blocks,
      };
    }
    return { reply: `${busyNote} No discharged patient found for ${ip || uhid}.`, blocks };
  }

  // Discharges on a date
  const range = dateRange(text);
  if (/discharg/i.test(lower) && range.from && !/\b(glucose|haemoglobin|hemoglobin|creatinine|sodium|potassium|platelet|urea|wbc|rbc)\b/i.test(lower)) {
    const r = await run('list_discharges', { date: range.to });
    return { reply: r.count ? `${busyNote} ${r.count} patient${r.count === 1 ? '' : 's'} discharged on ${range.to.split('-').reverse().join('-')} — shown below.` : `${busyNote} No discharges recorded for that date.`, blocks };
  }

  // How-to and "what does this mean" questions: the portal's manual. Lab
  // questions ("who had low haemoglobin?") go on to the lab search instead.
  const labLike =
    VALUE_WORDS.some((v) => lower.includes(v)) || Object.keys(STATUS_WORDS).some((w) => new RegExp(`\\b${w}\\b`).test(lower));
  if (!labLike && /^\s*(how|where|what|what's|why|which|when|help|explain|tell me)\b|\bmean(s|ing)?\b|\?\s*$/i.test(text)) {
    const [best] = searchGuide(text, 1, 3);
    if (best) return { reply: `**${best.title}**\n${best.text}`, blocks };
    if (/^\s*(how|help)\b/i.test(text)) return { reply: HOW_TO, blocks };
  }

  // Lab search: test words + value / flag + dates
  const value = VALUE_WORDS.find((v) => lower.includes(v));
  const statusWord = Object.keys(STATUS_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(lower));
  let rest = lower;
  for (const v of VALUE_WORDS) rest = rest.split(v).join(' ');
  rest = rest
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w) && !STATUS_WORDS[w] && !/^\d+$/.test(w))
    .join(' ');
  if (rest || value || statusWord) {
    const r = await run('search_lab_results', { test: rest, value, status: statusWord ? STATUS_WORDS[statusWord] : undefined, from: range.from, to: range.to });
    // Nothing found from bare words (no result/flag given) is more likely not
    // a lab question at all — give the usage hint instead of an empty table.
    if (!r.error && !r.total && !value && !statusWord) blocks.length = 0;
    else if (!r.error) {
      return {
        reply: r.total
          ? `${busyNote} ${r.total} result${r.total === 1 ? '' : 's'} for ${r.patients} patient${r.patients === 1 ? '' : 's'} — shown below. You can download them or share on WhatsApp.`
          : `${busyNote} No matching lab results.${r.similarTests?.length ? ` Similar tests: ${r.similarTests.slice(0, 4).join(', ')}.` : ''}`,
        blocks,
      };
    }
  }

  return {
    reply: `The AI helper is busy right now. Try a direct question like "IP07028148 lab report", "discharges on ${isoDaysAgo(1).split('-').reverse().join('-')}" or "urine glucose negative last week" — or use Lab Finder.`,
    blocks,
  };
}

function sanitiseContext(context = {}) {
  const ctx = {};
  const l = context.lastLookup;
  if (l && /^\d{4}-\d{2}-\d{2}$/.test(String(l.day || '')) && /^[a-f0-9]{12}$/.test(String(l.lookupId || ''))) {
    ctx.lastLookup = { day: l.day, lookupId: l.lookupId, id: cleanLookupId(l.id).slice(0, 20), name: String(l.name || '').slice(0, 80) };
  }
  if (SCREEN_LABELS[context.view]) ctx.view = context.view;
  const draft = cleanTestMessage(context.testDraft?.message);
  if (draft) ctx.testDraft = { message: draft };
  const pendingMessage = cleanTestMessage(context.pendingTest?.message);
  const pendingNumber = cleanTestNumber(context.pendingTest?.toNumber);
  if (pendingMessage && pendingNumber) ctx.pendingTest = { message: pendingMessage, toNumber: pendingNumber };
  if (context.lastLabQuery && typeof context.lastLabQuery === 'object') {
    const q = normaliseQuery(context.lastLabQuery);
    if (hasCriteria(q)) ctx.lastLabQuery = q;
  }
  const p = context.lastPatient;
  if (p && /^[A-Za-z0-9]{1,20}$/.test(String(p.ipNo || '')) && DATE_RE.test(String(p.date || ''))) {
    ctx.lastPatient = { ipNo: p.ipNo, date: p.date };
  }
  return ctx;
}

/**
 * When the AI service is busy after the tools already ran: say what they found
 * in a sentence per result, instead of a bare "here it is".
 */
function describeBlocks(blocks) {
  const lines = blocks.map((b) => {
    const tag = b.n ? `#${b.n} ` : '';
    switch (b.type) {
      case 'patientDetails': {
        const f = (label) => b.fields.find((x) => x.label === label)?.value;
        return `${tag}${b.title}: ${[f('Age') && `age ${f('Age')}`, f('Mobile') && `mobile ${f('Mobile')}`, f('Discharged') && `discharged ${f('Discharged')}`, f('Length of stay') && `stay ${f('Length of stay')}`].filter(Boolean).join(', ')}.`;
      }
      case 'journey': {
        const first = b.steps[0];
        const last = b.steps[b.steps.length - 1];
        const labDays = b.steps.filter((st) => st.lane === 'lab').length;
        return `${tag}${b.title}: ${b.steps.length} steps — ${first ? `${first.title} ${formatIstShort(first.at)}` : ''}${labDays ? `, ${labDays} lab day${labDays === 1 ? '' : 's'}` : ''}${last && last !== first ? `, last: ${last.title} ${formatIstShort(last.at)}` : ''}.`;
      }
      case 'compare':
        return `${tag}${b.title}: ${b.summary.testsCompared} tests in both, ${b.summary.changed} changed; out of range ${b.summary.abnormalA} vs ${b.summary.abnormalB}.`;
      case 'chatExport':
        return `Your file ${b.filename} (${b.results.map((n) => `#${n}`).join(', ')}) is ready.`;
      case 'dischargeReport':
        return `${tag}${b.title}: ${b.totals.patients} patients.`;
      case 'whatsappReport':
        return `${tag}${b.title}: ${b.totals.patients} patients, ${b.totals.messages} messages, ${b.totals.read} read, ${b.totals.failed} failed.`;
      default:
        return b.title ? `${tag}${b.title}.` : '';
    }
  });
  const text = lines.filter(Boolean).join('\n');
  return text ? `${text}\nDetails are below.` : 'Here is what I found.';
}

const formatIstShort = (at) =>
  at ? new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '';

export async function runAssistant({ messages, context = {}, user = null, access = FULL_PERMISSIONS, chatId = null, superAdmin = false }) {
  const ctx = sanitiseContext(context);
  ctx.user = user;
  ctx.access = access;
  ctx.superAdmin = Boolean(superAdmin);
  ctx.chatId = /^[a-z0-9]{6,40}$/i.test(String(chatId || '')) ? String(chatId) : null;
  ctx.results = await listResults(ctx.chatId).catch(() => []);
  const question = String([...messages].reverse().find((m) => m.role === 'user')?.content || '').slice(0, 500);
  // Each result gets its number (#1, #2 …) as it's made, so a file can include it in the same answer.
  const number = (block) => numberResult({ chatId: ctx.chatId, user, question, block }).catch(() => block);
  const finish = async (result) => {
    if (result.fallback) result.blocks = await Promise.all((result.blocks || []).map((b) => (b.n ? b : number(b))));
    saveReply({ chatId: ctx.chatId, user, question, reply: result.reply }).catch(() => {});
    return result;
  };
  ctx.allowedTools = new Set(TOOLS.filter((t) => TOOL_ACCESS[t.name]?.(access)).map((t) => t.name));
  const toolDefs = TOOLS.filter((t) => ctx.allowedTools.has(t.name));

  // "Cancel" while a test message is being prepared ends it for sure, without the model.
  const latest = String([...messages].reverse().find((m) => m.role === 'user')?.content || '');
  if ((ctx.testDraft || ctx.pendingTest) && /^\s*(cancel|stop|never ?mind|no|don'?t send)\b/i.test(latest)) {
    return { reply: 'Okay, cancelled — nothing was sent.', blocks: [{ type: 'testDraft', message: null }] };
  }
  const convo = [{ role: 'system', content: systemPrompt(ctx) }, ...sanitiseHistory(messages)];
  const blocks = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const message = await chatCompletion(convo, toolDefs);
    if (!message) {
      // No AI model answered. If tools already ran this turn, show what they
      // found; otherwise answer the question with the rule-based matcher.
      if (blocks.length) return finish({ reply: describeBlocks(blocks), blocks });
      try {
        return finish({ ...(await ruleBasedAnswer(messages, ctx)), fallback: true });
      } catch (error) {
        if (error instanceof NoAccessError) {
          return { reply: "Your account doesn't have access to that — ask the super admin if you need it.", blocks: [], fallback: true };
        }
        throw error;
      }
    }
    const calls = message.tool_calls || [];
    if (!calls.length) {
      return finish({ reply: String(message.content || '').trim() || 'Done.', blocks });
    }
    convo.push({ role: 'assistant', content: message.content || '', tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        // leave args empty — the handler reports what's missing
      }
      const name = call.function?.name;
      const handler = handlers[name];
      let outcome;
      try {
        if (handler && !ctx.allowedTools.has(name)) outcome = { forModel: { error: NO_ACCESS } };
        else outcome = handler ? await handler(args, ctx) : { forModel: { error: 'Unknown tool' } };
      } catch (error) {
        outcome = { forModel: { error: error.message } };
      }
      if (outcome.block) {
        outcome.block = await number(outcome.block);
        if (outcome.block.n && outcome.forModel && typeof outcome.forModel === 'object') outcome.forModel.resultNumber = outcome.block.n;
        blocks.push(outcome.block);
        if (outcome.block.n) ctx.results = [...(ctx.results || []), { n: outcome.block.n, title: outcome.block.title || outcome.block.type }];
        // Later tool calls in this same turn ("…and download it as Excel") see the new results.
        if (outcome.block.type === 'labResults') ctx.lastLabQuery = outcome.block.query;
        if (outcome.block.type === 'testDraft') ctx.testDraft = { message: outcome.block.message };
        if (outcome.block.type === 'labLookup' && outcome.block.found) {
          const b = outcome.block;
          ctx.lastLookup = { day: b.day, lookupId: b.lookupId, id: b.id, name: b.patient?.name || '' };
        }
        if (outcome.block.type === 'testMessage' && outcome.block.status === 'ready') {
          ctx.pendingTest = { message: outcome.block.message, toNumber: outcome.block.toNumber };
        }
        if (outcome.block.type === 'patients' && outcome.block.patients.length === 1) {
          ctx.lastPatient = { ipNo: outcome.block.patients[0].ipNo, date: outcome.block.patients[0].date };
        }
      }
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.forModel) });
    }
  }
  return finish({ reply: 'That took too many steps — please ask in a simpler way.', blocks });
}
