// ── Runs API ────────────────────────────────────────────────────────────────
// Reads the run history that server/middleware/runTracking.js writes. Always
// scoped to one workspace: the active workspace resolved for the caller (see
// services/workspaceContext.js), and a run's detail is only readable by
// someone who belongs to the workspace the run landed in.

const express = require('express');
const runStore = require('../services/runStore');
const identityStore = require('../services/identityStore');
const { resolveIdentity } = require('../services/workspaceContext');
const { isSupabaseConfigured } = require('../services/supabase');
const { TRACKED_TOOL_IDS } = require('../config/runTracking');

const router = express.Router();

const MAX_LIMIT = 200;

function clampLimit(raw, fallback = 50) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIMIT);
}

// Resolves the workspace this request reads from, plus the workspace's own
// details (name + primary user) so the UI can say whose runs it is showing.
async function activeWorkspace(req) {
  const identity = await resolveIdentity(req);
  if (!identity.workspaceId) return { identity, workspace: null };
  let workspace = null;
  try {
    const all = await identityStore.listWorkspacesForUser(identity.userId);
    workspace = all.find(w => w.id === identity.workspaceId) || null;
  } catch (e) {
    console.error('[runs.activeWorkspace]', e.message);
  }
  return { identity, workspace };
}

function workspaceView(workspace, identity) {
  if (!workspace) return identity.workspaceId ? { id: identity.workspaceId } : null;
  return {
    id: workspace.id,
    name: workspace.name,
    isPersonal: Boolean(workspace.is_personal),
    myRole: workspace.myRole || null,
    ownerEmail: workspace.ownerEmail || null,
  };
}

function notConfigured(res) {
  return res.status(503).json({
    error: 'Run history needs Supabase configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).',
    runs: [], total: 0, workspace: null, trackedTools: TRACKED_TOOL_IDS,
  });
}

// GET /api/runs — the active workspace's run history, newest first.
// Filters: toolId, status, action, q (label search), mine=1, limit, offset.
router.get('/', async (req, res) => {
  if (!isSupabaseConfigured()) return notConfigured(res);
  try {
    const { identity, workspace } = await activeWorkspace(req);
    if (!identity.workspaceId) {
      return res.json({ runs: [], total: 0, workspace: null, trackedTools: TRACKED_TOOL_IDS });
    }

    const limit = clampLimit(req.query.limit);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { runs, total } = await runStore.listRuns({
      workspaceId: identity.workspaceId,
      userId: req.query.mine === '1' ? identity.userId : null,
      toolId: req.query.toolId || null,
      status: req.query.status || null,
      action: req.query.action || null,
      search: req.query.q ? String(req.query.q).slice(0, 120) : null,
      limit,
      offset,
    });

    res.json({
      runs,
      total,
      limit,
      offset,
      workspace: workspaceView(workspace, identity),
      trackedTools: TRACKED_TOOL_IDS,
      viewerUserId: identity.userId || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/runs/stats — per-tool rollup for the active workspace. `toolId`
// narrows it to one tool, for the run panel on that module's own page.
router.get('/stats', async (req, res) => {
  if (!isSupabaseConfigured()) return notConfigured(res);
  try {
    const { identity, workspace } = await activeWorkspace(req);
    if (!identity.workspaceId) {
      return res.json({ tools: [], totals: null, workspace: null, trackedTools: TRACKED_TOOL_IDS });
    }
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const stats = await runStore.runStats({
      workspaceId: identity.workspaceId,
      days,
      toolId: req.query.toolId || null,
    });
    res.json({ ...stats, days, workspace: workspaceView(workspace, identity), trackedTools: TRACKED_TOOL_IDS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/runs/:id — one run with its full input/output. Readable only by a
// member of the workspace the run belongs to (not just the active one, so a
// link to a run in another of your workspaces still opens).
router.get('/:id', async (req, res) => {
  if (!isSupabaseConfigured()) return notConfigured(res);
  try {
    const identity = await resolveIdentity(req);
    if (!identity.userId) return res.status(404).json({ error: 'Run not found.' });

    const workspaces = await identityStore.listWorkspacesForUser(identity.userId);
    const run = await runStore.getRun(req.params.id, workspaces.map(w => w.id));
    if (!run) return res.status(404).json({ error: 'Run not found.' });

    res.json({ run });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
