// ── Revoking a platform administrator, against a real database ─────────────
//
// Two defects made revocation impossible to rely on:
//
//   1. revokeAdmin counted the active grants with `select count(*) … for update`.
//      Postgres refuses FOR UPDATE alongside an aggregate, so every revoke
//      failed with a 500 — including the ones the last-admin guard allows.
//   2. ensureBootstrapGrants runs on every boot and re-seeded any bootstrap
//      address without an ACTIVE grant. Revoking a bootstrap administrator
//      therefore lasted only until the next deploy or restart.
//
// Needs a real database: (1) is a Postgres rule, which a fake could only
// restate. Skips without TEST_DATABASE_URL; see helpers/testDatabase.js.
//
// Run: TEST_DATABASE_URL=postgres://... node services/__tests__/platformAdminDb.test.js

const assert = require('node:assert/strict');
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { useTestDatabase } = require('./helpers/testDatabase');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// Must run before services/db builds its pool.
if (!useTestDatabase('platformAdmin (database)')) {
  process.exit(0);
}

// A bootstrap address of this suite's own, so the assertions do not depend on
// whatever the migrations seeded for the real one.
const BOOTSTRAP = 'bootstrap-admin@platform-admin-test.example';
process.env.PLATFORM_ADMIN_EMAILS = BOOTSTRAP;

const db = require('../db');
const platformAdmin = require('../platformAdmin');

const OTHER = 'other-admin@platform-admin-test.example';
const THIRD = 'third-admin@platform-admin-test.example';

async function reset() {
  await db.query(`delete from platform_admin_grants where normalized_email like '%@platform-admin-test.example'`);
  // The suite's rows must be the only active ones, or the last-admin count is
  // someone else's. Revoked rather than deleted: the migrations' seed is real data.
  await db.query(`update platform_admin_grants set status = 'revoked', revoked_at = now() where status = 'active'`);
  platformAdmin.invalidate();
}

async function grant(email) {
  return db.one(
    `insert into platform_admin_grants (normalized_email, grant_source) values ($1, 'admin_ui') returning *`,
    [email]);
}

(async () => {
  console.log('platformAdmin (database)');

  await test('a grant can be revoked while another administrator remains', async () => {
    await reset();
    const a = await grant(OTHER);
    await grant(THIRD);
    const revoked = await platformAdmin.revokeAdmin({ grantId: a.id, actorEmail: 'tester' });
    assert.equal(revoked.status, 'revoked');
    assert.equal(await platformAdmin.isPlatformAdmin({ email: OTHER }), false);
    assert.equal(await platformAdmin.isPlatformAdmin({ email: THIRD }), true);
  });

  await test('the last active administrator still cannot be revoked', async () => {
    await reset();
    const only = await grant(OTHER);
    await assert.rejects(
      platformAdmin.revokeAdmin({ grantId: only.id, actorEmail: 'tester' }),
      (e) => e.status === 400 && /last platform administrator/.test(e.message),
    );
  });

  await test('a revoked bootstrap administrator is not re-granted at the next boot', async () => {
    await reset();
    await grant(OTHER); // so the bootstrap grant is not the last one
    await platformAdmin.ensureBootstrapGrants();
    const seeded = await db.one(
      `select * from platform_admin_grants where normalized_email = $1 and status = 'active'`, [BOOTSTRAP]);
    await platformAdmin.revokeAdmin({ grantId: seeded.id, actorEmail: 'tester' });

    await platformAdmin.ensureBootstrapGrants(); // the next deploy
    platformAdmin.invalidate();
    assert.equal(await platformAdmin.isPlatformAdmin({ email: BOOTSTRAP }), false,
      'revoking a bootstrap administrator must survive a restart');
  });

  await test('a bootstrap address with no grant history is still seeded', async () => {
    await reset();
    const result = await platformAdmin.ensureBootstrapGrants();
    assert.ok(result.seeded.includes(BOOTSTRAP));
    assert.equal(await platformAdmin.isPlatformAdmin({ email: BOOTSTRAP }), true);
  });

  await reset();
  await db.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
