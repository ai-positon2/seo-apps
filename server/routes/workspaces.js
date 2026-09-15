const express = require('express');
const identityStore = require('../services/identityStore');
const workspaceContext = require('../services/workspaceContext');
const projectAccess = require('../services/projectAccess');
const projectStore = require('../modules/projects/store');
const workspaceLifecycle = require('../services/workspaceLifecycle');
const { COOKIE_OPTIONS, WORKSPACE_COOKIE } = require('./auth');
const router = express.Router();

// Runs are recorded against the workspace the user is currently working in.
// A month is long enough that the choice sticks across sessions.
const WORKSPACE_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

function requireUserId(req, res) {
  if (!req.user.userId) {
    res.status(400).json({ error: 'This session has no linked user.' });
    return null;
  }
  return req.user.userId;
}

// A status on the error means it was raised deliberately, with a message meant
// for the caller (invalid_role, last_owner, forbidden, …). Anything else is an
// internal failure, and its message is not safe to echo: identityStore reports
// a dead database as `[identityStore.getWorkspace] upstream unavailable:
// connect ECONNREFUSED <host>:<port>`, and a bad credential as `password
// authentication failed for user "…"`. Both were being returned verbatim to
// any signed-in caller. Logged here, never sent — the same rule server.js's
// final error handler and routes/admin.js already follow.
function handleError(res, e, req) {
  if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error('[workspaces]', req?.method, req?.originalUrl, e?.stack || e?.message || e);
  res.status(500).json({ error: 'Something went wrong with that workspace request.' });
}

// GET /api/workspaces — workspaces the current user belongs to, plus which
// one is active (the one their runs are being recorded against).
router.get('/', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const workspaces = await identityStore.listWorkspacesForUser(userId);
    const { workspaceId: activeId } = await workspaceContext.resolveIdentity(req);
    // How many projects each one holds. Without this the list is a set of names
    // with no way to tell a workspace holding a client's whole audit history
    // from an empty one somebody made and never used.
    const summaries = await projectStore.summariesForWorkspaces(workspaces.map(w => w.id));
    res.json({
      workspaces: workspaces.map(w => ({
        ...w,
        active: w.id === activeId,
        projectCount: (summaries.get(w.id) || []).length,
      })),
      activeWorkspaceId: activeId || null,
    });
  } catch (e) { handleError(res, e, req); }
});

// POST /api/workspaces/:id/activate — switch the workspace this user's runs
// are recorded against. Membership is checked here and again on every use.
router.post('/:id/activate', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    if (!(await identityStore.isWorkspaceMember(req.params.id, userId))) {
      return res.status(403).json({ error: 'You are not a member of that workspace.' });
    }
    res.cookie(WORKSPACE_COOKIE, req.params.id, { ...COOKIE_OPTIONS, maxAge: WORKSPACE_COOKIE_MAX_AGE });
    workspaceContext.setActiveWorkspace(userId, req.params.id, req.user.username);
    res.json({ ok: true, activeWorkspaceId: req.params.id });
  } catch (e) { handleError(res, e, req); }
});

// POST /api/workspaces { name } — creates a workspace; caller becomes its owner.
router.post('/', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Workspace name is required.' });
  try {
    res.json({
      workspace: await identityStore.createWorkspace(userId, name.trim(), req.user.username),
    });
  } catch (e) { handleError(res, e, req); }
});

// GET /api/workspaces/:id — workspace details + members (must be a member).
router.get('/:id', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const workspace = await identityStore.getWorkspace(req.params.id, userId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found.' });
    // Membership was just checked above, so the projects inside it are readable
    // by this caller by definition — the workspace IS the authorization boundary.
    const summaries = await projectStore.summariesForWorkspaces([workspace.id]);

    // What this caller may DO here, resolved by the same matrix the routes
    // enforce. The screen used to gate its member controls on
    // `myRole === 'owner'`, which hid them from an admin who is allowed to use
    // them — a second, hand-rolled copy of the permission rules that disagreed
    // with the real one.
    const role = projectAccess.normalizeRole(workspace.myRole);
    res.json({
      workspace: {
        ...workspace,
        projects: summaries.get(workspace.id) || [],
        capabilities: projectAccess.capabilityMap(role),
        // Granting or revoking ownership stays with owners even though admins
        // hold manageWorkspaceMembers, so the role picker needs to know.
        canAssignOwner: role === 'owner',
        assignableRoles: identityStore.ASSIGNABLE_ROLES,
        viewerUserId: userId,
      },
    });
  } catch (e) { handleError(res, e, req); }
});

// ── Members ─────────────────────────────────────────────────────────────────
//
// All three routes authorize through projectAccess with 'manageWorkspaceMembers',
// which the permission matrix grants to admin AND owner. They used to check
// `role === 'owner'` by hand inside identityStore, which disagreed with the
// matrix — and the add route coerced every role to 'owner' or 'member', so
// 'admin' and 'approver' could not be assigned to anyone in the first place.
// Both halves of that are fixed here: the capability decides who may call, and
// the role in the body is validated against the real list.

// POST /api/workspaces/:id/members { email, role }
router.post('/:id/members', async (req, res) => {
  const { email, role } = req.body || {};
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required.' });
  try {
    const access = await projectAccess.requireWorkspace(req, req.params.id, 'manageWorkspaceMembers');
    const member = await identityStore.addWorkspaceMember({
      access, email: email.trim(), role,
    });
    // Their effective workspace may change as a result, so drop any cached
    // resolution rather than leaving them pointed at a stale one.
    workspaceContext.invalidate(member.user_id);
    res.json({ member });
  } catch (e) { handleError(res, e, req); }
});

// PATCH /api/workspaces/:id/members/:userId { role } — change an existing role.
// Its own route rather than remove-and-re-add, which drops the membership row
// and loses added_at: the record of how long someone has had access.
router.patch('/:id/members/:userId', async (req, res) => {
  try {
    const access = await projectAccess.requireWorkspace(req, req.params.id, 'manageWorkspaceMembers');
    const member = await identityStore.setWorkspaceMemberRole({
      access, targetUserId: req.params.userId, role: req.body?.role,
    });
    workspaceContext.invalidate(req.params.userId);
    res.json({ member });
  } catch (e) { handleError(res, e, req); }
});

// DELETE /api/workspaces/:id/members/:userId
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const access = await projectAccess.requireWorkspace(req, req.params.id, 'manageWorkspaceMembers');
    await identityStore.removeWorkspaceMember({ access, targetUserId: req.params.userId });
    // The removed member may have had this workspace active — drop their
    // cached resolution so the next request falls back to one they can use.
    workspaceContext.invalidate(req.params.userId);
    res.json({ ok: true });
  } catch (e) { handleError(res, e, req); }
});

// GET /api/workspaces/:id/member-events — who was given or lost access, when,
// and who did it.
//
// workspace_member_events has existed since migration 0011 and had no writer
// until the membership functions were rewritten, and no reader until this. A
// history written but never readable answers no question anybody actually asks.
//
// Readable by any member, not just those who can manage membership: knowing who
// else can see your workspace's clients is not an administrative privilege, and
// every one of these people can already list each other through GET /:id.
router.get('/:id/member-events', async (req, res) => {
  try {
    const access = await projectAccess.requireWorkspace(req, req.params.id);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const events = await identityStore.listMemberEvents(access.workspaceId, { limit });
    res.json({ events });
  } catch (e) { handleError(res, e, req); }
});

// ── Lifecycle (PRD §3.3.4, phase 2) ─────────────────────────────────────────
//
// Deletion is a request with a grace period, not an immediate destruction. The
// capability check is the shared one: 'requestWorkspaceDeletion' is granted to
// admin and owner and explicitly NOT to a platform administrator, who can see
// every workspace — being able to destroy any of them is a different power.

// POST /api/workspaces/:id/request-deletion  { reason }
router.post('/:id/request-deletion', async (req, res) => {
  try {
    const access = await projectAccess.requireWorkspace(req, req.params.id, 'requestWorkspaceDeletion');
    const result = await workspaceLifecycle.requestDeletion({ access, reason: req.body?.reason });
    res.json({
      workspace: result.workspace,
      purgeAfter: result.purgeAfter,
      graceDays: result.graceDays,
      message:
        `This workspace and everything in it will be permanently deleted after `
        + `${result.graceDays} days. It stays fully usable and restorable until then.`,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('[workspaces.requestDeletion]', e.message);
    res.status(500).json({ error: 'Could not request deletion.' });
  }
});

// POST /api/workspaces/:id/restore — cancels a pending deletion.
router.post('/:id/restore', async (req, res) => {
  try {
    const access = await projectAccess.requireWorkspace(req, req.params.id, 'restorePendingDeletion');
    res.json(await workspaceLifecycle.restore({ access }));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('[workspaces.restore]', e.message);
    res.status(500).json({ error: 'Could not restore the workspace.' });
  }
});

module.exports = router;
