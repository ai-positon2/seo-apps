// ── The report bar's failure states, in words ───────────────────────────────
//
// UX-104/181/182: a failed page or an unreadable stored report was reported as
// 'none' with a raw error string; a failed run read "No stored report yet".
// UX-151: ?page= picks the page on reload.
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';

import { plainFailure, runDidNotFinish, pickSelection } from '../pageReportPicker.js';

test('a refusal by the site is said plainly', () => {
  assert.match(plainFailure('Fetch failed: HTTP 429 Too Many Requests'), /site blocked our check/);
  assert.match(plainFailure('Could not fetch https://x.test (HTTP 403)'), /site blocked our check/);
  assert.match(plainFailure('Page timed out after 30s'), /took too long/);
  assert.match(plainFailure('getaddrinfo ENOTFOUND x.test'), /could not be reached/);
  assert.match(plainFailure('something odd'), /couldn’t be audited/);
});

test('our own failed request is not blamed on the site', () => {
  assert.match(plainFailure('Internal server error', { kind: 'fetch', status: 500 }), /couldn’t open this report just now/);
  assert.match(plainFailure('Page report not found.', { kind: 'fetch', status: 404 }), /no longer available/);
});

test('a failed or cancelled run did not finish; a completed one did', () => {
  assert.strictEqual(runDidNotFinish({ status: 'failed' }), true);
  assert.strictEqual(runDidNotFinish({ status: 'cancelled' }), true);
  assert.strictEqual(runDidNotFinish({ status: 'completed' }), false);
  assert.strictEqual(runDidNotFinish(null), false);
});

test('the page in the address wins, when it belongs to this run', () => {
  const pages = [{ pageRunId: 'b', ordinal: 1 }, { pageRunId: 'a', ordinal: 0 }];
  assert.strictEqual(pickSelection(pages, { wanted: 'b' }), 'b');
  assert.strictEqual(pickSelection(pages, { wanted: 'zzz', current: 'b' }), 'b');
  assert.strictEqual(pickSelection(pages, { wanted: 'zzz' }), 'a', 'falls back to the homepage');
  assert.strictEqual(pickSelection([], { wanted: 'b' }), null);
});
