// ── D7: did a score go up or down since the last measurement ────────────────
//
// Run: node --test modules/projects/__tests__/scoreChange.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { changeOf } = require('../overview');

test('a rise, a fall and no change', () => {
  assert.equal(changeOf(76, 66, '2026-10-01').direction, 'up');
  assert.equal(changeOf(76, 66, '2026-10-01').delta, 10);
  assert.equal(changeOf(60, 66).direction, 'down');
  assert.equal(changeOf(66.4, 65.6).direction, 'same', 'both round to 66');
});

test('nothing to compare gives no indicator', () => {
  assert.equal(changeOf(null, 66), null);
  assert.equal(changeOf(70, undefined), null);
});
