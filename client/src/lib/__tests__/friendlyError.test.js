// ── Errors a non-technical reader can act on ─────────────────────────────────
//
// Run: npm test --prefix client
//
// Screens used to show the browser's "Failed to fetch", bare status codes and
// developer setup instructions as-is. Server-written sentences must survive.

import { test } from 'node:test';
import assert from 'node:assert';

import { friendlyError, errorDetail } from '../friendlyError.js';

test('network failures become a connection hint', () => {
  assert.match(friendlyError(new Error('Failed to fetch')), /connection/);
  assert.match(friendlyError(new TypeError('NetworkError when attempting to fetch resource.')), /connection/);
  assert.match(friendlyError(null), /connection/);
});

test('bare status codes become plain sentences', () => {
  assert.match(friendlyError(new Error('Request failed (500)')), /server/);
  assert.match(friendlyError(new Error('HTTP 404')), /couldn't find/);
  assert.match(friendlyError({ message: 'Request failed (401)' }), /sign in/);
  assert.match(friendlyError({ message: 'Request failed (403)' }), /access/);
  assert.match(friendlyError({ message: 'Request failed (418)' }), /didn't work/);
});

test("apiRequest's '<what> failed (NNN)' fallback counts as a bare status", () => {
  const e = new Error('Download failed (500)'); e.status = 500;
  assert.match(friendlyError(e), /server/);
  assert.strictEqual(errorDetail(e), 'Download failed (500)');
  // A server sentence that merely ends in a number is not a status code.
  const s = 'This crawl was already exported 3 times today and the limit is 3 per day.';
  assert.strictEqual(friendlyError(new Error(s)), s);
});

test('the rate limiter reply is softened', () => {
  assert.match(friendlyError(new Error('Too many requests. Please wait a moment and try again.')), /busy/);
  const e = new Error('x'); e.status = 429;
  assert.match(friendlyError(e), /busy/);
});

test('developer setup instructions are not shown to users', () => {
  assert.match(friendlyError(new Error('Apply supabase/migrations/0030_ai_visibility_lite.sql, then reload.')), /isn't set up/);
  assert.match(friendlyError(new Error('The database is not configured. Set DATABASE_URL, then reload.')), /isn't set up/);
});

test('server-written sentences pass through untouched', () => {
  const s = 'That domain is already a project in this workspace.';
  assert.strictEqual(friendlyError(new Error(s)), s);
  assert.strictEqual(errorDetail(new Error(s)), null);
});

test('errorDetail keeps the original text when it was replaced', () => {
  assert.strictEqual(errorDetail(new Error('Request failed (500)')), 'Request failed (500)');
});
