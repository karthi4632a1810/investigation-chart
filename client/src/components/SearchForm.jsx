import { useEffect, useRef, useState } from 'react';
import {
  CalendarIcon,
  CloseIcon,
  PrinterIcon,
  SearchIcon,
} from './Icons';

function FetchWarnings({ fetchErrors }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (!fetchErrors?.length) return null;

  return (
    <div className="warn-popover-wrap no-print" ref={wrapRef}>
      <button
        type="button"
        className="btn icon-warn"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${fetchErrors.length} warning(s) while fetching results`}
        title={`${fetchErrors.length} warning(s) while fetching results`}
      >
        ⚠️ <span>{fetchErrors.length} Warning{fetchErrors.length > 1 ? 's' : ''}</span>
      </button>
      {open && (
        <div className="warn-popover">
          <div className="warn-popover-title">Fetch warnings ({fetchErrors.length})</div>
          {fetchErrors.map((fe, idx) => (
            <div key={idx} className="warn-popover-item">
              {fe}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function getFormattedDate(daysOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysOffset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function SearchForm({
  regNo,
  fromDate,
  toDate,
  loading,
  showPrint,
  fetchErrors,
  onRegNoChange,
  onFromDateChange,
  onToDateChange,
  onSubmit,
}) {
  const handlePreset = (preset) => {
    const today = getFormattedDate(0);
    if (preset === 'today') {
      onFromDateChange(today);
      onToDateChange(today);
    } else if (preset === 'yesterday') {
      const yest = getFormattedDate(1);
      onFromDateChange(yest);
      onToDateChange(yest);
    } else if (preset === '7days') {
      onFromDateChange(getFormattedDate(7));
      onToDateChange(today);
    } else if (preset === '30days') {
      onFromDateChange(getFormattedDate(30));
      onToDateChange(today);
    }
  };

  return (
    <div className="search-card-container">
      <div className="search-card-header">
        <div className="search-card-title-group">
          <div className="search-icon-badge">
            <SearchIcon size={20} />
          </div>
          <div>
            <h3 className="search-card-heading">Patient Lab Investigation Lookup</h3>
            <p className="search-card-subheading">
              Enter patient UHID or IP number to retrieve complete chronological investigation charts.
            </p>
          </div>
        </div>

        {/* Quick Date Presets */}
        <div className="preset-chips-wrap">
          <span className="preset-label">Quick Presets:</span>
          <button
            type="button"
            className="preset-chip"
            onClick={() => handlePreset('today')}
            title="Set date range to today"
          >
            Today
          </button>
          <button
            type="button"
            className="preset-chip"
            onClick={() => handlePreset('yesterday')}
            title="Set date range to yesterday"
          >
            Yesterday
          </button>
          <button
            type="button"
            className="preset-chip"
            onClick={() => handlePreset('7days')}
            title="Last 7 days"
          >
            Last 7 Days
          </button>
          <button
            type="button"
            className="preset-chip"
            onClick={() => handlePreset('30days')}
            title="Last 30 days"
          >
            Last 30 Days
          </button>
        </div>
      </div>

      <form className="searchbar modern-searchbar" onSubmit={onSubmit}>
        {/* Identifier Field */}
        <div className="field input-with-icon">
          <label htmlFor="patient-id-input">
            UHID / IP NUMBER <span className="req-star">*</span>
          </label>
          <div className="input-group">
            <span className="input-affix-icon">
              <SearchIcon size={16} />
            </span>
            <input
              id="patient-id-input"
              type="text"
              value={regNo}
              onChange={(e) => onRegNoChange(e.target.value)}
              placeholder="e.g. 6159338 or IP07025423"
              required
              autoFocus
              className="styled-input with-prefix"
            />
            {regNo && (
              <button
                type="button"
                className="input-clear-btn"
                onClick={() => onRegNoChange('')}
                title="Clear input"
                aria-label="Clear input"
              >
                <CloseIcon size={14} />
              </button>
            )}
          </div>
          <span className="field-micro-hint">Accepts both OP UHID and IPD admission number</span>
        </div>

        {/* Date of Admission */}
        <div className="field date-range">
          <label htmlFor="from-date-input">
            DATE OF ADMISSION <span className="req-star">*</span>
          </label>
          <div className="input-group">
            <span className="input-affix-icon">
              <CalendarIcon size={16} />
            </span>
            <input
              id="from-date-input"
              type="date"
              value={fromDate}
              onChange={(e) => onFromDateChange(e.target.value)}
              required
              className="styled-input with-prefix"
            />
          </div>
          <span className="field-micro-hint">Start date for investigation orders</span>
        </div>

        {/* Date of Discharge */}
        <div className="field date-range">
          <label htmlFor="to-date-input">
            DATE OF DISCHARGE <span className="req-star">*</span>
          </label>
          <div className="input-group">
            <span className="input-affix-icon">
              <CalendarIcon size={16} />
            </span>
            <input
              id="to-date-input"
              type="date"
              value={toDate}
              onChange={(e) => onToDateChange(e.target.value)}
              required
              className="styled-input with-prefix"
            />
          </div>
          <span className="field-micro-hint">End date for investigation orders</span>
        </div>

        {/* Action Buttons */}
        <div className="search-actions modern-search-actions">
          <button
            type="submit"
            className="btn btn-primary btn-search-main"
            disabled={loading}
          >
            <SearchIcon size={18} />
            <span>{loading ? 'Searching Records…' : 'Search Lab Results'}</span>
          </button>

          {showPrint && (
            <button
              type="button"
              className="btn btn-secondary btn-print-action"
              onClick={() => window.print()}
            >
              <PrinterIcon size={16} />
              <span>Print Investigation Chart</span>
            </button>
          )}

          {showPrint && <FetchWarnings fetchErrors={fetchErrors} />}
        </div>
      </form>
    </div>
  );
}
