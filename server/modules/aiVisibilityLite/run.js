// ── One AI Visibility Lite run ───────────────────────────────────────────────
//
// Measures every live prompt against all three model APIs, stores the evidence,
// and closes the module run with a score.
//
// ── Where the time goes, and why the shape is what it is ───────────────────
//
// v1's run is sequential because each scraped capture takes 25–110 seconds and
// firing them in parallel is the surest way to get the account rate-limited
// mid-run, losing prompts already paid for. Neither constraint applies here: an
// API answer takes a few seconds and the three providers are different accounts
// on different infrastructure, so asking all three at once costs nothing and
// cuts the wall clock to a third.
//
// Prompts stay sequential against each provider. Twenty prompts fired at one
// provider at once is exactly the burst their rate limiter exists to refuse,
// and a run that half-fails is worse than one that takes two minutes. So:
// prompts in series, surfaces in parallel — around 3 minutes for a full set,
// against 10–35 for v1.
//
// ── The cap is enforced here ───────────────────────────────────────────────
//
// Server-side, from stored rows, before the run opens. A UI that hides the
// button is a courtesy; this is the cap. It is checked at the top of runOnce so
// there is no path — autostart, route, retry — that can spend a 31st run.

const moduleEvidence = require('../projects/moduleEvidence');
const scoring = require('../aiVisibility/scoring');
const { describe } = require('./describe');
const { brandFrom, competitorsFrom } = require('../aiVisibility/run');
const { measure } = require('./measure');
const surfacesLib = require('./surfaces');
const store = require('./store');

const MODULE_KEY = 'ai_visibility_lite';

/**
 * The identity to measure, from the project AND the profile.
 *
 * v1's `brandFrom` reads the project row — name, domain, any aliases somebody
 * configured by hand. The profile adds what the SITE says the business calls
 * itself, which is usually the one a model actually writes. Neither alone is
 * enough: the project row knows the domain, the profile knows the name.
 *
 * Merged rather than replaced, and deduplicated case-insensitively so
 * "Brush and Floss" and "brush and floss" do not both get a matcher.
 */
function identityFor(project, profile) {
  const base = brandFrom(project);
  const seen = new Set([base.name, ...base.aliases].map((a) => String(a).toLowerCase()));
  const aliases = [...base.aliases];

  for (const alias of profile?.brandAliases || []) {
    const key = String(alias).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }

  const brand = {
    // The site's own name wins over the project label: a project somebody named
    // "Dentist — NC" measures nothing, and the profile read the real one off the
    // homepage.
    name: profile?.businessName || base.name,
    domain: base.domain,
    aliases,
  };

  // Competitors from project_domains, plus any the profile found named on the
  // site. Domain-derived stems are a poor substitute for a real name — v1's
  // competitorsFrom says so itself — so the profile's names are additive.
  const configured = competitorsFrom(project);
  const known = new Set(configured.map((c) => String(c.name).toLowerCase()));
  const competitors = [...configured];
  for (const name of profile?.competitors || []) {
    if (known.has(String(name).toLowerCase())) continue;
    known.add(String(name).toLowerCase());
    competitors.push({ name, domain: null, aliases: [] });
  }

  return { brand, competitors };
}

/**
 * Check the run budget and the provider keys before anything is spent.
 *
 * Returns the budget when the run may proceed; throws a 409 otherwise. Split
 * out so a route can ask "could I run?" without opening a run row.
 */
async function assertRunnable(projectId) {
  const budget = await store.runBudget(projectId);
  if (budget.remaining <= 0) {
    throw Object.assign(
      new Error(
        `This project has used all ${budget.cap} of its measurement runs. `
        + 'The cap exists because every run spends real money at three providers.',
      ),
      { status: 409, code: 'run_cap_reached', budget },
    );
  }

  const ready = surfacesLib.readySurfaceIds();
  if (!ready.length) {
    const why = surfacesLib.availability().map((s) => s.reason).filter(Boolean);
    throw Object.assign(
      new Error(`No model APIs are configured, so there is nothing to measure. ${why.join(' ')}`),
      { status: 503, code: 'no_surfaces' },
    );
  }

  return { budget, ready };
}

/**
 * Do the work against an ALREADY-OPEN run row.
 *
 * Split from runOnce for the reason v1's runAiVisibility is: a run reaching
 * here through the module queue has already had its row created and marked
 * running by the worker's claim, and opening a second one would leave an
 * orphan at 'running' forever.
 *
 * RETURNS a result rather than closing the row, which is the contract every
 * runner in modules/projects/moduleRunners.js follows — `executeOpenRun` calls
 * completeRun with what it gets back, and a function that closed its own row
 * would be closed twice. The second write fails on the missing scoreBasis, so
 * the failure is loud rather than silent, but it is still a failure on a run
 * whose captures are already paid for.
 *
 * Failing the row is the caller's job too, for the same reason: the queue owns
 * a claim it may have lost, and only it knows whether the row is still its to
 * write.
 *
 * @param {object} input
 * @param {object} input.access   {project, userId} — a queued run has no actor
 * @param {object} input.project  projectView
 * @param {object} input.run      the open project_module_runs row
 * @returns {Promise<object>} {status, score, scoreBasis, findings, payload}
 */
async function execute({ access, project, run }) {
  const projectId = access.project.id;

  {
    // The cap, now that this run's own row exists.
    //
    // assertRunnable reads the count BEFORE inserting, so two requests arriving
    // together can both be told there is one run left and both open one.
    // Re-counting after the insert is what actually decides it: the row is
    // already in the count, so whichever request pushed the total past the cap
    // loses and closes its own run without spending a single API call.
    const afterOpen = await store.runBudget(projectId);
    if (afterOpen.used > afterOpen.cap) {
      throw Object.assign(
        new Error(
          `This project has used all ${afterOpen.cap} of its measurement runs. `
          + 'Another run started at the same moment as this one.',
        ),
        { status: 409, code: 'run_cap_reached', budget: afterOpen },
      );
    }

    const ready = surfacesLib.readySurfaceIds();
    if (!ready.length) {
      const why = surfacesLib.availability().map((s) => s.reason).filter(Boolean);
      throw Object.assign(
        new Error(`No model APIs are configured, so there is nothing to measure. ${why.join(' ')}`),
        { status: 503, code: 'no_surfaces' },
      );
    }

    const prompts = await store.listPrompts(projectId);
    if (!prompts.length) {
      throw Object.assign(
        new Error('This project has no prompts yet. Generate them before measuring.'),
        { status: 409, code: 'no_prompts' },
      );
    }

    const profile = await store.getProfile(projectId);
    const { brand, competitors } = identityFor(project, profile);

    const rows = [];

    // Prompts in series; the three providers in parallel for each. See the
    // header for why this is the right way round.
    /* eslint-disable no-await-in-loop */
    for (const prompt of prompts) {
      const measured = await Promise.all(
        ready.map((surfaceId) => measure({
          surfaceId, prompt: prompt.text, brand, competitors,
        })),
      );
      // measure() never throws — every outcome is a row — so a provider having
      // a bad moment costs one capture, not the run.
      for (const row of measured) rows.push({ ...row, promptId: prompt.id });
    }
    /* eslint-enable no-await-in-loop */

    await store.saveCaptures({ access, runId: run.id, rows });

    // v1's scoring, unchanged. It reads the shape measure() returns, so these
    // rows go in exactly as they are.
    const summary = scoring.summarise(rows, { name: brand.name, domain: brand.domain });

    // What the answers SAID about the brand, as opposed to whether they named
    // it. One model call over the whole set — see describe.js. Never fatal: a
    // descriptor panel is not worth losing a run's captures over, and every
    // number above is already computed.
    const described = await describe({ rows, brand }).catch((e) => {
      console.warn(`[aiVisibilityLite] run ${run.id}: descriptors skipped (${e.message})`);
      return null;
    });

    const budget = await store.runBudget(projectId);

    return {
      score: summary.score,
      scoreBasis: summary.scoreBasis,
      findings: summary.findings,
      // A run that measured nothing at all is not a zero — it is a run that
      // failed to measure, and 'insufficient_data' is the status that says so
      // without putting a 0 on the dashboard.
      status: summary.score === null ? 'insufficient_data' : 'completed',
      payload: {
        ...summary,
        promptCount: prompts.length,
        surfaces: ready,
        // How many answers were actually grounded in a live search. A run whose
        // answers came from training data measured something else, and this is
        // the number that says so.
        grounded: rows.filter((r) => r.grounded === true).length,
        // How the models described the brand, with the verbatim quotes that
        // back each descriptor. Null when too few answers named it.
        described,
        budget,
      },
    };
  }
}

/**
 * Run the module once, opening the run row first.
 *
 * The path a person pressing Run takes. The queue takes `execute` directly,
 * against the row its claim already opened.
 *
 * @param {object} input
 * @param {object} input.access   from projectAccess.requireProject
 * @param {object} input.project  projectView
 * @param {string} [input.trigger]
 * @returns {Promise<object>} the closed project_module_runs row
 */
async function runOnce({ access, project, trigger = 'manual' }) {
  // Before the run row exists, so a refused run does not consume one of the 20.
  await assertRunnable(access.project.id);
  const run = await moduleEvidence.startRun({ access, moduleKey: MODULE_KEY, trigger });

  // This path opened the row, so this path closes it. On the queue path
  // moduleRunners.executeOpenRun does both, which is why `execute` itself does
  // neither.
  try {
    const result = await execute({ access, project, run });
    return await moduleEvidence.completeRun({ access, runId: run.id, ...result });
  } catch (error) {
    await moduleEvidence.failRun({ access, runId: run.id, error }).catch(() => {});
    throw error;
  }
}

/**
 * Start the first measurement for a project that has never had one.
 *
 * The brief is that saving a project is the whole interaction: identify the
 * business, write the questions, measure. Pressing a button afterwards is a
 * step nobody chose. So every path that finishes setup calls this, not just the
 * one that runs when a project is created — a project set up by hand from the
 * screen gets measured for the same reason.
 *
 * Idempotent by construction: it starts nothing if this project has ever had a
 * measurement run, whatever came of it. A failed first run is not retried
 * automatically — that would spend the budget on a provider outage — and a
 * successful one obviously must not be repeated.
 *
 * Never throws. A measurement that could not be started is reported through the
 * run history and the screen; failing setup because of it would report the
 * wrong thing.
 *
 * @returns {Promise<{started: boolean, reason: string|null}>}
 */
async function startFirstMeasurement({ access, project, trigger = 'auto_setup' }) {
  const projectId = access.project.id;
  try {
    const budget = await store.runBudget(projectId);
    // `used` counts every run that ever reached 'running'. Non-zero means this
    // project has measured before, so this is not a first measurement.
    if (budget.used > 0) return { started: false, reason: 'already_measured' };
    if (budget.remaining <= 0) return { started: false, reason: 'run_cap_reached' };

    const prompts = await store.listPrompts(projectId);
    if (!prompts.length) return { started: false, reason: 'no_prompts' };

    const ready = surfacesLib.readySurfaceIds();
    if (!ready.length) return { started: false, reason: 'not_configured' };

    // Detached: a run is minutes, and every caller of this is either a request
    // that has already answered or one that must not wait.
    runOnce({ access, project, trigger }).catch((e) => {
      // runOnce closes the run row as failed itself. This only stops the
      // rejection becoming an unhandled one.
      console.error('[aiVisibilityLite.startFirstMeasurement]', e?.message || e);
    });
    return { started: true, reason: null };
  } catch (e) {
    console.error('[aiVisibilityLite.startFirstMeasurement]', e?.message || e);
    return { started: false, reason: 'not_started' };
  }
}

module.exports = {
  MODULE_KEY, execute, runOnce, assertRunnable, identityFor, startFirstMeasurement,
};
