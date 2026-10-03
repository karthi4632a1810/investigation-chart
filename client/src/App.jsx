import { useEffect, useRef, useState } from 'react';
import {
  AUTH_EXPIRED_EVENT,
  checkSession,
  defaultDateOnly,
  fetchHospitalConfig,
  login,
  logout,
  searchInvestigation,
} from './api/client';
import SearchForm from './components/SearchForm';
import InvestigationChart from './components/InvestigationChart';
import RawResults from './components/RawResults';
import DetailModal from './components/DetailModal';
import LoginScreen from './components/LoginScreen';
import DischargeReports from './components/DischargeReports';
import WatiSettings from './components/WatiSettings';
import LabFinder from './components/LabFinder';
import AssistantPanel from './components/AssistantPanel';
import AdminDashboard from './components/admin/AdminDashboard';
import UserManagement from './components/UserManagement';
import ProfileMenu from './components/ProfileMenu';
import SetPasswordScreen from './components/SetPasswordScreen';
import AuditLog from './components/AuditLog';
import MasterSettings from './components/MasterSettings';
import { startAudit, stopAudit, track } from './utils/audit';
import { accessFor, canOpen, firstOpenView } from './utils/access';
import {
  FilePdfIcon,
  ChartIcon,
  ClockIcon,
  CloseIcon,
  FlaskIcon,
  GearIcon,
  HospitalIcon,
  LockIcon,
  MegaphoneIcon,
  SearchIcon,
  ShieldCheckIcon,
  UsersIcon,
  WhatsAppIcon,
} from './components/Icons';

// Screens with their own address: /admin (WhatsApp Monitor), /users, /audit, /settings.
const VIEW_PATHS = { admin: '/admin', users: '/users', audit: '/audit', settings: '/settings' };
const pathView = () => {
  const path = window.location.pathname.replace(/\/+$/, '');
  return Object.keys(VIEW_PATHS).find((v) => VIEW_PATHS[v] === path) || null;
};

function storedUser() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('investigation-auth') || 'null');
    return saved?.permissions ? saved : null;
  } catch {
    return null;
  }
}

// Master Settings everyone gets (switches, announcement, timings) — server: publicSettings().
const APP_KEY = 'investigation-app';
function storedApp() {
  try {
    return JSON.parse(sessionStorage.getItem(APP_KEY) || 'null') || {};
  } catch {
    return {};
  }
}
function keepApp(app) {
  try {
    if (app) sessionStorage.setItem(APP_KEY, JSON.stringify(app));
  } catch {
    // ignore storage errors
  }
}

/**
 * Master Settings → "Sign out after no activity": no mouse / keyboard in any
 * tab of the portal for `minutes` signs out, with a one-minute warning.
 */
const ACTIVITY_KEY = 'portal_last_activity';
function useIdleSignOut(minutes, onSignOut) {
  const [secondsLeft, setSecondsLeft] = useState(null);
  useEffect(() => {
    if (!minutes) {
      setSecondsLeft(null);
      return undefined;
    }
    let last = Date.now();
    let lastShared = 0;
    const mark = () => {
      last = Date.now();
      if (last - lastShared > 5000) {
        lastShared = last;
        try {
          localStorage.setItem(ACTIVITY_KEY, String(last));
        } catch {
          // ignore storage errors
        }
      }
    };
    mark();
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'];
    events.forEach((ev) => window.addEventListener(ev, mark, { passive: true, capture: true }));
    const timer = setInterval(() => {
      let shared = 0;
      try {
        shared = Number(localStorage.getItem(ACTIVITY_KEY)) || 0;
      } catch {
        // ignore storage errors
      }
      const left = minutes * 60_000 - (Date.now() - Math.max(last, shared));
      if (left <= 0) {
        clearInterval(timer);
        onSignOut(minutes);
      } else setSecondsLeft(left <= 60_000 ? Math.ceil(left / 1000) : null);
    }, 1000);
    return () => {
      clearInterval(timer);
      events.forEach((ev) => window.removeEventListener(ev, mark, { capture: true }));
    };
  }, [minutes, onSignOut]);
  return secondsLeft;
}

/** The announcement from Master Settings; each text can be hidden once per session. */
function NoticeBanner({ text, tone }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem('portal_notice_hidden') || '';
    } catch {
      return '';
    }
  });
  if (!text || hidden === text) return null;
  return (
    <div className={`app-notice is-${tone || 'info'} no-print`} role={tone === 'danger' ? 'alert' : 'status'}>
      <MegaphoneIcon size={15} />
      <span>{text}</span>
      <button
        type="button"
        className="app-notice-close"
        aria-label="Hide this announcement"
        onClick={() => {
          setHidden(text);
          try {
            sessionStorage.setItem('portal_notice_hidden', text);
          } catch {
            // ignore storage errors
          }
        }}
      >
        <CloseIcon size={13} />
      </button>
    </div>
  );
}

const RECENT_SEARCHES_KEY = 'portal_recent_searches';

function getRecentSearches() {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(regNo) {
  if (!regNo || !regNo.trim()) return;
  try {
    const current = getRecentSearches();
    const updated = [regNo.trim(), ...current.filter((item) => item !== regNo.trim())].slice(0, 5);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
  } catch {
    // ignore storage errors
  }
}

export default function App() {
  const [hospital, setHospital] = useState(null);
  // The signed-in user and their permissions (server: userService.js).
  const [me, setMe] = useState(storedUser);
  const [appSettings, setAppSettings] = useState(storedApp);
  const applyApp = (app) => {
    if (!app) return;
    keepApp(app);
    setAppSettings(app);
  };
  // So Master Settings can refresh this page's copy right after saving.
  const refreshSessionRef = useRef(() => {});
  // /admin opens the WhatsApp monitor, /users user management; / the rest.
  const [view, setView] = useState(() => pathView() || 'reports'); // 'search' | 'reports' | 'labFinder' | 'wati' | 'admin' | 'users'
  // Set by the AI assistant to open a screen at a given date / filter / query;
  // the screen applies it when `id` changes.
  const [navRequest, setNavRequest] = useState(null);
  const access = accessFor(me);

  // Audit log (utils/audit.js): this browser's screens, clicks and idle time.
  const viewRef = useRef(view);
  const screenSince = useRef({ view, at: Date.now() });
  useEffect(() => {
    if (!me?.username) return undefined;
    startAudit(() => viewRef.current);
    return () => stopAudit();
  }, [me?.username]);
  useEffect(() => {
    viewRef.current = view;
    if (!me?.username) return;
    const prev = screenSince.current;
    track('screen_open', { screen: view, details: prev.view !== view ? { from: prev.view, prevMs: Date.now() - prev.at } : undefined });
    screenSince.current = { view, at: Date.now() };
  }, [view, me?.username]);

  // A screen this user can't open (or lost access to) → their first allowed one.
  useEffect(() => {
    if (me && !canOpen(me, view)) {
      const next = firstOpenView(me);
      if (next && next !== view) setView(next);
    }
  }, [me, view]);

  // Keep the address in step with the screen (/admin, /users ↔ /), keeping ?query.
  useEffect(() => {
    const path = VIEW_PATHS[view] || '/';
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', `${path}${window.location.search}`);
    }
  }, [view]);

  useEffect(() => {
    const onPop = () => {
      const v = pathView();
      if (v) setView(v);
      else setView((cur) => (VIEW_PATHS[cur] ? 'reports' : cur));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function handleAssistantNavigate({ view: nextView, date, filter, query, monitor }) {
    if (!nextView) return;
    setView(nextView);
    setNavRequest({ id: Date.now(), view: nextView, date, filter, query, monitor });
  }
  const [regNo, setRegNo] = useState('');
  const [fromDate, setFromDate] = useState(defaultDateOnly());
  const [toDate, setToDate] = useState(defaultDateOnly());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('chart');
  const [detailOrderId, setDetailOrderId] = useState(null);
  const [recentSearches, setRecentSearches] = useState(getRecentSearches);
  const isAuthenticated = Boolean(me);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  // The password just typed, kept only while a temporary one must be replaced.
  const [tempPassword, setTempPassword] = useState('');

  useEffect(() => {
    fetchHospitalConfig()
      .then(setHospital)
      .catch(() => setHospital({}));
  }, []);

  // The server session is what actually grants access; the sessionStorage flag
  // only remembers the UI state. Drop back to the login screen whenever the
  // server says the session is gone — on load (e.g. after a redeploy or
  // password change) and on any API call that comes back 401.
  // Also re-reads the permissions every few minutes and when the tab comes
  // back, so changes the super admin makes show up without a reload.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const expire = (reason) => {
      sessionStorage.removeItem('investigation-auth');
      setMe(null);
      setPassword('');
      setLoginError(reason || 'Your session has ended — please log in again.');
    };
    const refresh = () =>
      checkSession()
        .then(({ user, app, reason }) => {
          if (!user) return expire(reason);
          sessionStorage.setItem('investigation-auth', JSON.stringify(user));
          setMe(user);
          applyApp(app);
        })
        .catch(() => {});
    refresh();
    refreshSessionRef.current = refresh;
    const onExpired = (e) => expire(e.detail?.reason);
    const onFocus = () => !document.hidden && refresh();
    // Every minute: Master Settings changes (switches, announcement) reach open pages.
    const timer = setInterval(refresh, 60_000);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [isAuthenticated]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError('');

    try {
      const data = await login({ username, password });
      if (data.ok && data.user) {
        sessionStorage.setItem('investigation-auth', JSON.stringify(data.user));
        applyApp(data.app);
        setTempPassword(data.user.mustChangePassword ? password : '');
        setMe(data.user);
        setPassword('');
        if (!canOpen(data.user, view)) setView(firstOpenView(data.user) || 'reports');
      } else {
        setLoginError(data.error || 'Login failed');
      }
    } catch (err) {
      setLoginError(err.message || 'Login failed');
    } finally {
      setLoginLoading(false);
    }
  }

  function handleLogout(reason = '') {
    stopAudit();
    logout();
    sessionStorage.removeItem('investigation-auth');
    setMe(null);
    setUsername('');
    setPassword('');
    setLoginError(typeof reason === 'string' ? reason : '');
  }

  const idleMinutes = isAuthenticated ? Number(appSettings['auth.idleSignOutMinutes']) || 0 : 0;
  const idleSignOutRef = useRef(null);
  idleSignOutRef.current = (minutes) => handleLogout(`Signed out after ${minutes} minutes without activity. Please sign in again.`);
  const onIdle = useRef((minutes) => idleSignOutRef.current(minutes)).current;
  const idleSecondsLeft = useIdleSignOut(idleMinutes, onIdle);

  async function executeSearch(targetRegNo, targetFrom, targetTo) {
    const searchId = targetRegNo || regNo;
    const start = targetFrom || fromDate;
    const end = targetTo || toDate;

    if (!searchId.trim()) return;

    setLoading(true);
    setError('');
    setResult(null);
    setActiveTab('chart');

    try {
      const data = await searchInvestigation({
        regNo: searchId.trim(),
        fromDate: start,
        toDate: end,
      });
      setResult(data);
      saveRecentSearch(searchId);
      setRecentSearches(getRecentSearches());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSearch(e) {
    e.preventDefault();
    executeSearch();
  }

  function handleRecentClick(val) {
    setRegNo(val);
    executeSearch(val, fromDate, toDate);
  }

  const hasData = result?.ok && result.data?.length > 0;

  if (!isAuthenticated) {
    return (
      <LoginScreen
        hospital={hospital}
        username={username}
        password={password}
        loading={loginLoading}
        error={loginError}
        onUsernameChange={setUsername}
        onPasswordChange={setPassword}
        onSubmit={handleLogin}
      />
    );
  }

  if (me?.mustChangePassword) {
    return (
      <SetPasswordScreen
        me={me}
        tempPassword={tempPassword}
        onLogout={handleLogout}
        onDone={async () => {
          setTempPassword('');
          const { user } = await checkSession();
          if (user) {
            sessionStorage.setItem('investigation-auth', JSON.stringify(user));
            setMe(user);
          }
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      {/* Modern Responsive Medical Header */}
      <header className="app-header">
        <div className="app-brand">
          <div className="app-brand-icon">
            <HospitalIcon size={24} />
          </div>
          <div className="app-brand-text">
            <div className="app-brand-title">
              {hospital?.nameEn || 'Adhiparasakthi Hospitals'}
            </div>
            <div className="app-brand-subtitle">
              <span>Diagnostics Summary Portal</span>
              <span className="brand-badge-pill">EMR Portal</span>
            </div>
          </div>
        </div>

        <div className="page-header-actions">
          <nav className="nav-segmented-control no-print" aria-label="Main Navigation">
            {[
              ['search', 'Lab Search', SearchIcon],
              ['reports', 'Discharge Reports', FilePdfIcon],
              ['labFinder', 'Lab Finder', FlaskIcon],
              ['wati', 'WATI Settings', WhatsAppIcon],
              ['admin', 'Monitor', ChartIcon],
              ['audit', 'Audit Log', ShieldCheckIcon],
              ['users', 'Users', UsersIcon],
              ['settings', 'Settings', GearIcon],
            ]
              .filter(([id]) => canOpen(me, id))
              .map(([id, label, Icon]) => (
                <button key={id} type="button" className={`nav-segment-btn ${view === id ? 'active' : ''}`} onClick={() => setView(id)} title={label} aria-label={label}>
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              ))}
          </nav>

          <ProfileMenu me={me} onLogout={handleLogout} />
        </div>
      </header>

      <main className="page">
        <NoticeBanner text={appSettings['notice.text']} tone={appSettings['notice.tone']} />
        {appSettings['maintenance.readOnly'] && (
          <div className="app-notice is-readonly no-print" role="status">
            <LockIcon size={14} />
            {me.isSuperAdmin ? (
              <span>
                <b>Read-only mode is on</b> for staff — they can view but not send, download or change anything. You still have full access.{' '}
                <button type="button" className="app-notice-link" onClick={() => setView('settings')}>
                  Master Settings
                </button>
              </span>
            ) : (
              <span>
                <b>Read-only mode</b> — the portal is under maintenance. You can view everything; sending, downloads and changes are paused.
              </span>
            )}
          </div>
        )}
        {idleSecondsLeft !== null && (
          <div className="app-idle-warning" role="alert">
            <ClockIcon size={16} />
            <span>
              No activity — you’ll be signed out in <b>{idleSecondsLeft} s</b>.
            </span>
            <button type="button" className="btn btn-primary" onClick={() => window.dispatchEvent(new Event('mousedown'))}>
              Stay signed in
            </button>
          </div>
        )}

        {!firstOpenView(me) && (
          <div className="no-access">
            <LockIcon size={28} />
            <b>Your account has no screens yet</b>
            <span>Ask the super admin to give you access.</span>
          </div>
        )}

        {view === 'reports' && canOpen(me, 'reports') && (
          <DischargeReports navRequest={navRequest} access={access} refreshMs={(Number(appSettings['reports.refreshSeconds']) || 20) * 1000} />
        )}

        {view === 'labFinder' && canOpen(me, 'labFinder') && (
          <LabFinder navRequest={navRequest} canShare={access.labFinder.canShare} canDownload={access.exports} />
        )}

        {view === 'wati' && canOpen(me, 'wati') && <WatiSettings readOnly={access.wati.readOnly} />}

        {view === 'admin' && canOpen(me, 'admin') && <AdminDashboard readOnly={access.monitor.readOnly} navRequest={navRequest} canExport={access.exports} />}

        {view === 'users' && canOpen(me, 'users') && <UserManagement />}

        {view === 'audit' && canOpen(me, 'audit') && <AuditLog canExport={access.exports} />}

        {view === 'settings' && canOpen(me, 'settings') && <MasterSettings onNavigate={setView} onSaved={() => refreshSessionRef.current()} />}

        {view === 'search' && canOpen(me, 'search') && (
          <div className="search-view-container">
            <div className="section-header">
              <h2>Lab Result Search & Diagnostics Summary</h2>
              <p className="section-subtitle">
                Retrieve a patient's historical laboratory findings, automated trends, and raw analyzer values.
              </p>
            </div>

            <SearchForm
              regNo={regNo}
              fromDate={fromDate}
              toDate={toDate}
              loading={loading}
              showPrint={hasData}
              fetchErrors={result?.chart?.fetchErrors}
              onRegNoChange={setRegNo}
              onFromDateChange={setFromDate}
              onToDateChange={setToDate}
              onSubmit={handleSearch}
            />

            {/* Quick overview / Empty state hero shown when no search has been executed */}
            {!loading && !result && !error && (
              <div className="search-welcome-dashboard">
                {recentSearches.length > 0 && (
                  <div className="recent-searches-bar">
                    <span className="recent-searches-label">Recent Searches:</span>
                    <div className="recent-chips-list">
                      {recentSearches.map((rec) => (
                        <button
                          key={rec}
                          type="button"
                          className="recent-chip"
                          onClick={() => handleRecentClick(rec)}
                          title={`Search for ${rec}`}
                        >
                          <SearchIcon size={13} />
                          <span>{rec}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="search-guidance-grid">
                  <div className="guidance-card">
                    <div className="guidance-icon-box bg-blue-subtle">🆔</div>
                    <h4>Dual Identification</h4>
                    <p>
                      Supports lookups by either <strong>OP UHID</strong> (e.g. <code>6159338</code>) or <strong>Inpatient Number</strong> (e.g. <code>IP07025423</code>).
                    </p>
                  </div>

                  <div className="guidance-card">
                    <div className="guidance-icon-box bg-emerald-subtle">📊</div>
                    <h4>Automated Trend Analysis</h4>
                    <p>
                      Generates consolidated chronological tables tracking Hemoglobin, WBC, Renal profile, Liver function, and more over the patient's stay.
                    </p>
                  </div>

                  <div className="guidance-card">
                    <div className="guidance-icon-box bg-indigo-subtle">🖨️</div>
                    <h4>Clinical Print Readiness</h4>
                    <p>
                      Outputs pre-formatted, letterhead-compliant charts designed for doctor clinical rounds and discharge summary folders.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {loading && (
              <div className="loading modern-loading">
                <div className="spinner"></div>
                <div>Fetching diagnostics summary data from laboratory servers…</div>
              </div>
            )}

            {error && (
              <div className="error modern-error-alert">
                <div className="alert-icon">⚠️</div>
                <div className="alert-body">
                  <strong>Search failed</strong>
                  <div>{error}</div>
                </div>
              </div>
            )}

            {result && !result.data?.length && (
              <div className="empty modern-empty">
                <div className="empty-icon">📂</div>
                <div className="empty-title">No Diagnostics Summary Records Found</div>
                <p className="empty-subtitle">
                  No verified lab test results were returned for UHID/IP <strong>"{result.regNo || regNo}"</strong> within the selected date range ({fromDate} to {toDate}).
                </p>
              </div>
            )}

            {hasData && (
              <div className="results-wrapper">
                <div className="tabs modern-tabs result-tabs no-print">
                  <button
                    type="button"
                    className={`tab-btn ${activeTab === 'chart' ? 'active' : ''}`}
                    onClick={() => setActiveTab('chart')}
                  >
                    <span>📋 Diagnostics Summary</span>
                  </button>
                  <button
                    type="button"
                    className={`tab-btn ${activeTab === 'raw' ? 'active' : ''}`}
                    onClick={() => setActiveTab('raw')}
                  >
                    <span>📄 Raw Results ({result.data.length})</span>
                  </button>
                </div>

                {activeTab === 'chart' && (
                  <InvestigationChart
                    hospital={hospital}
                    regNo={result.regNo}
                    chart={result.chart}
                  />
                )}

                {activeTab === 'raw' && (
                  <RawResults
                    rows={result.data}
                    onViewDetail={setDetailOrderId}
                  />
                )}
              </div>
            )}

            <DetailModal
              orderId={detailOrderId}
              onClose={() => setDetailOrderId(null)}
            />
          </div>
        )}
      </main>

      {access.ai !== 'none' && <AssistantPanel onNavigate={handleAssistantNavigate} view={view} access={access} />}
    </div>
  );
}
