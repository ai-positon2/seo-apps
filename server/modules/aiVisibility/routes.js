// ── AI Visibility API ────────────────────────────────────────────────────────
//
//   GET    /api/ai-visibility/:projectId/report     latest run + its captures
//   GET    /api/ai-visibility/:projectId/prompts    the question set
//   POST   /api/ai-visibility/:projectId/prompts    add prompts
//   DELETE /api/ai-visibility/:projectId/prompts/:id  retire one
//
// Every handler derives workspace access server-side through projectAccess —
// there is no route here that takes a workspace id from the client and trusts
// it. Reading is 'view'; changing the question set is 'editProjectSettings',
// because the prompt set decides what every future number means.

const express = require('express');
const projectAccess = require('../../services/projectAccess');
const moduleEvidence = require('../projects/moduleEvidence');
const scoring = require('./scoring');
const store = require('./store');

const router = express.Router({ mergeParams: true });

const MODULE_KEY = 'ai_visibility';

function handleError(res, e, where) {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code || undefined });
  }
  console.error(`[aiVisibility.${where}]`, e?.stack || e?.message || e);
  res.status(500).json({ error: 'Something went wrong reading AI visibility.' });
}

/**
 * The report for the latest run that produced something.
 *
 * Rebuilt from stored captures rather than read off the run's payload, so the
 * numbers on screen are always derivable from the evidence underneath them. A
 * payload written by an older version of the scorer cannot drift away from what
 * the rows actually say.
 */
router.get('/:projectId/report', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');

    const runs = await moduleEvidence.listRuns(access.project.id, MODULE_KEY, { limit: 10 });
    // A failed run can still hold real captures — the first live run stored six
    // and then fell over closing itself. Prefer a run with evidence over the
    // most recent one.
    let run = null;
    let captures = [];
    for (const candidate of runs) {
      const rows = await store.capturesForRun(candidate.id);
      if (rows.length) { run = candidate; captures = rows; break; }
      if (!run) run = candidate;
    }

    const prompts = await store.listPrompts(access.project.id).catch(() => []);

    if (!run) {
      return res.json({
        run: null, report: null, captures: [], prompts,
        note: 'AI Visibility has not run for this client yet.',
      });
    }

    const brand = run.payload?.brand
      || { name: access.project.name, domain: access.project.url };

    return res.json({
      run: {
        id: run.id,
        status: run.status,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        score: run.score,
        scoreBasis: run.score_basis,
        note: run.note,
        error: run.error,
      },
      // Null when the run stored no captures — never an empty report, which
      // would render as "measured everything, found nothing".
      report: captures.length ? scoring.summarise(captures, brand) : null,
      captures,
      prompts,
      promptBasis: run.payload?.promptBasis || null,
    });
  } catch (e) { handleError(res, e, 'report'); }
});

router.get('/:projectId/prompts', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    res.json({
      prompts: await store.listPrompts(access.project.id, {
        includeRetired: req.query.retired === 'true',
      }),
    });
  } catch (e) { handleError(res, e, 'listPrompts'); }
});

router.post('/:projectId/prompts', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );

    const incoming = Array.isArray(req.body?.prompts) ? req.body.prompts : [];
    const cleaned = incoming
      .map((p) => (typeof p === 'string' ? { text: p } : p))
      .filter((p) => p && typeof p.text === 'string' && p.text.trim())
      .map((p) => ({ text: p.text.trim(), source: 'manual', intent: p.intent || null }));

    if (!cleaned.length) return res.status(400).json({ error: 'No prompts to add.' });

    const added = await store.addPrompts({ access, prompts: cleaned });
    res.status(201).json({
      added,
      // Says how many were already there rather than silently adding fewer than
      // were sent.
      skipped: cleaned.length - added.length,
    });
  } catch (e) { handleError(res, e, 'addPrompts'); }
});

router.delete('/:projectId/prompts/:promptId', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const prompt = await store.retirePrompt({ access, promptId: req.params.promptId });
    if (!prompt) return res.status(404).json({ error: 'Prompt not found.' });
    // Retired, not deleted: its captures still count in the runs that measured it.
    res.json({ prompt, retired: true });
  } catch (e) { handleError(res, e, 'retirePrompt'); }
});

module.exports = router;
