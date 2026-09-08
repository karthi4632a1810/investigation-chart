const API_BASE = '/api';

export async function fetchHospitalConfig() {
  const res = await fetch(`${API_BASE}/config/hospital`);
  if (!res.ok) throw new Error('Failed to load hospital config');
  return res.json();
}

export async function login({ username, password }) {
  const res = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  return data;
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

export async function fetchReportStatus() {
  const res = await fetch(`${API_BASE}/reports/status`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load automation status');
  return data;
}

export async function fetchReportDates() {
  const res = await fetch(`${API_BASE}/reports/dates`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load report dates');
  return data.dates;
}

export async function fetchReportsForDate(date) {
  const res = await fetch(`${API_BASE}/reports/${encodeURIComponent(date)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load reports');
  return data.patients;
}

export async function triggerReportRun() {
  const res = await fetch(`${API_BASE}/reports/run-now`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to run discharge check');
  return data.summary;
}

export function reportPdfUrl(date, ipNo) {
  return `${API_BASE}/reports/${encodeURIComponent(date)}/${encodeURIComponent(ipNo)}/pdf`;
}

export function defaultDateOnly() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
