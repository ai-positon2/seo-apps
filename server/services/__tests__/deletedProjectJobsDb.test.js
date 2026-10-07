// ── Background work stops when its project is deleted ───────────────────────
//
// Deleting a project is a soft delete (lifecycle_status = 'deleted'), and the
// queue and the scheduler did not look at it. A queued AI Visibility, AI
// Visibility Lite, Competitor Research or Hub & Spoke run for a deleted project
// still executed — metered SEMrush and model spend on a project nobody can see
// any more — and its schedules kept firing. Only the homepage audits checked.
//
// The module bodies are stubbed to throw a sentinel. Two reasons: a deleted
// project must be refused BEFORE they are reached, and an active one reaching
// them proves the refusal is not just every run failing. They are never allowed
// to run for real here — the AI Visibility module loads provider keys from .env.
//
// Needs a real database. Skips without TEST_DATABASE_URL; see helpers/testDatabase.js.
//
// Run: TEST_DATABASE_URL=postgres://... node services/__tests__/deletedProjectJobsDb.test.js

const assert = require('node:assert/strict');
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { useTestDatabase } = require('./helpers/testDatabase');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

if (!useTestDatabase('deleted-project jobs (database)')) {
  process.exit(0);
}

const db = require('../db');
const executors = require('../moduleExecutors');
const scheduler = require('../moduleScheduler');
const { createProjectFixture, dropProjectFixture } = require('./helpers/projectFixture');

// ── Stubs: what "the module actually ran" looks like ───────────────────────
const REACHED = 'MODULE_BODY_REACHED';
const reached = () => { throw new Error(REACHED); };
require('../../modules/aiVisibility/run').runAiVisibility = reached;
require('../../modules/aiVisibilityLite/run').execute = reached;
require('../../modules/projects/moduleRunners').executeOpenRun = reached;

const MODULE_KEYS = ['ai_visibility', 'ai_visibility_lite', 'competitor', 'hub_spoke', 'seo_geo', 'agent_readiness'];
const fakeRun = (projectId, moduleKey) => ({
  id: '00000000-0000-0000-0000-000000000001',
  project_id: projectId,
  module_key: moduleKey,
  created_by: null,
  target_url: null,
});

(async () => {
  console.log('deleted-project jobs (database)');
  const live = await createProjectFixture({ prefix: 'jobs_live' });
  const gone = await createProjectFixture({ prefix: 'jobs_gone' });
  await db.query(`update crawl_projects set lifecycle_status = 'deleted' where id = $1`, [gone.projectId]);

  try {
    for (const key of MODULE_KEYS) {
      await test(`${key}: a queued run for a deleted project does not execute`, async () => {
        await assert.rejects(executors[key](fakeRun(gone.projectId, key)), (e) => {
          assert.doesNotMatch(e.message, new RegExp(REACHED), 'the module ran for a deleted project');
          assert.match(e.message, /no longer active/);
          return true;
        });
      });

      await test(`${key}: a queued run for an active project still reaches the module`, async () => {
        await assert.rejects(executors[key](fakeRun(live.projectId, key)), new RegExp(REACHED));
      });
    }

    await test('the scheduler does not pick up a deleted project\'s schedules', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      for (const f of [live, gone]) {
        await db.query(
          `insert into project_module_schedules (project_id, workspace_id, module_key, enabled, cron, timezone, next_run_at)
           values ($1, $2, 'ai_visibility', true, '0 6 * * *', 'UTC', $3)`,
          [f.projectId, f.workspaceId, past]);
      }
      const due = await scheduler.due({ limit: 500 });
      const projects = new Set(due.map((s) => s.project_id));
      assert.ok(projects.has(live.projectId), 'an active project\'s schedule is still due');
      assert.ok(!projects.has(gone.projectId), 'a deleted project\'s schedule must not fire');
    });
  } finally {
    await db.query(`delete from project_module_schedules where project_id = any($1)`, [[live.projectId, gone.projectId]]);
    await dropProjectFixture(live);
    await dropProjectFixture(gone);
  }

  await db.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
