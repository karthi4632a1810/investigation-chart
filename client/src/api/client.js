const API_BASE = '/api';

// Fired when the server rejects the session (expired, or signed out elsewhere)
// so App can drop back to the login screen instead of showing API errors.
export const AUTH_EXPIRED_EVENT = 'investigation-auth-expired';

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  return res;
}

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

/** Whether the browser still holds a valid server session. */
export async function checkSession() {
  const res = await fetch(`${API_BASE}/session`);
  return res.ok;
}

export async function logout() {
  await fetch(`${API_BASE}/logout`, { method: 'POST' }).catch(() => {});
}

export async function searchInvestigation({ regNo, fromDate, toDate }) {
  const res = await apiFetch(`${API_BASE}/search`, {
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
  const res = await apiFetch(`${API_BASE}/detail/${encodeURIComponent(orderid)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load detail');
  return data;
}

export async function fetchReportStatus() {
  const res = await apiFetch(`${API_BASE}/reports/status`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load automation status');
  return data;
}

export async function fetchReportDates() {
  const res = await apiFetch(`${API_BASE}/reports/dates`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load report dates');
  return data.dates;
}

export async function fetchReportsForDate(date) {
  const res = await apiFetch(`${API_BASE}/reports/${encodeURIComponent(date)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load reports');
  return data.patients;
}

export async function searchReports(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      params.set(key, value);
    }
  }
  const res = await apiFetch(`${API_BASE}/reports/search?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Search failed');
  return data.patients;
}

export async function triggerReportRun() {
  const res = await apiFetch(`${API_BASE}/reports/run-now`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to run discharge check');
  return data.summary;
}

export function reportPdfUrl(date, ipNo) {
  return `${API_BASE}/reports/${encodeURIComponent(date)}/${encodeURIComponent(ipNo)}/pdf`;
}

export function reportSummaryPdfUrl(date, ipNo) {
  return `${API_BASE}/reports/${encodeURIComponent(date)}/${encodeURIComponent(ipNo)}/summary-pdf`;
}

export async function sendReportWhatsApp(date, ipNo) {
  const res = await apiFetch(`${API_BASE}/reports/${encodeURIComponent(date)}/${encodeURIComponent(ipNo)}/send-whatsapp`, {
    method: 'POST',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to send WhatsApp message');
  return data;
}

export async function fetchWatiSettings() {
  const res = await apiFetch(`${API_BASE}/wati/settings`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load WATI settings');
  return data.settings;
}

export async function updateWatiSettings(payload) {
  const res = await apiFetch(`${API_BASE}/wati/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update WATI settings');
  return data.settings;
}

async function postJson(url, body) {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- Lab Finder -----------------------------------------------------------

export async function fetchLabTests(q) {
  const res = await apiFetch(`${API_BASE}/lab-results/tests?q=${encodeURIComponent(q || '')}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load test names');
  return data.tests;
}

export async function fetchLabCoverage() {
  const res = await apiFetch(`${API_BASE}/lab-results/coverage`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load coverage');
  return data;
}

export function searchLabResults(query) {
  return postJson(`${API_BASE}/lab-results/search`, { query });
}

export const EXPORT_LABELS = { pdf: 'PDF', xlsx: 'Excel', docx: 'Word', csv: 'CSV' };

/** Downloads a Lab Finder export (pdf | xlsx | docx | csv) as a file. */
export async function downloadLabResults(query, format) {
  const res = await apiFetch(`${API_BASE}/lab-results/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, format }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Download failed');
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || `lab-results.${format}`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

export function shareLabResults(query, toNumber, recipientName, via) {
  return postJson(`${API_BASE}/lab-results/share`, { query, toNumber, recipientName, via });
}

/** One patient's lab report + discharge summary to a number the user typed. */
export function sharePatientReports(date, ipNo, toNumber, via) {
  return postJson(`${API_BASE}/reports/${encodeURIComponent(date)}/${encodeURIComponent(ipNo)}/share`, { toNumber, via });
}

// ---- /admin WhatsApp monitor ---------------------------------------------

async function getJson(url) {
  const res = await apiFetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function adminParams(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    const value = Array.isArray(v) ? v.join(',') : v;
    if (value !== undefined && value !== null && String(value) !== '') q.set(k, value);
  }
  return q.toString();
}

export function fetchWhatsappSummary(params) {
  return getJson(`${API_BASE}/admin/whatsapp/summary?${adminParams(params)}`);
}

export function fetchWhatsappMessages(params) {
  return getJson(`${API_BASE}/admin/whatsapp/messages?${adminParams(params)}`);
}

export function fetchWhatsappMessage(id) {
  return getJson(`${API_BASE}/admin/whatsapp/messages/${encodeURIComponent(id)}`).then((d) => d.message);
}

export function fetchWhatsappActivity(limit = 20) {
  return getJson(`${API_BASE}/admin/whatsapp/activity?limit=${limit}`).then((d) => d.events);
}

/** Numbers whose latest WhatsApp message failed as "not on WhatsApp", as a Set of 91XXXXXXXXXX digits. */
export async function fetchNotOnWhatsappNumbers() {
  const data = await getJson(`${API_BASE}/whatsapp/not-on-whatsapp`);
  return new Set((data.numbers || []).map((n) => n.number));
}

export function fetchWhatsappInsights(params) {
  return getJson(`${API_BASE}/admin/whatsapp/insights?${adminParams(params)}`);
}

export function fetchWhatsappPatients(params) {
  return getJson(`${API_BASE}/admin/whatsapp/patients?${adminParams(params)}`);
}

export function retryWhatsappMessage(id) {
  return postJson(`${API_BASE}/admin/whatsapp/messages/${encodeURIComponent(id)}/retry`, {});
}

/** Downloads the monitor's current view: view 'messages' | 'patients', format xlsx | pdf | csv | json. */
export async function downloadWhatsappExport(params, view, format) {
  const res = await apiFetch(`${API_BASE}/admin/whatsapp/export?${adminParams({ ...params, view, format })}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Export failed');
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || `whatsapp-report.${format}`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

export function refreshWhatsappStatuses() {
  return postJson(`${API_BASE}/admin/whatsapp/refresh`, {});
}

/** WATI API calls used, status-check / webhook state, and how PDF links are served. */
export function fetchWatiUsage() {
  return getJson(`${API_BASE}/admin/whatsapp/wati-usage`);
}

// ---- Ask AI ---------------------------------------------------------------

export function askAssistant(messages, context) {
  return postJson(`${API_BASE}/assistant`, { messages, context });
}

export function defaultDateOnly() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
