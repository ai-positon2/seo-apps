// ── Location + Service Page Content Builder — HTTP API (Build Spec) ──────────
// Mounted at /api/location-page-builder. File-store backed; reuses the app's
// SERP/SEMrush/OpenAI/scraper services. Long-running pipeline + generation run
// over SSE (matching the app's keywordResearch route convention).

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const config = require('../locationPageBuilder/config');
const store = require('../locationPageBuilder/store');
const { seedNeuroWellness, seedGentleDental } = require('../locationPageBuilder/seed');
const compose = require('../locationPageBuilder/compose');
const pageService = require('../locationPageBuilder/pageService');
const exporter = require('../locationPageBuilder/exporter');
const keywordAdapter = require('../locationPageBuilder/keywordAdapter');
const dentalWizard = require('../locationPageBuilder/dentalWizard');
const qaEngine = require('../locationPageBuilder/qaEngine');

// Feature flag (Spec §0.2)
router.use((req, res, next) => {
  if (!config.enabled) return res.status(404).json({ error: 'Module disabled (LPB_ENABLED=false).' });
  next();
});

// Express 4 does not catch a rejected promise returned by an async handler:
// the rejection goes unhandled, and on modern Node that terminates the whole
// server process. The read routes below have no try/catch of their own, so a
// single store error in any of them took the entire app down (this is exactly
// how the export route killed the server on a Gentle Dental page). wrap()
// turns any such rejection into a 500 on that one request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error(`[LPB] ${req.method} ${req.originalUrl} failed:`, e.message);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

// Short-lived tokens for SSE streams (same pattern as keywordResearch).
const sseTokens = new Map();
function mintToken(payload) {
  const token = crypto.randomBytes(16).toString('hex');
  sseTokens.set(token, payload);
  setTimeout(() => sseTokens.delete(token), 120000);
  return token;
}

// ── Reference data (L1/L2) ───────────────────────────────────────────────────
router.post('/seed', async (req, res) => {
  try { res.json(await seedNeuroWellness()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/seed-gentle-dental', async (req, res) => {
  try { res.json(await seedGentleDental()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/clients', wrap(async (req, res) => res.json(await store.list('clients'))));
router.get('/clients/:id', wrap(async (req, res) => {
  const client = await store.get('clients', req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const [services, locations, providers] = await Promise.all([
    store.list('services', { client_id: client.id }),
    store.list('locations', { client_id: client.id }),
    store.list('providers', { client_id: client.id }),
  ]);
  res.json({ client, services, locations, providers });
}));

// Generic CRUD for L1/L2 entities (Spec §M1 intake).
const CRUD_COLLECTIONS = ['clients', 'services', 'locations', 'providers', 'reviews', 'insuranceSets', 'resources', 'toneProfiles', 'globalTemplates'];
router.get('/entities/:collection', wrap(async (req, res) => {
  if (!CRUD_COLLECTIONS.includes(req.params.collection)) return res.status(404).json({ error: 'Unknown collection.' });
  res.json(await store.list(req.params.collection, req.query.client_id ? { client_id: req.query.client_id } : {}));
}));
router.post('/entities/:collection', wrap(async (req, res) => {
  if (!CRUD_COLLECTIONS.includes(req.params.collection)) return res.status(404).json({ error: 'Unknown collection.' });
  res.json(await store.insert(req.params.collection, req.body));
}));
router.put('/entities/:collection/:id', wrap(async (req, res) => {
  if (!CRUD_COLLECTIONS.includes(req.params.collection)) return res.status(404).json({ error: 'Unknown collection.' });
  const updated = await store.update(req.params.collection, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Not found.' });
  res.json(updated);
}));
router.delete('/entities/:collection/:id', wrap(async (req, res) => {
  if (!CRUD_COLLECTIONS.includes(req.params.collection)) return res.status(404).json({ error: 'Unknown collection.' });
  res.json({ removed: await store.remove(req.params.collection, req.params.id) });
}));

// ── Pages: tracking dashboard + detail ──────────────────────────────────────
// This dashboard + LocationPageDetailPage.jsx are built entirely around the
// Neuro page_object shape (approach/competitor_section/faqs). Dental wizard
// pages have a completely different shape (hero/breadcrumb/officeInfo/
// servicesInCity/educationalBody/faq/schema) and are reviewed inline in the
// wizard itself, not through this dashboard — exclude them so they don't
// appear as broken-looking rows here or crash the detail page if clicked.
router.get('/pages', wrap(async (req, res) => {
  const all = await store.list('pages', req.query.client_id ? { client_id: req.query.client_id } : {});
  const pages = all.filter(p => p.page_type !== 'dental_location_service');
  // Enrich with service/location names for the dashboard.
  const [services, locations, clients] = await Promise.all([
    store.list('services'), store.list('locations'), store.list('clients'),
  ]);
  const byId = (arr) => Object.fromEntries(arr.map(x => [x.id, x]));
  const S = byId(services), L = byId(locations), C = byId(clients);
  const rows = pages.map(p => ({
    id: p.id, status: p.status, client_id: p.client_id,
    client_name: C[p.client_id]?.name || '', service_name: S[p.service_id]?.name || '',
    location_name: L[p.location_id]?.location_name || '',
    assignee_id: p.assignee_id, target_date: p.target_date, updated_at: p.updated_at,
    primary_keywords: (p.keyword_set?.primary || []).map(k => k.keyword),
    approval_status: p.approval_status,
    qa_blocking: p.qa_result?.blocking_failures ?? null,
    exported: (p.versions || []).some(v => (v.exported_formats || []).length),
  }));
  res.json(rows);
}));

router.get('/pages/:id', wrap(async (req, res) => {
  const page = await store.get('pages', req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found.' });
  if (page.page_type === 'dental_location_service') {
    return res.status(400).json({ error: 'This is a Gentle Dental wizard page — review it from the wizard, not this detail view.' });
  }
  res.json(page);
}));

// New Page wizard — eligibility + already-exists (Stage 1)
// This whole pipeline (SERP/SEMrush keyword mining, competitor scraping,
// Neuro-shaped section template, multi-gate approval) is Neuro-specific.
// Reject a dental client here so it can't be driven through the wrong
// template — direct callers to POST /wizard/generate instead.
router.post('/pages', async (req, res) => {
  try {
    const { clientId, serviceId, locationId, assigneeId, targetDate } = req.body;
    if (!clientId || !serviceId || !locationId) return res.status(400).json({ error: 'clientId, serviceId, locationId are required.' });
    const template = await store.findOne('globalTemplates', { client_id: clientId });
    if (template?.page_type === 'dental_location_service') {
      return res.status(400).json({ error: 'This client uses the Gentle Dental wizard, not this pipeline. Use the "Gentle Dental Wizard" flow instead.' });
    }
    res.json(await pageService.createPage({ clientId, serviceId, locationId, assigneeId, targetDate }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hard delete (the module's retention rule is "kept forever unless deleted").
// The page's approved-keyword record is keyed by the same tuple and is deleted
// with it, so nothing is orphaned behind the page it belonged to.
router.delete('/pages/:id', async (req, res) => {
  try {
    const page = await store.get('pages', req.params.id);
    const removed = await store.remove('pages', req.params.id);
    // Non-fatal: the page itself is already gone, so a failure to tidy up its
    // keyword record must not report the delete as having failed.
    if (page) {
      try {
        const tuple_key = dentalWizard.tupleKey({
          clientId: page.client_id, serviceId: page.service_id, locationId: page.location_id,
        });
        await store.removeWhere('keywordSelections', { tuple_key });
      } catch (e) {
        console.error('[LPB] Failed to remove keyword selection for deleted page:', e.message);
      }
    }
    res.json({ removed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Keyword pipeline (SSE) ───────────────────────────────────────────────────
router.post('/pages/:id/keywords/run', (req, res) => {
  res.json({ token: mintToken({ kind: 'pipeline', pageId: req.params.id }) });
});
router.post('/pages/:id/content/run', (req, res) => {
  res.json({ token: mintToken({ kind: 'generate', pageId: req.params.id }) });
});

router.get('/stream/:token', async (req, res) => {
  const job = sseTokens.get(req.params.token);
  if (!job) return res.status(404).json({ error: 'Stream token not found or expired.' });
  sseTokens.delete(req.params.token);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  res.on('close', () => { closed = true; });
  const emit = (event, data) => { if (!closed) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { closed = true; } } };
  const onStep = (step) => emit('step', step);

  // Heartbeat: a comment line every 15s keeps the SSE connection warm through
  // proxies (Railway/Envoy) during slow stages (SERP/SEMrush/LLM).
  const heartbeat = setInterval(() => { if (!closed) { try { res.write(': keepalive\n\n'); } catch { closed = true; } } }, 15000);

  try {
    if (job.kind === 'pipeline') {
      const result = await pageService.runKeywordPipeline(job.pageId, onStep);
      emit('result', result);
    } else if (job.kind === 'generate') {
      const result = await pageService.generateContent(job.pageId, onStep);
      emit('result', { qa_result: result.qa_result, status: result.page_object.meta.status });
    }
  } catch (e) {
    emit('fail', { message: e.message });
  }
  clearInterval(heartbeat);
  emit('done', {});
  res.end();
});

// ── Keyword editing (Stage 6) ────────────────────────────────────────────────
router.put('/pages/:id/keywords', async (req, res) => {
  try { res.json(await pageService.saveKeywords(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/pages/:id/keywords/finalize', async (req, res) => {
  try { res.json({ ok: await pageService.finalizeKeywords(req.params.id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Content editing + QA ─────────────────────────────────────────────────────
router.put('/pages/:id/section', async (req, res) => {
  try {
    const { sectionKey, value, actorId } = req.body;
    res.json(await pageService.editSection(req.params.id, sectionKey, value, actorId));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/pages/:id/content', async (req, res) => {
  try { res.json(await pageService.saveContent(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/pages/:id/qa', async (req, res) => {
  try { res.json(await pageService.rerunQA(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/pages/:id/content/regen-field', async (req, res) => {
  try {
    const { field, maxChars, context } = req.body;
    const value = await pageService.regenField(req.params.id, { field, maxChars: maxChars || null, context: context || {} });
    res.json({ value });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Approval (Spec §10) ──────────────────────────────────────────────────────
router.post('/pages/:id/gate', async (req, res) => {
  try {
    const { gate, action, role, comment, actorId } = req.body;
    // Role comes from the request (app auth is currently a stub — Spec §0 RBAC).
    res.json(await pageService.actOnGate(req.params.id, gate, action, { role: role || 'admin', comment, actorId }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/pages/:id/comments', async (req, res) => {
  try { res.json(await pageService.addComment(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Gentle Dental wizard (Build Brief) ──────────────────────────────────────
// Steps 2-4: keyword candidates, single-call generation, QC. Deliberately
// separate from the Neuro pages/keywords/content routes above — no SSE, no
// approval workflow.
router.post('/keyword-candidates', async (req, res) => {
  try {
    const { service, city, state, stateName, region, seedQuery, clientId, serviceSlug } = req.body;
    if (!service || !city || !state) return res.status(400).json({ error: 'service, city, state are required.' });
    // region + stateName are optional: they widen what Secondary may name
    // (this office's own broader region/state) without opening the door to
    // rival cities. Absent them, only the city itself is treated as local.
    res.json(await keywordAdapter.getKeywordCandidates({ service, city, state, stateName, region, seedQuery, clientId, serviceSlug }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/wizard/generate', async (req, res) => {
  try {
    const { clientId, serviceId, locationId, primaryKeywords, secondaryKeywords } = req.body;
    if (!clientId || !serviceId || !locationId) return res.status(400).json({ error: 'clientId, serviceId, locationId are required.' });
    if (!Array.isArray(primaryKeywords) || !primaryKeywords.filter(Boolean).length) {
      return res.status(400).json({ error: 'primaryKeywords (array, at least 1) is required.' });
    }
    const result = await dentalWizard.generatePage({
      clientId, serviceId, locationId, primaryKeywords, secondaryKeywords: secondaryKeywords || [],
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Only one page per (client, service, location) tuple is ever stored — this
// lets Step 1 detect "you've already generated this combo" and offer to open
// the existing page instead of blindly regenerating (and re-billing).
router.get('/wizard/existing', async (req, res) => {
  try {
    const { clientId, serviceId, locationId } = req.query;
    if (!clientId || !serviceId || !locationId) return res.status(400).json({ error: 'clientId, serviceId, locationId are required.' });
    const page = await dentalWizard.getExistingPage({ clientId, serviceId, locationId });
    res.json({ exists: !!page, pageId: page?.id || null, page: page?.page_object || null, updatedAt: page?.updated_at || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Regenerate ONE section of an already-generated page in place (no full
// re-generation, no duplicate row — see dentalWizard.regenerateSection).
router.post('/wizard/regenerate', async (req, res) => {
  try {
    const { clientId, serviceId, locationId, section, blockIndex } = req.body;
    if (!clientId || !serviceId || !locationId || !section) {
      return res.status(400).json({ error: 'clientId, serviceId, locationId, section are required.' });
    }
    const result = await dentalWizard.regenerateSection({ clientId, serviceId, locationId, section, blockIndex });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Approved keywords (durable) ─────────────────────────────────────────────
// Approval used to be implicit in generation, so approving and leaving lost the
// work, and re-opening a page had nothing to rehydrate from and silently re-ran
// the billed /keyword-candidates research. These two routes give the approval
// its own permanent record.
router.post('/wizard/keywords', async (req, res) => {
  try {
    const { clientId, serviceId, locationId, primary, secondary, candidates, approved } = req.body;
    if (!clientId || !serviceId || !locationId) return res.status(400).json({ error: 'clientId, serviceId, locationId are required.' });
    const saved = await dentalWizard.saveSelection({
      clientId, serviceId, locationId,
      primary: primary || [], secondary: secondary || [], candidates: candidates || [],
      // Default true: an explicit POST with no flag is a deliberate approval.
      approved: approved !== false,
    });
    res.json({ saved: true, approved: saved.approved, approvedAt: saved.approved_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/wizard/keywords', async (req, res) => {
  try {
    const { clientId, serviceId, locationId } = req.query;
    if (!clientId || !serviceId || !locationId) return res.status(400).json({ error: 'clientId, serviceId, locationId are required.' });
    const sel = await dentalWizard.getSelection({ clientId, serviceId, locationId });
    if (!sel) return res.json({ exists: false, primary: [], secondary: [], candidates: [] });
    res.json({
      exists: true, primary: sel.primary || [], secondary: sel.secondary || [],
      candidates: sel.candidates || [],
      approved: sel.approved !== false, approvedAt: sel.approved_at || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Persist manual step-4 edits. The Neuro PUT /pages/:id/content can't be
// reused: pageService.saveContent writes page_object.page_data, a shape the
// dental page_object (sections.hero / educationalBody.blocks[] / faq.items[])
// does not share.
router.put('/wizard/pages/:id', async (req, res) => {
  try {
    const { page } = req.body;
    if (!page) return res.status(400).json({ error: 'page is required.' });
    const saved = await dentalWizard.saveContent({ pageId: req.params.id, page });
    // Return the recomputed verdict so the UI reflects what was actually stored.
    res.json({ saved: true, updatedAt: saved.updated_at, qc: saved.page_object?.qc || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Dashboard for the wizard's own saved pages — separate from the Neuro
// /pages list (which explicitly excludes dental pages, since it's built
// around a page_object shape this module doesn't share). Without this,
// generated Gentle Dental pages have NO visible home once you navigate away
// from the exact location+service combo — they're saved, just invisible.
router.get('/wizard/pages', async (req, res) => {
  try {
    const clientId = req.query.clientId || req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'clientId is required.' });
    const [pages, services, locations] = await Promise.all([
      store.list('pages', { client_id: clientId }),
      store.list('services', { client_id: clientId }),
      store.list('locations', { client_id: clientId }),
    ]);
    const S = Object.fromEntries(services.map(s => [s.id, s]));
    const L = Object.fromEntries(locations.map(l => [l.id, l]));
    const rows = pages
      .filter(p => p.page_type === 'dental_location_service' && p.page_object)
      .map(p => ({
        id: p.id,
        service_id: p.service_id, location_id: p.location_id,
        service_name: S[p.service_id]?.name || '', location_name: L[p.location_id]?.location_name || '',
        primary_keyword: p.page_object.primaryKeyword || '',
        url_path: p.page_object.meta?.urlPath || '',
        qc_verdict: p.page_object.qc?.verdict || null,
        updated_at: p.updated_at,
      }))
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/wizard/pages/:id', async (req, res) => {
  try {
    const page = await store.get('pages', req.params.id);
    if (!page || page.page_type !== 'dental_location_service') return res.status(404).json({ error: 'Page not found.' });
    res.json({ pageId: page.id, page: page.page_object, serviceId: page.service_id, locationId: page.location_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The thresholds the QC gates enforce, so the wizard can show each field the
// target it will actually be judged against instead of carrying its own copy.
router.get('/wizard/content-limits', (req, res) => res.json(qaEngine.DENTAL_LIMITS));

// Download the wizard's page as a formatted .docx.
//
// Takes the GeneratedPage in the REQUEST BODY rather than reading it back from
// the store by id, which is what /pages/:id/export/docx does. The wizard edits
// its page client-side and only persists on Save, so an id-based export would
// hand the reviewer a document missing whatever they just typed. This exports
// exactly what is on screen, saved or not.
router.post('/wizard/export/docx', async (req, res) => {
  try {
    const { page } = req.body;
    if (!qaEngine.isDentalScaffold(page)) return res.status(400).json({ error: 'page (GeneratedPage with meta + sections) is required.' });
    const buffer = await exporter.toDentalDocxBuffer(page);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${exporter.safeFilename(page)}.docx"`);
    return res.send(buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Re-run QC against a (possibly client-edited) GeneratedPage without regenerating.
router.post('/wizard/qc', async (req, res) => {
  try {
    const { page, pageId } = req.body;
    if (!qaEngine.isDentalScaffold(page)) return res.status(400).json({ error: 'page (GeneratedPage with meta + sections) is required.' });
    const qc = qaEngine.runDentalQC(page);
    // With a pageId the verdict is stored on the page rather than being
    // recomputed-and-lost on every reload. Non-fatal: still return the verdict
    // if the write fails.
    if (pageId) {
      try { await dentalWizard.saveQc({ pageId, qc }); }
      catch (e) { console.error('[LPB] Failed to persist QC verdict:', e.message); }
    }
    res.json(qc);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Re-run ONE check. The wizard shows each QC failure next to the field it came
// from, with a Recheck button — this is that button. `checks` is the client's
// current result set, so the single fresh check can be spliced back in and the
// verdict re-derived without re-running the other seventeen.
router.post('/wizard/qc/check', async (req, res) => {
  try {
    const { page, pageId, id, checks } = req.body;
    if (!qaEngine.isDentalScaffold(page)) return res.status(400).json({ error: 'page (GeneratedPage with meta + sections) is required.' });
    if (!id) return res.status(400).json({ error: 'id (QC check id) is required.' });
    const { check, verdict, checks: merged } = qaEngine.recheckDental(page, id, checks);
    // pageId is sent only when the client has no unsaved edits: a verdict
    // computed from content the store doesn't have yet must not be written
    // against the content it does have.
    if (pageId) {
      try { await dentalWizard.saveQc({ pageId, qc: { verdict, checks: merged } }); }
      catch (e) { console.error('[LPB] Failed to persist QC verdict:', e.message); }
    }
    res.json({ check, verdict, checks: merged });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Export (Spec §11) ────────────────────────────────────────────────────────
router.get('/pages/:id/export/:format', wrap(async (req, res) => {
  const page = await store.get('pages', req.params.id);
  if (!page?.page_object) return res.status(400).json({ error: 'No generated content to export.' });
  // The Neuro exporters read service_data/location_data/page_data; a dental
  // page shares none of that shape. Exporting one used to throw inside
  // safeFilename — and because that call sat OUTSIDE the try below, in an
  // async handler, the rejection went unhandled and took the whole server
  // process down. Dental pages now get their own exporters, and every
  // shape-dependent call stays inside the try.
  const dental = page.page_type === 'dental_location_service';
  const fmt = req.params.format;
  try {
    const fname = exporter.safeFilename(page.page_object);
    if (fmt === 'json') {
      await pageService.snapshotVersion(req.params.id, ['json']);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}.json"`);
      return res.send(exporter.toJSON(page.page_object));
    }
    if (fmt === 'markdown' || fmt === 'md') {
      await pageService.snapshotVersion(req.params.id, ['markdown']);
      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}.md"`);
      return res.send(dental ? exporter.toDentalMarkdown(page.page_object) : exporter.toMarkdown(page.page_object));
    }
    if (fmt === 'docx') {
      const buffer = dental
        ? await exporter.toDentalDocxBuffer(page.page_object)
        : await exporter.toDocxBuffer(page.page_object);
      await pageService.snapshotVersion(req.params.id, ['docx']);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}.docx"`);
      return res.send(buffer);
    }
    res.status(400).json({ error: `Unknown format "${fmt}".` });
  } catch (e) { res.status(500).json({ error: e.message }); }
}));

// Inline preview (JSON/markdown) without download.
router.get('/pages/:id/preview/:format', wrap(async (req, res) => {
  const page = await store.get('pages', req.params.id);
  if (!page?.page_object) return res.status(400).json({ error: 'No generated content.' });
  if (req.params.format === 'markdown') {
    const md = page.page_type === 'dental_location_service'
      ? exporter.toDentalMarkdown(page.page_object)
      : exporter.toMarkdown(page.page_object);
    return res.type('text/plain').send(md);
  }
  res.json(page.page_object);
}));

module.exports = router;
