// ── The module run queue ────────────────────────────────────────────────────
//
// Claim / heartbeat / reap, over `project_module_runs` (0019).
//
// This mirrors `modules/crawlScope/db/repo.js` deliberately rather than
// inventing a second mechanism. Three properties are load-bearing, and each is
// the kind of thing that looks like an implementation detail right up until it
// silently loses work:
//
//   1. The claim is atomic. Exactly one worker may move a queued row to
//      'running'; two workers racing must produce one winner and one `null`,
//      never two workers running the same job and billing the client twice.
//
//   2. A run cannot report its own crash, so liveness is inverted: the worker
//      stamps `heartbeat_at` while it works, and its ABSENCE past a threshold is
//      what the reaper acts on.
//
//   3. `attempts` is bounded. Requeueing for ever means one poison job can
//      occupy a worker permanently, and the symptom is "the queue is busy but
//      nothing finishes" — which is much harder to diagnose than a failed run.
//
// On (1): over PostgREST this had to be a read-then-compare-and-swap — select a
// window of candidates, then UPDATE each one scoped to `status = 'queued'` until
// one came back. That was correct but lossy: every worker that lost a race
// burned a round trip, and `attempts` was computed in JS from the row it had
// read, so two writers could both derive the same next value. Speaking SQL
// directly, the whole claim is one statement — the row is picked with
// `for update skip locked`, which makes concurrent claimers walk past a locked
// candidate instead of colliding with it, and `attempts` is incremented by the
// database from its own current value.

const db = require('./db');

// How long a run may go without stamping a heartbeat before it is presumed
// dead. Generous, because an AI Visibility capture can legitimately take 110
// seconds and a worker stamps between captures, not during one.
const STALE_AFTER_MS = Number(process.env.MODULE_QUEUE_STALE_MS) || 10 * 60 * 1000;

// A run is retried this many times before it is failed for good.
const MAX_ATTEMPTS = Number(process.env.MODULE_QUEUE_MAX_ATTEMPTS) || 3;

const RUN_COLUMNS = 'id, project_id, workspace_id, module_key, status, trigger, '
  + 'target_url, country_code, attempts, worker_id, heartbeat_at, scheduled_for, '
  + 'claimed_at, started_at, created_at, created_by';

function fail(op, error) {
  throw new Error(`[moduleQueue.${op}] ${error.message || error}`);
}

/**
 * True when the error is "0019 has not been applied yet".
 *
 * The worker polls every few seconds, so a pending migration would otherwise
 * write the same error to the log several times a minute for as long as it
 * takes someone to run it. The queue is simply empty until the columns exist,
 * and that is the honest reading — but it has to be said ONCE, not forever.
 */
function isMissingSchema(error) {
  // 42703 undefined_column, 42P01 undefined_table.
  if (error?.code === '42703' || error?.code === '42P01') return true;
  return /column .* does not exist|relation .* does not exist/i
    .test(error?.message || '');
}

let warnedMissingSchema = false;
function warnMissingSchemaOnce(op, error) {
  if (warnedMissingSchema) return;
  warnedMissingSchema = true;
  console.warn(`[moduleQueue.${op}] Queue columns are missing — apply `
    + `supabase/migrations/0019_module_run_queue.sql. Nothing will be claimed until then. `
    + `(${error.message})`);
}

/**
 * Put work on the queue.
 *
 * Returns the run row. `scheduledFor` in the future means the claimer will not
 * touch it until then — which is how the scheduler enqueues tomorrow's work
 * today, and how `staggerMinute` spreads a herd of clients across an hour.
 */
async function enqueue({
  projectId, workspaceId = null, moduleKey, trigger = 'schedule',
  scheduledFor = null, createdBy = null, targetUrl = null, countryCode = null,
}) {
  if (!db.isDatabaseConfigured()) throw new Error('The database is not configured.');

  try {
    return await db.maybeOne(
      `insert into project_module_runs
         (project_id, workspace_id, module_key, status, trigger,
          scheduled_for, target_url, country_code, created_by, attempts)
       values ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, 0)
       returning ${RUN_COLUMNS}`,
      [projectId, workspaceId, moduleKey, trigger, scheduledFor, targetUrl, countryCode, createdBy]
    );
  } catch (error) {
    fail('enqueue', error);
  }
}

/**
 * Claim the oldest eligible queued run, atomically.
 *
 * One statement: the inner select picks the next eligible row and locks it with
 * `skip locked`, so a concurrent claimer steps over it rather than blocking on
 * it or claiming it twice; the outer update is what actually takes ownership.
 * `status = 'queued'` is still asserted on the update, so a row that changed
 * state between the two cannot be claimed.
 *
 * @param {object} input
 * @param {string} input.workerId
 * @param {string[]} [input.moduleKeys] restrict to modules this worker can run
 */
async function claimNext({ workerId, moduleKeys = null } = {}) {
  if (!db.isDatabaseConfigured()) return null;
  const nowIso = new Date().toISOString();

  // `scheduled_for` in the future is not yet eligible; NULL means "as soon as
  // possible" and must still be claimable, so it is tested for explicitly —
  // a bare `scheduled_for <= now` is NULL for those rows and never claims one.
  const params = [nowIso, workerId || null];
  let moduleFilter = '';
  if (moduleKeys?.length) {
    params.push(moduleKeys);
    moduleFilter = ` and module_key = any($${params.length})`;
  }

  try {
    return await db.maybeOne(
      `update project_module_runs r
          set status = 'running',
              worker_id = $2,
              claimed_at = $1,
              heartbeat_at = $1,
              started_at = $1,
              attempts = coalesce(r.attempts, 0) + 1
        where r.id = (
          select id from project_module_runs
           where status = 'queued'
             and (scheduled_for is null or scheduled_for <= $1)${moduleFilter}
           order by scheduled_for asc nulls first, created_at asc
           for update skip locked
           limit 1
        )
          and r.status = 'queued'
        returning ${RUN_COLUMNS}`,
      params
    );
  } catch (error) {
    if (isMissingSchema(error)) { warnMissingSchemaOnce('claimNext', error); return null; }
    fail('claimNext', error);
  }
}

/**
 * Stamp liveness.
 *
 * Scoped to `status = 'running'` so a worker that has already been reaped
 * cannot resurrect its claim by heartbeating a row someone else now owns.
 * Returns false when the row is no longer ours, which the caller should treat
 * as "stop working".
 */
async function heartbeat(runId, workerId) {
  if (!db.isDatabaseConfigured()) return false;
  try {
    const row = await db.maybeOne(
      `update project_module_runs set heartbeat_at = $1
        where id = $2 and status = 'running' and worker_id = $3
        returning id`,
      [new Date().toISOString(), runId, workerId]
    );
    return Boolean(row);
  } catch (error) {
    fail('heartbeat', error);
  }
}

/**
 * Runs that claim to be executing but have stopped stamping heartbeats.
 *
 * Two arms, and the second is the one that is easy to omit: in SQL,
 * `heartbeat_at < threshold` evaluates to NULL when the column is NULL, and
 * NULL is not true. A row set running without ever stamping a heartbeat — by an
 * older code path, or by a worker that died between claiming and its first
 * stamp — would be permanently invisible to a reaper that only compared
 * timestamps. It has to be tested for separately.
 */
async function findStale({ staleAfterMs = STALE_AFTER_MS, limit = 20 } = {}) {
  if (!db.isDatabaseConfigured()) return [];
  const threshold = new Date(Date.now() - staleAfterMs).toISOString();

  // The second arm is restricted to rows the QUEUE owns. claimNext() always
  // stamps both worker_id and heartbeat_at when it moves a run to 'running', so
  // a queue-owned run can never sit here with a null heartbeat -- but an INLINE
  // run can, because moduleEvidence.startRun() inserts status:'running' with
  // neither field set.
  //
  // Without that filter every inline run was reclaimed at the flat 10-minute
  // STALE_AFTER_MS, regardless of the deadline it recorded for itself: a
  // healthy 10-page SEO & GEO audit takes ~22 minutes, so "Run Full Audit" was
  // silently flipped back to 'queued' mid-flight and then re-run by the worker.
  // Inline runs are swept by moduleEvidence.sweepStaleRuns(), which judges each
  // row against its own payload.deadlineAt -- the allowance model this table
  // was designed around.
  try {
    return await db.rows(
      `select ${RUN_COLUMNS}
         from project_module_runs
        where status = 'running'
          and (
            heartbeat_at < $1
            or (heartbeat_at is null and worker_id is not null and started_at < $1)
          )
        order by coalesce(heartbeat_at, started_at) asc
        limit $2`,
      [threshold, limit]
    );
  } catch (error) {
    if (isMissingSchema(error)) { warnMissingSchemaOnce('findStale', error); return []; }
    fail('findStale', error);
  }
}

/**
 * Requeue a dead run, or fail it if it has burned its attempts.
 *
 * The write is guarded on exactly the heartbeat we observed, so a revived
 * worker or a second replica's reaper cannot act on the same row twice.
 * `is not distinct from` makes that guard work for a NULL heartbeat too, where
 * `=` would never match.
 *
 * @returns {'requeued'|'failed'|'skipped'}
 */
async function reclaim(run, { maxAttempts = MAX_ATTEMPTS } = {}) {
  if (!db.isDatabaseConfigured()) return 'skipped';
  const exhausted = (run.attempts || 0) >= maxAttempts;

  const patch = exhausted
    ? {
      status: 'failed',
      error: `Worker stopped responding after ${run.attempts} attempt(s). `
        + 'The run was reclaimed rather than left holding a slot.',
      finished_at: new Date().toISOString(),
      worker_id: null,
      heartbeat_at: null,
    }
    : {
      status: 'queued',
      worker_id: null,
      heartbeat_at: null,
      claimed_at: null,
      // Clear the terminal fields from the dead attempt, or a queued run
      // carries the previous attempt's error and finish time.
      //
      // `started_at` is deliberately NOT cleared: it is NOT NULL in 0012, so
      // nulling it makes every requeue fail on the constraint — which would
      // mean the reaper could never recover a dead run at all. It is stale
      // until the next claim, and `claimNext` always overwrites it, so the
      // window where it is wrong is the window where nothing is reading it.
      finished_at: null,
      error: null,
    };

  const cols = Object.keys(patch);
  const params = cols.map((c) => patch[c]);
  params.push(run.id, run.heartbeat_at ?? null);
  const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');

  try {
    const row = await db.maybeOne(
      `update project_module_runs set ${sets}
        where id = $${cols.length + 1}
          and status = 'running'
          and heartbeat_at is not distinct from $${cols.length + 2}
        returning id`,
      params
    );
    if (!row) return 'skipped';
    return exhausted ? 'failed' : 'requeued';
  } catch (error) {
    fail('reclaim', error);
  }
}

/** One reaper sweep. Safe to run on every replica — the guard makes it idempotent. */
async function reap(options = {}) {
  const stale = await findStale(options);
  const result = { found: stale.length, requeued: 0, failed: 0, skipped: 0 };
  for (const run of stale) {
    const outcome = await reclaim(run, options);
    result[outcome] += 1;
  }
  return result;
}

/** Queue depth, for the operator view and for deciding whether to scale. */
async function depth({ moduleKey = null } = {}) {
  if (!db.isDatabaseConfigured()) return { queued: 0, running: 0 };
  try {
    // Both counts in one pass — two round trips for two numbers off the same
    // filtered set was only ever a PostgREST limitation.
    const row = await db.one(
      `select
         count(*) filter (where status = 'queued')  as queued,
         count(*) filter (where status = 'running') as running
         from project_module_runs
        where $1::text is null or module_key = $1`,
      [moduleKey]
    );
    return { queued: Number(row.queued || 0), running: Number(row.running || 0) };
  } catch (error) {
    fail('depth', error);
  }
}

module.exports = {
  isMissingSchema,
  STALE_AFTER_MS,
  MAX_ATTEMPTS,
  enqueue,
  claimNext,
  heartbeat,
  findStale,
  reclaim,
  reap,
  depth,
};
