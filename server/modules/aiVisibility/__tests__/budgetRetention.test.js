// ── budget + retention ────────────────────────────────────────────────────
//
// Two policies whose failure modes are opposite and both quiet:
//
//   A budget that checks AFTER a capture has already spent the money it was
//   meant to prevent.
//
//   A retention sweep that DELETES rows rather than clearing a column would
//   rewrite the history every past metric was computed from — §11 requires
//   every number shown to a client to stay reproducible from stored captures.
//
// Run: node modules/aiVisibility/__tests__/budgetRetention.test.js

const assert = require('assert');

// Stub Supabase before either module is required.
const supabasePath = require.resolve('../../../services/supabase.js');
const state = { captures: [], schedule: null, updates: [] };

function query(table) {
  const filters = [];
  const api = {
    select() { return api; },
    eq(col, val) { filters.push([col, val]); return api; },
    gte() { return api; },
    lt() { return api; },
    not() { return api; },
    is() { return api; },
    in(col, vals) { filters.push(['__in', vals]); return api; },
    order() { return api; },
    // Paging support. spentThisMonth reads in pages ordered on a unique key,
    // so a fake that ignored .range() would return the full set on every
    // iteration and the loop would never see a short page.
    range(from, to) { api._range = [from, to]; return api; },
    limit(n) { api._limit = n; return api; },
    update(patch) { api._patch = patch; return api; },
    maybeSingle() { return api.then((r) => r); },
    then(resolve) {
      if (table === 'project_module_schedules') {
        return Promise.resolve(resolve({ data: state.schedule, error: null }));
      }
      if (api._patch) {
        const ids = (filters.find((f) => f[0] === '__in') || [])[1] || [];
        state.updates.push({ ids, patch: api._patch });
        state.captures.forEach((c) => { if (ids.includes(c.id)) Object.assign(c, api._patch); });
        return Promise.resolve(resolve({ data: null, error: null }));
      }
      let rows = state.captures;
      if (api._range) rows = rows.slice(api._range[0], api._range[1] + 1);
      if (api._limit) rows = rows.slice(0, api._limit);
      return Promise.resolve(resolve({ data: rows, error: null, count: rows.length }));
    },
  };
  return api;
}

require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  paths: [],
  exports: {
    isSupabaseConfigured: () => true,
    getSupabase: () => ({ from: query }),
  },
};

const budget = require('../budget');
const retention = require('../retention');

let passed = 0, failed = 0;
async function test(name, fn) {
  state.captures = []; state.schedule = null; state.updates = [];
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

(async () => {
  section('budget — a ceiling that is not configured is not a ceiling of zero');

  await test('no schedule row means no ceiling, and the run proceeds', async () => {
    state.schedule = null;
    const guard = await budget.createGuard('p1');
    assert.strictEqual(await guard(), null,
      'treating a missing value as zero would stop every run on an unconfigured project');
  });

  await test('a configured ceiling is read as a number', async () => {
    state.schedule = { monthly_budget_usd: '2.5000' };
    assert.strictEqual(await budget.ceilingFor('p1'), 2.5);
  });

  section('budget — the check happens BEFORE the spend');

  await test('the guard stops on the capture that WOULD cross the line', async () => {
    state.schedule = { monthly_budget_usd: 0.05 };
    state.captures = [];                       // nothing spent yet this month
    const guard = await budget.createGuard('p1', { estimatePerCapture: 0.02 });

    assert.strictEqual(await guard(), null);   // 0.02 projected — fine
    guard.record(0.02);
    assert.strictEqual(await guard(), null);   // 0.04 projected — fine
    guard.record(0.02);
    const reason = await guard();              // 0.06 projected — over
    assert.ok(reason, 'stopping only once already over means the crossing capture was paid for');
    assert.match(reason, /Monthly budget of \$0\.05/);
    assert.match(reason, /were not measured/, 'the truncation has to be stated, not hidden');
  });

  await test('spend already booked this month counts against the ceiling', async () => {
    state.schedule = { monthly_budget_usd: 0.05 };
    state.captures = [{ task_cost: 0.049 }];
    const guard = await budget.createGuard('p1', { estimatePerCapture: 0.02 });
    assert.ok(await guard(), 'a fresh run must not get a fresh allowance');
  });

  await test('failed captures still count — a provider charged for them', async () => {
    state.captures = [{ task_cost: 0.01 }, { task_cost: 0.02 }];
    assert.ok(Math.abs(await budget.spentThisMonth('p1') - 0.03) < 1e-9);
  });

  section('retention — clears the payload, never the row');

  await test('a sweep NULLS raw and keeps the capture', async () => {
    state.captures = [
      { id: 'c1', captured_at: '2024-01-01T00:00:00Z', raw: { big: 'payload' } },
      { id: 'c2', captured_at: '2024-01-02T00:00:00Z', raw: { big: 'payload' } },
    ];
    const result = await retention.sweep({ months: 12 });
    assert.strictEqual(result.cleared, 2);
    assert.strictEqual(state.captures.length, 2,
      'deleting the row would rewrite the history every past metric was computed from');
    assert.strictEqual(state.captures[0].raw, null);
    assert.deepStrictEqual(state.updates[0].patch, { raw: null });
  });

  await test('a dry run changes nothing', async () => {
    state.captures = [{ id: 'c1', captured_at: '2024-01-01T00:00:00Z', raw: { x: 1 } }];
    const result = await retention.sweep({ months: 12, dryRun: true });
    assert.strictEqual(result.found, 1);
    assert.strictEqual(result.cleared, 0);
    assert.strictEqual(state.updates.length, 0);
    assert.ok(state.captures[0].raw, 'a dry run that wrote would not be a dry run');
  });

  await test('the sweep is batched, so a year of backlog is not one giant update', async () => {
    state.captures = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`, captured_at: '2024-01-01T00:00:00Z', raw: { x: 1 },
    }));
    const result = await retention.sweep({ months: 12, batch: 10 });
    assert.strictEqual(result.found, 10, 'an unbounded UPDATE holds locks far too long');
    assert.strictEqual(result.cleared, 10);
  });

  await test('the cutoff is 12 months back by default', () => {
    const cutoff = new Date(retention.cutoffIso(12, new Date('2026-08-29T00:00:00Z')));
    assert.strictEqual(cutoff.toISOString().slice(0, 7), '2025-08');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
