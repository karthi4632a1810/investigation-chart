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
    body: JSON.stringify({ regNo, fromDate, toDate }),
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

export function defaultDatetimeLocal(hours, minutes) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(hours)}:${pad(minutes)}`;
}
