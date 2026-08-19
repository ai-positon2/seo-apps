const express = require('express');
const identityStore = require('../services/identityStore');
const router = express.Router();

// GET /api/profile — the current user's profile, or null if not set up yet.
router.get('/', async (req, res) => {
  if (!req.user.userId) return res.json({ profile: null, companyLocked: false });
  try {
    const profile = await identityStore.getProfile(req.user.userId);
    res.json({
      profile,
      companyLocked: identityStore.isPosition2Email(req.user.username),
      lockedCompanyName: 'Position2',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/profile { fullName, company } — creates or updates the profile.
// Company is forced to "Position2" server-side for @position2.com emails,
// no matter what the client sends.
router.post('/', async (req, res) => {
  if (!req.user.userId) return res.status(400).json({ error: 'This session has no linked user.' });
  const { fullName, company } = req.body || {};
  if (!fullName || !fullName.trim()) return res.status(400).json({ error: 'Full name is required.' });
  if (!identityStore.isPosition2Email(req.user.username) && !(company || '').trim()) {
    return res.status(400).json({ error: 'Company is required.' });
  }

  try {
    const profile = await identityStore.upsertProfile(req.user.userId, req.user.username, {
      fullName: fullName.trim(),
      company: (company || '').trim(),
    });
    res.json({ profile });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
