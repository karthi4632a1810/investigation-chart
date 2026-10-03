/**
 * Master Settings (super admin): every switch and timing of the portal in one
 * place (server: appSettingsService.js). Changes are staged on the page, then
 * reviewed and saved together; open screens pick them up within a minute.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchMasterSettings, saveMasterSettings } from '../api/client';
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  ExternalLinkIcon,
  GaugeIcon,
  GearIcon,
  HistoryIcon,
  LockIcon,
  MegaphoneIcon,
  RefreshIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  ToggleIcon,
  WhatsAppIcon,
} from './Icons';

const SECTION_ICONS = {
  toggle: ToggleIcon,
  whatsapp: WhatsAppIcon,
  retry: RotateCcwIcon,
  gauge: GaugeIcon,
  clock: ClockIcon,
  lock: LockIcon,
  sparkles: SparklesIcon,
  shield: ShieldCheckIcon,
  megaphone: MegaphoneIcon,
};
const HISTORY_ID = 'history';

const TONES = { info: 'Info', warning: 'Warning', danger: 'Urgent' };
const SINGULAR = { hours: 'hour', days: 'day', characters: 'character', tries: 'try', 'tries / day': 'try / day', 'calls / day': 'call / day' };

const withUnit = (v, unit) => (unit ? `${v} ${Number(v) === 1 ? SINGULAR[unit] || unit : unit}` : String(v));

/** How a value reads on screen. */
function show(def, v) {
  if (def.type === 'bool') return v ? 'On' : 'Off';
  if (def.type === 'text') return v ? `“${v.length > 50 ? `${v.slice(0, 50)}…` : v}”` : 'empty';
  if (def.key === 'notice.tone') return TONES[v] || v;
  return withUnit(v, def.unit);
}

const fmtWhen = (v) =>
  v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '';
const fmtTime = (v) => (v ? new Date(v).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }) : '');
const num = (n) => Number(n || 0).toLocaleString('en-IN');
const PLURALS = { try: 'tries', 'automatic try': 'automatic tries', 'staff member': 'staff members' };
const plural = (n, word) => `${num(n)} ${n === 1 ? word : PLURALS[word] || `${word}s`}`;

/** What a change will do, for the review step (null = nothing to point out). */
function warningFor(def, from, to, live) {
  if (def.key.startsWith('features.') && to === false) {
    const n = live?.featureHolders?.[def.key];
    return n ? `Turns this off for ${plural(n, 'staff member')} who have it now.` : 'Turns this off for all staff.';
  }
  switch (def.key) {
    case 'maintenance.readOnly':
      return to ? 'Staff can only look: no sending, retries, downloads or changes. Automatic sending pauses too.' : null;
    case 'whatsapp.autoSend':
      return to ? null : 'New reports won’t go out by themselves, even in Live mode.';
    case 'discharge.autoCheck':
      return to ? null : 'No new discharge reports are made until this is back on.';
    case 'retry.enabled':
      return to ? null : 'Failed reports stay failed until someone presses Retry.';
    case 'audit.retentionDays':
      return to < from ? `Audit records older than ${to} days are deleted for good.` : null;
    case 'auth.idleSignOutMinutes':
      return to > 0 ? `Anyone with no mouse or keyboard activity for ${to} min is signed out.` : null;
    case 'ai.sharePatientData':
      return to ? null : 'Ask AI then answers with counts only — it can’t tell a number, age or address.';
    case 'auth.minPasswordLength':
      return to > from ? 'Existing passwords keep working; it applies when a password is set or changed.' : null;
    default:
      return null;
  }
}

// ---- Controls --------------------------------------------------------------------

function Switch({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`um-switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function NumberField({ def, value, onChange, onInvalid }) {
  const [text, setText] = useState(String(value));
  const step = def.step || 1;
  // "Reset to default" changes the value from outside.
  useEffect(() => {
    setText((t) => {
      if (t.trim() !== '' && Number(t) === value) return t;
      onInvalid(def.key, false);
      return String(value);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const n = Number(text);
  const error = text.trim() === '' || !Number.isFinite(n) ? 'Enter a number' : n < def.min || n > def.max ? `Between ${def.min} and ${def.max}` : '';

  function commit(t) {
    setText(t);
    const v = Number(t);
    const ok = t.trim() !== '' && Number.isFinite(v) && v >= def.min && v <= def.max;
    onInvalid(def.key, !ok);
    if (ok) onChange(v);
  }
  const snap = () => {
    if (error) return;
    const v = Math.min(def.max, Math.max(def.min, Math.round(n / step) * step));
    if (v !== n) commit(String(v));
  };
  const bump = (dir) => commit(String(Math.min(def.max, Math.max(def.min, (error ? Number(value) : Math.round(n / step) * step) + dir * step))));

  return (
    <div className="ms-num-wrap">
      <div className={`ms-num ${error ? 'is-error' : ''}`}>
        <button type="button" onClick={() => bump(-1)} disabled={!error && n <= def.min} aria-label={`Less (${def.label})`}>
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={def.min}
          max={def.max}
          step={step}
          value={text}
          onChange={(e) => commit(e.target.value)}
          onBlur={snap}
          aria-label={def.label}
          aria-invalid={Boolean(error)}
        />
        <button type="button" onClick={() => bump(1)} disabled={!error && n >= def.max} aria-label={`More (${def.label})`}>
          +
        </button>
      </div>
      {def.unit && <span className="ms-unit">{Number(text) === 1 ? SINGULAR[def.unit] || def.unit : def.unit}</span>}
      {error && <span className="ms-field-error">{error}</span>}
    </div>
  );
}

function SelectField({ def, value, onChange }) {
  return (
    <div className={`um-seg ms-seg ${def.key === 'notice.tone' ? 'is-tones' : ''}`} role="radiogroup" aria-label={def.label}>
      {def.options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? 'is-on' : ''} onClick={() => onChange(o)}>
          {def.key === 'notice.tone' && <i className={`ms-tone-dot is-${o}`} />}
          {def.key === 'notice.tone' ? TONES[o] : withUnit(o, def.unit)}
        </button>
      ))}
    </div>
  );
}

function TextField({ def, value, onChange }) {
  return (
    <div className="ms-text">
      <textarea
        rows={2}
        maxLength={def.max}
        value={value}
        placeholder="e.g. EMR maintenance tonight 10–11 pm — reports may be delayed."
        onChange={(e) => onChange(e.target.value)}
        aria-label={def.label}
      />
      <span className="ms-count">
        {value.length} / {def.max}
      </span>
    </div>
  );
}

// ---- Section extras ------------------------------------------------------------------

/**
 * When a failed report is tried again, from the current (unsaved too) values —
 * the same rules as the server (whatsappLogService.js canAutoRetry / retryTime).
 */
function retrySchedule(v) {
  const every = v['retry.everyHours'];
  const span = v['retry.forDays'] * 24;
  const maxAttempts = Math.ceil(span / every) + 2;
  const run = (first) => {
    const out = [];
    let t = first;
    let attempts = 1;
    for (;;) {
      out.push(t);
      attempts += 1;
      if (!(t < span && attempts < maxAttempts)) break;
      t += every;
    }
    return out;
  };
  const quick = v['retry.quickMinutes'] > 0 ? v['retry.quickMinutes'] / 60 : 0;
  return { span, every, plain: run(quick || every), nowa: run(every), quick };
}

function RetryPlan({ values, live }) {
  if (!values['retry.enabled']) {
    return (
      <div className="ms-callout is-warn">
        <AlertIcon size={15} /> Automatic retries are off — failed reports wait until someone presses <b>Retry</b> in the WhatsApp Monitor.
      </div>
    );
  }
  const { span, every, plain, nowa, quick } = retrySchedule(values);
  const end = Math.max(span, plain[plain.length - 1]);
  const days = values['retry.forDays'];
  const perDay = 24 / every;
  const at = (t) => `${(t / end) * 100}%`;
  const label = (t) => {
    const h = Math.floor(t);
    const m = Math.round((t - h) * 60);
    return t < 1 ? `${m} min` : `${h} h${m ? ` ${m} min` : ''}`;
  };
  const r = live?.retries;
  const used = live?.wati?.today?.retry ?? null;
  return (
    <div className="ms-plan">
      <p className="ms-plan-lead">
        A report that didn’t go out is tried again <b>{plural(plain.length, 'time')}</b> over {plural(values['retry.forDays'], 'day')}
        {quick ? (
          <>
            : once after <b>{values['retry.quickMinutes']} min</b>, then every <b>{plural(every, 'hour')}</b>
          </>
        ) : (
          <>
            , every <b>{plural(every, 'hour')}</b>
          </>
        )}{' '}
        ({Number.isInteger(perDay) ? perDay : `about ${perDay.toFixed(1)}`} a day).
      </p>
      <div className="ms-track" role="img" aria-label={`Retry times: ${plain.map(label).join(', ')} after the first send`}>
        {Array.from({ length: days }, (_, d) => (
          <span key={d} className="ms-track-day" style={{ left: at(d * 24), width: at(24) }}>
            Day {d + 1}
          </span>
        ))}
        <span className="ms-track-line" />
        <i className="ms-dot is-first" style={{ left: '0%' }} title="First send" />
        {plain.map((t, i) => (
          <i
            key={t}
            className={`ms-dot ${quick && i === 0 ? 'is-quick' : ''}`}
            style={{ left: at(t) }}
            title={`Try ${i + 1}: ${label(t)} after the first send`}
          />
        ))}
      </div>
      <div className="ms-legend">
        <span>
          <i className="ms-dot is-first" /> First send
        </span>
        {quick > 0 && (
          <span>
            <i className="ms-dot is-quick" /> Quick retry (plain failures)
          </span>
        )}
        <span>
          <i className="ms-dot" /> Retry
        </span>
      </div>
      <ul className="ms-facts">
        <li>
          <b>Not on WhatsApp:</b>{' '}
          {values['retry.notOnWhatsApp'] ? `${plural(nowa.length, 'try')}, every ${plural(every, 'hour')} (no quick retry).` : 'not retried — shown in the Monitor for a manual Retry.'}
        </li>
        <li>
          <b>Daily safety cap:</b> {plural(values['retry.dailyCap'], 'automatic try')} across all reports
          {used !== null ? ` · ${num(used)} used today` : ''}.
        </li>
        {r && (
          <li>
            <b>Right now:</b> {plural(r.waiting, 'report')} waiting to retry
            {r.nextRetryAt ? ` · next try at ${fmtTime(r.nextRetryAt)}` : ''}.
          </li>
        )}
      </ul>
    </div>
  );
}

function Meter({ label, used, cap }) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const tone = cap > 0 && used >= cap ? 'is-full' : pct >= 80 ? 'is-high' : '';
  return (
    <div className="ms-meter">
      <div className="ms-meter-head">
        <span>{label}</span>
        <b>
          {num(used)} <small>/ {cap > 0 ? num(cap) : 'none allowed'}</small>
        </b>
      </div>
      <div className={`ms-meter-bar ${tone}`}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function WatiToday({ values, live }) {
  const w = live?.wati;
  if (!w) return null;
  return (
    <div className="ms-usage">
      <Meter label="Status checks today" used={w.today.status} cap={values['wati.statusChecksPerDay']} />
      <Meter label="Automatic retries today" used={w.today.retry} cap={values['retry.dailyCap']} />
      <div className="ms-usage-note">
        Today {num(w.today.total)} WATI calls ({num(w.today.send)} sends) · this month {num(w.month.total)}.
        {w.pausedUntil && new Date(w.pausedUntil) > new Date() && (
          <b className="ms-warn-text"> WATI refused calls (usage limit) — paused until {fmtWhen(w.pausedUntil)}.</b>
        )}
      </div>
    </div>
  );
}

function SchedulerNow({ live }) {
  const s = live?.scheduler;
  if (!s) return null;
  return (
    <div className={`ms-callout ${s.paused ? 'is-warn' : ''}`}>
      <ClockIcon size={15} />
      {s.paused ? (
        <span>Automatic checks are paused.</span>
      ) : (
        <span>
          {s.checkInProgress ? 'Checking the EMR now' : s.lastCheckFinishedAt ? `Last check ${fmtTime(s.lastCheckFinishedAt)}` : 'No check yet since the server started'}
          {s.nextCheckAt ? ` · next at ${fmtTime(s.nextCheckAt)}` : ''}. A new timing starts after the next check.
        </span>
      )}
    </div>
  );
}

function NoticePreview({ values }) {
  const text = values['notice.text'];
  return (
    <div className="ms-preview">
      <span className="ms-preview-label">Preview</span>
      {text ? (
        <div className={`app-notice is-${values['notice.tone']}`}>
          <MegaphoneIcon size={15} />
          <span>{text}</span>
        </div>
      ) : (
        <div className="ms-preview-empty">No announcement — write one above to show it on every screen.</div>
      )}
      {values['maintenance.readOnly'] && (
        <div className="app-notice is-readonly">
          <LockIcon size={14} />
          <span>
            <b>Read-only mode</b> — the portal is under maintenance. You can view everything; sending, downloads and changes are paused.
          </span>
        </div>
      )}
    </div>
  );
}

function SectionExtra({ id, values, live, onNavigate }) {
  switch (id) {
    case 'features':
      return (
        <div className="ms-callout">
          <ShieldCheckIcon size={15} />
          <span>
            You (super admin) always keep every feature, so you can keep testing.
            {live?.staffCount !== undefined && ` ${plural(live.staffCount, 'active staff account')}.`}
          </span>
        </div>
      );
    case 'whatsapp':
      return (
        <div className={`ms-callout ${live?.whatsappLive ? 'is-live' : ''}`}>
          <WhatsAppIcon size={15} />
          <span>
            WhatsApp is in <b>{live?.whatsappLive ? 'Live mode' : 'Test mode'}</b>
            {live?.whatsappLive
              ? values['whatsapp.autoSend']
                ? ' — reports go to patients automatically.'
                : ' — but only sent by hand (automatic sending is off).'
              : ' — every message goes to the test number.'}
          </span>
          {onNavigate && (
            <button type="button" className="ms-link" onClick={() => onNavigate('wati')}>
              WATI Settings <ExternalLinkIcon size={12} />
            </button>
          )}
        </div>
      );
    case 'retry':
      return <RetryPlan values={values} live={live} />;
    case 'wati':
      return <WatiToday values={values} live={live} />;
    case 'discharge':
      return <SchedulerNow live={live} />;
    case 'security':
      return onNavigate ? (
        <div className="ms-callout">
          <LockIcon size={15} />
          <span>To unlock someone straight away, reset a password or sign a person out everywhere, use Users.</span>
          <button type="button" className="ms-link" onClick={() => onNavigate('users')}>
            Users <ExternalLinkIcon size={12} />
          </button>
        </div>
      ) : null;
    case 'audit':
      return onNavigate ? (
        <div className="ms-callout">
          <ShieldCheckIcon size={15} />
          <span>Every change made here is in the Audit Log too (Settings), with who and when.</span>
          <button type="button" className="ms-link" onClick={() => onNavigate('audit')}>
            Audit Log <ExternalLinkIcon size={12} />
          </button>
        </div>
      ) : null;
    case 'notice':
      return <NoticePreview values={values} />;
    default:
      return null;
  }
}

// ---- One setting -----------------------------------------------------------------------

function SettingRow({ def, value, saved, dirty, live, onChange, onInvalid, version }) {
  const holders = live?.featureHolders?.[def.key];
  const control =
    def.type === 'bool' ? (
      <div className="ms-bool">
        <span className={value ? 'is-on' : ''}>{value ? 'On' : 'Off'}</span>
        <Switch checked={value} onChange={onChange} label={def.label} />
      </div>
    ) : def.type === 'number' ? (
      <NumberField key={version} def={def} value={value} onChange={onChange} onInvalid={onInvalid} />
    ) : def.type === 'select' ? (
      <SelectField def={def} value={value} onChange={onChange} />
    ) : (
      <TextField def={def} value={value} onChange={onChange} />
    );

  return (
    <div className={`ms-row ${dirty ? 'is-dirty' : ''} ${def.type === 'text' ? 'is-wide' : ''}`} id={`ms-${def.key}`}>
      <div className="ms-row-text">
        <div className="ms-row-label">{def.label}</div>
        <p>{def.help}</p>
        <div className="ms-row-meta">
          {dirty && <span className="ms-tag is-unsaved">Unsaved · was {show(def, saved)}</span>}
          {!dirty && value !== def.baseValue && <span className="ms-tag">Default: {show(def, def.baseValue)}</span>}
          {def.fromEnv && (
            <span className="ms-tag is-env" title="This setting’s default comes from the server’s .env file">
              default from .env
            </span>
          )}
          {holders !== undefined && (
            <span className={`ms-tag ${value ? '' : 'is-off'}`}>
              {value ? `${plural(holders, 'staff member')} ${holders === 1 ? 'has' : 'have'} this` : `Off for ${plural(holders, 'staff member')} who have it`}
            </span>
          )}
          {value !== def.baseValue && (
            <button type="button" className="ms-reset" onClick={() => onChange(def.baseValue)} title={`Back to ${show(def, def.baseValue)}`}>
              <RotateCcwIcon size={11} /> Reset to default
            </button>
          )}
        </div>
      </div>
      <div className="ms-row-control">{control}</div>
    </div>
  );
}

// ---- Review & save ---------------------------------------------------------------------

function ReviewDialog({ changes, saving, error, onCancel, onSave }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !saving && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, onCancel]);

  return createPortal(
    <div className="ms-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !saving && onCancel()}>
      <div className="ms-modal" role="dialog" aria-modal="true" aria-labelledby="ms-review-title">
        <header>
          <h3 id="ms-review-title">Save {plural(changes.length, 'change')}?</h3>
          <button type="button" className="ms-icon-btn" onClick={onCancel} disabled={saving} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        <ul className="ms-review">
          {changes.map((c) => (
            <li key={c.def.key}>
              <div className="ms-review-label">{c.def.label}</div>
              <div className="ms-review-values">
                <span className="is-from">{show(c.def, c.from)}</span>
                <span aria-hidden="true">→</span>
                <span className="is-to">
                  {show(c.def, c.to)}
                  {c.to === c.def.baseValue ? ' (default)' : ''}
                </span>
              </div>
              {c.warning && (
                <div className="ms-review-warn">
                  <AlertIcon size={13} /> {c.warning}
                </div>
              )}
            </li>
          ))}
        </ul>
        {error && <div className="ms-error">{error}</div>}
        <footer>
          <span className="ms-modal-note">Applies to everyone right away; open screens update within a minute.</span>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
            Back
          </button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : `Save ${plural(changes.length, 'change')}`}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// ---- The screen ---------------------------------------------------------------------------

// Unsaved changes survive switching to another screen and back.
let keptDraft = {};

export default function MasterSettings({ onNavigate, onSaved }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraftState] = useState(() => keptDraft);
  const [invalid, setInvalid] = useState({});
  const [version, setVersion] = useState(0); // remounts number fields on discard
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [active, setActive] = useState('features');
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [toast, setToast] = useState('');
  const sectionRefs = useRef({});

  const setDraft = useCallback((next) => {
    setDraftState((cur) => {
      const value = typeof next === 'function' ? next(cur) : next;
      keptDraft = value;
      return value;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setData(await fetchMasterSettings());
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const defs = useMemo(() => data?.settings || [], [data]);
  const byKey = useMemo(() => Object.fromEntries(defs.map((d) => [d.key, d])), [defs]);
  const valueOf = useCallback((key) => (key in draft ? draft[key] : byKey[key]?.value), [draft, byKey]);
  const values = useMemo(() => Object.fromEntries(defs.map((d) => [d.key, valueOf(d.key)])), [defs, valueOf]);
  const savedValues = useMemo(() => Object.fromEntries(defs.map((d) => [d.key, d.value])), [defs]);

  // Drop staged values that match what's saved (e.g. switched off and on again).
  const changes = useMemo(
    () =>
      defs
        .filter((d) => d.key in draft && draft[d.key] !== d.value)
        .map((d) => ({ def: d, from: d.value, to: draft[d.key], warning: warningFor(d, d.value, draft[d.key], data?.live) })),
    [defs, draft, data],
  );
  const hasInvalid = Object.values(invalid).some(Boolean);

  function change(key, value) {
    setDraft((cur) => ({ ...cur, [key]: value }));
    setToast('');
  }
  const markInvalid = useCallback((key, bad) => setInvalid((cur) => (cur[key] === bad ? cur : { ...cur, [key]: bad })), []);

  function discard() {
    setDraft({});
    setInvalid({});
    setVersion((v) => v + 1);
  }

  async function save() {
    setSaving(true);
    setSaveError('');
    try {
      const patch = Object.fromEntries(changes.map((c) => [c.def.key, c.to === c.def.baseValue ? null : c.to]));
      const result = await saveMasterSettings(patch);
      setData(result);
      setDraft({});
      setInvalid({});
      setVersion((v) => v + 1);
      setReviewing(false);
      const n = result.changes?.length ?? changes.length;
      setToast(n ? `Saved ${plural(n, 'change')}. Everyone has the new settings now.` : 'Nothing needed saving.');
      onSaved?.();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // Leaving the page with unsaved changes asks first; Ctrl+S opens the review.
  useEffect(() => {
    if (!changes.length) return undefined;
    const beforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!hasInvalid) setReviewing(true);
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('keydown', onKey);
    };
  }, [changes.length, hasInvalid]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // Which section is on screen, for the side menu.
  useEffect(() => {
    if (!data) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (seen) setActive(seen.target.dataset.section);
      },
      { rootMargin: '-15% 0px -70% 0px' },
    );
    Object.values(sectionRefs.current).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [data, query, changedOnly]);

  const jump = (id) => {
    setActive(id);
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const q = query.trim().toLowerCase();
  const matches = (d) =>
    (!q || `${d.label} ${d.help} ${d.key}`.toLowerCase().includes(q)) && (!changedOnly || values[d.key] !== d.baseValue || d.key in draft);
  const sections = (data?.sections || []).map((s) => ({ ...s, defs: defs.filter((d) => d.section === s.id && matches(d)) }));
  const notDefault = defs.filter((d) => d.value !== d.baseValue).length;

  if (!data) {
    return (
      <div className="ms-page">
        {loadError ? (
          <div className="error modern-error-alert">
            <div className="alert-icon">⚠️</div>
            <div className="alert-body">
              <strong>Couldn’t load the settings</strong>
              <div>{loadError}</div>
              <button type="button" className="btn btn-secondary" onClick={load}>
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div className="loading modern-loading">
            <div className="spinner" />
            <div>Loading settings…</div>
          </div>
        )}
      </div>
    );
  }

  const live = data.live || {};
  const saved = savedValues;
  const glance = [
    {
      id: 'whatsapp',
      icon: WhatsAppIcon,
      title: 'WhatsApp',
      value: live.whatsappLive === null ? '—' : live.whatsappLive ? 'Live mode' : 'Test mode',
      sub: !saved['whatsapp.autoSend'] ? 'Automatic sending off' : live.whatsappLive ? 'Sends automatically' : 'Nothing goes to patients',
      tone: live.whatsappLive && saved['whatsapp.autoSend'] ? 'ok' : 'neutral',
    },
    {
      id: 'retry',
      icon: RotateCcwIcon,
      title: 'Retries',
      value: saved['retry.enabled'] ? `Every ${saved['retry.everyHours']} h · ${plural(saved['retry.forDays'], 'day')}` : 'Off',
      sub: live.retries ? `${plural(live.retries.waiting, 'report')} waiting` : '',
      tone: saved['retry.enabled'] ? 'ok' : 'warn',
    },
    {
      id: 'discharge',
      icon: ClockIcon,
      title: 'Discharge check',
      value: saved['discharge.autoCheck'] ? `Every ${saved['discharge.checkMinutes']} min` : 'Paused',
      sub: saved['discharge.autoCheck'] && live.scheduler?.nextCheckAt ? `Next at ${fmtTime(live.scheduler.nextCheckAt)}` : 'Check Now still works',
      tone: saved['discharge.autoCheck'] ? 'ok' : 'warn',
    },
    {
      id: 'notice',
      icon: saved['maintenance.readOnly'] ? LockIcon : MegaphoneIcon,
      title: 'Portal',
      value: saved['maintenance.readOnly'] ? 'Read-only mode' : 'Normal',
      sub: saved['notice.text'] ? 'Announcement showing' : 'No announcement',
      tone: saved['maintenance.readOnly'] ? 'warn' : 'ok',
    },
  ];

  return (
    <div className={`ms-page ${changes.length ? 'has-savebar' : ''}`}>
      <header className="al-hero ms-hero">
        <div className="al-hero-icon">
          <GearIcon size={26} />
        </div>
        <div className="al-hero-text">
          <h2>Master Settings</h2>
          <p>
            Every switch and timing of the portal in one place. Changes apply to everyone as soon as you save.
            {data.updatedAt && (
              <>
                {' '}
                Last changed {fmtWhen(data.updatedAt)}
                {data.updatedBy ? ` by ${data.updatedBy}` : ''}.
              </>
            )}
          </p>
        </div>
        <div className="al-hero-actions">
          <button type="button" className="al-hero-btn" onClick={load} disabled={loading}>
            <RefreshIcon size={15} spinning={loading} /> Refresh
          </button>
        </div>
      </header>

      <div className="ms-glance">
        {glance.map((g) => (
          <button key={g.id} type="button" className={`ms-glance-card is-${g.tone}`} onClick={() => jump(g.id)}>
            <span className="ms-glance-icon">
              <g.icon size={18} />
            </span>
            <span className="ms-glance-text">
              <small>{g.title}</small>
              <b>{g.value}</b>
              {g.sub && <span>{g.sub}</span>}
            </span>
          </button>
        ))}
      </div>

      {toast && (
        <div className="ms-toast" role="status">
          <CheckIcon size={15} /> {toast}
        </div>
      )}

      <div className="ms-layout">
        <nav className="ms-nav" aria-label="Settings sections">
          {sections.map((s) => {
            const Icon = SECTION_ICONS[s.icon] || GearIcon;
            const all = defs.filter((d) => d.section === s.id);
            const unsaved = changes.some((c) => c.def.section === s.id);
            const custom = all.filter((d) => d.value !== d.baseValue).length;
            return (
              <button
                key={s.id}
                type="button"
                className={`ms-nav-item ${active === s.id ? 'is-active' : ''}`}
                onClick={() => jump(s.id)}
                disabled={!s.defs.length}
                aria-current={active === s.id ? 'true' : undefined}
              >
                <Icon size={15} />
                <span>{s.title}</span>
                {unsaved ? <i className="ms-nav-dot" title="Unsaved changes" /> : custom > 0 && <em title={`${custom} changed from the default`}>{custom}</em>}
              </button>
            );
          })}
          <button type="button" className={`ms-nav-item ${active === HISTORY_ID ? 'is-active' : ''}`} onClick={() => jump(HISTORY_ID)}>
            <HistoryIcon size={15} />
            <span>Change history</span>
          </button>
        </nav>

        <div className="ms-main">
          <div className="ms-tools">
            <label className="ms-search">
              <SearchIcon size={15} />
              <input type="search" placeholder="Find a setting — e.g. retry, password, WhatsApp" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <button type="button" className={`wa-chip ${changedOnly ? 'is-on' : ''}`} onClick={() => setChangedOnly((v) => !v)} aria-pressed={changedOnly}>
              Changed from default ({notDefault})
            </button>
          </div>

          {sections.every((s) => !s.defs.length) && (
            <div className="ms-empty">
              No setting matches {q ? `“${query}”` : 'that'}.{' '}
              <button
                type="button"
                className="ms-link"
                onClick={() => {
                  setQuery('');
                  setChangedOnly(false);
                }}
              >
                Show all
              </button>
            </div>
          )}

          {sections
            .filter((s) => s.defs.length)
            .map((s) => {
              const Icon = SECTION_ICONS[s.icon] || GearIcon;
              const resettable = s.defs.filter((d) => values[d.key] !== d.baseValue);
              return (
                <section
                  key={s.id}
                  className="ms-section"
                  id={`ms-section-${s.id}`}
                  data-section={s.id}
                  ref={(el) => {
                    sectionRefs.current[s.id] = el;
                  }}
                >
                  <header className="ms-section-head">
                    <span className="ms-section-icon">
                      <Icon size={18} />
                    </span>
                    <div>
                      <h3>{s.title}</h3>
                      <p>{s.intro}</p>
                    </div>
                    {resettable.length > 0 && (
                      <button
                        type="button"
                        className="ms-reset is-section"
                        onClick={() => setDraft((cur) => ({ ...cur, ...Object.fromEntries(resettable.map((d) => [d.key, d.baseValue])) }))}
                      >
                        <RotateCcwIcon size={11} /> Reset section
                      </button>
                    )}
                  </header>
                  {!q && !changedOnly && <SectionExtra id={s.id} values={values} live={live} onNavigate={onNavigate} />}
                  <div className="ms-rows">
                    {s.defs.map((d) => (
                      <SettingRow
                        key={d.key}
                        def={d}
                        value={values[d.key]}
                        saved={d.value}
                        dirty={changes.some((c) => c.def.key === d.key)}
                        live={live}
                        version={`${d.key}-${version}`}
                        onChange={(v) => change(d.key, v)}
                        onInvalid={markInvalid}
                      />
                    ))}
                  </div>
                </section>
              );
            })}

          <section
            className="ms-section"
            data-section={HISTORY_ID}
            ref={(el) => {
              sectionRefs.current[HISTORY_ID] = el;
            }}
          >
            <header className="ms-section-head">
              <span className="ms-section-icon">
                <HistoryIcon size={18} />
              </span>
              <div>
                <h3>Change history</h3>
                <p>The last changes made here, newest first.</p>
              </div>
            </header>
            {data.history?.length ? (
              <ol className="ms-history">
                {data.history.map((h, i) => (
                  <li key={`${h.at}-${h.key}-${i}`}>
                    <span className="ms-history-when">{fmtWhen(h.at)}</span>
                    <span className="ms-history-what">
                      <b>{h.label}</b> {h.from} → {h.to}
                    </span>
                    <span className="ms-history-who">{h.by || '—'}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="ms-empty">Nothing changed yet — everything is on its default.</div>
            )}
          </section>
        </div>
      </div>

      {changes.length > 0 && (
        <div className="ms-savebar" role="region" aria-label="Unsaved changes">
          <span className="ms-savebar-text">
            <i className="ms-nav-dot" /> {plural(changes.length, 'unsaved change')}
            {hasInvalid && <em> · fix the highlighted number first</em>}
          </span>
          <button type="button" className="btn btn-secondary" onClick={discard}>
            Discard
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setSaveError('');
              setReviewing(true);
            }}
            disabled={hasInvalid}
          >
            Review &amp; save
          </button>
        </div>
      )}

      {reviewing && changes.length > 0 && (
        <ReviewDialog changes={changes} saving={saving} error={saveError} onCancel={() => setReviewing(false)} onSave={save} />
      )}
    </div>
  );
}
