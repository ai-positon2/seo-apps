// ── What the worker actually runs ───────────────────────────────────────────
//
// One executor per module key. The worker claims a row and hands it here; this
// file resolves the project, runs the module, and closes the run.
//
// Only `ai_visibility` is registered. Every other module still executes
// synchronously through `moduleRunners`, unchanged — the queue is opt-in per
// module, and putting a 3-second module on it would add polling latency for no
// benefit. AI Visibility is on it because it is the one that cannot finish in a
// request.

const moduleEvidence = require('../modules/projects/moduleEvidence');

/**
 * Run AI Visibility for a claimed row.
 *
 * The run row already exists and is already `running` — the worker's claim did
 * that. So this must NOT open a second one; it executes and then closes the row
 * the worker is holding.
 *
 * `isStillOurs` goes false when a reaper decided this worker was dead. Checked
 * before the close so two workers cannot both write a terminal state to one
 * run — the later write would overwrite a result that was already reported.
 */
async function runAiVisibility(run, { isStillOurs } = {}) {
  const { runAiVisibility: execute } = require('../modules/aiVisibility/run');
  const { getSupabase } = require('./supabase');
  const projectsStore = require('../modules/projects/store');

  const { data: project, error } = await getSupabase()
    .from('crawl_projects').select('*').eq('id', run.project_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!project) throw new Error(`Project ${run.project_id} no longer exists.`);

  const domains = await projectsStore.listDomains(run.project_id).catch(() => []);

  // run.js is written against a projectView, not the raw row — camelCase
  // primaryDomain, competitors, countryCode. Handing it the raw row is the bug
  // that made brand.domain and competitors resolve to nothing on every
  // production run before it was found; moduleRunners builds the view for the
  // same reason and this must too.
  const view = projectsStore.projectView(project, domains);

  // A scheduled run has no actor. `userId: null` says so rather than
  // attributing an automated measurement to whoever configured the schedule.
  const access = { project, userId: null };

  const result = await execute({ access, project: view, run });

  if (isStillOurs && !isStillOurs()) {
    // Reaped mid-flight. The captures are already stored, so the evidence is
    // not lost — only the closing write is abandoned, and whoever owns the row
    // now will close it. Writing anyway would overwrite a result that has
    // already been reported.
    console.warn(`[moduleExecutors] run ${run.id} was reclaimed while executing; not closing it.`);
    return result;
  }

  await moduleEvidence.completeRun({ access, runId: run.id, ...result });
  return result;
}

module.exports = {
  ai_visibility: runAiVisibility,
};
