import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { track } from '../utils/audit';
import { patientMatcher } from '../utils/patientMatch';
import {
  checkWhatsAppNumber,
  defaultDateOnly,
  fetchWhatsappNumberStates,
  fetchWatiSettings,
  fetchReportsForDate,
  fetchReportStatus,
  fetchUnsentWhatsAppCount,
  reportPdfUrl,
  searchReports,
  sendReportWhatsApp,
  sendUnsentReportsWhatsApp,
  triggerReportRun,
} from '../api/client';
import {
  CalendarIcon,
  CardViewIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
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
import PatientDetailsDialog from './PatientDetailsDialog';

const LIVE_REFRESH_MS = 20_000; // default; Master Settings → refreshMs

const EMPTY_FILTERS = {
  any: '', // "Search anything" — name, UHID, token, Req No, Bill No, mobile, town … (server: patientSearchService.js)
  regNo: '',
  tokenNo: '',
  reqNo: '',
  billNo: '',
  name: '',
  mobile: '',
  whatsapp: '',
  department: '',
  doctor: '',
  visitType: '',
  patientType: '',
  createdUser: '',
  fromDate: '',
  toDate: '',
};

// Without an access prop (e.g. the super admin): everything. See utils/access.js.
const FULL_ACCESS = { reports: { canRun: true, showWhatsApp: true } };

function isReportReady(p) {
  if (!p) return false;
  if (p.reportStatus === 'ready') return true;
  return p.reportStatus === undefined && p.dateCount !== undefined;
}

function isPendingReport(p) {
  return p?.reportStatus === 'pending';
}

function pendingTooltip(p) {
  const counts = p?.totalOrders ? `${p.approvedOrders ?? 0}/${p.totalOrders} orders Result Approved` : 'Waiting for lab result approval';
  const statuses = Array.isArray(p?.pendingStatuses) && p.pendingStatuses.length ? ` · Pending: ${p.pendingStatuses.join(', ')}` : '';
  return `${counts}${statuses}`;
}

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

function AutomationStatus({ status, onRunNow, running, canRun = true }) {
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
              <span className="automation-checking-text">Syncing with OP lab orders now…</span>
            ) : status.paused ? (
              // Master Settings → OP lab automation switched off.
              <span>Automatic checks are paused{canRun ? ' — Check Now still works' : ''}</span>
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
            <span className="stat-chip chip-found" title="Total OP patients with lab orders detected">
              <strong>{summary.found}</strong> found
            </span>
          )}
          {summary.generated !== undefined && summary.generated > 0 && (
            <span className="stat-chip chip-generated" title="Newly generated OP lab reports">
              <strong>+{summary.generated}</strong> generated
            </span>
          )}
          {summary.alreadyReported !== undefined && (
            <span className="stat-chip chip-existing" title="Reports already prepared">
              <strong>{summary.alreadyReported}</strong> ready
            </span>
          )}
          {summary.pending !== undefined && summary.pending > 0 && (
            <span
              className="stat-chip chip-pending"
              title="Patients whose lab orders are not all Result Approved yet — will auto-generate once approved"
            >
              <strong>{summary.pending}</strong> pending
            </span>
          )}
          {summary.noLabData !== undefined && summary.noLabData > 0 && (
            <span
              className="stat-chip chip-nodata"
              title="No completed lab results exist for this patient in the EMR"
            >
              <strong>{summary.noLabData}</strong> no lab data
            </span>
          )}
          {summary.failed !== undefined && summary.failed > 0 && (
            <span className="stat-chip chip-failed" title="Failed to generate">
              <strong>{summary.failed}</strong> failed
            </span>
          )}
          {summary.error && (
            <span className="stat-chip chip-failed" title={summary.error}>
              <strong>Error:</strong> {summary.error}
            </span>
          )}
        </div>
      )}

      {canRun && (
        <button
          type="button"
          className="btn btn-secondary btn-check-now"
          onClick={onRunNow}
          disabled={running || checking}
          title="Trigger an immediate check for OP lab orders"
        >
          <RefreshIcon spinning={running || checking} size={16} />
          <span>{running || checking ? 'Checking…' : 'Check Now'}</span>
        </button>
      )}
    </div>
  );
}

function CopyableChip({ value, label, className = '', onToast, iconOnly = false }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!value || value === '—') return;
    track('copy', { screen: 'reports', details: { label: label || 'value', value: String(value).slice(0, 40) } });
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

/** "+91 99624 60782" for a stored number (10 digits, 91…, or +91…). */
function prettyNumber(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const local = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 10 ? d : '';
  return local ? `+91 ${local.slice(0, 5)} ${local.slice(5)}` : raw ? `+${d}` : '';
}

/**
 * WATI Settings → "Confirm the number before sending": the number the send
 * would use — the test number in Test mode, the patient's mobile when Live —
 * shown editable before anything goes out.
 */
function SendConfirmDialog({ patient, live, defaultNumber, documents, onCancel, onSend }) {
  const [number, setNumber] = useState(() => prettyNumber(defaultNumber));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = checkWhatsAppNumber(number);
  const edited = String(number).replace(/\D/g, '').slice(-10) !== String(defaultNumber || '').replace(/\D/g, '').slice(-10);

  const cancel = () => onCancel(edited);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && cancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, edited]);

  async function submit(e) {
    e.preventDefault();
    if (!check.ok) return;
    setBusy(true);
    setError('');
    try {
      await onSend(check.digits);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  // Rendered on <body>, not inside the card: the card lifts on hover (a CSS
  // transform) and is a size container, and either makes a position: fixed
  // popup sit inside the card — it then jumped between the card and the
  // screen as the mouse moved (the flicker). Clicks stay out of the card too.
  return createPortal(
    <div className="um-modal-backdrop" onMouseDown={() => !busy && cancel()} onClick={(e) => e.stopPropagation()}>
      <form className="um-modal wa-send" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit} aria-label="Send on WhatsApp">
        <h3>
          <WhatsAppIcon size={18} /> Send on WhatsApp
        </h3>
        <div className="wa-send-patient">
          <b>{patient.name}</b>
          <span>
            UHID {patient.regNo}
            {patient.department ? ` · ${patient.department}` : ''}
          </span>
        </div>
        <span className={`wa-send-mode ${live ? 'is-live' : 'is-test'}`}>
          {live ? "Live mode — the patient's mobile" : 'Test mode — the test number'}
        </span>
        <label className="wa-send-field">
          <span>WhatsApp number</span>
          <input
            value={number}
            onChange={(e) => {
              setNumber(e.target.value);
              setError('');
            }}
            inputMode="tel"
            placeholder="+91 98765 43210"
            autoFocus
            aria-invalid={!check.ok}
          />
        </label>
        {!check.ok && number && <div className="wa-send-error">{check.error}</div>}
        {!defaultNumber && <div className="wa-send-error">{live ? 'No mobile number on file for this patient — type one.' : 'No test number set — type one.'}</div>}
        {edited && check.ok && defaultNumber && (
          <button type="button" className="ai-link wa-send-reset" onClick={() => setNumber(prettyNumber(defaultNumber))}>
            Use {prettyNumber(defaultNumber)} instead
          </button>
        )}
        <div className="wa-send-docs">
          {documents.map((d) => (
            <span key={d}>
              <FilePdfIcon size={13} /> {d}
            </span>
          ))}
        </div>
        <p className="wa-send-note">Sent as the OP Lab Report PDF on WhatsApp.</p>
        {error && <div className="wa-send-error is-block">{error}</div>}
        <div className="um-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary wa-send-btn" disabled={busy || !check.ok}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** Self-contained so each row tracks its own send state independently. */
function SendWhatsAppButton({ date, regNo, name, onToast, patient, waSettings, onPopup }) {
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  // Tell the list a popup is open (it holds the live refresh until it closes).
  useEffect(() => {
    if (!confirming) return undefined;
    onPopup?.(true);
    return () => onPopup?.(false);
  }, [confirming, onPopup]);
  const live = Boolean(waSettings?.liveEnabled);
  const defaultNumber = live ? patient?.mobile || '' : waSettings?.fixedNumber || '';
  const documents = [isReportReady(patient) && 'Lab Report'].filter(Boolean);

  async function send(toNumber) {
    setStatus('sending');
    setError('');
    try {
      const result = await sendReportWhatsApp(date, regNo, toNumber);
      setStatus('sent');
      setConfirming(false);
      const docs = result.sent.map((d) => d.label).join(' + ');
      if (onToast) onToast(`WhatsApp sent to ${prettyNumber(result.sentTo) || result.sentTo}: ${docs}`);
    } catch (err) {
      setStatus('error');
      setError(err.message);
      throw err;
    }
  }

  const auditTarget = { patientName: patient?.name || name, regNo, date, department: patient?.department || '' };

  function handleClick(e) {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (status === 'sending') return;
    track('whatsapp_click', { screen: 'reports', target: auditTarget, details: { mode: live ? 'live' : 'test', popup: Boolean(waSettings?.confirmBeforeSend) } });
    if (waSettings?.confirmBeforeSend && patient) setConfirming(true);
    else send().catch(() => { });
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
      ? 'Sending OP lab report…'
      : status === 'error'
        ? `Failed: ${error} — click to retry`
        : `Send OP lab report to ${name} via WhatsApp`;

  return (
    <>
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
      {confirming && (
        <SendConfirmDialog
          patient={patient}
          live={live}
          defaultNumber={defaultNumber}
          documents={documents}
          onCancel={(edited) => {
            track('whatsapp_popup_cancel', { screen: 'reports', target: auditTarget, details: { numberEdited: Boolean(edited) } });
            setConfirming(false);
          }}
          onSend={send}
        />
      )}
    </>
  );
}


/** 10-digit EMR mobiles are sent as 91XXXXXXXXXX (same as the server's toWatiNumber). */
function whatsappDigits(mobile) {
  const d = String(mobile || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d;
}

function NoWhatsAppBadge() {
  return (
    <span className="wa-nowa-tag" title="The last WhatsApp message to this number failed because it is not on WhatsApp — check the mobile number in the EMR">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M20 11.5a8.4 8.4 0 0 1-12.2 7.5L3 20.5l1.5-4.6A8.4 8.4 0 1 1 20 11.5z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      Not on WhatsApp
    </span>
  );
}

function WhatsAppVerifiedBadge({ source }) {
  const title =
    source === 'both'
      ? 'WhatsApp verified (registered in EMR & delivered via WATI)'
      : source === 'emr'
        ? 'WhatsApp verified (registered in EMR)'
        : 'WhatsApp verified (delivered via WATI)';
  return (
    <span className="wa-verified-badge" title={title} aria-label="WhatsApp verified">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M20 11.5a8.4 8.4 0 0 1-12.2 7.5L3 20.5l1.5-4.6A8.4 8.4 0 1 1 20 11.5Z"
          fill="currentColor"
          fillOpacity="0.16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M8.8 12l2.1 2.1 4.4-4.4"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function MobileWhatsAppStatus({ patient, waStates }) {
  const digits = whatsappDigits(patient?.mobile);
  if (!digits) return null;
  if (waStates?.notOnWhatsApp?.has(digits)) return <NoWhatsAppBadge />;

  const hasEmrWa = Boolean(String(patient?.whatsappNo || '').trim());
  const isWatiVerified = Boolean(waStates?.verified?.has(digits));
  if (!hasEmrWa && !isWatiVerified) return null;

  const source = hasEmrWa && isWatiVerified ? 'both' : hasEmrWa ? 'emr' : 'wati';
  return <WhatsAppVerifiedBadge source={source} />;
}

function ReportsTable({ patients, dateColumn, getPdfUrl, onToast, waStates, access = FULL_ACCESS, waSettings, onPopup, onInspect }) {
  if (!patients.length) return null;

  return (
    <div className="table-wrap modern-table-wrap">
      <table className="results modern-results-table">
        <thead>
          <tr>
            {dateColumn && <th>OP Date</th>}
            <th>UHID (Reg No)</th>
            <th>Token No</th>
            <th>Patient Name</th>
            <th>Visit Type</th>
            <th>Patient Type</th>
            <th>Department</th>
            <th>Doctor</th>
            <th>Mobile</th>
            <th>Created By</th>
            <th>Lab Status</th>
            <th className="th-action">Report</th>
          </tr>
        </thead>
        <tbody>
          {patients.map((p) => {
            const isCorporate = p.patientType?.toLowerCase().includes('corp');
            const ready = isReportReady(p);
            const pending = isPendingReport(p);
            return (
              <tr key={`${p.date}-${p.regNo}`} className="patient-row">
                {dateColumn && <td className="cell-date">{p.date}</td>}
                <td className="cell-reg">
                  <CopyableChip
                    value={p.regNo}
                    label="UHID"
                    className="code-chip code-chip-reg"
                    onToast={onToast}
                  />
                </td>
                <td className="cell-ip">
                  {p.tokenNo ? (
                    <CopyableChip
                      value={p.tokenNo}
                      label="Token"
                      className="code-chip code-chip-ip"
                      onToast={onToast}
                    />
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="cell-name">
                  <div className="patient-name-box">
                    <span className="name-text">{p.name}</span>
                  </div>
                </td>
                <td className="cell-ward">
                  <span>{p.visitType || 'OP'}</span>
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
                      <MobileWhatsAppStatus patient={p} waStates={waStates} />
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
                  {ready ? (
                    <span className="dates-pill dates-pill-ready" title={`${p.dateCount} dates with approved lab orders`}>
                      {p.dateCount} date{p.dateCount === 1 ? '' : 's'}
                    </span>
                  ) : pending ? (
                    <span className="dates-pill dates-pill-pending" title={pendingTooltip(p)}>
                      Pending {p.approvedOrders ?? 0}/{p.totalOrders ?? '?'}
                    </span>
                  ) : p.reportStatus === 'failed' ? (
                    <span className="text-muted" title={p.error || 'Report generation failed'}>
                      failed
                    </span>
                  ) : (
                    <span className="text-muted" title="No completed lab orders found for this patient">
                      no lab data
                    </span>
                  )}
                </td>
                <td className="cell-action">
                  <div className="action-btn-group">
                    {ready ? (
                      <>
                        <a
                          className="btn btn-view-pdf"
                          href={getPdfUrl(p)}
                          target="_blank"
                          rel="noreferrer"
                          title={`Open OP lab report PDF for ${p.name}`}
                        >
                          <FilePdfIcon size={15} />
                          <span>Lab Report</span>
                        </a>
                        {access.reports?.showWhatsApp && (
                          <SendWhatsAppButton
                            date={p.date}
                            regNo={p.regNo}
                            name={p.name}
                            onToast={onToast}
                            patient={p}
                            waSettings={waSettings}
                            onPopup={onPopup}
                          />
                        )}
                      </>
                    ) : pending ? (
                      <span className="dates-pill dates-pill-pending" title={pendingTooltip(p)}>
                        Awaiting approval
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                    {onInspect && (
                      <button
                        type="button"
                        className={`btn-row-info ${pending ? 'is-pending' : ''}`}
                        onClick={() => onInspect(p)}
                        aria-label={`View full details and test status for ${p.name}`}
                        title="View card details & lab test status"
                      >
                        <InfoIcon size={14} />
                      </button>
                    )}
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

function ReportsCards({ patients, dateColumn, getPdfUrl, onToast, waStates, access = FULL_ACCESS, waSettings, onPopup, onInspect }) {
  if (!patients.length) return null;

  return (
    <div className="patient-cards-grid">
      {patients.map((p) => {
        const isCorporate = p.patientType?.toLowerCase().includes('corp');
        const ready = isReportReady(p);
        const pending = isPendingReport(p);
        return (
          <article key={`${p.date}-${p.regNo}`} className={`pcard ${isCorporate ? 'is-corporate' : ''}`}>
            <header className="pcard-head">
              <div className="pcard-avatar" aria-hidden="true">{patientInitials(p.name)}</div>
              <div className="pcard-title">
                <h3 className="pcard-name" title={p.name}>{p.name}</h3>
                <div className="pcard-tags">
                  <span className={`type-badge ${isCorporate ? 'type-corporate' : 'type-general'}`}>
                    {p.patientType || 'General'}
                  </span>
                  {ready ? (
                    <span className="pcard-tag is-ready" title={`${p.dateCount} dates with approved lab tests`}>
                      {p.dateCount} lab date{p.dateCount === 1 ? '' : 's'}
                    </span>
                  ) : pending ? (
                    <span className="pcard-tag is-pending" title={pendingTooltip(p)}>
                      Pending · {p.approvedOrders ?? 0}/{p.totalOrders ?? '?'}
                    </span>
                  ) : (
                    <span className="pcard-tag" title={p.error || 'No completed laboratory test results in EMR'}>
                      {p.reportStatus === 'failed' ? 'Failed' : 'No lab data'}
                    </span>
                  )}
                </div>
              </div>
              {onInspect && (
                <button
                  type="button"
                  className={`pcard-info-btn ${pending ? 'is-pending' : ''}`}
                  onClick={() => onInspect(p)}
                  aria-label={`View full details and test status for ${p.name}`}
                  title="View full card details & lab test status"
                >
                  <InfoIcon size={16} />
                </button>
              )}
            </header>

            <div className="pcard-ids">
              <div className="pcard-id">
                <span className="pcard-label" title="Registration number">UHID</span>
                <CopyableChip value={p.regNo} label="UHID" className="pcard-id-value is-ip" onToast={onToast} />
              </div>
              <div className="pcard-id">
                <span className="pcard-label">Token</span>
                {p.tokenNo ? (
                  <CopyableChip value={p.tokenNo} label="Token" className="pcard-id-value" onToast={onToast} />
                ) : (
                  <span className="pcard-id-value text-muted">—</span>
                )}
              </div>
            </div>

            <div className="pcard-dept">
              <span className="pcard-dept-icon" aria-hidden="true">
                <WardIcon size={15} />
              </span>
              <div className="pcard-dept-text">
                <div className="pcard-dept-name">{p.department || 'General'}</div>
                {p.visitType && <div className="pcard-ward">{p.visitType}</div>}
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
                      <MobileWhatsAppStatus patient={p} waStates={waStates} />
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
                <dt><CalendarIcon size={13} />OP Date</dt>
                <dd>{p.date ? (dateColumn ? p.date : getHumanDate(p.date)) : '—'}</dd>
              </div>
            </dl>

            <footer className="pcard-actions">
              {/* Always one line, whichever state, so every card in a row keeps the same height. */}
              {ready ? (
                <div className="pcard-status is-approved" title="All active lab orders Result Approved">
                  <CheckIcon size={13} />
                  <span>
                    {p.totalOrders ? `${p.totalOrders} lab ${p.totalOrders === 1 ? 'order' : 'orders'} approved` : 'Lab report ready'}
                  </span>
                </div>
              ) : pending ? (
                <div className="pcard-status is-pending" title={pendingTooltip(p)}>
                  <ClockIcon size={13} />
                  <span>
                    Awaiting approval ({p.approvedOrders ?? 0}/{p.totalOrders ?? '?'} ready)
                  </span>
                </div>
              ) : (
                <div className="pcard-status" title={p.error || 'No completed laboratory orders found'}>
                  <span>{p.reportStatus === 'failed' ? 'Report generation failed' : 'No completed lab data'}</span>
                </div>
              )}
              <div className="pcard-buttons">
                {ready ? (
                  <>
                    <a
                      className="btn btn-view-pdf pcard-btn"
                      href={getPdfUrl(p)}
                      target="_blank"
                      rel="noreferrer"
                      title={`Open OP lab report for ${p.name}`}
                    >
                      <FilePdfIcon size={14} />
                      <span>Lab Report</span>
                    </a>
                    {access.reports?.showWhatsApp && (
                      <SendWhatsAppButton
                        date={p.date}
                        regNo={p.regNo}
                        name={p.name}
                        onToast={onToast}
                        patient={p}
                        waSettings={waSettings}
                        onPopup={onPopup}
                      />
                    )}
                  </>
                ) : pending ? (
                  <span className="btn pcard-btn is-empty" title={pendingTooltip(p)}>
                    <span>Awaiting approval</span>
                  </span>
                ) : (
                  <span className="btn pcard-btn is-empty" title={p.error || 'No completed laboratory test orders found in EMR'}>
                    <span>{p.reportStatus === 'failed' ? 'Failed' : 'No lab data'}</span>
                  </span>
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
            <h3 className="panel-title">Advanced OP Investigation Filter</h3>
            <p className="panel-subtitle">
              Filter OP visits by department, consulting doctor, visit type, token, patient type, or report date window.
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
        {/* Search anything — the quickest way to find one patient */}
        <div className="filter-card-section">
          <div className="enhanced-field search-anything-field">
            <label htmlFor="filter-any">Search anything</label>
            <div className="field-input-box">
              <input
                id="filter-any"
                value={filters.any || ''}
                onChange={set('any')}
                placeholder="Name, UHID, Token, Req No, Bill No, mobile (any format), doctor, address or town"
                className="filter-control"
                autoComplete="off"
              />
            </div>
            <small className="search-anything-hint">Searches every date (or the window below), best match first. Combine with any filter below.</small>
          </div>
        </div>

        {/* Section 1: Patient & Contact Identifiers */}
        <div className="filter-card-section">
          <div className="section-title-tag">
            <span className="tag-dot" />
            <span>Patient & Contact Identifiers</span>
          </div>

          <div className="filter-input-grid">
            <div className="enhanced-field">
              <label htmlFor="filter-reg">UHID / Reg No</label>
              <div className="field-input-box">
                <input
                  id="filter-reg"
                  value={filters.regNo}
                  onChange={set('regNo')}
                  placeholder="e.g. 4625656"
                  className="filter-control"
                />
              </div>
            </div>

            <div className="enhanced-field">
              <label htmlFor="filter-token">Token No</label>
              <div className="field-input-box">
                <input
                  id="filter-token"
                  value={filters.tokenNo}
                  onChange={set('tokenNo')}
                  placeholder="e.g. 12"
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
              <label htmlFor="filter-bill">Bill No</label>
              <div className="field-input-box">
                <input
                  id="filter-bill"
                  value={filters.billNo}
                  onChange={set('billNo')}
                  placeholder="Lab bill number"
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
            <span>Clinical & Visit Details</span>
          </div>

          <div className="filter-input-grid">
            <div className="enhanced-field">
              <label htmlFor="filter-dept">Department</label>
              <div className="field-input-box">
                <input
                  id="filter-dept"
                  value={filters.department}
                  onChange={set('department')}
                  placeholder="e.g. General Medicine"
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
              <label htmlFor="filter-visit">Visit Type</label>
              <div className="field-input-box">
                <input
                  id="filter-visit"
                  value={filters.visitType}
                  onChange={set('visitType')}
                  placeholder="e.g. New / Review"
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

        {/* Section 3: OP Period */}
        <div className="filter-card-section">
          <div className="section-header-flex">
            <div className="section-title-tag">
              <span className="tag-dot" />
              <span>OP Report Date Period</span>
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
              <label htmlFor="filter-from">OP From Date</label>
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
              <label htmlFor="filter-to">OP To Date</label>
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

export default function OpReports({ navRequest, access = FULL_ACCESS, refreshMs = LIVE_REFRESH_MS }) {
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
  // WhatsApp verification & not-on-WhatsApp state from WATI logs, paired with EMR whatsappNo.
  const [waStates, setWaStates] = useState(() => ({ notOnWhatsApp: new Set(), verified: new Set() }));
  // How many WhatsApp popups are open — the live refresh waits while any is.
  const popupsOpen = useRef(0);
  const onPopup = useCallback((open) => {
    popupsOpen.current = Math.max(0, popupsOpen.current + (open ? 1 : -1));
  }, []);
  const [detailPatient, setDetailPatient] = useState(null);
  const updatePatientRecord = useCallback((updated) => {
    if (!updated?.regNo || !updated?.date) return;
    setPatients((prev) =>
      prev.map((item) => (item.date === updated.date && item.regNo === updated.regNo ? { ...item, ...updated } : item)),
    );
  }, []);
  // Test / Live and "confirm the number before sending" for the WhatsApp buttons.
  const [waSettings, setWaSettings] = useState(null);
  const [unsentCount, setUnsentCount] = useState(0);
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkJob, setBulkJob] = useState(null);
  const [bulkError, setBulkError] = useState('');
  const bulkWasRunning = useRef(false);
  useEffect(() => {
    fetchWatiSettings()
      .then(setWaSettings)
      .catch(() => { });
  }, []);
  useEffect(() => {
    if (!bulkConfirming) return undefined;
    onPopup(true);
    return () => onPopup(false);
  }, [bulkConfirming, onPopup]);

  // The AI assistant can open this screen at a date, with the list filtered.
  useEffect(() => {
    if (navRequest?.view !== 'reports') return;
    setMode('date');
    if (navRequest.date) setDate(navRequest.date);
    setFilterText(navRequest.filter || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navRequest?.id]);
  const [categoryFilter, setCategoryFilter] = useState('all'); // 'all' | 'lab' | 'pending' | 'nolab' | 'corporate'

  // Audit log: which day's list was looked at, and filters used.
  useEffect(() => {
    if (mode === 'date') track('date_change', { screen: 'reports', details: { date } });
  }, [date, mode]);
  useEffect(() => {
    if (!filterText.trim()) return undefined;
    const t = setTimeout(() => track('filter_change', { screen: 'reports', details: { summary: `searched “${filterText.trim().slice(0, 60)}”` } }), 1500);
    return () => clearTimeout(t);
  }, [filterText]);
  const firstCategory = useRef(true);
  useEffect(() => {
    if (firstCategory.current) {
      firstCategory.current = false;
      return;
    }
    track('filter_change', { screen: 'reports', details: { summary: `category: ${categoryFilter}` } });
  }, [categoryFilter]);
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

  useEffect(() => {
    fetchWhatsappNumberStates()
      .then(setWaStates)
      .catch(() => { });
  }, [lastRefreshedAt]);

  const refreshUnsentCount = useCallback((forDate) => {
    fetchUnsentWhatsAppCount(forDate)
      .then((res) => {
        setUnsentCount(res?.count || 0);
        setBulkJob(res?.job || null);
      })
      .catch(() => setUnsentCount(0));
  }, []);

  useEffect(() => {
    if (mode !== 'date' || !waSettings?.liveEnabled) {
      setUnsentCount(0);
      setBulkJob(null);
      return;
    }
    refreshUnsentCount(date);
  }, [mode, date, lastRefreshedAt, waSettings?.liveEnabled, refreshUnsentCount]);

  // `quiet` (the 20-second live refresh): swap the data in place — no spinner,
  // the list stays mounted, so an open WhatsApp popup, the page you're on, the
  // scroll position and each button's "sent" tick all survive the refresh.
  const loadByDate = useCallback((forDate, { quiet = false } = {}) => {
    if (!quiet) {
      setLoading(true);
      setError('');
    }
    fetchReportsForDate(forDate)
      .then((rows) => {
        setPatients(rows);
        setLastRefreshedAt(Date.now());
        if (!quiet) setCurrentPage(1);
      })
      .catch((err) => !quiet && setError(err.message))
      .finally(() => !quiet && setLoading(false));
  }, []);

  useEffect(() => {
    if (bulkJob?.running) {
      bulkWasRunning.current = true;
      if (mode !== 'date') return undefined;
      const t = setInterval(() => refreshUnsentCount(date), 2500);
      return () => clearInterval(t);
    }
    if (bulkWasRunning.current && bulkJob && !bulkJob.running) {
      bulkWasRunning.current = false;
      const parts = [`Sent ${bulkJob.sent || 0}`];
      if (bulkJob.failed) parts.push(`${bulkJob.failed} failed`);
      if (bulkJob.skipped) parts.push(`${bulkJob.skipped} skipped`);
      if (bulkJob.stoppedReason) parts.push(bulkJob.stoppedReason);
      showToast(`Bulk WhatsApp complete: ${parts.join(' · ')}`);
      if (mode === 'date') loadByDate(date, { quiet: true });
    }
    return undefined;
  }, [bulkJob, mode, date, refreshUnsentCount, loadByDate, showToast]);

  const runSearch = useCallback(({ quiet = false } = {}) => {
    if (!quiet) {
      setLoading(true);
      setError('');
    }
    setSearchActive(true);
    searchReports(filtersRef.current)
      .then((rows) => {
        setPatients(rows);
        setLastRefreshedAt(Date.now());
        if (!quiet) setCurrentPage(1);
      })
      .catch((err) => !quiet && setError(err.message))
      .finally(() => !quiet && setLoading(false));
  }, []);

  function refreshCurrentView() {
    if (mode === 'date') loadByDate(date);
    else if (searchActive) runSearch();
  }

  function refreshStatus() {
    fetchReportStatus()
      .then(setStatus)
      .catch(() => { });
  }

  useEffect(() => {
    if (mode === 'date') loadByDate(date);
  }, [mode, date, loadByDate]);

  // Live auto-refresh: keep whatever's on screen current without manual reload —
  // quietly, and not at all while a WhatsApp popup is open or the tab is hidden.
  useEffect(() => {
    const id = setInterval(() => {
      if (popupsOpen.current > 0 || document.hidden) return;
      if (mode === 'date') loadByDate(date, { quiet: true });
      else if (searchActive) runSearch({ quiet: true });
    }, refreshMs);
    return () => clearInterval(id);
  }, [mode, date, searchActive, loadByDate, runSearch, refreshMs]);

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
        summary?.error
          ? `Check failed: ${summary.error}`
          : summary?.found !== undefined
            ? `OP lab check complete: ${summary.found} patients checked`
            : 'OP lab check completed successfully'
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

  // Nothing on this date matches the filter box — look across every date instead.
  function searchAllDates(text) {
    const next = { ...EMPTY_FILTERS, any: text.trim() };
    setFilters(next);
    filtersRef.current = next;
    setMode('search');
    setFilterText('');
    setCategoryFilter('all');
    setCurrentPage(1);
    track('filter_change', { screen: 'reports', details: { summary: `searched all dates for “${text.trim().slice(0, 60)}”` } });
    runSearch();
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
    let pending = 0;
    let noLab = 0;
    let corporate = 0;
    patients.forEach((p) => {
      if (isReportReady(p)) lab++;
      else if (isPendingReport(p)) pending++;
      else noLab++;
      if (p.patientType?.toLowerCase().includes('corp')) corporate++;
    });
    return { all: patients.length, lab, pending, noLab, corporate };
  }, [patients]);

  // Quick in-page client filter: Category + Text filter across all key fields
  const filteredPatients = useMemo(() => {
    let list = patients;

    if (categoryFilter === 'lab') {
      list = list.filter((p) => isReportReady(p));
    } else if (categoryFilter === 'pending') {
      list = list.filter((p) => isPendingReport(p));
    } else if (categoryFilter === 'nolab') {
      list = list.filter((p) => !isReportReady(p) && !isPendingReport(p));
    } else if (categoryFilter === 'corporate') {
      list = list.filter((p) => p.patientType?.toLowerCase().includes('corp'));
    }

    if (!filterText.trim()) return list;
    // Any value: name (any order), UHID, token, Req No, Bill No, mobile in any format, doctor, town …
    return list.filter(patientMatcher(filterText));
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

  const bulkActive = bulkSending || Boolean(bulkJob?.running);

  async function handleBulkSend() {
    setBulkSending(true);
    setBulkError('');
    try {
      const res = await sendUnsentReportsWhatsApp(date);
      setBulkConfirming(false);
      if (res?.job) setBulkJob(res.job);
      refreshUnsentCount(date);
      if (res?.started) {
        bulkWasRunning.current = true;
        showToast(`Sending ${res.total} unsent report${res.total === 1 ? '' : 's'} in the background…`);
      } else {
        showToast('No unsent ready reports left for this date');
      }
    } catch (err) {
      setBulkError(err.message);
    } finally {
      setBulkSending(false);
    }
  }

  return (
    <div className="discharge-reports-page">
      <ToastNotification toast={toast} onDismiss={() => setToast(null)} />
      {bulkConfirming &&
        createPortal(
          <div className="um-modal-backdrop" onMouseDown={() => !bulkSending && setBulkConfirming(false)}>
            <div className="um-modal wa-send" role="alertdialog" aria-label="Send unsent reports on WhatsApp" onMouseDown={(e) => e.stopPropagation()}>
              <h3>Send unsent WhatsApp reports?</h3>
              <p>
                This will send <strong>{unsentCount}</strong> ready OP lab report{unsentCount === 1 ? '' : 's'} for{' '}
                <strong>{getHumanDate(date)}</strong> directly to each patient&apos;s mobile number in <strong>Live mode</strong>.
              </p>
              <p className="wa-send-note">
                Reports already sent in Live mode (or already queued/failed) are skipped automatically.
              </p>
              {bulkError && <div className="wa-send-error is-block">{bulkError}</div>}
              <div className="um-modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setBulkConfirming(false)} disabled={bulkSending}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary wa-send-btn" onClick={handleBulkSend} disabled={bulkSending}>
                  {bulkSending ? 'Sending…' : `Send ${unsentCount} report${unsentCount === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <div className="section-header reports-header">
        <div>
          <h2>OP Lab Investigation Reports</h2>
          <p className="section-subtitle">
            Automated OP lab investigation reports generated once all active orders for the patient are Result Approved.
          </p>
        </div>
      </div>

      <AutomationStatus status={status} onRunNow={handleRunNow} running={running} canRun={access.reports.canRun} />

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
                aria-label="Select OP report date"
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
                placeholder="Search name, UHID, token, mobile, doctor, dept, town… (Press /)"
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
          <div className="empty-title">No OP lab reports for {date}</div>
          <p className="empty-subtitle">
            OP investigation reports generate automatically once all active lab orders are Result Approved in the EMR. Click "Check Now" above to trigger a fresh query.
          </p>
        </div>
      )}

      {!loading && !error && mode === 'search' && !searchActive && (
        <div className="empty modern-empty search-guide-empty">
          <div className="empty-icon">🔍</div>
          <div className="empty-title">Advanced OP Query Ready</div>
          <p className="empty-subtitle">
            Set your target criteria above (UHID, Token No, Patient Name, Consulting Doctor, or Date Window) and click <strong>Execute Patient Search</strong>.
          </p>
        </div>
      )}

      {!loading && !error && mode === 'search' && searchActive && patients.length === 0 && (
        <div className="empty modern-empty">
          <div className="empty-icon">📋</div>
          <div className="empty-title">No Matching Records Found</div>
          <p className="empty-subtitle">Try adjusting your filters or broadening the OP report date range.</p>
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
              title="Filter to patients with OP lab reports ready"
            >
              <span>📋 Lab Ready</span>
              <span className="cat-count-badge">{categoryCounts.lab}</span>
            </button>
            {categoryCounts.pending > 0 && (
              <button
                type="button"
                className={`cat-chip cat-chip-pending ${categoryFilter === 'pending' ? 'active' : ''}`}
                onClick={() => handleCategoryFilterChange('pending')}
                title="Filter to patients waiting for all lab orders to be Result Approved"
              >
                <span>⏳ Pending Approval</span>
                <span className="cat-count-badge">{categoryCounts.pending}</span>
              </button>
            )}
            <button
              type="button"
              className={`cat-chip cat-chip-nolab ${categoryFilter === 'nolab' ? 'active' : ''}`}
              onClick={() => handleCategoryFilterChange('nolab')}
              title="Filter to patients with no completed lab data"
            >
              <span>No Lab Data</span>
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
            {mode === 'date' && access.reports.showWhatsApp && waSettings?.liveEnabled && (unsentCount > 0 || bulkActive) && (
              <button
                type="button"
                className="btn btn-send-whatsapp"
                style={{ marginLeft: 'auto' }}
                disabled={bulkActive}
                onClick={() => {
                  setBulkError('');
                  setBulkConfirming(true);
                }}
                title="Send all ready reports for this date that have not been sent in Live mode yet"
              >
                <WhatsAppIcon size={15} />
                <span>
                  {bulkJob?.running
                    ? `Sending ${bulkJob.processed || 0}/${bulkJob.total || unsentCount}…`
                    : bulkSending
                      ? 'Starting…'
                      : `Send ${unsentCount} unsent`}
                </span>
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
              <div className="filter-empty-actions">
                {mode === 'date' && filterText.trim() && (
                  <button type="button" className="btn btn-primary" onClick={() => searchAllDates(filterText)}>
                    <SearchIcon size={14} /> Search all dates for “{filterText.trim().slice(0, 30)}”
                  </button>
                )}
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
            </div>
          ) : (
            <>
              {/* Conditional rendering based on layout toggle */}
              {viewLayout === 'cards' ? (
                <ReportsCards
                  patients={paginatedPatients}
                  dateColumn={mode === 'search'}
                  getPdfUrl={(p) => reportPdfUrl(p.date, p.regNo)}
                  onToast={showToast}
                  waStates={waStates}
                  access={access}
                  waSettings={waSettings}
                  onPopup={onPopup}
                  onInspect={setDetailPatient}
                />
              ) : (
                <>
                  <div className="responsive-table-view">
                    <ReportsTable
                      patients={paginatedPatients}
                      dateColumn={mode === 'search'}
                      getPdfUrl={(p) => reportPdfUrl(p.date, p.regNo)}
                      onToast={showToast}
                      waStates={waStates}
                      access={access}
                      waSettings={waSettings}
                      onPopup={onPopup}
                      onInspect={setDetailPatient}
                    />
                  </div>
                  <div className="responsive-cards-view">
                    <ReportsCards
                      patients={paginatedPatients}
                      dateColumn={mode === 'search'}
                      getPdfUrl={(p) => reportPdfUrl(p.date, p.regNo)}
                      onToast={showToast}
                      waStates={waStates}
                      access={access}
                      waSettings={waSettings}
                      onPopup={onPopup}
                      onInspect={setDetailPatient}
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

      <PatientDetailsDialog
        patient={detailPatient}
        onClose={() => setDetailPatient(null)}
        onPopup={onPopup}
        onToast={showToast}
        onRecordUpdated={updatePatientRecord}
      />
    </div>
  );
}
