/**
 * Ask AI's patient answers: everything known about a discharged patient
 * (the EMR discharge row — address, relation, diagnosis… — plus stay, reports,
 * lab values and WhatsApp), their journey as a timeline (admission → lab days
 * → discharge → reports → WhatsApp → staff actions), and comparisons of two
 * patients or two dates of one patient's lab values.
 */
import { getMongoCollection } from './mongo.js';
import { emrDetails, fetchDischargeList } from './dischargeReportService.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Shown on screen, but not sent to the AI service.
export const PRIVATE_FIELDS = new Set(['ABHA ID', 'RELIGION', 'MLC', 'MLC RECORD NUMBER']);
// Columns already shown elsewhere on the card, or empty noise.
const SKIP_FIELDS = new Set(['IPVISIT']);

/** "29-09-2026 12:24" (EMR) → Date (India time), or null. */
export function emrTime(text) {
  const m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(String(text || ''));
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${(m[4] || '00').padStart(2, '0')}:${m[5] || '00'}:00+05:30`) : null;
}

function stayLength(admitted, discharged) {
  if (!admitted || !discharged) return null;
  const hours = Math.max(0, (discharged - admitted) / 3600_000);
  const days = Math.floor(hours / 24);
  return { hours: Math.round(hours), text: days ? `${days} day${days === 1 ? '' : 's'} ${Math.round(hours % 24)} h` : `${Math.round(hours)} h` };
}

/** The discharge record for an IP number, UHID or name (latest stay first). */
export async function findRecord(id, date) {
  const q = String(id || '').trim();
  if (!q) return null;
  const c = await getMongoCollection('discharge_reports');
  let filter;
  if (/^ip\s*\d+$/i.test(q)) filter = { ipNo: { $regex: `^${esc(q.replace(/\s+/g, ''))}$`, $options: 'i' } };
  else if (/^\d{4,}$/.test(q)) filter = { $or: [{ regNo: q }, { ipNo: { $regex: `${esc(q)}$` } }] };
  else filter = { name: { $regex: esc(q), $options: 'i' } };
  if (DATE_RE.test(date || '')) filter = { ...filter, date };
  const docs = await c.find(filter, { projection: { _id: 0, reqNos: 0 } }).sort({ date: -1 }).limit(5).toArray();
  return docs.length ? { record: docs[0], others: docs.slice(1) } : null;
}

// One EMR discharge-list call per date, reused for 10 minutes.
const listCache = new Map();
async function emrRowsFor(date) {
  const hit = listCache.get(date);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.rows;
  const [y, m, d] = date.split('-');
  const rows = await fetchDischargeList(`${m}/${d}/${y}`, `${m}/${d}/${y}`);
  const list = Array.isArray(rows) ? rows : rows?.data || [];
  listCache.set(date, { at: Date.now(), rows: list });
  return list;
}

/** Fills in the full EMR row for records saved before it was kept (and stores it). */
export async function ensureEmr(record) {
  if (record.emr && Object.keys(record.emr).length) return record.emr;
  try {
    const row = (await emrRowsFor(record.date)).find((r) => String(r['IP NO'] || '').trim() === record.ipNo);
    if (!row) return {};
    const emr = emrDetails(row);
    await (await getMongoCollection('discharge_reports')).updateOne({ date: record.date, ipNo: record.ipNo }, { $set: { emr } });
    return emr;
  } catch {
    return {};
  }
}

async function labValues(ipNo, dischargeDate) {
  return (await getMongoCollection('lab_results'))
    .find({ ipNo, ...(dischargeDate ? { dischargeDate } : {}) }, { projection: { _id: 0, section: 1, test: 1, value: 1, numeric: 1, range: 1, status: 1, resultDate: 1, resultDay: 1 } })
    .sort({ resultDay: 1, section: 1, test: 1 })
    .toArray();
}

async function whatsappFor(ipNo, date) {
  return (await getMongoCollection('whatsapp_messages'))
    .find({ ipNo, ...(date ? { dischargeDate: date } : {}) }, { projection: { history: 0 } })
    .sort({ createdAt: 1 })
    .toArray();
}

const WA_TEXT = { pending: 'Pending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };

/** Everything about one discharged patient. */
export async function patientDetails(id, date) {
  const found = await findRecord(id, date);
  if (!found) return { found: false };
  const r = found.record;
  const emr = await ensureEmr(r);
  const admitted = emrTime(r.admissionDate);
  const discharged = emrTime(r.dischargeDate);
  const labs = await labValues(r.ipNo, r.date);
  const msgs = await whatsappFor(r.ipNo, r.date);
  const latestByDoc = {};
  for (const m of msgs) latestByDoc[m.document] = m;

  const core = [
    ['Name', r.name],
    ['IP No', r.ipNo],
    ['UHID', r.regNo],
    ['Age', r.age],
    ['Gender', r.gender],
    ['Mobile', r.mobile],
    ['WhatsApp No', r.whatsapp || emr['WhatsApp No']],
    ['Patient type', r.patientType],
    ['Department', r.department],
    ['Doctor', r.doctor],
    ['Ward', r.ward],
    ['Bed', r.bedNo],
    ['Admitted', r.admissionDate],
    ['Discharged', r.dischargeDate],
    ['Length of stay', stayLength(admitted, discharged)?.text],
    ['Discharge type', r.dischargeType],
    ['Created by', r.createdUser],
    ['Summary approved by', r.summaryApprovedBy],
  ];
  const shown = new Set(['REG NO', 'IP NO', 'ADMISSION DATE', 'PATIENT NAME', 'PATIENT TYPE', 'AGE', 'GENDER', 'MOBILE', 'DEPARTMENT', 'DOCTOR', 'WARD', 'BED NO', 'DISCHARGE DATE', 'DISCHARGE TYPE', 'CREATED USER', 'WhatsApp No']);
  const more = Object.entries(emr).filter(([k]) => !shown.has(k) && !SKIP_FIELDS.has(k));
  const fields = [...core, ...more].filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '').map(([label, value]) => ({ label, value: String(value) }));

  const abnormal = labs.filter((l) => l.status === 'high' || l.status === 'low');
  return {
    found: true,
    record: { date: r.date, ipNo: r.ipNo, regNo: r.regNo, name: r.name },
    fields,
    stay: { admittedAt: admitted, dischargedAt: discharged, length: stayLength(admitted, discharged) },
    reports: {
      labReport: r.dateCount !== undefined && r.dateCount !== null ? `Ready (${r.dateCount} lab day${r.dateCount === 1 ? '' : 's'})` : 'No lab data',
      dischargeSummary: r.hasSummary && r.summaryDataMissing ? 'No Summary (EMR had no data)' : r.hasSummary ? 'Ready' : 'Not available yet',
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
    otherStays: found.others.map((o) => ({ date: o.date, ipNo: o.ipNo, department: o.department })),
  };
}

/** The same, for the AI service: without the fields kept private. */
export function detailsForModel(d) {
  if (!d.found) return d;
  return { ...d, fields: d.fields.filter((f) => !PRIVATE_FIELDS.has(f.label)) };
}

/** A patient's journey as dated steps, for a flowchart. */
export async function patientJourney(id, date) {
  const found = await findRecord(id, date);
  if (!found) return { found: false };
  const r = found.record;
  const emr = await ensureEmr(r);
  const steps = [];
  const add = (at, lane, title, detail, tone) => at && !Number.isNaN(new Date(at).getTime()) && steps.push({ at: new Date(at), lane, title, detail: detail || '', tone: tone || 'normal' });

  add(emrTime(r.admissionDate), 'stay', 'Admitted', [r.department, r.ward, r.bedNo && `Bed ${r.bedNo}`, emr.IP_Diagnosis && `Diagnosis: ${emr.IP_Diagnosis}`].filter(Boolean).join(' · '));
  const labs = await labValues(r.ipNo, r.date);
  const byDay = new Map();
  for (const l of labs) {
    const d = byDay.get(l.resultDay) || { tests: 0, abnormal: [] };
    d.tests += 1;
    if (l.status === 'high' || l.status === 'low') d.abnormal.push(`${l.test} ${l.status === 'high' ? '↑' : '↓'} ${l.value}`);
    byDay.set(l.resultDay, d);
  }
  for (const [day, d] of byDay) {
    add(new Date(`${day}T09:00:00+05:30`), 'lab', `Lab tests · ${d.tests} result${d.tests === 1 ? '' : 's'}`, d.abnormal.length ? `Out of range: ${d.abnormal.slice(0, 6).join(', ')}${d.abnormal.length > 6 ? ` +${d.abnormal.length - 6} more` : ''}` : 'All within range', d.abnormal.length ? 'warn' : 'ok');
  }
  add(emrTime(r.dischargeDate), 'stay', 'Discharged', [r.dischargeType, stayLength(emrTime(r.admissionDate), emrTime(r.dischargeDate))?.text && `stay ${stayLength(emrTime(r.admissionDate), emrTime(r.dischargeDate)).text}`, r.doctor && `Dr. ${r.doctor}`].filter(Boolean).join(' · '));
  if (r.generatedAt) add(r.generatedAt, 'reports', 'Lab report made', `${r.dateCount ?? 0} lab day${r.dateCount === 1 ? '' : 's'}`, 'ok');
  if (r.hasSummary) add(r.summaryGeneratedAt || r.generatedAt || emrTime(r.dischargeDate), 'reports', r.summaryDataMissing ? 'Discharge summary: no data in EMR' : 'Discharge summary ready', r.summaryApprovedBy ? `Approved by ${r.summaryApprovedBy}` : '', r.summaryDataMissing ? 'bad' : 'ok');

  for (const m of await whatsappFor(r.ipNo, r.date)) {
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
    .find({ 'target.ipNo': r.ipNo, action: { $in: ['pdf_open', 'whatsapp_click', 'whatsapp_popup_cancel'] } }, { projection: { at: 1, text: 1, userName: 1, action: 1 } })
    .sort({ at: 1 })
    .limit(30)
    .toArray();
  for (const a of audit) add(a.at, 'staff', a.text.replace(/ of .*$| for .*$/, ''), a.userName, a.action === 'whatsapp_popup_cancel' ? 'warn' : 'normal');

  steps.sort((a, b) => a.at - b.at);
  return { found: true, record: { date: r.date, ipNo: r.ipNo, regNo: r.regNo, name: r.name, department: r.department }, steps };
}

const testKey = (l) => `${l.section || ''}|${l.test}`;

/**
 * Two patients side by side, or one patient's lab values on two dates
 * (a = b, with dateA / dateB as result days YYYY-MM-DD).
 */
export async function comparePatients({ a, b, dateA, dateB }) {
  const A = await findRecord(a);
  const B = b ? await findRecord(b) : A;
  if (!A || !B) return { found: false, missing: !A ? a : b };
  const ra = A.record;
  const rb = B.record;
  const samePatient = ra.ipNo === rb.ipNo;
  const [la, lb] = await Promise.all([labValues(ra.ipNo, ra.date), samePatient ? null : labValues(rb.ipNo, rb.date)]);
  const days = [...new Set(la.map((l) => l.resultDay))].sort();
  const pick = (labs, day, fallback) => {
    const want = DATE_RE.test(day || '') ? day : fallback;
    const map = new Map();
    for (const l of labs) if (!want || l.resultDay === want) map.set(testKey(l), l); // latest wins (sorted by day)
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
    labelA = `${ra.name} (${ra.ipNo})`;
    labelB = `${rb.name} (${rb.ipNo})`;
  }

  const keys = [...new Set([...mapA.keys(), ...mapB.keys()])];
  const labs = keys
    .map((k) => {
      const x = mapA.get(k);
      const y = mapB.get(k);
      const diff = x?.numeric !== undefined && x?.numeric !== null && y?.numeric !== undefined && y?.numeric !== null ? Math.round((y.numeric - x.numeric) * 100) / 100 : null;
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
        row('Admitted', (r) => r.admissionDate),
        row('Discharged', (r) => r.dischargeDate),
        row('Length of stay', (r) => stayLength(emrTime(r.admissionDate), emrTime(r.dischargeDate))?.text),
        row('Diagnosis', (r) => r.emr?.IP_Diagnosis),
        row('Discharge type', (r) => r.dischargeType),
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
