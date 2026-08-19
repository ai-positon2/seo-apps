const express = require('express');
const identityStore = require('../services/identityStore');
const router = express.Router();

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

// GET /api/workspaces — workspaces the current user belongs to.
router.get('/', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    res.json({ workspaces: await identityStore.listWorkspacesForUser(userId) });
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
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

module.exports = router;
