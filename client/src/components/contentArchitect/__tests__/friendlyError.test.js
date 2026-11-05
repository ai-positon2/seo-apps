// ── Content Architect: errors a person can act on (UX-229) ──────────────────
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';

import { friendlyError } from '../friendlyError.js';

test('a dropped connection reads as plain words, not the browser’s "Failed to fetch"', () => {
  assert.strictEqual(
    friendlyError(new TypeError('Failed to fetch')),
    'Could not reach the server. Check your connection and try again.',
  );
  assert.match(friendlyError(new TypeError('NetworkError when attempting to fetch resource.')), /Could not reach the server/);
  assert.match(friendlyError(new TypeError('Load failed')), /Could not reach the server/);
});

test('the next step can be named', () => {
  assert.strictEqual(
    friendlyError(new TypeError('Failed to fetch'), 'reload the page'),
    'Could not reach the server. Check your connection and reload the page.',
  );
});

test('a server’s own message is kept, and an empty one is not shown blank', () => {
  assert.strictEqual(friendlyError(new Error('This project needs a primary domain.')), 'This project needs a primary domain.');
  assert.match(friendlyError(null), /Could not reach the server/);
});
