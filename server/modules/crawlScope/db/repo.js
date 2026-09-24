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
  crawl_run_results: new Set(["data", "edges"]),
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

// createProject is deliberately NOT here.
//
// It used to be, and it inserted a crawl_projects row and nothing else — no
// project_domains row, no country_code. project_domains is the authoritative
// home of a project's primary and competitor domains (PRD §8.1, §30.6), so
// every project this function created was structurally incomplete from birth:
// primaryDomain read back null, the projects screen showed "Missing", and
// nothing in the app could repair it.
//
// The project aggregate now has exactly one writer,
// modules/projects/store.js createProject, which writes the project and its
// primary domain in the same transaction. Migration 0027 backs that with a
// NOT NULL workspace_id and a checked backfill, so a partial project cannot be
// stored even by hand.
//
// If you need to create a project from here, call that store function (see the
// POST /projects handler in ../api/routes.js for how CrawlScope passes its own
// cron, enabled default and requireCountry: false through it). Do not add a
// second INSERT.

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

// Take ownership of ONE specific queued run — the guarantee claimNextQueuedRun
// gives the worker, for a caller that already knows which run it wants: the web
// process executing a run it has just created (POST /runs, the project's first
// crawl). Without it, that caller's plain UPDATE to 'running' raced the
// worker's claim, and a worker poll landing between the two executed the same
// crawl twice into one run id. Returns the claimed row, or null when the run
// is no longer queued (someone else owns it).
async function claimRun(client, id, { workerId = null } = {}) {
  const nowIso = new Date().toISOString();
  return client.maybeOne(
    `update crawl_runs
        set status = 'running',
            started_at = coalesce(started_at, $2),
            heartbeat_at = $2,
            worker_id = coalesce($3, worker_id)
      where id = $1 and status = 'queued'
      returning *`,
    [id, nowIso, workerId],
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

// The last completed crawl of the same site, for "new since last crawl": the
// same project, or for a crawl outside any project the same owner and URL. A
// URL-list crawl is never compared (its url is a label, not a site).
async function previousComparableRun(client, run) {
  return client.maybeOne(
    `select id, created_at, finished_at from crawl_runs
      where id <> $1
        and status = 'completed'
        and created_at < $2
        and not coalesce(options ? 'urls', false)
        and (($3::uuid is not null and project_id = $3)
          or ($3::uuid is null and project_id is null and owner = $4 and url = $5))
      order by created_at desc
      limit 1`,
    [run.id, run.created_at || new Date().toISOString(), run.project_id || null, run.owner, run.url],
  );
}

// Just enough of a run's findings to match them against another crawl's.
async function listRunIssueRows(client, runId) {
  return client.rows(
    `select finding_id as id,
            rule_id as "ruleId",
            data->>'url' as url,
            coalesce(data->>'targetUrl', '') as "targetUrl",
            data->>'issueKey' as "issueKey"
       from crawl_run_finding_instances
      where run_id = $1`,
    [runId],
  );
}

// Reviews carried over from the previous crawl (run/comparison.js). Never
// over a review someone already made on this run.
async function insertCarriedReviews(client, runId, owner, carried) {
  if (!carried.length) return 0;
  const now = new Date().toISOString();
  const rows = carried.map((review) => ({
    run_id: runId,
    finding_id: review.findingId,
    owner,
    rule_id: review.ruleId,
    review_status: review.reviewStatus,
    reviewer_notes: review.reviewerNotes ?? null,
    reviewed_by: review.reviewedBy ?? null,
    updated_at: now,
  }));
  const CHUNK = 1_000;
  for (let at = 0; at < rows.length; at += CHUNK) {
    await client.upsert("crawl_finding_reviews", rows.slice(at, at + CHUNK), ["run_id", "finding_id"], { merge: false });
  }
  return rows.length;
}

// ---- results / findings ---------------------------------------------------

async function insertResults(client, rows) {
  if (!rows.length) return;
  await client.insertMany("crawl_run_results", rows);
}

// ── Each page's own edges, for resuming (migration 0031) ────────────────────
// Whether crawl_run_results.edges exists here. Asked once per process: a
// database the migration has not reached must keep storing results without it
// rather than fail every insert over an unknown column.
let resultEdgesColumn = null;
async function resultEdgesSupported(client) {
  if (resultEdgesColumn !== null) return resultEdgesColumn;
  try {
    const rows = await client.rows(
      `select 1 from information_schema.columns
        where table_name = 'crawl_run_results' and column_name = 'edges' limit 1`,
    );
    resultEdgesColumn = rows.length > 0;
  } catch {
    resultEdgesColumn = false;
  }
  return resultEdgesColumn;
}

// Every row an interrupted attempt stored, with its edges, in the order it was
// stored — what a resumed run reloads so its analysis covers the whole crawl.
// Keyset-paged on the (run_id, id) index.
async function listRunResultsForResume(client, runId) {
  const withEdges = await resultEdgesSupported(client);
  const PAGE = 2_000;
  const rows = [];
  let after = 0;
  for (;;) {
    const page = await client.rows(
      `select id, url, data, ${withEdges ? "edges" : "null::jsonb as edges"}
         from crawl_run_results
        where run_id = $1 and id > $2
        order by id
        limit $3`,
      [runId, after, PAGE],
    );
    rows.push(...page);
    if (page.length < PAGE) return rows;
    after = page[page.length - 1].id;
  }
}

// Nothing reads a finished run's edges; they are only kept for a resume.
async function clearResultEdges(client, runId) {
  if (!(await resultEdgesSupported(client))) return 0;
  const result = await client.query(
    `update crawl_run_results set edges = null where run_id = $1 and edges is not null`,
    [runId],
  );
  return result?.rowCount || 0;
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

// ── Findings added to a stored run ──────────────────────────────────────────
// Core Web Vitals findings come from PageSpeed Insights, which runs after a
// crawl is analysed (run/pagespeed-findings.js). These are the reads and the
// write that replace them; the caller runs them in one transaction.

// The run row, locked until the transaction ends, so two PageSpeed results
// landing together recompute one after the other instead of over each other.
async function lockRun(client, runId) {
  return client.maybeOne(`select * from crawl_runs where id = $1 for update`, [runId]);
}

// Every page of the run with a stored PageSpeed Insights result: per URL, the
// row updateResultPagespeed writes to (the first one stored for it). Only the
// parts the findings are made from, not each result's list of fixes, since a
// whole-site sample can store thousands.
async function listRunPageSpeed(client, runId) {
  return client.rows(
    `select distinct on (url) url,
            jsonb_build_object(
              'dataUnavailable', data#>'{pagespeed,dataUnavailable}',
              'mobile', jsonb_build_object(
                'lcpMs', data#>'{pagespeed,mobile,lcpMs}',
                'cls', data#>'{pagespeed,mobile,cls}',
                'field', data#>'{pagespeed,mobile,field}'),
              'desktop', jsonb_build_object('field', data#>'{pagespeed,desktop,field}')
            ) as pagespeed
       from crawl_run_results
      where run_id = $1 and data ? 'pagespeed'
      order by url, id asc`,
    [runId],
  );
}

// What rule-order.js weighs a page by, and what makes it a page PageSpeed
// Insights can check, for every page of the run.
// Numbers and flags are read only when they are one, so an odd stored value is
// missing rather than an error.
async function listRunPageFacts(client, runId) {
  const number = (key) =>
    `case when jsonb_typeof(data->'${key}') = 'number' then (data->>'${key}')::numeric::int end`;
  return client.rows(
    `select url,
            data->>'scope' as scope,
            ${number("status")} as status,
            data->>'contentType' as "contentType",
            data->>'indexability' as indexability,
            coalesce(data->'isAsset' = 'true'::jsonb, false) as "isAsset",
            coalesce(data->'crawlRefused' = 'true'::jsonb, false) as "crawlRefused",
            ${number("inlinks")} as inlinks,
            ${number("followInlinks")} as "followInlinks",
            ${number("clickDepth")} as "clickDepth"
       from crawl_run_results
      where run_id = $1`,
    [runId],
  );
}

// Replaces some rules' findings on a stored run, instances and rollup rows.
// Returns the rollup rows it removed, for the caller to take out of the run's
// counts.
async function replaceRuleFindings(client, runId, owner, ruleIds, findings, rollup) {
  await client.query(
    `delete from crawl_run_finding_instances where run_id = $1 and rule_id = any($2::text[])`,
    [runId, ruleIds],
  );
  const removed = await client.rows(
    `delete from crawl_run_findings where run_id = $1 and rule_id = any($2::text[])
     returning rule_id, severity, count`,
    [runId, ruleIds],
  );
  await insertRunFindingInstances(client, runId, owner, findings);
  await insertFindings(client, rollup);
  return removed;
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
// The most finding instances any one read returns. A run can hold more; the
// report says so (see `meta` below) instead of presenting the first 50,000 as
// all of them.
const FINDINGS_READ_CAP = 50_000;

async function listAllRunFindingInstances(client, runId, { cap = FINDINGS_READ_CAP, meta = null } = {}) {
  // Paged rather than one unbounded select, so a 20,000-row run cannot arrive as
  // one enormous result set.
  //
  // Two things here are about cost, and both were measured against a real run of
  // 17,642 findings on the hosted database, which is far enough away that a
  // trivial query round-trips in ~260ms:
  //
  //   1. The pages are fetched TOGETHER. They were a sequential while-loop that
  //      advanced by whatever came back, so a four-page run paid four full
  //      transfers end to end. The count is known up front, so the page offsets
  //      are too, and nothing about the result depends on the order they arrive.
  //
  //   2. 'recommendation' and 'description' are fetched ONCE EACH, not once per
  //      finding. They are ~42% of the payload and they are rule-level prose:
  //      those 17,642 findings carried 39 distinct recommendations and 36
  //      distinct descriptions between them. The rows come back without those
  //      two keys plus a short hash of each, and they are put back on before
  //      this function returns.
  //
  // Measured end to end: 32.0s -> 10.7s for that run, producing a byte-identical
  // array. That last part is the point — every caller sees exactly what it saw
  // before, so this is a transport change, not a contract change. Keep it that
  // way: if you add a field here, it must be reassembled here too.
  const PAGE = 5_000;
  // Bounded so one large report cannot take the whole pool (DATABASE_POOL_MAX
  // defaults to 10) and stall every other request while it loads.
  const CONCURRENCY = 4;

  const [countRow, texts] = await Promise.all([
    client.rows(
      `select count(*)::int as n from crawl_run_finding_instances where run_id = $1`,
      [runId],
    ),
    client.rows(
      `select distinct
              left(md5(coalesce(data->>'recommendation','')), 8) as rk,
              data->>'recommendation'                            as rec,
              left(md5(coalesce(data->>'description','')), 8)    as dk,
              data->>'description'                               as descr
         from crawl_run_finding_instances
        where run_id = $1`,
      [runId],
    ),
  ]);

  // `meta.total` is how many the run holds, which a caller compares with what
  // came back to know whether the cap cut the list short.
  if (meta) meta.total = Number(countRow[0]?.n) || 0;
  const total = Math.min(Number(countRow[0]?.n) || 0, cap);
  if (!total) return [];

  const recommendationFor = new Map(texts.map((t) => [t.rk, t.rec]));
  const descriptionFor = new Map(texts.map((t) => [t.dk, t.descr]));

  const offsets = [];
  for (let o = 0; o < total; o += PAGE) offsets.push(o);

  const pages = new Array(offsets.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= offsets.length) return;
      const offset = offsets[i];
      // eslint-disable-next-line no-await-in-loop
      pages[i] = await client.rows(
        `select (data - 'recommendation' - 'description')          as d,
                left(md5(coalesce(data->>'recommendation','')), 8) as rk,
                left(md5(coalesce(data->>'description','')), 8)    as dk
           from crawl_run_finding_instances
          where run_id = $1
          order by id asc
          limit $2 offset $3`,
        [runId, Math.min(PAGE, total - offset), offset],
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, offsets.length) }, worker));

  // Reassembled in page order, so the result is still ordered by id.
  const all = [];
  for (const rows of pages) {
    if (!rows) continue;
    for (const row of rows) {
      const finding = row.d;
      const recommendation = recommendationFor.get(row.rk);
      if (recommendation !== undefined) finding.recommendation = recommendation;
      const description = descriptionFor.get(row.dk);
      if (description !== undefined) finding.description = description;
      all.push(finding);
    }
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

// Merges analyzer-computed fields into stored result rows. crawl_run_results
// rows are written as each page is fetched, before anything that needs the
// whole crawl exists — so a row's `inlinks` was the count at fetch time (0 for
// most pages; projects/crawledPages.js documents it as "0 on every row") and
// the report's Inlinks column showed that. `patches` is [{ url, fields }];
// `fields` is merged into `data`, never replacing it. Chunked so a 10,000-page
// crawl is several statements, not one enormous parameter.
const RESULT_PATCH_CHUNK = 1_000;

async function patchResultData(client, runId, patches) {
  for (let i = 0; i < patches.length; i += RESULT_PATCH_CHUNK) {
    const chunk = patches.slice(i, i + RESULT_PATCH_CHUNK);
    await client.query(
      `update crawl_run_results r
          set data = r.data || p.fields
         from jsonb_to_recordset($2::jsonb) as p(url text, fields jsonb)
        where r.run_id = $1 and r.url = p.url`,
      [runId, json(chunk)],
    );
  }
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
  previousComparableRun,
  listRunIssueRows,
  insertCarriedReviews,
  resultEdgesSupported,
  listRunResultsForResume,
  clearResultEdges,
  FINDINGS_READ_CAP,
  canViewRow,
  viewerScope,
  getRunForViewer,
  listRunsForViewer,
  listProjectsForViewer,
  getProjectForViewer,
  listProjects,
  getProject,
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
  claimRun,
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
  lockRun,
  listRunPageSpeed,
  listRunPageFacts,
  replaceRuleFindings,
  listAllRunFindingInstances,
  listRunFindingRollup,
  listRunFindingInstancesPage,
  deleteRunResults,
  listResults,
  updateResultPagespeed,
  patchResultCategories,
  patchResultData,
  upsertPageCategories,
  listPageCategories,
  listFindingReviews,
  saveFindingReviews,
};
