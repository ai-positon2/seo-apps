// ── Robots Monitor routes: saved passwords and the manual run id ─────────────
// Zero-dependency: Node's assert and a real Express app on an ephemeral port.
// The store, the crawler, the page checker, Slack and the scheduler are stubbed
// through require.cache, so nothing here touches a database or the network.
// Run: node modules/robotsMonitor/__tests__/routes.test.js

const assert = require('assert');
const http = require('http');

function stub(relPath, exports) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ── In-memory store ──────────────────────────────────────────────────────────
const state = {
  clients: [],
  slack: { timezone: 'Asia/Kolkata' },
  savedRuns: [],
};

function findClient(clientId) {
  const client = state.clients.find((c) => c.id === clientId);
  if (!client) throw new Error(`Client "${clientId}" not found`);
  return client;
}

stub('../monitorStore', {
  async init() {},
  async getClients() { return JSON.parse(JSON.stringify(state.clients)); },
  async addClient({ name }) {
    const client = { id: `client_${state.clients.length + 1}`, name, domains: [] };
    state.clients.push(client);
    return client;
  },
  async updateClient(clientId, { name }) { const c = findClient(clientId); c.name = name; return JSON.parse(JSON.stringify(c)); },
  async deleteClient() {},
  async addDomain(clientId, { url, env, auth = null }) {
    const domain = { id: `dom_${Date.now()}`, url, env, auth: auth || null, enabled: true };
    findClient(clientId).domains.push(domain);
    return JSON.parse(JSON.stringify(domain));
  },
  async getDomain(clientId, domainId) {
    const d = findClient(clientId).domains.find((x) => x.id === domainId);
    if (!d) throw new Error(`Domain "${domainId}" not found`);
    return JSON.parse(JSON.stringify(d));
  },
  async updateDomain(clientId, domainId, fields) {
    const d = findClient(clientId).domains.find((x) => x.id === domainId);
    if (!d) throw new Error(`Domain "${domainId}" not found`);
    Object.assign(d, fields);
    return JSON.parse(JSON.stringify(d));
  },
  async deleteDomain() {},
  async getSlackConfig() { return { ...state.slack }; },
  async saveSlackConfig(c) { state.slack = c; },
  async saveRunHistory(run) { state.savedRuns.push(run); },
  async getRunHistory() { return state.savedRuns; },
  async getRunById(id) { return state.savedRuns.find((r) => r.runId === id) || null; },
  async pruneHistory() {},
});

// The crawl waits on a gate so a test can hold a run open.
let releaseCrawl = () => {};
let crawlGate = Promise.resolve();
function holdCrawl() { crawlGate = new Promise((resolve) => { releaseCrawl = resolve; }); }

const checkedAuth = [];
stub('../sitemapCrawler', {
  async crawlDomain(domain) {
    await crawlGate;
    return { sitemapStatus: 'found', sitemapUrl: `${domain.url}/sitemap.xml`, urls: [`${domain.url}/`] };
  },
});
stub('../indexChecker', {
  async checkPage(url, auth) {
    checkedAuth.push(auth);
    return { url, finalUrl: url, noindex: false, signal: null, error: null };
  },
});
stub('../slackNotifier', { async sendRunAlert() {}, async sendTestMessage() {} });
stub('../monitorScheduler', { async init() {}, async reinitScheduler() {} });

const express = require('express');
const router = require('../routes');
const { getStatus } = require('../monitorRunner');

const app = express();
app.use(express.json());
app.use('/api/robots-monitor', router);

let baseUrl;
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${baseUrl}${urlPath}`, {
      method,
      headers: payload ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitUntil(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting');
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const BASE = '/api/robots-monitor';
let clientId;
let domainId;

test('adding a domain without a password is refused', async () => {
  const c = await request('POST', `${BASE}/clients`, { name: 'Acme' });
  assert.strictEqual(c.status, 201);
  clientId = c.body.id;
  const r = await request('POST', `${BASE}/clients/${clientId}/domains`, {
    url: 'https://staging.example.com', env: 'staging', auth: { username: 'qa' },
  });
  assert.strictEqual(r.status, 400);
});

test('adding a domain with a password stores it but never returns it', async () => {
  const r = await request('POST', `${BASE}/clients/${clientId}/domains`, {
    url: 'https://staging.example.com', env: 'staging', auth: { username: 'qa', password: 's3cret' },
  });
  assert.strictEqual(r.status, 201);
  domainId = r.body.id;
  assert.deepStrictEqual(r.body.auth, { username: 'qa', hasPassword: true });
  assert.ok(!r.raw.includes('s3cret'));
  assert.strictEqual(state.clients[0].domains[0].auth.password, 's3cret');
});

test('GET /clients never includes the password', async () => {
  const r = await request('GET', `${BASE}/clients`);
  assert.strictEqual(r.status, 200);
  assert.ok(!r.raw.includes('s3cret'), 'password leaked in GET /clients');
  assert.deepStrictEqual(r.body[0].domains[0].auth, { username: 'qa', hasPassword: true });
});

test('PATCH without a password keeps the stored one and can change the username', async () => {
  const r = await request('PATCH', `${BASE}/clients/${clientId}/domains/${domainId}`, {
    url: 'https://staging.example.com', env: 'staging', auth: { username: 'qa2' },
  });
  assert.strictEqual(r.status, 200, r.raw);
  assert.ok(!r.raw.includes('s3cret'));
  assert.deepStrictEqual(r.body.auth, { username: 'qa2', hasPassword: true });
  assert.deepStrictEqual(state.clients[0].domains[0].auth, { username: 'qa2', password: 's3cret' });
});

test('PATCH with an empty password also keeps the stored one', async () => {
  const r = await request('PATCH', `${BASE}/clients/${clientId}/domains/${domainId}`, {
    auth: { username: 'qa', password: '' },
  });
  assert.strictEqual(r.status, 200, r.raw);
  assert.deepStrictEqual(state.clients[0].domains[0].auth, { username: 'qa', password: 's3cret' });
});

test('POST /run answers 202 with the id the run is stored under', async () => {
  const r = await request('POST', `${BASE}/run`);
  assert.strictEqual(r.status, 202, r.raw);
  assert.strictEqual(r.body.ok, true);
  assert.match(r.body.runId, /^run_\d{8}_\d{4}$/);
  assert.deepStrictEqual(r.body.run, { id: r.body.runId, status: 'running' });
  await waitUntil(() => state.savedRuns.length === 1);
  assert.strictEqual(state.savedRuns[0].runId, r.body.runId);
  assert.strictEqual(state.savedRuns[0].triggeredBy, 'manual');
});

test('the checker still receives the real stored password', async () => {
  assert.ok(checkedAuth.length > 0);
  assert.deepStrictEqual(checkedAuth[0], { username: 'qa', password: 's3cret' });
});

test('a second POST /run while one is going is a 409 run_in_progress', async () => {
  holdCrawl();
  const first = await request('POST', `${BASE}/run`);
  assert.strictEqual(first.status, 202, first.raw);
  assert.strictEqual(getStatus().currentRunId, first.body.runId);
  const second = await request('POST', `${BASE}/run`);
  assert.strictEqual(second.status, 409);
  assert.deepStrictEqual(second.body, { error: 'A run is already in progress.', code: 'run_in_progress' });
  releaseCrawl();
  await waitUntil(() => !getStatus().isRunning);
});

test('PATCH with auth: null removes auth', async () => {
  const r = await request('PATCH', `${BASE}/clients/${clientId}/domains/${domainId}`, { auth: null });
  assert.strictEqual(r.status, 200, r.raw);
  assert.strictEqual(r.body.auth, null);
  assert.strictEqual(state.clients[0].domains[0].auth, null);
});

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${t.name}\n       ${e.message}`);
    }
  }
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
