// ── Template-driven Location + Service pages — HTTP API ─────────────────────
// Mounted at /api/location-page-builder/ls (see routes/locationPageBuilder.js),
// so this engine shares the module's base path, feature flag and auth with the
// two page types already there while keeping its own route surface.
//
// Deliberately separate from the routes above it: the Neuro pipeline's
// /pages/:id/* routes read page_data and run over SSE with an approval
// workflow, and the Gentle Dental /wizard/* routes assume a page_object with
// sections.educationalBody. Neither shape is this one, so reusing either would
// mean a page_type conditional in every handler.
//
// No SSE here. Every call is a single request that finishes: keyword research
// is one billed round-trip, the brief is one model call, the copy is one (plus
// at most one correction pass). The step that used to need streaming — "run
// the whole pipeline" — does not exist in this flow, because a human approves
// the brief in between.

const express = require('express');
const router = express.Router();

const store = require('../locationPageBuilder/store');
const lsWizard = require('../locationPageBuilder/lsWizard');
const lsQa = require('../locationPageBuilder/lsQa');
const lsCompose = require('../locationPageBuilder/lsCompose');
const lsProfiles = require('../locationPageBuilder/lsProfiles');
const keywordAdapter = require('../locationPageBuilder/keywordAdapter');
const exporter = require('../locationPageBuilder/exporter');
const { seedClearBehavioralHealth } = require('../locationPageBuilder/lsSeed');

// Express 4 does not catch a rejected promise returned by an async handler:
// the rejection goes unhandled, and on modern Node that terminates the whole
// server process. Every handler here goes through wrap() so a store or model
// failure becomes a 500 on that one request. (This is not theoretical — it is
// exactly how a Gentle Dental export once killed the app.)
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  // An error that names its own status is one we RAISED on purpose and whose
  // message is written for the person on the screen — "no reference data for
  // this client yet", not a stack. Logging it at error level and reporting it
  // as a 500 would file a configuration gap as an outage.
  const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status >= 500 && status !== 503) {
    console.error(`[LPB/ls] ${req.method} ${req.originalUrl} failed:`, e.message);
  } else {
    console.warn(`[LPB/ls] ${req.method} ${req.originalUrl} → ${status}: ${e.message}`);
  }
  if (!res.headersSent) res.status(status).json({ error: e.message, code: e.code || undefined });
});

// A 400 (the caller sent something wrong) rather than a 500 (we broke) for the
// whole family of "generate the brief first" / "approve it first" / "index must
// reference…" errors the wizard raises. They are all the same class of thing:
// a step attempted out of order, which the UI should surface as guidance.
const ORDERING_RE = /required|before|must reference|not found|Approve the content brief/i;
const wrapStep = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  const status = ORDERING_RE.test(e.message) ? 400 : 500;
  if (status === 500) console.error(`[LPB/ls] ${req.method} ${req.originalUrl} failed:`, e.message);
  if (!res.headersSent) res.status(status).json({ error: e.message });
});

function requireTuple(req, res) {
  const src = req.method === 'GET' ? req.query : req.body;
  const { clientId, serviceId, locationId } = src;
  if (!clientId || !serviceId || !locationId) {
    res.status(400).json({ error: 'clientId, serviceId, locationId are required.' });
    return null;
  }
  return { clientId, serviceId, locationId };
}

// ── Reference data ──────────────────────────────────────────────────────────
// Re-runnable: services are replaced, hand-entered location NAP is preserved
// (see lsSeed).
router.post('/seed/clear-behavioral-health', wrap(async (req, res) => {
  res.json(await seedClearBehavioralHealth());
}));

// The thresholds QC will actually gate on, per client, so the wizard can show
// each field its real target instead of carrying its own copy of the numbers.
router.get('/content-limits', wrap(async (req, res) => {
  res.json(lsQa.lsLimits(req.query.clientId || req.query.client_id || ''));
}));

// ── Step 2: keyword research (billed) ───────────────────────────────────────
// Wraps the same SERP + SEMrush adapter the Gentle Dental wizard uses, with
// the client's own seed qualifier from its profile — without it every query
// would be prefixed "Dental" (the adapter's dental-catalogue default).
router.post('/keyword-candidates', wrap(async (req, res) => {
  const { clientId, serviceId, locationId } = req.body;
  if (!clientId || !serviceId || !locationId) {
    return res.status(400).json({ error: 'clientId, serviceId, locationId are required.' });
  }
  const { layers, profile } = await lsCompose.loadLsLayers({ clientId, serviceId, locationId });
  const { service, location } = layers;
  res.json(await keywordAdapter.getKeywordCandidates({
    service: service.name,
    city: location.city,
    state: location.state_abbreviation,
    stateName: location.state,
    region: location.region,
    seedQuery: req.body.seedQuery,
    clientId,
    serviceSlug: service.slug,
    qualifier: profile.seedQualifier,
  }));
}));

// ── Step 3: the approved keyword list ──────────────────────────────────────
// Saved the moment it is approved, not as a byproduct of generating — leaving
// the wizard used to lose the work, and re-opening a page with nothing to
// rehydrate from silently re-ran the billed research call.
router.post('/keywords', wrap(async (req, res) => {
  const tuple = requireTuple(req, res);
  if (!tuple) return;
  const { primary, secondary, candidates, approved } = req.body;
  const saved = await lsWizard.saveSelection({
    ...tuple,
    primary: primary || [], secondary: secondary || [], candidates: candidates || [],
    // Default true: an explicit POST with no flag is a deliberate approval.
    approved: approved !== false,
  });
  res.json({ saved: true, approved: saved.approved, approvedAt: saved.approved_at });
}));

router.get('/keywords', wrap(async (req, res) => {
  const tuple = requireTuple(req, res);
  if (!tuple) return;
  const sel = await lsWizard.getSelection(tuple);
  if (!sel) return res.json({ exists: false, primary: [], secondary: [], candidates: [] });
  res.json({
    exists: true,
    primary: sel.primary || [], secondary: sel.secondary || [], candidates: sel.candidates || [],
    approved: sel.approved !== false, approvedAt: sel.approved_at || null,
  });
}));

// ── Step 4: the brief ──────────────────────────────────────────────────────
router.post('/brief', wrapStep(async (req, res) => {
  const tuple = requireTuple(req, res);
  if (!tuple) return;
  const { primaryKeywords, secondaryKeywords, competitorUrls } = req.body;
  if (!Array.isArray(primaryKeywords) || !primaryKeywords.filter(Boolean).length) {
    return res.status(400).json({ error: 'primaryKeywords (array, at least 1) is required.' });
  }
  res.json(await lsWizard.generateBrief({
    ...tuple,
    primaryKeywords,
    secondaryKeywords: secondaryKeywords || [],
    // Absent, the SERP picks the competitors; present, the reviewer's list wins.
    competitorUrls: Array.isArray(competitorUrls) ? competitorUrls : null,
  }));
}));

// Save the reviewer's edits, optionally approving in the same call (which is
// what the wizard's "Approve brief & write content" button does). The brief is
// re-normalized server-side, so an edited one still satisfies the constraints
// the writer prompt and the QC gates assume.
router.put('/brief', wrapStep(async (req, res) => {
  const tuple = requireTuple(req, res);
  if (!tuple) return;
  if (!req.body.brief) return res.status(400).json({ error: 'brief is required.' });
  res.json(await lsWizard.saveBrief({ ...tuple, brief: req.body.brief, approve: !!req.body.approve }));
}));

// ── Step 5: the copy ───────────────────────────────────────────────────────
router.post('/copy', wrapStep(async (req, res) => {
  const tuple = requireTuple(req, res);
  if (!tuple) return;
  res.json(await lsWizard.generateCopy(tuple));
}));

router.post('/regenerate', wrapStep(async (req, res) => {
  const tuple = requireTuple(req, res);
  if (!tuple) return;
  const { field, index } = req.body;
  if (!field) return res.status(400).json({ error: 'field is required.' });
  res.json(await lsWizard.regenerateField({ ...tuple, field, index }));
}));

// ── Pages ──────────────────────────────────────────────────────────────────
// Only one page per (client, service, location) tuple is ever stored, so step 1
// can detect "you have already built this combination" and offer to open it
// rather than blindly regenerating (and re-billing).
router.get('/existing', wrap(async (req, res) => {
  const tuple = requireTuple(req, res);
  if (!tuple) return;
  const page = await lsWizard.getExistingPage(tuple);
  res.json({
    exists: !!page, pageId: page?.id || null, page: page?.page_object || null,
    status: page?.status || null, updatedAt: page?.updated_at || null,
  });
}));

// This engine's own dashboard. The module's /pages list is built around the
// Neuro page_object and excludes anything else, so without this the pages
// generated here would be saved but invisible.
router.get('/pages', wrap(async (req, res) => {
  const clientId = req.query.clientId || req.query.client_id;
  if (!clientId) return res.status(400).json({ error: 'clientId is required.' });
  const [pages, services, locations] = await Promise.all([
    store.list('pages', { client_id: clientId }),
    store.list('services', { client_id: clientId }),
    store.list('locations', { client_id: clientId }),
  ]);
  const S = Object.fromEntries(services.map(s => [s.id, s]));
  const L = Object.fromEntries(locations.map(l => [l.id, l]));
  res.json(pages
    .filter(p => p.page_type === lsProfiles.LS_PAGE_TYPE && p.page_object)
    .map(p => ({
      id: p.id, status: p.status,
      service_id: p.service_id, location_id: p.location_id,
      service_name: S[p.service_id]?.name || '',
      location_name: L[p.location_id]?.location_name || '',
      primary_keyword: p.page_object.primaryKeyword || '',
      url_path: p.page_object.meta?.urlPath || '',
      brief_approved: !!p.page_object.brief?.approved,
      has_copy: !!(p.page_object.sections?.body?.blocks || []).length,
      qc_verdict: p.page_object.qc?.verdict || null,
      updated_at: p.updated_at,
    }))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));
}));

router.get('/pages/:id', wrap(async (req, res) => {
  const page = await store.get('pages', req.params.id);
  if (!page || page.page_type !== lsProfiles.LS_PAGE_TYPE) return res.status(404).json({ error: 'Page not found.' });
  res.json({
    pageId: page.id, page: page.page_object,
    clientId: page.client_id, serviceId: page.service_id, locationId: page.location_id,
  });
}));

// Persist manual edits from steps 4 and 5. Schema and QC are re-derived from
// what is actually stored, so an edit can never leave a stale verdict — or a
// stale FAQPage block — on the record.
router.put('/pages/:id', wrapStep(async (req, res) => {
  if (!req.body.page) return res.status(400).json({ error: 'page is required.' });
  const saved = await lsWizard.saveContent({ pageId: req.params.id, page: req.body.page });
  res.json({ saved: true, updatedAt: saved.updated_at, qc: saved.page_object?.qc || null, status: saved.status });
}));

// ── QC ─────────────────────────────────────────────────────────────────────
// Runs against the page in the REQUEST BODY, not one read back by id: the
// wizard edits client-side and only persists on Save, so an id-based check
// would grade content the reviewer can no longer see.
router.post('/qc', wrapStep(async (req, res) => {
  const { page, pageId, clientId } = req.body;
  if (!lsCompose.isLsScaffold(page)) return res.status(400).json({ error: 'page (with meta + sections) is required.' });
  const qc = await lsWizard.qcFor({ clientId, page });
  // With a pageId the verdict is stored rather than recomputed-and-lost on
  // every reload. Non-fatal: still return the verdict if the write fails.
  if (pageId) {
    try { await lsWizard.saveQc({ pageId, qc }); }
    catch (e) { console.error('[LPB/ls] Failed to persist QC verdict:', e.message); }
  }
  res.json(qc);
}));

// Re-run ONE check — the per-notice "Recheck" button, so confirming a single
// fix costs one check instead of the whole set. `checks` is the client's
// current result set, spliced and re-verdicted server-side.
router.post('/qc/check', wrapStep(async (req, res) => {
  const { page, pageId, id, checks, clientId } = req.body;
  if (!lsCompose.isLsScaffold(page)) return res.status(400).json({ error: 'page (with meta + sections) is required.' });
  if (!id) return res.status(400).json({ error: 'id (QC check id) is required.' });
  const { check, verdict, checks: merged } = await lsWizard.qcFor({ clientId, page, id, checks });
  // pageId is sent only when the client has no unsaved edits: a verdict
  // computed from content the store does not have yet must not be written
  // against the content it does.
  if (pageId) {
    try { await lsWizard.saveQc({ pageId, qc: { verdict, checks: merged } }); }
    catch (e) { console.error('[LPB/ls] Failed to persist QC verdict:', e.message); }
  }
  res.json({ check, verdict, checks: merged });
}));

// ── Export ─────────────────────────────────────────────────────────────────
// POSTs the on-screen page rather than reading it back by id, for the same
// reason QC does: the reviewer must get a document containing the edits they
// are looking at, saved or not.
router.post('/export/:format', wrapStep(async (req, res) => {
  const { page } = req.body;
  if (!lsCompose.isLsScaffold(page)) return res.status(400).json({ error: 'page (with meta + sections) is required.' });
  const fname = exporter.safeFilename(page);
  const fmt = req.params.format;

  if (fmt === 'markdown' || fmt === 'md') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.md"`);
    return res.send(exporter.toLsMarkdown(page));
  }
  if (fmt === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.json"`);
    return res.send(exporter.toLsJSON(page));
  }
  if (fmt === 'docx') {
    const buffer = await exporter.toLsDocxBuffer(page);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.docx"`);
    return res.send(buffer);
  }
  res.status(400).json({ error: `Unknown format "${fmt}".` });
}));

module.exports = router;
