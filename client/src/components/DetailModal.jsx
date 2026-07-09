import { useEffect, useState } from 'react';
import { fetchLabDetail } from '../api/client';

export default function DetailModal({ orderId, onClose }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!orderId) return;

    setLoading(true);
    setError('');
    setRows([]);

    fetchLabDetail(orderId)
      .then((data) => setRows(data.rows || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [orderId]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!orderId) return null;

  return (
    <div
      className="modal-overlay show"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-box">
        <button type="button" className="modal-close" onClick={onClose}>
          &times;
        </button>
        <h3>Lab Result Detail</h3>
        <div className="modal-sub">Request No: {orderId}</div>

        {loading && (
          <div className="loading">
            <div className="spinner" />
            Loading...
          </div>
        )}

        {error && <div className="error">{error}</div>}

        {!loading && !error && rows.length === 0 && (
          <div className="empty">No test rows found for this request.</div>
        )}

        {!loading && !error && rows.length > 0 && (
          <table className="detail">
            <thead>
              <tr>
                <th>Test Name</th>
                <th>Result Value</th>
                <th>Biological Reference Range</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) =>
                row.section ? (
                  <tr key={i} className="section-row-modal">
                    <td colSpan={3}>{row.section}</td>
                  </tr>
                ) : (
                  <tr key={i}>
                    <td>{row.test}</td>
                    <td>{row.value}</td>
                    <td>{row.range}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
