// Data-access layer. Every function takes the database handle as its first
// argument. In the standalone CrawlScope app that was sometimes a user-scoped
// Supabase client with RLS enforced; here it is always the app's Postgres pool,
// because identity in this app is our own signed JWT over `app_users` and there
// was never a Supabase Auth session for RLS to key off (see ./client.js). The
// argument is kept so a caller can hand in a transaction-scoped handle instead.
//
// Ownership note — load-bearing: with RLS out of the picture, the explicit
// `owner` filter in these functions IS the tenancy boundary. Anything reachable
// from an HTTP route must pass `owner`; the `owner = null` defaults exist for
// the worker, which legitimately operates across users. If you add a route,
// pass the owner.
//
// Tables carry a `crawl_` prefix in this app (crawl_projects, crawl_runs,
// crawl_run_results, crawl_run_findings) so they don't collide conceptually
// with the app's own `tool_runs` / `user_profiles`. See
// supabase/migrations/0010_crawlscope.sql.

const { json } = require("../../../services/db");

// jsonb columns per table. Needed because node-postgres encodes a JS array as a
// POSTGRES ARRAY literal, not as JSON — so an array bound to a jsonb column
// fails outright, while `crawl_projects.recipients` (a real text[]) must keep
// being passed as an array. The distinction is a property of the column, so it
// is written down per table rather than guessed from the value.
const JSONB_COLUMNS = {
  crawl_projects: new Set(["options", "settings"]),
  crawl_runs: new Set(["options", "progress", "summary", "checkpoint", "site_diagnostics"]),
  crawl_run_results: new Set(["data"]),
  crawl_run_findings: new Set(["detail"]),
  crawl_run_finding_instances: new Set(["data"]),
};

function encode(table, column, value) {
  return JSONB_COLUMNS[table]?.has(column) ? json(value) : value;
}

// Builds `col = $n, col = $n` for a patch object, appending to `params`.
// Column names come from module code, never from a request body, and anything
// that is not a plain identifier is rejected rather than interpolated.
function setClause(table, patch, params) {
  const cols = Object.keys(patch);
  if (!cols.length) throw new Error(`[repo] empty patch for ${table}`);
  return cols
    .map((c) => {
      if (!/^[a-z_][a-z0-9_]*$/i.test(c)) throw new Error(`[repo] unsafe column: ${c}`);
      params.push(encode(table, c, patch[c]));
      return `"${c}" = $${params.length}`;
    })
    .join(", ");
}

// Compare-and-swap helpers return the updated row or null, because zero matched
// rows is the normal "another worker won the race" outcome rather than an error.
function firstRow(rows) {
  return (Array.isArray(rows) ? rows[0] : rows) || null;
}

// ---- projects -------------------------------------------------------------

async function listProjects(client, owner) {
  return client.rows(
    `select * from crawl_projects where owner = $1 order by created_at desc`,
    [owner],
  );
}

// `owner` is optional so the worker (which has no request user) can read any project,
// while every HTTP path passes it and gets explicit tenant scoping.
async function getProject(client, id, owner = null) {
  const params = [id];
  let scope = "";
  if (owner) {
    params.push(owner);
    scope = ` and owner = $${params.length}`;
  }
  return client.maybeOne(
    `select * from crawl_projects where id = $1${scope}`,
    params,
  );
}

async function createProject(client, owner, data) {
  return client.one(
    `insert into crawl_projects
       (owner, workspace_id, name, url, options, cron, timezone, recipients, enabled, next_run_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [
      owner,
      // Recorded, not used for access control — see 0010_crawlscope.sql.
      data.workspace_id || null,
      data.name || null,
      data.url,
      json(data.options || {}),
      data.cron,
      data.timezone,
      data.recipients || [],
      data.enabled !== false,
      data.next_run_at || null,
    ],
  );
}

async function updateProject(client, id, patch, owner = null) {
  const params = [];
  const sets = setClause("crawl_projects", patch, params);
  params.push(id);
  let scope = "";
  const idPos = params.length;
  if (owner) {
    params.push(owner);
    scope = ` and owner = $${params.length}`;
  }
  return firstRow(
    await client.rows(
      `update crawl_projects set ${sets} where id = $${idPos}${scope} returning *`,
      params,
    ),
  );
}

// deleteProject was removed deliberately, not moved.
//
// It was a permanent DELETE on crawl_projects gated only by the optional `owner`
// column, and it had exactly one caller — DELETE /api/crawl-scope/projects/:id —
// which now performs the governed soft delete via modules/projects/store instead
// (see the note on that route). Destroying a project row directly skips the
// capability check, the audit event, the soft-delete precondition, the
// confirm-the-name step, and PROJECT_PURGE_ORDER's crawl_runs-first ordering,
// which 0010 requires because crawl_runs.project_id is ON DELETE SET NULL rather
// than a cascade. Keeping the primitive around exported would just invite that
// bypass to be reintroduced by the next caller who wanted a one-line delete.
//
// Permanent destruction lives in modules/projects/store.purgeProject().

// Enabled projects whose next_run_at is due (service client only).
// Ordered so the most overdue fires first, and bounded so one tick cannot pull the
// entire table into memory.
async function dueProjects(client, nowIso, { limit = 50 } = {}) {
  return client.rows(
    `select * from crawl_projects
      where enabled = true and next_run_at is not null and next_run_at <= $1
      order by next_run_at asc
      limit $2`,
    [nowIso, limit],
  );
}

// Enabled projects with next_run_at IS NULL. SQL NULL comparison means dueProjects can
// never see these, so without a repair pass they sleep forever.
async function dormantProjects(client, { limit = 50 } = {}) {
  return client.rows(
    `select id, cron, timezone from crawl_projects
      where enabled = true and next_run_at is null
      limit $1`,
    [limit],
  );
}

// Advance a project's fire slot, but only if it still holds `expectedIso`. Two worker
// replicas ticking the same due project therefore cannot both advance it.
async function advanceProjectFrom(client, id, expectedIso, patch) {
  const params = [];
  const sets = setClause("crawl_projects", patch, params);
  params.push(id, expectedIso);
  return firstRow(
    await client.rows(
      `update crawl_projects set ${sets}
        where id = $${params.length - 1} and enabled = true and next_run_at = $${params.length}
        returning *`,
      params,
    ),
  );
}

async function repairProjectNextRun(client, id, nextIso) {
  return firstRow(
    await client.rows(
      `update crawl_projects set next_run_at = $1
        where id = $2 and enabled = true and next_run_at is null
        returning *`,
      [nextIso, id],
    ),
  );
}

// ---- runs -----------------------------------------------------------------

async function createRun(client, run) {
  return client.one(
    `insert into crawl_runs
       (owner, workspace_id, project_id, scheduled_for, url, options, status, trigger)
     values ($1, $2, $3, $4, $5, $6, 'queued', $7)
     returning *`,
    [
      run.owner,
      run.workspace_id || null,
      run.project_id || null,
      run.scheduled_for || null,
      run.url,
      json(run.options || {}),
      run.trigger || "manual",
    ],
  );
}

// Idempotent enqueue for one (project, fire slot) pair, guarded by the
// runs_project_slot_uniq constraint. Returns null when the slot was already taken,
// which is how two replicas racing the same tick converge on a single crawl and a
// single client email.
//
// 23505 (unique_violation) is the one error here that means "success, someone else
// got there first" rather than a failure, so it is inspected rather than rethrown.
async function enqueueScheduledRun(client, run) {
  try {
    return await client.one(
      `insert into crawl_runs
         (owner, workspace_id, project_id, scheduled_for, url, options, status, trigger)
       values ($1, $2, $3, $4, $5, $6, 'queued', $7)
       returning *`,
      [
        run.owner,
        run.workspace_id || null,
        run.project_id,
        run.scheduled_for,
        run.url,
        json(run.options || {}),
        run.trigger || "schedule",
      ],
    );
  } catch (error) {
    if (error.code === "23505") return null;
    throw error;
  }
}

// ── Viewer scope ────────────────────────────────────────────────────────────
//
// A crawl run is readable by the WORKSPACE it belongs to, not by whoever happened
// to click Start.
//
// Every read in this file used `owner = <caller>`, which made the module
// single-user in a way nothing announced: a teammate could see a project through
// /api/projects, open it, and get "Run not found" on its crawl. `workspace_id`
// was written on every row and never once read back.
//
// The rule, and the null branch is the part worth being careful about:
//
//   workspace_id set   — visible to members of that workspace
//   workspace_id null  — visible only to the user who created it
//
// Null means "written before workspaces existed". Reading null as "belongs to
// everybody" would hand every legacy crawl to the whole deployment, so it stays
// with its creator instead.
//
// This is the same shape as runStore.getRun(id, workspaceIds), which is how the
// rest of the app has always scoped tool runs — CrawlScope was the outlier.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `viewer` may read a row carrying `owner` + `workspace_id`. */
function canViewRow(row, viewer) {
  if (!row || !viewer) return false;
  if (row.workspace_id) return (viewer.workspaceIds || []).includes(row.workspace_id);
  return Boolean(viewer.userId) && row.owner === viewer.userId;
}

/**
 * The same rule as a WHERE clause, for list reads that cannot fetch first and
 * authorize after.
 *
 * Ids are bound as parameters, so no identifier reaches the query as text. They
 * are still format-checked first: a viewer whose only ids are malformed must
 * come back with NO rows, and dropping them here is what turns that into an
 * empty scope rather than a clause that matches nothing by accident.
 *
 * Returns null when the viewer has no usable identity at all. Callers MUST treat
 * that as "no rows" — never as "no filter", which would read the whole table.
 *
 * @returns {{ sql: string, params: any[] } | null}
 */
function viewerScope(viewer) {
  const ids = (viewer?.workspaceIds || []).filter((id) => UUID_RE.test(String(id)));
  const userId = UUID_RE.test(String(viewer?.userId)) ? viewer.userId : null;

  const clauses = [];
  const params = [];
  if (ids.length) {
    params.push(ids);
    clauses.push(`workspace_id = any($${params.length})`);
  }
  if (userId) {
    params.push(userId);
    clauses.push(`(workspace_id is null and owner = $${params.length})`);
  }
  if (!clauses.length) return null;
  return { sql: `(${clauses.join(" or ")})`, params };
}

/** One run, if this viewer may see it. Null when it does not exist OR is theirs
 *  to not see — the route answers 404 for both, per the house rule that a
 *  cross-workspace read must not confirm the row exists. */
async function getRunForViewer(client, id, viewer) {
  const row = await client.maybeOne(`select * from crawl_runs where id = $1`, [id]);
  return canViewRow(row, viewer) ? row : null;
}

// workspace_id and owner ride along so a returned row can be checked against
// the scope that produced it. Still no `summary`, which carries every finding
// and reaches tens of megabytes on a large crawl — only summary->'counts'.
const RUN_LIST_COLUMNS =
  `id, url, status, trigger, project_id, workspace_id, owner, scheduled_for,
   created_at, started_at, finished_at, report_path, summary->'counts' as counts`;

async function listRunsForViewer(client, viewer, { limit = 50, projectId = null } = {}) {
  const scope = viewerScope(viewer);
  if (!scope) return [];
  const params = [...scope.params];
  let narrow = "";
  if (projectId) {
    params.push(projectId);
    narrow = ` and project_id = $${params.length}`;
  }
  params.push(limit);
  return client.rows(
    `select ${RUN_LIST_COLUMNS} from crawl_runs
      where ${scope.sql}${narrow}
      order by created_at desc
      limit $${params.length}`,
    params,
  );
}

// "Deleted" in this product is a soft delete: modules/projects flips
// crawl_projects.lifecycle_status to 'deleted' and leaves the row in place so it
// can be restored. CrawlScope read none of that, so a project deleted from the
// projects UI kept appearing in the CrawlScope list and stayed crawlable.
// lifecycle_status is NOT NULL DEFAULT 'active' (0011), so a plain <> is safe
// here — no NULL rows to lose — and index 0011:364 covers exactly this predicate.
async function listProjectsForViewer(client, viewer) {
  const scope = viewerScope(viewer);
  if (!scope) return [];
  return client.rows(
    `select * from crawl_projects
      where ${scope.sql} and lifecycle_status <> 'deleted'
      order by created_at desc`,
    scope.params,
  );
}

async function getProjectForViewer(client, id, viewer) {
  const row = await client.maybeOne(`select * from crawl_projects where id = $1`, [id]);
  // A deleted project reads as absent, matching projectAccess.requireProject,
  // which answers notFound for it rather than confirming the id exists.
  if (!row || row.lifecycle_status === "deleted") return null;
  return canViewRow(row, viewer) ? row : null;
}

async function getRun(client, id, owner = null) {
  const params = [id];
  let scope = "";
  if (owner) {
    params.push(owner);
    scope = ` and owner = $${params.length}`;
  }
  return client.maybeOne(`select * from crawl_runs where id = $1${scope}`, params);
}

// Narrow select: the UI only reads summary.counts, while `summary` itself carries every
// finding and can reach tens of megabytes on a large crawl.
async function listRuns(client, owner, { limit = 50, projectId = null } = {}) {
  const params = [owner];
  let narrow = "";
  if (projectId) {
    params.push(projectId);
    narrow = ` and project_id = $${params.length}`;
  }
  params.push(limit);
  return client.rows(
    `select id, url, status, trigger, project_id, scheduled_for, created_at,
            started_at, finished_at, report_path, summary->'counts' as counts
       from crawl_runs
      where owner = $1${narrow}
      order by created_at desc
      limit $${params.length}`,
    params,
  );
}

// Claim the oldest queued run for execution, atomically. `triggers` limits which runs
// a caller will claim (the worker claims 'schedule' and 'initial' runs; plain 'manual'
// runs are executed in-process by the web service).
//
// One statement: the inner select locks the next eligible row with `skip locked`, so a
// second worker steps over it instead of colliding, and the outer update takes
// ownership. This replaces a candidate-window loop that existed only because PostgREST
// could not express row locking — every worker that lost a race there burned a round
// trip, and the claim still had to re-assert `status = 'queued'` to be safe.
async function claimNextQueuedRun(client, { triggers, trigger, workerId } = {}) {
  const wanted = triggers?.length ? triggers : trigger ? [trigger] : null;
  const nowIso = new Date().toISOString();
  const params = [nowIso, workerId || null];
  let narrow = "";
  if (wanted) {
    params.push(wanted);
    narrow = ` and trigger = any($${params.length})`;
  }
  return client.maybeOne(
    `update crawl_runs r
        set status = 'running', started_at = $1, heartbeat_at = $1, worker_id = $2
      where r.id = (
        select id from crawl_runs
         where status = 'queued'${narrow}
         order by created_at asc
         for update skip locked
         limit 1
      )
        and r.status = 'queued'
      returning *`,
    params,
  );
}

// ── The control channel (migration 0025) ───────────────────────────────────
//
// Pause/resume/stop reach the RunManager in the process that receives the
// request, and every project or scheduled crawl executes in the worker — so the
// web process records the request on the run and the worker collects it here.
//
// Two functions rather than one because the read is deliberately cheap: the poll
// is one narrow read of one primary-key row, and nothing is written unless a
// request is actually waiting.

/** The outstanding request for this run, or null. Two columns, one row. */
async function readControlRequest(client, id) {
  const row = await client.maybeOne(
    `select control_request from crawl_runs where id = $1`,
    [id],
  );
  return row?.control_request || null;
}

/**
 * Clears a request, but only if it is still the one that was read.
 *
 * Compare-and-clear, not a blind null: between the read above and this write
 * the web process may have recorded a NEWER request (a pause followed by a
 * stop), and clearing unconditionally would swallow it. Matching on the value
 * makes the update a no-op in that case, so the next poll picks the new one up.
 */
async function clearControlRequest(client, id, expected) {
  await client.query(
    `update crawl_runs set control_request = null, control_requested_at = null
      where id = $1 and control_request = $2`,
    [id, expected],
  );
}

async function updateRun(client, id, patch) {
  const params = [];
  const sets = setClause("crawl_runs", patch, params);
  params.push(id);
  return client.maybeOne(
    `update crawl_runs set ${sets} where id = $${params.length} returning *`,
    params,
  );
}

// Put a run back on the queue. Used when our own shutdown interrupted it, and by the
// reaper when a worker died holding it. Stale terminal fields from the dead attempt are
// cleared too, so a queued run doesn't report a duration or carry the old summary.
async function requeueRun(client, id, { attempts, keepCheckpoint = false } = {}) {
  const patch = {
    status: "queued",
    started_at: null,
    finished_at: null,
    heartbeat_at: null,
    worker_id: null,
    error: null,
    summary: null,
    progress: {},
  };
  // Cleared unless the caller is deliberately resuming: a queued run holding a
  // frontier nobody meant to reuse would silently skip most of the site.
  if (!keepCheckpoint) patch.checkpoint = null;
  if (attempts !== undefined) patch.attempts = attempts;
  return updateRun(client, id, patch);
}

// Just the frontier, never the whole row: a checkpoint for a large crawl is
// megabytes, and the callers that need it only need to know whether it is usable.
async function getRunCheckpoint(client, id) {
  const row = await client.maybeOne(
    `select checkpoint from crawl_runs where id = $1`,
    [id],
  );
  return row?.checkpoint || null;
}

// Runs that claim to be executing but whose worker has stopped stamping heartbeats.
//
// `paused` is included alongside `running`: a paused run keeps heart-beating, so a stale
// heartbeat there means the process died rather than that a user paused it. Excluding it
// would leave a run hard-killed while paused stuck forever.
//
// The NULL-heartbeat arm matters more than it looks. `heartbeat_at < x` evaluates to NULL
// (not true) when the column is NULL, so any row written before this column existed — or
// by a path that cleared it — would be invisible to the reaper permanently. `started_at`
// is the fallback liveness signal for those.
// `checkpoint` rides along because the reaper's decision — resume, or restart
// from the seed and drop the partial rows — depends on whether one exists.
const STALE_RUN_COLUMNS =
  "id, owner, project_id, url, status, trigger, attempts, worker_id, heartbeat_at, started_at, checkpoint";

async function staleRuns(client, staleBeforeIso, { limit = 20 } = {}) {
  // One query with both arms. It used to be two selects, because expressing this
  // through PostgREST's comma/dot `or=` grammar with an embedded ISO timestamp was
  // a parsing subtlety that could not be verified offline. In SQL the timestamp is
  // a bound parameter and the disjunction is unambiguous.
  return client.rows(
    `select ${STALE_RUN_COLUMNS}
       from crawl_runs
      where status in ('running', 'paused')
        and (
          heartbeat_at < $1
          or (heartbeat_at is null and started_at < $1)
        )
      order by coalesce(heartbeat_at, started_at) asc
      limit $2`,
    [staleBeforeIso, limit],
  );
}

// Guard a reaper write on exactly the row we observed, so a revived worker or a second
// replica's reaper cannot act on it twice. `is not distinct from` makes the guard hold
// for a NULL heartbeat too, where `=` would never match.
function observedRunGuard(run, params) {
  params.push(run.id, run.status, run.heartbeat_at ?? null);
  return `id = $${params.length - 2}
      and status = $${params.length - 1}
      and heartbeat_at is not distinct from $${params.length}`;
}

// `keepCheckpoint` decides whether the retry resumes or starts over. The
// checkpoint is cleared by default so a run reclaimed without one cannot later
// pick up a stale frontier.
async function reclaimStaleRun(client, run, attempts, { keepCheckpoint = false } = {}) {
  const patch = {
    status: "queued",
    started_at: null,
    finished_at: null,
    heartbeat_at: null,
    worker_id: null,
    error: null,
    summary: null,
    progress: {},
    attempts,
  };
  if (!keepCheckpoint) patch.checkpoint = null;

  const params = [];
  const sets = setClause("crawl_runs", patch, params);
  const guard = observedRunGuard(run, params);
  return firstRow(
    await client.rows(
      `update crawl_runs set ${sets} where ${guard} returning *`,
      params,
    ),
  );
}

async function failStaleRun(client, run, attempts, message) {
  const params = [];
  const sets = setClause("crawl_runs", {
    status: "failed",
    error: message,
    attempts,
    finished_at: new Date().toISOString(),
  }, params);
  const guard = observedRunGuard(run, params);
  return firstRow(
    await client.rows(
      `update crawl_runs set ${sets} where ${guard} returning *`,
      params,
    ),
  );
}

// Most recent completed run for a project before a given time (for deltas).
async function previousCompletedRun(client, projectId, beforeIso) {
  if (!projectId) return null;
  return client.maybeOne(
    `select id, summary, finished_at from crawl_runs
      where project_id = $1 and status = 'completed' and created_at < $2
      order by created_at desc
      limit 1`,
    [projectId, beforeIso],
  );
}

// ---- results / findings ---------------------------------------------------

async function insertResults(client, rows) {
  if (!rows.length) return;
  await client.insertMany("crawl_run_results", rows);
}

async function insertFindings(client, rows) {
  if (!rows.length) return;
  await client.insertMany("crawl_run_findings", rows);
}

// Full per-occurrence findings for one run (migration 0023) — chunked the
// same way insertRunLinksStreaming already handles a quarter million link
// edges, because the single-UPDATE alternative (embedding the whole array in
// crawl_runs.summary) is exactly what started timing out once crawls could
// reach 10,000 pages. `data` carries each finding object exactly as
// analyzer.js produced it, so every existing reader keeps working unchanged
// once it reads from this table instead of run.summary.findings.
const FINDING_INSTANCE_CHUNK = 1000;

async function insertRunFindingInstances(client, runId, owner, findings) {
  let written = 0;
  for (let i = 0; i < findings.length; i += FINDING_INSTANCE_CHUNK) {
    const chunk = findings.slice(i, i + FINDING_INSTANCE_CHUNK).map((f) => ({
      run_id: runId,
      owner,
      finding_id: f.id,
      rule_id: f.ruleId,
      data: f,
    }));
    await client.insertMany("crawl_run_finding_instances", chunk);
    written += chunk.length;
  }
  return written;
}

// The per-RULE rollup, which aggregateFindings() already writes on every
// completed run: one row per ruleId carrying a count. 18 rows for a crawl whose
// instance table holds 7,298.
//
// projects/overview.js has read this for a while; the crawlScope report did not,
// and instead pulled every instance over the wire to re-derive the same grouping
// in the browser — 2.0MB and 9.8s for a 500-page crawl. Nothing here is new
// aggregation; it is the same table, finally offered to the endpoint that needs
// it most.
async function listRunFindingRollup(client, runId) {
  return client.rows(
    `select rule_id, severity, category, count, detail
       from crawl_run_findings
      where run_id = $1
      order by count desc
      limit 200`,
    [runId],
  );
}

// One page of instances. The unpaged reader below holds every row in memory,
// then mergeReviews() maps a second full copy, then res.json() serialises a
// third — roughly 150MB transient for a 46,000-finding run, per concurrent
// caller. The 50,000 cap is what stands between a 10,000-page crawl and an OOM,
// so the answer at scale is to page rather than to raise it.
const INSTANCE_PAGE_MAX = 1_000;

async function listRunFindingInstancesPage(client, runId, { offset = 0, limit = INSTANCE_PAGE_MAX } = {}) {
  // The 1,000 ceiling used to be PostgREST's own max-rows limit on Supabase,
  // which returned a SHORT page rather than an error and broke any caller that
  // paged on "did I get what I asked for". Talking to Postgres directly there is
  // no transport ceiling at all — so this is now OUR cap, kept for the memory
  // reason in the comment above rather than inherited from the REST layer.
  //
  // The response still reports what was actually RETURNED, not what was
  // requested: a caller pages on `returned` and stops when it is zero.
  const size = Math.max(1, Math.min(Number(limit) || INSTANCE_PAGE_MAX, INSTANCE_PAGE_MAX));
  const from = Math.max(0, Number(offset) || 0);
  const rows = await client.rows(
    `select data from crawl_run_finding_instances
      where run_id = $1
      order by id asc
      limit $2 offset $3`,
    [runId, size, from],
  );
  return { rows: rows.map((r) => r.data), offset: from, limit: size, returned: rows.length };
}

// Fetches every stored finding instance for a run, reconstructed to the exact
// shape analyzer.js produced (just `row.data`) — a drop-in replacement for
// the old `run.summary.findings` array. `cap` is a safety ceiling, not an
// expected limit.
async function listAllRunFindingInstances(client, runId, { cap = 50_000 } = {}) {
  // Paged rather than one unbounded select, so a 20,000-row run cannot arrive as
  // one enormous result set. Advance by what actually came back and stop on an
  // empty page — the same rule as before, though the short-page hazard it was
  // written against (PostgREST's silent max-rows truncation) is gone.
  const PAGE = 5_000;
  const all = [];
  let offset = 0;
  while (offset < cap) {
    const rows = await client.rows(
      `select data from crawl_run_finding_instances
        where run_id = $1
        order by id asc
        limit $2 offset $3`,
      [runId, Math.min(PAGE, cap - offset), offset],
    );
    if (!rows.length) break;
    for (const row of rows) all.push(row.data);
    offset += rows.length;
  }
  return all;
}

// Internal link edges for one run (migration 0012). Chunked because a crawl of
// a few hundred pages produces tens of thousands of edges: one statement that
// size would exceed Postgres's bind-parameter limit, and chunking also bounds
// how much of the graph is held as bound values at once.
const LINK_CHUNK = 1000;

async function insertRunLinks(client, rows) {
  if (!rows.length) return 0;
  let written = 0;
  for (let i = 0; i < rows.length; i += LINK_CHUNK) {
    const chunk = rows.slice(i, i + LINK_CHUNK);
    await client.insertMany("crawl_run_links", chunk);
    written += chunk.length;
  }
  return written;
}

// Same insert, but the caller hands over the SOURCE edges and a mapper instead
// of a fully materialized row array. On a large crawl that array is millions of
// objects, and building it up front doubled the peak just as the crawler was
// still holding the graph it was copied from. Only one chunk exists at a time
// here, and each chunk is released before the next is built.
async function insertRunLinksStreaming(client, edges, toRow, include = () => true) {
  let written = 0;
  let chunk = [];
  const flush = async () => {
    if (!chunk.length) return;
    await client.insertMany("crawl_run_links", chunk);
    written += chunk.length;
    chunk = [];
  };
  for (const edge of edges) {
    if (!include(edge)) continue;
    chunk.push(toRow(edge));
    if (chunk.length >= LINK_CHUNK) await flush();
  }
  await flush();
  return written;
}

async function listRunLinks(client, runId, { limit = 20000 } = {}) {
  return client.rows(
    `select from_url, to_url, anchor, nofollow from crawl_run_links
      where run_id = $1
      limit $2`,
    [runId, limit],
  );
}

// Clear a reclaimed run's partial rows before it is retried, so the retry does not
// append to a half-finished result set.
async function deleteRunResults(client, runId) {
  // One transaction: a failure partway used to leave a mix of two attempts'
  // rows, which is precisely the half-finished state this function exists to
  // prevent. A retry re-derives the graph from scratch, so the edges go too —
  // leaving the previous attempt's would double every count in the clustering.
  await client.tx(async (t) => {
    for (const table of [
      "crawl_run_results",
      "crawl_run_findings",
      "crawl_run_finding_instances",
      "crawl_run_links",
    ]) {
      await t.query(`delete from "${table}" where run_id = $1`, [runId]);
    }
  });
}

async function listResults(client, runId, { limit = 500, offset = 0, owner = null } = {}) {
  const params = [runId];
  let scope = "";
  if (owner) {
    params.push(owner);
    scope = ` and owner = $${params.length}`;
  }
  params.push(limit, offset);
  return client.rows(
    `select data from crawl_run_results
      where run_id = $1${scope}
      order by id asc
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
}

// Patches one page's stored result with PageSpeed Insights data, keyed by
// (run_id, url) rather than a dedicated table — a page's PSI data lives
// alongside everything else the crawl already knows about it, the same way
// title/meta/word-count all live inside `data`. There's no unique constraint
// on (run_id, url) (a page is only ever inserted once per run in practice,
// but nothing enforces that), so this reads the row, merges in `pagespeed`,
// and writes the merge back by id rather than trying an upsert that assumes
// uniqueness it doesn't have. Read-modify-write in one transaction, so a
// concurrent PATCH to some other part of `data` isn't clobbered.
async function updateResultPagespeed(client, runId, url, pagespeed) {
  return client.tx(async (t) => {
    const row = await t.maybeOne(
      `select id, data from crawl_run_results
        where run_id = $1 and url = $2
        order by id asc
        limit 1
        for update`,
      [runId, url],
    );
    if (!row) return null;
    const data = { ...(row.data || {}), pagespeed };
    await t.query(
      `update crawl_run_results set data = $1 where id = $2`,
      [json(data), row.id],
    );
    return data;
  });
}

// ── Page category (V10.0) ───────────────────────────────────────────────────
// See supabase/migrations/0022_page_category.sql for why these are database
// functions rather than per-row writes: a per-row UPDATE loop over a
// 10,000-page crawl is 10,000 round trips, and "skip rows a human already
// corrected" can't be expressed by a plain upsert.

// Patches { pageCategory } onto crawl_run_results.data for one run, in one
// statement — the fix for the "—" the Category column has shown since V5
// (categorizePage() always ran; its output just never reached the table the
// UI reads). `patches` is [{ url, category }, ...]. Best-effort: called from
// a fire-and-forget context in run/manager.js, same as the link-graph write
// it sits next to — losing this patch costs one crawl's worth of category
// display, not the run itself.
async function patchResultCategories(client, runId, patches) {
  if (!patches.length) return;
  await client.query(
    `select patch_crawl_run_result_categories($1, $2)`,
    [runId, json(patches)],
  );
}

// Upserts a project's classification, skipping any URL a human has already
// manually corrected (manual_override = true) — enforced by the function's own
// WHERE clause, not here, so it holds regardless of caller. `entries` is
// [{ url, category, secondary_categories?, confidence?, signals? }, ...].
// No-op (not an error) for a run with no project_id — a one-off spider/list
// crawl has nowhere to key a cross-crawl override on.
async function upsertPageCategories(client, projectId, entries) {
  if (!projectId || !entries.length) return;
  await client.query(
    `select upsert_page_categories($1, $2)`,
    [projectId, json(entries)],
  );
}

async function listPageCategories(client, projectId) {
  if (!projectId) return [];
  return client.rows(
    `select url, category, secondary_categories, category_confidence,
            signals_matched, manual_override, override_reason
       from page_category
      where project_id = $1`,
    [projectId],
  );
}

// ── Issue review ────────────────────────────────────────────────────────────
// Per-finding triage (status + notes) for one run. See
// crawl_finding_reviews in supabase/migrations/0010_crawlscope.sql for why this
// is keyed on the analyzer's finding id rather than on crawl_run_findings,
// which is a per-rule rollup.
//
// `owner` is required, not optional, on every function here: these are only ever
// reached from an HTTP route, so there is no worker case that legitimately spans
// users the way claimNextQueuedRun does.

// Keyed on the run, not on the reader.
//
// This used to filter on `owner` while saveFindingReviews upserts on
// (run_id, finding_id) — so a second reviewer's decision OVERWROTE the first
// reviewer's row, and then neither could read the other's back. One row, two
// people, each seeing only their own writes to it.
//
// The row was always shared; only the read pretended otherwise. `reviewed_by`
// carries who decided, which is the attribution the UI actually shows. The
// caller has already authorized the run, and the run is the boundary.
async function listFindingReviews(client, runId) {
  return client.rows(
    `select finding_id, rule_id, review_status, reviewer_notes, reviewed_by, updated_at
       from crawl_finding_reviews
      where run_id = $1`,
    [runId],
  );
}

// Upsert, because a finding has no review row until someone first touches it —
// the UI shows every finding as "Needs review" by default without writing
// anything, so the first edit is an insert and later ones are updates.
async function saveFindingReviews(client, runId, owner, reviews, reviewedBy = null) {
  if (!reviews.length) return [];
  const rows = reviews.map((r) => ({
    run_id: runId,
    finding_id: r.findingId,
    owner,
    rule_id: r.ruleId,
    review_status: r.reviewStatus,
    reviewer_notes: r.reviewerNotes ?? null,
    reviewed_by: reviewedBy,
    updated_at: new Date().toISOString(),
  }));
  return client.upsert("crawl_finding_reviews", rows, ["run_id", "finding_id"], {
    returning: "*",
  });
}

module.exports = {
  canViewRow,
  viewerScope,
  getRunForViewer,
  listRunsForViewer,
  listProjectsForViewer,
  getProjectForViewer,
  listProjects,
  getProject,
  createProject,
  updateProject,
  dueProjects,
  dormantProjects,
  advanceProjectFrom,
  repairProjectNextRun,
  createRun,
  enqueueScheduledRun,
  getRun,
  listRuns,
  claimNextQueuedRun,
  updateRun,
  requeueRun,
  getRunCheckpoint,
  staleRuns,
  reclaimStaleRun,
  failStaleRun,
  previousCompletedRun,
  insertResults,
  insertRunLinks,
  insertRunLinksStreaming,
  listRunLinks,
  insertFindings,
  readControlRequest,
  clearControlRequest,
  insertRunFindingInstances,
  listAllRunFindingInstances,
  listRunFindingRollup,
  listRunFindingInstancesPage,
  deleteRunResults,
  listResults,
  updateResultPagespeed,
  patchResultCategories,
  upsertPageCategories,
  listPageCategories,
  listFindingReviews,
  saveFindingReviews,
};
