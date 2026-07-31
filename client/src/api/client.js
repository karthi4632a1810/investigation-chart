const API_BASE = '/api';

export async function fetchHospitalConfig() {
  const res = await fetch(`${API_BASE}/config/hospital`);
  if (!res.ok) throw new Error('Failed to load hospital config');
  return res.json();
}

export async function searchInvestigation({ regNo, fromDate, toDate }) {
  const res = await fetch(`${API_BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // fromDate/toDate come in as plain "YYYY-MM-DD" from a date-only input —
    // expand to the full day so the search range still covers 00:00–23:59.
    body: JSON.stringify({
      regNo,
      fromDate: `${fromDate}T00:00`,
      toDate: `${toDate}T23:59`,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Search failed');
  return data;
}

export async function fetchLabDetail(orderid) {
  const res = await fetch(`${API_BASE}/detail/${encodeURIComponent(orderid)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load detail');
  return data;
}

export function defaultDateOnly() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
