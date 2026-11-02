// ── Report chat storage, against a real database ────────────────────────────
//
// Migration 0044 and store.js together: one active thread per person per
// project, a new conversation keeps the old one, nobody reads another person's
// messages, and the daily count counts only that person's questions.
//
// Needs a real database because the partial unique index and ON CONFLICT ...
// WHERE are what make two racing first questions share one thread. Skips
// without TEST_DATABASE_URL; see services/__tests__/helpers/testDatabase.js.
//
// Run: TEST_DATABASE_URL=postgres://... node modules/reportChat/__tests__/storeDb.test.js

const assert = require('node:assert/strict');
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { useTestDatabase } = require('../../../services/__tests__/helpers/testDatabase');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// Must run before services/db builds its pool.
if (!useTestDatabase('reportChat store (database)')) {
  process.exit(0);
}

const db = require('../../../services/db');
const store = require('../store');
const { createProjectFixture, dropProjectFixture } = require('../../../services/__tests__/helpers/projectFixture');

(async () => {
  console.log('\nreportChat store — threads and messages\n');

  const fixture = await createProjectFixture({ prefix: 'rchat', url: 'https://rchat.invalid' });
  const other = await db.one(
    `insert into app_users (email) values ($1) returning id`,
    [`_rchat_other_${Date.now()}@position2.com`],
  );
  const me = fixture.userId;
  const project = fixture.projectId;

  try {
    await test('no thread until the first question', async () => {
      assert.equal(await store.activeThread(project, me), null);
    });

    await test('two racing first questions share one thread', async () => {
      const [a, b] = await Promise.all([store.ensureThread(project, me), store.ensureThread(project, me)]);
      assert.equal(a.id, b.id);
      assert.equal(await db.count(
        `select count(*) from report_chat_threads where project_id = $1 and user_id = $2`, [project, me]), 1);
    });

    await test('messages read back oldest first, newest window', async () => {
      const thread = await store.ensureThread(project, me);
      for (let i = 1; i <= 4; i++) {
        await store.addMessage({ threadId: thread.id, userId: me, role: i % 2 ? 'user' : 'assistant', content: `m${i}`, screen: 'tech' });
      }
      const last3 = await store.listMessages(thread.id, me, 3);
      assert.deepEqual(last3.map((m) => m.content), ['m2', 'm3', 'm4']);
    });

    await test('tokens are stored on an answer', async () => {
      const thread = await store.ensureThread(project, me);
      const row = await store.addMessage({
        threadId: thread.id, userId: me, role: 'assistant', content: 'answer', model: 'gpt-5.4-mini', inputTokens: 1500, outputTokens: 90,
      });
      const stored = await db.one(`select model, input_tokens, output_tokens from report_chat_messages where id = $1`, [row.id]);
      assert.deepEqual(stored, { model: 'gpt-5.4-mini', input_tokens: 1500, output_tokens: 90 });
    });

    await test('an expert answer keeps its specialist offer and sources (0045)', async () => {
      const thread = await store.ensureThread(project, me);
      const sources = [{ title: 'Google Search Central', url: 'https://developers.google.com/search/updates' }];
      await store.addMessage({ threadId: thread.id, userId: me, role: 'assistant', content: 'advice', offerExpert: true, sources, webSearches: 1 });
      const last = (await store.listMessages(thread.id, me, 1))[0];
      assert.equal(last.offer_expert, true);
      assert.deepEqual(last.sources, sources);
      const row = await db.one(`select web_searches from report_chat_messages where thread_id = $1 order by created_at desc limit 1`, [thread.id]);
      assert.equal(row.web_searches, 1);
    });

    await test('someone else cannot read my thread by its id', async () => {
      const thread = await store.ensureThread(project, me);
      assert.deepEqual(await store.listMessages(thread.id, other.id, 50), []);
      assert.equal(await store.activeThread(project, other.id), null);
    });

    await test('the daily count is only my questions', async () => {
      assert.equal(await store.countRecentQuestions(me), 2);
      assert.equal(await store.countRecentQuestions(other.id), 0);
    });

    await test('a new conversation keeps the old thread, archived', async () => {
      const before = await store.ensureThread(project, me);
      await store.archiveActive(project, me);
      assert.equal(await store.activeThread(project, me), null);
      const after = await store.ensureThread(project, me);
      assert.notEqual(after.id, before.id);
      const archived = await db.one(`select archived_at from report_chat_threads where id = $1`, [before.id]);
      assert.ok(archived.archived_at);
      assert.deepEqual(await store.listMessages(after.id, me, 50), []);
    });

    await test('only user and assistant roles are accepted', async () => {
      const thread = await store.ensureThread(project, me);
      await assert.rejects(store.addMessage({ threadId: thread.id, userId: me, role: 'system', content: 'x' }));
    });

    await test('deleting the project removes its conversations', async () => {
      const thread = await store.ensureThread(project, me);
      await db.query(`delete from crawl_projects where id = $1`, [project]);
      assert.equal(await db.count(`select count(*) from report_chat_threads where project_id = $1`, [project]), 0);
      assert.equal(await db.count(`select count(*) from report_chat_messages where thread_id = $1`, [thread.id]), 0);
      fixture.projectId = null;
    });
  } finally {
    await dropProjectFixture(fixture).catch(() => {});
    await db.query(`delete from app_users where id = $1`, [other.id]).catch(() => {});
    await db.end().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
