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

export default function App() {
  const [hospital, setHospital] = useState(null);
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
    <div className="page">
      <div className="page-header">
        <h2>Lab Result Search &amp; Investigation Chart</h2>
        <button type="button" className="btn secondary" onClick={handleLogout}>
          Logout
        </button>
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
    </div>
  );
}
