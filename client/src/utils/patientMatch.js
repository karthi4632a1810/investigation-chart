/**
 * Does a patient card match what was typed in the filter box? Same rules as
 * the server's search (server/src/services/patientSearchService.js): IP
 * number, UHID, mobile / WhatsApp number in any format ("+91 89396 05869",
 * last 4+ digits), name in any word order, Req No, bed, doctor, department,
 * ward, created by, approver, and the EMR's relation / address / town.
 */

const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function mobileDigits(raw) {
  let d = digitsOf(raw);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

const FILLER = new Set(['mr', 'mrs', 'ms', 'miss', 'master', 'baby', 'dr', 'smt', 'thiru', 'the', 'patient', 'of', 'and']);
const TEXT = (p) => [
  p.name,
  p.doctor,
  p.department,
  p.ward,
  p.patientType,
  p.createdUser,
  p.summaryApprovedBy,
  p.ipNo,
  p.regNo,
  p.emr?.['RELATION NAME'],
  p.emr?.ADDRESS,
  p.emr?.['AREA / VILLAGE'],
  p.emr?.City,
  p.emr?.District,
];
const PHONES = (p) => [p.mobile, p.whatsapp, p.emr?.MOBILE];

function digitsMatch(p, d) {
  const mobile = mobileDigits(d);
  if (String(p.regNo ?? '') === d || digitsOf(p.ipNo) === d || String(p.bedNo ?? '') === d) return true;
  if (mobile.length === 10 && PHONES(p).some((v) => mobileDigits(v) === mobile)) return true;
  if ((p.reqNos || []).some((r) => String(r) === d)) return true;
  if (d.length >= 4) {
    if (PHONES(p).some((v) => digitsOf(v).includes(d))) return true;
    if (String(p.regNo ?? '').includes(d) || digitsOf(p.ipNo).includes(d)) return true;
    if ((p.reqNos || []).some((r) => String(r).includes(d))) return true;
  }
  return false;
}

/** A matcher for one typed query: (patient) => boolean. */
export function patientMatcher(raw) {
  const q = String(raw ?? '').trim();
  if (!q) return () => true;
  const compact = q.replace(/[\s\-()+.]/g, '');
  if (/^ip\d{2,}$/i.test(compact)) {
    const ip = compact.toUpperCase();
    return (p) => String(p.ipNo ?? '').toUpperCase().includes(ip) || String(p.ipNo ?? '').includes(ip.slice(2));
  }
  if (/^\d{3,}$/.test(compact)) return (p) => digitsMatch(p, compact);
  const all = norm(q).split(' ').filter((w) => w.length >= 2 || /\d/.test(w));
  const kept = all.filter((w) => !FILLER.has(w));
  const words = kept.length ? kept : all;
  const phrase = norm(q);
  return (p) => {
    if (phrase && norm(p.name).includes(phrase)) return true;
    const text = TEXT(p).map(norm);
    return words.every((w) => (/^\d{3,}$/.test(w) ? digitsMatch(p, w) : text.some((t) => t.includes(w))));
  };
}
