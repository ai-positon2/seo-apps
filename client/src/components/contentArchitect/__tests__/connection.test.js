// ── Content Architect: Retry only when it can change the answer (UX-228) ────
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';

import { canRetry } from '../connection.js';

const base = { canStartRun: true };

test('a site that serves crawlers its homepage is not offered a Retry that repeats the verdict', () => {
  assert.strictEqual(canRetry({ ...base, state: 'insufficient_data', reason: 'homepage_served', retryHelps: false }), false);
});

test('a verdict a second run could change keeps Retry, and so does a run stored before retryHelps existed', () => {
  assert.strictEqual(canRetry({ ...base, state: 'insufficient_data', retryHelps: true }), true);
  assert.strictEqual(canRetry({ ...base, state: 'insufficient_data' }), true);
});

test('failed, cancelled and never-started runs can always be retried; nothing is offered without the right', () => {
  for (const state of ['failed', 'cancelled', 'not_started']) assert.strictEqual(canRetry({ ...base, state }), true);
  assert.strictEqual(canRetry({ ...base, state: 'analyzed' }), false);
  assert.strictEqual(canRetry({ state: 'failed', canStartRun: false }), false);
  assert.strictEqual(canRetry(null), false);
});
