import { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  EXPORT_LABELS,
  askAssistant,
  checkWhatsAppNumber,
  downloadDischargeExport,
  downloadLabResults,
  downloadWhatsappExport,
  fetchMessageStatus,
  lookupPdfUrl,
  sendLookupWhatsApp,
  sendTestWhatsApp,
} from '../api/client';
import ExportShareBar from './ExportShareBar';
import { CheckIcon, CloseIcon, ExternalLinkIcon, FilePdfIcon, RotateCcwIcon, SendIcon, SparklesIcon, WhatsAppIcon } from './Icons';

const SUGGESTIONS = [
  "Show today's discharges",
  'Patients with urine glucose negative last week',
  'Is WhatsApp working right now?',
  "Today's WhatsApp report, patient and message wise",
  'Patients discharged today 10 am to 2 pm',
  'What does the red No Summary button mean?',
  'Send a test WhatsApp message',
];

const SCREEN_NAMES = { reports: 'Discharge Reports', labFinder: 'Lab Finder', search: 'Lab Search', wati: 'WATI Settings', admin: 'WhatsApp Monitor' };

function formatIst(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}
const FLAG = { high: 'High', low: 'Low', normal: 'Normal' };

// The user's permissions for every download / share bar in the chat (utils/access.js).
const BarAccess = createContext({ allowShare: true, showLab: true, showSummary: true });
function Bar(props) {
  return <ExportShareBar {...useContext(BarAccess)} {...props} />;
}

/** The model sometimes uses **bold** — show it as bold, everything else as plain text. */
function formatReply(text) {
  return String(text)
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part));
}

function isoToDmy(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso || '';
}

function PatientsBlock({ block, onNavigate }) {
  const [all, setAll] = useState(false);
  const list = all ? block.patients : block.patients.slice(0, 4);
  return (
    <div className="ai-block">
      <div className="ai-block-title">{block.title}</div>
      {list.map((p) => (
        <div className="ai-patient" key={`${p.date}-${p.ipNo}`}>
          <div className="ai-patient-top">
            <div className="ai-patient-name">{p.name}</div>
            <div className="ai-patient-date">{isoToDmy(p.date)}</div>
          </div>
          <div className="ai-patient-meta">
            <span>{p.ipNo}</span>
            {p.regNo && <span>UHID {p.regNo}</span>}
            {p.department && <span>{p.department}</span>}
          </div>
          <Bar via="assistant" patient={p} compact />
        </div>
      ))}
      <div className="ai-block-links">
        {block.patients.length > 4 && (
          <button type="button" className="ai-link" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${block.patients.length}`}
          </button>
        )}
        {block.patients[0]?.date && (
          <button type="button" className="ai-link" onClick={() => onNavigate({ view: 'reports', date: block.patients[0].date, filter: block.patients.length === 1 ? block.patients[0].ipNo : '' })}>
            Open in Discharge Reports
          </button>
        )}
      </div>
    </div>
  );
}

function LabResultsBlock({ block, onNavigate }) {
  if (!block.total) {
    return <div className="ai-block ai-block-empty">No matching lab results found.</div>;
  }
  return (
    <div className="ai-block">
      <div className="ai-block-title">
        {block.total} result{block.total === 1 ? '' : 's'} · {block.patients} patient{block.patients === 1 ? '' : 's'}
      </div>
      {block.matchedTests?.length > 0 && <div className="ai-tests">{block.matchedTests.slice(0, 4).join(' · ')}</div>}
      <div className="ai-table-wrap">
        <table className="ai-table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Result</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {block.rows.slice(0, 6).map((r, i) => (
              <tr key={i}>
                <td>
                  <div className="ai-cell-name">{r.name}</div>
                  <div className="ai-cell-sub">
                    {r.ipNo} · {r.test}
                  </div>
                </td>
                <td>
                  <span className={`ai-value ${r.status === 'high' || r.status === 'low' ? `is-${r.status}` : ''}`}>{r.value}</span>
                  {FLAG[r.status] && r.status !== 'normal' && <span className={`lf-flag is-${r.status}`}>{FLAG[r.status]}</span>}
                </td>
                <td className="ai-cell-sub">{r.resultDate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ai-block-links">
        <button type="button" className="ai-link" onClick={() => onNavigate({ view: 'labFinder', query: block.query })}>
          {block.total > 6 ? `See all ${block.total} in Lab Finder` : 'Open in Lab Finder'}
        </button>
      </div>
      <Bar via="assistant" query={block.query} compact />
    </div>
  );
}

function DownloadBlock({ block }) {
  const started = useRef(false);
  const [note, setNote] = useState('');
  const isPatientPdf = block.target === 'patient' && block.format === 'pdf';
  const query = block.target === 'patient' ? { ipNo: block.patient.ipNo, from: block.patient.date, to: block.patient.date } : block.query;

  // Start the chosen download straight away; the options stay as a fallback.
  useEffect(() => {
    if (started.current || isPatientPdf) return;
    started.current = true;
    downloadLabResults(query, block.format)
      .then((name) => setNote(`Downloaded ${name}`))
      .catch((err) => setNote(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ai-block">
      <div className="ai-block-title">
        {isPatientPdf ? 'Open the PDFs' : `${EXPORT_LABELS[block.format]} download`}
        {note && <span className="ai-block-note"> · {note}</span>}
      </div>
      {block.target === 'patient' ? <Bar via="assistant" patient={block.patient} highlight={block.format} compact /> : <Bar via="assistant" query={block.query} highlight={block.format} compact />}
    </div>
  );
}

function ShareBlock({ block }) {
  return (
    <div className="ai-block">
      <div className="ai-block-title">Check the number, then press Send</div>
      {block.target === 'patient' ? (
        <Bar via="assistant" patient={block.patient} shareNumber={block.toNumber} openShare compact />
      ) : (
        <Bar via="assistant" query={block.query} shareNumber={block.toNumber} openShare compact />
      )}
    </div>
  );
}

/** Live portal status: rows with a coloured dot for good / needs a look / problem. */
function StatusBlock({ block, onNavigate }) {
  return (
    <div className="ai-block ai-status">
      {block.sections.map((section) => (
        <div key={section.title} className="ai-status-section">
          <div className="ai-block-title">{section.title}</div>
          <dl className="ai-status-rows">
            {section.rows.map((row) => (
              <div key={row.label} className={`ai-status-row ${row.tone ? `is-${row.tone}` : ''}`}>
                <dt>
                  {row.tone && <span className="ai-status-dot" aria-hidden="true" />}
                  {row.label}
                </dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          {section.link && (
            <div className="ai-block-links">
              <button type="button" className="ai-link" onClick={() => onNavigate({ view: section.link.view })}>
                {section.link.label}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const DOC_STATUS = { read: 'Read', delivered: 'Delivered', sent: 'Sent', pending: 'Pending', failed: 'Failed' };
const FORMAT_SHORT = { xlsx: 'XLS', pdf: 'PDF', csv: 'CSV', json: 'JSON' };

/** Download buttons for a report card; `download(format)` returns the file name. */
function ReportDownloads({ formats, download }) {
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  return (
    <div className="ai-report-dl">
      <span>Download</span>
      {formats.map((f) => (
        <button
          key={f}
          type="button"
          className={`xs-chip is-${f}`}
          disabled={Boolean(busy)}
          onClick={async () => {
            setBusy(f);
            setNote('');
            try {
              setNote(`Downloaded ${await download(f)}`);
            } catch (err) {
              setNote(err.message);
            } finally {
              setBusy('');
            }
          }}
        >
          {busy === f ? <span className="xs-spin" /> : <span className="xs-ext">{FORMAT_SHORT[f]}</span>}
          {EXPORT_LABELS[f] || f.toUpperCase()}
        </button>
      ))}
      {note && <div className="ai-report-note">{note}</div>}
    </div>
  );
}

function StatusPill({ status, notOnWhatsApp }) {
  const key = notOnWhatsApp ? 'failed' : status;
  return <span className={`ai-wa-status is-${key}`}>{notOnWhatsApp ? 'Not on WhatsApp' : DOC_STATUS[status] || status}</span>;
}

/** WhatsApp report: patient-wise and message-wise, with downloads. */
function WhatsAppReportBlock({ block, onNavigate }) {
  const [tab, setTab] = useState(block.view === 'messages' ? 'messages' : 'patients');
  const [all, setAll] = useState(false);
  const t = block.totals;
  const rows = tab === 'patients' ? block.patients : block.messages;
  const shown = all ? rows : rows.slice(0, 8);
  const total = tab === 'patients' ? block.patientsTotal : block.messagesTotal;
  return (
    <div className="ai-block ai-report">
      <div className="ai-block-title">{block.title}</div>
      <div className="ai-wa-totals">
        <span><b>{t.patients}</b> patients</span>
        <span><b>{t.messages}</b> messages</span>
        <span><b>{t.sent}</b> sent</span>
        <span><b>{t.delivered}</b> delivered</span>
        <span className="is-read"><b>{t.read}</b> read</span>
        {t.pending > 0 && <span className="is-pending"><b>{t.pending}</b> pending</span>}
        <span className={t.failed ? 'is-failed' : ''}><b>{t.failed}</b> failed</span>
      </div>
      {block.view === 'both' && (
        <div className="ai-report-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'patients'} className={tab === 'patients' ? 'is-on' : ''} onClick={() => setTab('patients')}>
            Patient-wise ({block.patientsTotal})
          </button>
          <button type="button" role="tab" aria-selected={tab === 'messages'} className={tab === 'messages' ? 'is-on' : ''} onClick={() => setTab('messages')}>
            Message-wise ({block.messagesTotal})
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="ai-block-empty">Nothing matches.</div>
      ) : (
        <ul className="ai-wa-list">
          {tab === 'patients'
            ? shown.map((p) => (
                <li key={p.key}>
                  <StatusPill status={p.status} notOnWhatsApp={p.notOnWhatsApp} />
                  <span className="ai-wa-main">
                    <b>{p.patientName || p.ipNo || 'Patient'}</b>
                    <span>
                      {[p.ipNo, p.department, p.dischargeDate && isoToDmy(p.dischargeDate)].filter(Boolean).join(' · ')}
                    </span>
                    <span className="ai-wa-docs">
                      {p.lab && <em className={`is-${p.lab}`}>Lab: {DOC_STATUS[p.lab]}</em>}
                      {p.summary && <em className={`is-${p.summary}`}>Summary: {DOC_STATUS[p.summary]}</em>}
                    </span>
                  </span>
                </li>
              ))
            : shown.map((m) => (
                <li key={m.id}>
                  <StatusPill status={m.status} notOnWhatsApp={m.notOnWhatsApp} />
                  <span className="ai-wa-main">
                    <b>{m.patientName || m.ipNo || 'Message'}</b>
                    <span>
                      {m.document}
                      {m.ipNo ? ` · ${m.ipNo}` : ''} · {formatIst(m.sentAt)}
                    </span>
                    {m.reason && (
                      <span className="ai-wa-reason">
                        {m.reason}
                        {m.nextRetryAt ? ` · retry ${formatIst(m.nextRetryAt)}` : ''}
                      </span>
                    )}
                  </span>
                </li>
              ))}
        </ul>
      )}
      {total > rows.length && <div className="ai-report-note">Showing the first {rows.length} of {total} — the download has all of them.</div>}
      <ReportDownloads formats={['xlsx', 'pdf', 'csv', 'json']} download={(f) => downloadWhatsappExport(block.query, tab, f)} />
      <div className="ai-block-links">
        {rows.length > 8 && (
          <button type="button" className="ai-link" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        )}
        <button type="button" className="ai-link" onClick={() => onNavigate({ view: 'admin', monitor: { ...block.query, tableView: tab } })}>
          Open in WhatsApp Monitor
        </button>
      </div>
    </div>
  );
}

const SUMMARY_TEXT = { ready: 'Summary', no_summary: 'No Summary', pending: 'Summary pending' };
const WA_TEXT = { read: 'Read', delivered: 'Delivered', sent: 'Sent', pending: 'Pending', failed: 'WhatsApp failed', nowa: 'Not on WhatsApp', none: 'Not sent' };

/** Discharge report: patients discharged in a date / time range, with downloads. */
function DischargeReportBlock({ block, onNavigate }) {
  const [all, setAll] = useState(false);
  const t = block.totals;
  const shown = all ? block.rows : block.rows.slice(0, 8);
  return (
    <div className="ai-block ai-report">
      <div className="ai-block-title">{block.title}</div>
      <div className="ai-wa-totals">
        <span><b>{t.patients}</b> patients</span>
        <span><b>{t.labReady}</b> lab reports</span>
        <span><b>{t.summaryReady}</b> summaries</span>
        {t.noSummary > 0 && <span className="is-failed"><b>{t.noSummary}</b> No Summary</span>}
        <span className="is-read"><b>{t.whatsapp.read}</b> read on WhatsApp</span>
        {t.whatsapp.failed > 0 && <span className="is-failed"><b>{t.whatsapp.failed}</b> WhatsApp failed</span>}
        <span><b>{t.whatsapp.notSent}</b> not sent</span>
      </div>
      {t.byDepartment.length > 1 && (
        <div className="ai-tests">{t.byDepartment.slice(0, 5).map((d) => `${d.department} ${d.patients}`).join(' · ')}</div>
      )}
      {block.rows.length === 0 ? (
        <div className="ai-block-empty">No patients match.</div>
      ) : (
        <ul className="ai-wa-list">
          {shown.map((r) => (
            <li key={`${r.date}-${r.ipNo}`}>
              <span className="ai-dis-time">{String(r.dischargedAt).split(' ')[1] || isoToDmy(r.date)}</span>
              <span className="ai-wa-main">
                <b>{r.name}</b>
                <span>{[r.ipNo, r.department, r.doctor].filter(Boolean).join(' · ')}</span>
                <span className="ai-wa-docs">
                  <em className={r.lab === 'ready' ? 'is-read' : ''}>{r.lab === 'ready' ? 'Lab report' : 'No lab data'}</em>
                  <em className={r.summary === 'ready' ? 'is-read' : r.summary === 'no_summary' ? 'is-failed' : ''}>{SUMMARY_TEXT[r.summary]}</em>
                  <em className={r.whatsapp === 'read' ? 'is-read' : r.whatsapp === 'failed' || r.whatsapp === 'nowa' ? 'is-failed' : ''}>{WA_TEXT[r.whatsapp]}</em>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {block.total > block.rows.length && <div className="ai-report-note">Showing the first {block.rows.length} of {block.total} — the download has all of them.</div>}
      <ReportDownloads formats={['xlsx', 'pdf', 'csv']} download={(f) => downloadDischargeExport(block.query, f)} />
      <div className="ai-block-links">
        {block.rows.length > 8 && (
          <button type="button" className="ai-link" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${block.rows.length}`}
          </button>
        )}
        <button type="button" className="ai-link" onClick={() => onNavigate({ view: 'reports', date: block.query.to })}>
          Open in Discharge Reports
        </button>
      </div>
    </div>
  );
}

// ---- Lab reports looked up in the EMR (OP patients too) ------------------------

const STATE_TEXT = {
  pending: 'Sending…',
  sent: 'Sent ✓ — WhatsApp hasn\'t confirmed delivery yet',
  delivered: 'Delivered ✓✓ — not read yet',
  read: 'Read ✓✓ — the patient opened it',
};

/** Follows a sent message: delivered / read / failed. Free re-reads; "Check with WATI" asks WATI once. */
function MessageStatus({ id }) {
  const [state, setState] = useState(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    let tries = 0;
    const read = () => fetchMessageStatus(id, false).then((m) => alive && setState(m)).catch(() => {});
    read();
    const timer = setInterval(() => {
      tries += 1;
      if (tries > 20) clearInterval(timer); // ~5 minutes
      read();
    }, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);

  async function check() {
    setChecking(true);
    setNote('');
    try {
      const m = await fetchMessageStatus(id, true);
      setState(m);
      if (m.status === 'sent') setNote('WATI has no delivery tick yet — the phone may be off or offline.');
    } catch (err) {
      setNote(err.message);
    } finally {
      setChecking(false);
    }
  }

  if (!state) return <div className="ai-test-status">Sent — checking status…</div>;
  const failed = state.status === 'failed';
  const text = failed
    ? state.notOnWhatsApp
      ? 'This number is not on WhatsApp — please check the number and try another.'
      : `Not delivered: ${state.reason || 'WATI reported a failure'}${state.error ? ` (${state.error})` : ''}`
    : STATE_TEXT[state.status] || state.status;
  return (
    <div className={`ai-test-status ${failed ? 'is-error' : state.status === 'read' ? 'is-ok' : ''}`} role="status">
      {state.status === 'read' && <CheckIcon size={13} />} {text}
      {!failed && state.status !== 'read' && (
        <button type="button" className="ai-link" onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Check with WATI'}
        </button>
      )}
      {note && <span className="ai-report-note">{note}</span>}
    </div>
  );
}

/** Number box + Send for a looked-up lab report, then its delivery status. */
function LookupSender({ lookup, initialNumber = '', onSent }) {
  const [number, setNumber] = useState(initialNumber);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);
  const check = checkWhatsAppNumber(number);

  async function send(e) {
    e.preventDefault();
    if (!check.ok) return;
    setBusy(true);
    setError('');
    try {
      const r = await sendLookupWhatsApp(lookup, check.digits);
      setSent(r);
      onSent?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="ai-lookup-sent">
        <div className="ai-test-status is-ok">
          <WhatsAppIcon size={13} /> Sent to {sent.sentTo} with the “{sent.template}” template.
        </div>
        {sent.messageId && <MessageStatus id={sent.messageId} />}
        <button type="button" className="ai-link" onClick={() => setSent(null)}>
          Send to another number
        </button>
      </div>
    );
  }

  return (
    <form className="xs-share" onSubmit={send}>
      <label className="xs-share-label" htmlFor={`lk-${lookup.lookupId}`}>
        Send this lab report on WhatsApp to
      </label>
      <div className="xs-share-row">
        <input id={`lk-${lookup.lookupId}`} type="tel" inputMode="tel" placeholder="WhatsApp number, e.g. 99624 60782" value={number} onChange={(e) => setNumber(e.target.value)} autoFocus />
        <button type="submit" className="xs-send" disabled={busy || !check.ok}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      {number && !check.ok && <div className="xs-note is-error">{check.error}</div>}
      {error && <div className="xs-note is-error">{error}</div>}
    </form>
  );
}

function LabLookupBlock({ block, canSend }) {
  const [sharing, setSharing] = useState(false);
  if (!block.found) {
    return (
      <div className="ai-block ai-block-empty">
        No lab results in the EMR for <b>{block.id}</b> between {block.range}.
      </div>
    );
  }
  const p = block.patient;
  return (
    <div className="ai-block ai-lookup">
      <div className="ai-block-title">
        <FilePdfIcon size={14} /> Lab report · {p.name || block.id}
      </div>
      <div className="ai-patient-meta">
        {p.uhid && <span>UHID {p.uhid}</span>}
        {p.ipNo && <span>{p.ipNo}</span>}
        <span className={`ai-pt-type is-${p.type.toLowerCase()}`}>{p.type === 'OP' ? 'OP patient' : 'IP patient'}</span>
        {(p.age || p.sex) && <span>{[p.age, p.sex].filter(Boolean).join(' / ')}</span>}
        {p.unit && <span>{p.unit}</span>}
      </div>
      <div className="ai-tests">
        {block.tests} results · {block.dates} day{block.dates === 1 ? '' : 's'} ({block.firstDate}
        {block.dates > 1 ? ` – ${block.lastDate}` : ''}) · searched {block.range}
      </div>
      <div className="xs-options">
        <a className="xs-chip is-pdf" href={lookupPdfUrl(block)} target="_blank" rel="noreferrer">
          <ExternalLinkIcon size={13} /> Open PDF
        </a>
        <a className="xs-chip is-pdf" href={lookupPdfUrl(block, true)}>
          <FilePdfIcon size={13} /> Download PDF
        </a>
        {canSend && (
          <button type="button" className={`xs-chip is-whatsapp ${sharing ? 'is-active' : ''}`} onClick={() => setSharing((v) => !v)}>
            <WhatsAppIcon size={13} /> WhatsApp
          </button>
        )}
      </div>
      {sharing && canSend && <LookupSender lookup={block} />}
      {p.type === 'OP' && <div className="ai-report-note">OP patients appear only here in Ask AI — not in Discharge Reports.</div>}
    </div>
  );
}

function LookupShareBlock({ block }) {
  return (
    <div className="ai-block">
      <div className="ai-block-title">
        <WhatsAppIcon size={14} /> Lab report of {block.lookup.name || block.lookup.id}
      </div>
      <LookupSender lookup={{ ...block.lookup, patient: { name: block.lookup.name } }} initialNumber={block.display} />
    </div>
  );
}

/** A test WhatsApp message waiting for Send — or its result when "yes" sent it. */
function TestMessageBlock({ block, onDone }) {
  const [state, setState] = useState(block.status); // ready | sending | sent | failed | cancelled
  const [error, setError] = useState(block.error || '');

  async function send() {
    setState('sending');
    setError('');
    try {
      await sendTestWhatsApp(block.message, block.toNumber);
      setState('sent');
      onDone?.();
    } catch (err) {
      setError(err.message);
      setState('failed');
    }
  }

  return (
    <div className={`ai-block ai-test is-${state}`}>
      <div className="ai-block-title">
        <WhatsAppIcon size={14} /> Test message to {block.display}
      </div>
      <div className="ai-test-bubble">{block.message}</div>
      <div className="ai-test-note">Sent with the report template and a small test PDF.</div>
      {state === 'ready' && (
        <div className="ai-test-actions">
          <button type="button" className="xs-send" onClick={send}>
            Send
          </button>
          <button
            type="button"
            className="ai-link"
            onClick={() => {
              setState('cancelled');
              onDone?.();
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {state === 'sending' && <div className="ai-test-status">Sending…</div>}
      {state === 'sent' && (
        <div className="ai-test-status is-ok" role="status">
          <CheckIcon size={13} /> Sent — WATI accepted it. Check that phone.
        </div>
      )}
      {state === 'failed' && (
        <div className="ai-test-status is-error" role="alert">
          Not sent: {error}
          <button type="button" className="ai-link" onClick={send}>
            Try again
          </button>
        </div>
      )}
      {state === 'cancelled' && <div className="ai-test-status">Cancelled — nothing was sent.</div>}
    </div>
  );
}

function Blocks({ blocks, onNavigate, onTestDone }) {
  const bar = useContext(BarAccess);
  return blocks.map((b, i) => {
    if (b.type === 'labLookup') return <LabLookupBlock key={i} block={b} canSend={bar.allowShare} />;
    if (b.type === 'lookupShare') return <LookupShareBlock key={i} block={b} />;
    if (b.type === 'testMessage') return <TestMessageBlock key={i} block={b} onDone={onTestDone} />;
    if (b.type === 'testDraft') return null;
    if (b.type === 'status') return <StatusBlock key={i} block={b} onNavigate={onNavigate} />;
    if (b.type === 'whatsappReport') return <WhatsAppReportBlock key={i} block={b} onNavigate={onNavigate} />;
    if (b.type === 'dischargeReport') return <DischargeReportBlock key={i} block={b} onNavigate={onNavigate} />;
    if (b.type === 'patients') return <PatientsBlock key={i} block={b} onNavigate={onNavigate} />;
    if (b.type === 'labResults') return <LabResultsBlock key={i} block={b} onNavigate={onNavigate} />;
    if (b.type === 'download') return <DownloadBlock key={i} block={b} />;
    if (b.type === 'share') return <ShareBlock key={i} block={b} />;
    if (b.type === 'navigate')
      return (
        <div key={i} className="ai-nav-note">
          Opened {SCREEN_NAMES[b.view] || 'screen'}
          {b.date ? ` · ${isoToDmy(b.date)}` : ''}
          {b.filter ? ` · “${b.filter}”` : ''}
        </div>
      );
    return null;
  });
}

export default function AssistantPanel({ onNavigate, view, access }) {
  const barAccess = {
    allowShare: !access || access.ai === 'act',
    showLab: access ? access.showLab : true,
    showSummary: access ? access.showSummary : true,
  };
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [context, setContext] = useState({});
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  async function send(text) {
    const question = String(text || '').trim();
    if (!question || busy) return;
    const history = [...messages, { role: 'user', content: question }];
    setMessages(history);
    setInput('');
    setBusy(true);
    try {
      const res = await askAssistant(
        history.map(({ role, content }) => ({ role, content })),
        { ...context, view },
      );
      const next = { ...context };
      for (const b of res.blocks || []) {
        // Test message flow: remember the typed text until the number comes, then the card until it's sent.
        if (b.type === 'testDraft') {
          if (b.message) next.testDraft = { message: b.message };
          else {
            delete next.testDraft;
            delete next.pendingTest;
          }
        }
        if (b.type === 'labLookup' && b.found) next.lastLookup = { day: b.day, lookupId: b.lookupId, id: b.id, name: b.patient?.name || '' };
        if (b.type === 'testMessage') {
          delete next.testDraft;
          if (b.status === 'ready') next.pendingTest = { message: b.message, toNumber: b.toNumber };
          else delete next.pendingTest;
        }
        if (b.type === 'labResults') next.lastLabQuery = b.query;
        if (b.type === 'patients' && b.patients.length === 1) next.lastPatient = { ipNo: b.patients[0].ipNo, date: b.patients[0].date };
        if (b.type === 'navigate') onNavigate(b);
      }
      setContext(next);
      setMessages([...history, { role: 'assistant', content: res.reply, blocks: res.blocks || [] }]);
    } catch (err) {
      setMessages([...history, { role: 'assistant', content: `Sorry, I couldn't answer that: ${err.message}`, error: true }]);
    } finally {
      setBusy(false);
    }
  }


  return (
    <>
      {!open && (
        <button type="button" className="ai-launcher no-print" onClick={() => setOpen(true)} aria-label="Ask AI">
          <SparklesIcon size={18} />
          <span>Ask AI</span>
        </button>
      )}

      {open && (
        <BarAccess.Provider value={barAccess}>
        <section className="ai-panel no-print" role="dialog" aria-label="Ask AI assistant">
          <header className="ai-head">
            <div className="ai-head-icon">
              <SparklesIcon size={17} />
            </div>
            <div className="ai-head-text">
              <div className="ai-head-title">Ask AI</div>
              <div className="ai-head-sub">Reports, lab results, WhatsApp status and how-tos</div>
            </div>
            {messages.length > 0 && (
              <button
                type="button"
                className="ai-icon-btn"
                onClick={() => {
                  setMessages([]);
                  setContext({});
                }}
                title="New chat"
                aria-label="New chat"
              >
                <RotateCcwIcon size={16} />
              </button>
            )}
            <button type="button" className="ai-icon-btn" onClick={() => setOpen(false)} title="Close" aria-label="Close">
              <CloseIcon size={18} />
            </button>
          </header>

          <div className="ai-messages" ref={listRef}>
            {messages.length === 0 && (
              <div className="ai-welcome">
                <div className="ai-welcome-title">How can I help?</div>
                <p>Ask for a patient's reports, find patients by lab result, check whether WhatsApp is working, or ask what anything on screen means.</p>
                <div className="ai-suggestions">
                  {SUGGESTIONS.filter((s) => access?.ai === 'act' || !/send a test/i.test(s)).map((s) => (
                    <button key={s} type="button" className="ai-suggestion" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`ai-msg is-${m.role} ${m.error ? 'is-error' : ''}`}>
                {m.content && <div className="ai-bubble">{m.role === 'assistant' ? formatReply(m.content) : m.content}</div>}
                {m.blocks?.length > 0 && (
                  <Blocks
                    blocks={m.blocks}
                    onNavigate={onNavigate}
                    onTestDone={() =>
                      setContext((c) => {
                        const next = { ...c };
                        delete next.pendingTest;
                        delete next.testDraft;
                        return next;
                      })
                    }
                  />
                )}
              </div>
            ))}

            {busy && (
              <div className="ai-msg is-assistant">
                <div className="ai-bubble ai-typing" aria-label="Thinking">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>

          <form
            className="ai-input"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder="e.g. IP07028148 lab report"
              maxLength={600}
            />
            <button type="submit" className="ai-send" disabled={busy || !input.trim()} aria-label="Send">
              <SendIcon size={17} />
            </button>
          </form>
          <div className="ai-foot">AI can misread questions — check results before acting on them.</div>
        </section>
        </BarAccess.Provider>
      )}
    </>
  );
}
