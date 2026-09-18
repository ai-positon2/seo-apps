// ── AI Visibility sets itself up once a project has a crawl to ground on ────
//
// AI Visibility normally needs four manual steps before it measures anything:
// approve a brand identity, pick pages, generate one question per page, approve
// the questions. Each step is a deliberate gate — approving a brand or a
// question "releases [it] into measurement" (store.js's own words) and both
// writes REQUIRE a real `access.userId`, not just a capability, because an
// approval must be attributable to a person, not silently self-granted.
//
// This does not remove that gate. It walks through it on the project creator's
// behalf, once, the moment their first crawl gives the pipeline something to
// read — the same reasoning hubSpokeAutostart uses for re-clustering, and
// competitorAutostart uses for the comparison. `run.owner` (the crawl's real
// actor) is who every approval here is attributed to; a crawl with no owner
// (nothing to attribute to) is left alone rather than inventing a system actor.
//
// Fires ONCE per project, not after every crawl. Re-running this after every
// crawl would keep re-proposing brands and prompts over state a person may
// have since edited by hand — the opposite of "otherwise it should start and
// run automatically, but within the agent itself I could edit". Eligibility is
// "this project has never had a brand, a prompt, or an ai_visibility(_prompts)
// run of ANY kind" — once any of those exist, by this path or a manual one,
// autostart steps aside for good and the Brands/Prompt-set tabs take over.
//
// Only the CHEAP, free half runs here: deriving and approving brands is a pure
// function plus a few DB writes, no LLM, no provider call. Prompt generation
// (an LLM call per page) and measurement (the real capture run) are each
// queued instead — moduleExecutors.ai_visibility_prompts picks up the first
// and chains into the second on success. Keeping this function itself cheap
// matters because it runs inside the crawl worker's own completion path,
// exactly like hubSpokeAutostart.scheduleHubSpoke beside it.

const db = require('../../services/db');
const moduleQueue = require('../../services/moduleQueue');

const PROMPTS_MODULE_KEY = 'ai_visibility_prompts';
const MEASURE_MODULE_KEY = 'ai_visibility';

// Distinct from 'manual' and 'schedule' so the run history can say a question
// set and a measurement started because the project was set up, not because
// someone clicked Generate or Measure.
const TRIGGER = 'auto_setup';

// A short settle before the queued generation becomes claimable — the crawl's
// page rows are already written by the time this runs (same ordering
// hubSpokeAutostart relies on), so this is only breathing room, not a wait for
// data to exist.
const DEFAULT_DELAY_MS = 10_000;

const OFF_VALUES = ['0', 'off', 'false', 'no', 'disabled'];

/** On unless a deployment turns it off. */
function isEnabled() {
  const raw = String(process.env.AI_VISIBILITY_AUTOSTART ?? '').trim().toLowerCase();
  if (!raw) return true;
  return !OFF_VALUES.includes(raw);
}

// Same longhand as the other two autostarts: `Number('')` is 0, and
// `Number.isFinite(0)` is true, so the obvious coercion turns an unset
// variable into a zero delay rather than the default.
function positiveMs(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const ms = Number(text);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function delayMs(override) {
  const asked = positiveMs(override);
  if (asked !== null) return asked;
  const configured = positiveMs(process.env.AI_VISIBILITY_AUTOSTART_DELAY_MS);
  return configured === null ? DEFAULT_DELAY_MS : configured;
}

/**
 * The decision, as a pure function so it is testable without a database.
 *
 * @returns {{ start: boolean, reason: string }}
 */
function decide({ enabled = true, hasProject = false, hasOwner = false, alreadySetUp = false } = {}) {
  if (!enabled) return { start: false, reason: 'autostart_disabled' };
  if (!hasProject) return { start: false, reason: 'no_project' };
  if (!hasOwner) return { start: false, reason: 'no_actor' };
  if (alreadySetUp) return { start: false, reason: 'already_set_up' };
  return { start: true, reason: 'queued' };
}

/** True when the error is "0019 has not been applied yet" (queue) or the AI
 *  Visibility tables (0016-0018) are missing. Either way, nothing here can run. */
function isMissingSchema(error) {
  if (error?.code === '42703' || error?.code === '42P01') return true;
  return /column .* does not exist|relation .* does not exist/i.test(error?.message || '');
}

/**
 * Whether this project has ANY brand, prompt, or ai_visibility(_prompts) run —
 * by this path or a person's. One query per table, all independent, so a
 * single row anywhere is enough to call this project already set up.
 */
async function alreadySetUp(projectId) {
  const [brand, prompt, run] = await Promise.all([
    db.maybeOne(`select 1 from project_brands where project_id = $1 limit 1`, [projectId]),
    db.maybeOne(`select 1 from ai_visibility_prompts where project_id = $1 limit 1`, [projectId]),
    db.maybeOne(
      `select 1 from project_module_runs
        where project_id = $1 and module_key in ($2, $3) limit 1`,
      [projectId, PROMPTS_MODULE_KEY, MEASURE_MODULE_KEY],
    ),
  ]);
  return Boolean(brand || prompt || run);
}

/**
 * Derive the measured set and approve it, attributed to `access.userId`.
 *
 * The client brand is approved regardless of strength — without one, nothing
 * downstream has anything to measure, and `brandFrom(project)` derives it
 * from the project's own name, which is a real business name in practice, not
 * a generic word. A competitor brand is approved only when `deriveMeasuredSet`
 * scored it 'strong' (a distinctive token survives): a 'weak' one is a generic
 * industry term that would match the whole category, exactly the case
 * store.js's own route comment warns a human to look at before releasing —
 * automating past that warning is not this feature's job. Weak proposals are
 * left 'proposed' — visible and approvable by hand in the Brands tab, per
 * "within the agent itself I could edit".
 *
 * Never throws: one brand failing to approve must not stop the rest, and this
 * whole step failing must not stop generation from being queued — a missing
 * brand approval degrades to "reports read empty until someone approves one
 * in the Brands tab", not to nothing happening at all.
 */
async function deriveAndApproveBrands({ access, project }) {
  const { deriveMeasuredSet } = require('../aiVisibility/captureEngines/brandAliases');
  const store = require('../aiVisibility/store');

  let proposals;
  try {
    proposals = deriveMeasuredSet({ project });
  } catch (e) {
    console.error('[aiVisibilityAutostart] could not derive brands:', e.message);
    return { approved: 0 };
  }
  if (!proposals?.length) return { approved: 0 };

  try {
    await store.upsertBrands({ access, brands: proposals });
  } catch (e) {
    console.error('[aiVisibilityAutostart] could not propose brands:', e.message);
    return { approved: 0 };
  }

  const strongByName = new Map(
    proposals.map((p) => [String(p.name).trim().toLowerCase(), p.strength === 'strong']),
  );

  let proposed;
  try {
    proposed = await store.listBrands(project.id, { status: 'proposed' });
  } catch (e) {
    console.error('[aiVisibilityAutostart] could not read proposed brands:', e.message);
    return { approved: 0 };
  }

  let approved = 0;
  for (const brand of proposed) {
    const strong = strongByName.get(String(brand.name).trim().toLowerCase());
    if (!brand.isClient && !strong) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await store.transitionBrand({ access, brandId: brand.id, to: 'approved' });
      approved += 1;
    } catch (e) {
      console.error(`[aiVisibilityAutostart] could not approve brand "${brand.name}":`, e.message);
    }
  }
  return { approved };
}

/**
 * Set up AI Visibility for the project whose first crawl just finished:
 * approve a brand identity, then queue prompt generation (which chains into
 * approval and measurement itself — see moduleExecutors.js).
 *
 * Never throws into its caller, for the same reason hubSpokeAutostart's does
 * not: the crawl succeeded whether or not this could be queued.
 *
 * @param {object} input
 * @param {object} input.run  finished crawl_runs row (project_id, workspace_id, owner, url)
 * @param {number} [input.delayMs] override the settle window
 * @returns {Promise<{scheduled: boolean, reason: string, runId: string|null, brandsApproved: number}>}
 */
async function scheduleAiVisibilitySetup({ run, delayMs: delayOverride } = {}) {
  const answer = (extra) => ({ scheduled: false, runId: null, brandsApproved: 0, ...extra });

  if (!run?.project_id) return answer({ reason: 'no_project' });
  if (!db.isDatabaseConfigured()) return answer({ reason: 'not_configured' });

  let setUp = false;
  try {
    setUp = await alreadySetUp(run.project_id);
  } catch (e) {
    if (isMissingSchema(e)) return answer({ reason: 'schema_unavailable' });
    console.error('[aiVisibilityAutostart] could not check existing setup:', e.message);
    return answer({ reason: 'setup_check_failed' });
  }

  const verdict = decide({
    enabled: isEnabled(),
    hasProject: true,
    hasOwner: Boolean(run.owner),
    alreadySetUp: setUp,
  });
  if (!verdict.start) return answer({ reason: verdict.reason });

  const projectsStore = require('./store');
  let rawProject;
  let view;
  try {
    rawProject = await db.maybeOne(`select * from crawl_projects where id = $1`, [run.project_id]);
    if (!rawProject) return answer({ reason: 'no_project' });
    const domains = await projectsStore.listDomains(run.project_id).catch(() => []);
    view = projectsStore.projectView(rawProject, domains);
  } catch (e) {
    console.error('[aiVisibilityAutostart] could not load project:', e.message);
    return answer({ reason: 'project_load_failed' });
  }

  const access = { project: rawProject, userId: run.owner };
  const { approved: brandsApproved } = await deriveAndApproveBrands({ access, project: view });

  const startAt = new Date(Date.now() + delayMs(delayOverride));
  try {
    const queued = await moduleQueue.enqueue({
      projectId: run.project_id,
      workspaceId: run.workspace_id || null,
      moduleKey: PROMPTS_MODULE_KEY,
      trigger: TRIGGER,
      scheduledFor: startAt.toISOString(),
      createdBy: run.owner,
      targetUrl: run.url || null,
    });
    if (!queued) return answer({ reason: 'queue_unavailable', brandsApproved });
    return answer({ scheduled: true, reason: verdict.reason, runId: queued.id, brandsApproved });
  } catch (e) {
    if (isMissingSchema(e)) return answer({ reason: 'queue_unavailable', brandsApproved });
    console.error('[aiVisibilityAutostart] could not queue prompt generation:', e.message);
    return answer({ reason: 'queue_failed', brandsApproved });
  }
}

module.exports = {
  PROMPTS_MODULE_KEY,
  MEASURE_MODULE_KEY,
  TRIGGER,
  DEFAULT_DELAY_MS,
  isEnabled,
  delayMs,
  decide,
  alreadySetUp,
  deriveAndApproveBrands,
  scheduleAiVisibilitySetup,
};
