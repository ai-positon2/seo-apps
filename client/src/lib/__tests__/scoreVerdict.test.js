// ── The badge a scored module earns ──────────────────────────────────────────
//
// Run: npm test --prefix client
//
// The Home dashboard's module badge used to report the run ("Healthy" meant
// "it completed") and so read "Healthy" above a red 3/100. The badge now takes
// its word from the score, on the same bands the card colours the number with.

import { test } from 'node:test';
import assert from 'node:assert';

import { scoreVerdict, scoreBandColor } from '../scoreVerdict.js';

test('the verdict follows the same bands as the score colour', () => {
  assert.deepStrictEqual(scoreVerdict(100), { label: 'Good', tone: 'accent' });
  assert.deepStrictEqual(scoreVerdict(80), { label: 'Good', tone: 'accent' });
  assert.deepStrictEqual(scoreVerdict(79.6), { label: 'Good', tone: 'accent' }, 'rounds like the number on the card');
  assert.deepStrictEqual(scoreVerdict(79), { label: 'Needs attention', tone: 'warn' });
  assert.deepStrictEqual(scoreVerdict(60), { label: 'Needs attention', tone: 'warn' });
  assert.deepStrictEqual(scoreVerdict(59), { label: 'At risk', tone: 'neg' });
  assert.deepStrictEqual(scoreVerdict(3), { label: 'At risk', tone: 'neg' });
  assert.deepStrictEqual(scoreVerdict(0), { label: 'At risk', tone: 'neg' });
});

test('no score, no verdict — the caller falls back to the run status', () => {
  assert.strictEqual(scoreVerdict(null), null);
  assert.strictEqual(scoreVerdict(undefined), null);
  assert.strictEqual(scoreVerdict(Number.NaN), null);
});

// Agent Readiness used to colour its ring and category bars at 70/45 while the
// dashboard banded the same score at 80/60, so a 72 was green on one screen and
// amber on the other. One helper, one set of bands.
test('the band colour switches at 80 and 60, like the verdict', () => {
  assert.strictEqual(scoreBandColor(80), 'var(--primary)');
  assert.strictEqual(scoreBandColor(79.6), 'var(--primary)', 'rounds like the number on the card');
  assert.strictEqual(scoreBandColor(79), 'var(--viz-warn)');
  assert.strictEqual(scoreBandColor(60), 'var(--viz-warn)');
  assert.strictEqual(scoreBandColor(59), 'var(--viz-neg)');
  assert.strictEqual(scoreBandColor(0), 'var(--viz-neg)');
});

test('no score, no band colour', () => {
  assert.strictEqual(scoreBandColor(null), null);
  assert.strictEqual(scoreBandColor(undefined), null);
  assert.strictEqual(scoreBandColor(Number.NaN), null);
});
