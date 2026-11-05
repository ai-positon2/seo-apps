// ── The Overview's per-project cache (UX-084) ───────────────────────────────
//
// Run: npm test --prefix client
//
// Back to the Overview shows the last numbers at once instead of skeletons —
// and never another client's.

import { test } from 'node:test';
import assert from 'node:assert';

import { createOverviewCache } from '../overviewCache.js';

test('returns what was stored for the same project', () => {
  const cache = createOverviewCache();
  cache.set('overview', 'p1', { modules: [1] });
  assert.deepStrictEqual(cache.get('overview', 'p1'), { modules: [1] });
});

test('never hands one project\'s data to another', () => {
  const cache = createOverviewCache();
  cache.set('overview', 'p1', { name: 'one' });
  assert.strictEqual(cache.get('overview', 'p2'), null);
  assert.strictEqual(cache.get('insights', 'p1'), null, 'kinds are separate too');
});

test('an entry older than the limit is dropped, not shown', () => {
  let t = 0;
  const cache = createOverviewCache({ maxAgeMs: 1000, now: () => t });
  cache.set('overview', 'p1', { a: 1 });
  t = 999;
  assert.ok(cache.get('overview', 'p1'));
  t = 1001;
  assert.strictEqual(cache.get('overview', 'p1'), null);
});

test('forget clears every kind for one project only', () => {
  const cache = createOverviewCache();
  cache.set('overview', 'p1', { a: 1 });
  cache.set('insights', 'p1', { b: 1 });
  cache.set('overview', 'p2', { c: 1 });
  cache.forget('p1');
  assert.strictEqual(cache.get('overview', 'p1'), null);
  assert.strictEqual(cache.get('insights', 'p1'), null);
  assert.ok(cache.get('overview', 'p2'));
});

test('stays bounded however many clients are opened', () => {
  const cache = createOverviewCache();
  for (let i = 0; i < 100; i += 1) cache.set('overview', `p${i}`, { i });
  assert.ok(cache.size() <= 36);
  assert.ok(cache.get('overview', 'p99'), 'the newest is kept');
});
