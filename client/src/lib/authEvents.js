// ── When the session ends ───────────────────────────────────────────────────
//
// The app used to check the session once, at start-up. After that a cookie that
// expired, a sign-out in another tab or a removal from the allowlist left the
// shell running: every page showed the server's raw "Not authenticated." inside
// the app chrome, "Try again" got another 401, and the crawl-status heartbeat
// kept polling every fifteen seconds forever.
//
// This module is the one place that notices. AuthProvider installs a watcher
// on window.fetch, so every API helper in the app is covered without each one
// having to remember — the first 401 from requireAuth switches to the sign-in
// screen, once, however many requests fail together. A sign-out is broadcast to
// the other tabs of this browser so they switch too.
//
// Which 401s count: only ones requireAuth sent (it marks them with the
// X-Session-Ended header). A route that answers 401 for its own reasons, such
// as an upstream API key, must not sign anyone out.

export const SESSION_HEADER = 'x-session-ended';
const CHANNEL = 'seo-studio-auth';
const STORAGE_KEY = 'seo-studio:signed-out';
const RETURN_KEY = 'seo-studio:return-path';
const SIGNED_IN_KEY = 'seo-studio:signed-in';
const HAD_SESSION_KEY = 'seo-studio:had-session';

const listeners = new Set();
let fired = false;

/** Subscribes to "this tab's session has ended". Returns an unsubscribe. */
export function onSessionEnded(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Announces that the session ended. Fires once until resetSessionEnded(), so a
 * dashboard whose six reads all 401 together makes one transition, not six.
 */
export function notifySessionEnded(reason = 'session_expired') {
  if (fired) return;
  fired = true;
  for (const fn of [...listeners]) {
    try { fn(reason); } catch { /* one bad listener must not stop the rest */ }
  }
}

/** Re-arms the signal after a successful sign-in. */
export function resetSessionEnded() { fired = false; }

/**
 * Whether a response means "your session is gone". Pure, for the tests.
 * Same-origin /api/* only, never /api/auth/* (verify drives the gate itself and
 * would otherwise loop), and only a 401 requireAuth marked as its own.
 */
export function isSessionEndedResponse(url, status, header, origin) {
  if (status !== 401) return false;
  if (!header) return false;
  let u;
  try { u = new URL(String(url), origin); } catch { return false; }
  if (origin && u.origin !== origin) return false;
  return u.pathname.startsWith('/api/') && !u.pathname.startsWith('/api/auth/');
}

/**
 * How to read an /api/auth/verify answer. A 5xx or a dropped connection is not
 * a signed-out user: treating it as one put the whole team on the sign-in
 * screen during a fifteen-second database hiccup.
 *
 * @returns {'authenticated'|'unauthenticated'|'unreachable'}
 */
export function classifyVerify(status, body) {
  if (status === 401 || status === 403) return 'unauthenticated';
  if (status == null || status >= 500 || status === 0) return 'unreachable';
  if (body && body.valid === true) return 'authenticated';
  if (body && body.valid === false) return 'unauthenticated';
  // A 200 that is not the JSON we expect (a proxy's HTML page) says nothing
  // about the session either.
  return 'unreachable';
}

const RETRY_DELAYS_MS = [2000, 5000, 10000];
/** Wait before the nth retry of an unreachable verify (0-based), capped. */
export function retryDelay(attempt) {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, attempt), RETRY_DELAYS_MS.length - 1)];
}

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

let installed = null;

/**
 * Wraps window.fetch so a requireAuth 401 from anywhere ends the session. The
 * response is returned untouched, so callers behave exactly as before; the
 * gate simply replaces the screen they were rendering. Idempotent.
 */
export function installFetchWatcher() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return () => {};
  if (installed) return installed.uninstall;
  const original = window.fetch;
  const watched = async function watchedFetch(input, init) {
    const res = await original.call(this, input, init);
    try {
      if (res && res.status === 401
          && isSessionEndedResponse(urlOf(input), res.status, res.headers?.get?.(SESSION_HEADER), window.location.origin)) {
        notifySessionEnded('session_expired');
      }
    } catch { /* never let the watcher break a request */ }
    return res;
  };
  window.fetch = watched;
  installed = {
    uninstall: () => {
      if (window.fetch === watched) window.fetch = original;
      installed = null;
    },
  };
  return installed.uninstall;
}

// ── Across tabs ─────────────────────────────────────────────────────────────

/** Tells this browser's other tabs that the user signed out. */
export function broadcastSignOut() {
  try {
    if (typeof BroadcastChannel === 'function') {
      const ch = new BroadcastChannel(CHANNEL);
      ch.postMessage({ type: 'signed-out', at: Date.now() });
      ch.close();
    }
  } catch { /* fall through to the storage event */ }
  // Written as well as posted: the storage event reaches browsers without
  // BroadcastChannel, and a duplicate notice is harmless (notify fires once).
  try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch { /* private mode */ }
}

/**
 * Tells this browser's other tabs that a session now exists (someone signed in
 * here). A tab left on the sign-in screen re-checks and leaves it; a signed-in
 * tab ignores it.
 */
export function broadcastSignIn() {
  try {
    if (typeof BroadcastChannel === 'function') {
      const ch = new BroadcastChannel(CHANNEL);
      ch.postMessage({ type: 'signed-in', at: Date.now() });
      ch.close();
    }
  } catch { /* fall through to the storage event */ }
  try { localStorage.setItem(SIGNED_IN_KEY, String(Date.now())); } catch { /* private mode */ }
}

/** Calls fn when another tab of this browser signs in. Returns an unsubscribe. */
export function onCrossTabSignIn(fn) {
  const cleanups = [];
  try {
    if (typeof BroadcastChannel === 'function') {
      const ch = new BroadcastChannel(CHANNEL);
      ch.onmessage = (e) => { if (e?.data?.type === 'signed-in') fn(); };
      cleanups.push(() => ch.close());
    }
  } catch { /* storage fallback below */ }
  const onStorage = (e) => { if (e.key === SIGNED_IN_KEY && e.newValue) fn(); };
  window.addEventListener('storage', onStorage);
  cleanups.push(() => window.removeEventListener('storage', onStorage));
  return () => cleanups.forEach((c) => c());
}

// ── "Was signed in here" ────────────────────────────────────────────────────
// Set on every successful session check, cleared only by choosing to sign out.
// A reload that finds no session while this is set means the session ended
// under the user (expiry, revoked elsewhere), not that they never signed in —
// so the sign-in screen says so and signing in returns to the same page.

export function markHadSession() {
  try { localStorage.setItem(HAD_SESSION_KEY, '1'); } catch { /* private mode */ }
}

export function clearHadSession() {
  try { localStorage.removeItem(HAD_SESSION_KEY); } catch { /* private mode */ }
}

export function hadSession() {
  try { return localStorage.getItem(HAD_SESSION_KEY) === '1'; } catch { return false; }
}

/** Calls fn when another tab of this browser signs out. Returns an unsubscribe. */
export function onCrossTabSignOut(fn) {
  const cleanups = [];
  try {
    if (typeof BroadcastChannel === 'function') {
      const ch = new BroadcastChannel(CHANNEL);
      ch.onmessage = (e) => { if (e?.data?.type === 'signed-out') fn(); };
      cleanups.push(() => ch.close());
    }
  } catch { /* storage fallback below */ }
  const onStorage = (e) => { if (e.key === STORAGE_KEY && e.newValue) fn(); };
  window.addEventListener('storage', onStorage);
  cleanups.push(() => window.removeEventListener('storage', onStorage));
  return () => cleanups.forEach((c) => c());
}

// ── Coming back after signing in ────────────────────────────────────────────
// sessionStorage, so it is this tab's own and survives the Google round trip
// (same tab, same origin) without leaking into another tab's sign-in.

export function rememberReturnPath(path) {
  try {
    if (path && path !== '/' && path.startsWith('/')) sessionStorage.setItem(RETURN_KEY, path);
  } catch { /* nothing to return to, then */ }
}

/** Reads and clears the remembered path. Only same-app paths are returned. */
export function takeReturnPath() {
  try {
    const path = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return path && path.startsWith('/') && !path.startsWith('//') ? path : null;
  } catch { return null; }
}

export function clearReturnPath() {
  try { sessionStorage.removeItem(RETURN_KEY); } catch { /* ignore */ }
}

// Routes drawn without the sign-in gate (or the sign-in page itself). Never a
// place to come back to after signing in: a shared Agent Readiness summary
// opened signed out would otherwise claim the return path, and "Open full
// report" -> sign in landed back on the summary.
const PUBLIC_PATHS = new Set(['/agent-readiness-audit/summary', '/login']);

export function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname || '');
}

/**
 * The return path to keep when the sign-in screen is shown at `pathname`, or
 * null for a public route or the root. Pure, for the tests.
 */
export function gateReturnPath(pathname, search = '') {
  if (!pathname || !pathname.startsWith('/') || pathname === '/' || isPublicPath(pathname)) return null;
  return pathname + (search || '');
}
