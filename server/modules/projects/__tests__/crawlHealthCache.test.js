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
// The on-demand URL statement (computeCostingUrls) and the page count
// (internalCounts), counted apart from the aggregates.
let urlCalls = 0;
let countsCalls = 0;
let countsError = null;

db.maybeOne = async (sql, params) => {
  if (/from crawl_runs r/.test(sql)) return runs.get(params[0]) || null;
  throw new Error(`unexpected maybeOne: ${sql}`);
};
db.boundedRead = async (ms, fn) => {
  return fn({
    maybeOne: async (sql) => {
      if (/scope' = 'Internal'/.test(sql)) {
        countsCalls += 1;
        if (countsError) throw countsError;
        return { internal: 12, max_urls: 10 };
      }
      computeCalls += 1;
      if (computeDelayMs) await new Promise((r) => setTimeout(r, computeDelayMs));
      if (computeError) throw computeError;
      return {
        html_pages: 4,
        error_pages: 1, warning_pages: 3, notice_pages: 1,
        error_loss: 40, warning_loss: 30, notice_loss: 0,
        site_rules: [{ rule: 'robots', severity: 'warning', site_scoped: true, on_scored: false }],
        // Counts only: the URL lists are not built on every load (item 3).
        costing: [
          { rule: 'rule', severity: 'error', pages: 1 },
          { rule: 'thin', severity: 'warning', pages: 2 },
        ],
      };
    },
    rows: async (sql) => {
      assert.match(sql, /array_agg\(distinct i\.url\)/);
      urlCalls += 1;
      return [{ rule: 'rule', severity: 'error', urls: ['https://h.invalid/p0'] }];
    },
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
    assert.deepEqual([...costing.keys()], ['rule', 'thin', 'robots']);
    // Counts without the URL lists: the dashboard's card and the report need
    // only how many pages, so no list was built (item 3).
    assert.equal(costing.get('rule').pageCount, 1);
    assert.equal(costing.get('thin').pageCount, 2);
    assert.equal(costing.get('rule').pages.size, 0);
    assert.equal(costing.get('rule').urlsListed, false);
    assert.equal(urlCalls, 0);
  });

  await test('the URL lists are read on demand, once per finished run, for the fix list', async () => {
    urlCalls = 0;
    const [a, b] = await Promise.all([
      overview.costingRules('r1', { urls: true }),
      overview.costingRules('r1', { urls: true }),
    ]);
    assert.equal(urlCalls, 1);
    assert.equal(a.pending, false);
    assert.deepEqual([...a.byRule.get('rule').pages], ['https://h.invalid/p0']);
    assert.equal(a.byRule.get('rule').urlsListed, true);
    // A rule the fix list cannot call an error has no list, and says so.
    assert.equal(b.byRule.get('thin').urlsListed, false);
    // Site-level rules are on no page: their empty list is complete.
    assert.equal(b.byRule.get('robots').urlsListed, true);
    await overview.costingRules('r1', { urls: true });
    assert.equal(urlCalls, 1);
  });

  await test('a finished, unchanged run is not computed again', async () => {
    computeCalls = 0;
    await overview.healthAffectedPages('r1');
    await overview.internalHtmlPageCount('r1');
    assert.equal(computeCalls, 0);
  });

  await test('callers get their own Sets, so one cannot change another\'s', async () => {
    const a = await overview.costingRulePages('r1', { urls: true });
    a.get('rule').pages.add('x');
    const b = await overview.costingRulePages('r1', { urls: true });
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

  await test('the fix list waits for costing no longer than the card does (item 2)', async () => {
    finishedRun('slowCost');
    computeDelayMs = 80;
    const answer = await overview.costingRules('slowCost', { urls: true, waitMs: 10 });
    assert.deepEqual(answer, { byRule: null, pending: true });
    // costingRulePages keeps its old shape: null, which callers read as unknown.
    assert.equal(await overview.costingRulePages('slowCost', { waitMs: 10 }), null);
    await new Promise((r) => setTimeout(r, 120));
    computeDelayMs = 0;
    const later = await overview.costingRules('slowCost', { urls: true, waitMs: 10 });
    assert.equal(later.pending, false);
    assert.ok(later.byRule.has('rule'));
  });

  await test('a costing statement that ran out of time reads as pending, not as an error', async () => {
    finishedRun('hugeCost');
    computeError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    assert.deepEqual(await overview.costingRules('hugeCost'), { byRule: null, pending: true });
    computeError = null;
    finishedRun('brokenCost');
    computeError = new Error('relation does not exist');
    assert.deepEqual(await overview.costingRules('brokenCost'), { byRule: null, pending: false });
    computeError = null;
  });

  await test('the internal page count is a bounded read and degrades to null on timeout', async () => {
    countsCalls = 0;
    assert.deepEqual(await overview.internalCounts('r1'), { internal: 12, pages: 10, probes: 2 });
    countsError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    assert.equal(await overview.internalCounts('r1'), null);
    assert.equal(await overview.internalPageCount('r1'), null);
    countsError = null;
    assert.equal(countsCalls, 3);
  });

  await test('the pending card tells the reader to come back when the server will have retried', async () => {
    const card = overview.healthPendingCard({ key: 'technical', status: 'completed', runId: 'r1', detail: '' });
    assert.match(card.detail, /Reload in 2 minutes/);
    assert.doesNotMatch(card.detail, /in a minute/);
  });

  await test('concurrent /overview requests share one build; a settled one is not reused', async () => {
    const configured = db.isDatabaseConfigured;
    db.isDatabaseConfigured = () => false;   // the build fails fast, with one error object per build
    const access = { project: { id: 'join-test' }, role: 'owner', capabilities: {} };
    const errors = await Promise.all([
      overview.buildOverview({ access }).catch((e) => e),
      overview.buildOverview({ access }).catch((e) => e),
    ]);
    assert.equal(errors[0], errors[1]);
    const after = await overview.buildOverview({ access }).catch((e) => e);
    assert.notEqual(after, errors[0]);
    db.isDatabaseConfigured = configured;
  });

  await test('a build started before a change to the project is never joined or reused', async () => {
    const configured = db.isDatabaseConfigured;
    let calls = 0;
    // Each build fails with its own error object, so which build a caller got is visible.
    db.isDatabaseConfigured = () => { calls += 1; return false; };
    const access = { project: { id: 'changed-test' }, role: 'owner', capabilities: {} };
    const before = overview.buildOverview({ access }).catch((e) => e);
    overview.markProjectChanged('changed-test');   // e.g. a module run was started
    const fresh = overview.buildOverview({ access }).catch((e) => e);
    const reader = overview.buildOverview({ access, reuse: true }).catch((e) => e);
    const [a, b, c] = await Promise.all([before, fresh, reader]);
    assert.notEqual(a, b);
    // A reader after the change gets the post-change build, not the stale one.
    assert.equal(b, c);
    assert.equal(calls, 2);
    db.isDatabaseConfigured = configured;
  });

  await test('fix list: costing is not pending once the aggregates are ready, even when the URL lists are slow', async () => {
    finishedRun('slowUrls');
    await overview.crawlHealthAggregates('slowUrls');   // the card has its score
    const realRows = db.boundedRead;
    let urlRuns = 0;
    db.boundedRead = async (ms, fn) => fn({
      rows: async () => { urlRuns += 1; await new Promise((r) => setTimeout(r, 80)); return [{ rule: 'rule', severity: 'error', urls: ['https://h.invalid/p0'] }]; },
    });
    const answer = await overview.costingRules('slowUrls', { urls: true, waitMs: 10 });
    assert.equal(answer.pending, false);
    assert.equal(answer.urlsPending, true);
    assert.equal(answer.byRule.get('rule').pageCount, 1);
    assert.equal(answer.byRule.get('rule').urlsListed, false);
    await new Promise((r) => setTimeout(r, 120));
    const later = await overview.costingRules('slowUrls', { urls: true, waitMs: 10 });
    assert.equal(later.urlsPending, false);
    assert.equal(later.byRule.get('rule').urlsListed, true);
    assert.equal(urlRuns, 1);
    db.boundedRead = realRows;
  });

  await test('a URL-list statement that timed out is backed off, not re-run by every request', async () => {
    finishedRun('hugeUrls');
    await overview.crawlHealthAggregates('hugeUrls');
    const realRows = db.boundedRead;
    let urlRuns = 0;
    db.boundedRead = async (ms, fn) => fn({
      rows: async () => {
        urlRuns += 1;
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      },
    });
    const first = await overview.costingRules('hugeUrls', { urls: true });
    const second = await overview.costingRules('hugeUrls', { urls: true });
    assert.equal(first.pending, false);
    assert.equal(first.urlsPending, true);
    assert.equal(second.urlsPending, true);
    assert.equal(urlRuns, 1);
    db.boundedRead = realRows;
  });

  await test('the report path waits past the dashboard wait (waitMs: null)', async () => {
    finishedRun('reportWait');
    computeDelayMs = 40;
    const costing = await overview.costingRulePages('reportWait', { waitMs: null });
    computeDelayMs = 0;
    assert.ok(costing && costing.has('rule'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
