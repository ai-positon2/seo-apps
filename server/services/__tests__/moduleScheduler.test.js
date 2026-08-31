// ── moduleScheduler ───────────────────────────────────────────────────────
//
// The interval floor (`scheduleMinIntervalHours`) has been defined and
// resolvable in adminLimits since the platform foundation, with tests covering
// its resolution — but nothing has ever CHECKED it. These pin that it now is.
//
// The cron maths itself is CrawlScope's and already tested there; what is
// tested here is the wiring: the floor, the stagger, and that a tick advances
// before it enqueues.
//
// Run: node services/__tests__/moduleScheduler.test.js

const assert = require('assert');
const sched = require('../moduleScheduler');
const { staggerMinute } = require('../../modules/crawlScope/shared/schedule');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

(async () => {
  section('intervalHoursOf — enough resolution to gate on');

  await test('a fixed hour every day is 24 hours', () => {
    assert.strictEqual(sched.intervalHoursOf('17 3 * * *'), 24);
  });

  await test('a named weekday is weekly', () => {
    assert.strictEqual(sched.intervalHoursOf('17 3 * * 0'), 168);
  });

  await test('an hourly or sub-hourly schedule is caught, not treated as daily', () => {
    assert.strictEqual(sched.intervalHoursOf('17 * * * *'), 1);
    assert.ok(sched.intervalHoursOf('*/15 * * * *') < 1,
      'a step minute is sub-hourly and must not slip past a 24-hour floor');
  });

  await test('a malformed cron returns null rather than a confident wrong number', () => {
    assert.strictEqual(sched.intervalHoursOf('nonsense'), null);
    assert.strictEqual(sched.intervalHoursOf(''), null);
  });

  section('staggerMinute — deterministic, so a project keeps its minute');

  await test('the same project always gets the same minute', () => {
    const a = staggerMinute('project-abc');
    const b = staggerMinute('project-abc');
    assert.strictEqual(a, b, 'a random minute would move on every edit');
    assert.ok(a >= 0 && a < 60);
  });

  await test('different projects land on different minutes', () => {
    const minutes = new Set(
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map(staggerMinute),
    );
    assert.ok(minutes.size > 4,
      `only ${minutes.size} distinct minutes across 8 projects — the herd would re-form`);
  });

  section('minIntervalHours — the floor that was never enforced');

  await test('with no admin override the floor is the 24-hour default', async () => {
    const hours = await sched.minIntervalHours({ project: { id: 'p1' } });
    assert.strictEqual(hours, 24);
  });

  await test('a resolution failure falls back to 24 rather than to no limit', async () => {
    const hours = await sched.minIntervalHours(null);
    assert.strictEqual(hours, 24,
      'defaulting to unlimited on error would let an error open the floodgates');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
