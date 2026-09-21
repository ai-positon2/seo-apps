// ── Tests for the platform foundation (PRD phase 1) ─────────────────────────
// Covers the decisions that are pure logic, which is deliberately where the
// security-relevant ones live: email normalization, the §7.2 permission matrix,
// and the most-restrictive limit precedence. Everything a wrong answer here
// would cost — an unintended platform admin, a cross-workspace read, a
// workspace policy quietly raising a platform cap — is checked without needing
// a database, so these run in CI on every commit.
//
// Run: node services/__tests__/platformFoundation.test.js

const assert = require('assert');
const platformAdmin = require('../platformAdmin');
const projectAccess = require('../projectAccess');
const adminLimits = require('../adminLimits');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// ── Platform admin identity (PRD §7.3, AC-002) ──────────────────────────────

console.log('\nPlatform admin — email normalization');

test('normalization is trim plus lowercase', () => {
  assert.strictEqual(platformAdmin.normalizeEmail('  Nikhil.Ashok@Position2.com  '), 'nikhil.ashok@position2.com');
  assert.strictEqual(platformAdmin.normalizeEmail('NIKHIL.ASHOK@POSITION2.COM'), 'nikhil.ashok@position2.com');
  assert.strictEqual(platformAdmin.normalizeEmail('\tnikhil.ashok@position2.com\n'), 'nikhil.ashok@position2.com');
});

test('normalization never throws on absent input', () => {
  assert.strictEqual(platformAdmin.normalizeEmail(undefined), '');
  assert.strictEqual(platformAdmin.normalizeEmail(null), '');
  assert.strictEqual(platformAdmin.normalizeEmail(''), '');
});

test('the PRD initial administrator matches, in any casing', () => {
  assert.ok(platformAdmin.isBootstrapAdminEmail('nikhil.ashok@position2.com'));
  assert.ok(platformAdmin.isBootstrapAdminEmail('  Nikhil.Ashok@Position2.COM '));
});

test('the match is exact — not a prefix, suffix, or domain match', () => {
  // The whole point of an exact normalized match: none of these are the admin.
  assert.ok(!platformAdmin.isBootstrapAdminEmail('nikhil.ashok@position2.com.evil.com'));
  assert.ok(!platformAdmin.isBootstrapAdminEmail('evil.nikhil.ashok@position2.com'));
  assert.ok(!platformAdmin.isBootstrapAdminEmail('nikhil.ashok@position2.co'));
  assert.ok(!platformAdmin.isBootstrapAdminEmail('someone.else@position2.com'));
  assert.ok(!platformAdmin.isBootstrapAdminEmail('nikhil.ashok+admin@position2.com'));
  assert.ok(!platformAdmin.isBootstrapAdminEmail(''));
});

test('PLATFORM_ADMIN_EMAILS adds administrators and never removes the initial one', () => {
  const before = process.env.PLATFORM_ADMIN_EMAILS;
  process.env.PLATFORM_ADMIN_EMAILS = ' Second.Admin@Position2.com , third@position2.com ';
  try {
    const emails = platformAdmin.bootstrapEmails();
    assert.ok(emails.includes('nikhil.ashok@position2.com'), 'initial admin is always present');
    assert.ok(emails.includes('second.admin@position2.com'), 'env addition is normalized');
    assert.ok(emails.includes('third@position2.com'));
    assert.strictEqual(new Set(emails).size, emails.length, 'no duplicates');
  } finally {
    if (before === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = before;
  }
});

test('the initial administrator is the address the PRD names', () => {
  assert.strictEqual(platformAdmin.INITIAL_PLATFORM_ADMIN, 'nikhil.ashok@position2.com');
});

// ── Permission matrix (PRD §7.2) ────────────────────────────────────────────

console.log('\nWorkspace authorization — role capabilities');

test("0008's legacy 'member' role reads as contributor, not as more", () => {
  assert.strictEqual(projectAccess.normalizeRole('member'), 'contributor');
  assert.strictEqual(projectAccess.normalizeRole('MEMBER'), 'contributor');
});

test('an unrecognized role degrades to the least privileged one', () => {
  assert.strictEqual(projectAccess.normalizeRole('superuser'), 'contributor');
  assert.strictEqual(projectAccess.normalizeRole(''), 'contributor');
  assert.strictEqual(projectAccess.normalizeRole(undefined), 'contributor');
});

test('a contributor cannot approve, override, or record a shipped date (AC-032)', () => {
  for (const capability of ['approveRecommendation', 'overrideMachineOutcome', 'recordShippedDate', 'editProjectSettings']) {
    assert.strictEqual(
      projectAccess.capabilityFor('contributor', capability), false,
      `contributor must not hold ${capability}`,
    );
  }
});

test('a contributor can still view, run and review', () => {
  for (const capability of ['view', 'startRun', 'reviewFinding', 'editRecommendation']) {
    assert.strictEqual(projectAccess.capabilityFor('contributor', capability), true, capability);
  }
});

// Creating a project and editing one are separate acts, and only the second is
// restricted. Bringing a new site under the team's view is the first thing any
// member needs to do; changing an existing project's settings alters something
// colleagues already depend on. These were briefly the same capability, which
// left a contributor unable to add their own client's site at all.
test('every role can add a new project, including a contributor', () => {
  for (const role of ['contributor', 'approver', 'admin', 'owner']) {
    assert.strictEqual(
      projectAccess.capabilityFor(role, 'createProject'), true,
      `${role} must be able to create a project`,
    );
  }
});

test('being able to create a project does not imply being able to edit one', () => {
  assert.strictEqual(projectAccess.capabilityFor('contributor', 'createProject'), true);
  assert.strictEqual(projectAccess.capabilityFor('contributor', 'editProjectSettings'), false);
});

// ── The creator's grant ─────────────────────────────────────────────────────
// The single, named exception to the role table: whoever created a project may
// edit that project. Without it, a contributor who added a client could not
// correct its name or country without asking an approver.

// Builds what requireProject hands to applyCreatorGrant, for a given role.
function contextFor(role, userId) {
  const ctx = {
    userId,
    role,
    capabilities: projectAccess.capabilityMap(role),
  };
  ctx.can = (name) => projectAccess.capabilityFor(role, name);
  return ctx;
}

test('a contributor may edit the project they created', () => {
  const ctx = contextFor('contributor', 'user-1');
  projectAccess.applyCreatorGrant(ctx, { owner: 'user-1' });
  assert.strictEqual(ctx.can('editProjectSettings'), true);
  assert.strictEqual(ctx.capabilities.editProjectSettings, true, 'the map the client reads must agree');
  assert.strictEqual(ctx.isCreator, true);
});

test("a contributor may NOT edit a colleague's project", () => {
  const ctx = contextFor('contributor', 'user-1');
  projectAccess.applyCreatorGrant(ctx, { owner: 'user-2' });
  assert.strictEqual(ctx.can('editProjectSettings'), false);
  assert.strictEqual(ctx.capabilities.editProjectSettings, false);
  assert.ok(!ctx.isCreator);
});

test('the creator grant covers editing and nothing else', () => {
  const ctx = contextFor('contributor', 'user-1');
  projectAccess.applyCreatorGrant(ctx, { owner: 'user-1' });
  // Approving, destroying and workspace administration are not yours just
  // because you made the project.
  for (const capability of [
    'approveRecommendation', 'overrideMachineOutcome', 'purgeProject',
    'manageWorkspaceMembers', 'configureLimits', 'transferOwnership',
  ]) {
    assert.strictEqual(ctx.can(capability), false, `creator must not gain ${capability}`);
  }
  // Competitors stay on the propose/approve path: each one costs metered
  // SEMrush units, which is what that review is for.
  assert.strictEqual(ctx.can('manageCompetitors'), 'propose');
});

test('a project with no owner recorded grants nothing', () => {
  const ctx = contextFor('contributor', 'user-1');
  projectAccess.applyCreatorGrant(ctx, { owner: null });
  assert.strictEqual(ctx.can('editProjectSettings'), false);
  projectAccess.applyCreatorGrant(ctx, null);
  assert.strictEqual(ctx.can('editProjectSettings'), false);
});

test('a contributor may only PROPOSE a competitor', () => {
  assert.strictEqual(projectAccess.capabilityFor('contributor', 'manageCompetitors'), 'propose');
  assert.strictEqual(projectAccess.capabilityFor('approver', 'manageCompetitors'), true);
});

test('an approver cannot configure the GSC integration or manage members', () => {
  assert.strictEqual(projectAccess.capabilityFor('approver', 'configureGscIntegration'), false);
  assert.strictEqual(projectAccess.capabilityFor('approver', 'manageWorkspaceMembers'), false);
  assert.strictEqual(projectAccess.capabilityFor('admin', 'configureGscIntegration'), true);
  assert.strictEqual(projectAccess.capabilityFor('admin', 'manageWorkspaceMembers'), true);
});

test('only an owner transfers ownership', () => {
  assert.strictEqual(projectAccess.capabilityFor('owner', 'transferOwnership'), true);
  assert.strictEqual(projectAccess.capabilityFor('admin', 'transferOwnership'), false);
  assert.strictEqual(projectAccess.capabilityFor('approver', 'transferOwnership'), false);
});

test('only a platform administrator configures limits — no workspace role can', () => {
  for (const role of ['contributor', 'approver', 'admin', 'owner']) {
    assert.strictEqual(projectAccess.capabilityFor(role, 'configureLimits'), false, role);
  }
  assert.strictEqual(projectAccess.capabilityFor('owner', 'configureLimits', { platformAdmin: true }), true);
});

test('a platform administrator does not inherit ownership-only workspace acts', () => {
  // §7.2: workspace deletion and restore are owner/admin rows with no platform
  // column — support scope is not the same as being in the workspace.
  assert.strictEqual(projectAccess.capabilityFor('contributor', 'requestWorkspaceDeletion', { platformAdmin: true }), false);
  assert.strictEqual(projectAccess.capabilityFor('contributor', 'restorePendingDeletion', { platformAdmin: true }), false);
});

test('permanently deleting a project stops at admin and owner', () => {
  // Deliberately narrower than editProjectSettings, which an approver holds: an
  // approver may delete a project, which a restore undoes, but not erase it.
  assert.strictEqual(projectAccess.capabilityFor('owner', 'purgeProject'), true);
  assert.strictEqual(projectAccess.capabilityFor('admin', 'purgeProject'), true);
  assert.strictEqual(projectAccess.capabilityFor('approver', 'purgeProject'), false);
  assert.strictEqual(projectAccess.capabilityFor('contributor', 'purgeProject'), false);
  // And withheld from a platform administrator, like the workspace lifecycle
  // acts above — seeing every workspace is not the same as being entitled to
  // destroy a customer's crawl history.
  assert.strictEqual(projectAccess.capabilityFor('owner', 'purgeProject', { platformAdmin: true }), true);
  assert.strictEqual(projectAccess.capabilityFor('contributor', 'purgeProject', { platformAdmin: true }), false);
});

test('an unknown capability name denies instead of defaulting open', () => {
  assert.strictEqual(projectAccess.capabilityFor('owner', 'deleteEverything'), false);
  assert.strictEqual(projectAccess.capabilityFor('owner', 'aproveRecomendation'), false); // typo
});

test('assertCapability distinguishes denied from propose-only', () => {
  const contributor = {
    role: 'contributor',
    can: (name) => projectAccess.capabilityFor('contributor', name),
  };
  assert.throws(
    () => projectAccess.assertCapability(contributor, 'approveRecommendation'),
    (e) => e.status === 403 && /not allowed/i.test(e.message),
  );
  assert.throws(
    () => projectAccess.assertCapability(contributor, 'manageCompetitors'),
    (e) => e.status === 403 && /only propose/i.test(e.message),
  );
  assert.strictEqual(projectAccess.assertCapability(contributor, 'view'), contributor);
});

test('capabilityMap covers every declared capability', () => {
  const map = projectAccess.capabilityMap('approver');
  assert.deepStrictEqual(
    Object.keys(map).sort(),
    Object.keys(projectAccess.CAPABILITIES).sort(),
  );
});

// ── Limit precedence (PRD §10.2, §30.5) ─────────────────────────────────────

console.log('\nAdmin limits — most restrictive wins');

test('with no policies at all, the seeded defaults apply', () => {
  const { limits, sources } = adminLimits.combine([]);
  assert.strictEqual(limits.maxUrlsPerCrawl, 500);
  assert.strictEqual(sources.maxUrlsPerCrawl, 'default');
});

test('a lower ceiling from a narrower scope wins', () => {
  const { limits, sources } = adminLimits.combine([
    { scope: 'platform',  limits: { maxUrlsPerCrawl: 5000 } },
    { scope: 'workspace', limits: { maxUrlsPerCrawl: 500 } },
  ]);
  assert.strictEqual(limits.maxUrlsPerCrawl, 500);
  assert.strictEqual(sources.maxUrlsPerCrawl, 'workspace');
});

test('a narrower scope cannot RAISE a ceiling', () => {
  // The failure this guards: a workspace policy loosening a platform cap.
  const { limits, sources } = adminLimits.combine([
    { scope: 'platform',  limits: { maxUrlsPerCrawl: 5000 } },
    { scope: 'workspace', limits: { maxUrlsPerCrawl: 100000 } },
  ]);
  assert.strictEqual(limits.maxUrlsPerCrawl, 5000);
  assert.strictEqual(sources.maxUrlsPerCrawl, 'platform');
});

test('for a floor, the HIGHER value is the restrictive one', () => {
  const { limits, sources } = adminLimits.combine([
    { scope: 'platform',  limits: { scheduleMinIntervalHours: 24 } },
    { scope: 'workspace', limits: { scheduleMinIntervalHours: 168 } },  // weekly minimum
  ]);
  assert.strictEqual(limits.scheduleMinIntervalHours, 168, 'a longer minimum interval restricts more');
  assert.strictEqual(sources.scheduleMinIntervalHours, 'workspace');

  const loosened = adminLimits.combine([
    { scope: 'platform',  limits: { scheduleMinIntervalHours: 168 } },
    { scope: 'workspace', limits: { scheduleMinIntervalHours: 1 } },
  ]);
  assert.strictEqual(loosened.limits.scheduleMinIntervalHours, 168, 'cannot be shortened by a narrower scope');
});

test('the tier layer participates and can tighten further', () => {
  const { limits, sources } = adminLimits.combine([
    { scope: 'platform',  limits: { maxUrlsPerCrawl: 5000 } },
    { scope: 'workspace', limits: { maxUrlsPerCrawl: 2000 } },
    { scope: 'tier',      limits: { maxUrlsPerCrawl: 750 } },
  ]);
  assert.strictEqual(limits.maxUrlsPerCrawl, 750);
  assert.strictEqual(sources.maxUrlsPerCrawl, 'tier');
});

test('the recovery window is most-specific-wins, not most-restrictive', () => {
  // Shrinking a recovery window is more destructive, not more restrictive, so
  // this key deliberately does not follow the min rule.
  const shortened = adminLimits.combine([
    { scope: 'platform',  limits: { workspacePurgeGraceDays: 30 } },
    { scope: 'workspace', limits: { workspacePurgeGraceDays: 60 } },
  ]);
  assert.strictEqual(shortened.limits.workspacePurgeGraceDays, 60);
  assert.strictEqual(shortened.sources.workspacePurgeGraceDays, 'workspace');
});

test('a stale key from an older policy is ignored, not merged in', () => {
  const { limits } = adminLimits.combine([
    { scope: 'platform', limits: { maxUrlsPerCrawl: 400, legacyThing: 1 } },
  ]);
  assert.strictEqual(limits.maxUrlsPerCrawl, 400);
  assert.ok(!('legacyThing' in limits));
});

test('a non-numeric policy value is skipped rather than producing NaN', () => {
  const { limits, sources } = adminLimits.combine([
    { scope: 'platform', limits: { maxUrlsPerCrawl: 'lots' } },
  ]);
  assert.strictEqual(limits.maxUrlsPerCrawl, 500);
  assert.strictEqual(sources.maxUrlsPerCrawl, 'default');
});

console.log('\nAdmin limits — policy validation');

test('an unknown limit key is rejected, not silently dropped', () => {
  assert.throws(
    () => adminLimits.validateLimits({ maxUrls: 100 }),          // not the real key
    (e) => e.status === 400 && /Unknown limit key/.test(e.message),
  );
});

test('negative and non-numeric values are rejected', () => {
  assert.throws(() => adminLimits.validateLimits({ maxUrlsPerCrawl: -1 }), (e) => e.status === 400);
  assert.throws(() => adminLimits.validateLimits({ maxUrlsPerCrawl: 'ten' }), (e) => e.status === 400);
});

test('an empty policy is rejected', () => {
  assert.throws(() => adminLimits.validateLimits({}), (e) => e.status === 400);
  assert.throws(() => adminLimits.validateLimits(null), (e) => e.status === 400);
});

test('numeric strings are coerced, so a form post is accepted', () => {
  assert.deepStrictEqual(adminLimits.validateLimits({ maxUrlsPerCrawl: '2500' }), { maxUrlsPerCrawl: 2500 });
});

test('every default key declares a combination direction', () => {
  for (const key of adminLimits.LIMIT_KEYS) {
    assert.ok(
      ['min', 'max', 'specific'].includes(adminLimits.DIRECTION[key]),
      `${key} has no declared direction — combine() would silently assume 'min'`,
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
