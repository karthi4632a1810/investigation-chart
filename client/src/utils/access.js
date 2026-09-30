/**
 * The signed-in user's permissions (server: userService.js), as simple flags
 * for the screens. The server enforces all of it; this only hides what a user
 * can't use.
 */

// App view id → permission screen id.
export const VIEW_SCREEN = { search: 'search', reports: 'reports', labFinder: 'labFinder', wati: 'wati', admin: 'monitor' };
export const VIEW_ORDER = ['reports', 'search', 'labFinder', 'wati', 'admin'];

export function canOpen(me, view) {
  if (!me) return false;
  if (view === 'users') return Boolean(me.isSuperAdmin);
  if (me.isSuperAdmin) return true;
  const screen = VIEW_SCREEN[view];
  return Boolean(screen) && me.permissions?.screens?.[screen] !== 'none';
}

export function firstOpenView(me) {
  return VIEW_ORDER.find((v) => canOpen(me, v)) || (me?.isSuperAdmin ? 'users' : null);
}

/** Flags each screen needs. */
export function accessFor(me) {
  const p = me?.permissions || {};
  const s = p.screens || {};
  const documents = p.documents || 'both';
  return {
    documents,
    showLab: documents !== 'summary',
    showSummary: documents !== 'lab',
    reports: {
      canRun: s.reports === 'write',
      showWhatsApp: s.reports === 'write' && Boolean(p.whatsappButton),
    },
    labFinder: { canShare: s.labFinder === 'write' || p.ai === 'act' },
    wati: { readOnly: s.wati !== 'write' },
    monitor: { readOnly: s.monitor !== 'write' },
    ai: p.ai || 'none',
  };
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
