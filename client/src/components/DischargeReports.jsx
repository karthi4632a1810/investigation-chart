import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultDateOnly,
  fetchReportsForDate,
  fetchReportStatus,
  reportPdfUrl,
  reportSummaryPdfUrl,
  searchReports,
  sendReportWhatsApp,
  triggerReportRun,
} from '../api/client';
import {
  CalendarIcon,
  CardViewIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DoctorIcon,
  ExternalLinkIcon,
  FilePdfIcon,
  FilterIcon,
  InfoIcon,
  PhoneIcon,
  RefreshIcon,
  RotateCcwIcon,
  SearchIcon,
  TableViewIcon,
  UserIcon,
  WardIcon,
  WhatsAppIcon,
} from './Icons';
import Pagination from './Pagination';

const LIVE_REFRESH_MS = 20_000;

const EMPTY_FILTERS = {
  ipNo: '',
  regNo: '',
  reqNo: '',
  name: '',
  mobile: '',
  whatsapp: '',
  department: '',
  doctor: '',
  patientType: '',
  ward: '',
  createdUser: '',
  fromDate: '',
  toDate: '',
};

function formatCountdown(ms) {
  if (ms <= 0) return 'any moment now';
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatRelativeTime(isoString) {
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${minutes % 60}m ago`;
}

function adjustDateByDays(dateStr, days) {
  try {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      d.setDate(d.getDate() + days);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
  } catch {
    // fallback
  }
  return dateStr;
}

function getFormattedDate(daysOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysOffset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getHumanDate(dateStr) {
  if (!dateStr) return '';
  const today = getFormattedDate(0);
  const yesterday = getFormattedDate(1);
  if (dateStr === today) return 'Today';
  if (dateStr === yesterday) return 'Yesterday';
  try {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }
  } catch {
    // fallback
  }
  return dateStr;
}

function AutomationStatus({ status, onRunNow, running }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!status) return null;

  const checking = status.checkInProgress;
  const msToNext = status.nextCheckAt ? new Date(status.nextCheckAt).getTime() - now : null;
  const lastAgo = formatRelativeTime(status.lastCheckFinishedAt);
  const summary = status.lastSummary;

  return (
    <div className="automation-card modern-telemetry-card">
      <div className="automation-status-col">
        <div className={`automation-dot-ring ${checking ? 'checking' : 'idle'}`}>
          <div className="automation-dot-core" />
        </div>
        <div className="automation-meta-text">
          <div className="automation-headline">
            {checking ? (
              <span className="automation-checking-text">Syncing with hospital discharges now…</span>
            ) : msToNext !== null ? (
              <>
                Next automatic check in <span className="automation-timer-pill">{formatCountdown(msToNext)}</span>
              </>
            ) : (
              'Automation service initializing…'
            )}
          </div>
          {lastAgo && (
            <div className="automation-last-run">
              Last check completed {lastAgo}
            </div>
          )}
        </div>
      </div>

      {summary && (
        <div className="automation-stats-chips">
          {summary.found !== undefined && (
            <span className="stat-chip chip-found" title="Total discharged patients detected">
              <strong>{summary.found}</strong> found
            </span>
          )}
          {summary.generated !== undefined && summary.generated > 0 && (
            <span className="stat-chip chip-generated" title="Newly generated charts">
              <strong>+{summary.generated}</strong> generated
            </span>
          )}
          {summary.alreadyReported !== undefined && (
            <span className="stat-chip chip-existing" title="Reports already prepared">
              <strong>{summary.alreadyReported}</strong> ready
            </span>
          )}
          {summary.noLabData !== undefined && summary.noLabData > 0 && (
            <span
              className="stat-chip chip-nodata"
              title="No lab orders exist for this patient in the EMR — not a failure, checked once and won't be rechecked"
            >
              <strong>{summary.noLabData}</strong> no lab data
            </span>
          )}
          {summary.failed !== undefined && summary.failed > 0 && (
            <span className="stat-chip chip-failed" title="Failed to generate">
              <strong>{summary.failed}</strong> failed
            </span>
          )}
          {summary.summaryGenerated !== undefined && summary.summaryGenerated > 0 && (
            <span className="stat-chip chip-generated" title="Discharge summary documents fetched from the EMR">
              <strong>+{summary.summaryGenerated}</strong> summaries
            </span>
          )}
          {summary.summaryFailed !== undefined && summary.summaryFailed > 0 && (
            <span
              className="stat-chip chip-failed"
              title="Discharge summary document could not be fetched — will retry next check"
            >
              <strong>{summary.summaryFailed}</strong> summary issues
            </span>
          )}
        </div>
      )}

      <button
        type="button"
        className="btn btn-secondary btn-check-now"
        onClick={onRunNow}
        disabled={running || checking}
        title="Trigger an immediate check for new discharges"
      >
        <RefreshIcon spinning={running || checking} size={16} />
        <span>{running || checking ? 'Checking…' : 'Check Now'}</span>
      </button>
    </div>
  );
}

function CopyableChip({ value, label, className = '', onToast, iconOnly = false }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!value || value === '—') return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (onToast) onToast(`Copied ${label ? label + ' ' : ''}${value} to clipboard`);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // fallback
    }
  }

  if (!value) return <span className="text-muted">—</span>;

  return (
    <button
      type="button"
      className={`copyable-chip ${className} ${copied ? 'is-copied' : ''}`}
      onClick={handleCopy}
      title={copied ? 'Copied to clipboard!' : `Click to copy ${label ? label + ': ' : ''}${value}`}
      aria-label={`Copy ${label || ''} ${value}`}
    >
      {!iconOnly && <span className="copyable-text">{value}</span>}
      <span className="copyable-indicator" aria-hidden="true">
        {copied ? (
          <CheckIcon size={12} className="copy-icon-copied" />
        ) : (
          <CopyIcon size={11} className="copy-icon-idle" />
        )}
      </span>
      {copied && <span className="copy-bubble-tag">Copied!</span>}
    </button>
  );
}

function ToastNotification({ toast, onDismiss }) {
  if (!toast) return null;
  return (
    <div className="portal-toast-container no-print" role="status" aria-live="polite">
      <div className="portal-toast">
        <div className="toast-icon">
          <CheckIcon size={16} />
        </div>
        <div className="toast-message">{toast.message}</div>
        <button
          type="button"
          className="toast-dismiss-btn"
          onClick={onDismiss}
          aria-label="Dismiss notification"
        >
          ×
        </button>
      </div>
    </div>
  );
}

/** Self-contained so each row tracks its own send state independently. */
function SendWhatsAppButton({ date, ipNo, name, onToast }) {
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [error, setError] = useState('');

  async function handleClick(e) {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (status === 'sending') return;
    setStatus('sending');
    setError('');
    try {
      const result = await sendReportWhatsApp(date, ipNo);
      setStatus('sent');
      const docs = result.sent.map((d) => d.label).join(' + ');
      if (onToast) onToast(`WhatsApp sent to ${result.sentTo}: ${docs}`);
    } catch (err) {
      setStatus('error');
      setError(err.message);
    }
  }

  if (status === 'sent') {
    return (
      <span className="btn btn-whatsapp-sent btn-icon-only" title="Sent on WhatsApp" aria-label="Sent on WhatsApp">
        <WhatsAppIcon size={15} />
      </span>
    );
  }

  const label =
    status === 'sending'
      ? 'Sending lab report and discharge summary…'
      : status === 'error'
        ? `Failed: ${error} — click to retry`
        : `Send lab report + discharge summary to ${name} via WhatsApp`;

  return (
    <button
      type="button"
      className="btn btn-send-whatsapp btn-icon-only"
      onClick={handleClick}
      disabled={status === 'sending'}
      title={label}
      aria-label={label}
    >
      <WhatsAppIcon size={15} />
    </button>
  );
}


function ReportsTable({ patients, dateColumn, getPdfUrl, getSummaryPdfUrl, onToast }) {
  if (!patients.length) return null;

  return (
    <div className="table-wrap modern-table-wrap">
      <table className="results modern-results-table">
        <thead>
          <tr>
            {dateColumn && <th>Discharge Date</th>}
            <th>IP Number</th>
            <th>Reg No (UHID)</th>
            <th>Patient Name</th>
            <th>Patient Type</th>
            <th>Department</th>
            <th>Doctor</th>
            <th>Ward</th>
            <th>Mobile</th>
            <th>Created By</th>
            <th>Lab Dates</th>
            <th className="th-action">Report</th>
          </tr>
        </thead>
        <tbody>
          {patients.map((p) => {
            const isCorporate = p.patientType?.toLowerCase().includes('corp');
            return (
              <tr key={`${p.date}-${p.ipNo}`} className="patient-row">
                {dateColumn && <td className="cell-date">{p.date}</td>}
                <td className="cell-ip">
                  <CopyableChip
                    value={p.ipNo}
                    label="IP"
                    className="code-chip code-chip-ip"
                    onToast={onToast}
                  />
                </td>
                <td className="cell-reg">
                  <CopyableChip
                    value={p.regNo}
                    label="UHID"
                    className="code-chip code-chip-reg"
                    onToast={onToast}
                  />
                </td>
                <td className="cell-name">
                  <div className="patient-name-box">
                    <span className="name-text">{p.name}</span>
                  </div>
                </td>
                <td className="cell-type">
                  <span className={`type-badge ${isCorporate ? 'type-corporate' : 'type-general'}`}>
                    {p.patientType || 'General'}
                  </span>
                </td>
                <td className="cell-dept">{p.department}</td>
                <td className="cell-doctor">
                  <div className="doctor-cell-content">
                    <DoctorIcon size={14} className="doctor-icon-dim" />
                    <span>{p.doctor}</span>
                  </div>
                </td>
                <td className="cell-ward">
                  <div className="ward-cell-content">
                    <WardIcon size={14} className="ward-icon-dim" />
                    <span>{p.ward}</span>
                  </div>
                </td>
                <td className="cell-mobile">
                  {p.mobile ? (
                    <div className="mobile-interactive-wrap">
                      <a href={`tel:+91${p.mobile}`} className="tel-link" title={`Call +91 ${p.mobile}`}>
                        <PhoneIcon size={12} />
                        <span>+91 {p.mobile}</span>
                      </a>
                      <CopyableChip
                        value={`+91${p.mobile}`}
                        label="Mobile"
                        className="mini-copy-chip"
                        onToast={onToast}
                        iconOnly
                      />
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="cell-user">
                  <span className="created-user-text" title={p.createdUser}>
                    {p.createdUser}
                  </span>
                </td>
                <td className="cell-dates">
                  {p.dateCount !== undefined ? (
                    <span className="dates-pill dates-pill-ready" title={`${p.dateCount} dates with lab orders`}>
                      {p.dateCount} date{p.dateCount === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="text-muted" title="No lab orders found for this patient">
                      no lab data
                    </span>
                  )}
                </td>
                <td className="cell-action">
                  <div className="action-btn-group">
                    {p.dateCount !== undefined && (
                      <a
                        className="btn btn-view-pdf"
                        href={getPdfUrl(p)}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open investigation chart PDF for ${p.name}`}
                      >
                        <FilePdfIcon size={15} />
                        <span>Lab Report</span>
                      </a>
                    )}
                    {p.hasSummary && p.summaryDataMissing ? (
                      <span className="btn btn-summary-missing" title={SUMMARY_NO_DATA_TITLE}>
                        No Summary
                      </span>
                    ) : p.hasSummary ? (
                      <a
                        className="btn btn-view-summary"
                        href={getSummaryPdfUrl(p)}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open discharge summary for ${p.name}`}
                      >
                        <FilePdfIcon size={15} />
                        <span>Summary</span>
                      </a>
                    ) : null}
                    {hasSendableDocument(p) && (
                      <SendWhatsAppButton
                        date={p.date}
                        ipNo={p.ipNo}
                        name={p.name}
                        onToast={onToast}
                      />
                    )}
                    {p.dateCount === undefined && !p.hasSummary && <span className="text-muted">—</span>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Honorifics the EMR prefixes onto names ("MR.", "BABY OF.") — skipped so the
// avatar shows the patient's own initials.
const NAME_TITLE_RE = /^(?:baby\s+of|mrs|mr|ms|miss|master|baby|dr|smt|shri|sri)\b\.?\s*/i;

function patientInitials(name) {
  const words = String(name || '')
    .replace(NAME_TITLE_RE, '')
    .split(/[^A-Za-z]+/)
    .filter(Boolean);
  return (words.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
}

const SUMMARY_NO_DATA_TITLE = 'The EMR returned no patient data for this discharge summary, so it is not shown or sent';

// A summary the EMR returned empty is never sent (see the send-whatsapp route).
function hasSendableDocument(p) {
  return p.dateCount !== undefined || (p.hasSummary && !p.summaryDataMissing);
}

// The name printed as "Prepared & Approved by" on the summary PDF. Records
// generated before that was stored fall back to the discharging doctor.
function summaryApprover(p) {
  return p.summaryApprovedBy || p.doctor || 'Treating Consultant';
}

function ReportsCards({ patients, dateColumn, getPdfUrl, getSummaryPdfUrl, onToast }) {
  if (!patients.length) return null;

  return (
    <div className="patient-cards-grid">
      {patients.map((p) => {
        const isCorporate = p.patientType?.toLowerCase().includes('corp');
        const hasLab = p.dateCount !== undefined;
        return (
          <article key={`${p.date}-${p.ipNo}`} className={`pcard ${isCorporate ? 'is-corporate' : ''}`}>
            <header className="pcard-head">
              <div className="pcard-avatar" aria-hidden="true">{patientInitials(p.name)}</div>
              <div className="pcard-title">
                <h3 className="pcard-name" title={p.name}>{p.name}</h3>
                <div className="pcard-tags">
                  <span className={`type-badge ${isCorporate ? 'type-corporate' : 'type-general'}`}>
                    {p.patientType || 'General'}
                  </span>
                  {hasLab ? (
                    <span className="pcard-tag is-ready" title={`${p.dateCount} dates with completed lab tests`}>
                      {p.dateCount} lab date{p.dateCount === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="pcard-tag" title="No laboratory test orders found in EMR">
                      No lab data
                    </span>
                  )}
                </div>
              </div>
            </header>

            <div className="pcard-ids">
              <div className="pcard-id">
                <span className="pcard-label">IP No</span>
                <CopyableChip value={p.ipNo} label="IP No" className="pcard-id-value is-ip" onToast={onToast} />
              </div>
              <div className="pcard-id">
                <span className="pcard-label" title="Registration number">UHID</span>
                <CopyableChip value={p.regNo} label="UHID" className="pcard-id-value" onToast={onToast} />
              </div>
            </div>

            <div className="pcard-dept">
              <span className="pcard-dept-icon" aria-hidden="true">
                <WardIcon size={15} />
              </span>
              <div className="pcard-dept-text">
                <div className="pcard-dept-name">{p.department || 'General'}</div>
                {p.ward && <div className="pcard-ward">{p.ward}</div>}
              </div>
            </div>

            <dl className="pcard-meta">
              <div className="pcard-row">
                <dt><DoctorIcon size={14} />Doctor</dt>
                <dd>{p.doctor || '—'}</dd>
              </div>
              <div className="pcard-row">
                <dt><PhoneIcon size={13} />Mobile</dt>
                <dd>
                  {p.mobile ? (
                    <span className="pcard-mobile">
                      <a href={`tel:+91${p.mobile}`} title={`Call +91 ${p.mobile}`}>+91 {p.mobile}</a>
                      <CopyableChip
                        value={`+91${p.mobile}`}
                        label="Mobile"
                        className="mini-copy-chip"
                        onToast={onToast}
                        iconOnly
                      />
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </dd>
              </div>
              <div className="pcard-row">
                <dt><UserIcon size={13} />Created by</dt>
                <dd className="pcard-mono">{p.createdUser || '—'}</dd>
              </div>
              <div className="pcard-row">
                <dt><CalendarIcon size={13} />Discharged</dt>
                <dd>{p.date ? (dateColumn ? p.date : getHumanDate(p.date)) : '—'}</dd>
              </div>
            </dl>

            <footer className="pcard-actions">
              {/* Always one line, whichever state, so every card in a row keeps the same height. */}
              {p.hasSummary && p.summaryDataMissing ? (
                <div className="pcard-status" title={SUMMARY_NO_DATA_TITLE}>
                  <span>Discharge summary unavailable</span>
                </div>
              ) : p.hasSummary ? (
                <div
                  className="pcard-status is-approved"
                  title={`Discharge summary prepared & approved by ${summaryApprover(p)}`}
                >
                  <CheckIcon size={13} />
                  <span>
                    Approved by <b>{summaryApprover(p)}</b>
                  </span>
                </div>
              ) : (
                <div className="pcard-status" title="Discharge summary not generated yet">
                  <span>Discharge summary pending</span>
                </div>
              )}
              <div className="pcard-buttons">
                {hasLab ? (
                  <a
                    className="btn btn-view-pdf pcard-btn"
                    href={getPdfUrl(p)}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open lab report for ${p.name}`}
                  >
                    <FilePdfIcon size={14} />
                    <span>Lab Report</span>
                  </a>
                ) : (
                  <span className="btn pcard-btn is-empty" title="No laboratory test orders found in EMR">
                    <span>No lab data</span>
                  </span>
                )}
                {p.hasSummary && p.summaryDataMissing ? (
                  <span className="btn pcard-btn btn-summary-missing" title={SUMMARY_NO_DATA_TITLE}>
                    <span>No Summary</span>
                  </span>
                ) : p.hasSummary ? (
                  <a
                    className="btn btn-view-summary pcard-btn"
                    href={getSummaryPdfUrl(p)}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open discharge summary for ${p.name}`}
                  >
                    <FilePdfIcon size={14} />
                    <span>Summary</span>
                  </a>
                ) : (
                  <span className="btn pcard-btn is-empty" title="Discharge summary not generated yet">
                    <span>No summary</span>
                  </span>
                )}
                {hasSendableDocument(p) && (
                  <SendWhatsAppButton date={p.date} ipNo={p.ipNo} name={p.name} onToast={onToast} />
                )}
              </div>
            </footer>
          </article>
        );
      })}
    </div>
  );
}



function AdvancedSearchForm({ filters, onChange, onSearch, onClear, loading }) {
  function set(key) {
    return (e) => onChange({ ...filters, [key]: e.target.value });
  }

  function handleDatePreset(preset) {
    const today = getFormattedDate(0);
    if (preset === 'today') {
      onChange({ ...filters, fromDate: today, toDate: today });
    } else if (preset === 'yesterday') {
      const yest = getFormattedDate(1);
      onChange({ ...filters, fromDate: yest, toDate: yest });
    } else if (preset === '7days') {
      onChange({ ...filters, fromDate: getFormattedDate(7), toDate: today });
    } else if (preset === '30days') {
      onChange({ ...filters, fromDate: getFormattedDate(30), toDate: today });
    }
  }

  return (
    <div className="advanced-search-container enhanced-search-panel">
      <div className="advanced-search-header-bar">
        <div className="search-panel-title-wrap">
          <div className="panel-badge-icon">
            <FilterIcon size={20} />
          </div>
          <div>
            <h3 className="panel-title">Advanced Patient Investigation Filter</h3>
            <p className="panel-subtitle">
              Filter discharges by clinical department, attending physician, patient type, ward, or discharge window.
            </p>
          </div>
        </div>

        <button
          type="button"
          className="btn-panel-reset"
          onClick={onClear}
          title="Reset all filter inputs"
        >
          <RotateCcwIcon size={13} />
          <span>Reset Form</span>
        </button>
      </div>

      <form
        className="enhanced-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch();
        }}
      >
        {/* Section 1: Patient & Contact Identifiers */}
        <div className="filter-card-section">
          <div className="section-title-tag">
            <span className="tag-dot" />
            <span>Patient & Contact Identifiers</span>
          </div>

          <div className="filter-input-grid">
            <div className="enhanced-field">
              <label htmlFor="filter-ip">IP Number</label>
              <div className="field-input-box">
                <input
                  id="filter-ip"
                  value={filters.ipNo}
                  onChange={set('ipNo')}
                  placeholder="e.g. IP07025423"
                  className="filter-control"
                />
              </div>
            </div>

            <div className="enhanced-field">
              <label htmlFor="filter-reg">UHID / Reg No</label>
              <div className="field-input-box">
                <input
                  id="filter-reg"
                  value={filters.regNo}
                  onChange={set('regNo')}
                  placeholder="e.g. 6159338"
                  className="filter-control"
                />
              </div>
            </div>

            <div className="enhanced-field">
              <label htmlFor="filter-req">Lab Req No</label>
              <div className="field-input-box">
                <input
                  id="filter-req"
                  value={filters.reqNo}
                  onChange={set('reqNo')}
                  placeholder="Lab request number"
                  className="filter-control"
                />
              </div>
            </div>

            <div className="enhanced-field">
              <label htmlFor="filter-name">Patient Name</label>
              <div className="field-input-box">
                <input
                  id="filter-name"
                  value={filters.name}
                  onChange={set('name')}
                  placeholder="e.g. Pushpam"
                  className="filter-control"
                />
              </div>
            </div>

            <div className="enhanced-field">
              <label htmlFor="filter-mobile">Phone Number</label>
              <div className="field-input-box">
                <input
                  id="filter-mobile"
                  value={filters.mobile}
                  onChange={set('mobile')}
                  placeholder="10-digit mobile number"
                  className="filter-control"
                />
              </div>
            </div>

            <div className="enhanced-field">
              <label htmlFor="filter-wa">WhatsApp Number</label>
              <div className="field-input-box">
                <input
                  id="filter-wa"
                  value={filters.whatsapp}
                  onChange={set('whatsapp')}
                  placeholder="WhatsApp mobile number"
                  className="filter-control"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: Clinical Assignment */}
        <div className="filter-card-section">
          <div className="section-title-tag">
            <span className="tag-dot" />
            <span>Clinical & Ward Assignment</span>
          </div>

          <div className="filter-input-grid">
            <div className="enhanced-field">
              <label htmlFor="filter-dept">Department</label>
              <div className="field-input-box">
                <input
                  id="filter-dept"
                  value={filters.department}
                  onChange={set('department')}
                  placeholder="e.g. Cardiology"
                  className="filter-control"
                />
              </div>
            </div>

            <div className="enhanced-field">
              <label htmlFor="filter-doc">Doctor Name</label>
              <div className="field-input-box">
                <input
                  id="filter-doc"
                  value={filters.doctor}
                  onChange={set('doctor')}
                  placeholder="Doctor name"
                  className="filter-control"
                />
              </div>
            </div>

            <div className="enhanced-field">
              <label htmlFor="filter-ptype">Patient Type</label>
              <div className="field-input-box">
                <input
                  id="filter-ptype"
                  value={filters.patientType}
                  onChange={set('patientType')}
                  placeholder="General / Corporate"
                  className="filter-control"
                />
              </div>
            </div>

            <div className="enhanced-field">
              <label htmlFor="filter-ward">Ward / ICU</label>
              <div className="field-input-box">
                <input
                  id="filter-ward"
                  value={filters.ward}
                  onChange={set('ward')}
                  placeholder="e.g. Cardiac ICU"
                  className="filter-control"
                />
              </div>
            </div>

            <div className="enhanced-field">
              <label htmlFor="filter-user">Created User</label>
              <div className="field-input-box">
                <input
                  id="filter-user"
                  value={filters.createdUser}
                  onChange={set('createdUser')}
                  placeholder="EMR user identifier"
                  className="filter-control"
                />
              </div>
            </div>
          </div>

          {/* Clean Info Banner instead of misaligned label hint */}
          <div className="filter-info-banner">
            <InfoIcon size={14} className="info-icon-blue" />
            <span>Test records (<code>ZPATIENT</code>) are automatically excluded from all query results.</span>
          </div>
        </div>

        {/* Section 3: Discharge Period */}
        <div className="filter-card-section">
          <div className="section-header-flex">
            <div className="section-title-tag">
              <span className="tag-dot" />
              <span>Discharge Date Period</span>
            </div>

            {/* Quick Range Presets */}
            <div className="filter-presets-row">
              <span className="preset-label-mini">Presets:</span>
              <button type="button" className="btn-preset-mini" onClick={() => handleDatePreset('today')}>
                Today
              </button>
              <button type="button" className="btn-preset-mini" onClick={() => handleDatePreset('yesterday')}>
                Yesterday
              </button>
              <button type="button" className="btn-preset-mini" onClick={() => handleDatePreset('7days')}>
                Last 7 Days
              </button>
              <button type="button" className="btn-preset-mini" onClick={() => handleDatePreset('30days')}>
                Last 30 Days
              </button>
            </div>
          </div>

          <div className="filter-dates-grid">
            <div className="enhanced-field">
              <label htmlFor="filter-from">Discharge From Date</label>
              <div className="field-input-box">
                <input
                  id="filter-from"
                  type="date"
                  value={filters.fromDate}
                  onChange={set('fromDate')}
                  className="filter-control"
                />
              </div>
            </div>

            <div className="enhanced-field">
              <label htmlFor="filter-to">Discharge To Date</label>
              <div className="field-input-box">
                <input
                  id="filter-to"
                  type="date"
                  value={filters.toDate}
                  onChange={set('toDate')}
                  className="filter-control"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons Bar */}
        <div className="enhanced-actions-bar">
          <button type="submit" className="btn btn-primary btn-execute-search" disabled={loading}>
            <SearchIcon size={18} />
            <span>{loading ? 'Searching Database…' : 'Execute Patient Search'}</span>
          </button>
          <button type="button" className="btn btn-secondary btn-clear-filters" onClick={onClear}>
            <RotateCcwIcon size={14} />
            <span>Clear All Filters</span>
          </button>
        </div>
      </form>
    </div>
  );
}

export default function DischargeReports({ navRequest }) {
  const [mode, setMode] = useState('date'); // 'date' | 'search'
  const [date, setDate] = useState(defaultDateOnly());
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [searchActive, setSearchActive] = useState(false);
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [viewLayout, setViewLayout] = useState(() => {
    try {
      return localStorage.getItem('portal_view_layout') || 'cards';
    } catch {
      return 'cards';
    }
  });
  const [filterText, setFilterText] = useState('');

  // The AI assistant can open this screen at a date, with the list filtered.
  useEffect(() => {
    if (navRequest?.view !== 'reports') return;
    setMode('date');
    if (navRequest.date) setDate(navRequest.date);
    setFilterText(navRequest.filter || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navRequest?.id]);
  const [categoryFilter, setCategoryFilter] = useState('all'); // 'all' | 'lab' | 'summary' | 'nolab' | 'corporate'
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  // Pagination State: 50 is default, options: 50, 100, 'all'
  const [pageSize, setPageSize] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const showToast = useCallback((message) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, id: Date.now() });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
    }, 2800);
  }, []);

  function handleLayoutToggle(newLayout) {
    setViewLayout(newLayout);
    try {
      localStorage.setItem('portal_view_layout', newLayout);
    } catch {
      // ignore
    }
  }

  const loadByDate = useCallback((forDate) => {
    setLoading(true);
    setError('');
    fetchReportsForDate(forDate)
      .then((rows) => {
        setPatients(rows);
        setLastRefreshedAt(Date.now());
        setCurrentPage(1);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const runSearch = useCallback(() => {
    setLoading(true);
    setError('');
    setSearchActive(true);
    searchReports(filtersRef.current)
      .then((rows) => {
        setPatients(rows);
        setLastRefreshedAt(Date.now());
        setCurrentPage(1);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function refreshCurrentView() {
    if (mode === 'date') loadByDate(date);
    else if (searchActive) runSearch();
  }

  function refreshStatus() {
    fetchReportStatus()
      .then(setStatus)
      .catch(() => {});
  }

  useEffect(() => {
    if (mode === 'date') loadByDate(date);
  }, [mode, date, loadByDate]);

  // Live auto-refresh: keep whatever's on screen current without manual reload.
  useEffect(() => {
    const id = setInterval(() => {
      if (mode === 'date') loadByDate(date);
      else if (searchActive) runSearch();
    }, LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [mode, date, searchActive, loadByDate, runSearch]);

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 15000);
    return () => clearInterval(id);
  }, []);

  // Keyboard navigation shortcuts
  useEffect(() => {
    function handleKeyDown(e) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
        if (e.key === 'Escape') {
          e.target.blur();
          if (filterText) {
            setFilterText('');
            setCurrentPage(1);
          }
        }
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        const searchInput = document.querySelector('.filter-text-input');
        searchInput?.focus();
      } else if (e.key === 'ArrowLeft' || e.key === '[') {
        if (mode === 'date') {
          setDate((prev) => adjustDateByDays(prev, -1));
        }
      } else if (e.key === 'ArrowRight' || e.key === ']') {
        if (mode === 'date') {
          setDate((prev) => adjustDateByDays(prev, 1));
        }
      } else if (e.key.toLowerCase() === 't') {
        if (mode === 'date') {
          setDate(defaultDateOnly());
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, filterText]);

  async function handleRunNow() {
    setRunning(true);
    try {
      const summary = await triggerReportRun();
      setStatus((prev) => ({ ...prev, lastSummary: summary, lastCheckFinishedAt: new Date().toISOString() }));
      refreshCurrentView();
      showToast(
        summary?.found !== undefined
          ? `Discharge check complete: ${summary.found} patients checked`
          : 'Discharge check completed successfully'
      );
    } catch (err) {
      setStatus((prev) => ({ ...prev, lastSummary: { error: err.message } }));
      showToast(`Check failed: ${err.message}`);
    } finally {
      setRunning(false);
      refreshStatus();
    }
  }

  function handleModeChange(nextMode) {
    setMode(nextMode);
    setPatients([]);
    setError('');
    setFilterText('');
    setCategoryFilter('all');
    setCurrentPage(1);
    if (nextMode === 'search') setSearchActive(false);
  }

  function handleClearFilters() {
    setFilters(EMPTY_FILTERS);
    setSearchActive(false);
    setPatients([]);
    setFilterText('');
    setCategoryFilter('all');
    setCurrentPage(1);
  }

  function handleFilterTextChange(e) {
    setFilterText(e.target.value);
    setCurrentPage(1);
  }

  function handleCategoryFilterChange(cat) {
    setCategoryFilter(cat);
    setCurrentPage(1);
  }

  function handlePageSizeChange(newSize) {
    setPageSize(newSize);
    setCurrentPage(1);
  }

  // Dynamic category counts
  const categoryCounts = useMemo(() => {
    let lab = 0;
    let summary = 0;
    let noLab = 0;
    let corporate = 0;
    patients.forEach((p) => {
      if (p.dateCount !== undefined) lab++;
      else noLab++;
      if (p.hasSummary) summary++;
      if (p.patientType?.toLowerCase().includes('corp')) corporate++;
    });
    return { all: patients.length, lab, summary, noLab, corporate };
  }, [patients]);

  // Quick in-page client filter: Category + Text filter across all key fields
  const filteredPatients = useMemo(() => {
    let list = patients;

    if (categoryFilter === 'lab') {
      list = list.filter((p) => p.dateCount !== undefined);
    } else if (categoryFilter === 'summary') {
      list = list.filter((p) => Boolean(p.hasSummary));
    } else if (categoryFilter === 'nolab') {
      list = list.filter((p) => p.dateCount === undefined);
    } else if (categoryFilter === 'corporate') {
      list = list.filter((p) => p.patientType?.toLowerCase().includes('corp'));
    }

    if (!filterText.trim()) return list;
    const q = filterText.toLowerCase();
    return list.filter((p) => {
      return (
        p.name?.toLowerCase().includes(q) ||
        p.ipNo?.toLowerCase().includes(q) ||
        p.regNo?.toLowerCase().includes(q) ||
        p.doctor?.toLowerCase().includes(q) ||
        p.department?.toLowerCase().includes(q) ||
        p.ward?.toLowerCase().includes(q) ||
        p.mobile?.includes(q) ||
        p.createdUser?.toLowerCase().includes(q)
      );
    });
  }, [patients, categoryFilter, filterText]);

  // Pagination calculation
  const totalCount = filteredPatients.length;
  const isAll = pageSize === 'all';
  const numericSize = isAll ? Math.max(totalCount, 1) : Number(pageSize);
  const totalPages = isAll ? 1 : Math.max(1, Math.ceil(totalCount / numericSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);

  const paginatedPatients = useMemo(() => {
    if (isAll) return filteredPatients;
    const start = (safePage - 1) * numericSize;
    return filteredPatients.slice(start, start + numericSize);
  }, [filteredPatients, isAll, safePage, numericSize]);

  const lastRefreshedLabel = lastRefreshedAt ? formatRelativeTime(new Date(lastRefreshedAt).toISOString()) : null;

  return (
    <div className="discharge-reports-page">
      <ToastNotification toast={toast} onDismiss={() => setToast(null)} />

      <div className="section-header reports-header">
        <div>
          <h2>Discharge Investigation Reports</h2>
          <p className="section-subtitle">
            Automated multi-parameter investigation charts generated in real-time upon patient discharge.
          </p>
        </div>
      </div>

      <AutomationStatus status={status} onRunNow={handleRunNow} running={running} />

      {/* Control Bar: Mode Tabs + Live Status */}
      <div className="reports-mode-row">
        <div className="tabs modern-tabs no-print">
          <button
            type="button"
            className={`tab-btn ${mode === 'date' ? 'active' : ''}`}
            onClick={() => handleModeChange('date')}
          >
            <CalendarIcon size={16} />
            <span>By Date</span>
          </button>
          <button
            type="button"
            className={`tab-btn ${mode === 'search' ? 'active' : ''}`}
            onClick={() => handleModeChange('search')}
          >
            <SearchIcon size={16} />
            <span>Advanced Search</span>
          </button>
        </div>

        <div className="live-indicator" title="Auto-refreshes every 20 seconds from hospital database">
          <span className="live-dot" />
          <span>Live · updated {lastRefreshedLabel || 'just now'}</span>
        </div>
      </div>

      {/* Date Mode Toolbar */}
      {mode === 'date' && (
        <div className="reports-toolbar modern-toolbar">
          {/* Quick Date Stepper */}
          <div className="date-stepper-group">
            <button
              type="button"
              className="btn btn-stepper"
              onClick={() => setDate((prev) => adjustDateByDays(prev, -1))}
              title="Previous day (Shortcut: [ or Left Arrow)"
            >
              <ChevronLeftIcon size={16} />
              <span className="hide-on-mobile">Prev</span>
            </button>

            <div className="toolbar-date-input-wrap">
              <CalendarIcon size={16} className="date-input-icon" />
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="toolbar-date-input"
                aria-label="Select discharge date"
              />
              <span className={`date-human-pill ${date === getFormattedDate(0) ? 'is-today' : ''}`}>
                {getHumanDate(date)}
              </span>
            </div>

            <button
              type="button"
              className="btn btn-stepper"
              onClick={() => setDate((prev) => adjustDateByDays(prev, 1))}
              title="Next day (Shortcut: ] or Right Arrow)"
            >
              <span className="hide-on-mobile">Next</span>
              <ChevronRightIcon size={16} />
            </button>

            <button
              type="button"
              className={`btn btn-stepper-today ${date === getFormattedDate(0) ? 'active' : ''}`}
              onClick={() => setDate(defaultDateOnly())}
              title="Reset to today (Shortcut: T)"
            >
              Today
            </button>
          </div>

          {/* Quick In-Table Search */}
          {patients.length > 0 && (
            <div className="in-table-filter">
              <SearchIcon size={16} className="filter-input-icon" />
              <input
                type="text"
                value={filterText}
                onChange={handleFilterTextChange}
                placeholder="Filter by name, IP, doctor, ward… (Press /)"
                className="filter-text-input"
              />
              {filterText && (
                <button
                  type="button"
                  className="filter-clear-btn"
                  onClick={() => {
                    setFilterText('');
                    setCurrentPage(1);
                  }}
                  title="Clear filter (Escape)"
                >
                  ×
                </button>
              )}
            </div>
          )}

          {/* Responsive Layout Toggle */}
          {patients.length > 0 && (
            <div className="layout-toggle-group no-print">
              <button
                type="button"
                className={`btn-layout-toggle ${viewLayout === 'table' ? 'active' : ''}`}
                onClick={() => handleLayoutToggle('table')}
                title="Table view"
              >
                <TableViewIcon size={16} />
                <span className="hide-on-mobile">Table</span>
              </button>
              <button
                type="button"
                className={`btn-layout-toggle ${viewLayout === 'cards' ? 'active' : ''}`}
                onClick={() => handleLayoutToggle('cards')}
                title="Card grid view"
              >
                <CardViewIcon size={16} />
                <span className="hide-on-mobile">Cards</span>
              </button>
            </div>
          )}
        </div>
      )}

      {mode === 'search' && (
        <AdvancedSearchForm
          filters={filters}
          onChange={setFilters}
          onSearch={runSearch}
          onClear={handleClearFilters}
          loading={loading}
        />
      )}

      {loading && (
        <div className="loading modern-loading">
          <div className="spinner"></div>
          <div>Loading patient reports…</div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {!loading && !error && mode === 'date' && patients.length === 0 && (
        <div className="empty modern-empty">
          <div className="empty-icon">📂</div>
          <div className="empty-title">No discharge reports for {date}</div>
          <p className="empty-subtitle">
            Investigation charts generate automatically when patients are discharged in the EMR. Click "Check Now" above to trigger a fresh query.
          </p>
        </div>
      )}

      {!loading && !error && mode === 'search' && !searchActive && (
        <div className="empty modern-empty search-guide-empty">
          <div className="empty-icon">🔍</div>
          <div className="empty-title">Advanced Discharge Query Ready</div>
          <p className="empty-subtitle">
            Set your target criteria above (IP Number, UHID, Patient Name, Attending Doctor, or Date Window) and click <strong>Execute Patient Search</strong>.
          </p>
        </div>
      )}

      {!loading && !error && mode === 'search' && searchActive && patients.length === 0 && (
        <div className="empty modern-empty">
          <div className="empty-icon">📋</div>
          <div className="empty-title">No Matching Records Found</div>
          <p className="empty-subtitle">Try adjusting your filters or broadening the discharge date range.</p>
        </div>
      )}

      {!loading && patients.length > 0 && (
        <div className="results-container">
          {/* Quick Category Filter Bar */}
          <div className="category-filter-chips no-print">
            <button
              type="button"
              className={`cat-chip ${categoryFilter === 'all' ? 'active' : ''}`}
              onClick={() => handleCategoryFilterChange('all')}
            >
              <span>All Patients</span>
              <span className="cat-count-badge">{categoryCounts.all}</span>
            </button>
            <button
              type="button"
              className={`cat-chip cat-chip-lab ${categoryFilter === 'lab' ? 'active' : ''}`}
              onClick={() => handleCategoryFilterChange('lab')}
              title="Filter to patients with lab reports ready"
            >
              <span>📋 Lab Ready</span>
              <span className="cat-count-badge">{categoryCounts.lab}</span>
            </button>
            <button
              type="button"
              className={`cat-chip cat-chip-summary ${categoryFilter === 'summary' ? 'active' : ''}`}
              onClick={() => handleCategoryFilterChange('summary')}
              title="Filter to patients with discharge summaries"
            >
              <span>📄 Summary Ready</span>
              <span className="cat-count-badge">{categoryCounts.summary}</span>
            </button>
            <button
              type="button"
              className={`cat-chip cat-chip-nolab ${categoryFilter === 'nolab' ? 'active' : ''}`}
              onClick={() => handleCategoryFilterChange('nolab')}
              title="Filter to patients with no lab orders"
            >
              <span>⏳ No Lab Data</span>
              <span className="cat-count-badge">{categoryCounts.noLab}</span>
            </button>
            {categoryCounts.corporate > 0 && (
              <button
                type="button"
                className={`cat-chip cat-chip-corp ${categoryFilter === 'corporate' ? 'active' : ''}`}
                onClick={() => handleCategoryFilterChange('corporate')}
                title="Filter to corporate patients"
              >
                <span>🏢 Corporate</span>
                <span className="cat-count-badge">{categoryCounts.corporate}</span>
              </button>
            )}
          </div>

          {/* Top Pagination Summary & Page Size Controls */}
          <div className="results-meta-bar">
            <div className="result-count-badge">
              <strong>{totalCount}</strong> {totalCount === 1 ? 'report' : 'reports'} found
              {(filterText || categoryFilter !== 'all') && (
                <span className="filtered-from-note"> (filtered from {patients.length})</span>
              )}
            </div>

            {/* Quick Page Size Pill in Meta Bar */}
            <div className="meta-size-pill-wrap no-print">
              <span className="meta-size-label">Rows:</span>
              <button
                type="button"
                className={`meta-size-btn ${pageSize === 50 ? 'active' : ''}`}
                onClick={() => handlePageSizeChange(50)}
              >
                50
              </button>
              <button
                type="button"
                className={`meta-size-btn ${pageSize === 100 ? 'active' : ''}`}
                onClick={() => handlePageSizeChange(100)}
              >
                100
              </button>
              <button
                type="button"
                className={`meta-size-btn ${pageSize === 'all' ? 'active' : ''}`}
                onClick={() => handlePageSizeChange('all')}
              >
                All
              </button>
            </div>
          </div>

          {totalCount === 0 ? (
            <div className="empty modern-empty filter-empty-state">
              <div className="empty-icon">🔍</div>
              <div className="empty-title">No matching reports found</div>
              <p className="empty-subtitle">
                No patients match the current filter {filterText ? `"${filterText}"` : ''} in{' '}
                <strong>
                  {categoryFilter === 'all' ? 'all categories' : categoryFilter}
                </strong>.
              </p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setFilterText('');
                  setCategoryFilter('all');
                  setCurrentPage(1);
                }}
              >
                Clear Filters
              </button>
            </div>
          ) : (
            <>
              {/* Conditional rendering based on layout toggle */}
              {viewLayout === 'cards' ? (
                <ReportsCards
                  patients={paginatedPatients}
                  dateColumn={mode === 'search'}
                  getPdfUrl={(p) => reportPdfUrl(p.date, p.ipNo)}
                  getSummaryPdfUrl={(p) => reportSummaryPdfUrl(p.date, p.ipNo)}
                  onToast={showToast}
                />
              ) : (
                <>
                  <div className="responsive-table-view">
                    <ReportsTable
                      patients={paginatedPatients}
                      dateColumn={mode === 'search'}
                      getPdfUrl={(p) => reportPdfUrl(p.date, p.ipNo)}
                      getSummaryPdfUrl={(p) => reportSummaryPdfUrl(p.date, p.ipNo)}
                      onToast={showToast}
                    />
                  </div>
                  <div className="responsive-cards-view">
                    <ReportsCards
                      patients={paginatedPatients}
                      dateColumn={mode === 'search'}
                      getPdfUrl={(p) => reportPdfUrl(p.date, p.ipNo)}
                      getSummaryPdfUrl={(p) => reportSummaryPdfUrl(p.date, p.ipNo)}
                      onToast={showToast}
                    />
                  </div>
                </>
              )}

              {/* Bottom Pagination Controls */}
              <Pagination
                currentPage={safePage}
                totalPages={totalPages}
                totalCount={totalCount}
                pageSize={pageSize}
                onPageChange={setCurrentPage}
                onPageSizeChange={handlePageSizeChange}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
