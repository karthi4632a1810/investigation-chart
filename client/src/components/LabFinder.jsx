import { useEffect, useRef, useState } from 'react';
import { fetchLabCoverage, fetchLabTests, searchLabResults } from '../api/client';
import ExportShareBar from './ExportShareBar';
import { FlaskIcon, SearchIcon } from './Icons';

const EMPTY = { test: '', value: '', status: '', min: '', max: '', from: '', to: '', dateBasis: 'discharge', patient: '', department: '' };
const PAGE = 100;

const EXAMPLES = [
  { label: 'Urine glucose · Negative', q: { test: 'urine glucose', value: 'negative' } },
  { label: 'Haemoglobin · Low', q: { test: 'haemoglobin', status: 'low' } },
  { label: 'Creatinine · High', q: { test: 'creatinine', status: 'high' } },
  { label: 'Platelet count < 100', q: { test: 'platelet', max: 100 } },
];

const FLAG_LABEL = { high: 'High', low: 'Low', normal: 'Normal' };

function isoToDmy(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso || '';
}

function toForm(q) {
  const f = { ...EMPTY };
  for (const k of Object.keys(EMPTY)) if (q?.[k] !== undefined && q[k] !== null) f[k] = String(q[k]);
  if (q?.ipNo) f.patient = q.ipNo;
  return f;
}

function toQuery(f) {
  const q = {};
  for (const [k, v] of Object.entries(f)) if (String(v).trim() !== '') q[k] = typeof v === 'string' ? v.trim() : v;
  // The patient box takes a name or an IP number.
  if (q.patient && /^ip\s*\d+$/i.test(q.patient)) {
    q.ipNo = q.patient.replace(/\s+/g, '');
    delete q.patient;
  }
  return q;
}

export default function LabFinder({ navRequest }) {
  const [form, setForm] = useState(EMPTY);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [suggestions, setSuggestions] = useState([]);
  const [coverage, setCoverage] = useState(null);
  const suggestTimer = useRef(null);

  useEffect(() => {
    fetchLabCoverage().then(setCoverage).catch(() => {});
  }, []);

  async function run(nextForm) {
    const f = nextForm || form;
    setForm(f);
    setLoading(true);
    setError('');
    setShown(PAGE);
    try {
      setResult(await searchLabResults(toQuery(f)));
    } catch (err) {
      setError(err.message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  // Opened from the AI assistant ("Open in Lab Finder") with a ready query.
  useEffect(() => {
    if (navRequest?.view === 'labFinder' && navRequest.query) run(toForm(navRequest.query));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navRequest?.id]);

  function set(key) {
    return (e) => {
      const value = e.target.value;
      setForm((f) => ({ ...f, [key]: value }));
      if (key === 'test') {
        clearTimeout(suggestTimer.current);
        suggestTimer.current = setTimeout(() => {
          if (value.trim().length < 2) return setSuggestions([]);
          fetchLabTests(value)
            .then((tests) => setSuggestions(tests.slice(0, 12)))
            .catch(() => {});
        }, 250);
      }
    };
  }

  const rows = result?.rows || [];

  return (
    <div className="search-view-container lf-page">
      <header className="lf-head">
        <div className="lf-head-icon">
          <FlaskIcon size={22} />
        </div>
        <div>
          <h2>Lab Finder</h2>
          <p>
            Find patients by lab result across all discharges — then download the list or share it on WhatsApp.
            {coverage?.from && (
              <span className="lf-coverage">
                {' '}
                Results stored for discharges {isoToDmy(coverage.from)} to {isoToDmy(coverage.to)}.
              </span>
            )}
          </p>
        </div>
      </header>

      <form
        className="lf-form"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <div className="lf-grid">
          <label className="lf-field lf-span-2">
            <span>Test</span>
            <input list="lf-tests" value={form.test} onChange={set('test')} placeholder="e.g. urine glucose, haemoglobin" autoFocus />
            <datalist id="lf-tests">
              {suggestions.map((t) => (
                <option key={`${t.section}|${t.test}`} value={t.section ? `${t.section} ${t.test}` : t.test}>
                  {t.count} results
                </option>
              ))}
            </datalist>
          </label>
          <label className="lf-field">
            <span>Result contains</span>
            <input value={form.value} onChange={set('value')} placeholder="e.g. Negative" />
          </label>
          <label className="lf-field">
            <span>Flag</span>
            <select value={form.status} onChange={set('status')}>
              <option value="">Any</option>
              <option value="high">High</option>
              <option value="low">Low</option>
              <option value="abnormal">High or low</option>
              <option value="normal">Within range</option>
            </select>
          </label>
          <label className="lf-field">
            <span>Value from</span>
            <input type="number" step="any" value={form.min} onChange={set('min')} placeholder="min" />
          </label>
          <label className="lf-field">
            <span>Value to</span>
            <input type="number" step="any" value={form.max} onChange={set('max')} placeholder="max" />
          </label>
          <label className="lf-field">
            <span>From</span>
            <input type="date" value={form.from} onChange={set('from')} />
          </label>
          <label className="lf-field">
            <span>To</span>
            <input type="date" value={form.to} onChange={set('to')} />
          </label>
          <label className="lf-field">
            <span>Dates are</span>
            <select value={form.dateBasis} onChange={set('dateBasis')}>
              <option value="discharge">Discharge dates</option>
              <option value="result">Test result dates</option>
            </select>
          </label>
          <label className="lf-field">
            <span>Patient or IP No</span>
            <input value={form.patient} onChange={set('patient')} placeholder="optional" />
          </label>
          <label className="lf-field">
            <span>Department</span>
            <input value={form.department} onChange={set('department')} placeholder="optional" />
          </label>
        </div>

        <div className="lf-actions">
          <div className="lf-examples">
            <span>Try:</span>
            {EXAMPLES.map((ex) => (
              <button key={ex.label} type="button" className="lf-example" onClick={() => run({ ...EMPTY, ...toForm(ex.q) })}>
                {ex.label}
              </button>
            ))}
          </div>
          <div className="lf-buttons">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setForm(EMPTY);
                setResult(null);
                setError('');
              }}
            >
              Clear
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              <SearchIcon size={16} /> {loading ? 'Searching…' : 'Search'}
            </button>
          </div>
        </div>
      </form>

      {error && (
        <div className="lock-error lf-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      {result && (
        <section className="lf-results">
          <div className="lf-results-head">
            <div>
              <div className="lf-count">
                <b>{result.total}</b> result{result.total === 1 ? '' : 's'} · <b>{result.patients}</b> patient{result.patients === 1 ? '' : 's'}
                {result.truncated && <span className="lf-trunc"> (first 5,000 — narrow the search)</span>}
              </div>
              {result.matchedTests.length > 1 && (
                <div className="lf-tests">
                  <span>Tests matched:</span>
                  {result.matchedTests.slice(0, 8).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="lf-test-chip"
                      title="Search only this test"
                      onClick={() => run({ ...form, test: t.replace(' › ', ' ') })}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {result.total > 0 && <ExportShareBar query={result.query} />}

          {result.total > 0 ? (
            <div className="table-wrap lf-table-wrap">
              <table className="lf-table">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>IP No</th>
                    <th>UHID</th>
                    <th>Department</th>
                    <th>Test</th>
                    <th>Result</th>
                    <th>Ref. range</th>
                    <th>Flag</th>
                    <th>Result date</th>
                    <th>Discharged</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, shown).map((r, i) => (
                    <tr key={`${r.dischargeDate}-${r.ipNo}-${r.test}-${r.resultDate}-${i}`}>
                      <td className="lf-name">{r.name}</td>
                      <td className="lf-id">{r.ipNo}</td>
                      <td className="lf-id is-plain">{r.regNo}</td>
                      <td>{r.department}</td>
                      <td>
                        {r.test}
                        {r.section && <span className="lf-section">{r.section}</span>}
                      </td>
                      <td className={`lf-value ${r.status === 'high' || r.status === 'low' ? `is-${r.status}` : ''}`}>{r.value}</td>
                      <td className="lf-range">{r.range}</td>
                      <td>{r.status && <span className={`lf-flag is-${r.status}`}>{FLAG_LABEL[r.status]}</span>}</td>
                      <td className="lf-date">{r.resultDate}</td>
                      <td className="lf-date">{isoToDmy(r.dischargeDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > shown && (
                <button type="button" className="btn btn-secondary lf-more" onClick={() => setShown((n) => n + PAGE)}>
                  Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}
                </button>
              )}
            </div>
          ) : (
            <div className="lf-empty">
              No matching results.{' '}
              {coverage?.from
                ? `Lab values are stored for discharges from ${isoToDmy(coverage.from)} to ${isoToDmy(coverage.to)}.`
                : 'No lab values have been stored yet.'}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
