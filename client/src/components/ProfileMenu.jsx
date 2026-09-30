import { useEffect, useRef, useState } from 'react';
import { changeMyPassword } from '../api/client';
import { initials } from '../utils/access';
import { CheckIcon, ClockIcon, KeyIcon, LogoutIcon, ShieldCheckIcon } from './Icons';

const SCREEN_NAMES = { search: 'Lab Search', reports: 'Discharge Reports', labFinder: 'Lab Finder', wati: 'WATI Settings', monitor: 'WhatsApp Monitor' };
const LEVEL = { read: 'View', write: 'View & change' };
const AI = { none: 'Off', ask: 'Ask questions', act: 'Ask + send' };
const DOCS = { both: 'Lab report + summary', lab: 'Lab report only', summary: 'Discharge summary only' };

/** The header's account button: who you are, what you can do, change password, sign out. */
export default function ProfileMenu({ me, onLogout }) {
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [form, setForm] = useState({ current: '', password: '', confirm: '' });
  const [status, setStatus] = useState({ busy: false, error: '', done: false });
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function savePassword(e) {
    e.preventDefault();
    if (form.password !== form.confirm) return setStatus({ busy: false, error: 'The new passwords don\'t match', done: false });
    setStatus({ busy: true, error: '', done: false });
    try {
      await changeMyPassword(form.current, form.password);
      setForm({ current: '', password: '', confirm: '' });
      setStatus({ busy: false, error: '', done: true });
      setChanging(false);
    } catch (err) {
      setStatus({ busy: false, error: err.message, done: false });
    }
  }

  const p = me.permissions;
  const screens = Object.entries(p.screens).filter(([, v]) => v !== 'none');

  return (
    <div className="pm" ref={ref}>
      <button type="button" className="pm-trigger no-print" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog">
        <span className={`pm-avatar ${me.isSuperAdmin ? 'is-super' : ''}`}>{me.isSuperAdmin ? <ShieldCheckIcon size={16} /> : initials(me.name)}</span>
        <span className="pm-trigger-text hide-on-mobile">
          <b>{me.name}</b>
          <small>{me.isSuperAdmin ? 'Super admin' : me.designation || `@${me.username}`}</small>
        </span>
      </button>

      {open && (
        <div className="pm-panel" role="dialog" aria-label="Your account">
          <div className="pm-head">
            <span className={`pm-avatar is-large ${me.isSuperAdmin ? 'is-super' : ''}`}>{me.isSuperAdmin ? <ShieldCheckIcon size={22} /> : initials(me.name)}</span>
            <div>
              <b>{me.name}</b>
              <span>
                @{me.username}
                {me.designation ? ` · ${me.designation}` : ''}
              </span>
              {me.department && <span>{me.department}</span>}
            </div>
          </div>

          {me.isSuperAdmin ? (
            <div className="pm-note">
              <ShieldCheckIcon size={14} /> Full access to everything, including Users &amp; access.
            </div>
          ) : (
            <>
              <div className="pm-section">
                <div className="pm-label">Your access</div>
                <ul className="pm-access">
                  {screens.map(([id, level]) => (
                    <li key={id}>
                      <span>{SCREEN_NAMES[id]}</span>
                      <em className={level === 'write' ? 'is-write' : ''}>{LEVEL[level]}</em>
                    </li>
                  ))}
                  <li>
                    <span>Ask AI</span>
                    <em>{AI[p.ai]}</em>
                  </li>
                  <li>
                    <span>Reports</span>
                    <em>{DOCS[p.documents]}</em>
                  </li>
                </ul>
              </div>
              <div className="pm-note">
                <ClockIcon size={14} /> Access hours: <b>{me.scheduleText}</b>
              </div>
            </>
          )}

          {status.done && (
            <div className="pm-ok">
              <CheckIcon size={13} /> Password changed. Other devices were signed out.
            </div>
          )}

          {!me.isSuperAdmin &&
            (changing ? (
              <form className="pm-form" onSubmit={savePassword}>
                <input type="password" placeholder="Current password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} autoComplete="current-password" required autoFocus />
                <input type="password" placeholder="New password (8+ characters)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" minLength={8} required />
                <input type="password" placeholder="New password again" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} autoComplete="new-password" minLength={8} required />
                {status.error && <div className="pm-error">{status.error}</div>}
                <div className="pm-form-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setChanging(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={status.busy}>
                    {status.busy ? 'Saving…' : 'Change password'}
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className="pm-item" onClick={() => setChanging(true)}>
                <KeyIcon size={15} /> Change password
              </button>
            ))}

          <button type="button" className="pm-item is-logout" onClick={onLogout}>
            <LogoutIcon size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
