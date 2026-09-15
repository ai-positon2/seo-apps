// ── AI Visibility budget guard + retention sweeper, against a real Postgres ──
//
// Both of these are statements about what the DATABASE does: that a SUM over
// captures reports the true monthly spend however many rows there are, and that
// a bounded UPDATE clears `raw` on exactly the batch it selected while leaving
// the rows in place. A hand-written fake could only restate the assumption, so
// this runs the real SQL.
//
// Needs TEST_DATABASE_URL — a throwaway database, NOT the app's, for the same
// reason as the queue suite: these write capture rows and sweep them, and a live
// worker on the same database is doing its own writes underneath. Without it the
// suite skips, so `npm test` still passes on a fresh checkout.
//
// Everything is created under one throwaway project and deleted afterwards.

const assert = require('assert');
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });

const { useTestDatabase } = require('../../../services/__tests__/helpers/testDatabase');
const { createProjectFixture, dropProjectFixture } = require('../../../services/__tests__/helpers/projectFixture');

const db = require('../../../services/db');
const budget = require('../budget');
const retention = require('../retention');

let passed = 0, failed = 0;
let projectId = null;
let ownerId = null;
let runId = null;

async function test(name, fn) {
  await db.query(`delete from ai_visibility_captures where project_id = $1`, [projectId]);
  await db.query(`delete from project_module_schedules where project_id = $1`, [projectId]);
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

// A capture carries a lot of NOT NULL metadata that none of these tests care
// about; only task_cost, captured_at and raw are ever asserted on.
async function addCapture({ taskCost = null, capturedAt = new Date().toISOString(), raw = null } = {}) {
  return db.one(
    `insert into ai_visibility_captures
       (run_id, project_id, prompt_text, engine, provider, surface_label, status,
        task_cost, captured_at, raw)
     values ($1, $2, 'selftest prompt', 'chatgpt', 'scraped', 'ChatGPT', 'captured',
             $3, $4, $5)
     returning id`,
    [runId, projectId, taskCost, capturedAt, db.json(raw)]
  );
}

const setCeiling = (usd) => db.query(
  `insert into project_module_schedules (project_id, module_key, monthly_budget_usd)
     values ($1, 'ai_visibility', $2)
   on conflict (project_id, module_key) do update set monthly_budget_usd = excluded.monthly_budget_usd`,
  [projectId, usd]
);

// A project is a workspace + membership + row + active primary domain, and
// since migration 0027 the database rejects anything less at COMMIT. The helper
// builds the whole aggregate so a fixture that is missing a domain cannot look
// like a budget or retention bug.
let fixture = null;

async function setup() {
  fixture = await createProjectFixture({
    prefix: 'aivtest',
    url: 'https://aiv-selftest.invalid',
    name: 'aiVisibility self-test',
  });
  ownerId = fixture.userId;
  projectId = fixture.projectId;
  runId = (await db.one(
    `insert into project_module_runs (project_id, module_key, status)
       values ($1, 'ai_visibility', 'completed') returning id`,
    [projectId]
  )).id;
}

async function teardown() {
  await dropProjectFixture(fixture);
  await db.end();
}

(async () => {
  if (!useTestDatabase('aiVisibility budget/retention')) return;

  await setup();
  try {
    section('budget — a ceiling that is not configured is not a ceiling of zero');

    await test('no schedule row means no ceiling, and the run proceeds', async () => {
      const guard = await budget.createGuard(projectId);
      assert.strictEqual(await guard(), null,
        'treating a missing value as zero would stop every run on an unconfigured project');
    });

    await test('a configured ceiling is read as a number', async () => {
      await setCeiling('2.5000');
      const ceiling = await budget.ceilingFor(projectId);
      assert.strictEqual(ceiling, 2.5);
      assert.strictEqual(typeof ceiling, 'number',
        'numeric must not arrive as a string, or every comparison against it is a string compare');
    });

    section('budget — the check happens BEFORE the spend');

    await test('the guard stops on the capture that WOULD cross the line', async () => {
      await setCeiling(0.05);                    // nothing spent yet this month
      const guard = await budget.createGuard(projectId, { estimatePerCapture: 0.02 });

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
      await setCeiling(0.05);
      await addCapture({ taskCost: 0.049 });
      const guard = await budget.createGuard(projectId, { estimatePerCapture: 0.02 });
      assert.ok(await guard(), 'a fresh run must not get a fresh allowance');
    });

    await test('failed captures still count — a provider charged for them', async () => {
      await addCapture({ taskCost: 0.01 });
      await addCapture({ taskCost: 0.02 });
      const spent = await budget.spentThisMonth(projectId);
      assert.ok(Math.abs(spent - 0.03) < 1e-9, `expected 0.03, got ${spent}`);
    });

    await test('spend from BEFORE this month is not charged to it', async () => {
      await addCapture({ taskCost: 5, capturedAt: '2020-01-01T00:00:00Z' });
      assert.strictEqual(await budget.spentThisMonth(projectId), 0);
    });

    await test('the sum covers every row, not just the first page', async () => {
      // The old implementation paged this by hand because PostgREST truncated a
      // large select at its max-rows ceiling and the total came back short — a
      // budget guard that under-reports spend reads as safety. Summing in SQL
      // has no such ceiling; 1,200 rows is past where the old page size sat.
      const rows = Array.from({ length: 1200 }, () => `('${runId}','${projectId}','p','chatgpt','scraped','ChatGPT','captured',0.001,now())`);
      await db.query(
        `insert into ai_visibility_captures
           (run_id, project_id, prompt_text, engine, provider, surface_label, status, task_cost, captured_at)
         values ${rows.join(',')}`
      );
      const spent = await budget.spentThisMonth(projectId);
      assert.ok(Math.abs(spent - 1.2) < 1e-9, `expected 1.2 across 1200 rows, got ${spent}`);
    });

    section('retention — clears the payload, never the row');

    await test('a sweep NULLS raw and keeps the capture', async () => {
      await addCapture({ capturedAt: '2024-01-01T00:00:00Z', raw: { big: 'payload' } });
      await addCapture({ capturedAt: '2024-01-02T00:00:00Z', raw: { big: 'payload' } });

      const result = await retention.sweep({ months: 12 });
      assert.strictEqual(result.cleared, 2);

      const kept = await db.count(
        `select count(*) from ai_visibility_captures where project_id = $1`, [projectId]);
      assert.strictEqual(kept, 2,
        'deleting the row would rewrite the history every past metric was computed from');
      const withRaw = await db.count(
        `select count(*) from ai_visibility_captures where project_id = $1 and raw is not null`,
        [projectId]);
      assert.strictEqual(withRaw, 0);
    });

    await test('a dry run changes nothing', async () => {
      await addCapture({ capturedAt: '2024-01-01T00:00:00Z', raw: { x: 1 } });
      const result = await retention.sweep({ months: 12, dryRun: true });
      assert.strictEqual(result.found, 1);
      assert.strictEqual(result.cleared, 0);
      const withRaw = await db.count(
        `select count(*) from ai_visibility_captures where project_id = $1 and raw is not null`,
        [projectId]);
      assert.strictEqual(withRaw, 1, 'a dry run that wrote would not be a dry run');
    });

    await test('a capture inside the retention window is left alone', async () => {
      await addCapture({ capturedAt: new Date().toISOString(), raw: { x: 1 } });
      const result = await retention.sweep({ months: 12 });
      assert.strictEqual(result.cleared, 0);
    });

    await test('the sweep is batched, so a year of backlog is not one giant update', async () => {
      for (let i = 0; i < 50; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await addCapture({ capturedAt: '2024-01-01T00:00:00Z', raw: { x: 1 } });
      }
      const result = await retention.sweep({ months: 12, batch: 10 });
      assert.strictEqual(result.found, 10, 'an unbounded UPDATE holds locks far too long');
      assert.strictEqual(result.cleared, 10);

      const left = await retention.pending({ months: 12 });
      assert.strictEqual(left.pending, 40, 'the rest stay outstanding for the next sweep');
    });

    await test('the cutoff is 12 months back by default', () => {
      const cutoff = new Date(retention.cutoffIso(12, new Date('2026-08-29T00:00:00Z')));
      assert.strictEqual(cutoff.toISOString().slice(0, 7), '2025-08');
    });
  } finally {
    await teardown();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error('SUITE ERROR:', e.message, '\n', e.stack); process.exit(1); });
