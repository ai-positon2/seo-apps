const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const store = require('./store');
const { resolveDomain, UnreachableDomainError } = require('./domainResolver');
const { discoverUrls, crawlFallback } = require('./sitemapDiscovery');
const { buildPatternTable, detectVertical, extractTemplates } = require('./patternClassifier');
const { UnsafeUrlError } = require('./urlSafety');
const { buildDraftClusters } = require('./draftClustering');
const { runFullAnalysis } = require('./fullAnalysis');
const { buildWorkbook, buildMarkdownNarrative } = require('./exporter');

const analyzeSessions = new Map();
const projectAccess = require('../../services/projectAccess');

// Automatically linked entries inherit the platform project's workspace access.
router.param('id', async (req, res, next, id) => {
  try {
    const project = await store.getProject(id);
    if (project?.platformProjectId) {
      const capability = req.method === 'GET' ? 'view'
        : req.method === 'DELETE' ? 'editProjectSettings' : 'startRun';
      await projectAccess.requireProject(req, project.platformProjectId, capability);
    }
    next();
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not load project.' });
  }
});

// Init-token + SSE stream — work starts only once the stream itself is open
// (headers flushed) so no progress event can be emitted before the client is
// listening. Same pattern as server/routes/keywordResearch.js and this app's
// GBP QC bulk-generation endpoint.
const discoverSessions = new Map();

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

router.get('/projects', async (req, res) => {
  try {
    const projects = await store.listProjects();
    const visible = await Promise.all(projects.map(async (project) => {
      if (!project.platformProjectId) return project;
      try {
        await projectAccess.requireProject(req, project.platformProjectId, 'view');
        return project;
      } catch (e) {
        if (e.status === 403 || e.status === 404) return null;
        throw e;
      }
    }));
    res.json(visible.filter(Boolean));
  } catch (e) {
    res.status(e.status || 500).json({ error: 'Could not load projects.' });
  }
});

router.post('/projects', async (req, res) => {
  const { domain } = req.body || {};
  if (!domain || !String(domain).trim()) return res.status(400).json({ error: 'Domain is required.' });
  try {
    const { canonicalOrigin, host } = await resolveDomain(domain);
    const project = await store.createProject({ domain: canonicalOrigin, host });
    res.json(project);
  } catch (err) {
    if (err instanceof UnreachableDomainError || err instanceof UnsafeUrlError) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id', async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

router.delete('/projects/:id', async (req, res) => {
  await store.deleteProject(req.params.id);
  res.json({ ok: true });
});

// ── Stage 1: sitemap discovery (SSE) ──────────────────────────────────────────

router.post('/projects/:id/discover', async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const token = generateToken();
  discoverSessions.set(token, { projectId: project.id });
  setTimeout(() => discoverSessions.delete(token), 120000);
  res.json({ token });
});

router.get('/projects/:id/discover/stream/:token', async (req, res) => {
  const session = discoverSessions.get(req.params.token);
  if (!session || session.projectId !== req.params.id) {
    return res.status(404).json({ error: 'Session not found or expired. Please try again.' });
  }
  discoverSessions.delete(req.params.token);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let isClosed = false;
  res.on('close', () => { isClosed = true; });
  const emit = (event, data) => {
    if (isClosed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { isClosed = true; }
  };

  try {
    const project = await store.getProject(req.params.id);
    if (!project) throw new Error('Project not found');

    emit('step', { id: 'sitemap', status: 'active', message: 'Looking for a sitemap…' });
    const result = await discoverUrls(project.domain);

    let urls = result.urls;
    let sitemapSource = result.source;
    let crawlMode = 'sitemap';

    if (result.mode === 'not-found') {
      emit('step', { id: 'sitemap', status: 'done', message: 'No sitemap found — falling back to a shallow site crawl' });
      emit('step', { id: 'crawl-fallback', status: 'active', message: 'No sitemap found. Crawling from the homepage instead (slower, may miss pages)…' });
      urls = await crawlFallback(project.domain);
      sitemapSource = 'crawl-fallback';
      crawlMode = 'slug-only'; // no page content yet either way — Stage 4 will crawl content separately
      emit('step', { id: 'crawl-fallback', status: 'done', message: `Found ${urls.length} URLs via crawl` });
    } else {
      emit('step', {
        id: 'sitemap',
        status: 'done',
        message: result.capped
          ? `Found ${urls.length} URLs (capped — hit the ${result.capReason} limit)`
          : `Found ${urls.length} URLs via ${sitemapSource}`,
      });
    }

    emit('step', { id: 'patterns', status: 'active', message: 'Grouping URLs into patterns…' });
    const urlStrings = urls.map((u) => u.url);
    const patterns = buildPatternTable(urlStrings);
    const vertical = detectVertical(urlStrings);
    await store.savePatterns(project.id, patterns);
    // Full list persisted separately from the pattern table (which only keeps
    // 3 examples per pattern) — Stage 3 draft clustering needs every
    // confirmed URL and must make no network calls of its own.
    await store.saveUrls(project.id, urls);
    emit('step', { id: 'patterns', status: 'done', message: `Found ${patterns.length} URL patterns` });

    await store.updateProject(project.id, {
      workflowState: 'patterns',
      vertical,
      sitemapSource,
      crawlMode,
      stats: { ...project.stats, urlsFound: urls.length },
    });

    emit('ready', {
      patterns,
      vertical,
      sitemapSource,
      crawlMode,
      capped: result.capped || false,
      capReason: result.capReason || null,
      skippedSitemaps: result.skippedSitemaps || [],
      urlCount: urls.length,
    });
  } catch (err) {
    console.error('[content-architect] discover error:', err.message);
    emit('fail', { message: err.message });
  }
  emit('done', {});
  if (!isClosed) res.end();
});

// ── Stage 2: pattern selection ────────────────────────────────────────────────

router.get('/projects/:id/patterns', async (req, res) => {
  const patterns = await store.getPatterns(req.params.id);
  if (!patterns) return res.status(404).json({ error: 'No patterns yet — run discovery first.' });
  res.json(patterns);
});

router.put('/projects/:id/patterns', async (req, res) => {
  const { included, vertical } = req.body || {};
  const patterns = await store.getPatterns(req.params.id);
  if (!patterns) return res.status(404).json({ error: 'No patterns yet — run discovery first.' });

  const includedMap = new Map((included || []).map((p) => [p.pattern, p.included]));
  const updated = patterns.map((p) => (includedMap.has(p.pattern) ? { ...p, included: includedMap.get(p.pattern) } : p));
  await store.savePatterns(req.params.id, updated);

  const project = await store.getProject(req.params.id);
  const urlsSelected = updated.filter((p) => p.included).reduce((sum, p) => sum + p.count, 0);
  const patch = { stats: { ...project.stats, urlsSelected } };
  if (vertical) patch.vertical = vertical;
  await store.updateProject(req.params.id, patch);

  res.json(updated);
});

// ── Stage 3: instant slug-only draft clustering ──────────────────────────────
// Provisional endpoint name — Checkpoint 3 will fold this into the spec's
// real POST/GET /analyze SSE job once Stage 4 (crawl) exists alongside it.
// Plain request/response, not SSE: the spec requires this to complete in
// under 2 seconds with no network calls, so there's no long job to stream.
router.post('/projects/:id/draft-clusters', async (req, res) => {
  try {
    const project = await store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    const patterns = await store.getPatterns(req.params.id);
    const allUrls = await store.getUrls(req.params.id);
    if (!patterns || !allUrls) return res.status(400).json({ error: 'Run discovery first.' });

    // Re-derive the pattern -> full-URL-list mapping locally (pure function
    // of the persisted raw URL list, no network call) rather than persisting
    // a second, duplicated copy of it — see store.js's getUrls/saveUrls note.
    const includedPatterns = new Set(patterns.filter((p) => p.included).map((p) => p.pattern));
    const rawUrlStrings = allUrls.map((u) => u.url);
    const templates = extractTemplates(rawUrlStrings);
    const confirmedUrls = templates.filter((t) => includedPatterns.has(t.pattern)).flatMap((t) => t.urls);

    const result = await buildDraftClusters(confirmedUrls, { domain: project.domain, vertical: project.vertical });
    await store.saveClusters(project.id, result);
    await store.updateProject(project.id, {
      stats: {
        ...project.stats,
        urlsAnalyzed: confirmedUrls.length,
        clusterCount: result.clusters.length,
        unassignedCount: result.unassigned.length,
      },
    });
    res.json(result);
  } catch (err) {
    console.error('[content-architect] draft-clusters error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/clusters', async (req, res) => {
  const clusters = await store.getClusters(req.params.id);
  if (!clusters) return res.status(404).json({ error: 'No clusters yet.' });
  res.json(clusters);
});

// ── Stages 4-7: full analysis (crawl -> cluster -> name -> hub -> diagnose) ──
router.post('/projects/:id/analyze', async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const patterns = await store.getPatterns(req.params.id);
  const allUrls = await store.getUrls(req.params.id);
  if (!patterns || !allUrls) return res.status(400).json({ error: 'Run discovery and confirm patterns first.' });

  const token = generateToken();
  analyzeSessions.set(token, { projectId: project.id });
  setTimeout(() => analyzeSessions.delete(token), 7200000); // 2h, per spec's job-map TTL
  res.json({ token });
});

router.get('/projects/:id/analyze/stream/:token', async (req, res) => {
  const session = analyzeSessions.get(req.params.token);
  if (!session || session.projectId !== req.params.id) {
    return res.status(404).json({ error: 'Session not found or expired. Please try again.' });
  }
  analyzeSessions.delete(req.params.token);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let isClosed = false;
  res.on('close', () => { isClosed = true; });
  const emit = (event, data) => {
    if (isClosed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { isClosed = true; }
  };
  const heartbeat = setInterval(() => { if (!isClosed) res.write(': heartbeat\n\n'); }, 15000);

  try {
    const project = await store.getProject(req.params.id);
    const patterns = await store.getPatterns(req.params.id);
    const allUrls = await store.getUrls(req.params.id);
    const includedPatterns = new Set(patterns.filter((p) => p.included).map((p) => p.pattern));
    const templates = extractTemplates(allUrls.map((u) => u.url));
    const confirmedUrls = templates.filter((t) => includedPatterns.has(t.pattern)).flatMap((t) => t.urls);

    await store.updateProject(project.id, { workflowState: 'analyzing' });

    const result = await runFullAnalysis(confirmedUrls, { domain: project.domain, vertical: project.vertical }, {
      onProgress: (stage, detail) => emit('step', { id: stage, status: 'active', message: detail.message }),
    });

    await store.saveFullAnalysis(project.id, result);
    const meanHealth = result.clusters.length
      ? Math.round(result.clusters.reduce((s, c) => s + (c.health || 0), 0) / result.clusters.length)
      : null;
    await store.updateProject(project.id, {
      workflowState: 'complete',
      stats: {
        ...project.stats,
        urlsAnalyzed: result.pages.length,
        urlsExcluded: result.excludedUrls.length,
        clusterCount: result.clusters.length,
        gapHubCount: result.clusters.filter((c) => c.isGap).length,
        orphanCount: result.pages.filter((p) => (p.flags || []).includes('orphan')).length,
        unassignedCount: result.unassignedPages.length,
        meanHealth,
      },
    });

    emit('ready', {
      clusterCount: result.clusters.length,
      gapHubCount: result.clusters.filter((c) => c.isGap).length,
      unassignedCount: result.unassignedPages.length,
      excludedCount: result.excludedUrls.length,
      meanHealth,
      crawlMeta: result.crawlMeta,
    });
  } catch (err) {
    console.error('[content-architect] analyze error:', err.message);
    emit('fail', { message: err.message });
  }
  clearInterval(heartbeat);
  emit('done', {});
  if (!isClosed) res.end();
});

router.get('/projects/:id/full-analysis', async (req, res) => {
  const analysis = await store.getFullAnalysis(req.params.id);
  if (!analysis) return res.status(404).json({ error: 'No analysis yet.' });
  res.json(analysis);
});

router.get('/projects/:id/export', async (req, res) => {
  try {
    const project = await store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const analysis = await store.getFullAnalysis(req.params.id);
    if (!analysis) return res.status(404).json({ error: 'Run analysis first.' });

    const format = req.query.format === 'md' ? 'md' : 'xlsx';
    const safeName = (project.name || 'content-architecture').replace(/[^a-z0-9-]+/gi, '-');

    if (format === 'md') {
      const md = buildMarkdownNarrative(analysis, project);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-narrative.md"`);
      return res.send(md);
    }

    const wb = await buildWorkbook(analysis, project);
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-content-architecture.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error('[content-architect] export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
