const express = require('express');
const router = express.Router();
const store = require('../services/kbStore');

// GET /api/modules  — list all module manifests
router.get('/', async (req, res) => {
  try {
    const modules = await store.listModules();
    res.json({ modules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/modules/:id  — get one module manifest
router.get('/:id', async (req, res) => {
  try {
    const mod = await store.readModule(req.params.id);
    res.json(mod);
  } catch {
    res.status(404).json({ error: `Module "${req.params.id}" not found.` });
  }
});

// PUT /api/modules/:id  — update module manifest
router.put('/:id', async (req, res) => {
  try {
    const updated = await store.writeModule(req.params.id, req.body);
    res.json({ ok: true, manifest: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
