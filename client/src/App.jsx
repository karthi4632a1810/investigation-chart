import { useEffect, useState } from 'react';
import {
  defaultDatetimeLocal,
  fetchHospitalConfig,
  searchInvestigation,
} from './api/client';
import SearchForm from './components/SearchForm';
import InvestigationChart from './components/InvestigationChart';
import RawResults from './components/RawResults';
import DetailModal from './components/DetailModal';

export default function App() {
  const [hospital, setHospital] = useState(null);
  const [regNo, setRegNo] = useState('');
  const [fromDate, setFromDate] = useState(defaultDatetimeLocal(0, 0));
  const [toDate, setToDate] = useState(defaultDatetimeLocal(23, 59));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('chart');
  const [detailOrderId, setDetailOrderId] = useState(null);

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

  return (
    <div className="page">
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
            <div key={fe} className="warn">
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
