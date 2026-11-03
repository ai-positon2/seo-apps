// ── A capped page says why ──────────────────────────────────────────────────
//
// Eight capped pages read "…blocking issue: undefined" because the reasons
// live in cap.groups[], not cap.reason.
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';

import { capReason } from '../capReason.js';

test('a capped page names its blocking issues', () => {
  const cap = {
    applied: true, value: 60,
    groups: [{ id: 'no_h1', cap: 65, reason: 'No usable H1.' }, { id: 'no_title', cap: 60, reason: 'No usable title element.' }],
  };
  assert.strictEqual(capReason(cap), 'No usable H1. No usable title element.');
  assert.doesNotMatch(capReason(cap), /undefined/);
});

test('a side cap (reasons list) and an empty cap read sensibly', () => {
  assert.strictEqual(capReason({ reasons: ['Answerability is 5/10.'] }), 'Answerability is 5/10.');
  assert.strictEqual(capReason({ applied: true, value: 50 }), 'a blocking issue on the page.');
  assert.strictEqual(capReason(null), '');
});
