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

const moduleEvidence = require('../projects/moduleEvidence');
const adminLimits = require('../../services/adminLimits');
const capture = require('./capture');
const scoring = require('./scoring');
const store = require('./store');
const promptBuilder = require('./promptBuilder');
const { surfaceIds, surfaceFor } = require('./surfaces');

const MODULE_KEY = 'ai_visibility';

// The surfaces a run measures unless told otherwise. ChatGPT first because it is
// the one clients ask about; AI Overview second because it is cheap and often
// has no answer at all for a given query, which is itself worth reporting.
const DEFAULT_SURFACES = ['chatgpt:dataforseo', 'google_ai_overview:dataforseo'];

// A ceiling on spend and wall clock, not a target. 20 prompts × 2 surfaces at
// ~60s each is already over half an hour.
const DEFAULT_PROMPT_BUDGET = 20;

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
  const chosen = (surfaces || DEFAULT_SURFACES).filter((id) => surfaceFor(id));
  if (!chosen.length) {
    throw Object.assign(
      new Error(`No known surface among: ${(surfaces || []).join(', ') || '(none given)'}. `
        + `Available: ${surfaceIds().join(', ')}`),
      { status: 400 },
    );
  }

  const budget = (await adminLimits
    .limit('maxPromptsPerVisibilityRun', { workspaceId: project.workspace_id })
    .catch(() => null)) || DEFAULT_PROMPT_BUDGET;

  const brand = brandFrom(project);
  const competitors = competitorsFrom(project);

  // The stored set is the measured set. A run that generated its own prompts
  // each time would move the questions between runs, and a trend line over a
  // moving question set measures the edit rather than the client.
  let prompts = await store.listPrompts(project.id);
  let promptBasis = `${prompts.length} stored prompt(s)`;

  if (!prompts.length) {
    const built = await promptBuilder.buildPrompts({
      brandName: brand.name,
      brandDomain: brand.domain,
      competitors: competitors.map((c) => c.name),
      clusters: await clustersFor(project.id),
      country: project.countryCode,
      count: budget,
    });
    prompts = await store.addPrompts({ access, prompts: built.prompts });
    promptBasis = promptBuilder.basis({ ...built, prompts });
  }

  const measured = prompts.slice(0, budget);
  if (!measured.length) {
    return {
      status: 'insufficient_data',
      note: 'No prompts to measure. Add prompts to this project, or let the builder '
        + 'generate a set from its topic clusters and competitors.',
      payload: { surfaces: chosen, promptBasis },
    };
  }

  // ── Measure ──────────────────────────────────────────────────────────────
  const rows = [];
  for (const prompt of measured) {
    for (const surfaceId of chosen) {
      const row = await capture.measure({
        surfaceId, prompt: prompt.text, brand, competitors,
      });
      rows.push({ ...row, promptId: prompt.id });
    }
  }

  await store.saveCaptures({ access, runId: run.id, rows }).catch((e) => {
    // Storage failing must not discard measurements already paid for; the run
    // still closes with its score and says the evidence did not persist.
    console.error('[aiVisibility.saveCaptures]', e.message);
  });

  // ── Report ───────────────────────────────────────────────────────────────
  const report = scoring.summarise(rows, brand);
  const anyMeasured = report.coverage.measured > 0;

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
    findings: report.findings,
    payload: {
      surfaces: chosen,
      surfaceLabels: report.surfaces,
      promptCount: measured.length,
      promptBasis,
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

/**
 * Content Architect's clusters for this project, if it has run.
 *
 * Read from the stored hub_spoke payload rather than re-running anything: the
 * clusters are already computed and a prompt build must not trigger a crawl.
 */
async function clustersFor(projectId) {
  try {
    const runs = await moduleEvidence.listRuns(projectId, 'hub_spoke', { limit: 1 });
    const payload = runs?.[0]?.payload;
    const clusters = payload?.clusters || payload?.native?.clusters || [];
    return Array.isArray(clusters) ? clusters : [];
  } catch {
    return [];
  }
}

module.exports = {
  MODULE_KEY,
  DEFAULT_SURFACES,
  DEFAULT_PROMPT_BUDGET,
  brandFrom,
  competitorsFrom,
  clustersFor,
  runAiVisibility,
};
