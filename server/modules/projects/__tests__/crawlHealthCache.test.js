// ── The crawl-health aggregates: one computation per finished crawl ─────────
//
// overview.crawlHealthAggregates answers Site Health's numerator, denominator,
// site-level rules and costing rules from one statement, kept per finished
// run. What is worth asserting offline is the caching contract, not the SQL
// (siteHealthDb.test.js runs that against a real database):
//
//   • concurrent callers share one computation;
//   • a finished, unchanged run is computed once;
//   • a review (or any change in the fingerprint) recomputes;
//   • a run still going is never kept;
//   • a statement timeout shows the Tech Audit card as "still being worked
//     out" instead of holding the dashboard, and is not retried by every
//     visitor straight away.
//
// Run: node modules/projects/__tests__/crawlHealthCache.test.js

const assert = require('node:assert/strict');
const db = require('../../../services/db');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

// The fingerprint row per run, and the aggregate row the statement returns.
const runs = new Map();
let computeCalls = 0;
let computeDelayMs = 0;
let computeError = null;

db.maybeOne = async (sql, params) => {
  if (/from crawl_runs r/.test(sql)) return runs.get(params[0]) || null;
  throw new Error(`unexpected maybeOne: ${sql}`);
};
db.boundedRead = async (ms, fn) => {
  computeCalls += 1;
  if (computeDelayMs) await new Promise((r) => setTimeout(r, computeDelayMs));
  if (computeError) throw computeError;
  return fn({
    maybeOne: async () => ({
      html_pages: 4,
      error_pages: 1, warning_pages: 3, notice_pages: 1,
      error_loss: 40, warning_loss: 30, notice_loss: 0,
      site_rules: [{ rule: 'robots', severity: 'warning', site_scoped: true, on_scored: false }],
      costing: [{ rule: 'rule', severity: 'error', urls: ['https://h.invalid/p0'] }],
    }),
  });
};

const overview = require('../overview');

function finishedRun(id, extra = {}) {
  runs.set(id, {
    status: 'completed', finished_at: '2026-11-01T00:00:00+00:00',
    instances: 5, last_instance: 99, reviews: 0, reviewed_at: null, ...extra,
  });
}

(async () => {
  console.log('\ncrawl-health aggregates — cache and single-flight\n');

  await test('concurrent callers share one computation', async () => {
    finishedRun('r1');
    computeCalls = 0;
    computeDelayMs = 20;
    const [pages, affected, costing] = await Promise.all([
      overview.internalHtmlPageCount('r1'),
      overview.healthAffectedPages('r1'),
      overview.costingRulePages('r1'),
    ]);
    computeDelayMs = 0;
    assert.equal(computeCalls, 1);
    assert.equal(pages, 4);
    assert.deepEqual(affected, {
      error: 1, warning: 3, notice: 1,
      siteRules: [{ ruleId: 'robots', severity: 'warning', kind: 'site' }],
      lossTotals: { error: 40, warning: 30, notice: 0 },
    });
    assert.deepEqual([...costing.keys()], ['rule', 'robots']);
  });

  await test('a finished, unchanged run is not computed again', async () => {
    computeCalls = 0;
    await overview.healthAffectedPages('r1');
    await overview.internalHtmlPageCount('r1');
    assert.equal(computeCalls, 0);
  });

  await test('callers get their own Sets, so one cannot change another\'s', async () => {
    const a = await overview.costingRulePages('r1');
    a.get('rule').pages.add('x');
    const b = await overview.costingRulePages('r1');
    assert.equal(b.get('rule').pages.size, 1);
  });

  await test('a reviewer\'s decision recomputes on the next request', async () => {
    computeCalls = 0;
    finishedRun('r1', { reviews: 1, reviewed_at: '2026-11-02T00:00:00+00:00' });
    await overview.healthAffectedPages('r1');
    assert.equal(computeCalls, 1);
  });

  await test('PageSpeed findings added after the crawl recompute too', async () => {
    computeCalls = 0;
    finishedRun('r1', { reviews: 1, reviewed_at: '2026-11-02T00:00:00+00:00', instances: 7, last_instance: 120 });
    await overview.healthAffectedPages('r1');
    assert.equal(computeCalls, 1);
  });

  await test('a run still going is computed every time, never kept', async () => {
    runs.set('live', { status: 'running', finished_at: null, instances: 3, last_instance: 5, reviews: 0, reviewed_at: null });
    computeCalls = 0;
    await overview.healthAffectedPages('live');
    await overview.healthAffectedPages('live');
    assert.equal(computeCalls, 2);
  });

  await test('a run with no instances has no affected counts but still a denominator', async () => {
    finishedRun('empty', { instances: 0, last_instance: null });
    assert.equal(await overview.healthAffectedPages('empty'), null);
    assert.equal(await overview.internalHtmlPageCount('empty'), 4);
  });

  await test('a slow computation leaves the card pending instead of holding the request', async () => {
    finishedRun('slow');
    computeDelayMs = 80;
    const health = await overview.crawlHealthWithin('slow', 10);
    assert.deepEqual(health, { unavailable: true });
    const inputs = overview.healthInputs(health);
    assert.equal(inputs.pending, true);
    // ...and the computation carried on, so the next visit gets the score.
    await new Promise((r) => setTimeout(r, 120));
    computeDelayMs = 0;
    computeCalls = 0;
    const later = await overview.crawlHealthWithin('slow', 10);
    assert.equal(later.htmlPages, 4);
    assert.equal(computeCalls, 0);
  });

  await test('a statement timeout is not retried by every visitor', async () => {
    finishedRun('huge');
    computeError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    computeCalls = 0;
    assert.deepEqual(await overview.crawlHealthWithin('huge'), { unavailable: true });
    assert.deepEqual(await overview.crawlHealthWithin('huge'), { unavailable: true });
    assert.equal(computeCalls, 1);
    computeError = null;
  });

  await test('any other error falls back exactly as before (null)', async () => {
    finishedRun('broken');
    computeError = new Error('relation does not exist');
    assert.equal(await overview.crawlHealthWithin('broken'), null);
    assert.equal(await overview.healthAffectedPages('broken'), null);
    computeError = null;
  });

  await test('the pending Tech Audit card keeps the run and withholds the score', async () => {
    const card = overview.healthPendingCard({
      key: 'technical', status: 'completed', scored: true, score: 80, runId: 'r1',
      headline: 'x', detail: '300 pages crawled', evidence: { counts: {} },
    });
    assert.equal(card.scored, false);
    assert.equal(card.score, null);
    assert.equal(card.healthPending, true);
    assert.match(card.headline, /still being worked out/);
    assert.match(card.detail, /300 pages crawled/);
    // A card with nothing to score is left alone.
    const notRun = { status: 'not_run', runId: null };
    assert.equal(overview.healthPendingCard(notRun), notRun);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
