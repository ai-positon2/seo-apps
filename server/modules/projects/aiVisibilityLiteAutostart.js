// ── AI Visibility Lite starts itself when a project is created ──────────────
//
// The one-click promise: a person enters a domain, presses Save, and the module
// identifies the business, writes ten questions and measures them. Nothing else
// to press.
//
// ── Two stages, because they have different failure modes ──────────────────
//
// Setup (read the site, write the questions) runs DETACHED in the process that
// created the project. It takes well under a minute, it spends two cheap model
// calls, and if the process dies mid-way the project simply has no questions
// yet and the screen offers a button. Queueing it would add a worker round trip
// to the one stage a person is actually watching.
//
// The first measurement runs only once setup has succeeded — it is the one
// stage that spends from the project's budget, so it must not start against an
// empty question set, which is exactly what chaining it guarantees.
//
// ── Queue when something is listening; run here when nothing is ───────────
//
// The queue is the better home: a run survives a deploy, gets reaped rather
// than stranded at 'running', and records its own attempts. But it only works
// if a module worker is consuming it, and `MODULE_WORKER=off` is a supported
// configuration that this deployment uses.
//
// Enqueueing regardless is what this did first, and the result was a run parked
// at `queued` forever, the screen reading "Measuring…", and no error anywhere —
// because the queue had no consumer and nothing is wrong with an unclaimed row.
// A one-click flow that silently depends on a process the operator has turned
// off is not one-click.
//
// So the mode is read from the same switch server.js reads, and where no worker
// will claim it the run executes detached here, exactly as setup does. A run is
// minutes in this module — not the 10-35 of the scraped one — so losing one to
// a restart costs a retry rather than an afternoon.
//
// ── What it refuses to do ──────────────────────────────────────────────────
//
// Every refusal is reported to the caller with a reason, because "nothing
// happened" with no explanation is what makes people press the button twice.
// It does not start when there is no primary domain to read, when no provider
// key is configured, when the migration has not been applied, or when the
// project already has questions (a re-created project, or one somebody set up
// by hand). `AI_VISIBILITY_LITE_AUTOSTART=off` disables it entirely.

const moduleQueue = require('../../services/moduleQueue');
const setup = require('../aiVisibilityLite/setup');
const runner = require('../aiVisibilityLite/run');
const store = require('../aiVisibilityLite/store');
const surfaces = require('../aiVisibilityLite/surfaces');

const MODULE_KEY = 'ai_visibility_lite';

// Distinct from 'manual' and 'schedule' so the run history can say this
// measurement happened because a project was created, not because somebody
// pressed Run.
const TRIGGER = 'auto_setup';

// Read when used, not at require time — a module-level read freezes the value
// before dotenv has run, which is the bug the same pattern avoids in
// aiVisibility/surfaces/index.js.
const enabled = () => String(process.env.AI_VISIBILITY_LITE_AUTOSTART || '').toLowerCase() !== 'off';

/**
 * Will anything actually claim a queued run?
 *
 * The same switch server.js reads to decide whether to start the in-process
 * worker, and the same default ('in-process'). 'off' means no worker in this
 * process and none expected beside it, so a queued row would sit unclaimed.
 * 'external' means an operator is running worker-module.js, so the queue is
 * live even though this process is not the one serving it.
 */
const queueHasConsumer = () => String(process.env.MODULE_WORKER || 'in-process').toLowerCase() !== 'off';

/**
 * Start the module for a freshly created project.
 *
 * Never throws: a project is already created by the time this runs, and failing
 * the create response because a module could not start would report the
 * opposite of what happened.
 *
 * @param {object} input
 * @param {object} input.access   from projectAccess.requireProject
 * @param {object} input.project  projectView
 * @returns {Promise<{scheduled: boolean, reason: string|null, note: string|null}>}
 */
async function scheduleForProject({ access, project }) {
  if (!enabled()) {
    return { scheduled: false, reason: 'disabled', note: 'AI_VISIBILITY_LITE_AUTOSTART is off.' };
  }

  const domain = project?.primaryDomain?.host
    || (() => { try { return new URL(project?.legacyUrl).host; } catch { return null; } })();
  if (!domain) {
    return {
      scheduled: false,
      reason: 'no_domain',
      note: 'The project has no primary domain, so there is no site to read.',
    };
  }

  const ready = surfaces.readySurfaceIds();
  if (!ready.length) {
    return {
      scheduled: false,
      reason: 'not_configured',
      note: 'No model API keys are configured, so there is nothing to measure with.',
    };
  }

  // A project that already has questions was set up before. Rewriting them
  // would throw away what somebody wrote.
  let existing;
  try {
    existing = await store.listPrompts(access.project.id);
  } catch (e) {
    // Almost always the migration. Reported, not thrown — see the doc comment.
    return {
      scheduled: false,
      reason: e.code === 'migration_needed' ? 'migration_needed' : 'not_started',
      note: e.message,
    };
  }
  if (existing.length) {
    return {
      scheduled: false,
      reason: 'already_set_up',
      note: `This project already has ${existing.length} questions.`,
    };
  }

  let run;
  try {
    run = await setup.start({ access });
  } catch (e) {
    return { scheduled: false, reason: 'not_started', note: e.message };
  }

  // Detached. The create response has already gone by the time this resolves.
  setup.complete({ access, project, run })
    .then(async () => {
      if (queueHasConsumer()) {
        // The durable path. startFirstMeasurement's guards are repeated here
        // because enqueue does not have them: a queued row against an empty
        // question set would spend a run measuring nothing.
        const prompts = await store.listPrompts(access.project.id);
        if (!prompts.length) {
          console.warn('[aiVisibilityLiteAutostart] setup wrote no questions; not starting a run.');
          return;
        }
        const budget = await store.runBudget(access.project.id);
        if (budget.used > 0 || budget.remaining <= 0) return;

        await moduleQueue.enqueue({
          projectId: access.project.id,
          workspaceId: access.project.workspace_id || null,
          moduleKey: MODULE_KEY,
          trigger: TRIGGER,
          countryCode: access.project.country_code || null,
          createdBy: access.userId || null,
        });
        return;
      }

      // No worker will claim a queued row here, so run it in this process.
      // The same helper the setup route uses, so a project created here and one
      // set up by hand from the screen reach a first measurement identically.
      console.log('[aiVisibilityLiteAutostart] MODULE_WORKER=off — running the first measurement in-process.');
      await runner.startFirstMeasurement({ access, project, trigger: TRIGGER });
    })
    .catch((e) => {
      // setup.complete already closed its run row as failed, so the state is
      // visible on the screen. This only stops the rejection being unhandled.
      console.error('[aiVisibilityLiteAutostart]', e?.message || e);
    });

  return {
    scheduled: true,
    reason: null,
    runId: run.id,
    note: `Reading ${domain} to identify the business and write its questions. `
      + 'The first measurement starts by itself once they are ready.',
  };
}

module.exports = {
  MODULE_KEY, TRIGGER, scheduleForProject, enabled,
};
