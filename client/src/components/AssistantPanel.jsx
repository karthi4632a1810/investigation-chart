import { useEffect, useRef, useState } from 'react';
import { EXPORT_LABELS, askAssistant, downloadLabResults } from '../api/client';
import ExportShareBar from './ExportShareBar';
import { CloseIcon, RotateCcwIcon, SendIcon, SparklesIcon } from './Icons';

const SUGGESTIONS = [
  "Show today's discharges",
  'Patients with urine glucose negative last week',
  'Who had low haemoglobin yesterday?',
  'How do I send reports on WhatsApp?',
];

const SCREEN_NAMES = { reports: 'Discharge Reports', labFinder: 'Lab Finder', search: 'Lab Search', wati: 'WATI Settings' };
const FLAG = { high: 'High', low: 'Low', normal: 'Normal' };

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
          <ExportShareBar patient={p} compact />
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
      <ExportShareBar query={block.query} compact />
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
      {block.target === 'patient' ? <ExportShareBar patient={block.patient} highlight={block.format} compact /> : <ExportShareBar query={block.query} highlight={block.format} compact />}
    </div>
  );
}

function ShareBlock({ block }) {
  return (
    <div className="ai-block">
      <div className="ai-block-title">Check the number, then press Send</div>
      {block.target === 'patient' ? (
        <ExportShareBar patient={block.patient} shareNumber={block.toNumber} openShare compact />
      ) : (
        <ExportShareBar query={block.query} shareNumber={block.toNumber} openShare compact />
      )}
    </div>
  );
}

function Blocks({ blocks, onNavigate }) {
  return blocks.map((b, i) => {
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

export default function AssistantPanel({ onNavigate }) {
  const [showAi, setShowAi] = useState(() => {
    if (typeof window === 'undefined') return false;
    const val = new URLSearchParams(window.location.search).get('ai');
    return val === 'true' || val === '1';
  });

  useEffect(() => {
    const check = () => {
      const val = new URLSearchParams(window.location.search).get('ai');
      setShowAi(val === 'true' || val === '1');
    };
    window.addEventListener('popstate', check);
    return () => window.removeEventListener('popstate', check);
  }, []);

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
        context,
      );
      const next = { ...context };
      for (const b of res.blocks || []) {
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

  if (!showAi) return null;

  return (
    <>
      {!open && (
        <button type="button" className="ai-launcher no-print" onClick={() => setOpen(true)} aria-label="Ask AI">
          <SparklesIcon size={18} />
          <span>Ask AI</span>
        </button>
      )}

      {open && (
        <section className="ai-panel no-print" role="dialog" aria-label="Ask AI assistant">
          <header className="ai-head">
            <div className="ai-head-icon">
              <SparklesIcon size={17} />
            </div>
            <div className="ai-head-text">
              <div className="ai-head-title">Ask AI</div>
              <div className="ai-head-sub">Find reports, lab results and how-tos</div>
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
                <p>Ask for a patient's reports, find patients by lab result, or ask how to do something in the portal.</p>
                <div className="ai-suggestions">
                  {SUGGESTIONS.map((s) => (
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
                {m.blocks?.length > 0 && <Blocks blocks={m.blocks} onNavigate={onNavigate} />}
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
      )}
    </>
  );
}
