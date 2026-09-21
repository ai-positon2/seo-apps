const express = require('express');
const { z } = require('zod');
const projectAccess = require('../../services/projectAccess');
const { generateArticleBrief } = require('../../services/articleBrief');
const { generateDraft } = require('./writer');
const { parseBrief, briefHash, ensureFaqSection } = require('./document');
const { planBrief, hasKey: hasPlannerKey } = require('./briefPlan');
const store = require('./store');
const router = express.Router();
router.post('/projects/:projectId/export', async (req, res) => {
  try {
    await projectAccess.requireProject(req, req.params.projectId, 'view');
    const stage = z.enum(['brief', 'draft']).parse(req.body.stage);
    const document = store.exportable(req.body.document);
    if (stage === 'brief' ? !document.brief : !document.draftHtml) return res.status(400).json({ error: 'Nothing to export yet.' });
    const buffer = await require('./export').exportDocx(document, stage);
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="content-${stage}.docx"` }).send(buffer);
  } catch (e) { error(res, e); }
});

function error(res, e) {
  if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
  console.error('[content-writer]', e.message);
  if (e.code === '42P01' && /content_writer_articles/.test(e.message)) {
    return res.status(503).json({
      code: 'content_writer_storage_not_ready',
      error: 'Content Writer project storage is not set up yet. Apply database migration 0031_content_writer.sql, then retry.',
    });
  }
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Content Writer could not complete this request. Check server configuration and retry.' });
}
router.param('projectId', (req, res, next, id) => {
  if (!z.string().uuid().safeParse(id).success) return res.status(400).json({ error: 'Invalid project ID.' });
  next();
});
router.param('id', (req, res, next, id) => {
  if (!z.string().uuid().safeParse(id).success) return res.status(400).json({ error: 'Invalid article ID.' });
  next();
});
router.get('/projects/:projectId/articles', async (req, res) => {
  try {
    await projectAccess.requireProject(req, req.params.projectId, 'view');
    res.json({ articles: await store.list(req.params.projectId) });
  } catch (e) { error(res, e); }
});
router.post('/projects/:projectId/articles', async (req, res) => {
  try {
    await projectAccess.requireProject(req, req.params.projectId, 'editRecommendation');
    res.status(201).json(await store.create(req.params.projectId, req.body));
  } catch (e) { error(res, e); }
});
router.get('/projects/:projectId/articles/:id', async (req, res) => {
  try {
    await projectAccess.requireProject(req, req.params.projectId, 'view');
    res.json(await store.get(req.params.projectId, req.params.id));
  } catch (e) { error(res, e); }
});
router.put('/projects/:projectId/articles/:id', async (req, res) => {
  try {
    await projectAccess.requireProject(req, req.params.projectId, 'editRecommendation');
    const revision = z.number().int().positive().parse(req.body.revision);
    const current = await store.get(req.params.projectId, req.params.id);
    const edited = store.editable(req.body.document);
    const document = { ...current.document, ...edited };
    if (edited.draftHtml !== current.document.draftHtml && document.research) {
      document.research = { ...document.research, status: 'Draft edited after source check' };
    }
    res.json(await store.save(req.params.projectId, req.params.id, revision, document));
  } catch (e) { error(res, e); }
});

async function generate(req, res, stage) {
  let heartbeat;
  try {
    await projectAccess.requireProject(req, req.params.projectId, 'startRun');
    const row = await store.get(req.params.projectId, req.params.id);
    if (row.revision !== req.body.revision) throw store.conflict();
    if (stage === 'draft' && (!row.document.brief?.sections.length || !row.document.brief.title.trim())) {
      throw Object.assign(new Error('Build and review a brief before generating a draft.'), { status: 400 });
    }
    // Planning runs last but is required, so refuse before spending a search,
    // ten page fetches and four model calls on a brief that cannot complete.
    if (stage === 'brief' && !hasPlannerKey()) {
      throw Object.assign(new Error('Brief planning needs ANTHROPIC_API_KEY, which is not configured on this server. Set it and try again.'),
        { status: 503, code: 'anthropic_not_configured' });
    }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const emit = (event, data) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
    let patch;
    if (stage === 'brief') {
      const result = await generateArticleBrief({ keyword: row.document.keyword,
        client: row.document.options.client, feedbackKbIds: row.document.options.feedbackKbIds,
        // An explicit word count wins; otherwise size the article to the pages that rank.
        targetWords: row.document.options.wordCount || 'auto' }, emit);
      const outline = ensureFaqSection(parseBrief(result.brief));
      const planned = await planBrief(outline, { keyword: row.document.keyword, targetWords: result.targetWords,
        secondaryKeywords: row.document.options.secondaryKeywords }, emit);
      patch = { brief: planned.brief, briefPlan: planned.plan, sourceUrls: result.sourceUrls, targetWords: result.targetWords };
    } else {
      patch = { ...await generateDraft(row.document, emit), draftBriefHash: briefHash(row.document.brief) };
    }
    // Long generation must not overwrite an intervening edit, or bypass revoked access.
    await projectAccess.requireProject(req, req.params.projectId, 'editRecommendation');
    const saved = await store.save(req.params.projectId, req.params.id, row.revision, { ...row.document, ...patch });
    emit('result', saved);
    emit('done', {});
  } catch (e) {
    if (res.headersSent) {
      if (!res.destroyed) res.write(`event: fail\ndata: ${JSON.stringify({ message: e.message, code: e.code, issues: e.issues })}\n\n`);
    } else error(res, e);
  } finally {
    clearInterval(heartbeat);
    if (res.headersSent && !res.writableEnded) res.end();
  }
}
router.post('/projects/:projectId/articles/:id/brief', (req, res) => generate(req, res, 'brief'));
router.post('/projects/:projectId/articles/:id/draft', (req, res) => generate(req, res, 'draft'));
module.exports = router;
