import { useEffect, useState } from 'react';
import {
  defaultDateOnly,
  fetchHospitalConfig,
  login,
  searchInvestigation,
} from './api/client';
import SearchForm from './components/SearchForm';
import InvestigationChart from './components/InvestigationChart';
import RawResults from './components/RawResults';
import DetailModal from './components/DetailModal';
import LoginScreen from './components/LoginScreen';
import DischargeReports from './components/DischargeReports';
import {
  FilePdfIcon,
  HospitalIcon,
  LogoutIcon,
  SearchIcon,
  SparklesIcon,
} from './components/Icons';

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
  const [view, setView] = useState('reports'); // 'search' | 'reports'
  const [regNo, setRegNo] = useState('');
  const [fromDate, setFromDate] = useState(defaultDateOnly());
  const [toDate, setToDate] = useState(defaultDateOnly());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('chart');
  const [detailOrderId, setDetailOrderId] = useState(null);
  const [recentSearches, setRecentSearches] = useState(getRecentSearches);
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return Boolean(sessionStorage.getItem('investigation-auth'));
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  useEffect(() => {
    fetchHospitalConfig()
      .then(setHospital)
      .catch(() => setHospital({}));
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError('');

    try {
      const data = await login({ username, password });
      if (data.ok) {
        sessionStorage.setItem('investigation-auth', JSON.stringify({ username }));
        setIsAuthenticated(true);
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
    sessionStorage.removeItem('investigation-auth');
    setIsAuthenticated(false);
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
              <span>Investigation Chart Portal</span>
              <span className="brand-badge-pill">EMR Portal</span>
            </div>
          </div>
        </div>

        <div className="page-header-actions">
          <nav className="nav-segmented-control no-print" aria-label="Main Navigation">
            <button
              type="button"
              className={`nav-segment-btn ${view === 'search' ? 'active' : ''}`}
              onClick={() => setView('search')}
            >
              <SearchIcon size={16} />
              <span>Lab Search</span>
            </button>
            <button
              type="button"
              className={`nav-segment-btn ${view === 'reports' ? 'active' : ''}`}
              onClick={() => setView('reports')}
            >
              <FilePdfIcon size={16} />
              <span>Discharge Reports</span>
            </button>
          </nav>

          <button
            type="button"
            className="btn btn-ghost-logout no-print"
            onClick={handleLogout}
            title="Sign out of hospital portal"
          >
            <LogoutIcon size={16} />
            <span className="hide-on-mobile">Logout</span>
          </button>
        </div>
      </header>

      <main className="page">
        {view === 'reports' && <DischargeReports />}

        {view === 'search' && (
          <div className="search-view-container">
            <div className="section-header">
              <h2>Lab Result Search & Investigation Chart</h2>
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
                <div>Fetching investigation data from laboratory servers…</div>
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
                <div className="empty-title">No Investigation Records Found</div>
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
                    <span>📋 Investigation Chart</span>
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
    </div>
  );
}
