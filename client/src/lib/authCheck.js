// ── Deciding what a /api/auth/verify answer means ───────────────────────────
//
// AuthContext used to treat every answer that was not `{ valid: true }` as
// "signed out": a 429 from the rate limiter, a 503 while the database was
// unreachable, an HTML error page from a proxy, a dropped connection. App.jsx
// then rendered the sign-in screen, so a signed-in user who was merely busy
// (or briefly offline) was shown "Sign in to continue" as if their session had
// gone — and the sign-in button itself was rate-limited too.
//
// Only the server can say a session is invalid, and it says so in exactly two
// ways: HTTP 200 with `valid: false` (no cookie, bad or expired token, account
// removed from the allowlist — see server/routes/auth.js /verify), or a 401/403.
// Anything else is "no answer yet", and is retried rather than acted on.
//
// Kept free of React and of the DOM so the decisions are testable under
// node:test (see ./__tests__/authCheck.test.js); AuthContext owns the timers.

// Back-off between attempts after the Nth consecutive failure: 1s, 2s, 4s, 8s,
// then every 15s for as long as it keeps failing.
export const RETRY_SCHEDULE_MS = [1000, 2000, 4000, 8000];
export const STEADY_RETRY_MS = 15_000;

// After this long without an answer, stop showing "Reconnecting…" and tell the
// user plainly that the app cannot be reached, with a button to try again.
export const UNREACHABLE_AFTER_MS = 60_000;

// A Retry-After longer than this is not honoured in full: the user is looking
// at a splash screen, and the next attempt is cheap.
export const MAX_RETRY_AFTER_MS = 60_000;

// A verify request that has not answered in this long is treated as a failed
// attempt, so a hung connection cannot leave the splash up indefinitely.
export const VERIFY_TIMEOUT_MS = 15_000;

/**
 * Classifies one verify response.
 *
 * @param {{ status: number, body?: unknown }} result  `status` 0 means the
 *   request never got an HTTP answer (network error, timeout). `body` is the
 *   parsed JSON, or undefined when the body was not JSON.
 * @returns {{ kind: 'authenticated', session: object }
 *         | { kind: 'signed-out' }
 *         | { kind: 'transient' }}
 */
export function classifyVerifyResult({ status, body }) {
  if (status === 401 || status === 403) return { kind: 'signed-out' };
  if (status === 200 && body && typeof body === 'object') {
    if (body.valid === true) {
      return {
        kind: 'authenticated',
        session: {
          role: body.role,
          email: body.email,
          userId: body.userId,
          hasProfile: body.hasProfile !== false,
          isPlatformAdmin: body.isPlatformAdmin === true,
        },
      };
    }
    if (body.valid === false) return { kind: 'signed-out' };
  }
  // 429, 5xx, an unexpected 2xx/4xx, a body that is not the verify shape (an
  // index.html served by a misrouted proxy, say), or no answer at all.
  return { kind: 'transient' };
}

/**
 * Parses a Retry-After header (delta-seconds or an HTTP date) into ms.
 * Returns null when absent or unreadable.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * How long to wait before the next attempt, after `failures` consecutive
 * failures (1 = the first attempt just failed). A server-sent Retry-After is
 * honoured when it asks for longer than the schedule, up to MAX_RETRY_AFTER_MS.
 */
export function retryDelayMs(failures, retryAfterMs = null) {
  const n = Math.max(1, failures);
  const base = n <= RETRY_SCHEDULE_MS.length ? RETRY_SCHEDULE_MS[n - 1] : STEADY_RETRY_MS;
  if (retryAfterMs == null || !(retryAfterMs > 0)) return base;
  return Math.max(base, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
}

/**
 * The auth state to show after a failed attempt, and whether to keep trying.
 *
 * A user who already has an answer ('authenticated' or 'unauthenticated') keeps
 * it: a re-check that cannot reach the server is no evidence their session
 * changed, and throwing a signed-in user out to a splash or error screen over
 * one failed background call is the bug this module exists to fix. Those
 * re-checks are retried quietly for UNREACHABLE_AFTER_MS and then dropped.
 *
 * With no answer yet, the user sees 'reconnecting' and then, once failures have
 * run continuously for UNREACHABLE_AFTER_MS, 'unreachable'. Retries continue in
 * the background either way, so the app recovers on its own when the server
 * comes back.
 *
 * @returns {{ state: string, retry: boolean }}
 */
export function afterFailure(prevState, failingSinceMs, now = Date.now()) {
  const elapsed = now - failingSinceMs;
  if (prevState === 'authenticated' || prevState === 'unauthenticated') {
    return { state: prevState, retry: elapsed < UNREACHABLE_AFTER_MS };
  }
  return {
    state: elapsed >= UNREACHABLE_AFTER_MS ? 'unreachable' : 'reconnecting',
    retry: true,
  };
}

/**
 * Makes one verify request and classifies it. Never throws.
 *
 * @returns {Promise<{ outcome: ReturnType<typeof classifyVerifyResult>, retryAfterMs: number|null }>}
 */
export async function verifySession({
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = VERIFY_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl('/api/auth/verify', {
      credentials: 'include',
      signal: controller.signal,
    });
    let body;
    try { body = await res.json(); } catch { body = undefined; }
    const retryAfterMs = res.status === 429 || res.status === 503
      ? parseRetryAfter(res.headers?.get?.('Retry-After'), now())
      : null;
    return { outcome: classifyVerifyResult({ status: res.status, body }), retryAfterMs };
  } catch {
    return { outcome: { kind: 'transient' }, retryAfterMs: null };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
