import { useCallback, useEffect, useMemo, useState } from 'react';
import { createUser, deleteUser, fetchUsers, resetUserPassword, signOutUserEverywhere, updateUser } from '../api/client';
import { initials } from '../utils/access';
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  KeyIcon,
  LockIcon,
  LogoutIcon,
  PlusIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TrashIcon,
  UsersIcon,
  WhatsAppIcon,
} from './Icons';

const SCREEN_SHORT = { search: 'Lab Search', reports: 'Reports', labFinder: 'Lab Finder', wati: 'WATI', monitor: 'Monitor' };
const AI_LABEL = { none: 'Off', ask: 'Ask questions', act: 'Ask + send' };
const DOC_LABEL = { both: 'Both reports', lab: 'Lab report only', summary: 'Summary only' };
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOUR_PRESETS = [
  { label: 'Mon–Fri · 9 am–6 pm', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' },
  { label: 'Mon–Sat · 8 am–8 pm', days: [1, 2, 3, 4, 5, 6], from: '08:00', to: '20:00' },
  { label: 'Night shift · 8 pm–8 am', days: [1, 2, 3, 4, 5, 6, 7], from: '20:00', to: '08:00' },
  { label: 'Every day · all day', days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '00:00' },
];
const AVATAR_TONES = ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#4f46e5', '#16a34a'];

function tone(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

function timeAgo(value) {
  if (!value) return 'Never';
  const s = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Same wording as the server's describeSchedule. */
function describeSchedule(s) {
  if (!s?.enabled) return 'Any time';
  const days = [...(s.days || [])].sort();
  const runs = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && d === last[1] + 1) last[1] = d;
    else runs.push([d, d]);
  }
  const dayText =
    days.length === 7
      ? 'Every day'
      : runs.map(([a, b]) => (a === b ? DAY_NAMES[a - 1] : b === a + 1 ? `${DAY_NAMES[a - 1]}, ${DAY_NAMES[b - 1]}` : `${DAY_NAMES[a - 1]}–${DAY_NAMES[b - 1]}`)).join(', ');
  return `${dayText || 'No days'}, ${s.from === s.to ? 'all day' : `${s.from}–${s.to}`}`;
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint32Array(10);
  crypto.getRandomValues(bytes);
  return `${Array.from(bytes, (n) => chars[n % chars.length]).join('')}@${(bytes[0] % 90) + 10}`;
}

function Avatar({ user, size = 40 }) {
  return (
    <span className="um-avatar" style={{ width: size, height: size, background: user.isSuperAdmin ? '#0b2956' : tone(user.username), fontSize: size * 0.38 }}>
      {user.isSuperAdmin ? <ShieldCheckIcon size={size * 0.5} /> : initials(user.name || user.username)}
    </span>
  );
}

function Switch({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`um-switch ${checked ? 'is-on' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
    >
      <span />
    </button>
  );
}

function Segmented({ value, options, onChange, disabled, small }) {
  return (
    <div className={`um-seg ${small ? 'is-small' : ''}`} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'is-on' : ''}
          onClick={() => onChange(o.value)}
          disabled={disabled || o.disabled}
          title={o.title}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- The editor ------------------------------------------------------------------

const EMPTY_USER = {
  username: '',
  name: '',
  designation: '',
  department: '',
  phone: '',
  email: '',
  password: '',
  active: true,
  mustChangePassword: true,
  permissions: null,
};

function UserEditor({ model, user, onClose, onSaved }) {
  const isNew = !user;
  const viewer = model.presets.find((p) => p.id === 'viewer');
  const [form, setForm] = useState(() =>
    isNew ? { ...EMPTY_USER, password: generatePassword(), permissions: structuredClone(viewer.permissions) } : { ...EMPTY_USER, ...user, password: '' },
  );
  const [showPassword, setShowPassword] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [preset, setPreset] = useState(isNew ? 'viewer' : '');
  const p = form.permissions;

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setPerm = (fn) => {
    setPreset('');
    setForm((f) => ({ ...f, permissions: fn(structuredClone(f.permissions)) }));
  };
  const setScreen = (id, level) => setPerm((x) => ({ ...x, screens: { ...x.screens, [id]: level } }));
  const setSchedule = (patch) => setPerm((x) => ({ ...x, schedule: { ...x.schedule, ...patch } }));

  function applyPreset(id) {
    const chosen = model.presets.find((x) => x.id === id);
    if (!chosen) return;
    setForm((f) => ({ ...f, permissions: structuredClone(chosen.permissions), designation: f.designation || (id === 'viewer' || id === 'admin' ? '' : chosen.label) }));
    setPreset(id);
  }

  const tabs = model.screens.filter((s) => p.screens[s.id] !== 'none');
  const whatsappNeedsWrite = p.whatsappButton && p.screens.reports !== 'write';

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) return setError('Enter the person\'s name');
    if (isNew && !/^[a-z0-9._-]{3,32}$/i.test(form.username.trim())) return setError('Username: 3–32 letters, numbers, dot, dash or underscore');
    if (isNew && form.password.length < model.minPasswordLength) return setError(`Password must be at least ${model.minPasswordLength} characters`);
    if (p.schedule.enabled && !p.schedule.days.length) return setError('Pick at least one day for the access hours');
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        designation: form.designation,
        department: form.department,
        phone: form.phone,
        email: form.email,
        active: form.active,
        permissions: p,
      };
      const saved = isNew
        ? await createUser({ ...payload, username: form.username.trim().toLowerCase(), password: form.password, mustChangePassword: form.mustChangePassword })
        : await updateUser(user.username, payload);
      onSaved(saved, isNew ? { password: form.password } : null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="um-drawer-backdrop" onMouseDown={onClose}>
      <form className="um-drawer" onMouseDown={(e) => e.stopPropagation()} onSubmit={save} aria-label={isNew ? 'Add user' : `Edit ${user.name}`}>
        <header className="um-drawer-head">
          <Avatar user={{ ...form, username: form.username || 'new' }} size={44} />
          <div>
            <h3>{isNew ? 'Add user' : form.name || user.username}</h3>
            <p>{isNew ? 'Profile, then what they can see and do' : `@${user.username}`}</p>
          </div>
          <button type="button" className="um-icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="um-drawer-body">
          {/* 1. Profile */}
          <section className="um-section">
            <h4>
              <span className="um-step">1</span> Profile
            </h4>
            <div className="um-grid">
              <label className="um-field">
                <span>Full name *</span>
                <input value={form.name} onChange={set('name')} placeholder="e.g. Dr. Priya Raman" autoFocus={isNew} maxLength={120} />
              </label>
              <label className="um-field">
                <span>Username *</span>
                <input
                  value={form.username}
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.toLowerCase().replace(/\s+/g, '') }))}
                  placeholder="e.g. priya.r"
                  disabled={!isNew}
                  maxLength={32}
                  autoComplete="off"
                />
              </label>
              <label className="um-field">
                <span>Designation</span>
                <input value={form.designation} onChange={set('designation')} placeholder="e.g. Staff nurse" maxLength={120} />
              </label>
              <label className="um-field">
                <span>Department</span>
                <input value={form.department} onChange={set('department')} placeholder="e.g. General Medicine" maxLength={120} />
              </label>
              <label className="um-field">
                <span>Mobile</span>
                <input value={form.phone} onChange={set('phone')} placeholder="+91 …" inputMode="tel" maxLength={20} />
              </label>
              <label className="um-field">
                <span>Email</span>
                <input value={form.email} onChange={set('email')} placeholder="name@hospital.org" type="email" maxLength={120} />
              </label>
              {isNew && (
                <label className="um-field um-span-2">
                  <span>Password *</span>
                  <div className="um-password">
                    <input
                      value={form.password}
                      onChange={set('password')}
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      minLength={model.minPasswordLength}
                    />
                    <button type="button" className="um-icon-btn" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                      {showPassword ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                    </button>
                    <button type="button" className="um-chip-btn" onClick={() => setForm((f) => ({ ...f, password: generatePassword() }))}>
                      Generate
                    </button>
                  </div>
                  <small>Give this to the person to sign in the first time.</small>
                  <label className="um-inline-check">
                    <input type="checkbox" checked={form.mustChangePassword} onChange={(e) => setForm((f) => ({ ...f, mustChangePassword: e.target.checked }))} />
                    <span>Make them choose their own password at first sign-in (then only they know it)</span>
                  </label>
                </label>
              )}
            </div>
            <div className="um-row-toggle">
              <div>
                <b>Account active</b>
                <span>Turn off to block sign-in without deleting the account.</span>
              </div>
              <Switch checked={form.active} onChange={(v) => setForm((f) => ({ ...f, active: v }))} label="Account active" />
            </div>
          </section>

          {/* 2. Role preset */}
          <section className="um-section">
            <h4>
              <span className="um-step">2</span> Start from a role
            </h4>
            <div className="um-presets">
              {model.presets.map((x) => (
                <button key={x.id} type="button" className={`um-preset ${preset === x.id ? 'is-on' : ''}`} onClick={() => applyPreset(x.id)} title={x.description}>
                  <b>{x.label}</b>
                  <span>{x.description}</span>
                </button>
              ))}
            </div>
            <p className="um-hint">A preset fills everything below; change anything after.</p>
          </section>

          {/* 3. Screens */}
          <section className="um-section">
            <h4>
              <span className="um-step">3</span> Screens
            </h4>
            <div className="um-screens">
              {model.screens.map((sc) => {
                const level = p.screens[sc.id];
                const on = level !== 'none';
                return (
                  <div key={sc.id} className={`um-screen ${on ? 'is-on' : ''}`}>
                    <label className="um-check">
                      <input type="checkbox" checked={on} onChange={(e) => setScreen(sc.id, e.target.checked ? 'read' : 'none')} />
                      <span className="um-check-box">{on && <CheckIcon size={12} />}</span>
                      <span className="um-screen-text">
                        <b>{sc.label}</b>
                        <small>{sc.write ? `Read & write: ${sc.write.charAt(0).toLowerCase()}${sc.write.slice(1)}` : 'Look-up only — nothing to change here'}</small>
                      </span>
                    </label>
                    <Segmented
                      small
                      value={level === 'none' ? '' : level}
                      disabled={!on}
                      onChange={(v) => setScreen(sc.id, v)}
                      options={[
                        { value: 'read', label: 'Read only' },
                        { value: 'write', label: 'Read & write', disabled: !sc.write, title: sc.write ? '' : 'Nothing to change on this screen' },
                      ]}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          {/* 4. Features */}
          <section className="um-section">
            <h4>
              <span className="um-step">4</span> Features
            </h4>
            <div className="um-feature">
              <div className="um-feature-text">
                <b>
                  <SparklesIcon size={14} /> Ask AI
                </b>
                <span>Chat assistant — only ever shows what this user's screens allow.</span>
              </div>
              <Segmented
                small
                value={p.ai}
                onChange={(v) => setPerm((x) => ({ ...x, ai: v }))}
                options={[
                  { value: 'none', label: 'Off' },
                  { value: 'ask', label: 'Ask questions' },
                  { value: 'act', label: 'Ask + send' },
                ]}
              />
            </div>
            <div className="um-feature">
              <div className="um-feature-text">
                <b>
                  <WhatsAppIcon size={14} /> WhatsApp button on patient cards
                </b>
                <span>Lets them send a patient's reports on WhatsApp.</span>
                {whatsappNeedsWrite && (
                  <span className="um-warn">
                    <AlertIcon size={12} /> Needs Discharge Reports set to Read & write to take effect.
                  </span>
                )}
              </div>
              <Switch checked={p.whatsappButton} onChange={(v) => setPerm((x) => ({ ...x, whatsappButton: v }))} label="WhatsApp button" />
            </div>
            <div className="um-feature">
              <div className="um-feature-text">
                <b>Reports shown</b>
                <span>Which PDFs they can open and send.</span>
              </div>
              <Segmented
                small
                value={p.documents}
                onChange={(v) => setPerm((x) => ({ ...x, documents: v }))}
                options={[
                  { value: 'both', label: 'Both' },
                  { value: 'lab', label: 'Lab report' },
                  { value: 'summary', label: 'Summary' },
                ]}
              />
            </div>
          </section>

          {/* 5. Access hours */}
          <section className="um-section">
            <h4>
              <span className="um-step">5</span> Access hours
            </h4>
            <div className="um-row-toggle">
              <div>
                <b>Limit when they can use the portal</b>
                <span>Outside these hours they can't sign in, and an open session ends. India time.</span>
              </div>
              <Switch checked={p.schedule.enabled} onChange={(v) => setSchedule({ enabled: v })} label="Limit access hours" />
            </div>
            {p.schedule.enabled && (
              <div className="um-hours">
                <div className="um-days" role="group" aria-label="Days">
                  {DAY_NAMES.map((d, i) => {
                    const day = i + 1;
                    const on = p.schedule.days.includes(day);
                    return (
                      <button
                        key={d}
                        type="button"
                        className={on ? 'is-on' : ''}
                        aria-pressed={on}
                        onClick={() => setSchedule({ days: on ? p.schedule.days.filter((x) => x !== day) : [...p.schedule.days, day].sort() })}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
                <div className="um-times">
                  <label>
                    <span>From</span>
                    <input type="time" value={p.schedule.from} onChange={(e) => setSchedule({ from: e.target.value })} />
                  </label>
                  <label>
                    <span>To</span>
                    <input type="time" value={p.schedule.to} onChange={(e) => setSchedule({ to: e.target.value })} />
                  </label>
                </div>
                <div className="um-hour-presets">
                  {HOUR_PRESETS.map((h) => (
                    <button key={h.label} type="button" className="um-chip-btn" onClick={() => setSchedule({ days: h.days, from: h.from, to: h.to })}>
                      {h.label}
                    </button>
                  ))}
                </div>
                <div className="um-hours-preview">
                  <ClockIcon size={14} /> Can use the portal: <b>{describeSchedule(p.schedule)}</b>
                  {p.schedule.from > p.schedule.to && p.schedule.to !== '00:00' && <span> (overnight)</span>}
                </div>
              </div>
            )}
          </section>

          {/* Preview */}
          <section className="um-section um-preview">
            <h4>What they'll see</h4>
            <div className="um-preview-tabs">
              {tabs.length ? tabs.map((t) => (
                <span key={t.id} className={`um-tab ${p.screens[t.id] === 'write' ? 'is-write' : ''}`}>
                  {t.label}
                  <small>{p.screens[t.id] === 'write' ? 'edit' : 'view'}</small>
                </span>
              )) : <span className="um-muted">No screens — they couldn't do anything after signing in.</span>}
            </div>
            <div className="um-preview-meta">
              <span>Ask AI: {AI_LABEL[p.ai]}</span>
              <span>WhatsApp button: {p.whatsappButton && p.screens.reports === 'write' ? 'On' : 'Off'}</span>
              <span>{DOC_LABEL[p.documents]}</span>
              <span>{describeSchedule(p.schedule)}</span>
            </div>
          </section>
        </div>

        <footer className="um-drawer-foot">
          {error && (
            <div className="um-error" role="alert">
              <AlertIcon size={14} /> {error}
            </div>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create user' : 'Save changes'}
          </button>
        </footer>
      </form>
    </div>
  );
}

// ---- Password + confirm dialogs ------------------------------------------------------

function PasswordDialog({ user, onClose, onDone }) {
  const [password, setPassword] = useState(generatePassword);
  const [mustChange, setMustChange] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await resetUserPassword(user.username, password, mustChange);
      onDone(password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="um-modal-backdrop" onMouseDown={onClose}>
      <form className="um-modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}>
        <h3>
          <KeyIcon size={18} /> Reset password
        </h3>
        <p>
          Set a new password for <b>{user.name}</b> — e.g. if they forgot theirs. Passwords are stored encrypted, so nobody can see the old one. They'll be signed out on every device.
        </p>
        <div className="um-password">
          <input value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          <button type="button" className="um-chip-btn" onClick={() => setPassword(generatePassword())}>
            Generate
          </button>
        </div>
        <label className="um-inline-check">
          <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
          <span>Make them choose a new password when they sign in (recommended — then only they know it)</span>
        </label>
        {error && <div className="um-error">{error}</div>}
        <div className="um-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || password.length < 8}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDialog({ title, body, action, danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="um-modal-backdrop" onMouseDown={onClose}>
      <div className="um-modal" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-label={title}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="um-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'um-btn-danger' : 'btn-primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm();
              setBusy(false);
            }}
          >
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyLine({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="um-copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <code>{text}</code>
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

// ---- The screen ----------------------------------------------------------------------

function AccessChips({ user }) {
  if (user.isSuperAdmin) return <span className="um-pill is-super">Full access · manages users</span>;
  const p = user.permissions;
  const screens = Object.entries(p.screens).filter(([, v]) => v !== 'none');
  return (
    <div className="um-pills">
      {screens.length ? (
        screens.map(([id, v]) => (
          <span key={id} className={`um-pill ${v === 'write' ? 'is-write' : ''}`} title={v === 'write' ? 'Read & write' : 'Read only'}>
            {SCREEN_SHORT[id]}
          </span>
        ))
      ) : (
        <span className="um-pill is-none">No screens</span>
      )}
      {p.ai !== 'none' && (
        <span className="um-pill is-ai">
          <SparklesIcon size={11} /> {p.ai === 'act' ? 'AI + send' : 'AI'}
        </span>
      )}
      {p.whatsappButton && p.screens.reports === 'write' && (
        <span className="um-pill is-wa">
          <WhatsAppIcon size={11} /> Send
        </span>
      )}
      {p.documents !== 'both' && <span className="um-pill">{DOC_LABEL[p.documents]}</span>}
    </div>
  );
}

export default function UserManagement() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null); // { user } | { user: null } for new
  const [passwordFor, setPasswordFor] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [notice, setNotice] = useState(null); // { text, password? }

  const load = useCallback(async () => {
    try {
      setData(await fetchUsers());
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const users = data?.users || [];
  const staff = users.filter((u) => !u.isSuperAdmin);
  const stats = {
    total: staff.length,
    active: staff.filter((u) => u.active).length,
    limited: staff.filter((u) => u.permissions.schedule.enabled).length,
    senders: staff.filter((u) => u.permissions.whatsappButton && u.permissions.screens.reports === 'write').length,
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (filter === 'active' && (!u.active || u.isSuperAdmin)) return false;
      if (filter === 'disabled' && u.active) return false;
      if (filter === 'limited' && !u.permissions.schedule.enabled) return false;
      if (!q) return true;
      return [u.name, u.username, u.designation, u.department, u.phone, u.email].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [users, query, filter]);

  function flash(text, password) {
    setNotice({ text, password });
    if (!password) setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 4000);
  }

  async function toggleActive(u, active) {
    try {
      await updateUser(u.username, { active });
      flash(`${u.name} ${active ? 'can sign in again' : 'is disabled — they can\'t sign in'}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="um-page">
      <header className="um-hero">
        <div className="um-hero-icon">
          <UsersIcon size={24} />
        </div>
        <div className="um-hero-text">
          <h2>Users &amp; access</h2>
          <p>Who can sign in, which screens they see, what they can change, and when.</p>
        </div>
        <button type="button" className="btn btn-primary um-add" onClick={() => setEditing({ user: null })} disabled={!data}>
          <PlusIcon size={16} /> Add user
        </button>
      </header>

      <div className="um-stats">
        <div className="um-stat">
          <b>{stats.total}</b>
          <span>Staff accounts</span>
        </div>
        <div className="um-stat">
          <b>{stats.active}</b>
          <span>Active</span>
        </div>
        <div className="um-stat">
          <b>{stats.limited}</b>
          <span>With access hours</span>
        </div>
        <div className="um-stat">
          <b>{stats.senders}</b>
          <span>Can send WhatsApp</span>
        </div>
      </div>

      {notice && (
        <div className="um-notice" role="status">
          <CheckIcon size={15} /> <span>{notice.text}</span>
          {notice.password && (
            <>
              <CopyLine text={notice.password} />
              <button type="button" className="um-icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss">
                <CloseIcon size={14} />
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="um-error um-error-block" role="alert">
          <AlertIcon size={15} /> {error}
        </div>
      )}

      <div className="um-toolbar">
        <label className="um-search">
          <SearchIcon size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, username, department…" />
        </label>
        <div className="um-filters" role="group" aria-label="Filter users">
          {[
            ['all', 'All'],
            ['active', 'Active'],
            ['disabled', 'Disabled'],
            ['limited', 'Access hours'],
          ].map(([id, label]) => (
            <button key={id} type="button" className={filter === id ? 'is-on' : ''} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {!data && !error && <div className="um-empty">Loading users…</div>}
      {data && staff.length === 0 && (
        <div className="um-empty">
          <UsersIcon size={28} />
          <b>No staff accounts yet</b>
          <span>Everyone uses the super admin login today. Add each person so you control what they see and do.</span>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ user: null })}>
            <PlusIcon size={16} /> Add the first user
          </button>
        </div>
      )}

      <div className="um-list">
        {shown.map((u) => (
          <article key={u.username} className={`um-user ${u.active ? '' : 'is-disabled'} ${u.isSuperAdmin ? 'is-super' : ''}`}>
            <div className="um-user-id">
              <Avatar user={u} />
              <div className="um-user-name">
                <b>{u.name}</b>
                <span>
                  @{u.username}
                  {u.designation ? ` · ${u.designation}` : ''}
                  {u.department ? ` · ${u.department}` : ''}
                </span>
              </div>
            </div>
            <div className="um-user-access">
              <AccessChips user={u} />
              <div className="um-user-meta">
                <span className={!u.allowedNow ? 'is-blocked' : ''}>
                  <ClockIcon size={12} /> {u.scheduleText}
                  {!u.allowedNow && ' · outside hours now'}
                </span>
                <span>Last sign-in: {timeAgo(u.lastLoginAt)}</span>
                {u.lockedUntil && (
                  <span className="is-blocked">
                    <LockIcon size={12} /> Locked (wrong passwords)
                  </span>
                )}
                {u.mustChangePassword && (
                  <span className="is-pending">
                    <KeyIcon size={12} /> Will set own password at next sign-in
                  </span>
                )}
              </div>
            </div>
            <div className="um-user-actions">
              {u.isSuperAdmin ? (
                <span className="um-muted">Built-in · set in server .env</span>
              ) : (
                <>
                  <Switch checked={u.active} onChange={(v) => toggleActive(u, v)} label={`${u.name} active`} />
                  <button type="button" className="um-action" onClick={() => setEditing({ user: u })} title="Edit profile and access">
                    <EditIcon size={14} /> <span>Edit</span>
                  </button>
                  <button type="button" className="um-action" onClick={() => setPasswordFor(u)} title="Set a new password">
                    <KeyIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="um-action"
                    title="Sign out on every device"
                    onClick={() =>
                      setConfirm({
                        title: 'Sign out everywhere?',
                        body: `${u.name} will be signed out on every device and has to sign in again.`,
                        action: 'Sign out',
                        run: async () => {
                          await signOutUserEverywhere(u.username);
                          flash(`${u.name} was signed out everywhere`);
                        },
                      })
                    }
                  >
                    <LogoutIcon size={14} />
                  </button>
                  {u.lockedUntil && (
                    <button
                      type="button"
                      className="um-action"
                      title="Unlock now"
                      onClick={async () => {
                        await updateUser(u.username, { unlock: true });
                        flash(`${u.name} is unlocked`);
                        load();
                      }}
                    >
                      <LockIcon size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="um-action is-danger"
                    title="Delete user"
                    onClick={() =>
                      setConfirm({
                        title: `Delete ${u.name}?`,
                        body: 'The account is removed and they can\'t sign in. Their past WhatsApp sends stay in the Monitor. To keep the account, turn it off instead.',
                        action: 'Delete',
                        danger: true,
                        run: async () => {
                          await deleteUser(u.username);
                          flash(`${u.name} was deleted`);
                          load();
                        },
                      })
                    }
                  >
                    <TrashIcon size={14} />
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
        {data && staff.length > 0 && shown.length === 0 && <div className="um-empty">No users match.</div>}
      </div>

      {editing && data && (
        <UserEditor
          model={data.model}
          user={editing.user}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            load();
            if (created)
              flash(
                `${saved.name} can sign in as “${saved.username}” with this password${saved.mustChangePassword ? ' — they\'ll then choose their own' : ''}:`,
                created.password,
              );
            else flash(`${saved.name}'s access is saved — it applies from their next click`);
          }}
        />
      )}
      {passwordFor && (
        <PasswordDialog
          user={passwordFor}
          onClose={() => setPasswordFor(null)}
          onDone={(password) => {
            flash(`New password for ${passwordFor.name} (they were signed out everywhere):`, password);
            setPasswordFor(null);
            load();
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          {...confirm}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await confirm.run();
            } catch (err) {
              setError(err.message);
            }
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}
