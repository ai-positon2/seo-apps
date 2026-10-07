const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');

// ── A project id that cannot be a UUID is "not found", not a 500 ─────────────
//
// crawl_projects.id is a uuid column, so `where id = $1` with 'abc' makes
// Postgres refuse the cast ("invalid input syntax for type uuid"), and
// requireProject rethrew that as a plain Error: a 500 for a typo in a URL. It
// now answers the same 404 it gives for a project that does not exist, without
// asking the database.
//
// No database: services/db is stubbed through require.cache with a maybeOne
// that behaves like Postgres's uuid cast.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const queries = [];

const dbPath = require.resolve('../db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    isDatabaseConfigured: () => true,
    async maybeOne(sql, params = []) {
      queries.push({ sql, params });
      if (/from crawl_projects/i.test(sql) && !UUID_RE.test(String(params[0]))) {
        throw Object.assign(new Error(`invalid input syntax for type uuid: "${params[0]}"`), { code: '22P02' });
      }
      return null;
    },
    async rows() { return []; },
    async one() { throw new Error('unexpected db.one'); },
    async query() { return { rows: [], rowCount: 0 }; },
  },
};

const projectAccess = require('../projectAccess');

const REQ = { user: { userId: '22222222-2222-4222-8222-222222222222', username: 'a@position2.com' } };

beforeEach(() => { queries.length = 0; });

for (const bad of ['not-a-uuid', '123', "1' or '1'='1", '00000000-0000-0000-0000-00000000000Z']) {
  test(`requireProject(${JSON.stringify(bad)}) is a 404 not_found and never queries`, async () => {
    await assert.rejects(
      projectAccess.requireProject(REQ, bad, 'view'),
      (e) => e.status === 404 && e.code === 'not_found' && e.message === 'Project not found.',
    );
    assert.equal(queries.length, 0);
  });
}

test('a well-formed id that matches nothing is still the same 404', async () => {
  await assert.rejects(
    projectAccess.requireProject(REQ, '00000000-0000-4000-8000-000000000000', 'view'),
    (e) => e.status === 404 && e.code === 'not_found',
  );
  assert.equal(queries.length, 1);
});
