/**
 * "Ask AI" — a tool-calling assistant for staff.
 *
 * The model (Groq, falling back to Gemini; both via their OpenAI-compatible
 * chat APIs) only decides which read-only tool to call and with what
 * arguments. Tools run here against Mongo; what they find is returned to the
 * page as `blocks` (patient cards, result tables, download/share options) and
 * the model is told only counts and non-identifying facts — patient names and
 * lab values never go to the AI provider from tool results. Nothing is sent on
 * WhatsApp from here: the share tool only prepares a confirmation the user
 * must press Send on.
 */
import { config } from '../config.js';
import { getMongoCollection } from './mongo.js';
import { loadReportIndex } from './dischargeReportService.js';
import { labResultsCoverage, listLabTests, normaliseQuery, searchLabResults, hasCriteria } from './labResultsService.js';

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

function describeContext(context) {
  const lines = [];
  const q = context.lastLabQuery;
  if (q) {
    const parts = [q.test && `test "${q.test}"`, q.value && `result "${q.value}"`, q.status && `flag ${q.status}`, q.from && `from ${q.from}`, q.to && `to ${q.to}`].filter(Boolean);
    lines.push(`- The latest lab results list on screen: ${parts.join(', ') || 'a lab search'}. "That list", "these results" etc. mean this — use target "lab_results".`);
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

The portal has four screens:
- Lab Search: look up one patient's lab results straight from the EMR by UHID or IP number and a date range; shows a chart.
- Discharge Reports: every discharged patient by discharge date, with their Lab Report and Discharge Summary PDFs (made automatically every 15 minutes). Cards or Table view, filters, Advanced Search. The green WhatsApp button sends both PDFs. A red "No Summary" means the EMR had no patient data for that summary.
- Lab Finder: search stored lab values across all patients (test, result, High/Low, number range, dates), then download PDF / Excel / Word / CSV or share on WhatsApp.
- WATI Settings: Test mode (manual sends go to a test number) or Live (reports go to patients automatically).

${describeContext(context)}
Rules:
- Use the tools for anything about patients, reports or lab results. Never invent names, IP numbers, values or counts.
- When the user asks for a specific patient's report, lab report or discharge summary (by IP number, UHID or name), call find_patient — it shows their reports with download and WhatsApp options. Don't send them to Lab Search for that.
- Tool results are shown to the user on screen; you only get counts. Don't repeat patient details — say briefly what was found and that it's shown below.
- For lab questions use search_lab_results. Qualitative results (negative, positive, nil, trace, reactive) go in "value"; "high"/"low"/"abnormal" go in "status"; numbers in "min"/"max". If you're unsure of the test name, or the search finds nothing, call list_lab_tests and ask which test they mean.
- After showing results, offer the options: download as PDF, Excel, Word or CSV, or share on WhatsApp. When they pick a format, call offer_download. When they want WhatsApp, ask for the number if they haven't given it, then call offer_whatsapp_share. Never say a message was sent — the user confirms with the Send button.
- To take the user to a screen, call open_screen.
- For "how do I…" questions, explain in short numbered steps using the screen names above, and open the screen if it helps.
- Keep replies short (1-3 sentences). Reply in English, unless the user writes in Tamil or another language — then use that language.`;
}

const TOOLS = [
  {
    name: 'find_patient',
    description: 'Find discharged patients by IP number, UHID (registration number) or name. Shows their report cards on screen.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'IP number (e.g. IP07028148), UHID digits, or part of the patient name' },
        date: { type: 'string', description: 'Optional discharge date YYYY-MM-DD' },
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
    name: 'open_screen',
    description: 'Take the user to a screen of the portal.',
    parameters: {
      type: 'object',
      properties: {
        screen: { type: 'string', enum: ['discharge_reports', 'lab_finder', 'lab_search', 'wati_settings'] },
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
});

async function findPatientRecord(ipNo, date) {
  const c = await getMongoCollection('discharge_reports');
  const filter = { ipNo: { $regex: `^${escapeRegex(ipNo)}$`, $options: 'i' } };
  if (DATE_RE.test(date || '')) filter.date = date;
  return c.find(filter, { projection: { _id: 0 } }).sort({ date: -1 }).limit(1).next();
}

/** Each tool returns { forModel, block? }. */
const handlers = {
  async find_patient({ query, date }) {
    const q = String(query || '').trim().slice(0, 60);
    if (!q) return { forModel: { error: 'Give an IP number, UHID or name' } };
    const c = await getMongoCollection('discharge_reports');
    let filter;
    if (/^ip\s*\d+$/i.test(q)) filter = { ipNo: { $regex: `^${escapeRegex(q.replace(/\s+/g, ''))}$`, $options: 'i' } };
    else if (/^\d{4,}$/.test(q)) filter = { $or: [{ regNo: q }, { ipNo: { $regex: `${escapeRegex(q)}$` } }] };
    else filter = { name: { $regex: escapeRegex(q), $options: 'i' } };
    if (DATE_RE.test(date || '')) filter = { ...filter, date };
    const docs = await c.find(filter, { projection: { _id: 0 } }).sort({ date: -1 }).limit(20).toArray();
    return {
      forModel: { count: docs.length, patients: docs.slice(0, 5).map(patientFacts) },
      block: docs.length ? { type: 'patients', title: `Found ${docs.length} match${docs.length === 1 ? '' : 'es'}`, patients: docs.map(patientCard) } : undefined,
    };
  },

  async list_discharges({ date, department }) {
    if (!DATE_RE.test(date || '')) return { forModel: { error: 'date must be YYYY-MM-DD' } };
    let docs = await loadReportIndex(date);
    if (department) docs = docs.filter((d) => String(d.department || '').toUpperCase().includes(String(department).toUpperCase()));
    const byDepartment = {};
    for (const d of docs) byDepartment[d.department || 'Unknown'] = (byDepartment[d.department || 'Unknown'] || 0) + 1;
    return {
      forModel: { date, count: docs.length, byDepartment },
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

  async open_screen({ screen, date, filter }) {
    const views = { discharge_reports: 'reports', lab_finder: 'labFinder', lab_search: 'search', wati_settings: 'wati' };
    if (!views[screen]) return { forModel: { error: 'Unknown screen' } };
    return {
      forModel: { opened: screen },
      block: { type: 'navigate', view: views[screen], date: DATE_RE.test(date || '') ? date : undefined, filter: filter ? String(filter).slice(0, 60) : undefined },
    };
  },

  async offer_download({ format, target, ip_no, date }, context) {
    if (!['pdf', 'xlsx', 'docx', 'csv'].includes(format)) return { forModel: { error: 'format must be pdf, xlsx, docx or csv' } };
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
async function chatCompletion(messages) {
  const tools = TOOLS.map((t) => ({ type: 'function', function: t }));
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
    const outcome = await handlers[tool](args, ctx);
    if (outcome.block) blocks.push(outcome.block);
    return outcome.forModel;
  };
  const busyNote = 'The AI helper is busy right now, so I ran a direct search.';

  // WhatsApp share with a number
  const phone = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/.exec(text)?.[0];
  if (/whats\s*app|share|send/i.test(text) && (ctx.lastLabQuery || ctx.lastPatient || /\bip\s*\d/i.test(text))) {
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
  const uhid = /\b(?:uhid|reg(?:istration)?\s*(?:no|number)?)\D{0,4}(\d{5,})/i.exec(text)?.[1];
  if (ip || uhid) {
    const r = await run('find_patient', { query: ip || uhid });
    return { reply: r.count ? `${busyNote} Found ${r.count} match${r.count === 1 ? '' : 'es'} — shown below.` : `${busyNote} No discharged patient found for ${ip || uhid}.`, blocks };
  }

  // Discharges on a date
  const range = dateRange(text);
  if (/discharg/i.test(lower) && range.from && !/\b(glucose|haemoglobin|hemoglobin|creatinine|sodium|potassium|platelet|urea|wbc|rbc)\b/i.test(lower)) {
    const r = await run('list_discharges', { date: range.to });
    return { reply: r.count ? `${busyNote} ${r.count} patient${r.count === 1 ? '' : 's'} discharged on ${range.to.split('-').reverse().join('-')} — shown below.` : `${busyNote} No discharges recorded for that date.`, blocks };
  }

  // How-to questions
  if (/^\s*(how|where|what is|what's|help)\b/i.test(text)) {
    return { reply: HOW_TO, blocks };
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

export async function runAssistant({ messages, context = {} }) {
  const ctx = sanitiseContext(context);
  const convo = [{ role: 'system', content: systemPrompt(ctx) }, ...sanitiseHistory(messages)];
  const blocks = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const message = await chatCompletion(convo);
    if (!message) {
      // No AI model answered. If tools already ran this turn, show what they
      // found; otherwise answer the question with the rule-based matcher.
      if (blocks.length) return { reply: 'Here is what I found.', blocks, fallback: true };
      return { ...(await ruleBasedAnswer(messages, ctx)), fallback: true };
    }
    const calls = message.tool_calls || [];
    if (!calls.length) {
      return { reply: String(message.content || '').trim() || 'Done.', blocks };
    }
    convo.push({ role: 'assistant', content: message.content || '', tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        // leave args empty — the handler reports what's missing
      }
      const handler = handlers[call.function?.name];
      let outcome;
      try {
        outcome = handler ? await handler(args, ctx) : { forModel: { error: 'Unknown tool' } };
      } catch (error) {
        outcome = { forModel: { error: error.message } };
      }
      if (outcome.block) {
        blocks.push(outcome.block);
        // Later tool calls in this same turn ("…and download it as Excel") see the new results.
        if (outcome.block.type === 'labResults') ctx.lastLabQuery = outcome.block.query;
        if (outcome.block.type === 'patients' && outcome.block.patients.length === 1) {
          ctx.lastPatient = { ipNo: outcome.block.patients[0].ipNo, date: outcome.block.patients[0].date };
        }
      }
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.forModel) });
    }
  }
  return { reply: 'That took too many steps — please ask in a simpler way.', blocks };
}
