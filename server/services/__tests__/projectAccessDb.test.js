// ── The workspace boundary, against a real database ─────────────────────────
//
// projectAccess has two halves. The capability TABLE — capabilityFor, role
// normalization, the propose verdict, the creator grant — is pure and covered in
// platformFoundation.test.js. This file covers the other half:
// requireWorkspace/requireProject, which resolve membership in SQL and decide
// whether a caller may see a project at all.
//
// That half had no tests, and it is the half whose bugs are silent: the server
// connects as the database owner, so no row policy stands between a query and
// the whole table. A boundary that stops working does not throw — it returns
// somebody else's client's data.
//
// The rule asserted hardest here is AC-001: a project in a workspace you do not
// belong to answers **404, not 403**. A 403 confirms the id exists, which turns
// project ids into an enumerable directory of who the agency's clients are.
//
// Needs a real database because that is what is being tested — NULL comparison,
// join behaviour and the visibility of a soft-deleted row are Postgres
// semantics, and a fake could only restate the assumption. Skips without
// TEST_DATABASE_URL; see helpers/testDatabase.js for why not DATABASE_URL.
//
// Run: TEST_DATABASE_URL=postgres://... node services/__tests__/projectAccessDb.test.js

const assert = require('node:assert/strict');
// Loaded before the helper reads TEST_DATABASE_URL. Without this the suite
// reports SKIPPED even on a machine that has the variable set in .env --
// which made this file, the workspace-boundary check, look like it was
// passing when it had never run. The sibling DB suites (moduleQueue,
// moduleScheduler, budgetRetention) all do this; this one was missed.
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { useTestDatabase } = require('./helpers/testDatabase');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// Must run before services/db builds its pool.
if (!useTestDatabase('projectAccess (database)')) {
  process.exit(0);
}

const db = require('../db');
const projectAccess = require('../projectAccess');
const { createProjectFixture, dropProjectFixture } = require('./helpers/projectFixture');

// requireAuth puts { userId, username } on the request; that is all these need.
const asUser = (user) => ({ user: { userId: user.userId, username: user.email } });

async function makeUser(prefix) {
  const email = `_pa_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@position2.com`;
  const row = await db.one(`insert into app_users (email) values ($1) returning id`, [email]);
  return { userId: row.id, email };
}

(async () => {
  console.log('\nprojectAccess — the workspace boundary\n');

  // `owner` holds a project; `outsider` belongs to no workspace of theirs.
  const fixture = await createProjectFixture({ prefix: 'paccess', url: 'https://paccess.invalid' });
  const ownerEmail = (await db.one(`select email from app_users where id = $1`, [fixture.userId])).email;
  const owner = { userId: fixture.userId, email: ownerEmail };
  const outsider = await makeUser('outsider');
  const member = await makeUser('member');

  await db.query(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'contributor')
       on conflict (workspace_id, user_id) do update set role = excluded.role`,
    [fixture.workspaceId, member.userId]
  );

  try {
    // ── The boundary ────────────────────────────────────────────────────────

    await test('a member of the workspace can open the project', async () => {
      const ctx = await projectAccess.requireProject(asUser(owner), fixture.projectId, 'view');
      assert.equal(ctx.project.id, fixture.projectId);
      assert.equal(ctx.workspaceId, fixture.workspaceId);
      assert.equal(ctx.role, 'owner');
    });

    await test('AC-001: a project in another workspace answers 404, never 403', async () => {
      await assert.rejects(
        projectAccess.requireProject(asUser(outsider), fixture.projectId, 'view'),
        (e) => {
          assert.equal(e.status, 404, 'a 403 here would confirm the id exists');
          assert.equal(e.code, 'not_found');
          return true;
        },
      );
    });

    await test('an id that does not exist answers the same 404', async () => {
      // Indistinguishable from the case above, which is the point: knowing an id
      // must not tell you whether it is real.
      await assert.rejects(
        projectAccess.requireProject(asUser(owner), '00000000-0000-0000-0000-000000000000', 'view'),
        (e) => e.status === 404 && e.code === 'not_found',
      );
    });

    await test('a workspace you do not belong to answers 404', async () => {
      await assert.rejects(
        projectAccess.requireWorkspace(asUser(outsider), fixture.workspaceId),
        (e) => e.status === 404,
      );
    });

    // ── Capabilities resolved from the stored role ──────────────────────────

    await test('a contributor may view and run, but not edit settings', async () => {
      const ctx = await projectAccess.requireProject(asUser(member), fixture.projectId, 'view');
      assert.equal(ctx.role, 'contributor');
      assert.equal(ctx.can('startRun'), true);
      assert.equal(ctx.can('createProject'), true);
      assert.equal(ctx.can('editProjectSettings'), false);
      assert.equal(ctx.can('manageCompetitors'), 'propose');
    });

    await test('a capability the role lacks is refused with 403, not 404', async () => {
      // The DISTINCTION matters: 404 means "no such project for you", 403 means
      // "this project, but not this action". Collapsing them would make a
      // permission problem look like a missing project.
      await assert.rejects(
        projectAccess.requireProject(asUser(member), fixture.projectId, 'editProjectSettings'),
        (e) => e.status === 403 && e.code === 'forbidden',
      );
    });

    await test('the creator grant applies to a real stored project', async () => {
      // owner-of-the-workspace is also the row's creator here; the grant is
      // asserted against a project actually read out of the database rather than
      // a hand-built object.
      const ctx = await projectAccess.requireProject(asUser(owner), fixture.projectId);
      assert.equal(ctx.isCreator, true);
      assert.equal(ctx.can('editProjectSettings'), true);
    });

    await test("a contributor is not the creator of someone else's project", async () => {
      const ctx = await projectAccess.requireProject(asUser(member), fixture.projectId);
      assert.ok(!ctx.isCreator);
      assert.equal(ctx.can('editProjectSettings'), false);
    });

    // ── accessibleWorkspaceIds, which scopes every list query ───────────────

    await test('accessibleWorkspaceIds returns only workspaces you belong to', async () => {
      const mine = await projectAccess.accessibleWorkspaceIds(member.userId);
      assert.ok(mine.includes(fixture.workspaceId));

      const theirs = await projectAccess.accessibleWorkspaceIds(outsider.userId);
      assert.ok(!theirs.includes(fixture.workspaceId),
        'an outsider must not see the workspace in their scope list');
    });

    // ── Soft deletion ───────────────────────────────────────────────────────

    await test('a soft-deleted project is hidden unless explicitly asked for', async () => {
      await db.query(
        `update crawl_projects set lifecycle_status = 'deleted' where id = $1`, [fixture.projectId]);
      try {
        await assert.rejects(
          projectAccess.requireProject(asUser(owner), fixture.projectId, 'view'),
          (e) => e.status === 404,
        );
        const ctx = await projectAccess.requireProject(
          asUser(owner), fixture.projectId, 'view', { includeDeleted: true });
        assert.equal(ctx.project.lifecycle_status, 'deleted');
      } finally {
        await db.query(
          `update crawl_projects set lifecycle_status = 'active' where id = $1`, [fixture.projectId]);
      }
    });

    await test('a session with no linked user is refused outright', async () => {
      await assert.rejects(
        projectAccess.requireProject({ user: {} }, fixture.projectId, 'view'),
        (e) => e.status === 403,
      );
    });
  } finally {
    await db.query(`delete from workspace_members where user_id = $1`, [member.userId]);
    await dropProjectFixture(fixture);
    await db.query(`delete from app_users where id = any($1)`, [[outsider.userId, member.userId]]);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await db.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('[projectAccessDb]', e.stack || e.message);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(2);
});
