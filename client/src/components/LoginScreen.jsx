import { useEffect, useState } from 'react';
import hospitalLogo from '../assets/hospital-logo.png';
import {
  AlertIcon,
  ArrowRightIcon,
  EyeIcon,
  EyeOffIcon,
  FilePdfIcon,
  LockIcon,
  ShieldCheckIcon,
  UserIcon,
  WhatsAppIcon,
} from './Icons';

// Decorative medical glyphs for the floating background (24×24, stroked).
const GLYPHS = {
  pulse: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  heart: [
    'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z',
    'M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27',
  ],
  cross: [
    'M11 2a2 2 0 0 0-2 2v5H4a2 2 0 0 0-2 2v2c0 1.1.9 2 2 2h5v5c0 1.1.9 2 2 2h2a2 2 0 0 0 2-2v-5h5a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-5V4a2 2 0 0 0-2-2h-2z',
  ],
  flask: [
    'M10 2v7.53a2 2 0 0 1-.21.9L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.07-10.12a2 2 0 0 1-.21-.9V2',
    'M8.5 2h7',
    'M7 16h10',
  ],
  pill: ['m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z', 'm8.5 8.5 7 7'],
  dna: [
    'M2 15c6.67-6 13.33 0 20-6',
    'M9 22c1.8-2 2.52-4 2.81-5.99',
    'M15 2c-1.8 2-2.52 4-2.81 5.99',
    'm17 6-2.5-2.5',
    'm14 8-1-1',
    'm7 18 2.5 2.5',
    'm10 16 1.5 1.5',
  ],
  stethoscope: [
    'M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3',
    'M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4',
    'M22 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  ],
  microscope: [
    'M6 18h8',
    'M3 22h18',
    'M14 22a7 7 0 1 0 0-14h-1',
    'M9 14h2',
    'M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z',
    'M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3',
  ],
  droplet: ['M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z'],
  syringe: [
    'm18 2 4 4',
    'm17 7 3-3',
    'M19 9 8.7 19.3c-1 1-2.5 1-3.4 0l-.6-.6c-1-1-1-2.5 0-3.4L15 5',
    'm9 11 4 4',
    'm5 19-3 3',
    'm14 4 6 6',
  ],
  clipboard: [
    'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2',
    'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z',
    'M12 11v6',
    'M9 14h6',
  ],
  thermometer: ['M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z'],
};

// x: horizontal start (%), s: size (px), d: rise duration (s), delay: negative so
// the field is already spread out on first paint, r: total rotation (deg).
const FLOATERS = [
  { g: 'cross', x: 4, s: 34, d: 26, delay: -3, r: 90 },
  { g: 'pulse', x: 13, s: 26, d: 21, delay: -14, r: -40 },
  { g: 'flask', x: 22, s: 30, d: 29, delay: -8, r: 60 },
  { g: 'heart', x: 31, s: 38, d: 33, delay: -22, r: -30 },
  { g: 'pill', x: 40, s: 24, d: 23, delay: -1, r: 180 },
  { g: 'dna', x: 49, s: 36, d: 31, delay: -17, r: 45 },
  { g: 'stethoscope', x: 58, s: 32, d: 27, delay: -9, r: -60 },
  { g: 'droplet', x: 66, s: 22, d: 19, delay: -12, r: 30 },
  { g: 'microscope', x: 74, s: 34, d: 34, delay: -26, r: -45 },
  { g: 'syringe', x: 82, s: 28, d: 24, delay: -5, r: 120 },
  { g: 'clipboard', x: 90, s: 30, d: 30, delay: -19, r: -20 },
  { g: 'thermometer', x: 96, s: 24, d: 22, delay: -11, r: 70 },
  { g: 'cross', x: 36, s: 18, d: 18, delay: -6, r: -90 },
  { g: 'pulse', x: 70, s: 20, d: 20, delay: -15, r: 25 },
  { g: 'pill', x: 8, s: 20, d: 25, delay: -20, r: -120 },
  { g: 'heart', x: 86, s: 22, d: 28, delay: -2, r: 40 },
];

function FloatingGlyphs() {
  return (
    <div className="lock-floaters" aria-hidden="true">
      {FLOATERS.map((f, i) => (
        <span
          key={i}
          className="lock-floater"
          style={{
            '--x': `${f.x}%`,
            '--size': `${f.s}px`,
            '--dur': `${f.d}s`,
            '--delay': `${f.delay}s`,
            '--rot': `${f.r}deg`,
            '--drift': `${(i % 2 ? -1 : 1) * (18 + (i % 4) * 8)}px`,
            '--y': `${6 + ((i * 37) % 84)}%`,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            {GLYPHS[f.g].map((d) => (
              <path key={d} d={d} />
            ))}
          </svg>
        </span>
      ))}
    </div>
  );
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export default function LoginScreen({
  hospital,
  username,
  password,
  loading,
  error,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}) {
  const now = useClock();
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const date = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hospitalName = hospital?.nameEn || 'Adhiparasakthi Hospitals';

  function trackCapsLock(e) {
    if (typeof e.getModifierState === 'function') setCapsLock(e.getModifierState('CapsLock'));
  }

  return (
    <div className="lock-screen">
      <div className="lock-glow lock-glow-a" aria-hidden="true" />
      <div className="lock-glow lock-glow-b" aria-hidden="true" />
      <div className="lock-glow lock-glow-c" aria-hidden="true" />
      <FloatingGlyphs />

      <main className="lock-layout">
        <section className="lock-intro">
          <div className="lock-clock" aria-live="off">
            <div className="lock-time">{time}</div>
            <div className="lock-date">{date}</div>
          </div>

          <div className="lock-brand">
            <img src={hospitalLogo} alt="" className="lock-brand-logo" />
            <div>
              <div className="lock-brand-name">{hospitalName}</div>
              {hospital?.nameTa && <div className="lock-brand-ta">{hospital.nameTa}</div>}
            </div>
          </div>

          <p className="lock-tagline">
            Lab reports and discharge summaries, generated automatically at discharge and delivered to
            patients on WhatsApp.
          </p>

          <ul className="lock-features">
            <li>
              <FilePdfIcon size={15} />
              Lab reports
            </li>
            <li>
              <FilePdfIcon size={15} />
              Discharge summaries
            </li>
            <li>
              <WhatsAppIcon size={15} />
              WhatsApp delivery
            </li>
          </ul>
        </section>

        <section className="lock-card" aria-labelledby="lock-card-title">
          <div className="lock-card-head">
            <div className="lock-card-icon">
              <LockIcon size={22} />
            </div>
            <h1 id="lock-card-title">Staff sign in</h1>
            <p>Diagnostics Summary Portal</p>
          </div>

          <form onSubmit={onSubmit} className="login-form">
            <label className="lock-field">
              <span className="lock-label">Username</span>
              <span className="lock-input">
                <UserIcon size={17} className="lock-input-icon" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => onUsernameChange(e.target.value)}
                  placeholder="Enter username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  required
                />
              </span>
            </label>

            <label className="lock-field">
              <span className="lock-label">Password</span>
              <span className="lock-input">
                <LockIcon size={17} className="lock-input-icon" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => onPasswordChange(e.target.value)}
                  onKeyDown={trackCapsLock}
                  onKeyUp={trackCapsLock}
                  placeholder="Enter password"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="lock-reveal"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
                </button>
              </span>
              {capsLock && <span className="lock-hint">Caps Lock is on</span>}
            </label>

            {error && (
              <div className="lock-error" role="alert">
                <AlertIcon size={16} />
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="lock-submit" disabled={loading}>
              {loading ? (
                <>
                  <span className="lock-spinner" aria-hidden="true" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRightIcon size={17} />
                </>
              )}
            </button>
          </form>

          <div className="lock-card-foot">
            <ShieldCheckIcon size={14} />
            Authorised staff only · 12-hour sessions
          </div>
        </section>
      </main>
    </div>
  );
}
