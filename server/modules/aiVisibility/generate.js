// ── The prompt-generation job ────────────────────────────────────────────
//
// The detached background job behind POST /prompts/generate. Manages its own
// project_module_runs row directly via moduleEvidence.startRun/completeRun/
// failRun — deliberately NOT through moduleRunners.runModule, which gates on
// RUNNABLE and only requires the 'startRun' capability (contributors hold
// it). Generation calls an LLM, so the only door to it is this router,
// behind 'editProjectSettings'.
//
// ONE path: a person picks pages, and each page gets one question it should
// win. The slot/intent generator that used to sit beside this — a topic×
// intent matrix, per-slot LLM calls, template fallbacks and paid DataForSEO
// demand seeding — was removed in full. It produced prompts from a topic
// LABEL, which is how a page titled "Find A Dentist" became the prompt "best
// find a dentist", and its matrix was the single most confusing thing on the
// screen. Reading the page and writing from what is on it is both simpler to
// explain and better output.
//
// Dedupe still spans every status (draft, approved, rejected, retired), so a
// question a person already rejected or removed is never silently rewritten.

const moduleEvidence = require('../projects/moduleEvidence');
const adminLimits = require('../../services/adminLimits');
const pagePrompts = require('./pagePrompts');
const store = require('./store');
const { brandFrom, competitorsFrom } = require('./run');

const MODULE_KEY = 'ai_visibility_prompts';

/**
 * Opens the run row. Split from the work itself so a route handler can hand
 * the caller a real run id in its 202 response BEFORE the (possibly
 * multi-minute) generation work starts — the row has to exist the instant
 * the client starts polling it.
 */
async function startGeneration({ access }) {
  return moduleEvidence.startRun({ access, moduleKey: MODULE_KEY, trigger: 'manual' });
}

/**
 * Does the work against an ALREADY-OPEN run (see startGeneration) and closes
 * it. Never throws past failRun — a caller firing this detached only needs
 * to know the promise settled, not to handle its rejection.
 *
 * @param {object} input
 * @param {object} input.access    from projectAccess.requireProject
 * @param {object} input.project   projectView (see routes.js's projectViewFor)
 * @param {object} input.run       from startGeneration()
 * @param {string[]} input.urls    the pages a person chose; one prompt each
 * @returns {Promise<object>} the closed project_module_runs row
 */
async function runGeneration({ access, project, run, urls = null }) {
  try {
    const chosen = (Array.isArray(urls) ? urls : []).filter(Boolean);
    if (!chosen.length) {
      return await moduleEvidence.completeRun({
        access,
        runId: run.id,
        status: 'insufficient_data',
        findings: [],
        payload: { counts: { added: 0, skipped: 0 } },
        note: 'No pages were chosen, so there was nothing to write questions about.',
      });
    }

    const ceiling = (await adminLimits
      .limit('maxPromptsPerVisibilityRun', { workspaceId: project.workspaceId })
      .catch(() => null)) || 20;

    // Writing more questions than can ever be approved just fills the review
    // list with work nobody can act on — a limit of 10 against 33 waiting is
    // 23 rejections before anything useful happens.
    const counts = await store.countPromptsByStatus(project.id).catch(() => null);
    const headroom = Math.max(0, ceiling - (counts?.approved || 0));
    if (!headroom) {
      return await moduleEvidence.completeRun({
        access,
        runId: run.id,
        status: 'insufficient_data',
        findings: [],
        payload: { budget: { ceiling, headroom: 0 }, counts: { added: 0, skipped: 0 } },
        note: `This client is already at its limit of ${ceiling} questions. `
          + 'Remove one to make room.',
      });
    }

    // The page selection sets the count: one question per page chosen. Asking
    // for "10 questions across these 6 pages" would silently double up on
    // some of them, and the person picking pages meant the pages.
    const within = chosen.slice(0, headroom);

    const brand = brandFrom(project);
    const competitors = competitorsFrom(project);

    // Every status, not just the live set — a rejected question must not be
    // silently rewritten, and a removed one should not resurface as "new".
    const existingRows = await store.listPrompts(project.id, {
      status: ['draft', 'approved', 'rejected', 'retired'],
    });
    const existing = existingRows.map((p) => p.text);

    const page = await pagePrompts.generateForUrls({
      urls: within, brand, competitors, existing,
    });

    const { added, skipped } = await store.saveGeneratedDraft({
      access, runId: run.id, prompts: page.prompts,
    });

    return await moduleEvidence.completeRun({
      access,
      runId: run.id,
      status: added.length ? 'completed' : 'insufficient_data',
      findings: [],
      payload: {
        model: page.model,
        basis: `${added.length} question(s) written from ${page.considered} page(s) `
          + `by ${page.model}, one call per page`,
        urls: within,
        budget: { ceiling, headroom, chosen: chosen.length, used: within.length },
        counts: {
          added: added.length,
          skipped: skipped.length,
          requested: page.requested,
          considered: page.considered,
        },
        // No paid provider is reachable from this path any more; stated
        // rather than omitted so a reader of an old run can tell the
        // difference between "none" and "not recorded".
        spend: { llmCalls: page.calls, dataForSeo: null },
        // Every URL that produced nothing, and why. A run that quietly
        // returned 12 questions for 20 pages would leave eight unexplained.
        skippedPages: page.skipped,
        truncated: page.truncated,
      },
      band: `${added.length} of ${within.length} question(s) added`,
      note: [
        chosen.length > within.length
          ? `Only ${within.length} of the ${chosen.length} pages fitted under the `
            + `${ceiling}-question limit.`
          : null,
        page.truncated ? `Only the first ${pagePrompts.MAX_PAGES} pages were used.` : null,
      ].filter(Boolean).join(' ') || null,
    });
  } catch (e) {
    await moduleEvidence.failRun({ access, runId: run.id, error: e });
    throw e;
  }
}

module.exports = { MODULE_KEY, startGeneration, runGeneration };
