function normCol(c) {
  return String(c).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractOrderIdFromCell(rawValue) {
  const raw = String(rawValue || '');
  const match = raw.match(/Orderid=(\d+)/i);
  const orderId = match ? match[1] : null;
  const stripped = raw.replace(/<[^>]*>/g, '').trim();
  const display = stripped || orderId || '';
  return { orderid: orderId, display };
}

function StatusPill({ value }) {
  const txt = String(value || '').trim();
  let cls = 'status-other';
  if (txt.toLowerCase().includes('approved')) cls = 'status-approved';
  else if (txt.toLowerCase().includes('pending')) cls = 'status-pending';
  return <span className={`status-pill ${cls}`}>{txt}</span>;
}

export default function RawResults({ rows, onViewDetail }) {
  if (!rows?.length) return null;

  const cols = Object.keys(rows[0]);
  let reqCol = null;
  let statusCol = null;

  for (const c of cols) {
    const n = normCol(c);
    if (!reqCol && (n === 'reqno' || n === 'requestno')) reqCol = c;
    if (!statusCol && n === 'status') statusCol = c;
  }

  return (
    <>
      <div className="result-count">{rows.length} result row(s) found.</div>
      <div className="table-wrap">
        <table className="results">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {cols.map((c) => {
                  const val = row[c];

                  if (c === reqCol) {
                    const parsed = extractOrderIdFromCell(val);
                    if (parsed.orderid) {
                      return (
                        <td key={c}>
                          <span
                            className="req-badge"
                            onClick={() => onViewDetail(parsed.orderid)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') onViewDetail(parsed.orderid);
                            }}
                            role="button"
                            tabIndex={0}
                          >
                            <i>&#128269;</i> {parsed.display}
                          </span>
                        </td>
                      );
                    }
                    return <td key={c}>{parsed.display}</td>;
                  }

                  if (c === statusCol) {
                    return (
                      <td key={c}>
                        <StatusPill value={val} />
                      </td>
                    );
                  }

                  return <td key={c}>{String(val ?? '')}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
