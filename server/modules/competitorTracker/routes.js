const express = require('express');
const store = require('./store');
const { runDashboardRefresh, getStatus, reinitScheduler } = require('./scheduler');
const semrushBudget = require('./semrushBudget');
const { renderDashboardPdf } = require('./exportPdf');

const router = express.Router();

function isValidScheduleTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

function cleanDomain(str) {
  return (str || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// ── Clients ───────────────────────────────────────────────────────────────────

router.get('/clients', async (req, res) => {
  try {
    res.json(await store.getClients());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clients', async (req, res) => {
  const { name, domain, country, brandName } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    res.status(201).json(await store.addClient({ name: name.trim(), domain: cleanDomain(domain), country, brandName }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/clients/:clientId', async (req, res) => {
  const { name, domain, country, brandName } = req.body || {};
  const fields = {};
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    fields.name = name.trim();
  }
  if (domain !== undefined) fields.domain = cleanDomain(domain);
  if (country !== undefined) fields.country = country;
  if (brandName !== undefined) fields.brandName = brandName;

  try {
    res.json(await store.updateClient(req.params.clientId, fields));
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

router.delete('/clients/:clientId', async (req, res) => {
  try {
    await store.deleteClient(req.params.clientId);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// ── Competitors ───────────────────────────────────────────────────────────────

router.post('/clients/:clientId/competitors', async (req, res) => {
  const { domain, label } = req.body || {};
  const cleaned = cleanDomain(domain);
  if (!cleaned) return res.status(400).json({ error: 'domain is required' });
  try {
    res.status(201).json(await store.addCompetitor(req.params.clientId, { domain: cleaned, label }));
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

router.patch('/clients/:clientId/competitors/:competitorId', async (req, res) => {
  const { domain, label } = req.body || {};
  const fields = {};
  if (domain !== undefined) {
    const cleaned = cleanDomain(domain);
    if (!cleaned) return res.status(400).json({ error: 'domain cannot be empty' });
    fields.domain = cleaned;
  }
  if (label !== undefined) fields.label = label;

  try {
    res.json(await store.updateCompetitor(req.params.clientId, req.params.competitorId, fields));
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

router.delete('/clients/:clientId/competitors/:competitorId', async (req, res) => {
  try {
    await store.deleteCompetitor(req.params.clientId, req.params.competitorId);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// ── Dashboard data (cached — never triggers a live API call) ─────────────────

router.get('/clients/:clientId/dashboard', async (req, res) => {
  try {
    const client = await store.getClient(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const [snapshot, insights, aiVisibility] = await Promise.all([
      store.getDashboardSnapshot(req.params.clientId),
      store.getInsights(req.params.clientId),
      store.getAIVisibility(req.params.clientId),
    ]);
    res.json({ client, snapshot, insights, aiVisibility });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI Visibility — manual entry (no public SEMrush API for this) ────────────

router.put('/clients/:clientId/ai-visibility', async (req, res) => {
  const { domains } = req.body || {};
  if (!domains || typeof domains !== 'object') return res.status(400).json({ error: 'domains object is required' });
  try {
    await store.saveAIVisibility(req.params.clientId, { domains });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Run control ───────────────────────────────────────────────────────────────

router.post('/run', async (req, res) => {
  const status = getStatus();
  if (status.isRunning) {
    return res.status(409).json({ error: 'RUN_IN_PROGRESS', message: 'A run is already in progress' });
  }
  res.json({ ok: true, runId: 'run_manual_' + Date.now().toString(36) });
  runDashboardRefresh({ triggeredBy: 'manual' }).catch(err => {
    console.error('[CompetitorAnalysis] Manual run failed:', err.message);
  });
});

router.get('/run/status', (req, res) => {
  res.json(getStatus());
});

// ── SEMrush credit budget ──────────────────────────────────────────────────────

router.get('/semrush-usage', async (req, res) => {
  try {
    res.json(await semrushBudget.getTodayUsage());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Schedule config ───────────────────────────────────────────────────────────

router.get('/schedule', async (req, res) => {
  try {
    res.json(await store.getRunConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/schedule', async (req, res) => {
  const { scheduleTime, timezone, enabled } = req.body || {};
  if (scheduleTime && !isValidScheduleTime(scheduleTime)) {
    return res.status(400).json({ error: 'scheduleTime must be HH:MM (24-hour)' });
  }
  try {
    const existing = await store.getRunConfig();
    const config = {
      scheduleTime: scheduleTime || existing.scheduleTime,
      timezone: timezone || existing.timezone,
      enabled: enabled !== undefined ? Boolean(enabled) : existing.enabled,
    };
    await store.saveRunConfig(config);
    await reinitScheduler();
    res.json({ ok: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Export ────────────────────────────────────────────────────────────────────

router.get('/clients/:clientId/export.csv', async (req, res) => {
  try {
    const client = await store.getClient(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const snapshot = await store.getDashboardSnapshot(req.params.clientId);
    if (!snapshot) return res.status(409).json({ error: 'No data yet — run a refresh first.' });

    const headers = ['Domain', 'Is Client', 'Authority Score', 'Home Page Authority', 'Organic Traffic', 'Organic Keywords', 'Backlinks', 'Referring Domains', 'AI Overview Keywords', 'Branded Keywords', 'Non-branded Keywords', 'Mobile PSI', 'Desktop PSI'];
    const rows = snapshot.domains.map(d => [
      d.domain, d.isClient ? 'Yes' : 'No', d.authorityScore ?? '', d.homepageAuthorityScore ?? '',
      d.domainRank?.organicTraffic ?? '', d.domainRank?.organicKeywords ?? '',
      d.backlinks?.totalBacklinks ?? '', d.backlinks?.referringDomains ?? '', d.aioKeywordCount ?? '',
      d.brandedKeywordCount != null ? `${d.brandedKeywordCount}${d.brandedKeywordCountCapped ? '+' : ''}` : '',
      d.nonBrandedKeywordCount ?? '', d.pageSpeed?.mobile?.score ?? '', d.pageSpeed?.desktop?.score ?? '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${client.name.replace(/\s+/g, '_')}_competitor_analysis.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/clients/:clientId/export.pdf', async (req, res) => {
  try {
    const client = await store.getClient(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const [snapshot, insights] = await Promise.all([
      store.getDashboardSnapshot(req.params.clientId),
      store.getInsights(req.params.clientId),
    ]);
    if (!snapshot) return res.status(409).json({ error: 'No data yet — run a refresh first.' });

    const pdfBuffer = await renderDashboardPdf({ client, snapshot, insights });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${client.name.replace(/\s+/g, '_')}_competitor_analysis.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[CompetitorAnalysis] PDF export failed:', err.message);
    res.status(500).json({ error: 'PDF export failed: ' + err.message });
  }
});

module.exports = router;
