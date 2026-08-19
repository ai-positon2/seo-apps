// ── Per-user tool run history API ────────────────────────────────────────────
// Read/delete access to the tool_runs rows written by runsStore.saveRun()
// from each tool's own route. Mounted behind requireAuth (server.js), so
// req.user.userId is always present here.

const express = require('express');
const router = express.Router();
const runsStore = require('../services/runsStore');
const { isSupabaseConfigured } = require('../services/supabase');

// GET /api/runs?tool=keyword-research&limit=50
router.get('/', async (req, res) => {
  if (!isSupabaseConfigured() || !req.user.userId) return res.json({ runs: [] });
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const runs = await runsStore.listRuns({ userId: req.user.userId, toolId: req.query.tool, limit });
    res.json({ runs });
  } catch (e) {
    console.error('[runs] list failed:', e.message);
    res.status(500).json({ error: 'Failed to load run history.' });
  }
});

// GET /api/runs/:id
router.get('/:id', async (req, res) => {
  if (!isSupabaseConfigured() || !req.user.userId) return res.status(404).json({ error: 'Run not found.' });
  try {
    const run = await runsStore.getRun(req.params.id, req.user.userId);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    res.json({ run });
  } catch (e) {
    console.error('[runs] get failed:', e.message);
    res.status(500).json({ error: 'Failed to load run.' });
  }
});

// DELETE /api/runs/:id
router.delete('/:id', async (req, res) => {
  if (!isSupabaseConfigured() || !req.user.userId) return res.status(404).json({ error: 'Run not found.' });
  try {
    const ok = await runsStore.deleteRun(req.params.id, req.user.userId);
    if (!ok) return res.status(404).json({ error: 'Run not found.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[runs] delete failed:', e.message);
    res.status(500).json({ error: 'Failed to delete run.' });
  }
});

module.exports = router;
