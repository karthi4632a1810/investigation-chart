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
  ChevronLeftIcon,
  ChevronRightIcon,
  DoctorIcon,
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

/** Self-contained so each row tracks its own send state independently. */
function SendWhatsAppButton({ date, ipNo, name }) {
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [error, setError] = useState('');

  async function handleClick() {
    if (status === 'sending') return;
    setStatus('sending');
    setError('');
    try {
      await sendReportWhatsApp(date, ipNo);
      setStatus('sent');
    } catch (err) {
      setStatus('error');
      setError(err.message);
    }
  }

  if (status === 'sent') {
    return (
      <span className="btn btn-whatsapp-sent" title="WhatsApp message sent">
        <WhatsAppIcon size={15} />
        <span>Sent</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="btn btn-send-whatsapp"
      onClick={handleClick}
      disabled={status === 'sending'}
      title={status === 'error' ? `Failed: ${error} — click to retry` : `Send investigation report to ${name} via WhatsApp`}
    >
      <WhatsAppIcon size={15} />
      <span>{status === 'sending' ? 'Sending…' : status === 'error' ? 'Retry' : 'Send WhatsApp'}</span>
    </button>
  );
}

function ReportsTable({ patients, dateColumn, getPdfUrl, getSummaryPdfUrl }) {
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
                  <span className="code-chip code-chip-ip">{p.ipNo}</span>
                </td>
                <td className="cell-reg">
                  <span className="code-chip code-chip-reg">{p.regNo}</span>
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
                    <a href={`tel:${p.mobile}`} className="tel-link">
                      <PhoneIcon size={12} />
                      <span>{p.mobile}</span>
                    </a>
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
                    <span className="dates-pill" title={`${p.dateCount} dates with lab orders`}>
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
                    {p.hasSummary && (
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
                    )}
                    {p.dateCount !== undefined && (
                      <SendWhatsAppButton date={p.date} ipNo={p.ipNo} name={p.name} />
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

function ReportsCards({ patients, dateColumn, getPdfUrl, getSummaryPdfUrl }) {
  if (!patients.length) return null;

  return (
    <div className="patient-cards-grid">
      {patients.map((p) => {
        const isCorporate = p.patientType?.toLowerCase().includes('corp');
        const hasLab = p.dateCount !== undefined;
        return (
          <div key={`${p.date}-${p.ipNo}`} className="patient-mobile-card">
            <div className="card-top-header">
              <div className="card-patient-info">
                <div className="card-patient-name">{p.name}</div>
                <div className="card-patient-chips">
                  <span className={`type-badge ${isCorporate ? 'type-corporate' : 'type-general'}`}>
                    {p.patientType || 'General'}
                  </span>
                  {dateColumn && <span className="card-date-chip">{p.date}</span>}
                </div>
              </div>
              <div className="action-btn-group">
                {hasLab && (
                  <a
                    className="btn btn-view-pdf btn-card-pdf"
                    href={getPdfUrl(p)}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open lab report for ${p.name}`}
                  >
                    <FilePdfIcon size={15} />
                    <span>Lab</span>
                  </a>
                )}
                {p.hasSummary && (
                  <a
                    className="btn btn-view-summary btn-card-pdf"
                    href={getSummaryPdfUrl(p)}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open discharge summary for ${p.name}`}
                  >
                    <FilePdfIcon size={15} />
                    <span>Summary</span>
                  </a>
                )}
                {hasLab && <SendWhatsAppButton date={p.date} ipNo={p.ipNo} name={p.name} />}
              </div>
            </div>

            <div className="card-id-strip">
              <div className="card-id-col">
                <span className="card-id-label">IP NO</span>
                <span className="code-chip code-chip-ip">{p.ipNo}</span>
              </div>
              <div className="card-id-col">
                <span className="card-id-label">UHID (REG NO)</span>
                <span className="code-chip code-chip-reg">{p.regNo}</span>
              </div>
              <div className="card-id-col">
                <span className="card-id-label">LAB DATES</span>
                {hasLab ? (
                  <span className="dates-pill">{p.dateCount} date{p.dateCount === 1 ? '' : 's'}</span>
                ) : (
                  <span className="text-muted">no lab data</span>
                )}
              </div>
            </div>

            <div className="card-details-grid">
              <div className="card-detail-item">
                <DoctorIcon size={14} className="doctor-icon-dim" />
                <div>
                  <span className="detail-label">Doctor</span>
                  <span className="detail-value">{p.doctor || '—'}</span>
                </div>
              </div>

              <div className="card-detail-item">
                <WardIcon size={14} className="ward-icon-dim" />
                <div>
                  <span className="detail-label">Department & Ward</span>
                  <span className="detail-value">{p.department} · {p.ward}</span>
                </div>
              </div>

              <div className="card-detail-item">
                <PhoneIcon size={14} />
                <div>
                  <span className="detail-label">Mobile</span>
                  <span className="detail-value">
                    {p.mobile ? <a href={`tel:${p.mobile}`} className="tel-link">{p.mobile}</a> : '—'}
                  </span>
                </div>
              </div>

              <div className="card-detail-item">
                <UserIcon size={14} />
                <div>
                  <span className="detail-label">Created User</span>
                  <span className="detail-value">{p.createdUser || '—'}</span>
                </div>
              </div>
            </div>

            <div className="card-action-bar">
              {hasLab && (
                <a
                  className="btn btn-view-pdf btn-card-full-pdf"
                  href={getPdfUrl(p)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <FilePdfIcon size={16} />
                  <span>View Full Investigation PDF</span>
                </a>
              )}
              {p.hasSummary && (
                <a
                  className="btn btn-view-summary btn-card-full-pdf"
                  href={getSummaryPdfUrl(p)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <FilePdfIcon size={16} />
                  <span>View Discharge Summary</span>
                </a>
              )}
            </div>
          </div>
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

export default function DischargeReports() {
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
  const [viewLayout, setViewLayout] = useState('auto'); // 'auto' | 'table' | 'cards'
  const [filterText, setFilterText] = useState('');

  // Pagination State: 50 is default, options: 50, 100, 'all'
  const [pageSize, setPageSize] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;

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

  async function handleRunNow() {
    setRunning(true);
    try {
      const summary = await triggerReportRun();
      setStatus((prev) => ({ ...prev, lastSummary: summary, lastCheckFinishedAt: new Date().toISOString() }));
      refreshCurrentView();
    } catch (err) {
      setStatus((prev) => ({ ...prev, lastSummary: { error: err.message } }));
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
    setCurrentPage(1);
    if (nextMode === 'search') setSearchActive(false);
  }

  function handleClearFilters() {
    setFilters(EMPTY_FILTERS);
    setSearchActive(false);
    setPatients([]);
    setFilterText('');
    setCurrentPage(1);
  }

  function handleFilterTextChange(e) {
    setFilterText(e.target.value);
    setCurrentPage(1);
  }

  function handlePageSizeChange(newSize) {
    setPageSize(newSize);
    setCurrentPage(1);
  }

  // Quick in-page client filter: Instant lookup by name, IP, doctor, ward
  const filteredPatients = useMemo(() => {
    if (!filterText.trim()) return patients;
    const q = filterText.toLowerCase();
    return patients.filter((p) => {
      return (
        p.name?.toLowerCase().includes(q) ||
        p.ipNo?.toLowerCase().includes(q) ||
        p.regNo?.toLowerCase().includes(q) ||
        p.doctor?.toLowerCase().includes(q) ||
        p.department?.toLowerCase().includes(q) ||
        p.ward?.toLowerCase().includes(q) ||
        p.mobile?.includes(q)
      );
    });
  }, [patients, filterText]);

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
              title="Previous day"
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
            </div>

            <button
              type="button"
              className="btn btn-stepper"
              onClick={() => setDate((prev) => adjustDateByDays(prev, 1))}
              title="Next day"
            >
              <span className="hide-on-mobile">Next</span>
              <ChevronRightIcon size={16} />
            </button>

            <button
              type="button"
              className="btn btn-stepper-today"
              onClick={() => setDate(defaultDateOnly())}
              title="Reset to today"
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
                placeholder="Filter by name, IP, doctor, ward…"
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
                  title="Clear filter"
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
                className={`btn-layout-toggle ${viewLayout === 'auto' || viewLayout === 'table' ? 'active' : ''}`}
                onClick={() => setViewLayout('table')}
                title="Table view"
              >
                <TableViewIcon size={16} />
                <span className="hide-on-mobile">Table</span>
              </button>
              <button
                type="button"
                className={`btn-layout-toggle ${viewLayout === 'cards' ? 'active' : ''}`}
                onClick={() => setViewLayout('cards')}
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
          {/* Top Pagination Summary & Page Size Controls */}
          <div className="results-meta-bar">
            <div className="result-count-badge">
              <strong>{totalCount}</strong> {totalCount === 1 ? 'report' : 'reports'} found
              {filterText && <span> (filtered from {patients.length})</span>}
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

          {/* Conditional rendering based on layout toggle */}
          {viewLayout === 'cards' ? (
            <ReportsCards
              patients={paginatedPatients}
              dateColumn={mode === 'search'}
              getPdfUrl={(p) => reportPdfUrl(p.date, p.ipNo)}
              getSummaryPdfUrl={(p) => reportSummaryPdfUrl(p.date, p.ipNo)}
            />
          ) : (
            <>
              {/* On desktop: show modern table without vertical scroll; on small screens CSS switches to cards */}
              <div className="responsive-table-view">
                <ReportsTable
                  patients={paginatedPatients}
                  dateColumn={mode === 'search'}
                  getPdfUrl={(p) => reportPdfUrl(p.date, p.ipNo)}
              getSummaryPdfUrl={(p) => reportSummaryPdfUrl(p.date, p.ipNo)}
                />
              </div>
              <div className="responsive-cards-view">
                <ReportsCards
                  patients={paginatedPatients}
                  dateColumn={mode === 'search'}
                  getPdfUrl={(p) => reportPdfUrl(p.date, p.ipNo)}
              getSummaryPdfUrl={(p) => reportSummaryPdfUrl(p.date, p.ipNo)}
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
        </div>
      )}
    </div>
  );
}
