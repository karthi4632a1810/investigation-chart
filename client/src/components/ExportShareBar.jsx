import { useState } from 'react';
import {
  EXPORT_LABELS,
  downloadLabResults,
  reportPdfUrl,
  reportSummaryPdfUrl,
  shareLabResults,
  sharePatientReports,
} from '../api/client';
import { CheckIcon, FilePdfIcon, WhatsAppIcon } from './Icons';

/**
 * "What next?" options for a result: download in a chosen format, or send on
 * WhatsApp to a number the user types. Used by the Lab Finder and the AI
 * assistant.
 *
 * Give either `query` (a Lab Finder search) or `patient` (one discharge record:
 * PDFs are the patient's own reports; Excel/Word/CSV are their lab values).
 */
export default function ExportShareBar({ query, patient, highlight, shareNumber, openShare = false, compact = false }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [sharing, setSharing] = useState(openShare);
  const [number, setNumber] = useState(shareNumber || '');

  const hasLab = patient ? patient.dateCount !== undefined : true;
  const hasSummary = patient ? Boolean(patient.hasSummary && !patient.summaryDataMissing) : false;
  const labQuery = patient ? { ipNo: patient.ipNo, from: patient.date, to: patient.date } : query;
  const tableFormats = patient ? (hasLab ? ['xlsx', 'docx', 'csv'] : []) : ['pdf', 'xlsx', 'docx', 'csv'];
  const canShare = patient ? hasLab || hasSummary : true;

  async function download(format) {
    setBusy(format);
    setError('');
    setDone('');
    try {
      const name = await downloadLabResults(labQuery, format);
      setDone(`Downloaded ${name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function send(e) {
    e.preventDefault();
    setBusy('share');
    setError('');
    setDone('');
    try {
      const result = patient
        ? await sharePatientReports(patient.date, patient.ipNo, number)
        : await shareLabResults(query, number);
      setDone(`Sent on WhatsApp to ${result.sentTo}`);
      setSharing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className={`xs-bar ${compact ? 'is-compact' : ''}`}>
      <div className="xs-options">
        {patient && hasLab && (
          <a className="xs-chip is-pdf" href={reportPdfUrl(patient.date, patient.ipNo)} target="_blank" rel="noreferrer">
            <FilePdfIcon size={14} /> Lab Report PDF
          </a>
        )}
        {patient && hasSummary && (
          <a className="xs-chip is-pdf" href={reportSummaryPdfUrl(patient.date, patient.ipNo)} target="_blank" rel="noreferrer">
            <FilePdfIcon size={14} /> Summary PDF
          </a>
        )}
        {tableFormats.map((f) => (
          <button
            key={f}
            type="button"
            className={`xs-chip is-${f} ${highlight === f ? 'is-highlight' : ''}`}
            onClick={() => download(f)}
            disabled={Boolean(busy)}
            title={patient ? `Download ${patient.name || patient.ipNo}'s lab values as ${EXPORT_LABELS[f]}` : `Download as ${EXPORT_LABELS[f]}`}
          >
            {busy === f ? <span className="xs-spin" /> : <span className="xs-ext">{f === 'xlsx' ? 'XLS' : f.toUpperCase()}</span>}
            {EXPORT_LABELS[f]}
          </button>
        ))}
        {canShare && (
          <button
            type="button"
            className={`xs-chip is-whatsapp ${sharing ? 'is-active' : ''}`}
            onClick={() => setSharing((v) => !v)}
            disabled={busy === 'share'}
          >
            <WhatsAppIcon size={14} /> WhatsApp
          </button>
        )}
      </div>

      {sharing && (
        <form className="xs-share" onSubmit={send}>
          <label className="xs-share-label" htmlFor={`xs-number-${patient?.ipNo || 'results'}`}>
            {patient ? `Send ${hasLab && hasSummary ? 'lab report + discharge summary' : hasLab ? 'lab report' : 'discharge summary'} to` : 'Send this results PDF to'}
          </label>
          <div className="xs-share-row">
            <input
              id={`xs-number-${patient?.ipNo || 'results'}`}
              type="tel"
              inputMode="tel"
              placeholder="WhatsApp number, e.g. 99624 60782"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              autoFocus
              required
            />
            <button type="submit" className="xs-send" disabled={busy === 'share' || number.replace(/\D/g, '').length < 10}>
              {busy === 'share' ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      )}

      {done && (
        <div className="xs-note is-ok" role="status">
          <CheckIcon size={13} /> {done}
        </div>
      )}
      {error && (
        <div className="xs-note is-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
