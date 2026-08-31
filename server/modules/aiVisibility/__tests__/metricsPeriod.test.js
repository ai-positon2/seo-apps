// ── metrics/period ────────────────────────────────────────────────────────
//
// METRICS.md §3.8. The intersection rule is the highest-stakes thing in the
// metrics layer: without it, approving five easy prompts shows up as a
// visibility jump — a number that moved because the questions changed,
// presented to a client as though their position improved.
//
// Run: node modules/aiVisibility/__tests__/metricsPeriod.test.js

const assert = require('assert');
const period = require('../metrics/period');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const cap = (id, promptId, capturedAt) => ({
  id, promptId, capturedAt, status: 'captured', offGeo: false, engine: 'chatgpt',
});

section('periods — equal length, `to` inclusive');

test('a 30-day period ending 2026-08-29 starts on 2026-07-31', () => {
  const p = period.periods({ to: '2026-08-29', days: 30 });
  assert.strictEqual(p.current.from, '2026-07-31');
  assert.strictEqual(p.current.to, '2026-08-29');
  assert.strictEqual(p.days, 30, 'the `to` day is included, so the count is 30 not 29');
});

test('the previous period is the same length and ends the day before', () => {
  const p = period.periods({ to: '2026-08-29', days: 30 });
  assert.strictEqual(p.previous.to, '2026-07-30');
  assert.strictEqual(p.previous.from, '2026-07-01');
});

test('an explicit from/to sets the length, and the previous window matches it', () => {
  const p = period.periods({ from: '2026-08-01', to: '2026-08-07' });
  assert.strictEqual(p.days, 7);
  assert.strictEqual(p.previous.from, '2026-07-25');
  assert.strictEqual(p.previous.to, '2026-07-31');
});

section('inPeriod — boundaries');

test('a capture on the final day is included', () => {
  const rows = [cap('1', 'p1', '2026-08-29T23:59:00Z')];
  assert.strictEqual(period.inPeriod(rows, { from: '2026-08-01', to: '2026-08-29' }).length, 1,
    'an exclusive `to` would silently drop today from every daily report');
});

test('a capture on the first day is included and one before it is not', () => {
  const rows = [cap('1', 'p1', '2026-08-01T00:00:01Z'), cap('2', 'p1', '2026-07-31T23:59:59Z')];
  const got = period.inPeriod(rows, { from: '2026-08-01', to: '2026-08-29' });
  assert.deepStrictEqual(got.map((r) => r.id), ['1']);
});

section('the intersection rule — §3.8');

test('an unchanged prompt set compares on everything and flags nothing', () => {
  const now = [cap('1', 'p1', 'x'), cap('2', 'p2', 'x')];
  const before = [cap('3', 'p1', 'x'), cap('4', 'p2', 'x')];
  const c = period.promptIntersection(now, before);
  assert.strictEqual(c.changed, false);
  assert.strictEqual(c.sharedCount, 2);
  assert.strictEqual(c.note, null);
});

test('newly approved prompts narrow the comparison and are disclosed', () => {
  const now = [cap('1', 'p1', 'x'), cap('2', 'p2', 'x'), cap('3', 'p3', 'x')];
  const before = [cap('4', 'p1', 'x'), cap('5', 'p2', 'x')];
  const c = period.promptIntersection(now, before);
  assert.strictEqual(c.changed, true);
  assert.deepStrictEqual(c.promptIds.sort(), ['p1', 'p2']);
  assert.match(c.note, /2 of 3 prompts/,
    'the header must say the comparison narrowed, not present it as the whole set');
});

test('a retired prompt also changes the set', () => {
  const now = [cap('1', 'p1', 'x')];
  const before = [cap('2', 'p1', 'x'), cap('3', 'p2', 'x')];
  assert.strictEqual(period.promptIntersection(now, before).changed, true);
});

test('with no shared prompts there is no comparison at all', () => {
  const c = period.promptIntersection([cap('1', 'p9', 'x')], [cap('2', 'p1', 'x')]);
  assert.strictEqual(c.comparable, false, 'better no delta than one built on nothing');
  assert.strictEqual(c.promptIds.length, 0);
});

test('a first-ever period has no previous data and is not comparable', () => {
  const c = period.promptIntersection([cap('1', 'p1', 'x')], []);
  assert.strictEqual(c.comparable, false);
  assert.strictEqual(c.previousCount, 0);
});

section('split — headline uses the full period, deltas use the intersection');

test('the headline rows are the whole current period, not the narrowed set', () => {
  const rows = [
    cap('1', 'p1', '2026-08-20T10:00:00Z'),
    cap('2', 'p2', '2026-08-20T10:00:00Z'),
    cap('3', 'p1', '2026-07-10T10:00:00Z'),
  ];
  const s = period.split(rows, { to: '2026-08-29', days: 30 });
  assert.strictEqual(s.current.length, 2,
    'this month\'s visibility is over the prompts asked this month');
  assert.strictEqual(s.currentForDelta.length, 1, 'but the delta compares only p1');
  assert.strictEqual(s.previousForDelta.length, 1);
});

test('the prompt-set change surfaces as a warning the report must carry', () => {
  const rows = [
    cap('1', 'p1', '2026-08-20T10:00:00Z'),
    cap('2', 'p2', '2026-08-20T10:00:00Z'),
    cap('3', 'p1', '2026-07-10T10:00:00Z'),
  ];
  const s = period.split(rows, { to: '2026-08-29', days: 30 });
  assert.ok(s.warnings.includes('prompt_set_changed'));
});

test('no previous data yields an empty delta basis rather than a fabricated one', () => {
  const rows = [cap('1', 'p1', '2026-08-20T10:00:00Z')];
  const s = period.split(rows, { to: '2026-08-29', days: 30 });
  assert.strictEqual(s.previous.length, 0);
  assert.deepStrictEqual(s.currentForDelta, []);
  assert.ok(s.warnings.includes('no_comparable_period'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
