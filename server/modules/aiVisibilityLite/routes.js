// ── AI Visibility Lite API ───────────────────────────────────────────────────
//
//   GET    /api/ai-visibility-lite/:projectId              everything the page needs on load
//   POST   /api/ai-visibility-lite/:projectId/setup        identify the business, write 10 prompts
//   GET    /api/ai-visibility-lite/:projectId/setup        poll the latest setup job
//   GET    /api/ai-visibility-lite/:projectId/prompts      the question set
//   POST   /api/ai-visibility-lite/:projectId/prompts      add custom questions
//   PATCH  /api/ai-visibility-lite/:projectId/prompts/:id  edit one
//   DELETE /api/ai-visibility-lite/:projectId/prompts/:id  delete one (a retire — see store.js)
//   POST   /api/ai-visibility-lite/:projectId/run          measure (spends money, capped at 30)
//   GET    /api/ai-visibility-lite/:projectId/runs         run history and what is left of the budget
//   GET    /api/ai-visibility-lite/:projectId/report       the report, rebuilt from stored captures
//
// Every handler derives workspace access server-side through projectAccess.
// There is no route here that takes a workspace id from the client and trusts
// it. Reading is 'view'.
//
// Writes split by what they SPEND, following v1's reasoning:
//
//   'editProjectSettings' — setup and prompt edits. Setup makes model calls,
//                           and a prompt is the thing a run spends money
//                           measuring. Contributors hold 'startRun' and must
//                           not be able to rewrite what gets measured.
//   'startRun'            — the run itself, matching every other module's run
//                           button.
//
// Both long jobs are DETACHED: the run row opens synchronously so the 202
// carries a real id to poll, and the work continues after the response is sent.

const express = require('express');
const projectAccess = require('../../services/projectAccess');
const projectsStore = require('../projects/store');
const moduleEvidence = require('../projects/moduleEvidence');
const store = require('./store');
const setup = require('./setup');
const runner = require('./run');
const report = require('./report');
const surfacesLib = require('./surfaces');
const { MAX_PROMPTS, AUTO_PROMPT_COUNT } = require('./models');
const { classifyTones, TONE_VERSION } = require('./describe');
const { namesBrand, prominenceOf } = require('../aiVisibility/capture');

/**
 * Re-decide `mentioned` for stored answers against the CURRENT name list.
 *
 * The column was written at capture time with whatever names the profile had
 * then — which for some projects included products the business only offers
 * (see brandNames.js). Re-deciding on read, with the same matcher capture
 * used, means a corrected name list fixes every existing report at once,
 * without rewriting stored evidence. A failed capture stays null: there is
 * no answer to re-read.
 */
function rematch(captures, brand) {
  const names = [brand.name, ...(brand.aliases || [])].filter(Boolean);
  if (!names.length) return captures;
  return captures.map((c) => {
    if (c.mentioned === null || c.mentioned === undefined || !c.answerText) return c;
    return {
      ...c,
      mentioned: namesBrand(c.answerText, names),
      prominence: prominenceOf(c.answerText, names),
    };
  });
}

const router = express.Router({ mergeParams: true });

function handleError(res, e, where) {
  if (e && e.status) {
    return res.status(e.status).json({
      error: e.message,
      code: e.code || undefined,
      // A cap refusal is only actionable if it says what is left.
      budget: e.budget || undefined,
    });
  }
  console.error(`[aiVisibilityLite.${where}]`, e?.stack || e?.message || e);
  res.status(500).json({ error: 'Something went wrong reading AI visibility.' });
}

async function projectViewFor(access) {
  const domains = await projectsStore.listDomains(access.project.id);
  return projectsStore.projectView(access.project, domains);
}

/** The latest run of one module key, flattened for polling. */
async function latestRun(projectId, moduleKey) {
  const runs = await moduleEvidence.listRuns(projectId, moduleKey, { limit: 1 }).catch(() => []);
  const run = runs[0];
  if (!run) return null;
  return {
    runId: run.id,
    status: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    score: run.score,
    error: run.error || null,
    payload: run.payload || null,
  };
}

/**
 * The most recent run that actually produced descriptors, PLUS every run's own
 * sentiment score (for report.build's composite `score` — see its runSentiment
 * doc), from one shared fetch.
 *
 * `panelLook` stays small (a handful of runs): beyond that the descriptor
 * artefact is old enough that showing it unlabelled would be worse than
 * showing nothing, and the caller renders the empty state instead. `look`
 * (the sentiment history) goes back further, because compositeScore reweights
 * around a missing perception reading anyway — an old one is still better than
 * none, as long as its own date travels with it, which sentimentByRun carries.
 */
async function describedHistory(projectId, { panelLook = 5, look = 100 } = {}) {
  const runs = await moduleEvidence
    .listRuns(projectId, runner.MODULE_KEY, { limit: look })
    .catch(() => []);

  let latest = null;
  for (const run of runs.slice(0, panelLook)) {
    const payload = run.payload?.described;
    if (!payload) continue;
    latest = {
      payload,
      // finished_at, not created_at: the descriptors describe the answers as
      // they were when the run closed.
      at: run.finished_at || run.created_at || null,
      runId: run.id,
    };
    break;
  }

  const sentimentByRun = new Map();
  // Every run's per-answer tones, pooled — report.js keys them by run, prompt
  // and engine, so which run they were stored on does not matter to it.
  const answerTones = [];
  for (const run of runs) {
    for (const t of run.payload?.answerTones || []) answerTones.push({ ...t, runId: t.runId || run.id });
    const score = run.payload?.described?.sentiment?.score;
    if (typeof score !== 'number' || !Number.isFinite(score)) continue;
    sentimentByRun.set(run.id, { score, at: run.finished_at || run.created_at || null });
  }

  return { latest, sentimentByRun, answerTones };
}

// ── The page load ──────────────────────────────────────────────────────────

/**
 * Everything the screen needs in one call.
 *
 * One request rather than five, because the page cannot render anything
 * sensible until it knows all of it: whether setup has run, how many questions
 * there are, how many runs are left, and whether the providers are even
 * configured. Five round trips would render four intermediate states nobody
 * wants to see.
 */
router.get('/:projectId', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const projectId = access.project.id;

    const [profile, prompts, budget, setupRun, measureRun] = await Promise.all([
      store.getProfile(projectId),
      store.listPrompts(projectId),
      store.runBudget(projectId),
      latestRun(projectId, setup.MODULE_KEY),
      latestRun(projectId, runner.MODULE_KEY),
    ]);

    res.json({
      profile,
      prompts,
      promptCap: MAX_PROMPTS,
      autoPromptCount: AUTO_PROMPT_COUNT,
      budget,
      setup: setupRun,
      latestRun: measureRun,
      // Which providers can actually answer, and why not when they cannot. The
      // page says so up front rather than letting someone spend a run to find
      // out a key is missing.
      surfaces: surfacesLib.availability(),
    });
  } catch (e) { handleError(res, e, 'status'); }
});

// ── Setup: identify the business, write the questions ──────────────────────

router.post('/:projectId/setup', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const project = await projectViewFor(access);
    const regenerate = req.body?.regenerate === true;

    const existing = await store.listPrompts(access.project.id);
    if (existing.length && !regenerate) {
      return res.status(409).json({
        error: 'This project already has its questions. Pass regenerate to rewrite them.',
        code: 'already_set_up',
      });
    }

    // Opened synchronously so the 202 below carries an id the client can poll
    // the instant it starts. The work itself is multi-second.
    const run = await setup.start({ access });

    setup.complete({ access, project, run, regenerate })
      .then(() => (
        // The first measurement follows setup without anyone pressing anything
        // — saving the project is meant to be the whole interaction. Starts
        // nothing if this project has measured before, so a regenerate on a
        // live project does not spend a run.
        runner.startFirstMeasurement({ access, project, trigger: 'auto_setup' })
      ))
      .catch((e) => {
        // complete() already closed the run row as failed. Nothing to do here but
        // keep the rejection from becoming an unhandled one.
        console.error('[aiVisibilityLite.setup]', e?.message || e);
      });

    res.status(202).json({ runId: run.id, status: 'running' });
  } catch (e) { handleError(res, e, 'setup'); }
});

router.get('/:projectId/setup', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    res.json({ setup: await latestRun(access.project.id, setup.MODULE_KEY) });
  } catch (e) { handleError(res, e, 'setup.poll'); }
});

// ── Prompts ────────────────────────────────────────────────────────────────

router.get('/:projectId/prompts', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const prompts = await store.listPrompts(access.project.id, {
      includeRetired: req.query.includeRetired === 'true',
    });
    res.json({ prompts, cap: MAX_PROMPTS, used: prompts.filter((p) => p.active).length });
  } catch (e) { handleError(res, e, 'prompts.list'); }
});

router.post('/:projectId/prompts', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    // Accepts one or many. The UI adds one at a time; a paste of several is the
    // obvious next request and costs nothing to support now.
    const body = req.body?.prompts || (req.body?.text ? [{ text: req.body.text, intent: req.body.intent }] : []);
    if (!body.length) {
      return res.status(400).json({ error: 'Send a prompt to add.', field: 'text' });
    }

    const result = await store.addPrompts({ access, prompts: body, source: 'custom' });
    res.status(result.added.length ? 201 : 200).json(result);
  } catch (e) { handleError(res, e, 'prompts.add'); }
});

router.patch('/:projectId/prompts/:promptId', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const prompt = await store.updatePrompt({
      access,
      promptId: req.params.promptId,
      text: req.body?.text,
      intent: req.body?.intent,
    });
    res.json({ prompt });
  } catch (e) { handleError(res, e, 'prompts.update'); }
});

router.delete('/:projectId/prompts/:promptId', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const prompt = await store.deletePrompt({ access, promptId: req.params.promptId });
    // null means it was already deleted. Not an error — the only way to get
    // here twice is a double-click.
    res.json({ deleted: true, prompt });
  } catch (e) { handleError(res, e, 'prompts.delete'); }
});

// ── Measuring ──────────────────────────────────────────────────────────────

router.post('/:projectId/run', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'startRun');
    const project = await projectViewFor(access);

    // The cap, checked before the run row opens. runOnce checks it again after
    // opening to settle a race; this one is what makes the refusal cheap and
    // gives the client a body it can render.
    await runner.assertRunnable(access.project.id);

    const started = runner.runOnce({ access, project, trigger: 'manual' });

    // Detached, like setup: a full run is minutes, and a request held open for
    // that long is a request that times out somewhere in between.
    started.catch((e) => {
      console.error('[aiVisibilityLite.run]', e?.message || e);
    });

    const budget = await store.runBudget(access.project.id);
    res.status(202).json({ status: 'running', budget });
  } catch (e) { handleError(res, e, 'run'); }
});

router.get('/:projectId/runs', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const projectId = access.project.id;
    const limit = Math.min(Number(req.query.limit) || 30, 100);

    const [runs, budget] = await Promise.all([
      moduleEvidence.listRuns(projectId, runner.MODULE_KEY, { limit }).catch(() => []),
      store.runBudget(projectId),
    ]);

    res.json({
      budget,
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        score: r.score,
        scoreBasis: r.score_basis,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        error: r.error || null,
      })),
    });
  } catch (e) { handleError(res, e, 'runs'); }
});

// ── The report ─────────────────────────────────────────────────────────────

router.get('/:projectId/report', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const projectId = access.project.id;
    const project = await projectViewFor(access);

    const [captures, prompts, profile, budget] = await Promise.all([
      store.capturesForProject(projectId),
      store.listPrompts(projectId),
      store.getProfile(projectId),
      store.runBudget(projectId),
    ]);

    if (!captures.length) {
      // Not an error and not an empty report — a state. A project that has
      // never run has no numbers, and inventing zeroes for it is the failure
      // this whole module is careful about.
      return res.json({
        state: 'not_run',
        budget,
        promptsLive: prompts.length,
        report: null,
      });
    }

    // Competitors as well as the brand: the comparison table, share of
    // mentions and the 'competitor' source category all need them, and
    // identityFor already merges the project's configured domains with the
    // names the profile found on the site.
    const { brand, competitors, nameCheck } = await runner.identityFor(project, profile);
    const checked = rematch(captures, brand);

    // The descriptor and sentiment history come from runs' payloads rather
    // than being recomputed here: they cost a model call, so they are produced
    // once when a run happens and read back afterwards. Everything else on the
    // report is rebuilt from stored captures on every read.
    //
    // For `described`: the NEWEST RUN THAT HAS THEM, not simply the newest
    // run. Reading only the latest meant one failed or still-running
    // measurement blanked the whole panel — no attributes, no sentiment, no
    // quotes — even though the run before it had produced a perfectly good
    // set. An empty panel then looked like "the models said nothing about
    // you", which is a finding, rather than "the last run did not finish",
    // which is not. It carries its own timestamp and answer count because it
    // is NOT scoped by the ?from/?to period the rest of the report obeys: it
    // is a frozen artefact of one run over at most 20 answers. Labelling it
    // with its own basis is what stops it being read as covering the selected
    // window.
    //
    // For `sentimentByRun`: report.build's composite `score` needs each run's
    // OWN reading (see report.js's runSentiment doc), so this is fetched
    // ahead of build() rather than after it.
    const { latest: described, sentimentByRun, answerTones } = await describedHistory(projectId);

    const built = report.build({
      captures: checked,
      prompts,
      brand,
      competitors,
      options: {
        from: req.query.from || null,
        to: req.query.to || null,
      },
      runSentiment: sentimentByRun,
      answerTones,
    });

    // Answers that name the client but carry no tone yet — runs from before
    // per-answer tones existed. Tagged in the background rather than in this
    // request, and the page is told so it can re-read when they land.
    const analysing = startSentimentBackfill({
      projectId, captures: checked, brand, answerTones,
    });

    res.json({
      state: 'ok',
      budget,
      report: built,
      described: described?.payload || null,
      describedAt: described?.at || null,
      describedRunId: described?.runId || null,
      sentimentAnalysing: analysing,
      // Which names count as a mention of this business, and which of the
      // profile's names were set aside and why — shown on Setup & runs.
      nameCheck,
    });
  } catch (e) { handleError(res, e, 'report'); }
});

// ── Sentiment backfill: tag answers that have no tone yet ──────────────────
//
// Started by a report read, never by a click: the report is how anybody sees
// sentiment, so it is where missing tones get noticed. One job per project at
// a time (a second read while one is running just reports it running), and an
// answer tried once in this process is not retried — one the model could not
// back with a quote would otherwise be re-read, and re-billed, on every load.

const BACKFILL_CAP = 200;
const backfillJobs = new Map(); // projectId -> Promise
const backfillTried = new Map(); // projectId -> Set of toneKeys

function startSentimentBackfill({
  projectId, captures, brand, answerTones,
}) {
  if (backfillJobs.has(projectId)) return true;
  if (!brand?.name) return false;

  // Tones from older instructions do not count as done — they are re-read.
  const have = new Set(answerTones
    .filter((t) => t.v === TONE_VERSION)
    .map((t) => report.toneKey(t.runId, t.promptId, t.engine)));
  if (!backfillTried.has(projectId)) backfillTried.set(projectId, new Set());
  const tried = backfillTried.get(projectId);

  const pending = captures
    .filter((c) => c.runId && c.status === 'captured' && c.mentioned === true && c.answerText)
    .filter((c) => {
      const key = report.toneKey(c.runId, c.promptId, c.engine);
      return !have.has(key) && !tried.has(key);
    })
    .slice(0, BACKFILL_CAP);
  if (!pending.length) return false;

  pending.forEach((c) => tried.add(report.toneKey(c.runId, c.promptId, c.engine)));

  const job = (async () => {
    const tones = await classifyTones({ rows: pending, brand });
    const byRun = new Map();
    for (const t of tones) {
      if (!byRun.has(t.runId)) byRun.set(t.runId, []);
      byRun.get(t.runId).push(t);
    }
    for (const [runId, list] of byRun) {
      // eslint-disable-next-line no-await-in-loop
      await store.appendRunTones(projectId, runId, list);
    }
    console.log(`[aiVisibilityLite] project ${projectId}: tagged ${tones.length} of ${pending.length} answers for sentiment`);
  })()
    .catch((e) => console.warn(`[aiVisibilityLite] project ${projectId}: sentiment backfill failed (${e.message})`))
    .finally(() => backfillJobs.delete(projectId));

  backfillJobs.set(projectId, job);
  return true;
}

module.exports = router;
