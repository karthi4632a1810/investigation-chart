import { useState } from 'react';
import { changeMyPassword } from '../api/client';
import { EyeIcon, EyeOffIcon, LockIcon, LogoutIcon } from './Icons';

/**
 * Shown right after signing in with a password the super admin set (new
 * account or reset): the person chooses their own, so only they know it.
 * The server allows nothing else until they do.
 */
export default function SetPasswordScreen({ me, tempPassword, onDone, onLogout }) {
  const minLength = me?.minPasswordLength || 8;
  const [current, setCurrent] = useState(tempPassword || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (password.length < minLength) return setError(`Use at least ${minLength} characters`);
    if (password !== confirm) return setError("The two passwords don't match");
    setBusy(true);
    try {
      await changeMyPassword(current, password);
      await onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="pw-screen">
      <form className="pw-card" onSubmit={submit}>
        <div className="pw-icon">
          <LockIcon size={22} />
        </div>
        <h2>Choose your own password</h2>
        <p>
          Welcome, <b>{me.name}</b>. Your account was set up with a temporary password — pick a new one that only you know. The super admin can't see it.
        </p>
        {!tempPassword && (
          <label className="pw-field">
            <span>Temporary password</span>
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus />
          </label>
        )}
        <label className="pw-field">
          <span>New password</span>
          <div className="pw-input">
            <input
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={minLength}
              required
              autoFocus={Boolean(tempPassword)}
            />
            <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>
              {show ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
            </button>
          </div>
          <small>At least {minLength} characters.</small>
        </label>
        <label className="pw-field">
          <span>New password again</span>
          <input type={show ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={minLength} required />
        </label>
        {error && <div className="pw-error" role="alert">{error}</div>}
        <button type="submit" className="btn btn-primary pw-submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save and continue'}
        </button>
        <button type="button" className="pw-logout" onClick={onLogout}>
          <LogoutIcon size={14} /> Sign out
        </button>
      </form>
    </div>
  );
}
