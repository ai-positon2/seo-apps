const express = require('express');
const router = express.Router();
const store = require('../services/kbStore');

// GET /api/kb  — list all KBs (index entries only, no file body)
router.get('/', async (req, res) => {
  try {
    const list = await store.listKBs();
    res.json({ knowledge_bases: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kb/:id  — read full KB (meta + body)
router.get('/:id', async (req, res) => {
  try {
    const kb = await store.readKB(req.params.id);
    if (!kb) return res.status(404).json({ error: `KB "${req.params.id}" not found.` });
    res.json(kb);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/kb/:id  — update KB (auto-increments version, appends changelog)
router.put('/:id', async (req, res) => {
  try {
    const { meta, body, changeNote } = req.body;
    if (!meta || body === undefined) return res.status(400).json({ error: 'meta and body are required.' });
    const updated = await store.writeKB(req.params.id, meta, body, changeNote || 'Updated');
    res.json({ ok: true, meta: updated });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// POST /api/kb  — create new KB
router.post('/', async (req, res) => {
  try {
    const result = await store.createKB(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(err.message.includes('already exists') ? 409 : 500).json({ error: err.message });
  }
});

// DELETE /api/kb/:id  — permanently delete a KB
router.delete('/:id', async (req, res) => {
  try {
    await store.deleteKB(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// PATCH /api/kb/:id/toggle  — toggle active/inactive
router.patch('/:id/toggle', async (req, res) => {
  try {
    const nowActive = await store.toggleActive(req.params.id);
    res.json({ ok: true, active: nowActive });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

module.exports = router;
