// ── Competitor Research starts itself once the domains exist ────────────────
//
// The comparison needs exactly two things: a primary domain and something to
// compare it against. The moment a project has both — at setup, or when a
// competitor is added or auto-discovered later — there is nothing left to wait
// for, so this queues the run instead of leaving a card that says "not run yet"
// next to a button whose only job is to say "yes, now".
//
// THIS SPENDS A METERED BUDGET. Roughly 1,955 SEMrush units per domain
// (moduleRunners.METERED), charged for the client's own domain as well as each
// competitor, so a project created with four competitors is close to 10,000
// units the moment it is created. Three things keep that honest rather than
// surprising:
//
//   1. It is queued, not run per keystroke. Adding three competitors one at a
//      time inside the coalescing window produces ONE run that compares all
//      three, not three runs that each cost the full amount. The window is a
//      `scheduled_for` in the future, and a second add pushes that time out
//      again rather than enqueueing beside it.
//   2. It refuses to open a run it already knows cannot measure anything — no
//      primary domain, no competitors and no auto-discovery, no SEMrush key.
//      Each refusal carries a reason the route reports, because "nothing
//      happened" with no explanation is what makes people press the button
//      twice.
//   3. `COMPETITOR_RESEARCH_AUTOSTART=off` disables it entirely, for a
//      deployment that would rather spend the budget by hand.
//
// It goes on the module queue (0019) rather than running detached in the
// request, for the reasons the queue exists: a run survives a deploy, a dead
// worker is reaped instead of leaving a row stuck at 'running' forever, and
// `scheduled_for` is the coalescing window above. One worker claims one job at
// a time, so a comparison queued while an AI Visibility capture is in flight
// waits for it — that is the existing worker contract, and the answer to it is
// another replica, not a second mechanism here.

const { getSupabase, isSupabaseConfigured } = require('../../services/supabase');
const moduleQueue = require('../../services/moduleQueue');

const MODULE_KEY = 'competitor';

// The trigger recorded on the run. Distinct from 'manual' and 'schedule' so the
// run history can say a comparison started because the domains were set up
// rather than because somebody pressed Run.
const TRIGGER = 'auto_setup';

// How long to wait before the queued run becomes claimable. Long enough that
// typing in a second and third competitor lands in the same run, short enough
// that "as soon as the domains are added" is still true.
const DEFAULT_DELAY_MS = 60_000;

// Project setup submits every competitor in one request, so there is nothing to
// coalesce and no reason to make the reader wait a minute for the first run.
const SETUP_DELAY_MS = 5_000;

// How far a queued run may be pushed out in total, measured from when it was
// enqueued. Coalescing works by deferring, and deferring without a ceiling is a
// run that never starts: somebody adding a competitor every fifty seconds would
// hold the comparison at "starts in a minute" indefinitely, which looks exactly
// like a queue that is broken. Past this the run goes as scheduled and the next
// domain gets its own run queued behind it.
const MAX_DEFER_MS = 5 * 60_000;

const OFF_VALUES = ['0', 'off', 'false', 'no', 'disabled'];

/** Autostart is on unless a deployment turns it off. */
function isEnabled() {
  const raw = String(process.env.COMPETITOR_RESEARCH_AUTOSTART ?? '').trim().toLowerCase();
  if (!raw) return true;
  return !OFF_VALUES.includes(raw);
}

// `Number('')` is 0 and `Number.isFinite(0)` is true, so an unset variable read
// through the obvious coercion is a window of ZERO — which does not just make
// the run start sooner, it defeats coalescing entirely and bills once per
// competitor added. Third time this exact coercion has bitten in this codebase
// (see moduleEvidence.sweepStaleRuns), hence the longhand.
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
  const configured = positiveMs(process.env.COMPETITOR_AUTOSTART_DELAY_MS);
  return configured === null ? DEFAULT_DELAY_MS : configured;
}

// Why a comparison was not queued, in the words the API hands back. Every one of
// these is a state the caller can do something about, which is why none of them
// is silence.
const NOTES = {
  autostart_disabled:
    'Competitor Research does not start automatically on this deployment '
    + '(COMPETITOR_RESEARCH_AUTOSTART is off). Run it from the Competitor Research card.',
  not_authorized:
    'Your role cannot start runs, so the comparison was not started automatically.',
  no_primary_domain:
    'This project has no primary domain, so there is nothing to compare. '
    + 'Set one and the comparison starts by itself.',
  no_competitors_tracked:
    'No competitor is tracked yet, so nothing was started. Add one — or turn on '
    + '"Find competitors for me" — and the comparison starts by itself.',
  competitors_pending_approval:
    'The competitors on this project are proposed, not tracked. An approver has to accept '
    + 'them before a comparison can run.',
  no_semrush_key:
    'SEMRUSH_API_KEY is not configured, so no comparison was started. Simulated numbers are '
    + 'never stored as project evidence — they would appear in the dashboard and the exported '
    + 'report as if they had been measured.',
  not_configured:
    'Projects need Supabase configured, so nothing was queued.',
};

/**
 * The whole decision, as a pure function, so it can be tested without a
 * database and read without following four requires.
 *
 * `pending` is what the project already has in flight: the queued run to
 * coalesce into, and/or the running one. A queued run is ALWAYS coalesced into
 * rather than duplicated — that is what makes three quick adds cost one run.
 * A run that is already executing is a different matter: it was assembled
 * before this domain existed and will not include it, so a fresh one is queued
 * behind it rather than pretending the new competitor is covered.
 *
 * @returns {{ start: boolean, reason: string, coalesceRunId: string|null, competitorCount: number }}
 */
function decide({
  enabled = true,
  canStartRun = true,
  hasPrimaryDomain = false,
  activeCompetitorCount = 0,
  proposedCompetitorCount = 0,
  autoFindCompetitors = false,
  hasSemrushKey = false,
  pending = {},
} = {}) {
  const base = { start: false, coalesceRunId: null, competitorCount: activeCompetitorCount };

  if (!enabled) return { ...base, reason: 'autostart_disabled' };
  if (!canStartRun) return { ...base, reason: 'not_authorized' };
  if (!hasPrimaryDomain) return { ...base, reason: 'no_primary_domain' };

  if (!activeCompetitorCount && !autoFindCompetitors) {
    // A contributor's additions land as 'proposed' (§7.2) and are not something
    // to compare against yet. Saying so is the difference between "waiting for
    // an approver" and "nothing happened".
    return {
      ...base,
      reason: proposedCompetitorCount ? 'competitors_pending_approval' : 'no_competitors_tracked',
    };
  }

  // Deliberately checked before opening a run rather than inside it: the runner
  // would record an honest 'insufficient_data' row, but one per competitor
  // added, which turns a missing key into a wall of failed-looking cards.
  if (!hasSemrushKey) return { ...base, reason: 'no_semrush_key' };

  if (pending.queued) {
    return { ...base, start: true, reason: 'coalesced', coalesceRunId: pending.queued.id };
  }

  return {
    ...base,
    start: true,
    reason: pending.running ? 'queued_behind_running' : 'queued',
  };
}

/** True when the error is "0019 has not been applied yet". */
function isMissingQueueSchema(error) {
  return /column .* does not exist|schema cache|Could not find/i.test(error?.message || '');
}

/** The competitor runs this project already has in flight, if any. */
async function pendingRuns(projectId) {
  const { data, error } = await getSupabase()
    .from('project_module_runs')
    .select('id, status, scheduled_for, created_at')
    .eq('project_id', projectId)
    .eq('module_key', MODULE_KEY)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false });

  // Queue columns missing means 0019 has not been applied. Nothing is in flight
  // that this can see, and the caller falls back to running detached.
  if (error) {
    if (isMissingQueueSchema(error)) {
      throw Object.assign(new Error(error.message), { code: 'queue_unavailable' });
    }
    throw new Error(`[competitorAutostart.pendingRuns] ${error.message}`);
  }

  const rows = data || [];
  return {
    queued: rows.find((r) => r.status === 'queued') || null,
    running: rows.find((r) => r.status === 'running') || null,
  };
}

/**
 * The moment a coalesced run should start: the requested window, capped so a
 * steady drip of competitor additions cannot defer it for ever.
 *
 * A cap that has already passed answers the run's existing time rather than a
 * time in the past — the point is to stop deferring, not to yank the run
 * forward and race the claimer.
 */
function coalescedStart(queuedRun, wait, now = Date.now()) {
  const requested = now + wait;
  const enqueuedAt = Date.parse(queuedRun?.created_at || '');
  if (!Number.isFinite(enqueuedAt)) return new Date(requested);

  const ceiling = enqueuedAt + MAX_DEFER_MS;
  if (requested <= ceiling) return new Date(requested);

  const current = Date.parse(queuedRun?.scheduled_for || '');
  return new Date(Number.isFinite(current) ? Math.max(current, ceiling) : ceiling);
}

/**
 * Push an already-queued run's start time out, so the domain just added is
 * included in it.
 *
 * Guarded on `status = 'queued'`: losing that race means a worker claimed the
 * row while this was deciding, and moving a running job's start time would be
 * meaningless. The loser reports the run it lost to rather than failing — the
 * comparison is running either way.
 */
async function pushBack(runId, startAt) {
  const { data, error } = await getSupabase()
    .from('project_module_runs')
    .update({ scheduled_for: startAt.toISOString() })
    .eq('id', runId)
    .eq('status', 'queued')
    .select('id, scheduled_for')
    .maybeSingle();
  if (error) throw new Error(`[competitorAutostart.pushBack] ${error.message}`);
  return data;
}

/**
 * Queue Competitor Research for a project whose domains have just changed.
 *
 * Never throws into its caller: adding a competitor domain succeeded whether or
 * not the comparison could be queued, and a route that 500s after the write it
 * was asked for has told the user the opposite of what happened. Failures come
 * back as a reason instead.
 *
 * @param {object}   input
 * @param {object}   input.access    access context carrying `project` (§7.2)
 * @param {object[]} input.domains   project_domains rows for this project
 * @param {number}  [input.delayMs]  coalescing window; SETUP_DELAY_MS at setup
 * @returns {Promise<{scheduled: boolean, reason: string, runId: string|null,
 *                    startsInSeconds: number|null, competitorCount: number,
 *                    estimate: object|null, note: string|null}>}
 */
async function scheduleCompetitorResearch({ access, domains = [], delayMs: delayOverride } = {}) {
  const project = access?.project;
  const answer = (extra) => ({
    scheduled: false, runId: null, startsInSeconds: null, note: null, estimate: null, ...extra,
  });

  if (!project) return answer({ reason: 'no_project', competitorCount: 0 });
  if (!isSupabaseConfigured()) {
    return answer({ reason: 'not_configured', competitorCount: 0, note: NOTES.not_configured });
  }

  const rows = Array.isArray(domains) ? domains : [];
  const active = rows.filter((d) => d.role === 'competitor' && d.status === 'active');
  const proposed = rows.filter((d) => d.role === 'competitor' && d.status === 'proposed');
  const primary = rows.find((d) => d.role === 'primary' && d.status === 'active');

  const { hasSemrushKey } = require('../competitorAnalysis/provider');

  let pending = { queued: null, running: null };
  let queueAvailable = true;
  try {
    pending = await pendingRuns(project.id);
  } catch (e) {
    if (e.code !== 'queue_unavailable') {
      console.error('[competitorAutostart] could not read in-flight runs:', e.message);
    }
    queueAvailable = false;
  }

  const verdict = decide({
    enabled: isEnabled(),
    canStartRun: access.can ? access.can('startRun') === true : false,
    hasPrimaryDomain: Boolean(primary?.normalized_origin || project.url),
    activeCompetitorCount: active.length,
    proposedCompetitorCount: proposed.length,
    autoFindCompetitors: Boolean(project.settings?.autoFindCompetitors),
    hasSemrushKey: hasSemrushKey(),
    pending,
  });

  const moduleRunners = require('./moduleRunners');
  // What this run bills, stated whether or not it was queued: a caller that
  // decides not to autostart still deserves to know the price of pressing Run.
  const estimate = moduleRunners.estimateCost(MODULE_KEY, { competitorCount: active.length });

  if (!verdict.start) {
    return answer({
      reason: verdict.reason,
      competitorCount: active.length,
      estimate,
      note: NOTES[verdict.reason] || null,
    });
  }

  const wait = delayMs(delayOverride);
  const startAt = pending.queued
    ? coalescedStart(pending.queued, wait)
    : new Date(Date.now() + wait);
  const startsInSeconds = Math.max(0, Math.round((startAt.getTime() - Date.now()) / 1000));

  try {
    if (verdict.coalesceRunId) {
      const moved = await pushBack(verdict.coalesceRunId, startAt);
      // Claimed while we were deciding: it is running now, which is the outcome
      // this was trying to produce.
      if (!moved) {
        return answer({
          scheduled: true,
          reason: 'already_running',
          runId: verdict.coalesceRunId,
          competitorCount: active.length,
          estimate,
          note: 'Competitor Research is already running for this project.',
        });
      }
      return answer({
        scheduled: true,
        reason: 'coalesced',
        runId: verdict.coalesceRunId,
        startsInSeconds,
        competitorCount: active.length,
        estimate,
        note: `Competitor Research is already queued and will start in about ${startsInSeconds}s, `
          + 'comparing every competitor tracked by then.',
      });
    }

    if (!queueAvailable) throw Object.assign(new Error('queue unavailable'), { code: 'queue_unavailable' });

    const run = await moduleQueue.enqueue({
      projectId: project.id,
      workspaceId: project.workspace_id || null,
      moduleKey: MODULE_KEY,
      trigger: TRIGGER,
      scheduledFor: startAt.toISOString(),
      createdBy: access.userId || null,
      targetUrl: primary?.normalized_origin || project.url || null,
      countryCode: project.country_code || null,
    });

    // 0019 not applied: enqueue answers null rather than throwing, and a null
    // here would read as "queued" to every caller.
    if (!run) throw Object.assign(new Error('queue unavailable'), { code: 'queue_unavailable' });

    return answer({
      scheduled: true,
      reason: verdict.reason,
      runId: run.id,
      startsInSeconds,
      competitorCount: active.length,
      estimate,
      note: verdict.reason === 'queued_behind_running'
        ? 'A comparison is already running without this domain, so another was queued behind it '
          + 'that includes it.'
        : `Competitor Research starts in about ${startsInSeconds}s against `
          + `${active.length || 'auto-discovered'} competitor${active.length === 1 ? '' : 's'}.`,
    });
  } catch (e) {
    // `moduleQueue.enqueue` rethrows a plain Error for a missing column, so the
    // message is the only signal that 0019 has not been applied.
    if (e.code === 'queue_unavailable' || isMissingQueueSchema(e)) {
      return runDetached({ access, domains: rows, active, estimate });
    }
    console.error('[competitorAutostart] could not queue the comparison:', e.message);
    return answer({
      reason: 'queue_failed',
      competitorCount: active.length,
      estimate,
      note: `The comparison could not be queued (${e.message}). Start it from the Competitor `
        + 'Research card.',
    });
  }
}

/**
 * Fallback for a deployment where the queue columns are missing (0019 not
 * applied): run it in this process and let it finish on its own.
 *
 * Deliberately a fallback and not the default. It cannot coalesce, so it is
 * gated on nothing else being in flight, and it dies with the process — which
 * is the whole reason the queue exists.
 */
async function runDetached({ access, domains, active, estimate }) {
  const moduleRunners = require('./moduleRunners');
  try {
    const run = await moduleRunners.runModule({
      access, moduleKey: MODULE_KEY, domains, trigger: TRIGGER, detached: true,
    });
    return {
      scheduled: true,
      reason: 'started_unqueued',
      runId: run?.id || null,
      startsInSeconds: 0,
      competitorCount: active.length,
      estimate,
      note: 'Competitor Research started. (The run queue is unavailable — apply '
        + 'supabase/migrations/0019_module_run_queue.sql — so it will not survive a restart.)',
    };
  } catch (e) {
    console.error('[competitorAutostart] detached fallback failed:', e.message);
    return {
      scheduled: false,
      reason: 'start_failed',
      runId: null,
      startsInSeconds: null,
      competitorCount: active.length,
      estimate,
      note: `The comparison could not be started (${e.message}).`,
    };
  }
}

module.exports = {
  MODULE_KEY,
  TRIGGER,
  DEFAULT_DELAY_MS,
  SETUP_DELAY_MS,
  MAX_DEFER_MS,
  NOTES,
  isEnabled,
  delayMs,
  decide,
  coalescedStart,
  scheduleCompetitorResearch,
};
