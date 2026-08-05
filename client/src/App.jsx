import { useEffect, useState } from 'react';
import {
  clearToken,
  defaultDatetimeLocal,
  fetchHospitalConfig,
  getToken,
  getUsername,
  searchInvestigation,
} from './api/client';
import Login from './components/Login';
import SearchForm from './components/SearchForm';
import InvestigationChart from './components/InvestigationChart';
import RawResults from './components/RawResults';
import DetailModal from './components/DetailModal';
import PendingTabs from './components/PendingTabs';

export default function App() {
  const [authed, setAuthed] = useState(() => Boolean(getToken()));
  const [username, setUsername] = useState(() => getUsername());
  const [hospital, setHospital] = useState(null);
  const [regNo, setRegNo] = useState('');
  const [fromDate, setFromDate] = useState(defaultDatetimeLocal(0, 0));
  const [toDate, setToDate] = useState(defaultDatetimeLocal(23, 59));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('chart');
  const [detailOrderId, setDetailOrderId] = useState(null);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    fetchHospitalConfig()
      .then(setHospital)
      .catch(() => setHospital({}));
  }, []);

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

  if (!authed) {
    return (
      <Login
        onLoggedIn={(loggedInUsername) => {
          setUsername(loggedInUsername);
          setAuthed(true);
        }}
      />
    );
  }

  function handleLogout() {
    clearToken();
    setAuthed(false);
    setUsername(null);
  }

  return (
    <div className="page">
      <div className="app-topbar no-print">
        <button type="button" className="btn secondary" onClick={handleLogout}>
          Log out
        </button>
      </div>

      {hasData && activeTab === 'chart' && (
        <button
          type="button"
          className="chart-edit-fab no-print"
          title="Edit groups and test names"
          onClick={() => setEditOpen(true)}
        >
          ✎
        </button>
      )}

      <h2>Lab Result Search &amp; Investigation Chart</h2>

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

      {error && <div className="error">Search failed: {error}</div>}

      {result && !result.data?.length && (
        <div className="empty">No records found for the given search.</div>
      )}

      {hasData && (
        <>
          {/* Group pending messages into an orange dropdown and show other warnings normally */}
          {(() => {
            const all = result.chart?.fetchErrors ?? [];
            const pending = all.filter((f) => /details pending/i.test(String(f)));
            // put the "Could not load detail" messages into the Canceled tab
            const canceled = all.filter((f) => /could not load detail/i.test(String(f)) || /cancel|canceled|rejected/i.test(String(f)));
            const groups = {};
            groups['Pending'] = pending;
            groups['Canceled'] = canceled;
            return <PendingTabs groups={groups} onViewDetail={setDetailOrderId} />;
          })()}

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
              onClick={() => {
                setActiveTab('raw');
                setEditOpen(false);
              }}
            >
              📄 Raw Results
            </button>
          </div>

          {activeTab === 'chart' && (
            <InvestigationChart
              hospital={hospital}
              regNo={result.regNo}
              chart={result.chart}
              editOpen={editOpen}
              onEditOpenChange={setEditOpen}
              generatedBy={username}
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
