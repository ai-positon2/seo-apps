import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyVerifyResult,
  parseRetryAfter,
  retryDelayMs,
  afterFailure,
  verifySession,
  STEADY_RETRY_MS,
  UNREACHABLE_AFTER_MS,
  MAX_RETRY_AFTER_MS,
} from '../authCheck.js';

// ── What counts as "signed out" ─────────────────────────────────────────────

test('only valid:false on a 200, or a 401/403, signs the user out', () => {
  assert.equal(classifyVerifyResult({ status: 200, body: { valid: false } }).kind, 'signed-out');
  assert.equal(classifyVerifyResult({ status: 401, body: { error: 'Not authenticated.' } }).kind, 'signed-out');
  assert.equal(classifyVerifyResult({ status: 403, body: undefined }).kind, 'signed-out');
});

test('a rate-limited, failing or garbled verify is transient, not signed out', () => {
  const transient = [
    { status: 429, body: { error: 'Too many requests. Please wait a moment and try again.' } },
    { status: 503, body: { error: 'Sign-in service is temporarily unavailable.' } },
    { status: 500, body: undefined },
    { status: 502, body: undefined },
    { status: 200, body: undefined },              // index.html from a misrouted proxy
    { status: 200, body: { status: 'ok' } },       // JSON, but not the verify shape
    { status: 404, body: { error: 'Unknown API endpoint' } },
    { status: 0, body: undefined },                // network error / timeout
  ];
  for (const r of transient) {
    assert.equal(classifyVerifyResult(r).kind, 'transient', `status ${r.status}`);
  }
});

test('valid:true carries the session fields, with the same defaults as before', () => {
  const r = classifyVerifyResult({
    status: 200,
    body: { valid: true, role: 'seo', email: 'a@x.com', userId: 'u1' },
  });
  assert.equal(r.kind, 'authenticated');
  assert.deepEqual(r.session, {
    role: 'seo', email: 'a@x.com', userId: 'u1', hasProfile: true, isPlatformAdmin: false,
  });
  const noProfile = classifyVerifyResult({
    status: 200, body: { valid: true, hasProfile: false, isPlatformAdmin: true },
  });
  assert.equal(noProfile.session.hasProfile, false);
  assert.equal(noProfile.session.isPlatformAdmin, true);
});

// ── Back-off ────────────────────────────────────────────────────────────────

test('retries back off 1s, 2s, 4s, 8s, then every 15s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map((n) => retryDelayMs(n)),
    [1000, 2000, 4000, 8000, STEADY_RETRY_MS, STEADY_RETRY_MS, STEADY_RETRY_MS]);
});

test('Retry-After is honoured when longer than the schedule, and capped', () => {
  assert.equal(retryDelayMs(1, 30_000), 30_000);
  assert.equal(retryDelayMs(5, 2_000), STEADY_RETRY_MS);   // never sooner than the schedule
  assert.equal(retryDelayMs(1, 3_600_000), MAX_RETRY_AFTER_MS);
  assert.equal(retryDelayMs(2, null), 2000);
  assert.equal(retryDelayMs(2, 0), 2000);
});

test('Retry-After parses seconds and HTTP dates, and ignores junk', () => {
  assert.equal(parseRetryAfter('42'), 42_000);
  assert.equal(parseRetryAfter(' 5 '), 5_000);
  const now = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(parseRetryAfter('Sun, 04 Oct 2026 12:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Sun, 04 Oct 2026 11:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('soon'), null);
});

// ── What the user sees while it keeps failing ───────────────────────────────

test('with no answer yet: reconnecting, then unreachable after a minute, retrying throughout', () => {
  const t0 = 1_000_000;
  assert.deepEqual(afterFailure('loading', t0, t0), { state: 'reconnecting', retry: true });
  assert.deepEqual(afterFailure('reconnecting', t0, t0 + 30_000), { state: 'reconnecting', retry: true });
  assert.deepEqual(afterFailure('reconnecting', t0, t0 + UNREACHABLE_AFTER_MS), { state: 'unreachable', retry: true });
  assert.deepEqual(afterFailure('unreachable', t0, t0 + 10 * 60_000), { state: 'unreachable', retry: true });
});

test('an authenticated user stays authenticated when a re-check fails, and retries stop after a minute', () => {
  const t0 = 1_000_000;
  assert.deepEqual(afterFailure('authenticated', t0, t0), { state: 'authenticated', retry: true });
  assert.deepEqual(afterFailure('authenticated', t0, t0 + UNREACHABLE_AFTER_MS), { state: 'authenticated', retry: false });
  assert.deepEqual(afterFailure('unauthenticated', t0, t0), { state: 'unauthenticated', retry: true });
});

// ── verifySession: the fetch wrapper ────────────────────────────────────────

function fakeResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    async json() {
      if (typeof body === 'string') throw new SyntaxError('Unexpected token <');
      return body;
    },
  };
}

test('verifySession reads Retry-After from a 429', async () => {
  let seen;
  const r = await verifySession({
    fetchImpl: async (url, init) => { seen = { url, init }; return fakeResponse(429, { error: 'x' }, { 'Retry-After': '12' }); },
  });
  assert.equal(seen.url, '/api/auth/verify');
  assert.equal(seen.init.credentials, 'include');
  assert.equal(r.outcome.kind, 'transient');
  assert.equal(r.retryAfterMs, 12_000);
});

test('verifySession turns a non-JSON body and a thrown fetch into transient', async () => {
  const html = await verifySession({ fetchImpl: async () => fakeResponse(200, '<!doctype html>') });
  assert.equal(html.outcome.kind, 'transient');
  const offline = await verifySession({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual(offline, { outcome: { kind: 'transient' }, retryAfterMs: null });
});

test('verifySession gives up on a hung request after its timeout', async () => {
  const r = await verifySession({
    timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  assert.equal(r.outcome.kind, 'transient');
});

test('verifySession passes a signed-out answer straight through', async () => {
  const r = await verifySession({ fetchImpl: async () => fakeResponse(200, { valid: false }) });
  assert.equal(r.outcome.kind, 'signed-out');
  assert.equal(r.retryAfterMs, null);
});
