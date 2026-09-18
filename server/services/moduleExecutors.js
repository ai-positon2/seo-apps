// ── What the worker actually runs ───────────────────────────────────────────
//
// One executor per module key. The worker claims a row and hands it here; this
// file resolves the project, runs the module, and closes the run.
//
// Project setup also queues homepage SEO/GEO and Agent Readiness audits.
// Their manual and full-audit runs keep their existing crawl-based paths.
// AI Visibility is on the queue because it is the one
// that cannot finish in a request; Competitor Research is on it because it
// starts itself when a project's domains are set up (modules/projects/
// competitorAutostart.js); Hub and Spoke because it starts itself when a crawl
// finishes (modules/projects/hubSpokeAutostart.js). Work that nobody is waiting
// on needs somewhere to run that survives the request that caused it.

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
  const db = require('./db');
  const projectsStore = require('../modules/projects/store');

  const project = await db.maybeOne(
    `select * from crawl_projects where id = $1`, [run.project_id]);
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

/**
 * Run Competitor Research for a claimed row.
 *
 * Same contract as above: the row is already `running`, so this executes into
 * it and closes it — `moduleRunners.executeOpenRun` is the shared path that
 * both the request-bound runner and this use, so a queued comparison is
 * normalised and failed exactly the way a manual one is.
 *
 * The access context is REBUILT here rather than assumed, and that is the part
 * worth reading. `runCompetitor` may auto-discover competitors and write them
 * to `project_domains`, which is the `manageCompetitors` capability (§7.2) —
 * and a contributor's picks must land as 'proposed' whether they typed them or
 * a queued run found them. So the role of whoever queued the run is resolved
 * again at execution time and the verdict comes from the same matrix the routes
 * use. A run with no actor (a schedule) gets no writing capability at all,
 * which reads as "auto-discovery found nothing" rather than as an automated
 * process quietly granting itself rights.
 */
async function runCompetitor(run, { isStillOurs } = {}) {
  const db = require('./db');
  const projectAccess = require('./projectAccess');
  const projectsStore = require('../modules/projects/store');
  const moduleRunners = require('../modules/projects/moduleRunners');

  const project = await db.maybeOne(
    `select * from crawl_projects where id = $1`, [run.project_id]);
  if (!project) throw new Error(`Project ${run.project_id} no longer exists.`);

  const domains = await projectsStore.listDomains(run.project_id).catch(() => []);

  const role = run.created_by && project.workspace_id
    ? await projectAccess.workspaceRole(project.workspace_id, run.created_by).catch(() => null)
    : null;

  const access = {
    project,
    workspaceId: project.workspace_id || null,
    userId: run.created_by || null,
    actorEmail: null,
    role,
    // No role resolved (the member left, or the run has no actor) means no
    // capability. `runCompetitor` reads this only to decide whether it may add
    // auto-discovered competitors; denying it there costs the comparison
    // nothing it was going to measure anyway.
    can: (name) => (role ? projectAccess.capabilityFor(role, name) : false),
  };

  // Raw row, not projectView: runCompetitor reads `country_code`, `settings`
  // and the raw project_domains rows. (AI Visibility above is the opposite —
  // hence the two are built differently rather than sharing one shape.)
  //
  // `isStillOurs` is handed down rather than checked here, because the closing
  // write happens inside executeOpenRun — checking it out here would be
  // checking after the write it is supposed to guard.
  return moduleRunners.executeOpenRun({
    access,
    moduleKey: 'competitor',
    run,
    target: { origin: run.target_url || project.url, host: null, fromLegacyColumn: false },
    project,
    domains,
    isStillOurs,
  });
}

/**
 * Run Hub and Spoke (Content Architect) for a claimed row.
 *
 * Same contract as the two above: the row is already `running`, so this executes
 * into it and closes it through the shared `executeOpenRun` path.
 *
 * Simpler than runCompetitor because the module only reads. It clusters pages a
 * crawl already stored and writes its result to Content Architect's own store and
 * the run's evidence row — it never touches `project_domains`, so there is no
 * capability to resolve and no reason to rebuild a role here. `can` answers false
 * for everything rather than being absent, so a runner that grew a capability
 * check later is denied rather than reading `undefined` as permission.
 */
async function runHubSpoke(run, { isStillOurs } = {}) {
  const db = require('./db');
  const projectsStore = require('../modules/projects/store');
  const moduleRunners = require('../modules/projects/moduleRunners');

  const project = await db.maybeOne(
    `select * from crawl_projects where id = $1`, [run.project_id]);
  if (!project) throw new Error(`Project ${run.project_id} no longer exists.`);

  const domains = await projectsStore.listDomains(run.project_id).catch(() => []);

  const access = {
    project,
    workspaceId: project.workspace_id || null,
    userId: run.created_by || null,
    actorEmail: null,
    role: null,
    can: () => false,
  };

  // Raw row, not projectView: runHubSpoke reads `project.url` as the fallback
  // origin and the raw project_domains rows, the same as runCompetitor.
  return moduleRunners.executeOpenRun({
    access,
    moduleKey: 'hub_spoke',
    run,
    target: { origin: run.target_url || project.url, host: null, fromLegacyColumn: false },
    project,
    domains,
    isStillOurs,
  });
}

async function runHomepageAudit(run, { isStillOurs } = {}) {
  const db = require('./db');
  const project = await db.maybeOne(
    `select * from crawl_projects where id = $1`, [run.project_id]);
  if (!project || project.lifecycle_status === 'deleted') {
    throw new Error(`Project ${run.project_id} is no longer active.`);
  }
  const access = {
    project, workspaceId: project.workspace_id || null,
    userId: run.created_by || null, can: () => false,
  };
  return require('../modules/projects/moduleRunners').executeOpenRun({
    access, moduleKey: run.module_key, run, project, isStillOurs,
  });
}

/**
 * Run AI Visibility Lite for a claimed row.
 *
 * Same contract as runAiVisibility above, in every respect: the row is already
 * `running` from the worker's claim so this must not open a second one, and
 * `execute` returns a result rather than closing the row, so this closes it.
 */
async function runAiVisibilityLite(run, { isStillOurs } = {}) {
  const { execute } = require('../modules/aiVisibilityLite/run');
  const db = require('./db');
  const projectsStore = require('../modules/projects/store');

  const project = await db.maybeOne(
    `select * from crawl_projects where id = $1`, [run.project_id]);
  if (!project) throw new Error(`Project ${run.project_id} no longer exists.`);

  const domains = await projectsStore.listDomains(run.project_id).catch(() => []);
  // A projectView, not the raw row — run.js reads camelCase primaryDomain and
  // competitors off it. Handing over the raw row is the bug that made
  // brand.domain resolve to nothing on every production AI Visibility run.
  const view = projectsStore.projectView(project, domains);

  // A queued run has no actor. `userId: null` says so rather than attributing
  // an automated measurement to whoever set the project up.
  const access = { project, userId: null };

  const result = await execute({ access, project: view, run });

  if (isStillOurs && !isStillOurs()) {
    // Reaped mid-flight. The captures are already stored, so the evidence is
    // not lost — only the closing write is abandoned, and whoever owns the row
    // now will close it. Writing anyway would overwrite a reported result.
    console.warn(`[moduleExecutors] run ${run.id} was reclaimed while executing; not closing it.`);
    return result;
  }

  await moduleEvidence.completeRun({ access, runId: run.id, ...result });
  return result;
}

module.exports = {
  ai_visibility: runAiVisibility,
  ai_visibility_lite: runAiVisibilityLite,
  competitor: runCompetitor,
  hub_spoke: runHubSpoke,
  seo_geo: runHomepageAudit,
  agent_readiness: runHomepageAudit,
};
