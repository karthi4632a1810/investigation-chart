/**
 * Ask AI's patient answers: everything known about an OP patient (the EMR
 * front-office row + lab orders, reports, lab values, and WhatsApp), their
 * journey as a timeline (visit -> lab days -> report ready -> WhatsApp ->
 * staff actions), and comparisons of two OP visits/patients or two dates.
 */
import { searchPatients } from './patientSearchService.js';
import { getMongoCollection } from './mongo.js';
import { emrDetails, fetchOpVisitForRegNo } from './opReportService.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Shown on screen, but not sent to the AI service.
export const PRIVATE_FIELDS = new Set(['ABHA ID', 'RELIGION', 'MLC', 'MLC RECORD NUMBER']);
const SKIP_FIELDS = new Set(['IPVISIT']);

/** "29-09-2026 12:24" or "10/11/2026 09:30" (EMR) -> Date (India time), or null. */
export function emrTime(text) {
  const s = String(text || '').trim();
  const dmy = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (dmy) return new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}T${(dmy[4] || '00').padStart(2, '0')}:${dmy[5] || '00'}:00+05:30`);
  const mdy = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (mdy) return new Date(`${mdy[3]}-${mdy[1]}-${mdy[2]}T${(mdy[4] || '00').padStart(2, '0')}:${mdy[5] || '00'}:00+05:30`);
  return null;
}

/** The OP record for a UHID (`regNo`), mobile, or patient name (latest date first). */
export async function findRecord(id, date) {
  const q = String(id || '').trim();
  if (!q) return null;
  const docs = (await searchPatients(q, { date: DATE_RE.test(date || '') ? date : undefined, limit: 5 })).map(
    ({ reqNos, match, ...d }) => d,
  );
  return docs.length ? { record: docs[0], others: docs.slice(1) } : null;
}

/** Fills in the full EMR OP visit row if missing from Mongo. */
export async function ensureEmr(record) {
  if (record.emr && Object.keys(record.emr).length) return record.emr;
  try {
    const row = await fetchOpVisitForRegNo(record.date, record.regNo);
    if (!row) return {};
    const emr = emrDetails(row);
    await (await getMongoCollection('op_reports')).updateOne({ date: record.date, regNo: record.regNo }, { $set: { emr } });
    return emr;
  } catch {
    return {};
  }
}

async function labValues(regNo, reportDate) {
  return (await getMongoCollection('lab_results'))
    .find(
      { regNo, ...(reportDate ? { reportDate } : {}) },
      { projection: { _id: 0, section: 1, test: 1, value: 1, numeric: 1, range: 1, status: 1, resultDate: 1, resultDay: 1 } },
    )
    .sort({ resultDay: 1, section: 1, test: 1 })
    .toArray();
}

async function whatsappFor(regNo, date) {
  return (await getMongoCollection('whatsapp_messages'))
    .find({ regNo, ...(date ? { reportDate: date } : {}) }, { projection: { history: 0 } })
    .sort({ createdAt: 1 })
    .toArray();
}

const WA_TEXT = { pending: 'Pending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };

function formatLabSummary(r) {
  if (r.reportStatus === 'ready' || (r.dateCount !== undefined && r.dateCount !== null)) {
    return `Ready (${r.dateCount ?? 1} lab day${r.dateCount === 1 ? '' : 's'})`;
  }
  if (r.reportStatus === 'pending') {
    return `Pending approval (${r.approvedOrders ?? 0}/${r.totalOrders ?? 0} approved)`;
  }
  if (r.reportStatus === 'failed') return `Failed (${r.error || 'Error'})`;
  return 'No renderable lab results';
}

/** Everything about one OP patient visit & lab report. */
export async function patientDetails(id, date) {
  const found = await findRecord(id, date);
  if (!found) return { found: false };
  const r = found.record;
  const emr = await ensureEmr(r);
  const labs = await labValues(r.regNo, r.date);
  const msgs = await whatsappFor(r.regNo, r.date);
  const latestByDoc = {};
  for (const m of msgs) latestByDoc[m.document] = m;

  const core = [
    ['Name', r.name],
    ['UHID', r.regNo],
    ['Age', r.age],
    ['Gender', r.gender],
    ['Mobile', r.mobile],
    ['WhatsApp No', r.whatsappNo || emr['WhatsApp No']],
    ['Visit type', r.visitType],
    ['Token No', r.tokenNo],
    ['Visit date', r.visitDate || r.date],
    ['Patient type', r.patientType],
    ['Corporate', r.corporate],
    ['Department', r.department],
    ['Doctor', r.doctor],
    ['Created by', r.createdUser],
    ['Lab orders', r.totalOrders ? `${r.approvedOrders ?? 0}/${r.totalOrders} approved` : ''],
  ];
  const shown = new Set([
    'REG NO',
    'NAME',
    'PATIENT NAME',
    'PATIENT TYPE',
    'AGE',
    'GENDER',
    'MOBILE',
    'DEPARTMENT',
    'UNIT',
    'DOCTOR',
    'VISIT TYPE',
    'TOKEN NO',
    'VISIT DATE',
    'CORPORATE',
    'CREATED USER',
    'WhatsApp No',
  ]);
  const more = Object.entries(emr).filter(([k]) => !shown.has(k) && !SKIP_FIELDS.has(k));
  const fields = [...core, ...more]
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([label, value]) => ({ label, value: String(value) }));

  const abnormal = labs.filter((l) => l.status === 'high' || l.status === 'low');
  return {
    found: true,
    record: { date: r.date, regNo: r.regNo, name: r.name },
    fields,
    reports: {
      labReport: formatLabSummary(r),
    },
    whatsapp: Object.values(latestByDoc).map((m) => ({
      document: m.documentLabel || m.document,
      status: m.status === 'failed' && m.notOnWhatsApp ? 'Not on WhatsApp' : WA_TEXT[m.status] || m.status,
      to: m.toNumber,
      sentAt: m.acceptedAt || m.createdAt,
      readAt: m.readAt || null,
    })),
    labs: {
      results: labs.length,
      days: new Set(labs.map((l) => l.resultDay)).size,
      abnormal: abnormal.slice(0, 25).map((l) => ({ test: l.test, value: l.value, range: l.range, flag: l.status, date: l.resultDate })),
      abnormalTotal: abnormal.length,
    },
    otherVisits: found.others.map((o) => ({ date: o.date, regNo: o.regNo, department: o.department, visitType: o.visitType })),
  };
}

/** The same, for the AI service: without the fields kept private. */
export function detailsForModel(d) {
  if (!d.found) return d;
  return { ...d, fields: d.fields.filter((f) => !PRIVATE_FIELDS.has(f.label)) };
}

/** An OP patient's journey as dated steps, for a flowchart. */
export async function patientJourney(id, date) {
  const found = await findRecord(id, date);
  if (!found) return { found: false };
  const r = found.record;
  await ensureEmr(r);
  const steps = [];
  const add = (at, lane, title, detail, tone) =>
    at && !Number.isNaN(new Date(at).getTime()) && steps.push({ at: new Date(at), lane, title, detail: detail || '', tone: tone || 'normal' });

  const visitAt = emrTime(r.visitDate) || new Date(`${r.date}T09:00:00+05:30`);
  add(visitAt, 'visit', 'OP Visit', [r.visitType, r.tokenNo && `Token ${r.tokenNo}`, r.department, r.doctor && `Dr. ${r.doctor}`].filter(Boolean).join(' · '));

  const labs = await labValues(r.regNo, r.date);
  const byDay = new Map();
  for (const l of labs) {
    const d = byDay.get(l.resultDay) || { tests: 0, abnormal: [] };
    d.tests += 1;
    if (l.status === 'high' || l.status === 'low') d.abnormal.push(`${l.test} ${l.status === 'high' ? '↑' : '↓'} ${l.value}`);
    byDay.set(l.resultDay, d);
  }
  for (const [day, d] of byDay) {
    add(
      new Date(`${day}T10:00:00+05:30`),
      'lab',
      `Lab tests · ${d.tests} result${d.tests === 1 ? '' : 's'}`,
      d.abnormal.length ? `Out of range: ${d.abnormal.slice(0, 6).join(', ')}${d.abnormal.length > 6 ? ` +${d.abnormal.length - 6} more` : ''}` : 'All within range',
      d.abnormal.length ? 'warn' : 'ok',
    );
  }

  if (r.reportStatus === 'ready' && r.generatedAt) {
    add(r.generatedAt, 'reports', 'OP lab report ready', `${r.approvedOrders ?? r.totalOrders ?? 0} order(s) approved · ${r.dateCount ?? 1} day(s)`, 'ok');
  } else if (r.reportStatus === 'pending') {
    add(r.updatedAt || new Date(`${r.date}T12:00:00+05:30`), 'reports', 'Waiting for lab approval', `${r.approvedOrders ?? 0}/${r.totalOrders ?? 0} orders approved`, 'warn');
  }

  for (const m of await whatsappFor(r.regNo, r.date)) {
    const doc = m.documentLabel || m.document;
    const who = m.trigger === 'auto' ? 'automatically' : `by ${m.triggeredBy || 'staff'}`;
    if (m.status === 'failed') add(m.failedAt || m.createdAt, 'whatsapp', `${doc}: WhatsApp failed`, `${m.notOnWhatsApp ? 'Number not on WhatsApp' : m.error || ''} (${who})`, 'bad');
    else {
      add(m.acceptedAt || m.createdAt, 'whatsapp', `${doc} sent on WhatsApp`, `to +${m.toNumber} ${who}`, 'ok');
      if (m.deliveredAt) add(m.deliveredAt, 'whatsapp', `${doc} delivered`, '', 'ok');
      if (m.readAt) add(m.readAt, 'whatsapp', `${doc} read by patient`, '', 'ok');
    }
  }

  const audit = await (await getMongoCollection('audit_events'))
    .find({ 'target.regNo': r.regNo, action: { $in: ['pdf_open', 'whatsapp_click', 'whatsapp_popup_cancel'] } }, { projection: { at: 1, text: 1, userName: 1, action: 1 } })
    .sort({ at: 1 })
    .limit(30)
    .toArray();
  for (const a of audit) add(a.at, 'staff', a.text.replace(/ of .*$| for .*$/, ''), a.userName, a.action === 'whatsapp_popup_cancel' ? 'warn' : 'normal');

  steps.sort((a, b) => a.at - b.at);
  return { found: true, record: { date: r.date, regNo: r.regNo, name: r.name, department: r.department }, steps };
}

const testKey = (l) => `${l.section || ''}|${l.test}`;

/** Two OP patients side by side, or one UHID across two dates. */
export async function comparePatients({ a, b, dateA, dateB }) {
  const A = await findRecord(a, dateA);
  const B = b ? await findRecord(b, dateB) : A;
  if (!A || !B) return { found: false, missing: !A ? a : b };
  const ra = A.record;
  const rb = B.record;
  const samePatient = ra.regNo === rb.regNo;
  const [la, lb] = await Promise.all([
    labValues(ra.regNo, samePatient && !dateA ? undefined : ra.date),
    samePatient ? null : labValues(rb.regNo, rb.date),
  ]);
  const days = [...new Set(la.map((l) => l.resultDay))].sort();
  const pick = (labs, day, fallback) => {
    const want = DATE_RE.test(day || '') ? day : fallback;
    const map = new Map();
    for (const l of labs) if (!want || l.resultDay === want) map.set(testKey(l), l);
    return map;
  };
  let mapA;
  let mapB;
  let labelA;
  let labelB;
  if (samePatient) {
    const first = DATE_RE.test(dateA || '') ? dateA : days[0];
    const last = DATE_RE.test(dateB || '') ? dateB : days[days.length - 1];
    mapA = pick(la, first);
    mapB = pick(la, last);
    labelA = `${ra.name} · ${first ? first.split('-').reverse().join('-') : '—'}`;
    labelB = `${ra.name} · ${last ? last.split('-').reverse().join('-') : '—'}`;
  } else {
    mapA = pick(la, dateA);
    mapB = pick(lb, dateB);
    labelA = `${ra.name} (${ra.regNo})`;
    labelB = `${rb.name} (${rb.regNo})`;
  }

  const keys = [...new Set([...mapA.keys(), ...mapB.keys()])];
  const labs = keys
    .map((k) => {
      const x = mapA.get(k);
      const y = mapB.get(k);
      const diff =
        x?.numeric !== undefined && x?.numeric !== null && y?.numeric !== undefined && y?.numeric !== null
          ? Math.round((y.numeric - x.numeric) * 100) / 100
          : null;
      return {
        test: (x || y).test,
        section: (x || y).section || '',
        range: (x || y).range || '',
        a: x ? { value: x.value, flag: x.status, date: x.resultDate } : null,
        b: y ? { value: y.value, flag: y.status, date: y.resultDate } : null,
        diff,
        changed: Boolean(x && y && (x.value !== y.value || x.status !== y.status)),
      };
    })
    .sort((p, q) => Number(Boolean(q.a && q.b)) - Number(Boolean(p.a && p.b)) || p.section.localeCompare(q.section) || p.test.localeCompare(q.test));

  const row = (label, f) => ({ label, a: f(ra) ?? '', b: f(rb) ?? '' });
  const demographics = samePatient
    ? []
    : [
      row('UHID', (r) => r.regNo),
      row('Age / gender', (r) => [r.age, r.gender].filter(Boolean).join(' / ')),
      row('Department', (r) => r.department),
      row('Doctor', (r) => r.doctor),
      row('Visit date', (r) => r.visitDate || r.date),
      row('Visit type', (r) => r.visitType),
      row('Token No', (r) => r.tokenNo),
      row('Orders', (r) => (r.totalOrders ? `${r.approvedOrders ?? 0}/${r.totalOrders} approved` : '')),
    ];
  const both = labs.filter((l) => l.a && l.b);
  return {
    found: true,
    samePatient,
    labelA,
    labelB,
    demographics,
    labs,
    summary: {
      testsCompared: both.length,
      changed: both.filter((l) => l.changed).length,
      abnormalA: labs.filter((l) => ['high', 'low'].includes(l.a?.flag)).length,
      abnormalB: labs.filter((l) => ['high', 'low'].includes(l.b?.flag)).length,
      onlyA: labs.filter((l) => l.a && !l.b).length,
      onlyB: labs.filter((l) => l.b && !l.a).length,
    },
    days: samePatient ? days : undefined,
  };
}
