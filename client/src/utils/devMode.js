import { useEffect, useState } from 'react';

const ON = new Set(['1', 'true', 'yes', 'on']);

/**
 * Staff-only extras (Ask AI, Lab Search) show when the address has
 * ?dev=1 / ?dev=true / ?admin=1 / ?admin=true, and hide otherwise
 * (including ?dev=0 / ?dev=false). This only changes what the page shows —
 * the API stays behind the normal login either way.
 */
export function readDevMode(search = window.location.search) {
  const params = new URLSearchParams(search);
  return ['dev', 'admin'].some((key) => ON.has(String(params.get(key) ?? '').toLowerCase()));
}

export function useDevMode() {
  const [devMode, setDevMode] = useState(() => (typeof window === 'undefined' ? false : readDevMode()));
  useEffect(() => {
    const update = () => setDevMode(readDevMode());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return devMode;
}
