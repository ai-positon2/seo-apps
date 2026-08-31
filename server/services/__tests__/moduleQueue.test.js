// ── moduleQueue ───────────────────────────────────────────────────────────
//
// The queue's job is to never lose work and never run the same work twice. The
// three properties that guarantee that are asserted here directly:
//
//   • the claim is a compare-and-swap, so a race produces one winner
//   • the reaper finds a run whose heartbeat is NULL, not just a stale one
//   • attempts are bounded, so poison work fails instead of cycling for ever
//
// Supabase is stubbed with a tiny in-memory table that models the one behaviour
// that matters — a conditional UPDATE matches only if the condition still holds.
//
// Run: node services/__tests__/moduleQueue.test.js

const assert = require('assert');
const path = require('path');

// ── A minimal PostgREST-shaped fake ────────────────────────────────────────
const db = { rows: [] };

function makeQuery(table) {
  const state = { filters: [], patch: null, op: 'select', limit: null, order: [] };

  const matches = (row) => state.filters.every((f) => {
    if (f.kind === 'eq') return row[f.col] === f.val;
    if (f.kind === 'is') return row[f.col] === null || row[f.col] === undefined;
    if (f.kind === 'not_is') return row[f.col] !== null && row[f.col] !== undefined;
    if (f.kind === 'lt') return row[f.col] !== null && row[f.col] < f.val;
    if (f.kind === 'lte') return row[f.col] !== null && row[f.col] <= f.val;
    if (f.kind === 'gte') return row[f.col] !== null && row[f.col] >= f.val;
    if (f.kind === 'in') return f.val.includes(row[f.col]);
    if (f.kind === 'or') return f.test(row);
    return true;
  });

  const api = {
    select() { return api; },
    eq(col, val) { state.filters.push({ kind: 'eq', col, val }); return api; },
    is(col) { state.filters.push({ kind: 'is', col }); return api; },
    not(col, _op) { state.filters.push({ kind: 'not_is', col }); return api; },
    lt(col, val) { state.filters.push({ kind: 'lt', col, val }); return api; },
    lte(col, val) { state.filters.push({ kind: 'lte', col, val }); return api; },
    gte(col, val) { state.filters.push({ kind: 'gte', col, val }); return api; },
    in(col, val) { state.filters.push({ kind: 'in', col, val }); return api; },
    or(expr) {
      // Only the one form the claimer uses.
      const iso = expr.split('scheduled_for.lte.')[1];
      state.filters.push({
        kind: 'or',
        test: (row) => row.scheduled_for === null || row.scheduled_for === undefined || row.scheduled_for <= iso,
      });
      return api;
    },
    order() { return api; },
    limit(n) { state.limit = n; return api; },
    update(patch) { state.op = 'update'; state.patch = patch; return api; },
    insert(row) { state.op = 'insert'; state.patch = row; return api; },
    maybeSingle() { return api.then((r) => r); },
    then(resolve) {
      if (state.op === 'insert') {
        const row = { id: `run-${db.rows.length + 1}`, ...state.patch };
        db.rows.push(row);
        return Promise.resolve(resolve({ data: row, error: null }));
      }
      let hit = db.rows.filter(matches);
      if (state.op === 'update') {
        // The CAS: only rows still matching the filters are written.
        hit.forEach((row) => Object.assign(row, state.patch));
        const single = hit[0] || null;
        return Promise.resolve(resolve({ data: single, error: null, count: hit.length }));
      }
      if (state.limit) hit = hit.slice(0, state.limit);
      return Promise.resolve(resolve({ data: hit, error: null, count: hit.length }));
    },
  };
  api.table = table;
  return api;
}

const supabasePath = require.resolve('../supabase.js');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  paths: [],
  exports: {
    isSupabaseConfigured: () => true,
    getSupabase: () => ({ from: (t) => makeQuery(t) }),
  },
};

const queue = require('../moduleQueue');

let passed = 0, failed = 0;
async function test(name, fn) {
  db.rows = [];
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const queued = (over = {}) => ({
  id: 'r1',
  project_id: 'p1',
  module_key: 'ai_visibility',
  status: 'queued',
  attempts: 0,
  scheduled_for: null,
  heartbeat_at: null,
  worker_id: null,
  created_at: '2026-08-01T00:00:00Z',
  ...over,
});

(async () => {
  section('enqueue');

  await test('work lands as queued with zero attempts', async () => {
    const run = await queue.enqueue({ projectId: 'p1', moduleKey: 'ai_visibility' });
    assert.strictEqual(run.status, 'queued');
    assert.strictEqual(run.attempts, 0);
  });

  section('claimNext — the compare-and-swap');

  await test('a claim flips the row to running and stamps a heartbeat', async () => {
    db.rows = [queued()];
    const run = await queue.claimNext({ workerId: 'w1' });
    assert.strictEqual(run.id, 'r1');
    assert.strictEqual(db.rows[0].status, 'running');
    assert.strictEqual(db.rows[0].worker_id, 'w1');
    assert.ok(db.rows[0].heartbeat_at, 'a run with no heartbeat is invisible to the reaper');
    assert.strictEqual(db.rows[0].attempts, 1);
  });

  await test('a second worker racing the same row gets nothing, not a duplicate', async () => {
    db.rows = [queued()];
    const first = await queue.claimNext({ workerId: 'w1' });
    const second = await queue.claimNext({ workerId: 'w2' });
    assert.ok(first);
    assert.strictEqual(second, null,
      'two workers on one job would run the captures twice and bill the client twice');
  });

  await test('a run scheduled for the future is not claimed yet', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    db.rows = [queued({ scheduled_for: future })];
    assert.strictEqual(await queue.claimNext({ workerId: 'w1' }), null);
  });

  await test('a run with no scheduled_for is claimable immediately', async () => {
    db.rows = [queued({ scheduled_for: null })];
    assert.ok(await queue.claimNext({ workerId: 'w1' }), 'a plain lte would never match NULL');
  });

  await test('moduleKeys restricts what a worker will pick up', async () => {
    db.rows = [queued({ module_key: 'hub_spoke' })];
    assert.strictEqual(await queue.claimNext({ workerId: 'w1', moduleKeys: ['ai_visibility'] }), null);
  });

  section('heartbeat');

  await test('a worker that no longer owns the row cannot resurrect its claim', async () => {
    db.rows = [queued({ status: 'running', worker_id: 'w2', heartbeat_at: 'x' })];
    assert.strictEqual(await queue.heartbeat('r1', 'w1'), false);
    assert.strictEqual(await queue.heartbeat('r1', 'w2'), true);
  });

  section('findStale — the NULL heartbeat arm');

  await test('a running row with a NULL heartbeat is found, not skipped', async () => {
    const old = new Date(Date.now() - 3600_000).toISOString();
    db.rows = [queued({ status: 'running', heartbeat_at: null, started_at: old })];
    const stale = await queue.findStale();
    assert.strictEqual(stale.length, 1,
      '`heartbeat_at < x` is NULL for a NULL column, so this row would be invisible for ever');
  });

  await test('a running row with a recent heartbeat is left alone', async () => {
    db.rows = [queued({ status: 'running', heartbeat_at: new Date().toISOString() })];
    assert.strictEqual((await queue.findStale()).length, 0);
  });

  section('reclaim — bounded retries');

  await test('a dead run under the attempt limit goes back on the queue, cleaned', async () => {
    const run = queued({
      status: 'running', attempts: 1, heartbeat_at: 'stale', started_at: 'x', error: 'old',
    });
    db.rows = [run];
    assert.strictEqual(await queue.reclaim(run), 'requeued');
    assert.strictEqual(db.rows[0].status, 'queued');
    assert.strictEqual(db.rows[0].error, null, 'a queued run must not carry the dead attempt\'s error');
    assert.strictEqual(db.rows[0].finished_at, null);
    // NOT nulled: `started_at` is NOT NULL in 0012, so clearing it makes every
    // requeue fail on the constraint — the reaper could then never recover a
    // dead run. The next claim overwrites it.
    assert.strictEqual(db.rows[0].started_at, 'x', 'stale until the next claim, by design');
  });

  await test('a run that has burned its attempts is failed, not requeued for ever', async () => {
    const run = queued({ status: 'running', attempts: queue.MAX_ATTEMPTS, heartbeat_at: 'stale' });
    db.rows = [run];
    assert.strictEqual(await queue.reclaim(run), 'failed');
    assert.strictEqual(db.rows[0].status, 'failed');
    assert.match(db.rows[0].error, /stopped responding/,
      'poison work must not be able to occupy a worker permanently');
  });

  await test('a second reaper acting on the same row it already reclaimed is a no-op', async () => {
    const run = queued({ status: 'running', attempts: 1, heartbeat_at: 'stale' });
    db.rows = [run];
    assert.strictEqual(await queue.reclaim(run), 'requeued');
    // The row is queued now, so the guard on status='running' no longer matches.
    assert.strictEqual(await queue.reclaim(run), 'skipped');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
