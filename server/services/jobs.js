// ── Durable jobs ─────────────────────────────────────────────────────────────
// One way to run long tool work: start it, follow it, fetch what it produced.
//
//   POST /api/<tool>/runs           → 202 { run: { id, status: 'running', … } }   (startJob)
//   GET  /api/runs/:id/events       → SSE, resumable with Last-Event-ID           (routes/runs.js)
//   GET  /api/runs/:id/result       → { result }
//   POST /api/runs/:id/cancel       → 202 { run }
//
// A job is a tool_runs row (so it shows in run history like any other run)
// plus an ordered list of tool_run_events. The work runs in this process after
// the response; everything it reports goes to the database first, so a
// refresh, a dropped connection or a second tab sees the same run. A heartbeat
// every 15 s lets sweepInterrupted() fail a job whose process died, instead of
// leaving it at 'running'.
//
// Events a job writes, in order:
//   <tool events>…       whatever the tool emits (step, url_done, recommendations…)
//   progress             { …tool-defined } — also kept on the row as `progress`
//   result               the value work() resolved to, when it returned one
//   error                { error, code } — only when it failed
//   status               { status: 'completed' | 'failed' | 'cancelled', code?, error? } — always last
//
// Error text follows the API rule: an ApiError's message reaches the user; any
// other failure is reported generically and logged, because pipeline errors
// carry upstream URLs, keys and SQL.
//
// Schema: supabase/migrations/0042_tool_run_jobs.sql

const db = require('./db');
const runStore = require('./runStore');
const { resolveIdentity } = require('./workspaceContext');
const { ApiError, errorBody, notConfigured } = require('../utils/api/errors');

const HEARTBEAT_MS = 15 * 1000;
const STALE_MS = 2 * 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
// The framework writes these; a tool emitting them would confuse every client.
const RESERVED_EVENTS = new Set(['status', 'error']);

const GENERIC_FAILURE = 'The run failed. Try again, and if it keeps failing let the team know.';
const INTERRUPTED = 'The server restarted while this was running. Start it again.';

// runId → job, for jobs running in this process.
const active = new Map();

function failureBody(err) {
  const { status, body } = errorBody(err);
  if (status >= 500 && !(err instanceof ApiError)) return { error: GENERIC_FAILURE, code: 'internal' };
  return body.details === undefined ? { error: body.error, code: body.code } : body;
}

function createJob(runId, userId) {
  const controller = new AbortController();
  let chain = Promise.resolve();
  let terminated = false;
  let latestProgress;

  const append = (event, data) => {
    chain = chain
      .then(() => db.query(
        'insert into tool_run_events (run_id, event, data) values ($1, $2, $3::jsonb)',
        [runId, event, JSON.stringify(data === undefined ? null : data)],
      ))
      .catch((e) => console.error(`[jobs] could not record "${event}" for ${runId}:`, e.message));
    return chain;
  };

  const job = {
    runId,
    userId,
    controller,
    get terminated() { return terminated; },
    append,
    flush: () => chain,
    emit(event, data) {
      if (terminated) return;
      if (RESERVED_EVENTS.has(event)) throw new Error(`"${event}" is written by the job framework; throw instead.`);
      append(event, data);
    },
    progress(value) {
      if (terminated) return;
      latestProgress = value;
      append('progress', value);
    },
    get latestProgress() { return latestProgress; },
    // Writes the terminal events once; later calls are ignored. The work may
    // still be running (a cancelled pipeline mid-request), but nothing it
    // reports after this point is recorded.
    async terminate(status, { error, code, result, durationMs } = {}) {
      if (terminated) return false;
      terminated = true;
      clearInterval(job.heartbeat);
      if (status === 'completed' && result !== undefined) append('result', result);
      if (status === 'failed') append('error', { error, code });
      append('status', { status, ...(code ? { code } : {}), ...(error ? { error } : {}) });
      await chain;
      // services/db passes a string to a jsonb column as already-serialized
      // JSON, so a job that returns plain text ('done') would fail the update
      // and leave the row at 'running'. Wrap anything that isn't an object.
      const output = result === undefined || result === null || typeof result === 'object'
        ? result
        : { value: result };
      await runStore.finishRun(runId, { status, output, error, durationMs });
      try {
        await db.query(
          'update tool_runs set progress = coalesce($2::jsonb, progress), heartbeat_at = now() where id = $1',
          [runId, latestProgress === undefined ? null : JSON.stringify(latestProgress)],
        );
      } catch (e) {
        console.error(`[jobs] could not close ${runId}:`, e.message);
      }
      active.delete(runId);
      return true;
    },
  };

  job.heartbeat = setInterval(async () => {
    try {
      const row = await db.maybeOne(
        `update tool_runs
            set heartbeat_at = now(),
                progress = coalesce($2::jsonb, progress),
                updated_at = now()
          where id = $1 and status = 'running'
          returning cancel_requested_at`,
        [runId, latestProgress === undefined ? null : JSON.stringify(latestProgress)],
      );
      // A cancel recorded by another process (or a restarted one) lands here.
      if (row?.cancel_requested_at && !controller.signal.aborted) cancelActive(job);
    } catch (e) {
      console.error(`[jobs] heartbeat failed for ${runId}:`, e.message);
    }
  }, HEARTBEAT_MS);
  if (typeof job.heartbeat.unref === 'function') job.heartbeat.unref();

  return job;
}

async function execute(job, work) {
  const started = Date.now();
  try {
    const result = await work({
      emit: job.emit,
      progress: job.progress,
      signal: job.controller.signal,
      runId: job.runId,
    });
    if (job.controller.signal.aborted) {
      await job.terminate('cancelled', { durationMs: Date.now() - started });
    } else {
      await job.terminate('completed', { result, durationMs: Date.now() - started });
    }
  } catch (err) {
    if (job.controller.signal.aborted) {
      await job.terminate('cancelled', { durationMs: Date.now() - started });
      return;
    }
    const body = failureBody(err);
    if (!(err instanceof ApiError)) console.error(`[jobs] ${job.runId} failed:`, err?.stack || err?.message || err);
    await job.terminate('failed', { error: body.error, code: body.code, durationMs: Date.now() - started });
  }
}

/**
 * Records a run, answers immediately, and does `work` in the background.
 *
 * work({ emit, progress, signal, runId }) → result
 *   emit(event, data)  record a tool event (synchronous; writes are queued in order)
 *   progress(value)    record progress and keep it on the run row
 *   signal             aborted when the run is cancelled — check it between steps
 *
 * Throws (before anything starts) a 503 when there is no database to record
 * the run in. Returns the run summary for a 202 body.
 */
async function startJob(req, { toolId, action = 'run', label = null, input = null, work }) {
  if (typeof work !== 'function') throw new TypeError('startJob needs a work function');
  if (!db.isDatabaseConfigured()) {
    throw notConfigured('Running this needs the database configured (DATABASE_URL).');
  }
  const identity = await resolveIdentity(req);
  const runId = await runStore.startRun({
    userId: identity.userId,
    workspaceId: identity.workspaceId,
    actorEmail: identity.actorEmail || req.user?.username || null,
    toolId,
    action,
    label,
    input,
    method: req.method,
    path: String(req.originalUrl || '').split('?')[0],
  });
  if (!runId) throw notConfigured('The run could not be recorded, so it was not started.', 'run_not_recorded');

  await db.query('update tool_runs set is_job = true, heartbeat_at = now() where id = $1', [runId]);

  const job = createJob(runId, identity.userId || null);
  active.set(runId, job);
  setImmediate(() => { execute(job, work); });

  return { id: runId, status: 'running', toolId, action, label: label ? String(label).slice(0, 300) : null };
}

function cancelActive(job) {
  job.controller.abort();
  // Answer the cancel now rather than when the pipeline next looks at its
  // signal; anything it reports afterwards is dropped.
  job.terminate('cancelled');
}

/**
 * Cancels a run. Returns 'cancelled' when it was running in this process,
 * 'requested' when another process (or none) holds it, 'finished' when it had
 * already ended.
 */
async function cancelJob(runId) {
  const job = active.get(runId);
  if (job) {
    cancelActive(job);
    await job.flush();
    return 'cancelled';
  }
  const row = await db.maybeOne(
    `update tool_runs set cancel_requested_at = now()
      where id = $1 and status = 'running'
      returning id, is_job`,
    [runId],
  );
  return row ? 'requested' : 'finished';
}

/** Events after `afterId`, oldest first. */
async function eventsAfter(runId, afterId = 0, limit = 500) {
  return db.rows(
    `select id, event, data from tool_run_events
      where run_id = $1 and id > $2
      order by id
      limit $3`,
    [runId, afterId, limit],
  );
}

async function runStatus(runId) {
  const row = await db.maybeOne('select status from tool_runs where id = $1', [runId]);
  return row ? row.status : null;
}

/** The value the job returned (its last `result` event), or undefined. */
async function latestResult(runId) {
  const row = await db.maybeOne(
    `select data from tool_run_events
      where run_id = $1 and event = 'result'
      order by id desc limit 1`,
    [runId],
  );
  return row ? row.data : undefined;
}

/**
 * Fails every running job whose heartbeat stopped (its process died) and that
 * is not running here, writing the same terminal events a failure would.
 */
async function sweepInterrupted({ staleMs = STALE_MS } = {}) {
  if (!db.isDatabaseConfigured()) return 0;
  try {
    const swept = await db.rows(
      `update tool_runs
          set status = 'failed',
              error = $3,
              completed_at = now(),
              updated_at = now()
        where is_job
          and status = 'running'
          and coalesce(heartbeat_at, created_at) < now() - make_interval(secs => $1)
          and not (id = any($2::uuid[]))
        returning id`,
      [staleMs / 1000, [...active.keys()], INTERRUPTED],
    );
    for (const { id } of swept) {
      await db.query(
        `insert into tool_run_events (run_id, event, data) values
           ($1, 'error',  $2::jsonb),
           ($1, 'status', $3::jsonb)`,
        [
          id,
          JSON.stringify({ error: INTERRUPTED, code: 'interrupted' }),
          JSON.stringify({ status: 'failed', code: 'interrupted', error: INTERRUPTED }),
        ],
      );
    }
    return swept.length;
  } catch (e) {
    console.error('[jobs] interrupted-job sweep failed:', e.message);
    return 0;
  }
}

/** Drops replay events of runs that ended more than `days` ago; the run row stays. */
async function pruneEvents({ days = 30 } = {}) {
  if (!db.isDatabaseConfigured()) return 0;
  try {
    const n = await db.count(
      `with gone as (
         delete from tool_run_events e
          using tool_runs r
          where e.run_id = r.id
            and r.status <> 'running'
            and r.completed_at < now() - make_interval(days => $1)
          returning 1)
       select count(*) from gone`,
      [days],
    );
    return n;
  } catch (e) {
    console.error('[jobs] event prune failed:', e.message);
    return 0;
  }
}

module.exports = {
  startJob,
  cancelJob,
  eventsAfter,
  runStatus,
  latestResult,
  sweepInterrupted,
  pruneEvents,
  TERMINAL,
  // For tests.
  _active: active,
  GENERIC_FAILURE,
  INTERRUPTED,
};
