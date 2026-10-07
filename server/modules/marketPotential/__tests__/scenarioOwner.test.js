// ── Market Potential: a scenario can only be deleted by its owner ────────────
// The list route shows a user only their own scenarios (user_id = username), but
// DELETE /scenarios/:id used to delete by id alone, so anyone holding an id
// could remove someone else's saved run.
//
// Zero-dependency: Node's assert and a real Express app on an ephemeral port.
// services/db is stubbed through require.cache with a tiny in-memory table, so
// the real store SQL runs against fake rows and nothing reaches a database.
// Run: node modules/marketPotential/__tests__/scenarioOwner.test.js

const assert = require('assert');
const http = require('http');

const table = [];      // market_potential_scenarios rows: { id, user_id, data }
const queries = [];    // every db.query call: { sql, params }

const dbPath = require.resolve('../../../services/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    json: (v) => JSON.stringify(v),
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/delete from market_potential_scenarios/i.test(sql)) {
        const byOwner = /user_id\s*=\s*\$2/i.test(sql);
        const before = table.length;
        for (let i = table.length - 1; i >= 0; i--) {
          const row = table[i];
          if (row.id === params[0] && (!byOwner || row.user_id === params[1])) table.splice(i, 1);
        }
        return { rowCount: before - table.length, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    async rows(sql, params = []) {
      queries.push({ sql, params });
      if (/from market_potential_scenarios/i.test(sql)) {
        return table.filter((r) => !params.length || r.user_id === params[0]).map((r) => ({ data: r.data }));
      }
      return [];
    },
    async maybeOne() { return null; },
    async one() { return null; },
    async tx(fn) { return fn(this); },
  },
};

const express = require('express');
const router = require('../routes');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const who = req.headers['x-test-user'];
  if (who) req.user = { username: who };
  next();
});
app.use('/api/market-potential', router);

let baseUrl;
function request(method, urlPath, user) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${urlPath}`, {
      method,
      headers: user ? { 'x-test-user': user } : {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function seed() {
  table.length = 0;
  table.push({ id: 'scn_alice', user_id: 'alice@position2.com', data: { id: 'scn_alice', userId: 'alice@position2.com' } });
  table.push({ id: 'scn_anon', user_id: 'anon', data: { id: 'scn_anon', userId: 'anon' } });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('another user deleting a scenario gets 404 and the row is kept', async () => {
  seed();
  queries.length = 0;
  const r = await request('DELETE', '/api/market-potential/scenarios/scn_alice', 'bob@position2.com');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error, 'Scenario not found');
  assert.ok(table.some((row) => row.id === 'scn_alice'), 'the row was deleted');
  const del = queries.find((q) => /delete from market_potential_scenarios/i.test(q.sql));
  assert.deepStrictEqual(del.params, ['scn_alice', 'bob@position2.com']);
});

test('the owner can delete their scenario', async () => {
  seed();
  const r = await request('DELETE', '/api/market-potential/scenarios/scn_alice', 'alice@position2.com');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true });
  assert.ok(!table.some((row) => row.id === 'scn_alice'));
});

test('a signed-out caller is "anon", the same owner the list uses', async () => {
  seed();
  const list = await request('GET', '/api/market-potential/scenarios');
  assert.deepStrictEqual(list.body.scenarios.map((s) => s.id), ['scn_anon']);
  const denied = await request('DELETE', '/api/market-potential/scenarios/scn_alice');
  assert.strictEqual(denied.status, 404);
  const ok = await request('DELETE', '/api/market-potential/scenarios/scn_anon');
  assert.strictEqual(ok.status, 200);
});

test('an unknown id is still 404', async () => {
  seed();
  const r = await request('DELETE', '/api/market-potential/scenarios/scn_nope', 'alice@position2.com');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(table.length, 2);
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
