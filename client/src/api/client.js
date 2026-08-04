const API_BASE = '/api';
const TOKEN_KEY = 'auth_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function handleAuthFailure(res) {
  if (res.status === 401) {
    clearToken();
  }
}

export async function login(username, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  setToken(data.token);
  return data;
}

export async function fetchHospitalConfig() {
  const res = await fetch(`${API_BASE}/config/hospital`);
  if (!res.ok) throw new Error('Failed to load hospital config');
  return res.json();
}

export async function searchInvestigation({ regNo, fromDate, toDate }) {
  const res = await fetch(`${API_BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ regNo, fromDate, toDate }),
  });
  const data = await res.json();
  if (!res.ok) {
    handleAuthFailure(res);
    throw new Error(data.error || 'Search failed');
  }
  return data;
}

export async function fetchLabDetail(orderid) {
  const res = await fetch(`${API_BASE}/detail/${encodeURIComponent(orderid)}`, {
    headers: authHeaders(),
  });
  const data = await res.json();
  if (!res.ok) {
    handleAuthFailure(res);
    throw new Error(data.error || 'Failed to load detail');
  }
  return data;
}

export function defaultDatetimeLocal(hours, minutes) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(hours)}:${pad(minutes)}`;
}
