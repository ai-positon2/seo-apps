// ── AI Visibility API ────────────────────────────────────────────────────────
//
//   GET    /api/ai-visibility/:projectId/report               latest run's report
//   GET    /api/ai-visibility/:projectId/prompts               the prompt set
//   POST   /api/ai-visibility/:projectId/prompts               add prompts
//   PATCH  /api/ai-visibility/:projectId/prompts/:id            edit a prompt
//   POST   /api/ai-visibility/:projectId/prompts/:id/status     draft/approved/rejected/retired
//   POST   /api/ai-visibility/:projectId/prompts/approve        bulk approve
//   POST   /api/ai-visibility/:projectId/prompts/:id/restore    retired -> approved
//   DELETE /api/ai-visibility/:projectId/prompts/:id            retire (contract kept)
//   GET    /api/ai-visibility/:projectId/prompts/evidence        what will/won't ground the next generation
//   POST   /api/ai-visibility/:projectId/prompts/generate         generate a draft set (spends money)
//   GET    /api/ai-visibility/:projectId/prompts/generation       poll the latest generation job
//
// Every handler derives workspace access server-side through projectAccess —
// there is no route here that takes a workspace id from the client and trusts
// it. Reading is 'view'. Every WRITE, including approving a prompt AND
// generating a draft, is 'editProjectSettings' — not 'startRun', which
// contributors also hold. Approving is what releases spend on measuring a
// question; generating spends directly (one LLM call per page chosen) —
// neither must be reachable by a contributor.
//
// Generation is DETACHED: the run row opens synchronously so the 202 carries
// a real id to poll, and the (multi-second-to-multi-minute) work continues
// after the response is sent. It is deliberately not routed through
// moduleRunners.runModule, which only requires 'startRun'.

const express = require('express');
const projectAccess = require('../../services/projectAccess');
const adminLimits = require('../../services/adminLimits');
const moduleEvidence = require('../projects/moduleEvidence');
const projectsStore = require('../projects/store');
const scoring = require('./scoring');
const store = require('./store');
const lifecycle = require('./promptLifecycle');
const promptTopics = require('./promptTopics');
const crawledPages = require('../projects/crawledPages');
const generate = require('./generate');
const pagePrompts = require('./pagePrompts');
const reports = require('./metrics/reports');
const periodMath = require('./metrics/period');
const extractionPass = require('./extractionPass');
const brandAliases = require('./captureEngines/brandAliases');
const { brandFrom, competitorsFrom } = require('./run');

const router = express.Router({ mergeParams: true });

const MODULE_KEY = 'ai_visibility';
const GENERATION_MODULE_KEY = 'ai_visibility_prompts';

function handleError(res, e, where) {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code || undefined });
  }
  console.error(`[aiVisibility.${where}]`, e?.stack || e?.message || e);
  res.status(500).json({ error: 'Something went wrong reading AI visibility.' });
}

/**
 * How many questions this client asks, against the admin-configured limit.
 *
 * `limit` is null (not a number) when the database is unavailable — a counter
 * with no denominator is honest; a fake one is not.
 *
 * The per-slot breakdown and the topic x slot cross-tab that used to live
 * here went with the slot generator. Nobody chose anything from them, and
 * "coverage" meaning two different things on one screen was half the reason
 * the screen was confusing.
 */
async function coverageFor(access) {
  const [limit, counts] = await Promise.all([
    adminLimits.limit('maxPromptsPerVisibilityRun', { workspaceId: access.project.workspace_id }).catch(() => null),
    store.countPromptsByStatus(access.project.id).catch(() => ({})),
  ]);

  return {
    limit,
    quota: limit, // back-compat: the client read `quota` before this was renamed
    approved: counts.approved || 0,
    draft: counts.draft || 0,
    retired: counts.retired || 0,
  };
}

/** Topic summary for the prompt-set screen's grouping headers. */
async function topicsFor(access) {
  const live = await store.listPrompts(access.project.id, { status: ['draft', 'approved'] }).catch(() => []);
  const byLabel = new Map();
  for (const p of live) {
    const label = p.topicLabel || 'Uncategorised';
    if (!byLabel.has(label)) {
      byLabel.set(label, {
        label, kind: p.topicKind || null, targetUrl: p.targetUrl || null, approved: 0, draft: 0,
      });
    }
    const t = byLabel.get(label);
    if (p.status === 'approved') t.approved += 1;
    else t.draft += 1;
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * `access.project` is the raw crawl_projects row (see
 * projectAccess.requireProject) — brandFrom/competitorsFrom are written
 * against a projectView (camelCase primaryDomain/competitors/countryCode).
 * Building the view here, from the row projectAccess already fetched plus one
 * domains read, is the same fix moduleRunners.runAiVisibility needed and for
 * the identical reason: without it, brand.domain silently resolves to
 * nothing and competitors is always [].
 */
async function projectViewFor(access) {
  const domains = await projectsStore.listDomains(access.project.id);
  return projectsStore.projectView(access.project, domains);
}

/** The latest prompt-generation job for this project, or null if none has run. */
async function latestGeneration(projectId) {
  const runs = await moduleEvidence.listRuns(projectId, GENERATION_MODULE_KEY, { limit: 1 }).catch(() => []);
  const run = runs[0];
  if (!run) return null;
  return {
    runId: run.id,
    status: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    error: run.error || null,
  };
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
    // One query for all ten runs, not one per run. This probed each candidate
    // in turn, so the common case — the newest run has evidence — still paid
    // for a round trip, and the worst case paid for ten.
    let run = runs[0] || null;
    let captures = [];
    if (runs.length) {
      const byRun = await store.capturesForRuns(runs.map((r) => r.id)).catch(() => new Map());
      const withEvidence = runs.find((r) => (byRun.get(r.id) || []).length);
      if (withEvidence) {
        run = withEvidence;
        captures = byRun.get(withEvidence.id) || [];
      }
    }

    // The full prompt set (not just approved) so byPrompt/byTopic can show a
    // draft or rejected prompt's history if it was ever measured, and so an
    // approved-but-unmeasured prompt still renders with `surfaces: []`.
    const prompts = await store.listPrompts(access.project.id, { status: ['draft', 'approved'] }).catch(() => []);
    const counts = await store.countPromptsByStatus(access.project.id).catch(() => null);

    if (!run) {
      return res.json({
        run: null, report: null, captures: [], prompts,
        promptSet: { counts, coverage: await coverageFor(access).catch(() => null) },
        byPrompt: [], byTopic: [],
        note: 'AI Visibility has not run for this client yet.',
      });
    }

    const brand = run.payload?.brand
      || { name: access.project.name, domain: access.project.url };

    let report = null;
    let byPrompt = [];
    let byTopic = [];
    if (captures.length) {
      report = scoring.summarise(captures, brand);
      byPrompt = scoring.groupByPrompt(captures, prompts);
      byTopic = scoring.groupByTopic(byPrompt);
      const topicFlags = scoring.topicFindings(byTopic);
      if (topicFlags.length) report = { ...report, findings: [...report.findings, ...topicFlags] };
    }

    const measuredIds = new Set(run.payload?.measuredPromptIds || []);
    const approvedNotMeasured = prompts.filter((p) => p.status === 'approved' && !measuredIds.has(p.id));

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
      report,
      captures,
      prompts,
      promptBasis: run.payload?.promptBasis || null,
      promptSet: {
        counts,
        coverage: await coverageFor(access).catch(() => null),
        measured: { promptIds: [...measuredIds], count: measuredIds.size },
        unmeasured: {
          count: approvedNotMeasured.length,
          reason: run.payload?.overBudget ? 'over_budget' : null,
        },
        pendingReview: counts?.draft || 0,
        generatedAt: run.payload?.promptBasis ? run.started_at : null,
      },
      byPrompt,
      byTopic,
    });
  } catch (e) { handleError(res, e, 'report'); }
});

router.get('/:projectId/prompts', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');

    const statusParam = req.query.status
      ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean)
      : null;

    const [prompts, counts, coverage, topics, generation] = await Promise.all([
      store.listPrompts(access.project.id, {
        status: statusParam,
        slot: req.query.slot || null,
        topic: req.query.topic || null,
        includeRetired: req.query.retired === 'true',
        includeEvidence: req.query.evidence === 'true',
      }),
      store.countPromptsByStatus(access.project.id).catch(() => null),
      coverageFor(access).catch(() => null),
      topicsFor(access).catch(() => []),
      latestGeneration(access.project.id).catch(() => null),
    ]);

    res.json({
      prompts, counts, coverage, topics, generation,
    });
  } catch (e) { handleError(res, e, 'listPrompts'); }
});

/**
 * Every crawled page, as one choosable row.
 *
 * Reads the crawl directly. It used to go through a five-collector evidence
 * gatherer (clusters, competitor keywords, page keywords, a knowledge-base
 * seam) so the slot generator could ground on all of it; the only field this
 * ever needed was `pages`, and the rest went with that generator.
 *
 * Read-only and free: no LLM, no provider call. Choosing should cost nothing;
 * only generating spends.
 */
router.get('/:projectId/prompts/topics', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const project = await projectViewFor(access);
    const brand = brandFrom(project);

    const pages = await crawledPages.listPageContent(access.project.id, { limit: 60 })
      .catch(() => []);
    const topics = promptTopics.topicPerUrl({ pages }, { brandName: brand?.name || null });

    // Pages that already have a prompt behind them, so the picker can say so
    // rather than letting someone silently ask the same question twice.
    const prompts = await store
      .listPrompts(access.project.id, { status: ['draft', 'approved'] })
      .catch(() => []);
    const covered = new Set(
      prompts.map((p) => p.targetUrl).filter(Boolean).map((u) => promptTopics.normaliseUrl(u)),
    );

    const groups = [...new Set(topics.map((t) => t.group))];

    res.json({
      topics: topics.map((t) => ({
        ...t,
        covered: covered.has(promptTopics.normaliseUrl(t.targetUrl)),
      })),
      groups,
      total: topics.length,
      coveredCount: topics.filter((t) => covered.has(promptTopics.normaliseUrl(t.targetUrl))).length,
    });
  } catch (e) { handleError(res, e, 'prompts.topics'); }
});


/**
 * How many approved prompts this client may hold.
 *
 * Resolved per request rather than cached: an admin can change the limit, and
 * a stale ceiling would either block a legitimate approval or wave one past.
 */
async function budgetFor(access) {
  const n = await adminLimits
    .limit('maxPromptsPerVisibilityRun', { workspaceId: access.project.workspace_id })
    .catch(() => null);
  return Number(n) || 20;
}

/**
 * Kicks off a draft generation. 202 + a real run id — the row is opened
 * BEFORE responding, and the (possibly multi-minute) work continues after
 * the response is sent. One at a time per project: a second request while
 * one is already running gets a 409 naming the run in progress rather than
 * two generations racing each other's evidence reads.
 */
router.post('/:projectId/prompts/generate', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );

    const [inFlight] = await moduleEvidence.listRuns(access.project.id, generate.MODULE_KEY, { limit: 1 });
    if (inFlight && inFlight.status === 'running') {
      return res.status(409).json({
        error: 'A prompt generation is already running for this client.',
        code: 'generation_in_progress',
        runId: inFlight.id,
      });
    }

    const project = await projectViewFor(access);

    // Pages the person actually picked. Capped at what the per-page writer
    // will process, so the count in the response matches what happens rather
    // than what was asked for. `topicUrls` is the old name, still accepted.
    const urls = [req.body?.urls, req.body?.topicUrls]
      .find((v) => Array.isArray(v) && v.length) || [];
    const asked = urls
      .filter((u) => typeof u === 'string' && u.trim())
      .slice(0, pagePrompts.MAX_PAGES);

    if (!asked.length) {
      return res.status(400).json({
        error: 'Choose at least one page to write a question about.',
        code: 'no_pages',
      });
    }

    // Only this client's own crawled pages, and nothing else.
    //
    // pagePrompts FETCHES each of these, following redirects. Taking the list
    // from the request body unchecked made this endpoint a server-side request
    // forgery: any contributor could point it at cloud metadata or an internal
    // host, and the response body would come back out inside the generated
    // question text. The chooser already offers only crawled pages, so
    // intersecting against them costs one query and closes it entirely.
    const crawled = await crawledPages.listPageContent(access.project.id, { limit: 500 })
      .catch(() => []);
    const allowed = new Set(
      crawled.map((pg) => promptTopics.normaliseUrl(pg.url)).filter(Boolean),
    );
    const chosen = asked.filter((u) => allowed.has(promptTopics.normaliseUrl(u)));

    if (!chosen.length) {
      return res.status(400).json({
        error: 'Those pages are not in this client\'s latest crawl. Pick from the list.',
        code: 'urls_not_crawled',
      });
    }

    const run = await generate.startGeneration({ access });

    // Detached: nothing here awaits this, and runGeneration never throws past
    // its own failRun, so there is nothing for this callback to catch beyond
    // a defensive log if closing the run itself somehow fails.
    generate.runGeneration({ access, project, run, urls: chosen })
      .catch((e) => console.error('[aiVisibility.generate] run failed to close cleanly:', e.message));

    res.status(202).json({
      run: { id: run.id, status: run.status, startedAt: run.started_at },
      estimate: {
        llmCalls: chosen.length,
        pages: chosen.length,
        model: pagePrompts.MODEL,
        note: `Reads ${chosen.length} page(s) and writes one question each with `
          + `${pagePrompts.MODEL} — one call per page. Nothing is measured until `
          + 'it is approved.',
      },
    });
  } catch (e) { handleError(res, e, 'generate'); }
});

/** What the UI polls after the 202. */
router.get('/:projectId/prompts/generation', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const [run] = await moduleEvidence.listRuns(access.project.id, generate.MODULE_KEY, { limit: 1 });
    if (!run) return res.json({ run: null });

    res.json({
      run: {
        id: run.id,
        status: run.status,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        error: run.error || null,
      },
      basis: run.payload?.basis || null,
      availability: run.payload?.evidenceAvailability || [],
      counts: run.payload?.counts || null,
      spend: run.payload?.spend || null,
      model: run.payload?.model || null,
      // Which chosen pages produced no prompt, and why. Without this the UI can
      // only say "10 asked for, 7 arrived" and leave three unexplained.
      skippedPages: run.payload?.skippedPages || [],
      truncated: run.payload?.truncated || false,
    });
  } catch (e) { handleError(res, e, 'generation'); }
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
      .map((p) => ({
        text: p.text,
        // 0016 hard-forced source: 'manual' regardless of what was sent. A
        // hand-typed prompt IS manual, but that forcing also made it
        // impossible to re-import a reviewed set with its real provenance —
        // so a caller may now say where it came from; unset still means
        // 'manual'.
        source: p.source || lifecycle.SOURCES.MANUAL,
        sourceRef: p.sourceRef,
        intent: p.intent,
        slot: p.slot,
        rationale: p.rationale,
        topicKind: p.topicKind,
        topicLabel: p.topicLabel,
        targetUrl: p.targetUrl,
        demandVolume: p.demandVolume,
        demandSource: p.demandSource,
      }));

    if (!cleaned.length) return res.status(400).json({ error: 'No prompts to add.' });

    // 'approved' is honoured only for a caller who can actually approve — the
    // capability required to hit this route at all (editProjectSettings) is
    // exactly that bar, so no separate check is needed: whoever can reach
    // this line could also approve these prompts one at a time afterward.
    const status = req.body?.status === 'approved' ? 'approved' : 'draft';

    const { added, skipped } = await store.addPrompts({ access, prompts: cleaned, status });
    res.status(added.length ? 201 : 200).json({ added, skipped });
  } catch (e) { handleError(res, e, 'addPrompts'); }
});

router.patch('/:projectId/prompts/:promptId', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const patch = {};
    if (req.body?.text !== undefined) patch.text = req.body.text;
    if (req.body?.intent !== undefined) patch.intent = req.body.intent;
    if (req.body?.slot !== undefined) patch.slot = req.body.slot;
    if (req.body?.rationale !== undefined) patch.rationale = req.body.rationale;

    const result = await store.updatePrompt({ access, promptId: req.params.promptId, patch });
    res.json(result);
  } catch (e) { handleError(res, e, 'updatePrompt'); }
});

router.post('/:projectId/prompts/:promptId/status', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const to = req.body?.to;
    if (!to || !lifecycle.STATUSES.includes(to)) {
      return res.status(400).json({
        error: `to must be one of: ${lifecycle.STATUSES.join(', ')}.`, code: 'bad_status',
      });
    }
    const budget = req.body?.to === 'approved' ? await budgetFor(access) : null;
    const prompt = await store.transitionPrompt({
      budget,
      access, promptId: req.params.promptId, to, reason: req.body?.reason || null,
    });
    res.json({ prompt });
  } catch (e) { handleError(res, e, 'transitionPrompt'); }
});

router.post('/:projectId/prompts/approve', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );

    let promptIds = Array.isArray(req.body?.promptIds) ? req.body.promptIds.filter(Boolean) : null;

    // 'all' (optionally scoped to one slot) is resolved from the CURRENT
    // draft set on the server, never from ids the client already had —
    // a stale tab must not approve something added after it loaded, and
    // must not silently miss something added since.
    if (!promptIds && (req.body?.all === true || req.body?.slot)) {
      const drafts = await store.listPrompts(access.project.id, {
        status: 'draft', slot: req.body?.slot || null,
      });
      promptIds = drafts.map((p) => p.id);
    }

    if (!promptIds || !promptIds.length) {
      return res.status(400).json({ error: 'Nothing to approve.' });
    }

    const { approved, failed } = await store.approvePrompts({
      access, promptIds, budget: await budgetFor(access),
    });
    res.json({
      approved, failed, counts: await store.countPromptsByStatus(access.project.id).catch(() => null),
    });
  } catch (e) { handleError(res, e, 'approvePrompts'); }
});

router.post('/:projectId/prompts/:promptId/restore', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const prompt = await store.restorePrompt({ access, promptId: req.params.promptId });
    res.json({ prompt });
  } catch (e) { handleError(res, e, 'restorePrompt'); }
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

// ── The nine reports (METRICS.md §12) ──────────────────────────────────────
//
// One endpoint, one envelope, so the shell switches reports without bespoke
// plumbing. Every number arrives pre-formatted; the client reads `display` and
// `deltaDisplay` and picks a colour from `direction`.

/** Catalogue for the rail — labels and grouping, no data. */
router.get('/:projectId/reports', async (req, res) => {
  try {
    await projectAccess.requireProject(req, req.params.projectId, 'view');
    res.json({ reports: reports.REPORTS });
  } catch (e) { handleError(res, e, 'reports.list'); }
});

/**
 * One report.
 *
 * Reads BOTH periods in a single query — the current window and the equal-length
 * one before it — because §3.8's delta needs both, and two round trips would
 * let a capture written between them appear in one side and not the other.
 */
router.get('/:projectId/reports/:reportId', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const { reportId } = req.params;

    if (!reports.REPORT_IDS.includes(reportId)) {
      return res.status(400).json({
        error: `Unknown report "${reportId}".`,
        code: 'unknown_report',
        available: reports.REPORT_IDS,
      });
    }

    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const options = {
      days,
      to: req.query.to || undefined,
      from: req.query.from || undefined,
      engine: req.query.engine && req.query.engine !== 'all' ? req.query.engine : null,
    };

    // Widen the read to cover the comparison window too.
    const window = periodMath.periods(options);
    const captures = await store.capturesForPeriod(access.project.id, {
      from: window.previous.from,
      to: window.current.to,
    });

    const entities = await store.entitiesForCaptures(captures.map((c) => c.id));
    const [brands, prompts] = await Promise.all([
      store.listBrands(access.project.id, { status: 'approved' }),
      store.listPrompts(access.project.id, { status: ['draft', 'approved'] }).catch(() => []),
    ]);

    // A capture that has never been through extraction has no mention rows, and
    // zero mention rows is indistinguishable from "measured, never named". Say
    // how many are in that state rather than letting them read as absences.
    const unextracted = captures.filter((c) => c.status === 'captured' && !c.extractedAt).length;

    const built = reports.buildReport(reportId, {
      captures,
      mentions: entities.mentions,
      citations: entities.citations,
      attributes: entities.attributes,
      brands: brands.map((b) => ({
        id: b.id, name: b.name, domain: b.domain, isClient: b.isClient,
      })),
      prompts,
      options,
    });

    if (unextracted) {
      built.warnings.push('captures_not_extracted');
      built.meta.unextracted = unextracted;
    }
    // `no_client_brand` already covers this and says it better. Two warnings
    // stacked saying the same thing reads as two problems.
    if (!brands.length && !built.warnings.includes('no_client_brand')) {
      built.warnings.push('no_approved_brands');
    }

    built.meta.report = reports.REPORTS.find((r) => r.id === reportId);
    res.json(built);
  } catch (e) { handleError(res, e, 'reports.get'); }
});

/**
 * One captured answer, in full.
 *
 * The Chats table shows a 180-character excerpt because 44 rows of prose is
 * not a table. This is what a reader gets when they open one: the answer as
 * the engine gave it, with its citations.
 */
router.get('/:projectId/captures/:captureId', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const capture = await store.captureDetail(access.project.id, req.params.captureId);
    if (!capture) return res.status(404).json({ error: 'No such capture.', code: 'not_found' });
    res.json({ capture });
  } catch (e) { handleError(res, e, 'captureDetail'); }
});

// ── Brands: the measured set (§3.4) ────────────────────────────────────────
//
// Nothing is measured against a brand until a person approves it. Aliases are
// derived and PROPOSED — measuring on an unreviewed alias set is how a generic
// industry word ends up matching the whole category.

router.get('/:projectId/brands', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const brands = await store.listBrands(access.project.id);
    res.json({
      brands,
      counts: brands.reduce((acc, b) => ({ ...acc, [b.status]: (acc[b.status] || 0) + 1 }), {}),
      // Without an approved client brand, extraction has nothing to measure —
      // say so here rather than letting every report render empty.
      hasApprovedClient: brands.some((b) => b.isClient && b.status === 'approved'),
    });
  } catch (e) { handleError(res, e, 'brands.list'); }
});

/**
 * Derive aliases from the project's own configuration and propose them.
 *
 * Read-only against everything except `project_brands`, and it never approves:
 * the derived set lands as `proposed` and a person releases it.
 */
router.post('/:projectId/brands/derive', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const project = await projectViewFor(access);

    // Names the models have actually used, harvested from stored answers, beat
    // a domain stem every time: competitor "names" in this codebase are stems
    // ("aspendental"), which no model ever writes.
    const proposals = brandAliases.deriveMeasuredSet({ project });

    const result = await store.upsertBrands({ access, brands: proposals });
    res.json({
      ...result,
      proposals,
      // A brand whose every token is a generic industry word would get a
      // matcher that fires on the whole category. Flagged, never silently used.
      weak: proposals.filter((p) => p.strength !== 'strong').map((p) => p.name),
    });
  } catch (e) { handleError(res, e, 'brands.derive'); }
});

router.patch('/:projectId/brands/:brandId', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const brand = await store.transitionBrand({
      access, brandId: req.params.brandId, to: req.body?.status,
    });
    res.json({ brand });
  } catch (e) { handleError(res, e, 'brands.transition'); }
});

// ── Extraction ─────────────────────────────────────────────────────────────

/**
 * Run the extraction pass over captures that have not had one.
 *
 * `editProjectSettings` rather than a contributor permission: the LLM pass
 * costs money per capture, and spend follows the same rule as approving a
 * prompt.
 */
router.post('/:projectId/extract', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const summary = await extractionPass.extractPending({
      access,
      limit: Math.max(1, Math.min(200, Number(req.body?.limit) || 50)),
      useLlm: req.body?.useLlm !== false,
    });
    res.json(summary);
  } catch (e) { handleError(res, e, 'extract'); }
});

/** How much is waiting, so the UI can offer the pass without guessing. */
router.get('/:projectId/extract/pending', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const pending = await store.capturesPendingExtraction(access.project.id, { limit: 200 });
    const brands = await store.listBrands(access.project.id, { status: 'approved' });
    res.json({
      pending: pending.length,
      atLimit: pending.length >= 200,
      measuredSetSize: brands.length,
      blocked: brands.length ? null : 'no_approved_brands',
      extractionVersion: extractionPass.EXTRACTION_VERSION,
    });
  } catch (e) { handleError(res, e, 'extract.pending'); }
});

module.exports = router;
