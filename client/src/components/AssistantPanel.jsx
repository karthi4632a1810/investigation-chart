import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { EXPORT_LABELS, askAssistant, downloadLabResults, sendTestWhatsApp } from '../api/client';
import ExportShareBar from './ExportShareBar';
import { CheckIcon, CloseIcon, RotateCcwIcon, SendIcon, SparklesIcon, WhatsAppIcon } from './Icons';

const SUGGESTIONS = [
  "Show today's discharges",
  'Patients with urine glucose negative last week',
  'Is WhatsApp working right now?',
  "Yesterday's WhatsApp messages",
  'What does the red No Summary button mean?',
  'Send a test WhatsApp message',
];

const SCREEN_NAMES = { reports: 'Discharge Reports', labFinder: 'Lab Finder', search: 'Lab Search', wati: 'WATI Settings', admin: 'WhatsApp Monitor' };
const WA_STATUS = { pending: 'Pending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };

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

/** WhatsApp messages for dates or one patient. */
function WhatsAppBlock({ block, onNavigate }) {
  const [all, setAll] = useState(false);
  const rows = all ? block.rows : block.rows.slice(0, 8);
  const t = block.totals;
  return (
    <div className="ai-block">
      <div className="ai-block-title">{block.title}</div>
      {t && (
        <div className="ai-wa-totals">
          <span><b>{t.total}</b> messages</span>
          <span><b>{t.sent}</b> sent</span>
          <span><b>{t.delivered}</b> delivered</span>
          <span className="is-read"><b>{t.read}</b> read</span>
          {t.pending > 0 && <span className="is-pending"><b>{t.pending}</b> pending</span>}
          <span className={t.failed ? 'is-failed' : ''}><b>{t.failed}</b> failed</span>
        </div>
      )}
      {block.rows.length === 0 ? (
        <div className="ai-block-empty">No WhatsApp messages found.</div>
      ) : (
        <ul className="ai-wa-list">
          {rows.map((r) => (
            <li key={r.id}>
              <span className={`ai-wa-status is-${r.notOnWhatsApp ? 'failed' : r.status}`}>{r.notOnWhatsApp ? 'Not on WhatsApp' : WA_STATUS[r.status] || r.status}</span>
              <span className="ai-wa-main">
                <b>{r.patientName || r.ipNo || 'Patient'}</b>
                <span>
                  {r.document}
                  {r.ipNo ? ` · ${r.ipNo}` : ''} · {formatIst(r.at)}
                </span>
                {r.reason && (
                  <span className="ai-wa-reason">
                    {r.reason}
                    {r.nextRetryAt ? ` · retry ${formatIst(r.nextRetryAt)}` : ''}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="ai-block-links">
        {block.rows.length > 8 && (
          <button type="button" className="ai-link" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${block.rows.length}`}
          </button>
        )}
        <button type="button" className="ai-link" onClick={() => onNavigate({ view: 'admin' })}>
          Open WhatsApp Monitor
        </button>
      </div>
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
  return blocks.map((b, i) => {
    if (b.type === 'testMessage') return <TestMessageBlock key={i} block={b} onDone={onTestDone} />;
    if (b.type === 'testDraft') return null;
    if (b.type === 'status') return <StatusBlock key={i} block={b} onNavigate={onNavigate} />;
    if (b.type === 'whatsapp') return <WhatsAppBlock key={i} block={b} onNavigate={onNavigate} />;
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
