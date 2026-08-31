// ── The module worker ───────────────────────────────────────────────────────
//
// Three loops: claim work and run it, sweep dead claims, and fire schedules.
//
// It is deliberately a separate process in production. Headless Chrome is
// 150–300MB per page and blocks on network for 25–110 seconds at a time; run
// alongside the HTTP server it competes for memory with request handling, and a
// browser leak takes the API down with it. `nixpacks.toml` already provisions
// chromium and `.env.example` already documents the equivalent CrawlScope
// switch, so this follows that shape exactly rather than inventing a second
// deployment story.
//
// Every loop is safe to run on several replicas at once:
//   • claiming is a compare-and-swap, so a race produces one winner
//   • the reaper's write is guarded on the heartbeat it observed
//   • the scheduler's advance is guarded on the next_run_at it observed
//
// Nothing here retries forever. A run that keeps dying burns its attempts and
// is failed, because "the queue is busy but nothing finishes" is a much harder
// symptom to diagnose than a failed run with a reason on it.

const os = require('os');
const moduleQueue = require('./moduleQueue');
const moduleScheduler = require('./moduleScheduler');
const { isSupabaseConfigured } = require('./supabase');

const CLAIM_INTERVAL_MS = Number(process.env.MODULE_WORKER_POLL_MS) || 5_000;
const REAP_INTERVAL_MS = Number(process.env.MODULE_WORKER_REAP_MS) || 60_000;
const SCHEDULE_INTERVAL_MS = Number(process.env.MODULE_WORKER_SCHEDULE_MS) || 60_000;
const HEARTBEAT_INTERVAL_MS = Number(process.env.MODULE_WORKER_HEARTBEAT_MS) || 30_000;

/** Identifies this replica in the run row. Host + pid is enough to find it. */
function workerId() {
  return process.env.MODULE_WORKER_ID || `${os.hostname()}:${process.pid}`;
}

/**
 * Run one claimed job, heartbeating throughout.
 *
 * The heartbeat runs on a timer rather than between steps because a single
 * capture can legitimately take 110 seconds — long enough for a
 * between-steps-only heartbeat to look dead to the reaper mid-capture, get
 * reclaimed, and end up running twice.
 *
 * If a heartbeat comes back false the row is no longer ours (a reaper decided
 * we were dead). Stop immediately: continuing would have two workers writing
 * captures for the same run.
 */
async function runJob(run, executors) {
  const id = workerId();
  let lost = false;

  const beat = setInterval(async () => {
    try {
      const held = await moduleQueue.heartbeat(run.id, id);
      if (!held) lost = true;
    } catch { /* a missed beat is survivable; the reaper's threshold is minutes */ }
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const execute = executors[run.module_key];
    if (!execute) throw new Error(`No executor registered for "${run.module_key}".`);
    return await execute(run, { isStillOurs: () => !lost });
  } finally {
    clearInterval(beat);
  }
}

/**
 * Start the loops.
 *
 * @param {object} input
 * @param {object} input.executors  { [moduleKey]: async (run, ctx) => void }
 * @param {string[]} [input.moduleKeys] what this replica will claim
 * @returns {{stop: Function, workerId: string}}
 */
function startLoops({ executors = {}, moduleKeys = null } = {}) {
  if (!isSupabaseConfigured()) {
    console.log('[moduleWorker] Not started — Supabase is not configured.');
    return { stop: () => {}, workerId: null };
  }

  const id = workerId();
  const keys = moduleKeys || Object.keys(executors);
  let stopped = false;
  let busy = false;

  console.log(`[moduleWorker] ${id} claiming: ${keys.join(', ') || '(nothing)'}`);

  // Claim loop. One job at a time per replica: the capture work inside is
  // already parallel across engines under its own gates, and a second
  // concurrent job would multiply the browser count past that ceiling.
  const claimTimer = setInterval(async () => {
    if (stopped || busy || !keys.length) return;
    busy = true;
    try {
      const run = await moduleQueue.claimNext({ workerId: id, moduleKeys: keys });
      if (run) await runJob(run, executors);
    } catch (e) {
      console.error('[moduleWorker] claim/run failed:', e.message);
    } finally {
      busy = false;
    }
  }, CLAIM_INTERVAL_MS);

  const reapTimer = setInterval(async () => {
    if (stopped) return;
    try {
      const result = await moduleQueue.reap();
      if (result.found) {
        console.log(`[moduleWorker] reaped ${result.found}: `
          + `${result.requeued} requeued, ${result.failed} failed, ${result.skipped} skipped`);
      }
    } catch (e) {
      console.error('[moduleWorker] reap failed:', e.message);
    }
  }, REAP_INTERVAL_MS);

  const scheduleTimer = setInterval(async () => {
    if (stopped) return;
    try {
      const result = await moduleScheduler.tick();
      if (result.enqueued) console.log(`[moduleWorker] scheduled ${result.enqueued} run(s)`);
      for (const err of result.errors) {
        console.error('[moduleWorker] schedule error:', err.scheduleId, err.message);
      }
    } catch (e) {
      console.error('[moduleWorker] schedule tick failed:', e.message);
    }
  }, SCHEDULE_INTERVAL_MS);

  // Unref so these timers never hold the process open on their own — a worker
  // with nothing to do should still exit on SIGTERM.
  claimTimer.unref?.();
  reapTimer.unref?.();
  scheduleTimer.unref?.();

  return {
    workerId: id,
    stop() {
      stopped = true;
      clearInterval(claimTimer);
      clearInterval(reapTimer);
      clearInterval(scheduleTimer);
    },
  };
}

module.exports = {
  CLAIM_INTERVAL_MS,
  REAP_INTERVAL_MS,
  SCHEDULE_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  workerId,
  runJob,
  startLoops,
};
