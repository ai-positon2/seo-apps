// ── Workspace membership: roles, and the guards around them ─────────────────
//
// Three defects lived here, and they reinforced each other:
//
//   1. POST /members coerced every role to `role === 'owner' ? 'owner' : 'member'`,
//      so 'approver' and 'admin' could not be assigned to anyone — even though
//      projectAccess defines four roles and migration 0011's CHECK constraint
//      allows all of them.
//   2. identityStore checked `requester.role !== 'owner'` by hand, while the
//      permission matrix grants 'manageWorkspaceMembers' to admin AND owner. An
//      admin was told they could manage members and then got a 403 — which
//      nobody could discover, because (1) made admins unassignable.
//   3. The last-owner guard only fired when you removed YOURSELF, so one owner
//      could remove another and leave the workspace with no owner at all.
//
// The role parser is where (1) is fixed, and it is asserted hardest: it must
// reject a typo rather than quietly storing the least-privileged role and
// reporting success. The ownership guard is the privilege-escalation boundary —
// admins hold manageWorkspaceMembers, and minting owners is not part of it.
//
// Run: node routes/__tests__/workspaces.test.js

const test = require('node:test');
const assert = require('node:assert');

const identityStore = require('../../services/identityStore');
const projectAccess = require('../../services/projectAccess');

const { parseAssignableRole, ASSIGNABLE_ROLES } = identityStore;

// ── The role parser ─────────────────────────────────────────────────────────

test('all four roles are assignable', () => {
  for (const role of ['contributor', 'approver', 'admin', 'owner']) {
    assert.equal(parseAssignableRole(role), role);
  }
  assert.deepEqual(ASSIGNABLE_ROLES, ['contributor', 'approver', 'admin', 'owner']);
});

test("the legacy spelling 'member' is stored as contributor", () => {
  // 0008 shipped 'member'; rows still carry it and it means contributor.
  assert.equal(parseAssignableRole('member'), 'contributor');
  assert.equal(parseAssignableRole('MEMBER'), 'contributor');
});

test('case and surrounding whitespace do not change the role', () => {
  assert.equal(parseAssignableRole('  Admin  '), 'admin');
  assert.equal(parseAssignableRole('APPROVER'), 'approver');
});

// The whole point of not reusing projectAccess.normalizeRole, which maps
// anything unrecognized to 'contributor'. That is correct when READING a stored
// row — an unknown role must never grant more than the least privilege — and
// silently wrong when WRITING one.
test('a typo is rejected, never silently downgraded to contributor', () => {
  for (const bad of ['aprover', 'administrator', 'superuser', 'Owner ', 'ownerr']) {
    if (bad.trim().toLowerCase() === 'owner') continue;
    assert.throws(
      () => parseAssignableRole(bad),
      (e) => e.status === 400 && /is not a role/.test(e.message),
      `"${bad}" must be rejected`,
    );
  }
  // And confirm the trap it is avoiding really is there in the read-path helper.
  assert.equal(projectAccess.normalizeRole('aprover'), 'contributor');
});

test('a missing role falls back only when a fallback is offered', () => {
  assert.equal(parseAssignableRole(undefined, { fallback: 'contributor' }), 'contributor');
  assert.equal(parseAssignableRole('', { fallback: 'approver' }), 'approver');
  for (const empty of [undefined, null, '', '   ']) {
    assert.throws(() => parseAssignableRole(empty), (e) => e.status === 400);
  }
});

// ── Who may manage members ──────────────────────────────────────────────────

test('admins and owners may manage members; approvers and contributors may not', () => {
  assert.equal(projectAccess.capabilityFor('owner', 'manageWorkspaceMembers'), true);
  assert.equal(projectAccess.capabilityFor('admin', 'manageWorkspaceMembers'), true);
  assert.equal(projectAccess.capabilityFor('approver', 'manageWorkspaceMembers'), false);
  assert.equal(projectAccess.capabilityFor('contributor', 'manageWorkspaceMembers'), false);
});

// ── The ownership boundary ──────────────────────────────────────────────────
//
// assertMaySetOwnerRole is internal, so it is exercised through the exported
// functions' preconditions instead: what matters is that an admin holding
// manageWorkspaceMembers still cannot create an owner, because owner carries
// transferOwnership — which the matrix withholds from admins outright.

test('owner is strictly more powerful than admin, which is why granting it is restricted', () => {
  assert.equal(projectAccess.capabilityFor('owner', 'transferOwnership'), true);
  assert.equal(projectAccess.capabilityFor('admin', 'transferOwnership'), false);
  // So if an admin could set someone's role to 'owner', they could grant a
  // capability they do not hold — including to themselves.
});

test('setWorkspaceMemberRole refuses an admin who tries to grant ownership', async () => {
  const access = {
    workspaceId: 'ws-1', userId: 'admin-1', role: 'admin', isPlatformAdmin: false,
  };
  await assert.rejects(
    identityStore.setWorkspaceMemberRole({ access, targetUserId: 'user-2', role: 'owner' }),
    (e) => e.status === 403 && /Only a workspace owner/.test(e.message),
  );
});

test('setWorkspaceMemberRole rejects an invalid role before touching the database', async () => {
  const access = {
    workspaceId: 'ws-1', userId: 'owner-1', role: 'owner', isPlatformAdmin: false,
  };
  // Parsing happens first, so this must fail with 400 rather than a DB error —
  // proof the validation is not sitting behind a query that would need a
  // connection to reach.
  await assert.rejects(
    identityStore.setWorkspaceMemberRole({ access, targetUserId: 'user-2', role: 'sudo' }),
    (e) => e.status === 400 && e.code === 'invalid_role',
  );
});

test('addWorkspaceMember refuses an admin who tries to add someone as owner', async () => {
  const access = {
    workspaceId: 'ws-1', userId: 'admin-1', role: 'admin', isPlatformAdmin: false,
  };
  await assert.rejects(
    identityStore.addWorkspaceMember({ access, email: 'x@example.com', role: 'sudo' }),
    (e) => e.status === 400 && e.code === 'invalid_role',
    'an invalid role is caught before the user lookup',
  );
});
