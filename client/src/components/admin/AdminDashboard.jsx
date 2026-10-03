import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchWatiUsage,
  fetchWhatsappActivity,
  fetchWhatsappInsights,
  fetchWhatsappMessage,
  fetchWhatsappMessages,
  fetchWhatsappSummary,
  downloadWhatsappExport,
  fetchWhatsappPatients,
  refreshWhatsappStatuses,
  retryWhatsappMessage,
} from '../../api/client';
import { AlertIcon, CheckIcon, CloseIcon, CopyIcon, RefreshIcon, SearchIcon, WhatsAppIcon } from '../Icons';
import { track } from '../../utils/audit';
import { ChartCard, Columns, Delta, HBars, LegendItem, RateLines, StackedColumns, StackedHBars, StatTile } from './Charts';

const LIVE_REFRESH_MS = 15_000;
const PAGE_SIZE = 20;

// Stack order bottom → top. Sent / delivered / read are one ordinal blue ramp
// (a message moves along it); pending and failed use the reserved status colours.
const STATUS = {
  read: { label: 'Read', color: 'var(--st-read)' },
  delivered: { label: 'Delivered', color: 'var(--st-delivered)' },
  sent: { label: 'Sent', color: 'var(--st-sent)' },
  pending: { label: 'Pending', color: 'var(--st-pending)' },
  failed: { label: 'Failed to send', color: 'var(--st-failed)' },
  // A kind of failure, kept apart: the number may not be on WhatsApp (retried anyway).
  nowa: { label: 'Not on WhatsApp', color: 'var(--st-nowa)' },
};
const STATUS_ORDER = ['read', 'delivered', 'sent', 'pending', 'failed', 'nowa'];
const SERIES = STATUS_ORDER.map((key) => ({ key, ...STATUS[key] }));
// Filter chips follow a message's life: pending → sent → delivered → read, or failed.
const CHIP_ORDER = ['pending', 'sent', 'delivered', 'read', 'failed', 'nowa'];

const DOCUMENT_LABEL = { lab: 'Lab report', summary: 'Discharge summary', lab_results: 'Lab results list', other: 'Other' };
const TRIGGER_LABEL = { auto: 'Automatic (live)', manual: 'Manual click', share: 'Shared to a number', imported: 'Imported history' };
const VIA_LABEL = { assistant: 'Ask AI', lab_finder: 'Lab Finder', reports: 'Discharge Reports' };

const PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
  { id: 'custom', label: 'Custom' },
];

// ---- dates (hospital time) --------------------------------------------------

function istToday() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function shiftDay(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function presetRange(id) {
  const today = istToday();
  if (id === 'today') return { from: today, to: today };
  if (id === 'yesterday') return { from: shiftDay(today, -1), to: shiftDay(today, -1) };
  if (id === '7d') return { from: shiftDay(today, -6), to: today };
  if (id === '30d') return { from: shiftDay(today, -29), to: today };
  if (id === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  return null;
}

const dmy = (iso) => (iso ? iso.split('-').reverse().join('-') : '');

function formatBucketFactory(granularity) {
  return (bucket, short) => {
    if (granularity === 'hour') return short ? `${Number(bucket)}` : `${bucket}:00 – ${bucket}:59`;
    const [, m, d] = bucket.split('-');
    const date = new Date(`${bucket}T00:00:00`);
    return short ? `${Number(d)}/${Number(m)}` : date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  };
}

function formatTime(iso, withDate = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    ...(withDate ? { day: '2-digit', month: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

function between(a, b) {
  if (!a || !b) return null;
  return (new Date(b) - new Date(a)) / 1000;
}

function timeAgo(date, now) {
  if (!date) return '';
  const s = Math.max(0, Math.round((now - new Date(date)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function formatNumber(digits) {
  const d = String(digits || '');
  return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : d ? `+${d}` : '—';
}

const pct = (r) => (r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`);

// ---- status icon: WhatsApp-style ticks, always with a text label ----------

export function StatusIcon({ status, size = 16 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true };
  if (status === 'read' || status === 'delivered') {
    return (
      <svg {...common} className={`wa-ticks is-${status}`}>
        <path d="M2 13l4 4 8-9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9.5 16l1 1 8-9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === 'sent') {
    return (
      <svg {...common} className="wa-ticks is-sent">
        <path d="M5 13l4 4 10-10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === 'nowa') {
    return (
      <svg {...common} className="wa-ticks is-failed">
        <path d="M20 11.5a8.4 8.4 0 0 1-12.2 7.5L3 20.5l1.5-4.6A8.4 8.4 0 1 1 20 11.5z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg {...common} className="wa-ticks is-failed">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path d="M12 7.5v5.5M12 16.5v.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common} className="wa-ticks is-pending">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A failure because the number isn't on WhatsApp gets its own label — a resend won't fix it. */
function StatusPill({ status, notOnWhatsApp }) {
  const nowa = status === 'failed' && notOnWhatsApp;
  return (
    <span className={`wa-pill is-${status} ${nowa ? 'is-nowa' : ''}`}>
      <StatusIcon status={nowa ? 'nowa' : status} size={15} />
      {nowa ? 'Not on WhatsApp' : STATUS[status]?.label || status}
    </span>
  );
}

function NoWhatsAppTag() {
  return (
    <span className="wa-nowa-tag" title="The last message to this number failed because it is not on WhatsApp — check the mobile number in the EMR">
      <StatusIcon status="nowa" size={12} /> Not on WhatsApp
    </span>
  );
}

// ---- message detail drawer --------------------------------------------------

function Timeline({ message }) {
  const failed = message.status === 'failed';
  const steps = [
    { key: 'triggered', label: 'Triggered', at: message.createdAt, note: `${TRIGGER_LABEL[message.trigger] || message.trigger}${message.via ? ` · via ${VIA_LABEL[message.via] || message.via}` : ''} · by ${message.triggeredBy}` },
    { key: 'sent', label: 'Accepted by WATI (✓)', at: message.acceptedAt, note: message.acceptedAt ? `after ${formatDuration(between(message.createdAt, message.acceptedAt))}` : null },
    { key: 'delivered', label: 'Delivered to phone (✓✓)', at: message.deliveredAt, note: message.deliveredAt ? `${formatDuration(between(message.acceptedAt, message.deliveredAt))} after sending` : null },
    { key: 'read', label: 'Read by patient (blue ✓✓)', at: message.readAt, note: message.readAt ? `${formatDuration(between(message.acceptedAt, message.readAt))} after sending` : null },
  ];
  if (failed) steps.push({ key: 'failed', label: 'Failed', at: message.failedAt, note: message.failedDetail || message.error || 'WATI reported a failure' });

  return (
    <ol className="wa-timeline">
      {steps.map((s) => {
        const done = Boolean(s.at) || (message.imported && s.key !== 'failed' && ['sent', 'delivered', 'read'].indexOf(message.status) >= ['sent', 'delivered', 'read'].indexOf(s.key));
        return (
          <li key={s.key} className={`${done ? 'is-done' : 'is-waiting'} is-${s.key}`}>
            <span className="wa-timeline-dot" />
            <div className="wa-timeline-body">
              <div className="wa-timeline-label">{s.label}</div>
              <div className="wa-timeline-time">{s.at ? formatTime(s.at) : done ? 'Time not recorded (imported)' : failed ? '—' : 'Waiting…'}</div>
              {s.note && <div className="wa-timeline-note">{s.note}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Plain-language meaning of a failure, shown above WATI's own wording. */
function explainFailure(text) {
  const t = String(text || '');
  if (/not a whatsapp number|not a valid whatsapp|invalid|undeliverable|131026/i.test(t))
    return 'WhatsApp says this number can\'t receive messages: it may not be on WhatsApp or be mistyped — or the phone may just be off, or its data off. It\'s retried automatically every 6 hours for 3 days; if it keeps failing, check the mobile number in the EMR.';
  if (/429|usage limit/i.test(t)) return 'WATI\'s API usage limit was reached, so WATI refused the message for now. It is retried automatically every hour until it goes through.';
  if (/timeout|aborted|network|fetch failed|ECONN|socket|503|502|busy/i.test(t)) return 'WATI or the network was briefly unavailable. This is retried automatically.';
  if (/undeliverable|re-?engage|24 ?hours|blocked/i.test(t)) return 'WhatsApp would not deliver it (the patient may have blocked the business number or be unreachable).';
  if (/template/i.test(t)) return 'WATI rejected the message template. Check the template in the WATI dashboard.';
  if (/no longer available|no patient data/i.test(t)) return 'The report itself is missing, so there is nothing to send.';
  return 'WATI did not accept or deliver this message.';
}

function MessageDrawer({ id, onClose, onChanged, readOnly = false }) {
  const [message, setMessage] = useState(null);
  // Audit log: whose message was opened (once per drawer).
  const opened = useRef(false);
  useEffect(() => {
    if (!message || opened.current) return;
    opened.current = true;
    track('message_open', {
      screen: 'admin',
      target: { patientName: message.patientName, ipNo: message.ipNo, date: message.dischargeDate },
      details: { document: message.documentLabel || message.document, status: message.status },
    });
  }, [message]);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [retrying, setRetrying] = useState(false);

  async function retryNow() {
    setRetrying(true);
    setError('');
    try {
      const res = await retryWhatsappMessage(id);
      setMessage((m) => ({ ...m, ...res.message }));
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setRetrying(false);
    }
  }

  const load = useCallback(() => {
    fetchWhatsappMessage(id)
      .then(setMessage)
      .catch((err) => setError(err.message));
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, LIVE_REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function checkNow() {
    setChecking(true);
    try {
      await refreshWhatsappStatuses();
      load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="wa-drawer-backdrop" onClick={onClose}>
      <aside className="wa-drawer" role="dialog" aria-label="Message details" onClick={(e) => e.stopPropagation()}>
        <header className="wa-drawer-head">
          <div>
            <div className="wa-drawer-eyebrow">WhatsApp message</div>
            <h3>{message?.patientName || message?.documentLabel || 'Message'}</h3>
          </div>
          <button type="button" className="wa-icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={18} />
          </button>
        </header>
        {error && <div className="lock-error">{error}</div>}
        {message && (
          <div className="wa-drawer-body">
            <div className="wa-drawer-status">
              <StatusPill status={message.status} notOnWhatsApp={message.notOnWhatsApp} />
              <span className="wa-drawer-doc">{message.documentLabel || DOCUMENT_LABEL[message.document]}</span>
            </div>
            {message.status === 'failed' && (
              <div className="wa-failure" role="alert">
                <div className="wa-failure-title">Why it failed</div>
                <p>{explainFailure(message.failedDetail || message.error)}</p>
                {(message.failedDetail || message.error) && <p className="wa-failure-raw">WATI: {message.failedDetail || message.error}</p>}
                <p className="wa-failure-retry">
                  {message.nextRetryAt
                    ? `Retried automatically every 6 hours for 3 days${message.notOnWhatsApp ? ' (in case the "not on WhatsApp" tag is wrong — the phone may just be off)' : ''} — tried ${message.attempts || 1} time${(message.attempts || 1) === 1 ? '' : 's'}, next at ${formatTime(message.nextRetryAt)}.`
                    : (message.attempts || 1) > 1
                      ? `Tried ${message.attempts} times — no more automatic retries. Press Retry to try again.`
                      : 'Not retried automatically — fix the cause, then press Retry.'}
                </p>
                {!readOnly && ['lab', 'summary'].includes(message.document) && message.ipNo && (
                  <button type="button" className="btn wa-retry" onClick={retryNow} disabled={retrying}>
                    <RefreshIcon size={15} spinning={retrying} /> {retrying ? 'Sending again…' : 'Retry now'}
                  </button>
                )}
              </div>
            )}
            <Timeline message={message} />
            <dl className="wa-facts">
              {(message.attempts || 1) > 1 && <div><dt>Attempts</dt><dd>{message.attempts}</dd></div>}
              <div><dt>To</dt><dd>{formatNumber(message.toNumber)}</dd></div>
              {message.ipNo && <div><dt>IP number</dt><dd>{message.ipNo}</dd></div>}
              {message.dischargeDate && <div><dt>Discharged</dt><dd>{dmy(message.dischargeDate)}</dd></div>}
              {message.department && <div><dt>Department</dt><dd>{message.department}</dd></div>}
              <div><dt>Mode</dt><dd>{message.trigger === 'imported' ? '—' : message.liveMode ? 'Live' : 'Test / manual'}</dd></div>
              <div><dt>Template</dt><dd>{message.template || '—'}</dd></div>
              <div><dt>WATI status</dt><dd>{message.watiStatus || '—'}</dd></div>
              <div><dt>Last checked</dt><dd>{formatTime(message.lastCheckedAt)}</dd></div>
              {message.watiMessageId && <div><dt>WATI message id</dt><dd className="wa-mono">{message.watiMessageId}</dd></div>}
            </dl>
            {!readOnly && (
            <button type="button" className="btn btn-secondary wa-check" onClick={checkNow} disabled={checking}>
              <RefreshIcon size={15} spinning={checking} /> {checking ? 'Checking WATI…' : 'Check status now'}
            </button>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

// ---- patient-wise table ------------------------------------------------------

function ReportBadge({ report, onOpen }) {
  const when = report.readAt || report.deliveredAt || report.acceptedAt || report.createdAt;
  const nowa = report.status === 'failed' && report.notOnWhatsApp;
  return (
    <button type="button" className={`wa-report is-${report.status}`} onClick={() => onOpen(report.id)} title="Open this report's timeline">
      <span className="wa-report-name">
        {report.documentLabel || DOCUMENT_LABEL[report.document]}
        {report.sends > 1 && <span className="wa-report-sends">×{report.sends}</span>}
      </span>
      <span className="wa-report-state">
        <StatusIcon status={nowa ? 'nowa' : report.status} size={14} />
        {nowa ? 'Not on WhatsApp' : STATUS[report.status]?.label}
        <span className="wa-report-time">{formatTime(when, false)}</span>
      </span>
    </button>
  );
}

function PatientsTable({ patients, onOpen, changed }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (key) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <table className="wa-table wa-patients">
      <thead>
        <tr>
          <th aria-label="Expand" />
          <th>Patient</th>
          <th>Reports</th>
          <th>Overall</th>
          <th>To</th>
          <th>Last update</th>
        </tr>
      </thead>
      <tbody>
        {patients.length === 0 && (
          <tr>
            <td colSpan={6} className="viz-empty">
              No patients match these filters
            </td>
          </tr>
        )}
        {patients.map((p) => {
          const open = expanded.has(p.key);
          return (
            <FragmentRows key={p.key}>
              <tr className={`wa-patient-row ${changed.has(p.key) ? 'is-changed' : ''} ${open ? 'is-open' : ''}`} onClick={() => toggle(p.key)}>
                <td className="wa-expand">
                  <button type="button" aria-expanded={open} aria-label={open ? 'Hide messages' : 'Show messages'} onClick={(e) => { e.stopPropagation(); toggle(p.key); }}>
                    <span className={`wa-chevron ${open ? 'is-open' : ''}`} />
                  </button>
                </td>
                <td>
                  <div className="wa-cell-main">{p.patientName || '—'}</div>
                  <div className="wa-cell-sub">
                    {[p.ipNo, p.dischargeDate && `discharged ${dmy(p.dischargeDate)}`, p.department].filter(Boolean).join(' · ') || 'Imported from WATI'}
                  </div>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="wa-reports">
                    {p.reports.map((r) => (
                      <ReportBadge key={r.id} report={r} onOpen={onOpen} />
                    ))}
                  </div>
                </td>
                <td>
                  <StatusPill status={p.status} notOnWhatsApp={p.notOnWhatsApp} />
                </td>
                <td className="wa-mono">
                  {formatNumber(p.toNumber)}
                  {p.notOnWhatsApp && <NoWhatsAppTag />}
                </td>
                <td className="wa-time">{formatTime(p.lastAt)}</td>
              </tr>
              {open && (
                <tr className="wa-sub-row">
                  <td />
                  <td colSpan={5}>
                    <div className="wa-sub-title">
                      {p.messages.length} message{p.messages.length === 1 ? '' : 's'} sent to this patient
                    </div>
                    <table className="wa-sub-table">
                      <thead>
                        <tr>
                          <th>Report</th>
                          <th>Status</th>
                          <th>Sent</th>
                          <th>Delivered</th>
                          <th>Read</th>
                          <th>Trigger</th>
                          <th>Attempts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.messages.map((m) => (
                          <tr key={m.id} onClick={() => onOpen(m.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(m.id)}>
                            <td>{m.documentLabel || DOCUMENT_LABEL[m.document]}</td>
                            <td>
                              <StatusPill status={m.status} notOnWhatsApp={m.notOnWhatsApp} />
                              {m.status === 'failed' && (m.failedDetail || m.error) && <div className="wa-cell-sub wa-fail-text">{m.failedDetail || m.error}</div>}
                            </td>
                            <td className="wa-time">{formatTime(m.acceptedAt || m.createdAt)}</td>
                            <td className="wa-time">{m.deliveredAt ? formatTime(m.deliveredAt) : '—'}</td>
                            <td className="wa-time">{m.readAt ? formatTime(m.readAt) : '—'}</td>
                            <td>
                              <div className="wa-cell-main">{TRIGGER_LABEL[m.trigger] || m.trigger}</div>
                              <div className="wa-cell-sub">{m.triggeredBy}</div>
                            </td>
                            <td>{m.attempts || 1}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </FragmentRows>
          );
        })}
      </tbody>
    </table>
  );
}

function FragmentRows({ children }) {
  return <>{children}</>;
}

const EXPORTS = [
  { format: 'xlsx', label: 'Excel', ext: 'XLS' },
  { format: 'pdf', label: 'PDF', ext: 'PDF' },
  { format: 'csv', label: 'CSV', ext: 'CSV' },
  { format: 'json', label: 'JSON', ext: 'JSON' },
];

// ---- coverage & attention ----------------------------------------------------

// Every discharged patient ends in exactly one of these (best outcome first).
const COVERAGE_STATES = [
  { key: 'read', label: 'Read', color: 'var(--st-read)' },
  { key: 'delivered', label: 'Delivered', color: 'var(--st-delivered)' },
  { key: 'sent', label: 'Sent, not delivered', color: 'var(--st-sent)' },
  { key: 'pending', label: 'Sending', color: 'var(--st-pending)' },
  { key: 'failed', label: 'Failed', color: 'var(--st-failed)' },
  { key: 'nowa', label: 'Not on WhatsApp', color: '#8f1f1f' },
  { key: 'notSent', label: 'Not sent', color: '#a8a79f' },
  { key: 'noReport', label: 'No report yet', color: '#c3c2b7' },
  { key: 'noMobile', label: 'No mobile number', color: '#dcdbd4' },
];
const STATE_LABEL = Object.fromEntries(COVERAGE_STATES.map((s) => [s.key, s.label]));

function CoverageCard({ coverage, liveEnabled, range }) {
  const [showAll, setShowAll] = useState(false);
  if (!coverage) return null;
  const { discharged, reached, counts, notReached, notReachedTotal } = coverage;
  const pctReached = discharged ? Math.round((reached / discharged) * 100) : 0;
  const list = showAll ? notReached : notReached.slice(0, 6);
  return (
    <section className="viz-card wa-span-2 wa-coverage">
      <header className="viz-card-head">
        <div>
          <h3>Did every discharged patient get their reports?</h3>
          <p>Patients discharged {range.from === range.to ? dmy(range.from) : `${dmy(range.from)} to ${dmy(range.to)}`} · by discharge date</p>
        </div>
      </header>
      {discharged === 0 ? (
        <div className="viz-empty">No discharges recorded for these dates</div>
      ) : (
        <>
          <div className="wa-coverage-hero">
            <div>
              <span className="wa-coverage-big">{reached}</span>
              <span className="wa-coverage-of"> of {discharged} patients reached on WhatsApp</span>
            </div>
            <div className="wa-coverage-pct">
              <b>{pctReached}%</b> reached · <b>{counts.read}</b> read their reports
            </div>
          </div>
          <div className="wa-coverage-bar" role="img" aria-label={`${reached} of ${discharged} patients reached`}>
            {COVERAGE_STATES.filter((st) => counts[st.key] > 0).map((st) => (
              <span key={st.key} style={{ flexGrow: counts[st.key], background: st.color }} title={`${st.label}: ${counts[st.key]}`} />
            ))}
          </div>
          <div className="viz-legend">
            {COVERAGE_STATES.filter((st) => counts[st.key] > 0).map((st) => (
              <span key={st.key} className="viz-legend-item">
                <span className="viz-key is-rect" style={{ background: st.color }} />
                {st.label} <b className="wa-legend-count">{counts[st.key]}</b>
              </span>
            ))}
          </div>
          {!liveEnabled && counts.notSent > 0 && (
            <div className="wa-coverage-note">Live mode is off, so reports are only sent when someone clicks Send — that's why {counts.notSent} patient{counts.notSent === 1 ? ' is' : 's are'} "Not sent".</div>
          )}
          {notReachedTotal > 0 && (
            <div className="wa-notreached">
              <div className="wa-notreached-title">Not reached ({notReachedTotal})</div>
              <ul>
                {list.map((p) => (
                  <li key={`${p.date}-${p.ipNo}`}>
                    <span className="wa-cell-main">{p.name}</span>
                    <span className="wa-cell-sub">
                      {p.ipNo} · {p.department}
                    </span>
                    <span className={`wa-reason is-${p.state}`}>{STATE_LABEL[p.state]}</span>
                  </li>
                ))}
              </ul>
              {notReached.length > 6 && (
                <button type="button" className="ai-link" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer' : `Show all ${notReached.length}`}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

const ATTENTION = [
  { key: 'fixable', filter: 'fixable', icon: 'failed', label: 'Failed to send', hint: 'Retried automatically (every 6 h for 3 days) — or open one and press Retry' },
  { key: 'nowa', filter: 'nowa', icon: 'nowa', label: 'Not on WhatsApp', hint: 'Retried every 6 h for 3 days in case the phone was off — check the mobile in the EMR' },
  { key: 'unread24', filter: 'unread24', icon: 'delivered', label: 'Delivered, unread for 24 h+', hint: 'Patient may need a call' },
  { key: 'stuck6', filter: 'stuck6', icon: 'sent', label: 'One tick for 6 h+', hint: 'Phone off or no internet' },
];
const SPECIAL_FILTER_LABEL = {
  fixable: 'Failed — can be fixed',
  unread24: 'Unread 24 h+',
  stuck6: 'One tick 6 h+',
};

function AttentionCard({ attention, onShow }) {
  if (!attention) return null;
  const total = ATTENTION.reduce((sum, a) => sum + (attention[a.key] || 0), 0);
  return (
    <section className="viz-card wa-attention">
      <header className="viz-card-head">
        <div>
          <h3>Needs attention</h3>
          <p>In this date range</p>
        </div>
      </header>
      {total === 0 ? (
        <div className="wa-allclear">
          <StatusIcon status="read" size={22} />
          <div>
            <b>All clear</b>
            <span>Nothing failed or stuck in this range.</span>
          </div>
        </div>
      ) : (
        <ul className="wa-attention-list">
          {ATTENTION.map((a) => (
            <li key={a.key} className={attention[a.key] ? 'has-items' : ''}>
              <span className={`wa-feed-icon is-${a.icon === 'nowa' ? 'failed' : a.icon}`}>
                <StatusIcon status={a.icon} size={16} />
              </span>
              <span className="wa-attention-text">
                <b>{a.label}</b>
                <span>
                  {a.key === 'fixable' && attention.autoRetrying ? `${attention.autoRetrying} retrying automatically · ` : ''}
                  {a.hint}
                </span>
              </span>
              <span className="wa-attention-count">{attention[a.key] || 0}</span>
              <button type="button" className="ai-link" disabled={!attention[a.key]} onClick={() => onShow(a.filter)}>
                Show
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


// ---- WATI connection: quota, status updates, PDF links ---------------------------

function CopyField({ value }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const el = document.createElement('textarea');
      el.value = value;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="wa-copy">
      <code title={value}>{value}</code>
      <button type="button" onClick={copy} aria-label="Copy webhook URL">
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function WatiCard({ info, now, readOnly = false }) {
  const [showSetup, setShowSetup] = useState(false);
  if (!info) return null;
  const { usage, poll, link, webhookPath } = info;
  const webhookUrl = `${link?.baseUrl || window.location.origin}${webhookPath}`;
  const paused = usage?.pausedUntil || poll?.pausedUntil;
  const hooked = poll?.webhook?.active;
  const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

  return (
    <section className="viz-card wa-wati">
      <header className="viz-card-head">
        <div>
          <h3>WATI connection</h3>
          <p>Every WATI API call, sends included, uses the account&apos;s monthly quota. The EMR&apos;s own messages share it too.</p>
        </div>
      </header>
      <div className="wa-wati-grid">
        <div className={`wa-wati-item ${paused ? 'is-bad' : 'is-ok'}`}>
          <span className="wa-wati-icon">{paused ? <AlertIcon size={16} /> : <CheckIcon size={16} />}</span>
          <div>
            <b>API calls from this app</b>
            <span>
              Today {fmt(usage?.today?.total)} ({fmt(usage?.today?.send)} sends · {fmt(usage?.today?.status)}/{fmt(usage?.statusChecksPerDay)} status checks)
            </span>
            <span>
              Automatic retries today: {fmt(usage?.today?.retry)}/{fmt(usage?.retriesPerDay)}
            </span>
            <span>This month {fmt(usage?.month?.total)}{usage?.month?.rateLimited ? ` · ${fmt(usage.month.rateLimited)} refused (429)` : ''}</span>
            {paused && (
              <span className="wa-wati-warn">
                WATI is refusing calls (usage limit). Status checks and automatic retries resume at {formatTime(paused, false)}; failed sends retry by themselves.
              </span>
            )}
          </div>
        </div>

        <div className={`wa-wati-item ${hooked ? 'is-ok' : 'is-warn'}`}>
          <span className="wa-wati-icon">{hooked ? <CheckIcon size={16} /> : <AlertIcon size={16} />}</span>
          <div>
            <b>Delivered / read updates</b>
            {hooked ? (
              <span>WATI webhook connected: last event {timeAgo(poll.webhook.lastEventAt, now)}. No status checks needed.</span>
            ) : (
              <span>
                Webhook not connected, so WATI is asked instead, 3 times per message and at most {fmt(poll?.dailyChecks)} calls a day.
                {poll?.enabled === false && ' (Scheduled checks are turned off.)'}
              </span>
            )}
            {!readOnly && (
              <button type="button" className="ai-link" onClick={() => setShowSetup((v) => !v)}>
                {showSetup ? 'Hide webhook setup' : hooked ? 'Webhook URL' : 'Connect the webhook (free, instant ticks)'}
              </button>
            )}
          </div>
        </div>

        <div className={`wa-wati-item ${link?.https ? 'is-ok' : 'is-warn'}`}>
          <span className="wa-wati-icon">{link?.https ? <CheckIcon size={16} /> : <AlertIcon size={16} />}</span>
          <div>
            <b>PDF links</b>
            {link?.https ? (
              <span>
                Secure links through {link.baseUrl.replace(/^https:\/\//, '')}, valid {link.days} day{link.days === 1 ? '' : 's'}. PDFs open inside WATI&apos;s inbox.
              </span>
            ) : (
              <span>
                Plain http links, valid {link?.days} day{link?.days === 1 ? '' : 's'}. Patients get the PDF, but WATI&apos;s https inbox can&apos;t show it (&ldquo;This plugin is not supported&rdquo;). Setting up HTTPS fixes that.
              </span>
            )}
          </div>
        </div>
      </div>

      {showSetup && (
        <div className="wa-wati-setup">
          <ol>
            <li>In WATI, open <b>Connectors → Webhooks</b> and click <b>Add Webhook</b>.</li>
            <li>
              Paste this URL:
              <CopyField value={webhookUrl} />
            </li>
            <li>
              Set status <b>Enabled</b> and tick <b>Template Message Sent</b>, <b>Delivered</b>, <b>Read</b>, <b>Replied</b> and <b>Failed</b>. Save.
            </li>
            <li>Send any report. This card turns green on the first event, and status checks stop by themselves.</li>
          </ol>
          {!webhookUrl.startsWith('https://') && <p className="wa-wati-note">If WATI asks for an https address, set up HTTPS first; the URL above then changes to https.</p>}
          <p className="wa-wati-note">Keep this URL private: anyone who has it can post status updates.</p>
        </div>
      )}
    </section>
  );
}

// ---- the dashboard ------------------------------------------------------------

const BASIS_KEY = 'wa-monitor-basis';
function savedBasis() {
  try {
    return localStorage.getItem(BASIS_KEY) === 'sent' ? 'sent' : 'report';
  } catch {
    return 'report';
  }
}

export default function AdminDashboard({ readOnly = false, navRequest, canExport = true }) {
  const [preset, setPreset] = useState('yesterday');
  // "Dates by": the patient's report (discharge) date, or when the message was sent.
  const [basis, setBasis] = useState(savedBasis);
  // Optional time of day, India time: from `from` at this time to `to` at that time.
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [custom, setCustom] = useState(() => presetRange('yesterday'));
  const [statuses, setStatuses] = useState([]);
  const [docFilter, setDocFilter] = useState('');
  const [trigger, setTrigger] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [tableView, setTableView] = useState('patients'); // 'patients' | 'messages'
  const [patients, setPatients] = useState(null);
  const [exporting, setExporting] = useState('');
  const [exportNote, setExportNote] = useState('');

  const [summary, setSummary] = useState(null);
  const [insights, setInsights] = useState(null);
  const tableRef = useRef(null);
  const [messages, setMessages] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [openId, setOpenId] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState('');
  const [wati, setWati] = useState(null);

  const seenEvents = useRef(new Set());
  const [freshEvents, setFreshEvents] = useState(new Set());
  const lastStatus = useRef(new Map());
  const [changedRows, setChangedRows] = useState(new Set());

  const range = preset === 'custom' ? custom : presetRange(preset);
  const params = useMemo(
    () => ({ from: range.from, to: range.to, basis, fromTime, toTime, status: statuses, document: docFilter, trigger, q }),
    [range.from, range.to, basis, fromTime, toTime, statuses, docFilter, trigger, q],
  );

  // "Open in WhatsApp Monitor" from Ask AI: take over its filters.
  useEffect(() => {
    const m = navRequest?.view === 'admin' ? navRequest.monitor : null;
    if (!m) return;
    if (m.from && m.to) {
      setPreset('custom');
      setCustom({ from: m.from, to: m.to });
    }
    if (m.basis) setBasis(m.basis === 'sent' ? 'sent' : 'report');
    setFromTime(m.fromTime || '');
    setToTime(m.toTime || '');
    setStatuses(m.status ? [m.status] : []);
    setDocFilter(m.document || '');
    setTrigger(m.trigger || '');
    setSearch(m.q || '');
    if (m.tableView) setTableView(m.tableView === 'messages' ? 'messages' : 'patients');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navRequest?.id]);

  // Audit log: the filters used (after they settle).
  const firstParams = useRef(true);
  useEffect(() => {
    if (firstParams.current) {
      firstParams.current = false;
      return undefined;
    }
    const t = setTimeout(() => {
      const parts = [
        `${params.from === params.to ? params.from : `${params.from} to ${params.to}`}${params.fromTime || params.toTime ? ` ${params.fromTime || '00:00'}–${params.toTime || '23:59'}` : ''}`,
        `by ${params.basis === 'sent' ? 'sent' : 'report'} date`,
        params.status?.length ? `status ${params.status.join(',')}` : '',
        params.document && `document ${params.document}`,
        params.trigger && `trigger ${params.trigger}`,
        params.q && `search “${params.q}”`,
      ].filter(Boolean);
      track('filter_change', { screen: 'admin', details: { summary: parts.join(' · ') } });
    }, 2000);
    return () => clearTimeout(t);
  }, [params]);

  function chooseBasis(next) {
    setBasis(next);
    try {
      localStorage.setItem(BASIS_KEY, next);
    } catch {
      // private window — the choice just isn't remembered
    }
  }

  // Debounced search box
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setPage(1), [params, tableView]);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const list = tableView === 'patients' ? fetchWhatsappPatients : fetchWhatsappMessages;
        const [s, m, a, ins, w] = await Promise.all([
          fetchWhatsappSummary(params),
          list({ ...params, page, limit: PAGE_SIZE }),
          fetchWhatsappActivity(20),
          fetchWhatsappInsights(params),
          fetchWatiUsage().catch(() => null),
        ]);
        setSummary(s);
        setInsights(ins);
        if (w) setWati(w);
        if (tableView === 'patients') setPatients(m);
        else setMessages(m);

        // Highlight feed events and table rows that are new since the last refresh.
        const fresh = new Set();
        for (const e of a) {
          const key = `${e.id}-${e.status}-${e.at}`;
          if (seenEvents.current.size && !seenEvents.current.has(key)) fresh.add(key);
          seenEvents.current.add(key);
        }
        setFreshEvents(fresh);
        setActivity(a);
        const changed = new Set();
        for (const item of m.items) {
          const key = item.key || item.id;
          const prev = lastStatus.current.get(key);
          if (prev && prev !== item.status) changed.add(key);
          lastStatus.current.set(key, item.status);
        }
        setChangedRows(changed);
        setUpdatedAt(Date.now());
        setError('');
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [params, page, tableView],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Live: refresh quietly while the tab is visible; tick the "updated" clock.
  useEffect(() => {
    const refresh = setInterval(() => {
      if (!document.hidden) load(true);
    }, LIVE_REFRESH_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(refresh);
      clearInterval(clock);
    };
  }, [load]);

  async function checkWati() {
    setChecking(true);
    try {
      const { poll } = await refreshWhatsappStatuses();
      setCheckNote(
        poll?.skipped ||
          (poll?.error ? `WATI: ${poll.error}` : `Checked ${poll?.checked || 0} message${poll?.checked === 1 ? '' : 's'}, ${poll?.updated || 0} updated`),
      );
      setTimeout(() => setCheckNote(''), 8000);
      await load(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  function toggleStatus(s) {
    setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  // "Needs attention → Show": filter the message list to those and scroll to it.
  function showAttention(filter) {
    setStatuses([filter]);
    setTableView('messages');
    setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  }

  const granularity = summary?.range?.granularity || 'day';
  const formatBucket = formatBucketFactory(granularity);
  const series = summary?.series || [];
  const trendOf = (keys) => series.map((b) => keys.reduce((sum, k) => sum + (b[k] || 0), 0));
  const counts = summary?.counts || {};
  const funnel = summary?.funnel || {};
  const listData = tableView === 'patients' ? patients : messages;
  const totalPages = listData ? Math.max(1, Math.ceil(listData.total / PAGE_SIZE)) : 1;

  async function exportAs(format) {
    setExporting(format);
    setExportNote('');
    try {
      setExportNote(`Downloaded ${await downloadWhatsappExport(params, tableView, format)}`);
    } catch (err) {
      setExportNote(err.message);
    } finally {
      setExporting('');
    }
  }

  const funnelSteps = [
    { label: 'Triggered', value: funnel.triggered || 0, color: 'var(--st-funnel-0)' },
    { label: 'Accepted by WATI', value: funnel.sent || 0, color: 'var(--st-sent)' },
    { label: 'Delivered', value: funnel.delivered || 0, color: 'var(--st-delivered)' },
    { label: 'Read', value: funnel.read || 0, color: 'var(--st-read)' },
  ].map((s) => ({ ...s, note: funnel.triggered ? `${Math.round((s.value / funnel.triggered) * 100)}%` : '' }));

  const byDocument = Object.entries(summary?.byDocument || {})
    .map(([k, v]) => ({ label: DOCUMENT_LABEL[k] || k, value: v }))
    .sort((a, b) => b.value - a.value);
  const prev = insights?.previous;
  const prevLabel = prev ? `vs ${prev.from === prev.to ? dmy(prev.from) : `${dmy(prev.from)} – ${dmy(prev.to)}`}` : '';
  const triggerRows = (insights?.byTrigger || [])
    .map((t) => ({ label: TRIGGER_LABEL[t.trigger] || t.trigger, ...t }))
    .sort((a, b) => STATUS_ORDER.reduce((n, k) => n + (b[k] || 0), 0) - STATUS_ORDER.reduce((n, k) => n + (a[k] || 0), 0));
  const departmentRows = (insights?.departments || []).map((d) => ({
    label: d.department,
    read: d.read,
    delivered: d.delivered - d.read,
    sent: Math.max(0, d.total - d.delivered - d.failed),
    failed: d.failed,
    readRate: d.delivered ? d.read / d.delivered : null,
  }));
  const readHours = (insights?.readHours || []).map((value, h) => ({ label: String(h), value }));
  const busiest = readHours.reduce((best, h) => (h.value > (best?.value || 0) ? h : best), null);
  const hourLabel = (h, short) => {
    const n = Number(h);
    const fmt = (x) => `${((x + 11) % 12) + 1}${x < 12 ? 'am' : 'pm'}`;
    return short ? fmt(n).replace(/(am|pm)/, '') : `${fmt(n)} – ${fmt((n + 1) % 24)}`;
  };
  const RATE_SERIES = [
    { key: 'deliveredRate', label: 'Delivered (of sent)', color: 'var(--st-delivered)' },
    { key: 'readRate', label: 'Read (of delivered)', color: 'var(--st-read)' },
  ];
  // "Status by trigger" counts every failure together (one "Failed" bar).
  const HBAR_SERIES = SERIES.filter((x) => !['pending', 'nowa'].includes(x.key)).map((x) => (x.key === 'failed' ? { ...x, label: 'Failed' } : x));

  return (
    <div className="wa-page">
      <header className="wa-hero">
        <div className="wa-hero-icon">
          <WhatsAppIcon size={24} />
        </div>
        <div className="wa-hero-text">
          <h2>WhatsApp Monitor</h2>
          <p>Every report sent on WhatsApp — delivered, read, pending or failed.</p>
        </div>
        <div className="wa-live">
          <span className={`wa-live-dot ${loading ? 'is-busy' : ''}`} />
          <span>
            Live · updated {timeAgo(updatedAt, now) || '…'}
            {checkNote ? (
              <span className="wa-live-sub"> · {checkNote}</span>
            ) : summary?.poll?.pausedUntil ? (
              <span className="wa-live-sub wa-live-paused"> · WATI usage limit reached, paused until {formatTime(summary.poll.pausedUntil, false)}</span>
            ) : summary?.poll?.webhook?.active ? (
              <span className="wa-live-sub"> · WATI webhook {timeAgo(summary.poll.webhook.lastEventAt, now)}</span>
            ) : (
              summary?.poll?.at && <span className="wa-live-sub"> · WATI checked {timeAgo(summary.poll.at, now)}</span>
            )}
          </span>
          {!readOnly && (
          <button type="button" className="wa-live-btn" onClick={checkWati} disabled={checking} title="Ask WATI for the latest delivery and read status now">
            <RefreshIcon size={15} spinning={checking} />
            {checking ? 'Checking…' : 'Check WATI now'}
          </button>
          )}
        </div>
      </header>

      {/* One filter row: scopes every tile, chart and the table below. */}
      <div className="wa-filters">
        <div className="wa-date-row">
        <div className="wa-presets" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className={preset === p.id ? 'is-on' : ''} onClick={() => setPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="wa-basis" role="radiogroup" aria-label="Dates by">
          <span>Dates by</span>
          <button
            type="button"
            role="radio"
            aria-checked={basis === 'report'}
            className={basis === 'report' ? 'is-on' : ''}
            onClick={() => chooseBasis('report')}
            title="The patient's discharge date — the date the reports are filed under. Today = today's patients only."
          >
            Report date
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={basis === 'sent'}
            className={basis === 'sent' ? 'is-on' : ''}
            onClick={() => chooseBasis('sent')}
            title="When the WhatsApp message went out — includes earlier patients' reports sent or re-sent in this period."
          >
            Sent date
          </button>
        </div>
        <div className="wa-time" role="group" aria-label="Time of day">
          <span>Time</span>
          <input type="time" value={fromTime} onChange={(e) => setFromTime(e.target.value)} aria-label="From time" />
          <span>to</span>
          <input type="time" value={toTime} onChange={(e) => setToTime(e.target.value)} aria-label="To time" />
          {(fromTime || toTime) && (
            <button
              type="button"
              className="wa-time-clear"
              onClick={() => {
                setFromTime('');
                setToTime('');
              }}
              aria-label="Clear time"
              title="All day"
            >
              ×
            </button>
          )}
        </div>
        </div>
        {preset === 'custom' && (
          <div className="wa-custom">
            <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} aria-label="From" />
            <span>to</span>
            <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} aria-label="To" />
          </div>
        )}
        <div className="wa-filter-row">
          <div className="wa-status-chips" role="group" aria-label="Status">
            {CHIP_ORDER.map((s) => (
                <button key={s} type="button" className={`wa-chip ${statuses.includes(s) ? 'is-on' : ''}`} onClick={() => toggleStatus(s)} aria-pressed={statuses.includes(s)}>
                  <StatusIcon status={s} size={14} />
                  {STATUS[s].label}
                  <span className="wa-chip-count">{s === 'nowa' ? summary?.notOnWhatsApp?.messages ?? 0 : s === 'failed' ? summary?.failedToSend ?? 0 : counts[s] ?? 0}</span>
                </button>
              ))}
            {statuses
              .filter((st) => SPECIAL_FILTER_LABEL[st])
              .map((st) => (
                <button key={st} type="button" className="wa-chip is-on" onClick={() => toggleStatus(st)} title="Remove this filter">
                  {SPECIAL_FILTER_LABEL[st]} ×
                </button>
              ))}
          </div>
          <select value={docFilter} onChange={(e) => setDocFilter(e.target.value)} aria-label="Document">
            <option value="">All documents</option>
            {Object.entries(DOCUMENT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value)} aria-label="Trigger">
            <option value="">All triggers</option>
            {Object.entries(TRIGGER_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <label className="wa-search">
            <SearchIcon size={15} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Patient, IP, number or staff" />
          </label>
          {(statuses.length > 0 || docFilter || trigger || search || fromTime || toTime) && (
            <button
              type="button"
              className="wa-clear"
              onClick={() => {
                setStatuses([]);
                setDocFilter('');
                setTrigger('');
                setSearch('');
                setFromTime('');
                setToTime('');
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <div className="wa-range-note">
          {basis === 'report' ? 'Patients discharged ' : 'Messages sent '}
          <b>
            {range.from === range.to ? dmy(range.from) : `${dmy(range.from)} to ${dmy(range.to)}`}
            {(fromTime || toTime) && `, ${fromTime || '00:00'}–${toTime || '23:59'}`}
          </b>
          {summary &&
            (basis === 'report'
              ? ` · ${summary.patients} patient${summary.patients === 1 ? '' : 's'} · ${summary.total} message${summary.total === 1 ? '' : 's'}`
              : ` · ${summary.total} message${summary.total === 1 ? '' : 's'}${summary.patients ? ` · ${summary.patients} patient${summary.patients === 1 ? '' : 's'}` : ''}`)}
        </div>
      </div>

      {error && (
        <div className="lock-error wa-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className={`wa-body ${loading && summary ? 'is-refetching' : ''}`}>
        <div className="wa-kpis">
          <StatTile
            label="Messages"
            value={summary?.total}
            trend={trendOf(STATUS_ORDER)}
            sub={summary?.patients ? `${summary.patients} patient${summary.patients === 1 ? '' : 's'}` : 'In this range'}
            delta={prev && <Delta current={summary?.total} previous={prev.total} label={prevLabel} />}
          />
          <StatTile
            label="Delivered"
            icon={<StatusIcon status="delivered" size={15} />}
            value={funnel.delivered}
            sub={`${pct(summary?.rates?.delivered)} of sent · avg ${formatDuration(summary?.avgSeconds?.toDeliver)}`}
            trend={trendOf(['delivered', 'read'])}
            delta={prev && <Delta current={funnel.delivered} previous={prev.delivered} label={prevLabel} />}
          />
          <StatTile
            label="Read"
            icon={<StatusIcon status="read" size={15} />}
            value={counts.read}
            sub={`${pct(summary?.rates?.read)} of delivered · avg ${formatDuration(summary?.avgSeconds?.toRead)}`}
            trend={trendOf(['read'])}
            delta={prev && <Delta current={counts.read} previous={prev.read} label={prevLabel} />}
          />
          <StatTile label="Pending" icon={<StatusIcon status="pending" size={15} />} value={counts.pending} sub="Waiting for WATI" tone={counts.pending ? 'warning' : undefined} />
          <StatTile
            label="Failed to send"
            icon={<StatusIcon status="failed" size={15} />}
            value={summary?.failedToSend}
            sub={`${summary?.retrying ? `${summary.retrying} retrying · ` : ''}every ${summary?.retryPolicy?.hours || 6} h for ${summary?.retryPolicy?.days || 3} days`}
            tone={summary?.failedToSend ? 'critical' : undefined}
            trend={trendOf(['failed'])}
          />
          <StatTile
            label="Not on WhatsApp"
            icon={<StatusIcon status="nowa" size={15} />}
            value={summary?.notOnWhatsApp?.messages}
            sub={`${summary?.notOnWhatsApp?.numbers || 0} number${summary?.notOnWhatsApp?.numbers === 1 ? '' : 's'} · retried every ${summary?.retryPolicy?.hours || 6} h for ${summary?.retryPolicy?.days || 3} days`}
            tone={summary?.notOnWhatsApp?.messages ? 'critical' : undefined}
            trend={trendOf(['nowa'])}
          />
        </div>

        <div className="wa-grid">
          <WatiCard info={wati} now={now} readOnly={readOnly} />
          <CoverageCard coverage={insights?.coverage} liveEnabled={insights?.liveEnabled} range={range} />
          <AttentionCard attention={insights?.attention} onShow={showAttention} />

          <ChartCard
            className="wa-span-2"
            title="Messages over time"
            subtitle={granularity === 'hour' ? 'By hour, hospital time' : 'By day'}
            legend={SERIES.map((s) => (
              <LegendItem key={s.key} color={s.color} label={s.label} />
            ))}
            table={
              <table className="viz-table">
                <thead>
                  <tr>
                    <th>{granularity === 'hour' ? 'Hour' : 'Date'}</th>
                    {SERIES.map((s) => (
                      <th key={s.key}>{s.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {series.map((b) => (
                    <tr key={b.bucket}>
                      <td>{formatBucket(b.bucket)}</td>
                      {SERIES.map((s) => (
                        <td key={s.key}>{b[s.key] || 0}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          >
            {series.length ? <StackedColumns data={series} series={SERIES} formatBucket={formatBucket} /> : <div className="viz-empty">No messages in this range</div>}
          </ChartCard>

          <section className="viz-card wa-feed">
            <header className="viz-card-head">
              <div>
                <h3>Live activity</h3>
                <p>Latest status changes, all dates</p>
              </div>
              <span className="wa-live-dot" aria-hidden="true" />
            </header>
            <ul className="wa-feed-list">
              {activity.length === 0 && <li className="viz-empty">No activity yet</li>}
              {activity.map((e) => {
                const key = `${e.id}-${e.status}-${e.at}`;
                return (
                  <li key={key} className={freshEvents.has(key) ? 'is-new' : ''}>
                    <button type="button" onClick={() => setOpenId(e.id)}>
                      <span className={`wa-feed-icon is-${e.status}`}>
                        <StatusIcon status={e.status === 'failed' && e.notOnWhatsApp ? 'nowa' : e.status} size={16} />
                      </span>
                      <span className="wa-feed-text">
                        <b>{e.status === 'failed' && e.notOnWhatsApp ? 'Not on WhatsApp' : STATUS[e.status]?.label || e.status}</b> · {e.documentLabel || 'Message'}
                        <span className="wa-feed-sub">{e.patientName || formatNumber(e.toNumber)}</span>
                      </span>
                      <span className="wa-feed-time">{timeAgo(e.at, now)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <ChartCard
            className="wa-span-2"
            title="Delivery & read rate"
            subtitle={
              insights?.trendRange && insights.trendRange.from !== range.from
                ? `Last 14 days (${dmy(insights.trendRange.from)} – ${dmy(insights.trendRange.to)}) — reached the phone, and opened`
                : 'Share of sent messages that reached the phone, and of those, how many were opened'
            }
            legend={RATE_SERIES.map((s) => (
              <LegendItem key={s.key} color={s.color} label={s.label} shape="line" />
            ))}
            table={
              <table className="viz-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Messages</th>
                    {RATE_SERIES.map((s) => (
                      <th key={s.key}>{s.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(insights?.trend || []).map((d) => (
                    <tr key={d.bucket}>
                      <td>{dmy(d.bucket)}</td>
                      <td>{d.total}</td>
                      {RATE_SERIES.map((s) => (
                        <td key={s.key}>{pct(d[s.key])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          >
            {insights?.trend?.length ? (
              <RateLines data={insights.trend} series={RATE_SERIES} formatBucket={formatBucketFactory('day')} />
            ) : (
              <div className="viz-empty">No messages in this range</div>
            )}
          </ChartCard>

          <ChartCard
            title="Delivery funnel"
            subtitle="Share of triggered messages reaching each step"
            table={
              <table className="viz-table">
                <tbody>
                  {funnelSteps.map((s) => (
                    <tr key={s.label}>
                      <td>{s.label}</td>
                      <td>{s.value}</td>
                      <td>{s.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          >
            <HBars items={funnelSteps} max={funnel.triggered || 1} />
          </ChartCard>

          <ChartCard
            title="When patients open reports"
            subtitle={busiest?.value ? `Busiest: ${hourLabel(busiest.label)} (hospital time)` : 'Hour of day the message was read'}
            table={
              <table className="viz-table">
                <tbody>
                  {readHours.map((h) => (
                    <tr key={h.label}>
                      <td>{hourLabel(h.label)}</td>
                      <td>{h.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          >
            {readHours.some((h) => h.value) ? (
              <Columns data={readHours} color="var(--st-read)" valueLabel="read" formatLabel={hourLabel} labelEvery={3} highlightMax />
            ) : (
              <div className="viz-empty">No read times recorded yet</div>
            )}
          </ChartCard>

          <ChartCard
            title="How long until read"
            subtitle="From sending to the blue ticks"
            table={
              <table className="viz-table">
                <tbody>
                  {(insights?.timeToRead || []).map((b) => (
                    <tr key={b.label}>
                      <td>{b.label}</td>
                      <td>{b.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          >
            {insights?.timeToRead?.some((b) => b.value) ? (
              <Columns data={insights.timeToRead} color="var(--st-read)" valueLabel="messages" />
            ) : (
              <div className="viz-empty">No read times recorded yet</div>
            )}
          </ChartCard>

          <ChartCard
            title="Why messages fail"
            subtitle={counts.failed ? `${counts.failed} failed in this range` : 'No failures in this range'}
            table={
              <table className="viz-table">
                <tbody>
                  {(insights?.failureReasons || []).map((r) => (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td>{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          >
            {insights?.failureReasons?.length ? (
              <HBars items={insights.failureReasons} color="var(--st-failed)" />
            ) : (
              <div className="wa-allclear is-compact">
                <StatusIcon status="read" size={20} />
                <div>
                  <b>No failures</b>
                  <span>Every message reached WATI.</span>
                </div>
              </div>
            )}
          </ChartCard>

          <ChartCard
            className="wa-span-2"
            title="Status by trigger"
            subtitle="Automatic sends vs manual clicks vs shares — and how each turned out"
            legend={HBAR_SERIES.map((s) => (
              <LegendItem key={s.key} color={s.color} label={s.label} />
            ))}
            table={
              <table className="viz-table">
                <thead>
                  <tr>
                    <th>Trigger</th>
                    {SERIES.map((s) => (
                      <th key={s.key}>{s.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {triggerRows.map((t) => (
                    <tr key={t.label}>
                      <td>{t.label}</td>
                      {SERIES.map((s) => (
                        <td key={s.key}>{t[s.key]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          >
            {triggerRows.length ? <StackedHBars rows={triggerRows} series={SERIES} /> : <div className="viz-empty">—</div>}
          </ChartCard>

          <ChartCard
            title="By document"
            table={
              <table className="viz-table">
                <tbody>
                  {byDocument.map((d) => (
                    <tr key={d.label}>
                      <td>{d.label}</td>
                      <td>{d.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          >
            {byDocument.length ? <HBars items={byDocument} /> : <div className="viz-empty">—</div>}
          </ChartCard>

          <ChartCard
            className="wa-span-2"
            title="By department"
            subtitle="Which departments' patients read their reports"
            legend={HBAR_SERIES.map((s) => (
              <LegendItem key={s.key} color={s.color} label={s.label} />
            ))}
            table={
              <table className="viz-table">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th>Read</th>
                    <th>Delivered</th>
                    <th>Sent</th>
                    <th>Failed</th>
                    <th>Read rate</th>
                  </tr>
                </thead>
                <tbody>
                  {departmentRows.map((d) => (
                    <tr key={d.label}>
                      <td>{d.label}</td>
                      <td>{d.read}</td>
                      <td>{d.delivered}</td>
                      <td>{d.sent}</td>
                      <td>{d.failed}</td>
                      <td>{pct(d.readRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          >
            {departmentRows.length ? <StackedHBars rows={departmentRows} series={HBAR_SERIES} /> : <div className="viz-empty">No department recorded (imported history only)</div>}
          </ChartCard>

          <ChartCard
            title="Who clicked"
            subtitle="Manual clicks and shares by staff"
            table={
              <table className="viz-table">
                <tbody>
                  {(insights?.staff || []).map((u) => (
                    <tr key={u.user}>
                      <td>{u.user}</td>
                      <td>{u.total}</td>
                      <td>{u.failed} failed</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          >
            {insights?.staff?.length ? (
              <HBars items={insights.staff.map((u) => ({ label: u.user, value: u.total, note: u.failed ? `${u.failed} failed` : '' }))} />
            ) : (
              <div className="viz-empty">No manual clicks in this range</div>
            )}
          </ChartCard>

        </div>

        <section className="viz-card wa-table-card" ref={tableRef}>
          <header className="viz-card-head wa-table-head">
            <div>
              <h3>{tableView === 'patients' ? 'Patients' : 'Messages'}</h3>
              <p>
                {listData
                  ? tableView === 'patients'
                    ? `${listData.total} patient${listData.total === 1 ? '' : 's'} — each report shown separately; open a row for every message`
                    : `${listData.total} message${listData.total === 1 ? '' : 's'} — click a row for its full timeline`
                  : 'Loading…'}
              </p>
            </div>
            <div className="wa-table-tools">
              <div className="viz-toggle" role="group" aria-label="Group by">
                <button type="button" className={tableView === 'patients' ? 'is-on' : ''} onClick={() => setTableView('patients')}>
                  Patients
                </button>
                <button type="button" className={tableView === 'messages' ? 'is-on' : ''} onClick={() => setTableView('messages')}>
                  Messages
                </button>
              </div>
              {canExport && (
                <div className="wa-exports" role="group" aria-label="Export">
                  <span>Export</span>
                  {EXPORTS.map((x) => (
                    <button
                      key={x.format}
                      type="button"
                      className={`xs-chip is-${x.format}`}
                      onClick={() => exportAs(x.format)}
                      disabled={Boolean(exporting)}
                      title={`Download this ${tableView === 'patients' ? 'patient-wise' : 'message'} view as ${x.label}`}
                    >
                      {exporting === x.format ? <span className="xs-spin" /> : <span className="xs-ext">{x.ext}</span>}
                      {x.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </header>
          {exportNote && <div className="xs-note is-ok wa-export-note">{exportNote}</div>}
          <div className="wa-table-wrap">
            {tableView === 'patients' ? (
              <PatientsTable patients={patients?.items || []} onOpen={setOpenId} changed={changedRows} />
            ) : (
              <table className="wa-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Patient</th>
                    <th>Document</th>
                    <th>To</th>
                    <th>Triggered</th>
                    <th>Sent</th>
                    <th>Delivered</th>
                    <th>Read</th>
                  </tr>
                </thead>
                <tbody>
                  {messages?.items.length === 0 && (
                    <tr>
                      <td colSpan={8} className="viz-empty">
                        No messages match these filters
                      </td>
                    </tr>
                  )}
                  {messages?.items.map((m) => (
                    <tr key={m.id} className={changedRows.has(m.id) ? 'is-changed' : ''} onClick={() => setOpenId(m.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpenId(m.id)}>
                      <td>
                        <StatusPill status={m.status} notOnWhatsApp={m.notOnWhatsApp} />
                      </td>
                      <td>
                        <div className="wa-cell-main">{m.patientName || '—'}</div>
                        <div className="wa-cell-sub">{m.ipNo || (m.imported ? 'Imported from WATI' : '')}</div>
                      </td>
                      <td>{m.documentLabel || DOCUMENT_LABEL[m.document]}</td>
                      <td className="wa-mono">
                        {formatNumber(m.toNumber)}
                        {m.status === 'failed' && m.notOnWhatsApp && <NoWhatsAppTag />}
                      </td>
                      <td>
                        <div className="wa-cell-main">{TRIGGER_LABEL[m.trigger] || m.trigger}</div>
                        <div className="wa-cell-sub">
                          {m.via ? `via ${VIA_LABEL[m.via] || m.via} · ` : ''}
                          {m.triggeredBy}
                        </div>
                      </td>
                      <td className="wa-time">{formatTime(m.acceptedAt || m.createdAt)}</td>
                      <td className="wa-time">{m.deliveredAt ? formatTime(m.deliveredAt) : m.imported && ['delivered', 'read'].includes(m.status) ? '✓' : '—'}</td>
                      <td className="wa-time">{m.readAt ? formatTime(m.readAt) : m.imported && m.status === 'read' ? '✓' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {listData && listData.total > PAGE_SIZE && (
            <div className="wa-pager">
              <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span>
                Page {page} of {totalPages}
              </span>
              <button type="button" className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          )}
        </section>
      </div>

      {openId && <MessageDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => load(true)} readOnly={readOnly} />}
    </div>
  );
}

