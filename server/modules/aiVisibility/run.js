// ── One AI Visibility run ────────────────────────────────────────────────────
//
// Measures the project's prompt set across the configured surfaces, stores the
// evidence, and closes the module run with a score.
//
// Sequential on purpose. Each ChatGPT capture takes 25–110 seconds and a
// 20-prompt run is therefore 10–35 minutes, which is why this is a background
// job rather than a request. Firing them in parallel would be faster and would
// also be the shape most likely to get the account rate-limited mid-run, losing
// prompts we already paid for.

const adminLimits = require('../../services/adminLimits');
const capture = require('./capture');
const scoring = require('./scoring');
const store = require('./store');
const {
  surfaceIds, surfaceFor, isAvailable, unavailableReason, availableSurfaceIds,
} = require('./surfaces');
const captureScheduler = require('./captureScheduler');
// Named `spendGuard`, not `budget`: this function already has a local `budget`
// holding the PROMPT count, and importing the module under the same name let
// the number shadow it — `budget.createGuard` then resolved against a number
// and every real run threw "budget.createGuard is not a function".
const spendGuard = require('./budget');
const extractionPass = require('./extractionPass');

const MODULE_KEY = 'ai_visibility';

// The surfaces a run measures unless told otherwise. ChatGPT first because it is
// the one clients ask about; AI Overview second because it is cheap and often
// has no answer at all for a given query, which is itself worth reporting.
// The self-hosted pair, which is what runs today: both work from a plain ISP
// address with no proxy. The Google surfaces are registered but gated on
// AIV_PROXIES and rejoin the default set on their own once it is set; the
// DataForSEO pair is deliberately turned off. See surfaces/index.js.
const DEFAULT_SURFACES = ['chatgpt:scraped', 'gemini:scraped'];

// A ceiling on spend and wall clock, not a target. 20 prompts × 2 surfaces at
// ~60s each is already over half an hour.
const DEFAULT_PROMPT_BUDGET = 20;

// moduleEvidence allows this module 45 minutes plus 10 minutes' grace. Stopping
// at 40 leaves room to store, extract and close the run inside that.
//
// Read when used, not at require time — the rule surfaces/index.js follows for
// AIV_DISABLED_SURFACES, and the one a module-level const quietly breaks by
// freezing the value before dotenv has run.
const runDeadlineMs = () => Number(process.env.AIV_RUN_DEADLINE_MS) || 40 * 60_000;

/**
 * The brand identity to measure, from the project.
 *
 * Aliases matter more than they look: "Gentle Dental of New England" and
 * "GentleDental" are the same client, and a model picks whichever it likes.
 * Missing them undercounts mentions and the score reads low for no reason.
 */
function brandFrom(project) {
  const host = project.primaryDomain?.host
    || (() => { try { return new URL(project.legacyUrl).host; } catch { return null; } })();
  const domain = String(host || '').replace(/^www\./i, '').toLowerCase();

  const name = project.name || domain;
  const aliases = [];
  if (name && name.includes(' ')) aliases.push(name.replace(/\s+/g, ''));
  const configured = project.settings?.brandAliases;
  if (Array.isArray(configured)) aliases.push(...configured.filter((a) => typeof a === 'string'));

  return { name, domain, aliases: [...new Set(aliases)] };
}

/** Competitors to score share of voice against, from project_domains. */
function competitorsFrom(project) {
  return (project.competitors || []).map((c) => {
    const host = String(c.host || '').replace(/^www\./i, '');
    // "aspendental.com" -> "Aspen Dental". Crude, and only a fallback: a model
    // writes the brand's real name, not its domain stem.
    const stem = host.split('.')[0];
    return { name: c.name || stem, domain: host, aliases: [stem] };
  });
}

/**
 * Run the module.
 *
 * @param {object} input
 * @param {object} input.access    from projectAccess.requireProject
 * @param {object} input.project   projectView
 * @param {object} input.run       the open project_module_runs row
 * @param {string[]} [input.surfaces]
 */
async function runAiVisibility({ access, project, run, surfaces = null }) {
  // Availability is checked here, not at selection time, because it can change
  // between runs — configuring a proxy brings the Google surfaces back without
  // anyone editing a stored setting.
  //
  // A requested-but-unavailable surface is RECORDED, never silently dropped:
  // quietly measuring two surfaces where four were asked for changes every
  // denominator with nothing on screen to explain it.
  const requested = surfaces || [...DEFAULT_SURFACES, ...availableSurfaceIds()];
  const uniqueRequested = [...new Set(requested)];
  const chosen = uniqueRequested.filter((id) => isAvailable(id));
  const skipped = uniqueRequested
    .filter((id) => !isAvailable(id))
    .map((id) => ({ id, reason: unavailableReason(id) }));
  if (!chosen.length) {
    throw Object.assign(
      new Error(`No known surface among: ${(surfaces || []).join(', ') || '(none given)'}. `
        + `Available: ${surfaceIds().join(', ')}`),
      { status: 400 },
    );
  }

  const budget = (await adminLimits
    .limit('maxPromptsPerVisibilityRun', { workspaceId: project.workspaceId })
    .catch(() => null)) || DEFAULT_PROMPT_BUDGET;

  const brand = brandFrom(project);
  const competitors = competitorsFrom(project);

  // The stored set is the measured set, and only the APPROVED slice of it —
  // store.listPrompts() with no status filter already means "approved only".
  // A run that generated its own prompts and measured them in the same
  // breath (0016's original shape) spent a client's budget on questions
  // nobody chose; that path is gone. Generation is now its own job
  // (aiVisibility/generate.js) that produces drafts, and a human approves
  // before anything here spends money on them.
  const approved = await store.listPrompts(project.id);
  const counts = await store.countPromptsByStatus(project.id).catch(() => null);

  if (!approved.length) {
    const draftCount = counts?.draft || 0;
    return {
      status: 'insufficient_data',
      score: null,
      scoreMax: 100,
      scoreBasis: null,
      findings: [],
      payload: {
        surfaces: chosen, counts, reason: draftCount ? 'awaiting_review' : 'no_prompts',
      },
      // Refusing here costs nothing. Measuring nothing would look like a
      // completed run with no evidence; auto-generating and measuring in the
      // same breath is exactly the "spend on questions nobody chose" bug this
      // refactor removes.
      note: draftCount
        ? `${draftCount} generated prompt(s) are waiting for review. Nothing was measured `
          + 'and nothing was spent — approve the set on the AI Visibility screen and run again.'
        : 'This client has no prompts. Generate a draft set on the AI Visibility screen, '
          + 'review it, and approve the questions worth measuring.',
    };
  }

  const measured = approved.slice(0, budget);
  // How many approved prompts this run's budget did not reach. Silent
  // truncation here would let a trend line change denominator the moment
  // someone approves a 21st prompt, with nothing on screen explaining why.
  const overBudget = approved.length - measured.length;
  const promptBasis = `${measured.length} of ${approved.length} approved prompt(s) measured`
    + (overBudget ? ` (budget ${budget})` : '');

  // ── Measure ──────────────────────────────────────────────────────────────
  //
  // Parallel across surfaces, serial within each. The serial half is the
  // politeness policy — Phase 0 measured that a second Google search inside the
  // cooldown is refused outright — and the parallel half is what makes the
  // daily volume fit at all: prompt x surface serially at 25-110s each is
  // 19-85 hours of wall clock at ten clients.
  //
  // The budget guard is checked BEFORE each capture, never after: a ceiling
  // enforced after the fact has already spent the money it was meant to save.
  const guard = await spendGuard.createGuard(access.project.id).catch(() => null);
  const rests = [];

  const { rows, stopped } = await captureScheduler.measureSet({
    prompts: measured,
    // `.ENGINE`, not `.engine` — the surface contract is uppercase. Lowercase
    // yields undefined for every surface, which collapses them all into ONE
    // engine lane and silently reverts the whole run to serial.
    surfaces: chosen.map((id) => ({
      id,
      engine: surfaceFor(id).ENGINE,
      access: surfaceFor(id).ACCESS || null,
    })),
    measure: ({ surfaceId, prompt }) => capture.measure({
      surfaceId, prompt, brand, competitors,
    }),
    onCapture: (row) => { guard?.record?.(row.taskCost); },
    // Leave a margin inside moduleEvidence's 45-minute allowance so the run
    // closes itself with an honest coverage figure rather than being reaped
    // mid-capture with the spend already made.
    deadlineMs: runDeadlineMs(),
    shouldStop: guard || undefined,
    // A paced engine goes quiet for minutes. Without this the run looks hung
    // to anyone watching it, and the pause leaves no trace afterwards to
    // explain why a 10-prompt run took 13 minutes instead of 9.
    onRest: (info) => {
      rests.push(info);
      console.log(`[aiVisibility] resting ${info.engine} for `
        + `${Math.round(info.restMs / 1000)}s after ${info.after} consecutive captures`);
    },
  });

  // A run whose evidence did not persist has measured nothing.
  //
  // This used to swallow the error and carry on scoring the in-memory rows, so
  // a failed insert produced a completed run with a headline number and no
  // stored captures behind it — a score no report could reproduce and nobody
  // could tell was hollow. The captures are already paid for either way; what
  // changes is whether the run claims to have them.
  let storeError = null;
  await store.saveCaptures({ access, runId: run.id, rows }).catch((e) => {
    storeError = e.message;
    console.error('[aiVisibility.saveCaptures]', e.message);
  });

  if (storeError) {
    return {
      status: 'insufficient_data',
      score: null,
      scoreMax: 100,
      scoreBasis: null,
      findings: [{
        id: 'aiv-captures-not-stored',
        severity: 'error',
        title: 'The answers were captured but could not be stored',
        detail: `${storeError} Nothing from this run reaches the reports. `
          + 'The captures were spent; re-running will spend again.',
      }],
      payload: {
        surfaces: chosen,
        skippedSurfaces: skipped,
        promptCount: measured.length,
        measuredPromptIds: measured.map((p) => p.id),
        // The money was spent whatever happened to the write; this is the one
        // branch where knowing how much matters most.
        spend: rows.reduce((sum, r) => sum + (Number(r.taskCost) || 0), 0),
        enginePauses: rests.map((r) => ({
          engine: r.engine, afterCaptures: r.after, restMs: r.restMs,
        })),
        storeError,
      },
      note: 'The engines answered, but the evidence could not be written. No number '
        + 'from this run is reportable.',
    };
  }

  // ── Extract, as part of measuring ────────────────────────────────────────
  //
  // A stored answer is not a measurement. Every report counts rows in
  // capture_mention and capture_citation, and those only exist after
  // extraction — so a run that captured and stopped leaves the whole surface
  // reading exactly as it did before, and the person who clicked "Measure"
  // concludes, correctly, that nothing happened.
  //
  // Extraction was built as its own route so a ruleset change can re-derive
  // history without re-capturing. That is an operator action. It was never a
  // step a user should have to know about, and leaving it as one made the
  // headline button appear broken.
  //
  // Deterministic only. The LLM pass costs money per capture and scores
  // sentiment; it stays opt-in, and sentiment stays honestly `—` until someone
  // asks for it.
  let extraction = null;
  try {
    extraction = await extractionPass.extractPending({
      access,
      limit: Math.max(rows.length, 50),
      useLlm: false,
    });
  } catch (e) {
    // A failed extraction must not fail a run that has already paid for its
    // captures. The answers are stored; they can be extracted later.
    console.error('[aiVisibility.extractPending]', e.message);
    extraction = { error: e.message };
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const report = scoring.summarise(rows, brand);
  const anyMeasured = report.coverage.measured > 0;

  const findings = [...report.findings];

  // A run cut short by the spend ceiling must say so beside its own numbers.
  // METRICS.md §3.1 makes coverage the denominator everything is judged
  // against, so a truncated run reporting a headline as though the whole set
  // had been asked is a number the client cannot detect and cannot act on.
  // Extraction blocked means captures were stored and counted by nothing. The
  // commonest cause is no approved brand: there is no measured set to match
  // against, so every report would read as an em-dash with no explanation.
  if (extraction?.errors?.length || extraction?.error) {
    const reason = extraction.error || extraction.errors[0]?.message || 'unknown';
    findings.push({
      id: 'aiv-extraction-blocked',
      severity: 'warning',
      title: 'The answers were captured but not counted',
      detail: `${reason} Until this is resolved the reports will not reflect this run.`,
    });
  }

  // A surface that could not run is stated, so a lower coverage number has a
  // visible cause rather than looking like a capture failure.
  for (const s2 of skipped) {
    findings.push({
      id: `aiv-surface-skipped-${s2.id.replace(/[^a-z0-9]+/gi, '-')}`,
      severity: 'notice',
      title: `${s2.id} was not measured`,
      detail: s2.reason === 'needs_proxy'
        ? 'This surface needs a residential proxy. Set AIV_PROXIES and it rejoins '
          + 'automatically — no other change is needed.'
        : s2.reason === 'turned_off'
          ? 'This surface is turned off (AIV_DISABLED_SURFACES).'
          : `Unavailable: ${s2.reason}.`,
    });
  }

  if (stopped) {
    findings.push({
      id: 'aiv-budget-stop',
      severity: 'notice',
      title: 'This run stopped early on the spend ceiling',
      detail: stopped,
    });
  }

  if (overBudget > 0) {
    // A trend line that silently changes denominator the moment someone
    // approves a 21st prompt is worse than one that says so.
    findings.push({
      ruleId: 'aiv-approved-over-budget',
      title: `${overBudget} approved prompt(s) were not measured this run (budget ${budget})`,
      severity: scoring.SEVERITY.notice,
      category: 'AI Visibility',
      count: overBudget,
      detail: { promptIds: approved.slice(budget).map((p) => p.id) },
    });
  }

  // A RESULT OBJECT, not a completed run.
  //
  // moduleRunners.runModule owns closing the row: it takes what a runner returns
  // and calls completeRun itself. Calling completeRun here as well wrote the row
  // correctly and then handed runModule the DATABASE row, whose column is
  // `score_basis` — so `result.scoreBasis` came back undefined and the second
  // completeRun rejected a score with no basis. The run had already succeeded and
  // spent the money; only the bookkeeping failed.
  return {
    status: anyMeasured ? 'completed' : 'insufficient_data',
    score: report.score,
    scoreMax: 100,
    scoreBasis: report.score === null ? null : report.scoreBasis,
    band: `${report.coverage.measured} of ${report.coverage.total} captures measured`,
    findings,
    payload: {
      surfaces: chosen,
      skippedSurfaces: skipped,
      surfaceLabels: report.surfaces,
      promptCount: measured.length,
      // The stable set a trend line reads against — see 0016's/0017's header
      // on why the set has to stay fixed for a trend to mean anything. This
      // is what makes "did the question set change" verifiable after the fact.
      measuredPromptIds: measured.map((p) => p.id),
      promptBasis,
      budget,
      approvedCount: approved.length,
      overBudget,
      // Non-null when the spend ceiling cut the run short. Recorded on the run
      // itself so the truncation stays discoverable after the fact, not just
      // in a finding somebody may have dismissed.
      stoppedReason: stopped || null,
      // What turning those answers into countable rows produced. Without this
      // a run says "10 captured" and the reports say nothing, with no way to
      // tell which step fell over.
      extraction: extraction && !extraction.error
        ? {
          extracted: extraction.extracted,
          skipped: extraction.skipped,
          failed: extraction.failed,
          blocked: extraction.errors?.[0]?.code || null,
        }
        : { error: extraction?.error || null },
      // Engine pauses taken during this run. Explains the wall-clock time
      // after the fact, and is the signal that a burst limit needs retuning.
      enginePauses: rests.map((r) => ({
        engine: r.engine, afterCaptures: r.after, restMs: r.restMs,
      })),
      coverage: report.coverage,
      shareOfVoice: report.shareOfVoice,
      citedDomains: report.citedDomains.slice(0, 30),
      promptsNaming: report.promptsNaming,
      promptsCiting: report.promptsCiting,
      spend: report.spend,
      brand: { name: brand.name, domain: brand.domain },
    },
    note: anyMeasured
      ? `${report.promptsNaming} of ${report.coverage.measured} measured captures named `
        + `${brand.name}. ${report.coverage.failed ? `${report.coverage.failed} could not be measured.` : ''}`
      : 'No capture succeeded, so nothing about this client\'s visibility is known from '
        + 'this run. The prompts were not answered — this is not an absence of the brand.',
  };
}

module.exports = {
  MODULE_KEY,
  DEFAULT_SURFACES,
  DEFAULT_PROMPT_BUDGET,
  brandFrom,
  competitorsFrom,
  runAiVisibility,
};
