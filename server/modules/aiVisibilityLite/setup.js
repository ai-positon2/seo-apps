// ── Identify the business, then write its questions ──────────────────────────
//
// The whole of step one and step two of the one-click flow, wrapped in its own
// module run so the UI has something real to poll while it happens. Follows
// v1's generate.js in shape: open the run row first so a route can hand back a
// run id in its 202 before the multi-second work starts, then do the work
// against that already-open row.
//
// Deliberately NOT counted against the 20-run cap. Identifying a business is
// setup, not measurement, and charging a run for it would mean a project that
// regenerated its questions got fewer measurements than one that never touched
// them. It gets its own module key for exactly that reason (see 0030).
//
// Never throws past failRun: a caller firing this detached only needs to know
// the promise settled, not to handle its rejection.

const moduleEvidence = require('../projects/moduleEvidence');
const businessProfile = require('./businessProfile');
const promptGen = require('./promptGen');
const store = require('./store');
const { AUTO_PROMPT_COUNT, MAX_PROMPTS } = require('./models');

const MODULE_KEY = 'ai_visibility_lite_setup';

/**
 * Open the run row.
 *
 * Split from the work so a route handler can return a real run id the instant
 * the client starts polling, rather than after a page fetch and two model calls.
 */
async function start({ access }) {
  return moduleEvidence.startRun({ access, moduleKey: MODULE_KEY, trigger: 'manual' });
}

/**
 * Do the work against an already-open run and close it.
 *
 * @param {object} input
 * @param {object} input.access   from projectAccess.requireProject
 * @param {object} input.project  projectView
 * @param {object} input.run      from start()
 * @param {boolean} [input.regenerate]  true to rewrite the questions for a
 *   project that already has some. The profile is always rebuilt.
 * @returns {Promise<object>} the closed project_module_runs row
 */
async function complete({ access, project, run, regenerate = false }) {
  const projectId = access.project.id;

  try {
    const domain = project.primaryDomain?.host
      || (() => { try { return new URL(project.legacyUrl).host; } catch { return null; } })();

    if (!domain) {
      throw Object.assign(
        new Error('This project has no primary domain, so there is no site to read.'),
        { status: 422, code: 'no_domain' },
      );
    }

    // ── Step one: what is this business ──────────────────────────────────
    const profile = await businessProfile.build({ domain });
    const saved = await store.saveProfile({ access, profile });

    // ── Step two: the questions ──────────────────────────────────────────
    //
    // Existing prompts are passed in — including retired ones — so a
    // regeneration cannot propose a question the project already asks, or one
    // somebody deliberately deleted. v1's validator does that comparison; it
    // needs the full history to do it.
    const existingRows = await store.listPrompts(projectId, { includeRetired: true });
    const existing = existingRows.map((p) => p.text);
    const liveCount = existingRows.filter((p) => p.active).length;

    // Never write past the cap, and never overwrite questions somebody typed.
    // On a first run this is the full ten; on a regeneration it is whatever
    // room is left.
    const room = Math.max(0, MAX_PROMPTS - liveCount);
    const want = Math.min(AUTO_PROMPT_COUNT, room);

    let written = { added: [], skipped: [] };
    let generated = { prompts: [], rejected: [], brandGuard: null };

    if (want > 0 && (regenerate || liveCount === 0)) {
      generated = await promptGen.generate({ profile, count: want, existing });
      written = await store.addPrompts({
        access,
        prompts: generated.prompts,
        source: 'auto',
      });
    }

    const warnings = [];
    if (want === 0) {
      warnings.push(`This project already has its ${MAX_PROMPTS} prompts, so none were written.`);
    }
    if (written.added.length && written.added.length < want) {
      warnings.push(
        `Asked for ${want} questions and kept ${written.added.length}. `
        + 'The rest were rejected as too similar to existing ones or as naming the business.',
      );
    }
    // 'weak' means the business name is entirely generic industry words, so the
    // brand guard could only match the full phrase. A question naming the
    // client may have got through, and that inflates every number built on it.
    if (generated.brandGuard === 'weak') {
      warnings.push(
        `"${profile.businessName}" is made only of common industry words, so the check that `
        + 'stops a question naming the business is weaker than usual. Worth reading the ten before measuring.',
      );
    }
    if (!profile.services.length && !profile.products.length) {
      warnings.push(
        'The site did not state what the business sells, so the questions are written from '
        + 'its general description and may be broad.',
      );
    }

    return await moduleEvidence.completeRun({
      access,
      runId: run.id,
      // No score: this run produces a setup, not a measurement. completeRun
      // requires a basis for any score, and there is no defensible methodology
      // for scoring "we read the website", so it carries none.
      status: 'completed',
      payload: {
        profile: saved,
        promptsWritten: written.added.length,
        promptsSkipped: written.skipped,
        rejected: generated.rejected,
        brandGuard: generated.brandGuard,
        warnings,
      },
    });
  } catch (error) {
    await moduleEvidence.failRun({ access, runId: run.id, error }).catch(() => {});
    throw error;
  }
}

module.exports = { MODULE_KEY, start, complete };
