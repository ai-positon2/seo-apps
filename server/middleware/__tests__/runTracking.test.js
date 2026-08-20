// ── Tests for the run-tracking middleware ────────────────────────────────────
// No test framework is configured in this app, so this is a zero-dependency
// runner using Node's built-in assert + a real Express app on an ephemeral
// port. Run: node middleware/__tests__/runTracking.test.js
//
// The store and the workspace resolver are stubbed via require.cache so the
// tests exercise the middleware's actual behavior (matching, the init→stream
// bridge, SSE outcome sniffing, deferred runs) without needing Supabase.

const assert = require('assert');
const path = require('path');
const http = require('http');

// ── Stub runStore + workspaceContext before requiring the middleware ─────────
const runStorePath = require.resolve('../../services/runStore');
const workspaceContextPath = require.resolve('../../services/workspaceContext');

const recorded = [];   // every startRun call, in order
const finished = [];   // every finishRun call, in order

require.cache[runStorePath] = {
  id: runStorePath, filename: runStorePath, loaded: true, exports: {
    async startRun(args) {
      const id = `run_${recorded.length + 1}`;
      recorded.push({ id, ...args });
      return id;
    },
    async finishRun(id, patch) { finished.push({ id, ...patch }); },
  },
};

require.cache[workspaceContextPath] = {
  id: workspaceContextPath, filename: workspaceContextPath, loaded: true, exports: {
    async resolveIdentity() {
      return { userId: 'user-1', workspaceId: 'ws-1', actorEmail: 'tester@position2.com' };
    },
  },
};

const express = require('express');
const { trackRuns, deriveLabel } = require('../runTracking');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function findRun(action) { return recorded.find(r => r.action === action); }
function outcomeOf(runId) { return finished.find(f => f.id === runId); }

// ── A test app covering all three run shapes ─────────────────────────────────
const app = express();
app.use(express.json());

const CONFIG = {
  toolId: 'test-tool',
  matchers: [
    { method: 'POST', path: '/sync', action: 'sync' },
    { method: 'POST', path: '/fails', action: 'fails' },
    { method: 'POST', path: '/init', bridge: 'init', action: 'streamed' },
    { method: 'GET', path: /^\/stream\/[^/]+$/, bridge: 'stream', action: 'streamed' },
    { method: 'POST', path: '/deferred', action: 'deferred', deferred: true },
    { method: 'POST', path: /^\/pages\/([^/]+)\/go$/, action: 'labelled',
      label: ({ match }) => `page ${match[1]}` },
    { method: 'POST', path: '/export', action: 'export' },
  ],
};

app.use('/tool', trackRuns(CONFIG), (() => {
  const router = express.Router();
  const sessions = new Map();

  router.post('/sync', (req, res) => res.json({ ok: true, score: 91 }));
  router.post('/fails', (req, res) => res.status(500).json({ error: 'boom' }));
  router.post('/untracked', (req, res) => res.json({ ok: true }));
  router.post('/bad', (req, res) => res.status(400).json({ error: 'url is required' }));

  router.post('/init', (req, res) => {
    const token = `t${sessions.size + 1}`;
    sessions.set(token, req.body);
    res.json({ token });
  });

  // SSE: ?mode=ok | fail | truncated
  router.get('/stream/:token', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('event: step\ndata: {"id":"one","status":"active"}\n\n');
    if (req.query.mode === 'fail') {
      res.write('event: fail\ndata: {"message":"model refused"}\n\n');
      res.write('event: done\ndata: {}\n\n');
      return res.end();
    }
    if (req.query.mode === 'truncated') return res.end(); // no terminal event
    res.write('event: result\ndata: {"primary":["a","b"],"score":77}\n\n');
    res.write('event: done\ndata: {}\n\n');
    res.end();
  });

  router.post('/deferred', (req, res) => {
    const run = req.run;
    res.json({ status: 'running' });
    setTimeout(() => {
      if (req.body.shouldFail) run.fail('background boom');
      else run.finish({ output: { auditId: 'a1' }, label: 'enriched label' });
    }, 15);
  });

  router.post(/^\/pages\/([^/]+)\/go$/, (req, res) => res.json({ ok: true }));
  router.post('/export', (req, res) => res.json({ bytes: 1024 }));
  return router;
})());

// ── HTTP helper ──────────────────────────────────────────────────────────────
let baseUrl;
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${urlPath}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

// ── Tests ────────────────────────────────────────────────────────────────────

test('deriveLabel prefers the most identifying field', () => {
  assert.strictEqual(deriveLabel({ keyword: 'dental implants' }), 'dental implants');
  assert.strictEqual(deriveLabel({ url: 'https://x.com/a', keyword: 'k' }), 'https://x.com/a');
  assert.strictEqual(deriveLabel({ urls: ['a', 'b', 'c'] }), 'a +2 more');
  assert.strictEqual(deriveLabel({ keywords: ['a', 'b'] }), 'a, b');
  assert.strictEqual(deriveLabel({ nothing: 1 }), null);
});

test('untracked endpoints record nothing', async () => {
  const before = recorded.length;
  await request('POST', '/tool/untracked', {});
  await settle();
  assert.strictEqual(recorded.length, before, 'no run should be recorded');
});

test('a JSON run records identity, workspace, input and output', async () => {
  await request('POST', '/tool/sync', { url: 'https://example.com', apiKey: 'sk-secret' });
  await settle();
  const run = findRun('sync');
  assert.ok(run, 'run recorded');
  assert.strictEqual(run.toolId, 'test-tool');
  assert.strictEqual(run.userId, 'user-1');
  assert.strictEqual(run.workspaceId, 'ws-1');
  assert.strictEqual(run.actorEmail, 'tester@position2.com');
  assert.strictEqual(run.label, 'https://example.com');
  assert.strictEqual(run.input.url, 'https://example.com');
  assert.strictEqual(run.method, 'POST');
  assert.strictEqual(run.path, '/tool/sync');

  const outcome = outcomeOf(run.id);
  assert.strictEqual(outcome.status, 'completed');
  assert.strictEqual(outcome.output.score, 91);
  assert.ok(Number.isFinite(outcome.durationMs), 'duration recorded');
});

test('a 5xx response is recorded as failed with the error message', async () => {
  const res = await request('POST', '/tool/fails', { url: 'https://fail.example' });
  await settle();
  assert.strictEqual(res.status, 500);
  const run = findRun('fails');
  assert.ok(run, 'a failing run is still recorded');
  const outcome = outcomeOf(run.id);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.error, 'boom', 'error message taken from the JSON body');
});

test('a path matcher supplies the label when the body has no identifying field', async () => {
  await request('POST', '/tool/pages/p9/go', { bad: true });
  await settle();
  const labelled = findRun('labelled');
  assert.strictEqual(labelled.label, 'page p9');
  assert.strictEqual(outcomeOf(labelled.id).status, 'completed');
});

test('init → stream bridge carries the input onto the stream run', async () => {
  const init = JSON.parse((await request('POST', '/tool/init', { keyword: 'invisalign cost' })).body);
  const beforeStream = recorded.length;
  assert.strictEqual(beforeStream, recorded.length, 'init itself records no run');

  await request('GET', `/tool/stream/${init.token}`);
  await settle();
  const run = recorded[recorded.length - 1];
  assert.strictEqual(run.action, 'streamed');
  assert.strictEqual(run.input.keyword, 'invisalign cost', 'input bridged from /init');
  assert.strictEqual(run.label, 'invisalign cost');

  const outcome = outcomeOf(run.id);
  assert.strictEqual(outcome.status, 'completed');
  assert.strictEqual(outcome.output.score, 77, 'result event captured as output');
});

test('an SSE stream that reports failure is recorded as failed', async () => {
  const init = JSON.parse((await request('POST', '/tool/init', { keyword: 'fails' })).body);
  await request('GET', `/tool/stream/${init.token}?mode=fail`);
  await settle();
  const run = recorded[recorded.length - 1];
  const outcome = outcomeOf(run.id);
  assert.strictEqual(outcome.status, 'failed', 'a fail event outranks the trailing done');
  assert.strictEqual(outcome.error, 'model refused');
});

test('an SSE stream with no terminal event is cancelled, not completed', async () => {
  const init = JSON.parse((await request('POST', '/tool/init', { keyword: 'cut short' })).body);
  await request('GET', `/tool/stream/${init.token}?mode=truncated`);
  await settle();
  const run = recorded[recorded.length - 1];
  const outcome = outcomeOf(run.id);
  assert.strictEqual(outcome.status, 'cancelled');
});

test('a deferred run stays open until the module closes it', async () => {
  await request('POST', '/tool/deferred', { url: 'https://deferred.example' });
  const run = recorded[recorded.length - 1];
  assert.strictEqual(outcomeOf(run.id), undefined, 'not settled when the response returns');
  await settle();
  const outcome = outcomeOf(run.id);
  assert.strictEqual(outcome.status, 'completed');
  assert.strictEqual(outcome.output.auditId, 'a1');
  assert.strictEqual(outcome.label, 'enriched label', 'module can enrich the label');
});

test('a deferred run that fails in the background is recorded as failed', async () => {
  await request('POST', '/tool/deferred', { url: 'https://boom.example', shouldFail: true });
  const run = recorded[recorded.length - 1];
  await settle();
  const outcome = outcomeOf(run.id);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.error, 'background boom');
});

test('exports are recorded as their own action, not as runs', async () => {
  await request('POST', '/tool/export', { url: 'https://example.com/report' });
  await settle();
  const run = findRun('export');
  assert.ok(run, 'export recorded');
  assert.strictEqual(run.action, 'export');
});

// ── Run ──────────────────────────────────────────────────────────────────────
(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  console.log('Run tracking middleware');
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  }

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
