// ── Tests for the shared API kit (utils/api) ─────────────────────────────────
// Zero-dependency, like the other suites: Node's assert plus a tiny runner.
// The DNS module the public-host check uses is stubbed, so nothing here
// touches the network. Run: node utils/api/__tests__/api.test.js

const assert = require('assert');
const dns = require('dns').promises;

// assertPublicHost resolves A and AAAA records; answer from a fixed table.
const DNS_TABLE = {
  'example.com': ['93.184.216.34'],
  'internal.test': ['10.0.0.5'],
};
dns.resolve = async (host, type) => {
  if (type !== 'A') return [];
  if (DNS_TABLE[host]) return DNS_TABLE[host];
  throw new Error('ENOTFOUND');
};

const {
  ApiError, badRequest, notFound, conflict, upstream, notConfigured,
  errorBody, asyncRoute, parseBody, isUuid, uuidParam, assertPublicHttpUrl,
  parseBool, parsePage, pageMeta, parseSort, openSse, z,
} = require('..');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── errorBody ────────────────────────────────────────────────────────────────

test('an ApiError 400 keeps its message, code and details', () => {
  const { status, body } = errorBody(badRequest('url is required', { field: 'url' }));
  assert.strictEqual(status, 400);
  assert.deepStrictEqual(body, { error: 'url is required', code: 'invalid_request', details: { field: 'url' } });
});

test('notFound and conflict carry their codes', () => {
  assert.deepStrictEqual(errorBody(notFound('Client not found.')).body, { error: 'Client not found.', code: 'not_found' });
  const c = errorBody(conflict('run_in_progress', 'A run is already in progress.', { runId: 'r1' }));
  assert.strictEqual(c.status, 409);
  assert.deepStrictEqual(c.body, { error: 'A run is already in progress.', code: 'run_in_progress', details: { runId: 'r1' } });
});

test('a plain Error is a generic 500 that never leaks its message', () => {
  const { status, body } = errorBody(new Error('password authentication failed for user "admin"'));
  assert.strictEqual(status, 500);
  assert.deepStrictEqual(body, { error: 'Internal server error.', code: 'internal' });
});

test('a plain Error with a 4xx status passes its message through with a default code', () => {
  const err = Object.assign(new Error('request entity too large'), { status: 413, expose: true });
  assert.deepStrictEqual(errorBody(err), { status: 413, body: { error: 'request entity too large', code: 'payload_too_large' } });
  const legacy = Object.assign(new Error('Project not found.'), { status: 404, code: 'not_found' });
  assert.deepStrictEqual(errorBody(legacy).body, { error: 'Project not found.', code: 'not_found' });
});

test('a non-string code (a Node errno) is replaced by the status default', () => {
  const err = Object.assign(new Error('nope'), { status: 400, code: 42 });
  assert.strictEqual(errorBody(err).body.code, 'invalid_request');
});

test('502/503 messages pass through only for ApiErrors', () => {
  assert.deepStrictEqual(errorBody(upstream('SEMrush did not answer.')).body, { error: 'SEMrush did not answer.', code: 'upstream_failed' });
  assert.deepStrictEqual(errorBody(notConfigured('Database not configured.')).body, { error: 'Database not configured.', code: 'not_configured' });
  const raw = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), { status: 503 });
  assert.deepStrictEqual(errorBody(raw).body, { error: 'Service unavailable.', code: 'not_configured' });
});

test('an axios-shaped error with no status is a 500', () => {
  const err = Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } });
  assert.strictEqual(errorBody(err).status, 500);
});

// ── asyncRoute ───────────────────────────────────────────────────────────────

test('asyncRoute forwards a rejection to next', async () => {
  const boom = new Error('x');
  let forwarded;
  await asyncRoute(async () => { throw boom; })({}, {}, (e) => { forwarded = e; });
  assert.strictEqual(forwarded, boom);
});

test('asyncRoute forwards a synchronous throw to next', async () => {
  const boom = new Error('sync');
  let forwarded;
  await asyncRoute(() => { throw boom; })({}, {}, (e) => { forwarded = e; });
  assert.strictEqual(forwarded, boom);
});

// ── parseBody ────────────────────────────────────────────────────────────────

test('parseBody returns parsed data and keeps unknown keys on a passthrough schema', () => {
  const schema = z.object({ name: z.string().trim().min(1) }).passthrough();
  assert.deepStrictEqual(parseBody(schema, { name: ' Acme ', extra: 1 }), { name: 'Acme', extra: 1 });
});

test('parseBody throws a 400 with readable issues', () => {
  const schema = z.object({ name: z.string().min(1), urls: z.array(z.string()).max(2) });
  try {
    parseBody(schema, { name: 5, urls: ['a', 'b', 'c'] });
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof ApiError);
    assert.strictEqual(e.status, 400);
    assert.match(e.message, /name/);
    assert.ok(Array.isArray(e.details.issues) && e.details.issues.length === 2);
  }
});

test('parseBody treats a missing body as an empty object', () => {
  assert.deepStrictEqual(parseBody(z.object({}).passthrough(), undefined), {});
});

// ── ids ──────────────────────────────────────────────────────────────────────

test('isUuid and uuidParam', () => {
  assert.ok(isUuid('3785ec9f-1c2d-4e5f-8a9b-0c1d2e3f4a5b'));
  assert.ok(!isUuid('not-a-uuid'));
  assert.ok(!isUuid(undefined));
  let seen;
  uuidParam('Project')({}, {}, (e) => { seen = e; }, 'bad');
  assert.strictEqual(seen.status, 404);
  assert.strictEqual(seen.message, 'Project not found.');
  uuidParam('Project')({}, {}, (e) => { seen = e; }, '3785ec9f-1c2d-4e5f-8a9b-0c1d2e3f4a5b');
  assert.strictEqual(seen, undefined);
});

// ── assertPublicHttpUrl ──────────────────────────────────────────────────────

test('assertPublicHttpUrl accepts a public https URL', async () => {
  const url = await assertPublicHttpUrl(' https://example.com/page ');
  assert.strictEqual(url.href, 'https://example.com/page');
});

test('assertPublicHttpUrl rejects other schemes, private and unresolvable hosts', async () => {
  for (const bad of ['ftp://example.com', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'http://internal.test', 'http://nowhere.invalid', 'not a url', '']) {
    await assert.rejects(assertPublicHttpUrl(bad), (e) => e instanceof ApiError && e.status === 400, bad);
  }
});

// ── query helpers ────────────────────────────────────────────────────────────

test('parseBool', () => {
  assert.strictEqual(parseBool('1'), true);
  assert.strictEqual(parseBool('true'), true);
  assert.strictEqual(parseBool('TRUE'), true);
  assert.strictEqual(parseBool('0'), false);
  assert.strictEqual(parseBool('false'), false);
  assert.strictEqual(parseBool(undefined), undefined);
  assert.strictEqual(parseBool(''), undefined);
  assert.strictEqual(parseBool('maybe'), undefined);
});

test('parsePage clamps and defaults', () => {
  assert.deepStrictEqual(parsePage({}), { limit: 50, offset: 0 });
  assert.deepStrictEqual(parsePage({ limit: '-5', offset: '-3' }), { limit: 1, offset: 0 });
  assert.deepStrictEqual(parsePage({ limit: '9999' }), { limit: 200, offset: 0 });
  assert.deepStrictEqual(parsePage({ limit: 'abc', offset: '20' }), { limit: 50, offset: 20 });
  assert.deepStrictEqual(parsePage({ limit: '30' }, { defaultLimit: 25, maxLimit: 100 }), { limit: 30, offset: 0 });
});

test('parsePage leaves an unbounded list unlimited when no limit is asked for', () => {
  assert.deepStrictEqual(parsePage({}, { unbounded: true }), { limit: null, offset: 0 });
  assert.deepStrictEqual(parsePage({ limit: '10' }, { unbounded: true }), { limit: 10, offset: 0 });
});

test('pageMeta sets nextOffset only when more rows can exist', () => {
  assert.deepStrictEqual(pageMeta({ limit: 10, offset: 0, returned: 10, total: 25 }), { limit: 10, offset: 0, total: 25, nextOffset: 10 });
  assert.deepStrictEqual(pageMeta({ limit: 10, offset: 20, returned: 5, total: 25 }), { limit: 10, offset: 20, total: 25, nextOffset: null });
  assert.deepStrictEqual(pageMeta({ limit: 10, offset: 0, returned: 10 }), { limit: 10, offset: 0, total: null, nextOffset: 10 });
  assert.deepStrictEqual(pageMeta({ limit: null, offset: 0, returned: 7 }), { limit: null, offset: 0, total: 7, nextOffset: null });
});

test('parseSort accepts allowed fields and rejects others', () => {
  assert.deepStrictEqual(parseSort('-createdAt', ['createdAt', 'name'], 'createdAt'), { field: 'createdAt', direction: 'desc' });
  assert.deepStrictEqual(parseSort('name', ['createdAt', 'name'], '-createdAt'), { field: 'name', direction: 'asc' });
  assert.deepStrictEqual(parseSort(undefined, ['createdAt'], '-createdAt'), { field: 'createdAt', direction: 'desc' });
  assert.throws(() => parseSort('password', ['createdAt'], 'createdAt'), (e) => e.status === 400);
});

// ── openSse ──────────────────────────────────────────────────────────────────

test('openSse writes named events with ids and stops after close', () => {
  const written = [];
  const listeners = {};
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    flushHeaders() {},
    write(chunk) { written.push(chunk); },
    end() { written.push('<end>'); },
    on(evt, fn) { listeners[evt] = fn; },
  };
  const sse = openSse(res, { heartbeatMs: 60000 });
  assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
  sse.send('progress', { done: 1 }, 7);
  sse.comment('ping');
  listeners.close();
  sse.send('progress', { done: 2 });
  assert.strictEqual(sse.closed, true);
  assert.deepStrictEqual(written, ['id: 7\nevent: progress\ndata: {"done":1}\n\n', ': ping\n\n']);
});

// ── runner ───────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${t.name}\n       ${e.stack || e.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
