import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { fetchReportDetails, reportPdfUrl } from '../api/client';
import {
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  DoctorIcon,
  FilePdfIcon,
  FlaskIcon,
  PhoneIcon,
  RefreshIcon,
  UserIcon,
  WardIcon,
} from './Icons';

function formatTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function CopyChip({ value, label, onToast }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-muted">—</span>;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied(true);
      onToast?.(`Copied ${label}: ${value}`, 'success');
      setTimeout(() => setCopied(false), 1200);
    } catch {
      onToast?.(`Could not copy ${label}`, 'error');
    }
  }

  return (
    <button
      type="button"
      className="pdetail-copy-btn"
      onClick={handleCopy}
      aria-label={`Copy ${label} ${value}`}
      title={`Copy ${label}`}
    >
      <span>{value}</span>
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
    </button>
  );
}

/**
 * Accessible native modal `<dialog>` displaying complete OP visit details and every
 * lab test color-coded by approval state (green for RESULT APPROVED, yellow-orange
 * for pending orders). Opens with `showModal()` and supports `Esc` + light-dismiss.
 */
export default function PatientDetailsDialog({ patient, onClose, onPopup, onToast, onRecordUpdated }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [testFilter, setTestFilter] = useState('all'); // 'all' | 'pending' | 'done'

  const activePatient = detail || patient;

  const loadLive = useCallback(
    async (date, regNo, refresh = false) => {
      if (!date || !regNo) return;
      setLoading(true);
      setError('');
      try {
        const res = await fetchReportDetails(date, regNo, { refresh });
        if (res?.patient) {
          setDetail(res.patient);
          onRecordUpdated?.(res.patient);
        }
        if (res?.refreshWarning) {
          setError(res.refreshWarning);
        }
      } catch (err) {
        setError(err.message || 'Could not load live test breakdown');
      } finally {
        setLoading(false);
      }
    },
    [onRecordUpdated],
  );

  // Open / close native modal cleanly and inform parent so auto-refresh pauses.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    if (patient) {
      setDetail(patient);
      setError('');
      setTestFilter('all');
      if (!dialog.open) dialog.showModal();
      onPopup?.(true);
      if (!Array.isArray(patient.tests)) {
        loadLive(patient.date, patient.regNo, false);
      }
      return () => onPopup?.(false);
    }

    setDetail(null);
    if (dialog.open) dialog.close();
    return undefined;
    // Key on date + regNo so reopening / switching patients resets cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patient?.date, patient?.regNo]);

  // Fallback light-dismiss for browsers lacking native `<dialog closedby="any">`.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || 'closedBy' in HTMLDialogElement.prototype) return undefined;

    const outside = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    const onPointerDown = (e) => {
      pressedOutside = outside(e);
    };
    const onPointerUp = (e) => {
      if (pressedOutside && outside(e) && dialog.open) dialog.close();
      pressedOutside = false;
    };
    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointerup', onPointerUp);
    return () => {
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  function requestClose() {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    else onClose?.();
  }

  const tests = useMemo(() => {
    if (Array.isArray(activePatient?.tests) && activePatient.tests.length) {
      return activePatient.tests;
    }
    if (Array.isArray(activePatient?.procedures) && activePatient.procedures.length && activePatient?.reportStatus === 'ready') {
      return activePatient.procedures.map((name, idx) => ({
        reqNo: activePatient.reqNos?.[idx] || activePatient.reqNos?.[0] || '',
        name,
        status: 'RESULT APPROVED',
        approved: true,
      }));
    }
    return [];
  }, [activePatient]);

  const doneTests = useMemo(() => tests.filter((t) => t.approved), [tests]);
  const pendingTests = useMemo(() => tests.filter((t) => !t.approved), [tests]);

  const visibleTests = useMemo(() => {
    if (testFilter === 'pending') return pendingTests;
    if (testFilter === 'done') return doneTests;
    return tests;
  }, [testFilter, tests, pendingTests, doneTests]);

  const totalCount = activePatient?.totalOrders ?? tests.length;
  const approvedCount = activePatient?.approvedOrders ?? doneTests.length;
  const pendingCount = activePatient?.pendingOrders ?? Math.max(0, totalCount - approvedCount);
  const progressPct = totalCount > 0 ? Math.round((approvedCount / totalCount) * 100) : 0;

  const ready = activePatient?.reportStatus === 'ready' || (activePatient?.reportStatus === undefined && activePatient?.dateCount !== undefined);
  const pending = activePatient?.reportStatus === 'pending';
  const isCorporate = activePatient?.patientType?.toLowerCase().includes('corp');
  const emrAgeGender = [activePatient?.age, activePatient?.gender].filter(Boolean).join(' · ') || activePatient?.emr?.['AGE / GENDER'] || '';
  const areaCity = activePatient?.city || activePatient?.emr?.['AREA / VILLAGE'] || '';

  return (
    <dialog
      ref={dialogRef}
      className="pdetail-dialog"
      closedby="any"
      aria-labelledby={titleId}
      onClose={() => onClose?.()}
    >
      {activePatient && (
        <div className="pdetail-shell">
          <header className="pdetail-head">
            <div className="pdetail-head-main">
              <div className="pdetail-avatar" aria-hidden="true">
                {String(activePatient.name || '?')
                  .replace(/^(?:baby\s+of|mrs|mr|ms|miss|master|baby|dr|smt|shri|sri)\b\.?\s*/i, '')
                  .trim()
                  .charAt(0)
                  .toUpperCase() || '?'}
              </div>
              <div className="pdetail-head-text">
                <h2 id={titleId} className="pdetail-title">{activePatient.name || 'Patient Details'}</h2>
                <div className="pdetail-badges">
                  <span className={`type-badge ${isCorporate ? 'type-corporate' : 'type-general'}`}>
                    {activePatient.patientType || 'General'}
                  </span>
                  {ready ? (
                    <span className="pdetail-status-pill is-done">
                      <CheckIcon size={12} />
                      <span>All {approvedCount}/{totalCount || approvedCount} Approved</span>
                    </span>
                  ) : pending ? (
                    <span className="pdetail-status-pill is-pending">
                      <ClockIcon size={12} />
                      <span>Awaiting approval · {approvedCount}/{totalCount || '?'} ready</span>
                    </span>
                  ) : (
                    <span className="pdetail-status-pill is-neutral">
                      {activePatient.reportStatus === 'failed' ? 'Generation failed' : 'No lab data'}
                    </span>
                  )}
                  {emrAgeGender && <span className="pdetail-meta-pill">{emrAgeGender}</span>}
                </div>
              </div>
            </div>

            <div className="pdetail-head-actions">
              <button
                type="button"
                className="pdetail-icon-btn"
                onClick={() => loadLive(activePatient.date, activePatient.regNo, true)}
                disabled={loading}
                aria-busy={loading}
                aria-label="Refresh live test status from EMR"
                title="Refresh live status from EMR"
              >
                <RefreshIcon size={15} spinning={loading} />
              </button>
              <button
                type="button"
                className="pdetail-icon-btn is-close"
                onClick={requestClose}
                aria-label="Close patient details"
                title="Close"
              >
                <CloseIcon size={16} />
              </button>
            </div>
          </header>

          <div className="pdetail-body">
            {/* Full Card Metadata Grid */}
            <section className="pdetail-section" aria-label="Patient visit information">
              <div className="pdetail-info-grid">
                <div className="pdetail-kv">
                  <span className="pdetail-k">UHID</span>
                  <div className="pdetail-v">
                    <CopyChip value={activePatient.regNo} label="UHID" onToast={onToast} />
                  </div>
                </div>
                <div className="pdetail-kv">
                  <span className="pdetail-k">Token No</span>
                  <div className="pdetail-v">
                    <CopyChip value={activePatient.tokenNo} label="Token" onToast={onToast} />
                  </div>
                </div>
                <div className="pdetail-kv">
                  <span className="pdetail-k"><CalendarIcon size={12} /> OP Date</span>
                  <div className="pdetail-v">{activePatient.visitDate || activePatient.date || '—'}</div>
                </div>
                <div className="pdetail-kv">
                  <span className="pdetail-k"><WardIcon size={12} /> Department / Visit</span>
                  <div className="pdetail-v">
                    <strong>{activePatient.department || 'General'}</strong>
                    {activePatient.visitType ? ` · ${activePatient.visitType}` : ''}
                  </div>
                </div>
                <div className="pdetail-kv">
                  <span className="pdetail-k"><DoctorIcon size={12} /> Doctor</span>
                  <div className="pdetail-v">{activePatient.doctor || '—'}</div>
                </div>
                <div className="pdetail-kv">
                  <span className="pdetail-k"><PhoneIcon size={12} /> Mobile</span>
                  <div className="pdetail-v">
                    {activePatient.mobile ? (
                      <span className="pdetail-mobile-wrap">
                        <a href={`tel:+91${activePatient.mobile}`}>+91 {activePatient.mobile}</a>
                        <CopyChip value={`+91${activePatient.mobile}`} label="Mobile" onToast={onToast} />
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </div>
                </div>
                <div className="pdetail-kv">
                  <span className="pdetail-k"><UserIcon size={12} /> Created by</span>
                  <div className="pdetail-v pdetail-mono">{activePatient.createdUser || '—'}</div>
                </div>
                <div className="pdetail-kv">
                  <span className="pdetail-k">Order / Bill No</span>
                  <div className="pdetail-v pdetail-mono">
                    {[
                      activePatient.reqNos?.length ? `Req: ${activePatient.reqNos.join(', ')}` : '',
                      activePatient.billNos?.length ? `Bill: ${activePatient.billNos.join(', ')}` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </div>
                </div>
                {(activePatient.corporate || areaCity || activePatient.updatedAt) && (
                  <div className="pdetail-kv is-wide">
                    <span className="pdetail-k">Additional Details</span>
                    <div className="pdetail-v">
                      {[
                        activePatient.corporate ? `Corporate: ${activePatient.corporate}` : '',
                        areaCity ? `Place: ${areaCity}` : '',
                        activePatient.updatedAt ? `Checked: ${formatTimestamp(activePatient.updatedAt)}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Approval Progress + Per-Test Status Section */}
            <section className="pdetail-section" aria-label="Laboratory tests status">
              <div className="pdetail-tests-head">
                <div className="pdetail-tests-title">
                  <FlaskIcon size={16} />
                  <h3>Lab Tests Breakdown</h3>
                  <span className="pdetail-fraction">{approvedCount}/{totalCount || 0} Done</span>
                </div>

                <div className="pdetail-count-pills">
                  <button
                    type="button"
                    className={`pdetail-filter-pill ${testFilter === 'all' ? 'is-selected' : ''}`}
                    aria-pressed={testFilter === 'all'}
                    onClick={() => setTestFilter('all')}
                  >
                    All ({tests.length || totalCount})
                  </button>
                  <button
                    type="button"
                    className={`pdetail-filter-pill is-pending-pill ${testFilter === 'pending' ? 'is-selected' : ''}`}
                    aria-pressed={testFilter === 'pending'}
                    onClick={() => setTestFilter('pending')}
                  >
                    Pending ({tests.length ? pendingTests.length : pendingCount})
                  </button>
                  <button
                    type="button"
                    className={`pdetail-filter-pill is-done-pill ${testFilter === 'done' ? 'is-selected' : ''}`}
                    aria-pressed={testFilter === 'done'}
                    onClick={() => setTestFilter('done')}
                  >
                    Done ({tests.length ? doneTests.length : approvedCount})
                  </button>
                </div>
              </div>

              {totalCount > 0 && (
                <div className="pdetail-progress-track" role="progressbar" aria-valuenow={approvedCount} aria-valuemin={0} aria-valuemax={totalCount} aria-label={`${approvedCount} of ${totalCount} lab tests approved`}>
                  <div className="pdetail-progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
              )}

              {error && (
                <div className="pdetail-warning" role="alert">
                  {error}
                </div>
              )}

              {loading && !tests.length ? (
                <div className="pdetail-loading">Fetching per-test approval status from EMR…</div>
              ) : visibleTests.length === 0 ? (
                <div className="pdetail-empty">
                  {tests.length === 0
                    ? 'No individual test lines recorded yet — click Refresh above to load live from EMR.'
                    : `No ${testFilter} tests in this order.`}
                </div>
              ) : (
                <ul className="pdetail-test-list" role="list">
                  {visibleTests.map((t, idx) => (
                    <li
                      key={`${t.reqNo || 'req'}-${t.name}-${idx}`}
                      className={`pdetail-test-item ${t.approved ? 'is-done' : 'is-pending'}`}
                    >
                      <div className="pdetail-test-main">
                        <span className="pdetail-test-icon" aria-hidden="true">
                          {t.approved ? <CheckIcon size={14} /> : <ClockIcon size={14} />}
                        </span>
                        <div className="pdetail-test-text">
                          <div className="pdetail-test-name">{t.name}</div>
                          <div className="pdetail-test-meta">
                            {t.reqNo && <span>Req #{t.reqNo}</span>}
                            {t.billNo && <span>Bill #{t.billNo}</span>}
                            {t.requestDate && <span>Ordered: {t.requestDate}</span>}
                            {t.completedDate && <span>Completed: {t.completedDate}</span>}
                            {!t.approved && t.waitingTat && <span>TAT: {t.waitingTat}</span>}
                          </div>
                        </div>
                      </div>
                      <span className={`pdetail-test-badge ${t.approved ? 'is-done' : 'is-pending'}`}>
                        {t.approved ? 'Done · Approved' : t.status || 'Pending'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <footer className="pdetail-foot">
            {ready && (
              <a
                className="btn btn-view-pdf"
                href={reportPdfUrl(activePatient.date, activePatient.regNo)}
                target="_blank"
                rel="noreferrer"
              >
                <FilePdfIcon size={15} />
                <span>Open Lab Report PDF</span>
              </a>
            )}
            <button type="button" className="btn btn-secondary" onClick={requestClose}>
              Close
            </button>
          </footer>
        </div>
      )}
    </dialog>
  );
}
