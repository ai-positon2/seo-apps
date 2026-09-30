// ── Inline keyword research, saved per topic ────────────────────────────────
//
// Migration 0040 and keywordResearchStore.js: one row per (project, cluster,
// topic), a re-run replaces it, and a pick change updates only the selection.
// The uniqueness is the database's, so this runs real SQL.
//
// Run: TEST_DATABASE_URL=postgres://... node modules/contentArchitect/__tests__/keywordResearchStore.test.js

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { useTestDatabase } = require('../../../services/__tests__/helpers/testDatabase');

if (!useTestDatabase('keywordResearchStore')) process.exit(0);

const db = require('../../../services/db');
const store = require('../keywordResearchStore');

const MIGRATION = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations', '0040_content_architect_keyword_research.sql');

before(async () => {
  await db.query(fs.readFileSync(MIGRATION, 'utf8'));
  await db.query('truncate content_architect_keyword_research');
});

after(async () => { await db.end(); });

const snap = (keyword) => ({
  keyword,
  intent: 'informational',
  allKeywords: [{ keyword, volume: 10, urlFrequency: 2 }],
  result: { primary: [{ keyword, volume: 10 }], secondary: [] },
});

test('a saved run lists back under its cluster, with its selection', async () => {
  const selection = { primary: [{ keyword: 'a' }], secondary: [{ keyword: 'b' }] };
  assert.deepEqual(await store.saveResult('proj_1', 'c1', { topic: 'Topic A', intent: 'informational', result: snap('a'), selection }), { saved: true });
  const items = await store.listForCluster('proj_1', 'c1');
  assert.equal(items.length, 1);
  assert.equal(items[0].topic, 'Topic A');
  assert.equal(items[0].intent, 'informational');
  assert.deepEqual(items[0].result, snap('a'));
  assert.deepEqual(items[0].selection, selection);
  assert.ok(items[0].updatedAt);
  assert.deepEqual(await store.listForCluster('proj_1', 'other'), []);
  assert.deepEqual(await store.listForCluster('proj_2', 'c1'), []);
});

test('re-running a topic replaces its row instead of adding one', async () => {
  await store.saveResult('proj_1', 'c1', { topic: 'Topic A', intent: 'commercial', result: snap('a2'), selection: null });
  const items = await store.listForCluster('proj_1', 'c1');
  assert.equal(items.length, 1);
  assert.equal(items[0].intent, 'commercial');
  assert.equal(items[0].result.keyword, 'a2');
  assert.equal(items[0].selection, null);
});

test('a pick change updates only the selection, and needs a saved run', async () => {
  const selection = { primary: [{ keyword: 'a2' }], secondary: [] };
  assert.deepEqual(await store.saveSelection('proj_1', 'c1', 'Topic A', selection), { saved: true });
  const [item] = await store.listForCluster('proj_1', 'c1');
  assert.deepEqual(item.selection, selection);
  assert.equal(item.result.keyword, 'a2', 'the run itself is untouched');
  assert.deepEqual(await store.saveSelection('proj_1', 'c1', 'Never run', selection), { saved: false, reason: 'not_found' });
});

test('topics are separate rows within a cluster, newest first', async () => {
  await store.saveResult('proj_1', 'c1', { topic: 'Topic B', intent: 'informational', result: snap('b'), selection: null });
  const items = await store.listForCluster('proj_1', 'c1');
  assert.deepEqual(items.map((i) => i.topic), ['Topic B', 'Topic A']);
});

test('an unknown intent is stored as informational', async () => {
  await store.saveResult('proj_1', 'c2', { topic: 'Topic C', intent: 'navigational', result: snap('c') });
  const [item] = await store.listForCluster('proj_1', 'c2');
  assert.equal(item.intent, 'informational');
});
