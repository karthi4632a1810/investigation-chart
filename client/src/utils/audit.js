/**
 * Audit log, browser side (server: auditService.js). The server records every
 * API action itself; this adds what only the page sees — screens opened,
 * a WhatsApp popup opened or cancelled, IDs copied, filters changed, the tab
 * hidden, idle time — and this tab's active / idle / hidden time.
 *
 * Events are queued and sent every few seconds, and with sendBeacon when the
 * tab is hidden or closed so nothing is lost.
 */

const ENDPOINT = '/api/audit/events';
const IDLE_AFTER_MS = 5 * 60_000;
const FLUSH_MS = 5_000;
const HEARTBEAT_MS = 60_000;

const tabId = Math.random().toString(36).slice(2, 12);
let queue = [];
let started = false;
// After sign-out nothing is queued until the next sign-in starts tracking again.
let blocked = false;
let getScreen = () => null;
let timers = [];
let listeners = [];

// Time accounting: the current state, since when, and the totals.
const clock = { state: 'active', since: Date.now(), lastInput: Date.now(), activeMs: 0, idleMs: 0, hiddenMs: 0 };

function settle(now = Date.now()) {
  clock[`${clock.state}Ms`] += now - clock.since;
  clock.since = now;
}

function setState(next) {
  if (next === clock.state) return 0;
  const now = Date.now();
  const lasted = now - clock.since;
  settle(now);
  clock.state = next;
  return lasted;
}

function snapshot() {
  settle();
  return { tabId, activeMs: clock.activeMs, idleMs: clock.idleMs, hiddenMs: clock.hiddenMs, screen: getScreen() };
}

/**
 * Records something the user did. `data`: { screen, target, details, durationMs }.
 * Before startAudit (screens mount before App starts it) events wait in the queue.
 */
export function track(action, data = {}) {
  if (blocked || queue.length >= 200) return;
  queue.push({ action, at: new Date().toISOString(), tabId, screen: data.screen ?? getScreen(), ...data });
  if (started && queue.length >= 40) flush();
}

function flush({ beacon = false, heartbeat = false } = {}) {
  if (!started || (!queue.length && !heartbeat)) return;
  const body = JSON.stringify({ events: queue.splice(0, 50), heartbeat: snapshot() });
  try {
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  } catch {
    // never let audit logging break the page
  }
}

function on(target, event, fn, opts) {
  target.addEventListener(event, fn, opts);
  listeners.push(() => target.removeEventListener(event, fn, opts));
}

/** Start after sign-in. `screen()` returns the current screen id. */
export function startAudit(screen) {
  if (started) return;
  started = true;
  blocked = false;
  getScreen = screen || getScreen;
  Object.assign(clock, { state: document.hidden ? 'hidden' : 'active', since: Date.now(), lastInput: Date.now(), activeMs: 0, idleMs: 0, hiddenMs: 0 });

  const onInput = () => {
    clock.lastInput = Date.now();
    if (clock.state === 'idle') {
      const lasted = setState('active');
      track('idle_end', { durationMs: lasted });
    }
  };
  for (const ev of ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel']) on(window, ev, onInput, { passive: true, capture: true });

  on(document, 'visibilitychange', () => {
    if (document.hidden) {
      setState('hidden');
      track('tab_hidden');
      flush({ beacon: true, heartbeat: true });
    } else {
      const lasted = setState('active');
      clock.lastInput = Date.now();
      track('tab_visible', { durationMs: lasted });
    }
  });
  on(window, 'pagehide', () => {
    track('tab_closed', { details: { activeMs: clock.activeMs, idleMs: clock.idleMs, hiddenMs: clock.hiddenMs } });
    flush({ beacon: true, heartbeat: true });
  });

  timers.push(
    setInterval(() => {
      if (clock.state === 'active' && Date.now() - clock.lastInput > IDLE_AFTER_MS) {
        setState('idle');
        track('idle_start');
      }
      flush();
    }, FLUSH_MS),
    setInterval(() => flush({ heartbeat: true }), HEARTBEAT_MS),
  );
}

/** Stop on sign-out: send what's queued first. */
export function stopAudit() {
  if (!started) return;
  flush({ heartbeat: true });
  started = false;
  blocked = true;
  timers.forEach(clearInterval);
  timers = [];
  listeners.forEach((off) => off());
  listeners = [];
  queue = [];
}
