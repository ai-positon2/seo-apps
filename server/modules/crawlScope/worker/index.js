// CrawlScope worker: turns due projects into runs, executes queued runs, and emails the
// report on completion. Runs as its own Railway service (no HTTP port).
//
// Two independent loop families share the process:
//
//   schedulerLoop  — evaluates due projects and reclaims dead runs, on a fixed tick
//   executorLoop×N — claims a queued run and executes it, N = WORKER_CONCURRENCY
//
// They are separate because scheduling must not be blocked by crawling. A single
// combined loop means a 40-minute crawl also delays every schedule evaluation by 40
// minutes, so a weekly project can silently fire late (or, with several projects due at
// once, hours late).

// Env is loaded here, not just in server.js: this file is its own entry point
// (`npm run worker`, and the Railway worker service). Deployed it inherits real
// env vars from the platform, so the omission was invisible there — but run
// locally it read an empty process.env and died on the first serviceClient()
// call with "the database is not configured", before a single line of its own ran.
// Matches server.js and worker-module.js, the other two entry points.
require("dotenv").config({ path: require("path").join(__dirname, "../../../../.env") });

const os = require("node:os");

const { serviceClient } = require("../db/client");
const { RunManager } = require("../run/manager");
const { advance, nextRun, DEFAULT_TIMEZONE } = require("../shared/cron");
const repo = require("../db/repo");
// Required as namespaces, not destructured, so tests can substitute the email and report
// side effects. A destructured binding captures the original function and cannot be
// intercepted.
const report = require("../run/report");
const email = require("./email");

const POLL_MS = Number(process.env.WORKER_POLL_MS) || 5_000;
const SCHEDULE_TICK_MS = Number(process.env.SCHEDULE_TICK_MS) || 30_000;
const SCHEDULE_MAX_DUE = Number(process.env.SCHEDULE_MAX_DUE) || 50;
const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 2);
const RUN_STALE_MS = Number(process.env.RUN_STALE_MS) || 600_000;
const RUN_MAX_ATTEMPTS = Number(process.env.RUN_MAX_ATTEMPTS) || 2;
// How long shutdown waits for in-flight runs to requeue themselves cleanly.
// Must stay inside the platform's stop grace window.
const SHUTDOWN_DRAIN_MS = Number(process.env.WORKER_SHUTDOWN_DRAIN_MS) || 15_000;

// 'initial' covers both the first crawl of a new project and on-demand "run now".
// Both are worker-executed so they get the same emailed report as a scheduled crawl.
const WORKER_TRIGGERS = ["schedule", "initial"];

const WORKER_ID =
  process.env.WORKER_ID ||
  `${process.env.RAILWAY_REPLICA_ID || os.hostname()}:${process.pid}`;

// Spread polls so N slots across M replicas don't all hit the database on the same
// instant, and a restart storm doesn't self-synchronize.
const jitter = (ms) => ms / 2 + Math.random() * ms;

// A sleep that returns early on shutdown. The platform's stop grace window is short, so
// waiting out a full poll interval before noticing SIGTERM wastes most of it.
function sleepUntil(state, ms) {
  return new Promise((resolve) => {
    if (!state.running) return resolve();
    const done = () => {
      clearTimeout(timer);
      state.wakeups.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    state.wakeups.add(done);
  });
}

// ---- scheduling ------------------------------------------------------------

// Enqueue a run for one due project, then advance its fire slot.
//
// Order matters. Advancing first and enqueueing second would silently skip a week if the
// process died between the two. Enqueueing first would duplicate the crawl (and the
// client's email) instead — except the runs_project_slot_uniq constraint makes the
// enqueue idempotent per (project, slot), so a duplicate insert is a no-op. That makes
// enqueue-then-advance safe at every crash point, and it also means a transient enqueue
// failure leaves next_run_at untouched so the next tick retries rather than losing a week.
async function fireProject(db, project, now) {
  const slot = project.next_run_at; // the INTENDED fire instant, passed through verbatim
  const timezone = project.timezone || DEFAULT_TIMEZONE;

  const run = await repo.enqueueScheduledRun(db, {
    owner: project.owner,
    // Inherited from the project so a scheduled run is attributed to the same
    // workspace the project was created in, matching this app's tool_runs.
    workspace_id: project.workspace_id || null,
    project_id: project.id,
    scheduled_for: slot,
    url: project.url,
    options: project.options,
    trigger: "schedule",
  });

  // Advance from the SCHEDULED time, not from `now`: anchored on now, a tick landing at
  // or just before the slot instant would compute the slot itself as the next fire and
  // enqueue it a second time. See advance() in src/shared/cron.js.
  const next = advance(project.cron, timezone, slot, now);
  const won = await repo.advanceProjectFrom(db, project.id, slot, {
    last_run_at: now.toISOString(),
    next_run_at: next ? next.toISOString() : null,
  });

  if (!run) {
    console.log(`project ${project.id}: slot ${slot} already enqueued elsewhere`);
    return false;
  }
  // Lateness is the scheduler's health signal: it should stay within one tick interval.
  // A large or growing value means ticks are being starved or the queue is backed up.
  const lateMs = now - new Date(slot);
  console.log(
    `project ${project.id} fired slot ${slot} (+${lateMs}ms late) -> run ${run.id}; ` +
      `next=${next ? next.toISOString() : "never"}${won ? "" : " [advance lost race]"}`,
  );
  return true;
}

// An enabled project whose next_run_at is NULL is invisible to dueProjects (SQL NULL
// comparison), so it would sleep forever. Repair from `now` with no back-fill, so a
// project that sat disabled for a month resumes on its next natural occurrence rather
// than firing instantly on re-enable.
async function repairDormantProjects(db, now) {
  const rows = await repo.dormantProjects(db, { limit: SCHEDULE_MAX_DUE });
  for (const project of rows) {
    const next = nextRun(project.cron, now, project.timezone || DEFAULT_TIMEZONE);
    if (!next) {
      console.warn(`project ${project.id}: cron "${project.cron}" never fires; leaving dormant`);
      continue;
    }
    await repo.repairProjectNextRun(db, project.id, next.toISOString());
    console.warn(`project ${project.id}: next_run_at was NULL, repaired to ${next.toISOString()}`);
  }
}

async function tickSchedules(db) {
  const now = new Date();
  const due = await repo.dueProjects(db, now.toISOString(), { limit: SCHEDULE_MAX_DUE });
  let fired = 0;
  for (const project of due) {
    try {
      if (await fireProject(db, project, now)) fired += 1;
    } catch (error) {
      // Per-project isolation: one bad project must not stall the rest. Its
      // next_run_at is untouched, so it retries on the next tick.
      console.error(`project ${project.id} fire failed:`, error.message);
    }
  }
  if (due.length >= SCHEDULE_MAX_DUE) {
    console.warn(
      `schedule tick saturated at SCHEDULE_MAX_DUE=${SCHEDULE_MAX_DUE}; remainder next tick`,
    );
  }
  await repairDormantProjects(db, now);
  return fired;
}

// ---- dead-worker recovery --------------------------------------------------

// A container killed mid-crawl (OOM, host loss) leaves its run stuck in 'running'
// forever: invisible to the queue, and the client silently never gets a report. Runs
// that stop heart-beating are put back on the queue, or failed after too many attempts.
async function reapStaleRuns(db) {
  const staleBefore = new Date(Date.now() - RUN_STALE_MS).toISOString();
  const stale = await repo.staleRuns(db, staleBefore, { limit: 20 });

  for (const run of stale) {
    try {
      const attempts = (run.attempts || 0) + 1;

      // Only triggers this worker will claim can be retried. Requeueing a 'manual' run
      // would strand it: it executes in the web process, nothing polls the queue for it,
      // and it could never reach a terminal state either. Fail it outright instead.
      if (!WORKER_TRIGGERS.includes(run.trigger)) {
        const failed = await repo.failStaleRun(
          db,
          run,
          attempts,
          "The process executing this run stopped responding.",
        );
        if (failed) {
          console.warn(`failed orphaned ${run.trigger} run ${run.id} (worker ${run.worker_id})`);
        }
        continue;
      }

      if (attempts > RUN_MAX_ATTEMPTS) {
        const failed = await repo.failStaleRun(
          db,
          run,
          attempts,
          "The crawl worker stopped responding and the run could not be completed.",
        );
        if (failed) {
          console.error(
            `run ${run.id} abandoned after ${attempts} attempts (worker ${run.worker_id})`,
          );
          await notifyFailure(db, failed, new Error(failed.error));
        }
        continue;
      }
      // A run with a usable frontier resumes from it; the rows its dead attempt
      // already stored are the pages it no longer has to fetch, and `seen`
      // covers them so nothing is written twice. Without a checkpoint the retry
      // still has to start from the seed, and then the partial rows MUST go —
      // otherwise the retry appends a second full set and the report
      // double-counts every page.
      const resumable = Boolean(run.checkpoint?.version);
      const requeued = await repo.reclaimStaleRun(db, run, attempts, { keepCheckpoint: resumable });
      if (requeued) {
        if (!resumable) await repo.deleteRunResults(db, run.id);
        console.warn(
          `reclaimed run ${run.id} -> queued (attempt ${attempts}, worker ${run.worker_id}` +
            `${resumable ? `, resuming from ${run.checkpoint.completedCount || 0} pages` : ", from seed"})`,
        );
      }
    } catch (error) {
      console.error(`reaping run ${run.id} failed:`, error.message);
    }
  }
}

// ---- notification ----------------------------------------------------------

// Build the workbook once, store it for later downloads, and email it.
async function emailReport(db, { run, summary, counts }) {
  if (!run.project_id) return;

  // Check recipients before doing any other work: with none configured there is
  // nothing to build, upload, or look up.
  let project = null;
  try {
    project = await repo.getProject(db, run.project_id);
  } catch (error) {
    console.error(`project lookup failed for run ${run.id}:`, error.message);
  }
  const recipients = project?.recipients || [];
  if (!recipients.length) return;

  let previousCounts = null;
  try {
    const prev = await repo.previousCompletedRun(db, run.project_id, run.created_at);
    previousCounts = prev?.summary?.counts || null;
  } catch (error) {
    console.error(`delta lookup failed for run ${run.id}:`, error.message);
  }

  const findings = summary.findings || [];
  const finishedAt = new Date().toISOString();

  try {
    const workbook = await report.buildReportBuffer({
      findings,
      siteUrl: run.url,
      crawlDate: finishedAt,
      coverage: summary.coverage || null,
    });
    const path = await report.storeReport(db, run, workbook);
    if (path) await repo.updateRun(db, run.id, { report_path: path });
    const downloadUrl = path ? await report.signedReportUrl(db, path, 7 * 24 * 3600) : null;

    const outcome = await email.sendReportEmail({
      run: { ...run, finished_at: finishedAt },
      counts,
      previousCounts,
      // Computed by the run manager against the same previous crawl.
      comparison: summary.comparison || null,
      findings,
      recipients,
      workbook,
      downloadUrl,
    });

    if (outcome?.skipped) {
      console.warn(`report email skipped for run ${run.id}: ${outcome.skipped}`);
    } else if (outcome?.failed?.length) {
      // Record the delivery failure on the run so it is visible in the UI, not only in
      // logs nobody reads. The crawl itself succeeded, so the status stays 'completed'.
      const detail = outcome.failed.map((entry) => `${entry.recipient}: ${entry.message}`).join("; ");
      console.error(
        `report email failed for run ${run.id} (${outcome.failed.length}/${recipients.length}): ${detail}`,
      );
      await repo
        .updateRun(db, run.id, { error: `Report email failed — ${detail}` })
        .catch(() => {});
    } else {
      console.log(
        `emailed report for run ${run.id} to ${outcome?.sent?.length ?? recipients.length} recipient(s)`,
      );
    }
  } catch (error) {
    // The crawl finished but its report never reached anyone. Silence here would look
    // exactly like a clean audit, so tell the recipients something went wrong.
    console.error(`report delivery failed for run ${run.id}:`, error.message);
    await repo
      .updateRun(db, run.id, { error: `Report delivery failed — ${error.message}` })
      .catch(() => {});
    await notifyFailure(
      db,
      { ...run, project_id: run.project_id },
      new Error(`The crawl completed but its report could not be delivered: ${error.message}`),
    ).catch(() => {});
  }
}

async function notifyFailure(db, run, error) {
  if (!run.project_id) return;
  try {
    const project = await repo.getProject(db, run.project_id);
    const recipients = project?.recipients || [];
    if (!recipients.length) return;
    await email.sendFailureEmail({
      run,
      projectName: project.name || run.url,
      message: String(error?.message || error || "unknown error"),
      recipients,
    });
    console.log(`emailed failure notice for run ${run.id} to ${recipients.length} recipient(s)`);
  } catch (sendError) {
    console.error(`failure notice failed for run ${run.id}:`, sendError.message);
  }
}

// ---- execution -------------------------------------------------------------

async function runOne(manager, db, state, run, slot) {
  const startedAt = Date.now();
  console.log(
    `[slot ${slot}] run ${run.id} start url=${run.url} scheduled_for=${run.scheduled_for ?? "-"}`,
  );

  let result = null;
  let failure = null;
  try {
    // execute() rethrows after marking the run failed, and the web service relies on
    // that, so the catch belongs here rather than inside the manager.
    // Already claimed atomically by claimNextQueuedRun.
    result = await manager.execute(run, { claimed: true });
  } catch (error) {
    failure = error;
  }

  // A crawl cut short by our own shutdown yields summary.stopped, which is
  // indistinguishable from a user-requested stop at the manager level. Emailing it would
  // send every client a truncated audit on each redeploy, so requeue it instead and let
  // the next container finish the job.
  if (result?.summary?.stopped && !state.running) {
    console.warn(`[slot ${slot}] run ${run.id} stopped by shutdown; requeueing`);
    try {
      // A redeploy is the most common way a long crawl dies, so this is the path
      // that most needs to resume rather than restart. The checkpoint written by
      // the heartbeat is left in place and the stored rows are kept: the next
      // container picks up where this one stopped.
      //
      // Without a checkpoint the partial rows MUST be cleared first — execute()
      // only ever inserts, so a restart would append a second full set of
      // results and findings and the report would double-count every page.
      const checkpoint = await repo.getRunCheckpoint(db, run.id);
      const resumable = Boolean(checkpoint?.version);
      if (!resumable) await repo.deleteRunResults(db, run.id);
      await repo.requeueRun(db, run.id, {
        attempts: (run.attempts || 0) + 1,
        keepCheckpoint: resumable,
      });
      console.warn(
        `[slot ${slot}] run ${run.id} requeued ` +
          `${resumable ? `to resume from ${checkpoint.completedCount || 0} pages` : "to restart from the seed"}`,
      );
    } catch (error) {
      console.error(`requeue failed for run ${run.id}:`, error.message);
    }
    return;
  }

  // Notification is best-effort: it must never take down the executor slot.
  try {
    if (result) await emailReport(db, result);
    else await notifyFailure(db, run, failure);
  } catch (error) {
    console.error(`notify failed for run ${run.id}:`, error.message);
  }

  const outcome = failure ? "FAILED" : result?.summary?.stopped ? "stopped" : "ok";
  console.log(
    `[slot ${slot}] run ${run.id} ${outcome} in ${Date.now() - startedAt}ms` +
      `${failure ? ` err=${failure.message}` : ""}`,
  );
}

// ---- loops -----------------------------------------------------------------

async function schedulerLoop(db, state) {
  while (state.running) {
    try {
      await tickSchedules(db);
      await reapStaleRuns(db);
    } catch (error) {
      console.error("scheduler tick failed:", error.message);
    }
    await sleepUntil(state, jitter(SCHEDULE_TICK_MS));
  }
  console.log("scheduler loop exited");
}

async function executorLoop(manager, db, state, slot) {
  await sleepUntil(state, slot * 250); // stagger slot startup
  while (state.running) {
    let run = null;
    try {
      run = await repo.claimNextQueuedRun(db, {
        triggers: WORKER_TRIGGERS,
        workerId: `${WORKER_ID}#${slot}`,
      });
    } catch (error) {
      console.error(`[slot ${slot}] claim failed:`, error.message);
    }
    if (!run) {
      await sleepUntil(state, jitter(POLL_MS));
      continue;
    }
    try {
      await runOne(manager, db, state, run, slot);
    } catch (error) {
      console.error(`[slot ${slot}] unexpected error on run ${run.id}:`, error.message);
    }
  }
  console.log(`executor slot ${slot} exited`);
}

// Boots the scheduler + executor loops and hands back a stop handle.
//
// `manageProcess` distinguishes the two ways this app runs the worker:
//
//   true  — the standalone `npm run worker` service. This process exists only to
//           be the worker, so it owns SIGTERM/SIGINT and exits when drained.
//   false — booted inside the web server (the default, see server.js). The web
//           process owns its own lifecycle: installing signal handlers here would
//           double-handle them, and process.exit() would take the HTTP server down
//           with the crawler.
function startLoops({ manageProcess = false } = {}) {
  const db = serviceClient();
  const manager = new RunManager({
    serviceClient,
    // Unattended crawls share a process and nobody is watching them, so they get
    // politer settings than the interactive web path. These can only tighten a run's
    // own options, never loosen them.
    optionOverrides: {
      perHostDelay: Number(process.env.WORKER_PER_HOST_DELAY_MS) || 500,
      concurrency: Number(process.env.WORKER_RUN_CONCURRENCY) || 4,
    },
  });
  const state = { running: true, wakeups: new Set() };

  const shutdown = async () => {
    console.log("[crawlScope] Shutting down worker…");
    state.running = false;
    for (const wake of [...state.wakeups]) wake();
    // manager.shutdown() now waits for each run to unwind — requeueing its
    // partial rows and clearing them — instead of returning the moment the
    // crawlers were told to stop. Previously the 8-second exit timer below
    // raced that cleanup and could cut it off mid-write, stranding the run in
    // 'running' with a half-written result set for a full stale window.
    await manager.shutdown({ timeoutMs: SHUTDOWN_DRAIN_MS });
    // Only after the drain do the loops get their chance to exit cleanly; the
    // timer is the backstop for a loop that is wedged, not the normal path.
    if (manageProcess) setTimeout(() => process.exit(0), 5_000).unref();
  };

  if (manageProcess) {
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  console.log(
    `[crawlScope] worker ${WORKER_ID} started (concurrency ${WORKER_CONCURRENCY}, ` +
      `poll ${POLL_MS}ms, tick ${SCHEDULE_TICK_MS}ms, tz ${DEFAULT_TIMEZONE}` +
      `${manageProcess ? "" : ", in-process"})`,
  );

  const loops = [schedulerLoop(db, state)];
  for (let slot = 0; slot < WORKER_CONCURRENCY; slot += 1) {
    loops.push(executorLoop(manager, db, state, slot));
  }
  const done = Promise.all(loops).catch((error) => {
    console.error("[crawlScope] fatal worker error:", error);
    // Standalone, a dead worker should restart, so a non-zero exit is right.
    // In-process, the web server must survive its crawler falling over.
    if (manageProcess) process.exit(1);
  });

  return { stop: shutdown, done, workerId: WORKER_ID, manager };
}

function start() {
  return startLoops({ manageProcess: true });
}

if (require.main === module) start();

module.exports = {
  tickSchedules,
  reapStaleRuns,
  emailReport,
  notifyFailure,
  runOne,
  schedulerLoop,
  executorLoop,
  sleepUntil,
  start,
  startLoops,
  WORKER_TRIGGERS,
};
