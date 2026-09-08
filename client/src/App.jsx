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

export default function App() {
  const [hospital, setHospital] = useState(null);
  const [view, setView] = useState('search'); // 'search' | 'reports'
  const [regNo, setRegNo] = useState('');
  const [fromDate, setFromDate] = useState(defaultDateOnly());
  const [toDate, setToDate] = useState(defaultDateOnly());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('chart');
  const [detailOrderId, setDetailOrderId] = useState(null);
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

  async function handleSearch(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    setActiveTab('chart');

    try {
      const data = await searchInvestigation({ regNo, fromDate, toDate });
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
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
      <header className="app-header">
        <div className="app-brand">
          <div className="app-brand-icon">🏥</div>
          <div className="app-brand-text">
            <div className="app-brand-title">{hospital?.nameEn || 'Lab Result Search & Investigation Chart'}</div>
            <div className="app-brand-subtitle">Investigation Chart Portal</div>
          </div>
        </div>
        <div className="page-header-actions">
          <div className="tabs no-print">
            <button
              type="button"
              className={`tab-btn ${view === 'search' ? 'active' : ''}`}
              onClick={() => setView('search')}
            >
              🔍 Search
            </button>
            <button
              type="button"
              className={`tab-btn ${view === 'reports' ? 'active' : ''}`}
              onClick={() => setView('reports')}
            >
              🗂️ Discharge Reports
            </button>
          </div>
          <button type="button" className="btn ghost-danger" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>

      <main className="page">
      {view === 'reports' && <DischargeReports />}

      {view === 'search' && (
        <>
      <div className="section-header">
        <h2>Lab Result Search</h2>
        <p className="section-subtitle">Search a patient's investigation chart and raw lab results.</p>
      </div>
      <SearchForm
        regNo={regNo}
        fromDate={fromDate}
        toDate={toDate}
        loading={loading}
        showPrint={hasData}
        onRegNoChange={setRegNo}
        onFromDateChange={setFromDate}
        onToDateChange={setToDate}
        onSubmit={handleSearch}
      />

      {loading && (
        <div className="loading">
          <div className="spinner"></div>
          <div>Please wait for a moment...</div>
        </div>
      )}

      {error && <div className="error">Search failed: {error}</div>}

      {result && !result.data?.length && (
        <div className="empty">No records found for the given search.</div>
      )}

      {hasData && (
        <>
          {result.chart?.fetchErrors?.map((fe) => (
            <div key={fe} className="warn no-print">
              {fe}
            </div>
          ))}

          <div className="tabs">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'chart' ? 'active' : ''}`}
              onClick={() => setActiveTab('chart')}
            >
              📋 Investigation Chart
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'raw' ? 'active' : ''}`}
              onClick={() => setActiveTab('raw')}
            >
              📄 Raw Results
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
        </>
      )}

      <DetailModal
        orderId={detailOrderId}
        onClose={() => setDetailOrderId(null)}
      />
        </>
      )}
      </main>
    </div>
  );
}
