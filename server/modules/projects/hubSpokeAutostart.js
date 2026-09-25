// ── Hub and Spoke starts itself once a crawl has something to analyse ───────
//
// Content Architect's project-side module (`hub_spoke`) does not crawl. It reads
// the pages CrawlScope already stored and clusters them (moduleRunners.runHubSpoke
// -> crawlToArchitect -> fullAnalysis). Its one prerequisite is a finished crawl.
//
// "Run Full Audit" did not respect that. hub_spoke is a site-level module, so the
// audit sequence ran it FIRST — deliberately, because site-level modules are quick
// and must not compete with the crawl for the client's server — which meant it
// asked for the latest completed crawl while the crawl meant to feed it had only
// just started. It found none, recorded an honest `insufficient_data` row saying
// "run a site crawl first", and never looked again. The crawl then finished and
// nothing re-ran the analysis, so the card sat there telling the reader to do the
// thing they had just done.
//
// So the trigger belongs at the other end: the crawl finishing is the event that
// creates the input, and that is where this is called from (crawlScope/run/
// manager.js, beside the page-inventory sync, for the same reason — it is the
// moment the run becomes readable).
//
// Cheap, unlike competitorAutostart: it fetches nothing, and its model calls
// (page selection, cluster naming, relevance) cost cents per run, with page-
// selection verdicts cached between runs so a re-crawl of an unchanged site asks
// the model almost nothing. Re-analysing after every crawl is the correct
// default rather than a budget decision, so the only gate is
// HUB_SPOKE_AUTOSTART=off.
//
// It goes on the module queue (0019) rather than running inside the crawl worker.
// Clustering a large site is CPU- and LLM-bound and the crawl worker's job is
// crawling; a run on the queue survives a deploy, is reaped if its worker dies,
// and is claimed by whichever replica is free. `moduleExecutors.hub_spoke` is what
// claims it — without that registration a queued run would wait for ever.

const db = require('../../services/db');
const moduleQueue = require('../../services/moduleQueue');

const MODULE_KEY = 'hub_spoke';

// Distinct from 'manual', 'schedule' and 'audit_all' so the run history can say
// the analysis happened because a crawl produced pages for it.
const TRIGGER = 'after_crawl';

// A short settle before the run becomes claimable. The crawl's result rows are
// written before its status flips, so the data is already there; this is only so
// the page-inventory sync that runs immediately after completion is not competing
// with the claim.
const DEFAULT_DELAY_MS = 10_000;

const OFF_VALUES = ['0', 'off', 'false', 'no', 'disabled'];

/** On unless a deployment turns it off. */
function isEnabled() {
  const raw = String(process.env.HUB_SPOKE_AUTOSTART ?? '').trim().toLowerCase();
  if (!raw) return true;
  return !OFF_VALUES.includes(raw);
}

// `Number('')` is 0 and `Number.isFinite(0)` is true, so the obvious coercion turns
// an unset variable into a zero delay. Same longhand as competitorAutostart, and
// for the same reason.
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
  const configured = positiveMs(process.env.HUB_SPOKE_AUTOSTART_DELAY_MS);
  return configured === null ? DEFAULT_DELAY_MS : configured;
}

/**
 * The decision, as a pure function so it is testable without a database.
 *
 * A run already QUEUED needs nothing: it has not started, and when it does it
 * reads the newest completed crawl — which is this one. Queueing a second would
 * analyse the same pages twice.
 *
 * A run already RUNNING is different. It was assembled against the previous crawl
 * and will finish with those pages, so a fresh one goes behind it.
 *
 * @returns {{ start: boolean, reason: string }}
 */
function decide({ enabled = true, hasProject = false, pending = {} } = {}) {
  if (!enabled) return { start: false, reason: 'autostart_disabled' };
  if (!hasProject) return { start: false, reason: 'no_project' };
  if (pending.queued) return { start: false, reason: 'already_queued' };
  return { start: true, reason: pending.running ? 'queued_behind_running' : 'queued' };
}

/** True when the error is "0019 has not been applied yet". */
function isMissingQueueSchema(error) {
  // 42703 undefined_column, 42P01 undefined_table.
  if (error?.code === '42703' || error?.code === '42P01') return true;
  return /column .* does not exist|relation .* does not exist/i.test(error?.message || '');
}

/** The hub_spoke runs this project already has in flight. */
async function pendingRuns(projectId) {
  let rows;
  try {
    rows = await db.rows(
      `select id, status, created_at from project_module_runs
        where project_id = $1 and module_key = $2 and status in ('queued', 'running')
        order by created_at desc`,
      [projectId, MODULE_KEY]
    );
  } catch (error) {
    if (isMissingQueueSchema(error)) {
      throw Object.assign(new Error(error.message), { code: 'queue_unavailable' });
    }
    throw new Error(`[hubSpokeAutostart.pendingRuns] ${error.message}`);
  }
  return {
    queued: rows.find((r) => r.status === 'queued') || null,
    running: rows.find((r) => r.status === 'running') || null,
  };
}

/**
 * Queue Hub and Spoke for the project whose crawl just finished.
 *
 * Never throws into its caller. The crawl succeeded whether or not the analysis
 * could be queued, and a completion path that rejects because a follow-on could
 * not be scheduled would report the crawl as failed — the opposite of what
 * happened. Failures come back as a reason and are logged.
 *
 * @param {object} input
 * @param {object} input.run       finished crawl_runs row (project_id, workspace_id, owner, url)
 * @param {number} [input.delayMs] override the settle window
 * @returns {Promise<{scheduled: boolean, reason: string, runId: string|null}>}
 */
async function scheduleHubSpoke({ run, delayMs: delayOverride } = {}) {
  const answer = (extra) => ({ scheduled: false, runId: null, ...extra });

  if (!run?.project_id) return answer({ reason: 'no_project' });
  if (!db.isDatabaseConfigured()) return answer({ reason: 'not_configured' });

  let pending = { queued: null, running: null };
  try {
    pending = await pendingRuns(run.project_id);
  } catch (e) {
    if (e.code === 'queue_unavailable') {
      console.warn(
        '[hubSpokeAutostart] the module run queue is unavailable, so Hub and Spoke was not '
        + 'queued — apply supabase/migrations/0019_module_run_queue.sql. '
        + 'Run it from the Hub and Spoke card meanwhile.',
      );
      return answer({ reason: 'queue_unavailable' });
    }
    console.error('[hubSpokeAutostart] could not read in-flight runs:', e.message);
    return answer({ reason: 'pending_lookup_failed' });
  }

  const verdict = decide({ enabled: isEnabled(), hasProject: true, pending });
  if (!verdict.start) return answer({ reason: verdict.reason });

  const startAt = new Date(Date.now() + delayMs(delayOverride));
  try {
    const queued = await moduleQueue.enqueue({
      projectId: run.project_id,
      workspaceId: run.workspace_id || null,
      moduleKey: MODULE_KEY,
      trigger: TRIGGER,
      scheduledFor: startAt.toISOString(),
      createdBy: run.owner || null,
      targetUrl: run.url || null,
    });
    // enqueue answers null rather than throwing when 0019 is missing, and a null
    // here would read as "queued" to the caller.
    if (!queued) return answer({ reason: 'queue_unavailable' });
    return answer({ scheduled: true, reason: verdict.reason, runId: queued.id });
  } catch (e) {
    if (isMissingQueueSchema(e)) return answer({ reason: 'queue_unavailable' });
    console.error('[hubSpokeAutostart] could not queue the analysis:', e.message);
    return answer({ reason: 'queue_failed' });
  }
}

module.exports = {
  MODULE_KEY,
  TRIGGER,
  DEFAULT_DELAY_MS,
  isEnabled,
  delayMs,
  decide,
  scheduleHubSpoke,
};
