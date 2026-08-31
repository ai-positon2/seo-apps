// ── metrics/format ────────────────────────────────────────────────────────
//
// METRICS.md §11 and §12. What is pinned hardest is the three-state rule —
// "no data", "zero measured" and "a real zero" must never render the same —
// because collapsing them tells a client they are invisible when the truth is
// that nothing was measured.
//
// Run: node modules/aiVisibility/__tests__/metricsFormat.test.js

const assert = require('assert');
const f = require('../metrics/format');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

section('halfUp — symmetric, so deltas compare fairly');

test('negatives round the same distance as positives', () => {
  assert.strictEqual(f.halfUp(2.5), 3);
  assert.strictEqual(f.halfUp(-2.5), -3, 'Math.round(-2.5) is -2, which is the bug this exists for');
});

section('percentages — §11');

test('hero form is 1 decimal, dense table form is 0', () => {
  assert.strictEqual(f.pct(0.273), '27.3%');
  assert.strictEqual(f.pct(0.273, { dense: true }), '27%');
});

test('100% is never shown for anything short of exactly 1.0', () => {
  assert.strictEqual(f.pct(0.9996), '99.9%', 'a near-perfect score must not claim perfection');
  assert.strictEqual(f.pct(1), '100.0%');
});

test('a tiny non-zero never renders as 0%', () => {
  assert.strictEqual(f.pct(0.0001), '0.1%', 'rounding a real signal down to zero erases it');
  assert.strictEqual(f.pct(0), '0.0%', 'but a real zero IS zero');
});

section('the three empty states are three different strings');

test('no data and zero measured are both an em-dash, a real zero is not', () => {
  assert.strictEqual(f.metric(null, 'percent').display, f.EMPTY);
  assert.strictEqual(f.metric(f.ratio(0, 0), 'percent').display, f.EMPTY, 'zero measured');
  assert.strictEqual(f.metric(f.ratio(0, 8), 'percent').display, '0.0%', 'measured 8 times, named none');
});

test('ratio refuses a zero denominator rather than returning zero', () => {
  assert.strictEqual(f.ratio(0, 0), null, '"0 of 0" is nothing measured, not zero percent');
  assert.strictEqual(f.ratio(0, 8), 0);
});

section('counts and compact labels — §11');

test('thousands separators in tables', () => {
  assert.strictEqual(f.count(2305), '2,305');
});

test('compact labels TRUNCATE rather than round up', () => {
  assert.strictEqual(f.compact(1999), '1.9k', 'a label must not claim a number reached 2,000');
  assert.strictEqual(f.compact(72200), '72.2k');
  assert.strictEqual(f.compact(999), '999');
});

section('deltas — §3.8');

test('percentages move in POINTS, and say so', () => {
  const m = f.metric(0.273, 'percent', { previous: 0.247 });
  assert.strictEqual(m.deltaDisplay, '+2.6 pts',
    'labelling this "%" is the most common way the number gets misread');
});

test('counts move in percent change', () => {
  const m = f.metric(120, 'count', { previous: 100 });
    assert.strictEqual(m.deltaDisplay, '+20.0%');
});

test('a previous value of zero has no percent change, not +100%', () => {
  const m = f.metric(50, 'count', { previous: 0 });
  assert.strictEqual(m.delta, null);
  assert.strictEqual(m.deltaDisplay, null, 'a first observation is not a trend');
});

test('no previous period means no delta at all', () => {
  const m = f.metric(0.273, 'percent');
  assert.strictEqual(m.deltaDisplay, null);
});

section('direction — the UI colours by this, not by sign');

test('position is lower_is_better, so an improving rank is not painted red', () => {
  const m = f.metric(2.0, 'position', { previous: 4.0, direction: 'lower_is_better' });
  assert.strictEqual(m.display, '#2.0');
  assert.strictEqual(m.delta, -2);
  assert.strictEqual(m.direction, 'lower_is_better');
});

section('the envelope shape — §12');

test('every metric carries value, display, delta, deltaDisplay and direction', () => {
  const m = f.metric(0.273, 'percent', { previous: 0.247 });
  assert.deepStrictEqual(Object.keys(m).sort(),
    ['delta', 'deltaDisplay', 'direction', 'display', 'value'].sort());
  assert.strictEqual(m.value, 0.273, 'the raw value ships alongside the string');
});

test('sentiment is an integer and dashes out when nothing was scored', () => {
  assert.strictEqual(f.metric(62.4, 'sentiment').display, '62');
  assert.strictEqual(f.metric(null, 'sentiment').display, f.EMPTY, '§3.6: never show 0');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
