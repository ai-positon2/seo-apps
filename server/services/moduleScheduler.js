// ── The scheduler ───────────────────────────────────────────────────────────
//
// Turns `project_module_schedules` rows into queued runs. It does not execute
// anything — it decides WHEN, the queue decides WHO, and the worker does the
// work. Keeping those separate is what lets the worker be scaled or restarted
// without losing a cadence.
//
// The cron maths is CrawlScope's `shared/cron.js`, unchanged: timezone-correct,
// and `advance()` is catch-up-safe, so a worker that was down for a month fires
// ONCE on return rather than thirty times. That property is not obvious and is
// easy to lose by reimplementing, which is why this reuses rather than copies.
//
// `staggerMinute` spreads clients across the hour. Without it every project
// configured for "3 AM" lands on the same minute and the worker chews through
// them serially while every client waits — with it, ten clients fire about six
// minutes apart and the herd never forms.

const { getSupabase, isSupabaseConfigured } = require('./supabase');
const adminLimits = require('./adminLimits');
const moduleQueue = require('./moduleQueue');
const { advance, nextRun, isValidCron, isValidTimezone } = require('../modules/crawlScope/shared/cron');
const { staggerMinute } = require('../modules/crawlScope/shared/schedule');

const SCHEDULE_COLUMNS = 'id, project_id, workspace_id, module_key, enabled, cron, timezone, '
  + 'next_run_at, last_run_at, last_run_id, monthly_budget_usd';

function fail(op, error) {
  throw new Error(`[moduleScheduler.${op}] ${error.message || error}`);
}

/** Missing table = 0019 not applied. Nothing scheduled is the safe reading. */
function isMissingTable(error) {
  return /relation .* does not exist|schema cache|Could not find the table/i.test(error?.message || '');
}

/**
 * Hours between fires, from a daily/weekly cron.
 *
 * Only needs to distinguish "daily" from "weekly" from "more often than daily",
 * because that is all `scheduleMinIntervalHours` gates. A cron minute field of
 * `*`, or one carrying a step, is sub-hourly and reported as such.
 */
function intervalHoursOf(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, , dow] = parts;
  if (minute.includes('*') || minute.includes('/')) return 1 / 60;
  if (hour.includes('*') || hour.includes('/')) return 1;
  if (dow !== '*') return 168;      // a named weekday is weekly
  if (dom !== '*') return 720;      // a day of month is monthly
  return 24;                         // fixed hour, every day
}

/**
 * The floor a workspace is allowed to schedule at.
 *
 * `scheduleMinIntervalHours` has been defined and resolvable in adminLimits
 * since the platform foundation, with tests covering its resolution — but
 * nothing has ever CHECKED it. Wiring it in here rather than inheriting the gap.
 */
async function minIntervalHours(access) {
  try {
    const hours = await adminLimits.limit('scheduleMinIntervalHours', access);
    return Number(hours) || 24;
  } catch {
    return 24;
  }
}

/**
 * Validate and store a schedule.
 *
 * The minute is replaced with the project's deterministic stagger unless the
 * caller pinned one — a person choosing "daily at 3 AM" means the hour, not the
 * minute, and spreading the minute costs them nothing.
 */
async function upsertSchedule({
  access, moduleKey, enabled = true, cron = '0 3 * * *', timezone = 'UTC',
  monthlyBudgetUsd = null, pinMinute = false,
}) {
  if (!isSupabaseConfigured()) throw new Error('Supabase is not configured.');
  if (!isValidCron(cron)) {
    throw Object.assign(new Error(`"${cron}" is not a valid schedule.`), { status: 400, code: 'bad_cron' });
  }
  if (!isValidTimezone(timezone)) {
    throw Object.assign(new Error(`"${timezone}" is not a known timezone.`), { status: 400, code: 'bad_timezone' });
  }

  const floor = await minIntervalHours(access);
  const interval = intervalHoursOf(cron);
  if (interval !== null && interval < floor) {
    throw Object.assign(
      new Error(`This workspace allows a run at most every ${floor} hour(s); `
        + `that schedule would run every ${interval} hour(s).`),
      { status: 400, code: 'interval_too_short' },
    );
  }

  const projectId = access.project.id;
  let finalCron = cron;
  if (!pinMinute) {
    const parts = cron.trim().split(/\s+/);
    parts[0] = String(staggerMinute(projectId));
    finalCron = parts.join(' ');
  }

  const next = enabled ? nextRun(finalCron, new Date(), timezone) : null;

  const { data, error } = await getSupabase()
    .from('project_module_schedules')
    .upsert({
      project_id: projectId,
      workspace_id: access.project.workspace_id || null,
      module_key: moduleKey,
      enabled,
      cron: finalCron,
      timezone,
      monthly_budget_usd: monthlyBudgetUsd,
      next_run_at: next ? next.toISOString() : null,
    }, { onConflict: 'project_id,module_key' })
    .select(SCHEDULE_COLUMNS)
    .maybeSingle();

  if (error) fail('upsertSchedule', error);
  return data;
}

async function getSchedule(projectId, moduleKey) {
  if (!isSupabaseConfigured()) return null;
  const { data, error } = await getSupabase()
    .from('project_module_schedules')
    .select(SCHEDULE_COLUMNS)
    .eq('project_id', projectId)
    .eq('module_key', moduleKey)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    fail('getSchedule', error);
  }
  return data;
}

/** Schedules whose time has come. */
async function due({ limit = 50, now = new Date() } = {}) {
  if (!isSupabaseConfigured()) return [];
  const { data, error } = await getSupabase()
    .from('project_module_schedules')
    .select(SCHEDULE_COLUMNS)
    .eq('enabled', true)
    .not('next_run_at', 'is', null)
    .lte('next_run_at', now.toISOString())
    .order('next_run_at', { ascending: true })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) return [];
    fail('due', error);
  }
  return data || [];
}

/**
 * One scheduler tick.
 *
 * Advances the schedule BEFORE enqueueing. If enqueue fails, the cadence has
 * still moved on and the client misses one run — which is far better than the
 * alternative: advancing after a failure that keeps failing would re-enqueue
 * the same overdue slot on every tick and flood the queue.
 *
 * Idempotent enough to run on several replicas: the advance is guarded on the
 * `next_run_at` we observed, so a second replica's update matches no row and it
 * skips without enqueueing a duplicate.
 */
async function tick({ now = new Date(), limit = 50 } = {}) {
  const result = {
    considered: 0, enqueued: 0, skipped: 0, errors: [],
  };
  const rows = await due({ limit, now });
  result.considered = rows.length;
  if (!rows.length) return result;

  const db = getSupabase();

  for (const schedule of rows) {
    try {
      const next = advance(schedule.cron, schedule.timezone, schedule.next_run_at, now);

      // The CAS: only the replica that still sees the observed next_run_at
      // proceeds. Everyone else finds no row and skips.
      const { data: won, error } = await db
        .from('project_module_schedules')
        .update({
          next_run_at: next ? next.toISOString() : null,
          last_run_at: now.toISOString(),
        })
        .eq('id', schedule.id)
        .eq('next_run_at', schedule.next_run_at)
        .select('id')
        .maybeSingle();

      if (error) throw error;
      if (!won) { result.skipped += 1; continue; }

      const run = await moduleQueue.enqueue({
        projectId: schedule.project_id,
        workspaceId: schedule.workspace_id,
        moduleKey: schedule.module_key,
        trigger: 'schedule',
      });

      await db.from('project_module_schedules')
        .update({ last_run_id: run?.id || null })
        .eq('id', schedule.id);

      result.enqueued += 1;
    } catch (e) {
      result.errors.push({ scheduleId: schedule.id, message: e.message });
    }
  }

  return result;
}

module.exports = {
  intervalHoursOf,
  minIntervalHours,
  upsertSchedule,
  getSchedule,
  due,
  tick,
};
