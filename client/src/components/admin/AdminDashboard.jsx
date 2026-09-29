import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchWhatsappActivity,
  fetchWhatsappMessage,
  fetchWhatsappMessages,
  fetchWhatsappSummary,
  refreshWhatsappStatuses,
} from '../../api/client';
import { CloseIcon, RefreshIcon, SearchIcon, WhatsAppIcon } from '../Icons';
import { ChartCard, HBars, LegendItem, StackedColumns, StatTile } from './Charts';

const LIVE_REFRESH_MS = 15_000;
const PAGE_SIZE = 20;

// Stack order bottom → top. Sent / delivered / read are one ordinal blue ramp
// (a message moves along it); pending and failed use the reserved status colours.
const STATUS = {
  read: { label: 'Read', color: 'var(--st-read)' },
  delivered: { label: 'Delivered', color: 'var(--st-delivered)' },
  sent: { label: 'Sent', color: 'var(--st-sent)' },
  pending: { label: 'Pending', color: 'var(--st-pending)' },
  failed: { label: 'Failed', color: 'var(--st-failed)' },
};
const STATUS_ORDER = ['read', 'delivered', 'sent', 'pending', 'failed'];
const SERIES = STATUS_ORDER.map((key) => ({ key, ...STATUS[key] }));
// Filter chips follow a message's life: pending → sent → delivered → read, or failed.
const CHIP_ORDER = ['pending', 'sent', 'delivered', 'read', 'failed'];

const DOCUMENT_LABEL = { lab: 'Lab report', summary: 'Discharge summary', lab_results: 'Lab results list', other: 'Other' };
const TRIGGER_LABEL = { auto: 'Automatic (live)', manual: 'Send button', share: 'Shared to a number', imported: 'Imported history' };
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

function StatusPill({ status }) {
  return (
    <span className={`wa-pill is-${status}`}>
      <StatusIcon status={status} size={15} />
      {STATUS[status]?.label || status}
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

function MessageDrawer({ id, onClose, onChanged }) {
  const [message, setMessage] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

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
              <StatusPill status={message.status} />
              <span className="wa-drawer-doc">{message.documentLabel || DOCUMENT_LABEL[message.document]}</span>
            </div>
            <Timeline message={message} />
            <dl className="wa-facts">
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
            <button type="button" className="btn btn-secondary wa-check" onClick={checkNow} disabled={checking}>
              <RefreshIcon size={15} spinning={checking} /> {checking ? 'Checking WATI…' : 'Check status now'}
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

// ---- the dashboard ------------------------------------------------------------

export default function AdminDashboard() {
  const [preset, setPreset] = useState('7d');
  const [custom, setCustom] = useState(() => presetRange('7d'));
  const [statuses, setStatuses] = useState([]);
  const [docFilter, setDocFilter] = useState('');
  const [trigger, setTrigger] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const [summary, setSummary] = useState(null);
  const [messages, setMessages] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [openId, setOpenId] = useState(null);
  const [checking, setChecking] = useState(false);

  const seenEvents = useRef(new Set());
  const [freshEvents, setFreshEvents] = useState(new Set());
  const lastStatus = useRef(new Map());
  const [changedRows, setChangedRows] = useState(new Set());

  const range = preset === 'custom' ? custom : presetRange(preset);
  const params = useMemo(
    () => ({ from: range.from, to: range.to, status: statuses, document: docFilter, trigger, q }),
    [range.from, range.to, statuses, docFilter, trigger, q],
  );

  // Debounced search box
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setPage(1), [params]);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const [s, m, a] = await Promise.all([
          fetchWhatsappSummary(params),
          fetchWhatsappMessages({ ...params, page, limit: PAGE_SIZE }),
          fetchWhatsappActivity(20),
        ]);
        setSummary(s);
        setMessages(m);

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
          const prev = lastStatus.current.get(item.id);
          if (prev && prev !== item.status) changed.add(item.id);
          lastStatus.current.set(item.id, item.status);
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
    [params, page],
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
      await refreshWhatsappStatuses();
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

  const granularity = summary?.range?.granularity || 'day';
  const formatBucket = formatBucketFactory(granularity);
  const series = summary?.series || [];
  const trendOf = (keys) => series.map((b) => keys.reduce((sum, k) => sum + (b[k] || 0), 0));
  const counts = summary?.counts || {};
  const funnel = summary?.funnel || {};
  const totalPages = messages ? Math.max(1, Math.ceil(messages.total / PAGE_SIZE)) : 1;

  const funnelSteps = [
    { label: 'Triggered', value: funnel.triggered || 0, color: 'var(--st-funnel-0)' },
    { label: 'Accepted by WATI', value: funnel.sent || 0, color: 'var(--st-sent)' },
    { label: 'Delivered', value: funnel.delivered || 0, color: 'var(--st-delivered)' },
    { label: 'Read', value: funnel.read || 0, color: 'var(--st-read)' },
  ].map((s) => ({ ...s, note: funnel.triggered ? `${Math.round((s.value / funnel.triggered) * 100)}%` : '' }));

  const byDocument = Object.entries(summary?.byDocument || {})
    .map(([k, v]) => ({ label: DOCUMENT_LABEL[k] || k, value: v }))
    .sort((a, b) => b.value - a.value);
  const byTrigger = Object.entries(summary?.byTrigger || {})
    .map(([k, v]) => ({ label: TRIGGER_LABEL[k] || k, value: v }))
    .sort((a, b) => b.value - a.value);

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
            {summary?.poll?.at && <span className="wa-live-sub"> · WATI checked {timeAgo(summary.poll.at, now)}</span>}
          </span>
          <button type="button" className="wa-live-btn" onClick={checkWati} disabled={checking} title="Ask WATI for the latest delivery and read status now">
            <RefreshIcon size={15} spinning={checking} />
            {checking ? 'Checking…' : 'Check WATI now'}
          </button>
        </div>
      </header>

      {/* One filter row: scopes every tile, chart and the table below. */}
      <div className="wa-filters">
        <div className="wa-presets" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className={preset === p.id ? 'is-on' : ''} onClick={() => setPreset(p.id)}>
              {p.label}
            </button>
          ))}
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
                  <span className="wa-chip-count">{counts[s] ?? 0}</span>
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
          {(statuses.length > 0 || docFilter || trigger || search) && (
            <button
              type="button"
              className="wa-clear"
              onClick={() => {
                setStatuses([]);
                setDocFilter('');
                setTrigger('');
                setSearch('');
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <div className="wa-range-note">
          {range.from === range.to ? dmy(range.from) : `${dmy(range.from)} to ${dmy(range.to)}`}
          {summary && ` · ${summary.total} message${summary.total === 1 ? '' : 's'}${summary.patients ? ` · ${summary.patients} patients` : ''}`}
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
          />
          <StatTile
            label="Delivered"
            icon={<StatusIcon status="delivered" size={15} />}
            value={funnel.delivered}
            sub={`${pct(summary?.rates?.delivered)} of sent · avg ${formatDuration(summary?.avgSeconds?.toDeliver)}`}
            trend={trendOf(['delivered', 'read'])}
          />
          <StatTile
            label="Read"
            icon={<StatusIcon status="read" size={15} />}
            value={counts.read}
            sub={`${pct(summary?.rates?.read)} of delivered · avg ${formatDuration(summary?.avgSeconds?.toRead)}`}
            trend={trendOf(['read'])}
          />
          <StatTile label="Pending" icon={<StatusIcon status="pending" size={15} />} value={counts.pending} sub="Waiting for WATI" tone={counts.pending ? 'warning' : undefined} />
          <StatTile
            label="Failed"
            icon={<StatusIcon status="failed" size={15} />}
            value={counts.failed}
            sub={`${pct(summary?.rates?.failed)} of all`}
            tone={counts.failed ? 'critical' : undefined}
            trend={trendOf(['failed'])}
          />
        </div>

        <div className="wa-grid">
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
                        <StatusIcon status={e.status} size={16} />
                      </span>
                      <span className="wa-feed-text">
                        <b>{STATUS[e.status]?.label || e.status}</b> · {e.documentLabel || 'Message'}
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
            title="By trigger"
            table={
              <table className="viz-table">
                <tbody>
                  {byTrigger.map((d) => (
                    <tr key={d.label}>
                      <td>{d.label}</td>
                      <td>{d.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          >
            {byTrigger.length ? <HBars items={byTrigger} /> : <div className="viz-empty">—</div>}
          </ChartCard>

        </div>

        <section className="viz-card wa-table-card">
          <header className="viz-card-head">
            <div>
              <h3>Messages</h3>
              <p>{messages ? `${messages.total} in this view — click a row for its full timeline` : 'Loading…'}</p>
            </div>
          </header>
          <div className="wa-table-wrap">
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
                      <StatusPill status={m.status} />
                    </td>
                    <td>
                      <div className="wa-cell-main">{m.patientName || '—'}</div>
                      <div className="wa-cell-sub">{m.ipNo || (m.imported ? 'Imported from WATI' : '')}</div>
                    </td>
                    <td>{m.documentLabel || DOCUMENT_LABEL[m.document]}</td>
                    <td className="wa-mono">{formatNumber(m.toNumber)}</td>
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
          </div>
          {messages && messages.total > PAGE_SIZE && (
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

      {openId && <MessageDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => load(true)} />}
    </div>
  );
}

