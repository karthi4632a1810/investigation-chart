import { useEffect, useState } from 'react';
import {
  defaultDateOnly,
  fetchReportsForDate,
  fetchReportStatus,
  reportPdfUrl,
  triggerReportRun,
} from '../api/client';

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

function summaryText(summary) {
  if (!summary) return null;
  if (summary.error) return `failed: ${summary.error}`;
  const parts = [`${summary.found} found`];
  if (summary.generated) parts.push(`${summary.generated} generated`);
  if (summary.alreadyReported) parts.push(`${summary.alreadyReported} already had a report`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  return parts.join(', ');
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
  const lastText = summaryText(status.lastSummary);

  return (
    <div className="automation-card">
      <div className={`automation-dot ${checking ? 'checking' : 'idle'}`} />
      <div className="automation-body">
        <div className="automation-primary">
          {checking ? (
            <>Checking for new discharges now…</>
          ) : msToNext !== null ? (
            <>
              Next automatic check in <span className="automation-countdown">{formatCountdown(msToNext)}</span>
            </>
          ) : (
            'Automation starting…'
          )}
        </div>
        {lastText && (
          <div className="automation-secondary">
            Last check{lastAgo ? ` (${lastAgo})` : ''}: {lastText}
          </div>
        )}
      </div>
      <button type="button" className="btn secondary" onClick={onRunNow} disabled={running || checking}>
        {running || checking ? 'Checking…' : 'Check now'}
      </button>
    </div>
  );
}

export default function DischargeReports() {
  const [date, setDate] = useState(defaultDateOnly());
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState(null);

  function load(forDate) {
    setLoading(true);
    setError('');
    fetchReportsForDate(forDate)
      .then(setPatients)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  function refreshStatus() {
    fetchReportStatus()
      .then(setStatus)
      .catch(() => {});
  }

  useEffect(() => {
    load(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

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
      if (summary.date === date) load(date);
    } catch (err) {
      setStatus((prev) => ({ ...prev, lastSummary: { error: err.message } }));
    } finally {
      setRunning(false);
      refreshStatus();
    }
  }

  return (
    <div>
      <div className="section-header">
        <h2>Discharge Reports</h2>
        <p className="section-subtitle">Investigation charts generated automatically when patients are discharged.</p>
      </div>

      <AutomationStatus status={status} onRunNow={handleRunNow} running={running} />

      <div className="reports-toolbar">
        <label className="reports-date-field">
          <span>Discharge date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>

      {loading && (
        <div className="loading">
          <div className="spinner"></div>
          <div>Loading reports…</div>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {!loading && !error && patients.length === 0 && (
        <div className="empty">No discharge reports generated for {date} yet.</div>
      )}

      {!loading && patients.length > 0 && (
        <>
          <div className="result-count">{patients.length} report(s) for {date}.</div>
          <div className="table-wrap">
            <table className="results">
              <thead>
                <tr>
                  <th>IP No</th>
                  <th>Patient Name</th>
                  <th>Ward / Unit</th>
                  <th>Admission</th>
                  <th>Discharge</th>
                  <th>Dates in Report</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {patients.map((p) => (
                  <tr key={p.ipNo}>
                    <td>{p.ipNo}</td>
                    <td>{p.name}</td>
                    <td>
                      {p.ward}
                      {p.unit ? ` / ${p.unit}` : ''}
                    </td>
                    <td>{p.admissionDate}</td>
                    <td>{p.dischargeDate}</td>
                    <td>{p.dateCount}</td>
                    <td>
                      <a
                        className="btn pdf-link"
                        href={reportPdfUrl(date, p.ipNo)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        📄 View PDF
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
