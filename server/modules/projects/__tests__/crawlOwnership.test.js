// POST /api/projects/:id/audit accepts a crawl to follow. The project is
// access-checked; the crawl id beside it was not, so naming another project's
// crawl audited that project's pages into this one, where the caller could read
// them. The crawl must belong to the project the audit is for.

const test = require('node:test');
const assert = require('node:assert');
const { crawlBelongsToProject } = require('../streamingAudit');

const lookupFrom = (rows) => async (id) => rows[id] || null;

test('a crawl of this project is accepted', async () => {
  const lookup = lookupFrom({ c1: { id: 'c1', project_id: 'p1' } });
  assert.strictEqual(await crawlBelongsToProject('c1', 'p1', { lookup }), true);
});

test("another project's crawl is refused", async () => {
  const lookup = lookupFrom({ c2: { id: 'c2', project_id: 'p2' } });
  assert.strictEqual(await crawlBelongsToProject('c2', 'p1', { lookup }), false);
});

test('a crawl attached to no project is refused', async () => {
  const lookup = lookupFrom({ c3: { id: 'c3', project_id: null } });
  assert.strictEqual(await crawlBelongsToProject('c3', 'p1', { lookup }), false);
});

test('an unknown crawl id is refused', async () => {
  assert.strictEqual(await crawlBelongsToProject('nope', 'p1', { lookup: lookupFrom({}) }), false);
});
