import { useEffect, useState } from 'react';
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
import { accessFor, canOpen, firstOpenView } from './utils/access';
import {
  FilePdfIcon,
  ChartIcon,
  FlaskIcon,
  HospitalIcon,
  LockIcon,
  SearchIcon,
  UsersIcon,
  WhatsAppIcon,
} from './components/Icons';

// Screens with their own address: /admin (WhatsApp Monitor) and /users.
const VIEW_PATHS = { admin: '/admin', users: '/users' };
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
  // /admin opens the WhatsApp monitor, /users user management; / the rest.
  const [view, setView] = useState(() => pathView() || 'reports'); // 'search' | 'reports' | 'labFinder' | 'wati' | 'admin' | 'users'
  // Set by the AI assistant to open a screen at a given date / filter / query;
  // the screen applies it when `id` changes.
  const [navRequest, setNavRequest] = useState(null);
  const access = accessFor(me);

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

  function handleAssistantNavigate({ view: nextView, date, filter, query }) {
    if (!nextView) return;
    setView(nextView);
    setNavRequest({ id: Date.now(), view: nextView, date, filter, query });
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
        .then(({ user, reason }) => {
          if (!user) return expire(reason);
          sessionStorage.setItem('investigation-auth', JSON.stringify(user));
          setMe(user);
        })
        .catch(() => {});
    refresh();
    const onExpired = (e) => expire(e.detail?.reason);
    const onFocus = () => !document.hidden && refresh();
    const timer = setInterval(refresh, 3 * 60_000);
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

  function handleLogout() {
    logout();
    sessionStorage.removeItem('investigation-auth');
    setMe(null);
    setUsername('');
    setPassword('');
    setLoginError('');
  }

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
              ['users', 'Users', UsersIcon],
            ]
              .filter(([id]) => canOpen(me, id))
              .map(([id, label, Icon]) => (
                <button key={id} type="button" className={`nav-segment-btn ${view === id ? 'active' : ''}`} onClick={() => setView(id)}>
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              ))}
          </nav>

          <ProfileMenu me={me} onLogout={handleLogout} />
        </div>
      </header>

      <main className="page">
        {!firstOpenView(me) && (
          <div className="no-access">
            <LockIcon size={28} />
            <b>Your account has no screens yet</b>
            <span>Ask the super admin to give you access.</span>
          </div>
        )}

        {view === 'reports' && canOpen(me, 'reports') && <DischargeReports navRequest={navRequest} access={access} />}

        {view === 'labFinder' && canOpen(me, 'labFinder') && <LabFinder navRequest={navRequest} canShare={access.labFinder.canShare} />}

        {view === 'wati' && canOpen(me, 'wati') && <WatiSettings readOnly={access.wati.readOnly} />}

        {view === 'admin' && canOpen(me, 'admin') && <AdminDashboard readOnly={access.monitor.readOnly} />}

        {view === 'users' && canOpen(me, 'users') && <UserManagement />}

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
