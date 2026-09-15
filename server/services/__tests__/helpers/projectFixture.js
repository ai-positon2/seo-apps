// ── A complete project fixture for the database-backed suites ───────────────
//
// A project is not one row. It is a workspace, an owner membership, the
// crawl_projects row, and an active primary domain in project_domains — and
// since migration 0027 the database enforces exactly that:
//
//   * crawl_projects.workspace_id  is NOT NULL
//   * project_domains.workspace_id is NOT NULL
//   * a deferred constraint trigger rejects, at COMMIT, any crawl_projects row
//     that has no active primary domain
//
// The suites that need a real project (moduleQueue, aiVisibility budget and
// retention) used to build one with a bare
// `insert into crawl_projects (owner, url, cron, name)`. That is precisely the
// half-built project 0027 exists to make impossible, so it would now fail at
// commit with a message about a missing primary domain — an error about the
// fixture, in a suite that is testing something else entirely.
//
// Building the whole aggregate here keeps that failure from being mistaken for
// a product bug, and means there is one place to change when the shape changes
// again.
//
// Deliberately NOT modules/projects/store.js createProject: these suites must be
// able to set a specific url, cron and name, and they must not drag the admin
// limits, audit trail and cron-stagger machinery into a queue test. This is the
// minimum valid aggregate, written in SQL, on purpose.

const db = require('../../db');

/**
 * Creates a user, their personal workspace, an owner membership, a project and
 * its active primary domain — all committed together.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.prefix]  distinguishes this suite's rows, and seeds the email
 * @param {string}  [opts.url]     the project's primary origin
 * @param {string}  [opts.cron]
 * @param {string}  [opts.name]
 * @returns {Promise<{userId, workspaceId, projectId, domainId, url}>}
 */
async function createProjectFixture({
  prefix = 'fixture',
  url = 'https://fixture-selftest.invalid',
  cron = '0 3 * * *',
  name = null,
} = {}) {
  const email = `_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@position2.com`;
  const host = new URL(url).host;
  const scheme = new URL(url).protocol.replace(':', '');

  return db.tx(async (t) => {
    const user = await t.one(
      `insert into app_users (email) values ($1) returning id`, [email]);

    const workspace = await t.one(
      `insert into workspaces (name, created_by, is_personal)
         values ($1, $2, true) returning id`,
      [`${prefix} workspace`, user.id]
    );
    await t.query(
      `insert into workspace_members (workspace_id, user_id, role)
         values ($1, $2, 'owner')`,
      [workspace.id, user.id]
    );

    const project = await t.one(
      `insert into crawl_projects (owner, workspace_id, url, cron, name)
         values ($1, $2, $3, $4, $5) returning id`,
      [user.id, workspace.id, url, cron, name || `${prefix} self-test`]
    );

    // The row that makes it a project rather than a fragment. Without it the
    // deferred trigger rejects the whole transaction at COMMIT.
    const domain = await t.one(
      `insert into project_domains
         (workspace_id, project_id, role, normalized_origin, host, scheme, raw_input, source, status, created_by)
       values ($1, $2, 'primary', $3, $4, $5, $3, 'user_entered', 'active', $6)
       returning id`,
      [workspace.id, project.id, url, host, scheme, user.id]
    );

    return {
      userId: user.id,
      workspaceId: workspace.id,
      projectId: project.id,
      domainId: domain.id,
      url,
    };
  });
}

/**
 * Removes a fixture. Deleting the project cascades project_domains and every
 * module/run child; deleting the workspace cascades its memberships. Order
 * matters: crawl_projects.workspace_id is ON DELETE RESTRICT since 0027, so the
 * workspace cannot go first.
 */
async function dropProjectFixture(fixture) {
  if (!fixture) return;
  const { projectId, workspaceId, userId } = fixture;
  if (projectId) await db.query(`delete from crawl_projects where id = $1`, [projectId]);
  if (workspaceId) await db.query(`delete from workspaces where id = $1`, [workspaceId]);
  if (userId) await db.query(`delete from app_users where id = $1`, [userId]);
}

module.exports = { createProjectFixture, dropProjectFixture };
