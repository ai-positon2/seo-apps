const express = require('express');
const { runAudit } = require('./auditor');
const { getAudit, listAudits, deleteAudit } = require('./store');

const router = express.Router();

// In-memory job tracking for polling
const jobs = new Map(); // jobId → { status, auditId, progress, error }

// POST /api/on-page-audit/run
router.post('/run', async (req, res) => {
  const { url, primaryKeywords } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const kws = Array.isArray(primaryKeywords) ? primaryKeywords
    : (typeof primaryKeywords === 'string' && primaryKeywords.trim()) ? [primaryKeywords.trim()]
    : [];

  if (kws.length === 0) return res.status(400).json({ error: 'primaryKeywords is required' });

  const jobId = `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  jobs.set(jobId, { status: 'running', auditId: null, progress: 'Starting…', error: null });

  // The tracked run (server/config/runTracking.js marks this endpoint
  // `deferred`) outlives the response below, so it is closed out here, where
  // the audit actually settles — not when the jobId is handed back.
  const run = req.run;

  // Fire-and-forget
  (async () => {
    try {
      const audit = await runAudit(url, kws, (msg) => {
        const job = jobs.get(jobId);
        if (job) job.progress = msg;
      });
      jobs.set(jobId, { status: 'complete', auditId: audit.id, progress: 'Done', error: audit.errorMessage || null });
      run?.finish({ output: { jobId, auditId: audit.id, url, keywords: kws, warning: audit.errorMessage || null } });
    } catch (err) {
      jobs.set(jobId, { status: 'failed', auditId: null, progress: 'Failed', error: err.message });
      run?.fail(err.message, { output: { jobId, url, keywords: kws } });
    }
  })();

  res.json({ jobId });
});

// GET /api/on-page-audit/status/:jobId
router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET /api/on-page-audit/result/:auditId
router.get('/result/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  res.json(audit);
});

// GET /api/on-page-audit/list
router.get('/list', async (req, res) => {
  const audits = await listAudits();
  res.json(audits);
});

// DELETE /api/on-page-audit/:auditId
router.delete('/:auditId', async (req, res) => {
  await deleteAudit(req.params.auditId);
  res.json({ ok: true });
});

module.exports = router;
