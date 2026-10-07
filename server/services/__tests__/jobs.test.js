// ── Tests for durable jobs (services/jobs.js + the /api/runs job endpoints) ───
// Real SQL: needs TEST_DATABASE_URL pointing at a database with the migrations
// applied (0042 at least). Skips cleanly without one. NEVER point it at a
// shared database — it inserts users, workspaces and runs.
//
//   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres \
//     node services/__tests__/jobs.test.js

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  console.log('SKIP jobs.test.js — TEST_DATABASE_URL is not set.');
  process.exit(0);
}
// services/db reads DATABASE_URL; point it at the test database before
// anything requires it, so the repo .env can never be used here.
process.env.DATABASE_URL = TEST_DB;
process.env.DATABASE_POOL_MAX = process.env.DATABASE_POOL_MAX || '1';

const USER = crypto.randomUUID();
const OTHER_USER = crypto.randomUUID();
const WS = crypto.randomUUID();
const OTHER_WS = crypto.randomUUID();

// Identity comes from a header so one app can act as either user.
const workspaceContextPath = require.resolve('../workspaceContext');
require.cache[workspaceContextPath] = {
  id: workspaceContextPath, filename: workspaceContextPath, loaded: true,
  exports: {
    async resolveIdentity(req) {
      const userId = req.headers?.['x-test-user'] || USER;
      return { userId, workspaceId: userId === USER ? WS : OTHER_WS, actorEmail: `${userId}@test` };
    },
    peekWorkspaceId: () => null,
    invalidate: () => {},
  },
};
const identityStorePath = require.resolve('../identityStore');
require.cache[identityStorePath] = {
  id: identityStorePath, filename: identityStorePath, loaded: true,
  exports: {
    async listWorkspacesForUser(userId) {
      return userId === USER ? [{ id: WS }] : [{ id: OTHER_WS }];
    },
  },
};

const db = require('../db');
const jobs = require('../jobs');
const { badRequest, sendError } = require('../../utils/api');
const express = require('express');
const runsRouter = require('../../routes/runs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeReq = (userId = USER) => ({ method: 'POST', originalUrl: '/api/test-tool/runs', headers: { 'x-test-user': userId }, user: { userId } });

async function waitForStatus(runId, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const row = await db.maybeOne('select status from tool_runs where id = $1', [runId]);
    if (row && row.status !== 'running') return row.status;
    await sleep(25);
  }
  throw new Error(`run ${runId} still running after ${timeoutMs}ms`);
}
const eventsOf = async (runId) => (await jobs.eventsAfter(runId, 0, 1000)).map((e) => [e.event, e.data]);

// ── HTTP helpers ─────────────────────────────────────────────────────────────

let server;
let base;
function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { userId: req.headers['x-test-user'] || USER }; next(); });
  app.use('/api/runs', runsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => sendError(res, err));
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}
function call(method, path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const ev = { id: null, event: 'message', data: null };
    let has = false;
    for (const line of lines) {
      if (line.startsWith('id: ')) { ev.id = Number(line.slice(4)); has = true; }
      else if (line.startsWith('event: ')) { ev.event = line.slice(7); has = true; }
      else if (line.startsWith('data: ')) { ev.data = JSON.parse(line.slice(6)); has = true; }
    }
    if (has && ev.data !== null) events.push(ev);
  }
  return events;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('a job records its events in order, its result and a terminal status', async () => {
  const run = await jobs.startJob(fakeReq(), {
    toolId: 'test-tool', label: 'https://example.com', input: { url: 'https://example.com' },
    work: async ({ emit, progress }) => {
      emit('step', { id: 'fetch', status: 'active' });
      progress({ done: 1, total: 2 });
      emit('step', { id: 'fetch', status: 'done' });
      return { score: 42 };
    },
  });
  assert.strictEqual(run.status, 'running');
  assert.strictEqual(await waitForStatus(run.id), 'completed');
  assert.deepStrictEqual(await eventsOf(run.id), [
    ['step', { id: 'fetch', status: 'active' }],
    ['progress', { done: 1, total: 2 }],
    ['step', { id: 'fetch', status: 'done' }],
    ['result', { score: 42 }],
    ['status', { status: 'completed' }],
  ]);
  const row = await db.one('select is_job, progress, workspace_id, user_id, tool_id from tool_runs where id = $1', [run.id]);
  assert.strictEqual(row.is_job, true);
  assert.deepStrictEqual(row.progress, { done: 1, total: 2 });
  assert.strictEqual(row.workspace_id, WS);
  assert.deepStrictEqual(await jobs.latestResult(run.id), { score: 42 });
});

test('an ApiError reaches the user; any other failure is generic', async () => {
  const userFacing = await jobs.startJob(fakeReq(), { toolId: 'test-tool', work: async () => { throw badRequest('That page has too little text to enhance.'); } });
  assert.strictEqual(await waitForStatus(userFacing.id), 'failed');
  const ev1 = await eventsOf(userFacing.id);
  assert.deepStrictEqual(ev1.slice(-2), [
    ['error', { error: 'That page has too little text to enhance.', code: 'invalid_request' }],
    ['status', { status: 'failed', code: 'invalid_request', error: 'That page has too little text to enhance.' }],
  ]);

  const internal = await jobs.startJob(fakeReq(), { toolId: 'test-tool', work: async () => { throw new Error('connect ECONNREFUSED 10.0.0.7:5432 password=hunter2'); } });
  assert.strictEqual(await waitForStatus(internal.id), 'failed');
  const ev2 = await eventsOf(internal.id);
  assert.deepStrictEqual(ev2[0], ['error', { error: jobs.GENERIC_FAILURE, code: 'internal' }]);
  assert.ok(!JSON.stringify(ev2).includes('hunter2'));
  const row = await db.one('select error from tool_runs where id = $1', [internal.id]);
  assert.strictEqual(row.error, jobs.GENERIC_FAILURE);
});

test('a tool cannot write the reserved status/error events', async () => {
  const run = await jobs.startJob(fakeReq(), { toolId: 'test-tool', work: async ({ emit }) => { emit('status', { status: 'completed' }); } });
  assert.strictEqual(await waitForStatus(run.id), 'failed');
});

test('cancel ends the run at once and drops later events', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = await jobs.startJob(fakeReq(), {
    toolId: 'test-tool',
    work: async ({ emit, signal }) => {
      emit('step', { id: 'a' });
      await gate;
      emit('step', { id: 'after-cancel' });
      return signal.aborted ? undefined : { done: true };
    },
  });
  await sleep(50);
  assert.strictEqual(await jobs.cancelJob(run.id), 'cancelled');
  assert.strictEqual(await waitForStatus(run.id), 'cancelled');
  release();
  await sleep(50);
  const ev = await eventsOf(run.id);
  assert.deepStrictEqual(ev, [['step', { id: 'a' }], ['status', { status: 'cancelled' }]]);
  assert.strictEqual(await jobs.cancelJob(run.id), 'finished');
});

test('the sweep fails a job whose heartbeat stopped, but not one running here', async () => {
  const orphan = crypto.randomUUID();
  await db.query(
    `insert into tool_runs (id, user_id, workspace_id, tool_id, status, is_job, heartbeat_at, created_at)
     values ($1, $2, $3, 'test-tool', 'running', true, now() - interval '10 minutes', now() - interval '10 minutes')`,
    [orphan, USER, WS],
  );
  let release;
  const gate = new Promise((r) => { release = r; });
  const live = await jobs.startJob(fakeReq(), { toolId: 'test-tool', work: async () => { await gate; return { ok: 1 }; } });
  await db.query(`update tool_runs set heartbeat_at = now() - interval '10 minutes' where id = $1`, [live.id]);

  const swept = await jobs.sweepInterrupted();
  assert.ok(swept >= 1);
  const o = await db.one('select status, error from tool_runs where id = $1', [orphan]);
  assert.strictEqual(o.status, 'failed');
  assert.strictEqual(o.error, jobs.INTERRUPTED);
  assert.deepStrictEqual((await eventsOf(orphan)).map((e) => e[0]), ['error', 'status']);
  assert.strictEqual((await eventsOf(orphan))[1][1].code, 'interrupted');
  assert.strictEqual((await db.one('select status from tool_runs where id = $1', [live.id])).status, 'running');
  release();
  assert.strictEqual(await waitForStatus(live.id), 'completed');
});

test('the old stale-run sweep leaves jobs alone', async () => {
  const runStore = require('../runStore');
  const id = crypto.randomUUID();
  await db.query(
    `insert into tool_runs (id, user_id, workspace_id, tool_id, status, is_job, heartbeat_at, created_at)
     values ($1, $2, $3, 'test-tool', 'running', true, now(), now() - interval '5 hours')`,
    [id, USER, WS],
  );
  await runStore.sweepStaleRuns({ olderThanMinutes: 120 });
  assert.strictEqual((await db.one('select status from tool_runs where id = $1', [id])).status, 'running');
  await db.query(`update tool_runs set status = 'completed' where id = $1`, [id]);
});

test('GET /api/runs/:id/events replays everything, then resumes after Last-Event-ID', async () => {
  const run = await jobs.startJob(fakeReq(), {
    toolId: 'test-tool',
    work: async ({ emit }) => { emit('step', { n: 1 }); emit('step', { n: 2 }); return { ok: true }; },
  });
  await waitForStatus(run.id);

  const all = await call('GET', `/api/runs/${run.id}/events`);
  assert.strictEqual(all.status, 200);
  assert.match(all.headers['content-type'], /text\/event-stream/);
  const events = parseSse(all.body);
  assert.deepStrictEqual(events.map((e) => e.event), ['step', 'step', 'result', 'status']);
  assert.ok(events.every((e) => Number.isFinite(e.id)));

  const resumed = parseSse((await call('GET', `/api/runs/${run.id}/events`, { headers: { 'Last-Event-ID': String(events[1].id) } })).body);
  assert.deepStrictEqual(resumed.map((e) => e.event), ['result', 'status']);
});

test('a live stream delivers events as the job writes them', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = await jobs.startJob(fakeReq(), {
    toolId: 'test-tool',
    work: async ({ emit }) => { emit('step', { n: 1 }); await gate; emit('step', { n: 2 }); return 'done'; },
  });
  const pending = call('GET', `/api/runs/${run.id}/events`);
  await sleep(300);
  release();
  const events = parseSse((await pending).body);
  assert.deepStrictEqual(events.map((e) => [e.event, e.data]), [
    ['step', { n: 1 }], ['step', { n: 2 }], ['result', 'done'], ['status', { status: 'completed' }],
  ]);
  // A plain-text result must still close the row out.
  assert.strictEqual(await waitForStatus(run.id), 'completed');
  const row = await db.one('select output from tool_runs where id = $1', [run.id]);
  assert.deepStrictEqual(row.output, { value: 'done' });
});

test('a run without events gets one status event once it has ended', async () => {
  const id = crypto.randomUUID();
  await db.query(
    `insert into tool_runs (id, user_id, workspace_id, tool_id, status) values ($1, $2, $3, 'old-tool', 'completed')`,
    [id, USER, WS],
  );
  const events = parseSse((await call('GET', `/api/runs/${id}/events`)).body);
  assert.deepStrictEqual(events.map((e) => [e.event, e.data]), [['status', { status: 'completed' }]]);
});

test('runs in another workspace, and malformed ids, are 404s', async () => {
  const run = await jobs.startJob(fakeReq(), { toolId: 'test-tool', work: async () => 1 });
  await waitForStatus(run.id);
  const other = await call('GET', `/api/runs/${run.id}/events`, { headers: { 'x-test-user': OTHER_USER } });
  assert.strictEqual(other.status, 404);
  assert.strictEqual(JSON.parse(other.body).code, 'not_found');
  const bad = await call('GET', '/api/runs/not-a-uuid');
  assert.strictEqual(bad.status, 404);
});

test('GET /result returns the job result; a running job is a 404 no_result', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = await jobs.startJob(fakeReq(), { toolId: 'test-tool', work: async () => { await gate; return { pages: 3 }; } });
  const early = await call('GET', `/api/runs/${run.id}/result`);
  assert.strictEqual(early.status, 404);
  assert.strictEqual(JSON.parse(early.body).code, 'no_result');
  release();
  await waitForStatus(run.id);
  const done = await call('GET', `/api/runs/${run.id}/result`);
  assert.deepStrictEqual(JSON.parse(done.body), { result: { pages: 3 } });
});

test('POST /cancel: only the starter may cancel; a finished run answers 200', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = await jobs.startJob(fakeReq(), { toolId: 'test-tool', work: async () => { await gate; } });
  await db.query('insert into workspace_members (workspace_id, user_id) values ($1, $2) on conflict do nothing', [WS, OTHER_USER]).catch(() => {});
  const ok = await call('POST', `/api/runs/${run.id}/cancel`);
  assert.strictEqual(ok.status, 202);
  assert.strictEqual(JSON.parse(ok.body).cancel, 'cancelled');
  release();
  const again = await call('POST', `/api/runs/${run.id}/cancel`);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(JSON.parse(again.body).cancel, 'finished');
});

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  try {
    for (const [id, email] of [[USER, 'jobs-user@test'], [OTHER_USER, 'jobs-other@test']]) {
      await db.query('insert into app_users (id, email) values ($1, $2)', [id, `${id}-${email}`]);
    }
    await db.query('insert into workspaces (id, name, created_by) values ($1, $2, $3), ($4, $5, $6)',
      [WS, 'Jobs test', USER, OTHER_WS, 'Other', OTHER_USER]);
    await startApp();
    for (const t of tests) {
      try {
        await t.fn();
        console.log(`  ok   ${t.name}`);
      } catch (e) {
        failed++;
        console.log(`  FAIL ${t.name}\n       ${e.stack || e.message}`);
      }
    }
  } catch (e) {
    failed++;
    console.log(`  FAIL setup\n       ${e.stack || e.message}`);
  } finally {
    if (server) server.close();
    await db.end().catch(() => {});
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
