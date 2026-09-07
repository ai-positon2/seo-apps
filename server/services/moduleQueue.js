// ── The module run queue ────────────────────────────────────────────────────
//
// Claim / heartbeat / reap, over `project_module_runs` (0019).
//
// This mirrors `modules/crawlScope/db/repo.js` deliberately rather than
// inventing a second mechanism. Three properties are load-bearing, and each is
// the kind of thing that looks like an implementation detail right up until it
// silently loses work:
//
//   1. The claim is a compare-and-swap on `status`, not a read-then-write. Two
//      workers reading the same queued row is fine; both then UPDATE it scoped
//      to `status = 'queued'`, and Postgres serialises that — exactly one gets a
//      row back. A read-then-write would let both run the same captures and bill
//      the client twice.
//
//   2. A run cannot report its own crash, so liveness is inverted: the worker
//      stamps `heartbeat_at` while it works, and its ABSENCE past a threshold is
//      what the reaper acts on.
//
//   3. `attempts` is bounded. Requeueing for ever means one poison job can
//      occupy a worker permanently, and the symptom is "the queue is busy but
//      nothing finishes" — which is much harder to diagnose than a failed run.

const { getSupabase, isSupabaseConfigured } = require('./supabase');

// How long a run may go without stamping a heartbeat before it is presumed
// dead. Generous, because an AI Visibility capture can legitimately take 110
// seconds and a worker stamps between captures, not during one.
const STALE_AFTER_MS = Number(process.env.MODULE_QUEUE_STALE_MS) || 10 * 60 * 1000;

// A run is retried this many times before it is failed for good.
const MAX_ATTEMPTS = Number(process.env.MODULE_QUEUE_MAX_ATTEMPTS) || 3;

// The claimer walks a small window rather than only the single oldest row.
// Losing one CAS should cost another round trip, not a whole poll interval of
// idleness while queued work sits there.
const CLAIM_CANDIDATES = Number(process.env.MODULE_QUEUE_CANDIDATES) || 5;

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
  return /column .* does not exist|relation .* does not exist|schema cache|Could not find/i
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
  if (!isSupabaseConfigured()) throw new Error('Supabase is not configured.');

  const { data, error } = await getSupabase()
    .from('project_module_runs')
    .insert({
      project_id: projectId,
      workspace_id: workspaceId,
      module_key: moduleKey,
      status: 'queued',
      trigger,
      scheduled_for: scheduledFor,
      target_url: targetUrl,
      country_code: countryCode,
      created_by: createdBy,
      attempts: 0,
    })
    .select(RUN_COLUMNS)
    .maybeSingle();

  if (error) fail('enqueue', error);
  return data;
}

/**
 * Claim the oldest eligible queued run, atomically.
 *
 * The `.eq('status', 'queued')` on the UPDATE is the whole mechanism: it is what
 * makes two workers racing produce one winner and one `null`, rather than two
 * workers running the same job.
 *
 * @param {object} input
 * @param {string} input.workerId
 * @param {string[]} [input.moduleKeys] restrict to modules this worker can run
 */
async function claimNext({ workerId, moduleKeys = null } = {}) {
  if (!isSupabaseConfigured()) return null;
  const db = getSupabase();
  const nowIso = new Date().toISOString();

  let q = db
    .from('project_module_runs')
    .select('id, attempts')
    .eq('status', 'queued')
    // `scheduled_for` in the future is not yet eligible. `is null` means "as
    // soon as possible" and must still be claimable, which `.or` covers —
    // a plain `.lte` would silently never claim an unscheduled run.
    .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
    .order('scheduled_for', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(CLAIM_CANDIDATES);

  if (moduleKeys?.length) q = q.in('module_key', moduleKeys);

  const { data: candidates, error } = await q;
  if (error) {
    if (isMissingSchema(error)) { warnMissingSchemaOnce('claimNext', error); return null; }
    fail('claimNext', error);
  }

  for (const candidate of candidates || []) {
    const { data: claimed, error: claimError } = await db
      .from('project_module_runs')
      .update({
        status: 'running',
        worker_id: workerId || null,
        claimed_at: nowIso,
        heartbeat_at: nowIso,
        started_at: nowIso,
        attempts: (candidate.attempts || 0) + 1,
      })
      .eq('id', candidate.id)
      // The CAS. Lose this and another worker got there first.
      .eq('status', 'queued')
      .select(RUN_COLUMNS)
      .maybeSingle();

    if (claimError) fail('claimNext', claimError);
    if (claimed) return claimed;
  }
  return null;
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
  if (!isSupabaseConfigured()) return false;
  const { data, error } = await getSupabase()
    .from('project_module_runs')
    .update({ heartbeat_at: new Date().toISOString() })
    .eq('id', runId)
    .eq('status', 'running')
    .eq('worker_id', workerId)
    .select('id')
    .maybeSingle();
  if (error) fail('heartbeat', error);
  return Boolean(data);
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
  if (!isSupabaseConfigured()) return [];
  const db = getSupabase();
  const threshold = new Date(Date.now() - staleAfterMs).toISOString();

  const [quiet, never] = await Promise.all([
    db.from('project_module_runs').select(RUN_COLUMNS)
      .eq('status', 'running').lt('heartbeat_at', threshold)
      .order('heartbeat_at', { ascending: true }).limit(limit),
    // Only rows the QUEUE owns. claimNext() always stamps both worker_id and
    // heartbeat_at when it moves a run to 'running', so a queue-owned run can
    // never sit here with a null heartbeat -- but an INLINE run can, because
    // moduleEvidence.startRun() inserts status:'running' with neither field set.
    //
    // Without this filter every inline run was reclaimed at the flat 10-minute
    // STALE_AFTER_MS, regardless of the deadline it recorded for itself: a
    // healthy 10-page SEO & GEO audit takes ~22 minutes, so "Run Full Audit" was
    // silently flipped back to 'queued' mid-flight and then re-run by the worker.
    // Inline runs are swept by moduleEvidence.sweepStaleRuns(), which judges each
    // row against its own payload.deadlineAt -- the allowance model this table
    // was designed around.
    db.from('project_module_runs').select(RUN_COLUMNS)
      .eq('status', 'running').is('heartbeat_at', null)
      .not('worker_id', 'is', null)
      .lt('started_at', threshold)
      .order('started_at', { ascending: true }).limit(limit),
  ]);

  for (const res of [quiet, never]) {
    if (res.error) {
      if (isMissingSchema(res.error)) { warnMissingSchemaOnce('findStale', res.error); return []; }
      fail('findStale', res.error);
    }
  }

  const seen = new Set();
  return [...(quiet.data || []), ...(never.data || [])]
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .slice(0, limit);
}

/**
 * Requeue a dead run, or fail it if it has burned its attempts.
 *
 * The write is guarded on exactly the heartbeat we observed, so a revived
 * worker or a second replica's reaper cannot act on the same row twice.
 * `.eq(col, null)` never matches in PostgREST, so the NULL case needs `.is`.
 *
 * @returns {'requeued'|'failed'|'skipped'}
 */
async function reclaim(run, { maxAttempts = MAX_ATTEMPTS } = {}) {
  if (!isSupabaseConfigured()) return 'skipped';
  const db = getSupabase();
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

  let q = db.from('project_module_runs').update(patch)
    .eq('id', run.id)
    .eq('status', 'running');
  q = run.heartbeat_at ? q.eq('heartbeat_at', run.heartbeat_at) : q.is('heartbeat_at', null);

  const { data, error } = await q.select('id').maybeSingle();
  if (error) fail('reclaim', error);
  if (!data) return 'skipped';
  return exhausted ? 'failed' : 'requeued';
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
  if (!isSupabaseConfigured()) return { queued: 0, running: 0 };
  const db = getSupabase();
  const count = async (status) => {
    let q = db.from('project_module_runs').select('id', { count: 'exact', head: true }).eq('status', status);
    if (moduleKey) q = q.eq('module_key', moduleKey);
    const { count: n, error } = await q;
    if (error) fail('depth', error);
    return n || 0;
  };
  const [queued, running] = await Promise.all([count('queued'), count('running')]);
  return { queued, running };
}

module.exports = {
  isMissingSchema,
  STALE_AFTER_MS,
  MAX_ATTEMPTS,
  CLAIM_CANDIDATES,
  enqueue,
  claimNext,
  heartbeat,
  findStale,
  reclaim,
  reap,
  depth,
};
