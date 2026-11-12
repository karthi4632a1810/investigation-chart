/**
 * Find an OP patient by anything people know about them — UHID (`regNo`),
 * mobile / WhatsApp number in any format ("+91 98765 43210", "098765-43210",
 * or last 4+ digits), name or part of it in any word order, lab Req No, Bill
 * No, token number, doctor, department, visit type, staff who registered, town
 * or village. Searches every date unless one is given; best match first.
 *
 * Used by Ask AI and the OP Reports search box. The client filter box uses the
 * matching rules in `client/src/utils/patientMatch.js`.
 */
import { getMongoCollection } from './mongo.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The 10-digit mobile in a typed number (drops +91, a leading 0, spaces, dashes). */
export function mobileDigits(raw) {
  let d = digitsOf(raw);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

const TEXT_FIELDS = [
  ['name', 'name'],
  ['emr.NAME', 'name'],
  ['emr.PATIENT NAME', 'name'],
  ['doctor', 'doctor'],
  ['emr.REFERRAL DOCTOR', 'referral doctor'],
  ['department', 'department'],
  ['visitType', 'visit type'],
  ['tokenNo', 'token'],
  ['patientType', 'patient type'],
  ['corporate', 'corporate'],
  ['createdUser', 'created by'],
  ['city', 'city / village'],
  ['emr.Address', 'address'],
  ['emr.AREA / VILLAGE', 'area / village'],
  ['emr.City', 'city'],
  ['emr.District', 'district'],
  ['emr.EMAIL', 'email'],
  ['regNo', 'UHID'],
];
const PHONE_FIELDS = [
  ['mobile', 'mobile number'],
  ['whatsappNo', 'WhatsApp number'],
  ['emr.MOBILE', 'mobile number'],
  ['emr.WhatsApp No', 'WhatsApp number'],
];
const FILLER = new Set(['mr', 'mrs', 'ms', 'miss', 'master', 'baby', 'dr', 'smt', 'thiru', 'the', 'patient', 'of', 'and', 'uhid']);

const get = (doc, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), doc);

function parse(raw) {
  const q = String(raw ?? '')
    .trim()
    .replace(/^(?:UHID|REG(?:\s*NO)?)\s*[:#-]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  if (!q) return null;
  const compact = q.replace(/[\s\-()+.]/g, '');
  if (/^\d{3,}$/.test(compact)) return { kind: 'digits', q, digits: compact, mobile: mobileDigits(compact) };
  const all = norm(q).split(' ').filter((w) => w.length >= 2 || /\d/.test(w));
  const words = all.filter((w) => !FILLER.has(w));
  return { kind: 'text', q, phrase: norm(q), words: words.length ? words : all };
}

function digitMatch(doc, d, mobile) {
  const hits = [];
  const regNo = String(doc.regNo ?? '').trim();
  if (regNo === d) hits.push([100, 'UHID']);
  if (mobile.length === 10) {
    for (const [f, label] of PHONE_FIELDS) if (mobileDigits(get(doc, f)) === mobile) hits.push([98, label]);
  }
  if ((doc.reqNos || []).some((r) => String(r) === d)) hits.push([90, 'lab Req No']);
  if ((doc.billNos || []).some((b) => String(b) === d)) hits.push([88, 'Bill No']);
  if (d.length >= 4) {
    for (const [f, label] of PHONE_FIELDS) if (digitsOf(get(doc, f)).includes(d)) hits.push([65, `${label} (part)`]);
    if (regNo.includes(d)) hits.push([60, 'UHID (part)']);
    if ((doc.reqNos || []).some((r) => String(r).includes(d))) hits.push([50, 'lab Req No (part)']);
    if ((doc.billNos || []).some((b) => String(b).includes(d))) hits.push([48, 'Bill No (part)']);
  }
  if (String(doc.tokenNo ?? '') === d) hits.push([35, 'token']);
  if (!hits.length) return null;
  hits.sort((a, b) => b[0] - a[0]);
  return { score: hits[0][0], on: hits[0][1] };
}

export function matchPatient(doc, raw) {
  const p = typeof raw === 'object' && raw?.kind ? raw : parse(raw);
  if (!p || !doc) return null;
  if (p.kind === 'digits') return digitMatch(doc, p.digits, p.mobile);

  const name = norm(doc.name || get(doc, 'emr.NAME') || get(doc, 'emr.PATIENT NAME'));
  if (name && p.phrase && name.includes(p.phrase)) return { score: 100, on: 'name' };
  const on = new Set();
  let inName = 0;
  for (const w of p.words) {
    if (/^\d{3,}$/.test(w)) {
      const m = digitMatch(doc, w, mobileDigits(w));
      if (!m) return null;
      on.add(m.on);
      continue;
    }
    if (name.split(' ').some((part) => part.startsWith(w)) || name.includes(w)) {
      inName += 1;
      on.add('name');
      continue;
    }
    const field = TEXT_FIELDS.find(([f]) => norm(get(doc, f)).includes(w));
    if (!field) return null;
    on.add(field[1]);
  }
  const score = inName === p.words.length ? 90 : inName ? 70 : on.size === 1 ? 50 : 40;
  return { score, on: [...on].join(' + ') };
}

export function patientSearchFilter(raw) {
  const p = typeof raw === 'object' && raw?.kind ? raw : parse(raw);
  if (!p) return null;
  const rx = (s) => ({ $regex: s, $options: 'i' });
  const loose = (d) => d.split('').join('\\D*');
  const digitConditions = (d, mobile) => {
    const or = [{ regNo: d }, { tokenNo: d }, { reqNos: d }, { billNos: d }];
    if (mobile.length === 10) for (const [f] of PHONE_FIELDS) or.push({ [f]: rx(`${loose(mobile)}\\D*$`) });
    if (d.length >= 4) {
      for (const [f] of PHONE_FIELDS) or.push({ [f]: rx(loose(d)) });
      or.push({ regNo: rx(esc(d)) }, { reqNos: rx(esc(d)) }, { billNos: rx(esc(d)) });
    }
    return { $or: or };
  };
  if (p.kind === 'digits') return digitConditions(p.digits, p.mobile);
  if (!p.words.length) {
    return p.phrase ? { $or: TEXT_FIELDS.map(([f]) => ({ [f]: rx(esc(p.phrase)) })) } : null;
  }
  return {
    $and: p.words.map((w) =>
      /^\d{3,}$/.test(w) ? digitConditions(w, mobileDigits(w)) : { $or: TEXT_FIELDS.map(([f]) => ({ [f]: rx(esc(w)) })) },
    ),
  };
}

/**
 * OP patients matching `query`, best first (then newest), each with
 * `match: { score, on }`. `date` (one day) or `from` / `to` narrow it.
 */
export async function searchPatients(query, { date, from, to, limit = 20, extra } = {}) {
  const p = parse(query);
  if (!p) return [];
  const filter = { ...patientSearchFilter(p) };
  const and = [filter];
  if (DATE_RE.test(date || '')) and.push({ date });
  else if (DATE_RE.test(from || '') || DATE_RE.test(to || '')) {
    and.push({ date: { ...(DATE_RE.test(from || '') ? { $gte: from } : {}), ...(DATE_RE.test(to || '') ? { $lte: to } : {}) } });
  }
  if (extra && Object.keys(extra).length) and.push(extra);
  const docs = await (await getMongoCollection('op_reports'))
    .find(and.length > 1 ? { $and: and } : filter, { projection: { _id: 0 } })
    .sort({ date: -1, generatedAt: -1, updatedAt: -1 })
    .limit(500)
    .toArray();
  return docs
    .map((d) => ({ ...d, match: matchPatient(d, p) }))
    .filter((d) => d.match)
    .sort((a, b) => b.match.score - a.match.score || String(b.date).localeCompare(String(a.date)))
    .slice(0, limit);
}
