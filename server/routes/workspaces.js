const express = require('express');
const identityStore = require('../services/identityStore');
const workspaceContext = require('../services/workspaceContext');
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

function handleError(res, e) {
  res.status(e.status || 500).json({ error: e.message });
}

// GET /api/workspaces — workspaces the current user belongs to, plus which
// one is active (the one their runs are being recorded against).
router.get('/', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const workspaces = await identityStore.listWorkspacesForUser(userId);
    const { workspaceId: activeId } = await workspaceContext.resolveIdentity(req);
    res.json({
      workspaces: workspaces.map(w => ({ ...w, active: w.id === activeId })),
      activeWorkspaceId: activeId || null,
    });
  } catch (e) { handleError(res, e); }
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
  } catch (e) { handleError(res, e); }
});

// POST /api/workspaces { name } — creates a workspace; caller becomes its owner.
router.post('/', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Workspace name is required.' });
  try {
    res.json({ workspace: await identityStore.createWorkspace(userId, name.trim()) });
  } catch (e) { handleError(res, e); }
});

// GET /api/workspaces/:id — workspace details + members (must be a member).
router.get('/:id', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const workspace = await identityStore.getWorkspace(req.params.id, userId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found.' });
    res.json({ workspace });
  } catch (e) { handleError(res, e); }
});

// POST /api/workspaces/:id/members { email, role } — owner-only.
router.post('/:id/members', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const { email, role } = req.body || {};
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required.' });
  try {
    const member = await identityStore.addWorkspaceMember(req.params.id, userId, email.trim(), role === 'owner' ? 'owner' : 'member');
    res.json({ member });
  } catch (e) { handleError(res, e); }
});

// DELETE /api/workspaces/:id/members/:userId — owner-only.
router.delete('/:id/members/:userId', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    await identityStore.removeWorkspaceMember(req.params.id, userId, req.params.userId);
    // The removed member may have had this workspace active — drop their
    // cached resolution so the next request falls back to one they can use.
    workspaceContext.invalidate(req.params.userId);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

module.exports = router;
