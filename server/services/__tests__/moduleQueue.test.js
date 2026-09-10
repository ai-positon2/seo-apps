// ── The module run queue, against a real Postgres ───────────────────────────
//
// These tests pin claim/heartbeat/reap semantics, and every one of them is a
// statement about what the DATABASE does: that two claimers produce one winner,
// that `heartbeat_at < x` is NULL (not false) for a NULL column, that a guarded
// UPDATE matches nothing once the row has moved on. A hand-written fake can
// only restate the assumption being tested, so this runs the real SQL.
//
// It needs DATABASE_URL. Without one it skips rather than fails, so `npm test`
// still passes on a checkout with no database configured.
//
// Everything is created under one throwaway project and deleted afterwards, so
// the suite never reads or writes another project's rows.

const assert = require('assert');
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const db = require('../db');
const queue = require('../moduleQueue');

const MODULE_KEY = 'ai_visibility';   // must satisfy project_module_runs_module_check

let passed = 0, failed = 0;
let projectId = null;
let ownerId = null;

async function test(name, fn) {
  // Each test starts from an empty queue for this project.
  await db.query(`delete from project_module_runs where project_id = $1`, [projectId]);
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

// Insert a queued row directly, so a test can set fields (a stale heartbeat, a
// future schedule) that enqueue() would never produce.
async function insertRun(over = {}) {
  const row = {
    project_id: projectId,
    module_key: MODULE_KEY,
    status: 'queued',
    attempts: 0,
    scheduled_for: null,
    heartbeat_at: null,
    worker_id: null,
    started_at: new Date('2026-08-01T00:00:00Z').toISOString(),
    created_at: new Date('2026-08-01T00:00:00Z').toISOString(),
    ...over,
  };
  return db.insertOne('project_module_runs', row);
}

const readRun = (id) => db.one(`select * from project_module_runs where id = $1`, [id]);

async function setup() {
  ownerId = (await db.one(
    `insert into app_users (email) values ($1) returning id`,
    [`_queuetest_${Date.now()}@position2.com`]
  )).id;
  projectId = (await db.one(
    `insert into crawl_projects (owner, url, cron, name) values ($1, $2, $3, $4) returning id`,
    [ownerId, 'https://queue-selftest.invalid', '0 3 * * *', 'moduleQueue self-test']
  )).id;
}

async function teardown() {
  if (projectId) await db.query(`delete from crawl_projects where id = $1`, [projectId]);
  if (ownerId) await db.query(`delete from app_users where id = $1`, [ownerId]);
  await db.end();
}

(async () => {
  if (!db.isDatabaseConfigured()) {
    console.log('moduleQueue: SKIPPED — set DATABASE_URL to run the queue tests against Postgres.');
    return;
  }

  await setup();
  try {
    section('enqueue');

    await test('work lands as queued with zero attempts', async () => {
      const run = await queue.enqueue({ projectId, moduleKey: MODULE_KEY });
      assert.strictEqual(run.status, 'queued');
      assert.strictEqual(run.attempts, 0);
    });

    section('claimNext — the atomic claim');

    await test('a claim flips the row to running and stamps a heartbeat', async () => {
      const seeded = await insertRun();
      const run = await queue.claimNext({ workerId: 'w1' });
      assert.strictEqual(run.id, seeded.id);
      const after = await readRun(seeded.id);
      assert.strictEqual(after.status, 'running');
      assert.strictEqual(after.worker_id, 'w1');
      assert.ok(after.heartbeat_at, 'a run with no heartbeat is invisible to the reaper');
      assert.strictEqual(after.attempts, 1);
    });

    await test('a second worker racing the same row gets nothing, not a duplicate', async () => {
      await insertRun();
      const first = await queue.claimNext({ workerId: 'w1' });
      const second = await queue.claimNext({ workerId: 'w2' });
      assert.ok(first);
      assert.strictEqual(second, null,
        'two workers on one job would run the captures twice and bill the client twice');
    });

    await test('two SIMULTANEOUS claimers still produce exactly one winner', async () => {
      // The sequential case above cannot catch a lost update; this one runs both
      // claims concurrently against one queued row, which is the actual race.
      await insertRun();
      const [a, b] = await Promise.all([
        queue.claimNext({ workerId: 'wA' }),
        queue.claimNext({ workerId: 'wB' }),
      ]);
      const winners = [a, b].filter(Boolean);
      assert.strictEqual(winners.length, 1, 'exactly one claimer may win the row');
      assert.strictEqual(winners[0].attempts, 1, 'attempts must be incremented once, not twice');
    });

    await test('a run scheduled for the future is not claimed yet', async () => {
      await insertRun({ scheduled_for: new Date(Date.now() + 3600_000).toISOString() });
      assert.strictEqual(await queue.claimNext({ workerId: 'w1' }), null);
    });

    await test('a run with no scheduled_for is claimable immediately', async () => {
      await insertRun({ scheduled_for: null });
      assert.ok(await queue.claimNext({ workerId: 'w1' }),
        'a bare `scheduled_for <= now` is NULL for these rows and would never match');
    });

    await test('moduleKeys restricts what a worker will pick up', async () => {
      await insertRun({ module_key: 'hub_spoke' });
      assert.strictEqual(await queue.claimNext({ workerId: 'w1', moduleKeys: [MODULE_KEY] }), null);
    });

    await test('the oldest eligible run is claimed first', async () => {
      const older = await insertRun({ created_at: new Date('2026-07-01T00:00:00Z').toISOString() });
      await insertRun({ created_at: new Date('2026-08-01T00:00:00Z').toISOString() });
      const run = await queue.claimNext({ workerId: 'w1' });
      assert.strictEqual(run.id, older.id);
    });

    section('heartbeat');

    await test('a worker that no longer owns the row cannot resurrect its claim', async () => {
      const seeded = await insertRun({
        status: 'running', worker_id: 'w2', heartbeat_at: new Date().toISOString(),
      });
      assert.strictEqual(await queue.heartbeat(seeded.id, 'w1'), false);
      assert.strictEqual(await queue.heartbeat(seeded.id, 'w2'), true);
    });

    await test('a heartbeat on a queued row is refused', async () => {
      const seeded = await insertRun({ status: 'queued', worker_id: 'w1' });
      assert.strictEqual(await queue.heartbeat(seeded.id, 'w1'), false);
    });

    section('findStale — the NULL heartbeat arm');

    await test('a QUEUE-owned running row with a NULL heartbeat is found, not skipped', async () => {
      const old = new Date(Date.now() - 3600_000).toISOString();
      await insertRun({ status: 'running', worker_id: 'w1', heartbeat_at: null, started_at: old });
      const stale = await queue.findStale();
      assert.strictEqual(stale.length, 1,
        '`heartbeat_at < x` is NULL for a NULL column, so this row would be invisible for ever');
    });

    await test('an INLINE running row is left to moduleEvidence, not reclaimed by the queue', async () => {
      // worker_id null is the signature of a run opened by
      // moduleEvidence.startRun() and executed in the request process, rather than
      // claimed by a worker (claimNext always stamps worker_id AND heartbeat_at).
      //
      // These were being reclaimed at the flat 10-minute STALE_AFTER_MS even though
      // each records its own deadline: a healthy 10-page SEO & GEO audit runs ~22
      // minutes, so "Run Full Audit" was flipped back to 'queued' mid-flight and
      // then re-run by the worker. They belong to moduleEvidence.sweepStaleRuns(),
      // which judges each row against its own payload.deadlineAt.
      const old = new Date(Date.now() - 3600_000).toISOString();
      await insertRun({ status: 'running', worker_id: null, heartbeat_at: null, started_at: old });
      assert.strictEqual((await queue.findStale()).length, 0,
        'an inline run must not be reclaimed by the queue reaper, however long it has been running');
    });

    await test('a running row with a recent heartbeat is left alone', async () => {
      await insertRun({ status: 'running', worker_id: 'w1', heartbeat_at: new Date().toISOString() });
      assert.strictEqual((await queue.findStale()).length, 0);
    });

    section('reclaim — bounded retries');

    await test('a dead run under the attempt limit goes back on the queue, cleaned', async () => {
      const stale = new Date(Date.now() - 3600_000).toISOString();
      const seeded = await insertRun({
        status: 'running', attempts: 1, worker_id: 'w1',
        heartbeat_at: stale, started_at: stale, error: 'old', finished_at: stale,
      });
      assert.strictEqual(await queue.reclaim(seeded), 'requeued');
      const after = await readRun(seeded.id);
      assert.strictEqual(after.status, 'queued');
      assert.strictEqual(after.error, null, "a queued run must not carry the dead attempt's error");
      assert.strictEqual(after.finished_at, null);
      // NOT nulled: `started_at` is NOT NULL in 0012, so clearing it makes every
      // requeue fail on the constraint — the reaper could then never recover a
      // dead run. The next claim overwrites it.
      //
      // Compared as instants, not strings: timestamps come back in the same
      // "+00:00" spelling PostgREST used, which is the same moment as the "Z"
      // form written above but not the same text.
      assert.strictEqual(new Date(after.started_at).getTime(), new Date(stale).getTime(),
        'stale until the next claim, by design');
    });

    await test('a run that has burned its attempts is failed, not requeued for ever', async () => {
      const stale = new Date(Date.now() - 3600_000).toISOString();
      const seeded = await insertRun({
        status: 'running', attempts: queue.MAX_ATTEMPTS, worker_id: 'w1', heartbeat_at: stale,
      });
      assert.strictEqual(await queue.reclaim(seeded), 'failed');
      const after = await readRun(seeded.id);
      assert.strictEqual(after.status, 'failed');
      assert.match(after.error, /stopped responding/,
        'poison work must not be able to occupy a worker permanently');
    });

    await test('a second reaper acting on the same row it already reclaimed is a no-op', async () => {
      const stale = new Date(Date.now() - 3600_000).toISOString();
      const seeded = await insertRun({
        status: 'running', attempts: 1, worker_id: 'w1', heartbeat_at: stale,
      });
      assert.strictEqual(await queue.reclaim(seeded), 'requeued');
      // The row is queued now, so the guard on status='running' no longer matches.
      assert.strictEqual(await queue.reclaim(seeded), 'skipped');
    });

    await test('reclaim is guarded on the heartbeat it observed', async () => {
      // A revived worker stamps a new heartbeat; the reaper acting on the old
      // one it read must then match nothing rather than reclaiming live work.
      const stale = new Date(Date.now() - 3600_000).toISOString();
      const seeded = await insertRun({
        status: 'running', attempts: 1, worker_id: 'w1', heartbeat_at: stale,
      });
      await db.query(`update project_module_runs set heartbeat_at = $1 where id = $2`,
        [new Date().toISOString(), seeded.id]);
      assert.strictEqual(await queue.reclaim(seeded), 'skipped',
        'the row moved on after it was read, so it must not be reclaimed');
    });

    await test('a NULL-heartbeat row is reclaimable — the guard handles NULL', async () => {
      const old = new Date(Date.now() - 3600_000).toISOString();
      const seeded = await insertRun({
        status: 'running', attempts: 1, worker_id: 'w1', heartbeat_at: null, started_at: old,
      });
      assert.strictEqual(await queue.reclaim(seeded), 'requeued',
        '`heartbeat_at = NULL` never matches, so this needs `is not distinct from`');
    });

    section('reap + depth');

    await test('reap requeues what findStale found', async () => {
      const old = new Date(Date.now() - 3600_000).toISOString();
      await insertRun({ status: 'running', attempts: 1, worker_id: 'w1', heartbeat_at: old });
      const result = await queue.reap();
      assert.strictEqual(result.found, 1);
      assert.strictEqual(result.requeued, 1);
    });

    await test('depth counts queued and running in one pass', async () => {
      await insertRun({ status: 'queued' });
      await insertRun({ status: 'queued' });
      await insertRun({ status: 'running', worker_id: 'w1', heartbeat_at: new Date().toISOString() });
      const d = await queue.depth({ moduleKey: MODULE_KEY });
      assert.strictEqual(d.queued, 2);
      assert.strictEqual(d.running, 1);
      assert.strictEqual(typeof d.queued, 'number', 'a count must not come back as a string');
    });

    section('missing schema');

    await test('a missing column or table reads as "migration not applied"', () => {
      assert.strictEqual(queue.isMissingSchema({ code: '42703' }), true);
      assert.strictEqual(queue.isMissingSchema({ code: '42P01' }), true);
      assert.strictEqual(queue.isMissingSchema({ message: 'column "x" does not exist' }), true);
      assert.strictEqual(queue.isMissingSchema({ code: '23505', message: 'duplicate key' }), false);
    });
  } finally {
    await teardown();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error('SUITE ERROR:', e.message, '\n', e.stack); process.exit(1); });
