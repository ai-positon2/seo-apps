const express = require('express');
const router = express.Router();

const store = require('./store');
const { fetchClientDashboardData, refreshPageSpeedOnly, refreshStalePageSpeed } = require('./dataFetcher');
const { MAX_UNITS_PER_RUN, estimateDomainCost, maxDomainsForBudget, estimateDiscoveryCost } = require('./unitCosts');
const { hasSemrushKey } = require('./provider');
const { runContentAnalysis, applyMappingEdits, regenerateTopPagesSummary, regenerateSitemapSummary } = require('./contentAnalysis/orchestrator');
const { discoverCompetitorsForClient, DEFAULT_DISCOVERY_LIMIT } = require('./discovery');
const { generateReportPdf } = require('../../services/competitorPdfGenerator');
const { buildReportData } = require('./reportExport');

// In-memory run tracking, one entry per client — mirrors the on-page-audit
// module's job-map pattern. A run against the mock provider is instant; a
// run against live SEMrush is not, but this same shape holds either way.
const runs = new Map(); // clientId -> { status, error, startedAt, finishedAt }

// Separate tracking for Page Speed-only refreshes, so they can run (and be
// polled) independently of a full SEMrush analysis — refreshing Core Web
// Vitals should never wait behind, or count against, the SEMrush unit budget.
const pageSpeedRuns = new Map(); // clientId -> { status, error, startedAt, finishedAt }

// Content Analysis (Part 1: top-pages, Part 2: sitemap structure) is a third
// independent action — its own SEMrush sub-budget (Part 1 only) and its own
// run tracking, unrelated to the main dashboard run or the Page Speed refresh.
const contentAnalysisRuns = new Map(); // clientId -> { status, error, startedAt, finishedAt }

router.get('/meta', (req, res) => {
  res.json({
    liveDataSource: hasSemrushKey(),
    pageSpeedEnabled: !!process.env.GOOGLE_PSI_API_KEY,
    capUnits: MAX_UNITS_PER_RUN,
    estimatedCostPerDomain: estimateDomainCost(),
    maxDomainsPerRun: maxDomainsForBudget(),
    maxCompetitors: store.MAX_COMPETITORS,
    discoveryCostUnits: estimateDiscoveryCost(),
    defaultDiscoveryLimit: DEFAULT_DISCOVERY_LIMIT,
  });
});

// ── Clients ──────────────────────────────────────────────────────────────────

router.get('/clients', async (req, res) => {
  res.json({ clients: await store.getClients() });
});

router.post('/clients', async (req, res) => {
  try {
    const client = await store.createClient(req.body || {});
    res.json({ client });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/clients/:clientId', async (req, res) => {
  try {
    const client = await store.updateClient(req.params.clientId, req.body || {});
    res.json({ client });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/clients/:clientId', async (req, res) => {
  await store.deleteClient(req.params.clientId);
  runs.delete(req.params.clientId);
  pageSpeedRuns.delete(req.params.clientId);
  contentAnalysisRuns.delete(req.params.clientId);
  res.json({ ok: true });
});

router.post('/clients/:clientId/competitors', async (req, res) => {
  try {
    const competitor = await store.addCompetitor(req.params.clientId, req.body || {});
    res.json({ competitor });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/clients/:clientId/competitors/:competitorId', async (req, res) => {
  try {
    await store.removeCompetitor(req.params.clientId, req.params.competitorId);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Auto-discovers organic competitors — synchronous (one SEMrush call + up to
// 2 short GPT calls, ~5-10s worst case), unlike the async-job-poll pattern
// used below for the multi-minute SEMrush+PSI actions. Nothing is persisted
// here; the frontend reviews the candidates and adds any it keeps via the
// existing POST /competitors endpoint above, one call per candidate.
router.post('/clients/:clientId/discover-competitors', async (req, res) => {
  const { clientId } = req.params;
  const client = await store.getClient(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const remainingSlots = store.MAX_COMPETITORS - client.competitors.length;
  if (remainingSlots <= 0) {
    return res.status(400).json({ error: `Maximum of ${store.MAX_COMPETITORS} competitors already added — remove one before discovering more.` });
  }
  const requested = parseInt(req.body?.limit, 10) || DEFAULT_DISCOVERY_LIMIT;
  const limit = Math.min(Math.max(requested, 1), remainingSlots);

  try {
    const result = await discoverCompetitorsForClient(client, { limit });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Dashboard (cached read — never triggers a fetch) ─────────────────────────

router.get('/clients/:clientId/dashboard', async (req, res) => {
  const client = await store.getClient(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const snapshot = await store.getSnapshot(req.params.clientId);
  res.json({ client, snapshot });
});

// ── Run ──────────────────────────────────────────────────────────────────────

router.post('/clients/:clientId/run', async (req, res) => {
  const { clientId } = req.params;
  const client = await store.getClient(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const existing = runs.get(clientId);
  if (existing && existing.status === 'running') {
    return res.status(409).json({ error: 'A run is already in progress for this client' });
  }
  const psExisting = pageSpeedRuns.get(clientId);
  if (psExisting && psExisting.status === 'running') {
    return res.status(409).json({ error: 'A Page Speed refresh is already in progress for this client' });
  }

  runs.set(clientId, { status: 'running', error: null, startedAt: Date.now(), finishedAt: null });
  // Tracked run (marked `deferred` in server/config/runTracking.js): the
  // response returns now, so the run row is closed where the work settles.
  const run = req.run;
  res.json({ status: 'running' });

  // Fire-and-forget — the mock provider is instant, but a future live
  // provider won't be, so this stays async from the start.
  (async () => {
    try {
      const previousSnapshot = await store.getSnapshot(clientId);
      const snapshot = await fetchClientDashboardData(client, previousSnapshot);
      await store.saveSnapshot(clientId, snapshot);
      runs.set(clientId, { status: 'done', error: null, startedAt: runs.get(clientId).startedAt, finishedAt: Date.now() });
      run?.finish({ output: { clientId, clientName: client.name, competitors: client.competitors?.length ?? null } });
    } catch (err) {
      runs.set(clientId, { status: 'error', error: err.message, startedAt: runs.get(clientId)?.startedAt, finishedAt: Date.now() });
      run?.fail(err.message, { output: { clientId, clientName: client.name } });
    }
  })();
});

router.get('/clients/:clientId/run/status', (req, res) => {
  const run = runs.get(req.params.clientId);
  res.json(run || { status: 'idle', error: null });
});

// ── Page Speed-only refresh (no SEMrush spend) ───────────────────────────────

router.post('/clients/:clientId/run-pagespeed', async (req, res) => {
  const { clientId } = req.params;
  const client = await store.getClient(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const mainRun = runs.get(clientId);
  if (mainRun && mainRun.status === 'running') {
    return res.status(409).json({ error: 'A full analysis is already running for this client' });
  }
  const existing = pageSpeedRuns.get(clientId);
  if (existing && existing.status === 'running') {
    return res.status(409).json({ error: 'A Page Speed refresh is already in progress for this client' });
  }

  // Defaults to true (force) so the existing manual "Refresh Page Speed"
  // button — which never sends a body — keeps its exact current behavior.
  // The automatic post-run chain (routes below) explicitly passes false to
  // respect the 7-day cache instead of re-checking every domain every time.
  const force = req.body?.force !== false;

  pageSpeedRuns.set(clientId, { status: 'running', error: null, startedAt: Date.now(), finishedAt: null });
  const run = req.run; // deferred tracked run — closed when the refresh settles
  res.json({ status: 'running' });

  (async () => {
    try {
      const previousSnapshot = await store.getSnapshot(clientId);
      const snapshot = force
        ? await refreshPageSpeedOnly(client, previousSnapshot)
        : await refreshStalePageSpeed(client, previousSnapshot);
      await store.saveSnapshot(clientId, snapshot);
      pageSpeedRuns.set(clientId, { status: 'done', error: null, startedAt: pageSpeedRuns.get(clientId).startedAt, finishedAt: Date.now() });
      run?.finish({ output: { clientId, clientName: client.name, force } });
    } catch (err) {
      pageSpeedRuns.set(clientId, { status: 'error', error: err.message, startedAt: pageSpeedRuns.get(clientId)?.startedAt, finishedAt: Date.now() });
      run?.fail(err.message, { output: { clientId, clientName: client.name, force } });
    }
  })();
});

router.get('/clients/:clientId/run-pagespeed/status', (req, res) => {
  const run = pageSpeedRuns.get(req.params.clientId);
  res.json(run || { status: 'idle', error: null });
});

// ── Content Analysis (top-pages content mix + sitemap structure) ────────────

router.get('/clients/:clientId/content-analysis', async (req, res) => {
  const client = await store.getClient(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const contentAnalysis = await store.getContentAnalysis(req.params.clientId);
  res.json({ client, contentAnalysis });
});

router.post('/clients/:clientId/content-analysis/run', async (req, res) => {
  const { clientId } = req.params;
  const client = await store.getClient(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const existing = contentAnalysisRuns.get(clientId);
  if (existing && existing.status === 'running') {
    return res.status(409).json({ error: 'A Content Analysis run is already in progress for this client' });
  }

  contentAnalysisRuns.set(clientId, { status: 'running', error: null, startedAt: Date.now(), finishedAt: null });
  const run = req.run; // deferred tracked run — closed when the analysis settles
  res.json({ status: 'running' });

  (async () => {
    try {
      // Pass the prior run so unchanged folders are served from cache and
      // user folder-map edits (userOverrides) survive the re-run.
      const previous = await store.getContentAnalysis(clientId);
      const data = await runContentAnalysis(client, previous);
      await store.saveContentAnalysis(clientId, data);
      contentAnalysisRuns.set(clientId, { status: 'done', error: null, startedAt: contentAnalysisRuns.get(clientId).startedAt, finishedAt: Date.now() });
      run?.finish({ output: { clientId, clientName: client.name, folders: data?.folderMap ? Object.keys(data.folderMap).length : null } });
    } catch (err) {
      contentAnalysisRuns.set(clientId, { status: 'error', error: err.message, startedAt: contentAnalysisRuns.get(clientId)?.startedAt, finishedAt: Date.now() });
      run?.fail(err.message, { output: { clientId, clientName: client.name } });
    }
  })();
});

router.get('/clients/:clientId/content-analysis/run/status', (req, res) => {
  const run = contentAnalysisRuns.get(req.params.clientId);
  res.json(run || { status: 'idle', error: null });
});

// Edit the folder → page-type mapping. Body: { edits: { "<template>": "<type>" } }.
// Recomputes all per-domain counts from stored data — no crawl, no GPT — and
// persists the edits as user overrides that win over GPT on future re-runs.
router.post('/clients/:clientId/content-analysis/mapping', async (req, res) => {
  const { clientId } = req.params;
  try {
    const previous = await store.getContentAnalysis(clientId);
    const updated = applyMappingEdits(previous, (req.body && req.body.edits) || {});
    await store.saveContentAnalysis(clientId, updated);
    res.json({ contentAnalysis: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Regenerate just one part's GPT summary from already-stored raw data — no
// re-fetch, so it's fast and spends no SEMrush units regardless of part.
router.post('/clients/:clientId/content-analysis/summary/top-pages', async (req, res) => {
  const { clientId } = req.params;
  try {
    const previous = await store.getContentAnalysis(clientId);
    const updated = await regenerateTopPagesSummary(previous);
    await store.saveContentAnalysis(clientId, updated);
    res.json({ contentAnalysis: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/clients/:clientId/content-analysis/summary/sitemap', async (req, res) => {
  const { clientId } = req.params;
  try {
    const previous = await store.getContentAnalysis(clientId);
    const updated = await regenerateSitemapSummary(previous);
    await store.saveContentAnalysis(clientId, updated);
    res.json({ contentAnalysis: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Export (PDF report) ───────────────────────────────────────────────────────
// Synchronous — everything needed is already cached from the last analysis
// run, so this never makes a live SEMrush or PageSpeed call. The one thing it
// may do is a few short GPT calls for narrative text, cached on the snapshot
// (see reportExport.js) so repeat downloads of the same run are instant.
router.post('/clients/:clientId/export', async (req, res) => {
  const { clientId } = req.params;
  const client = await store.getClient(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const snapshot = await store.getSnapshot(clientId);
  if (!snapshot) return res.status(409).json({ error: 'Run an analysis first — there is no data to export.' });
  const contentAnalysis = await store.getContentAnalysis(clientId);

  try {
    const { reportData, narrativeChanged } = await buildReportData(client, snapshot, contentAnalysis);
    if (narrativeChanged) await store.saveSnapshot(clientId, snapshot);
    const buffer = await generateReportPdf(reportData);
    const filename = `${(client.brandName || client.name).replace(/\s+/g, '_')}_Competitor_Analysis.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[CompetitorAnalysis] export error:', err.message);
    res.status(500).json({ error: 'Report generation failed: ' + err.message });
  }
});

module.exports = router;
