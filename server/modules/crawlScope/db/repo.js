// Data-access layer. Every function takes a Supabase `client` as its first
// argument. In the standalone CrawlScope app that was sometimes a user-scoped
// client with RLS enforced; here it is always the app's service-role client,
// because identity in this app is our own signed JWT over `app_users` and there
// is no Supabase Auth session for RLS to key off (see ./supabase.js).
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

function unwrap({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

// Compare-and-swap helpers use `.select()` (not `.select().single()`) because zero
// matched rows is the normal "another worker won the race" outcome, and `single()`
// raises PGRST116 for it.
function firstRow(rows) {
  return (Array.isArray(rows) ? rows[0] : rows) || null;
}

// ---- projects -------------------------------------------------------------

async function listProjects(client, owner) {
  return unwrap(
    await client
      .from("crawl_projects")
      .select("*")
      .eq("owner", owner)
      .order("created_at", { ascending: false }),
  );
}

// `owner` is optional so the worker (which has no request user) can read any project,
// while every HTTP path passes it and gets explicit tenant scoping.
async function getProject(client, id, owner = null) {
  let query = client.from("crawl_projects").select("*").eq("id", id);
  if (owner) query = query.eq("owner", owner);
  return unwrap(await query.maybeSingle());
}

async function createProject(client, owner, data) {
  return unwrap(
    await client
      .from("crawl_projects")
      .insert({
        owner,
        // Recorded, not used for access control — see 0010_crawlscope.sql.
        workspace_id: data.workspace_id || null,
        name: data.name || null,
        url: data.url,
        options: data.options || {},
        cron: data.cron,
        timezone: data.timezone,
        recipients: data.recipients || [],
        enabled: data.enabled !== false,
        next_run_at: data.next_run_at || null,
      })
      .select()
      .single(),
  );
}

async function updateProject(client, id, patch, owner = null) {
  let query = client.from("crawl_projects").update(patch).eq("id", id);
  if (owner) query = query.eq("owner", owner);
  return firstRow(unwrap(await query.select()));
}

async function deleteProject(client, id, owner = null) {
  let query = client.from("crawl_projects").delete().eq("id", id);
  if (owner) query = query.eq("owner", owner);
  return firstRow(unwrap(await query.select()));
}

// Enabled projects whose next_run_at is due (service client only).
// Ordered so the most overdue fires first, and bounded so one tick cannot pull the
// entire table into memory.
async function dueProjects(client, nowIso, { limit = 50 } = {}) {
  return unwrap(
    await client
      .from("crawl_projects")
      .select("*")
      .eq("enabled", true)
      .not("next_run_at", "is", null)
      .lte("next_run_at", nowIso)
      .order("next_run_at", { ascending: true })
      .limit(limit),
  );
}

// Enabled projects with next_run_at IS NULL. SQL NULL comparison means dueProjects can
// never see these, so without a repair pass they sleep forever.
async function dormantProjects(client, { limit = 50 } = {}) {
  return unwrap(
    await client
      .from("crawl_projects")
      .select("id,cron,timezone")
      .eq("enabled", true)
      .is("next_run_at", null)
      .limit(limit),
  );
}

// Advance a project's fire slot, but only if it still holds `expectedIso`. Two worker
// replicas ticking the same due project therefore cannot both advance it.
async function advanceProjectFrom(client, id, expectedIso, patch) {
  return firstRow(
    unwrap(
      await client
        .from("crawl_projects")
        .update(patch)
        .eq("id", id)
        .eq("enabled", true)
        .eq("next_run_at", expectedIso)
        .select(),
    ),
  );
}

async function repairProjectNextRun(client, id, nextIso) {
  return firstRow(
    unwrap(
      await client
        .from("crawl_projects")
        .update({ next_run_at: nextIso })
        .eq("id", id)
        .eq("enabled", true)
        .is("next_run_at", null)
        .select(),
    ),
  );
}

// ---- runs -----------------------------------------------------------------

async function createRun(client, run) {
  return unwrap(
    await client
      .from("crawl_runs")
      .insert({
        owner: run.owner,
        workspace_id: run.workspace_id || null,
        project_id: run.project_id || null,
        scheduled_for: run.scheduled_for || null,
        url: run.url,
        options: run.options || {},
        status: "queued",
        trigger: run.trigger || "manual",
      })
      .select()
      .single(),
  );
}

// Idempotent enqueue for one (project, fire slot) pair, guarded by the
// runs_project_slot_uniq constraint. Returns null when the slot was already taken,
// which is how two replicas racing the same tick converge on a single crawl and a
// single client email.
//
// This reads the raw error rather than going through unwrap() because unwrap discards
// the Postgres error code, and 23505 is the one code here that means "success, someone
// else got there first" rather than a failure.
async function enqueueScheduledRun(client, run) {
  const { data, error } = await client
    .from("crawl_runs")
    .insert({
      owner: run.owner,
      workspace_id: run.workspace_id || null,
      project_id: run.project_id,
      scheduled_for: run.scheduled_for,
      url: run.url,
      options: run.options || {},
      status: "queued",
      trigger: run.trigger || "schedule",
    })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") return null;
    throw new Error(error.message || String(error));
  }
  return data;
}

// ── Viewer scope ——————————————————————————————@
//
// A crawl run is readable by the WORKSPACE it belongs to, not by whoever happened
// to click Start.
//
// Every read in this file used `.eq("owner", owner)`, which made the module
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
 * The same rule as a PostgREST filter, for list reads that cannot fetch first and
 * authorize after.
 *
 * Ids are format-checked before interpolation. They come from our own tables and
 * our own JWT rather than from a request body, but this string becomes query
 * syntax, and a filter builder that trusts its input is how that stops being true
 * later.
 *
 * Returns '' when the viewer has no identity at all. Callers MUST treat that as
 * "no rows" — never as "no filter", which would read the whole table.
 */
function viewerFilter(viewer) {
  const ids = (viewer?.workspaceIds || []).filter((id) => UUID_RE.test(String(id)));
  const userId = UUID_RE.test(String(viewer?.userId)) ? viewer.userId : null;
  const clauses = [];
  if (ids.length) clauses.push(`workspace_id.in.(${ids.join(",")})`);
  if (userId) clauses.push(`and(workspace_id.is.null,owner.eq.${userId})`);
  return clauses.join(",");
}

/** One run, if this viewer may see it. Null when it does not exist OR is theirs
 *  to not see — the route answers 404 for both, per the house rule that a
 *  cross-workspace read must not confirm the row exists. */
async function getRunForViewer(client, id, viewer) {
  const row = unwrap(
    await client.from("crawl_runs").select("*").eq("id", id).maybeSingle(),
  );
  return canViewRow(row, viewer) ? row : null;
}

async function listRunsForViewer(client, viewer, { limit = 50, projectId = null } = {}) {
  const filter = viewerFilter(viewer);
  if (!filter) return [];
  let query = client
    .from("crawl_runs")
    // workspace_id and owner ride along so a returned row can be checked against
    // the scope that produced it. Still no `summary`, which carries every finding
    // and reaches tens of megabytes on a large crawl.
    .select(
      "id,url,status,trigger,project_id,workspace_id,owner,scheduled_for,created_at,started_at,finished_at,report_path,counts:summary->counts",
    )
    .or(filter);
  if (projectId) query = query.eq("project_id", projectId);
  return unwrap(await query.order("created_at", { ascending: false }).limit(limit));
}

async function listProjectsForViewer(client, viewer) {
  const filter = viewerFilter(viewer);
  if (!filter) return [];
  return unwrap(
    await client
      .from("crawl_projects")
      .select("*")
      .or(filter)
      .order("created_at", { ascending: false }),
  );
}

async function getProjectForViewer(client, id, viewer) {
  const row = unwrap(
    await client.from("crawl_projects").select("*").eq("id", id).maybeSingle(),
  );
  return canViewRow(row, viewer) ? row : null;
}

async function getRun(client, id, owner = null) {
  let query = client.from("crawl_runs").select("*").eq("id", id);
  if (owner) query = query.eq("owner", owner);
  return unwrap(await query.maybeSingle());
}

// Narrow select: the UI only reads summary.counts, while `summary` itself carries every
// finding and can reach tens of megabytes on a large crawl.
async function listRuns(client, owner, { limit = 50, projectId = null } = {}) {
  let query = client
    .from("crawl_runs")
    .select(
      "id,url,status,trigger,project_id,scheduled_for,created_at,started_at,finished_at,report_path,counts:summary->counts",
    )
    .eq("owner", owner);
  if (projectId) query = query.eq("project_id", projectId);
  return unwrap(await query.order("created_at", { ascending: false }).limit(limit));
}

// Claim the oldest queued run for execution. Optimistic: flip status queued->running
// scoped to the id, so if two workers race only one update succeeds. `triggers` limits
// which runs a caller will claim (the worker claims 'schedule' and 'initial' runs;
// plain 'manual' runs are executed in-process by the web service).
//
// Walks a small candidate window rather than only the single oldest row: losing one CAS
// should cost another round trip, not a whole poll interval of idleness while queued
// work sits there.
async function claimNextQueuedRun(serviceClient, { triggers, trigger, workerId } = {}) {
  const wanted = triggers?.length ? triggers : trigger ? [trigger] : null;
  const candidateLimit = Number(process.env.WORKER_CLAIM_CANDIDATES) || 5;
  let query = serviceClient
    .from("crawl_runs")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(candidateLimit);
  if (wanted) query = query.in("trigger", wanted);
  const candidates = unwrap(await query);

  for (const candidate of candidates || []) {
    const nowIso = new Date().toISOString();
    const claimed = unwrap(
      await serviceClient
        .from("crawl_runs")
        .update({
          status: "running",
          started_at: nowIso,
          heartbeat_at: nowIso,
          worker_id: workerId || null,
        })
        .eq("id", candidate.id)
        .eq("status", "queued")
        .select()
        .maybeSingle(),
    );
    if (claimed) return claimed;
  }
  return null;
}

async function updateRun(client, id, patch) {
  return unwrap(await client.from("crawl_runs").update(patch).eq("id", id).select().maybeSingle());
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
  return unwrap(await client.from("crawl_runs").update(patch).eq("id", id).select().maybeSingle());
}

// Just the frontier, never the whole row: a checkpoint for a large crawl is
// megabytes, and the callers that need it only need to know whether it is usable.
async function getRunCheckpoint(client, id) {
  const row = unwrap(
    await client.from("crawl_runs").select("checkpoint").eq("id", id).maybeSingle(),
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
  "id,owner,project_id,url,status,trigger,attempts,worker_id,heartbeat_at,started_at,checkpoint";

async function staleRuns(client, staleBeforeIso, { limit = 20 } = {}) {
  const executing = (query) => query.in("status", ["running", "paused"]);

  // Two plain queries rather than one `.or(...)` with an embedded timestamp: PostgREST's
  // or= grammar is comma/dot delimited, and smuggling an ISO timestamp through it is a
  // parsing subtlety this code cannot verify offline. Two selects are unambiguous.
  const beating = unwrap(
    await executing(client.from("crawl_runs").select(STALE_RUN_COLUMNS))
      .lt("heartbeat_at", staleBeforeIso)
      .order("heartbeat_at", { ascending: true })
      .limit(limit),
  );

  const neverStamped = unwrap(
    await executing(client.from("crawl_runs").select(STALE_RUN_COLUMNS))
      .is("heartbeat_at", null)
      .lt("started_at", staleBeforeIso)
      .order("started_at", { ascending: true })
      .limit(limit),
  );

  return [...beating, ...neverStamped].slice(0, limit);
}

// Guard a reaper write on exactly the row we observed, so a revived worker or a second
// replica's reaper cannot act on it twice. `.eq(column, null)` never matches in
// PostgREST, so a NULL heartbeat has to be expressed as `.is`.
function guardObservedRun(query, run) {
  const guarded = query.eq("id", run.id).eq("status", run.status);
  return run.heartbeat_at
    ? guarded.eq("heartbeat_at", run.heartbeat_at)
    : guarded.is("heartbeat_at", null);
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
  return firstRow(unwrap(await guardObservedRun(client.from("crawl_runs").update(patch), run).select()));
}

async function failStaleRun(client, run, attempts, message) {
  return firstRow(
    unwrap(
      await guardObservedRun(
        client.from("crawl_runs").update({
          status: "failed",
          error: message,
          attempts,
          finished_at: new Date().toISOString(),
        }),
        run,
      ).select(),
    ),
  );
}

// Most recent completed run for a project before a given time (for deltas).
async function previousCompletedRun(client, projectId, beforeIso) {
  if (!projectId) return null;
  const rows = unwrap(
    await client
      .from("crawl_runs")
      .select("id,summary,finished_at")
      .eq("project_id", projectId)
      .eq("status", "completed")
      .lt("created_at", beforeIso)
      .order("created_at", { ascending: false })
      .limit(1),
  );
  return rows[0] || null;
}

// ---- results / findings ---------------------------------------------------

async function insertResults(serviceClient, rows) {
  if (!rows.length) return;
  unwrap(await serviceClient.from("crawl_run_results").insert(rows));
}

async function insertFindings(serviceClient, rows) {
  if (!rows.length) return;
  unwrap(await serviceClient.from("crawl_run_findings").insert(rows));
}

// Full per-occurrence findings for one run (migration 0023) — chunked the
// same way insertRunLinksStreaming already handles a quarter million link
// edges, because the single-UPDATE alternative (embedding the whole array in
// crawl_runs.summary) is exactly what started timing out once crawls could
// reach 10,000 pages. `data` carries each finding object exactly as
// analyzer.js produced it, so every existing reader keeps working unchanged
// once it reads from this table instead of run.summary.findings.
const FINDING_INSTANCE_CHUNK = 1000;

async function insertRunFindingInstances(serviceClient, runId, owner, findings) {
  let written = 0;
  for (let i = 0; i < findings.length; i += FINDING_INSTANCE_CHUNK) {
    const chunk = findings.slice(i, i + FINDING_INSTANCE_CHUNK).map((f) => ({
      run_id: runId,
      owner,
      finding_id: f.id,
      rule_id: f.ruleId,
      data: f,
    }));
    unwrap(await serviceClient.from("crawl_run_finding_instances").insert(chunk));
    written += chunk.length;
  }
  return written;
}

// Fetches every stored finding instance for a run, reconstructed to the exact
// shape analyzer.js produced (just `row.data`) — a drop-in replacement for
// the old `run.summary.findings` array. Paginates internally (the same
// .range() loop pattern used throughout this file) rather than trusting one
// unbounded select to come back whole for a 20,000-row run. `cap` is a safety
// ceiling, not an expected limit — findings this app itself just inserted are
// trusted to be well under it for any real crawl.
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
  return unwrap(
    await client
      .from("crawl_run_findings")
      .select("rule_id, severity, category, count, detail")
      .eq("run_id", runId)
      .order("count", { ascending: false })
      .limit(200),
  );
}

async function listAllRunFindingInstances(client, runId, { cap = 50_000 } = {}) {
  // PostgREST applies its own `max-rows` ceiling (1,000 on Supabase) and
  // silently returns a SHORT page when asked for more. So "fewer rows than I
  // asked for" does NOT mean "no rows left" — with PAGE above the ceiling it is
  // the normal case on every page, and breaking on it ended this loop after
  // one. A 1,694-finding run served 1,000 findings; the report's own
  // completeness line was the only thing that noticed.
  //
  // So: advance by what actually came back, and stop only on an empty page.
  // That costs one extra round trip at the end. The alternative loses data
  // without telling anyone.
  const PAGE = 1_000;
  const all = [];
  let offset = 0;
  while (offset < cap) {
    const rows = unwrap(
      await client
        .from("crawl_run_finding_instances")
        .select("data")
        .eq("run_id", runId)
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1),
    );
    if (!rows.length) break;
    for (const row of rows) all.push(row.data);
    offset += rows.length;
  }
  return all;
}

// Internal link edges for one run (migration 0012). Chunked because a crawl of
// a few hundred pages produces tens of thousands of edges, and one insert that
// size is refused by the REST layer rather than being slow.
const LINK_CHUNK = 1000;

async function insertRunLinks(serviceClient, rows) {
  if (!rows.length) return 0;
  let written = 0;
  for (let i = 0; i < rows.length; i += LINK_CHUNK) {
    const chunk = rows.slice(i, i + LINK_CHUNK);
    unwrap(await serviceClient.from("crawl_run_links").insert(chunk));
    written += chunk.length;
  }
  return written;
}

// Same insert, but the caller hands over the SOURCE edges and a mapper instead
// of a fully materialized row array. On a large crawl that array is millions of
// objects, and building it up front doubled the peak just as the crawler was
// still holding the graph it was copied from. Only one chunk exists at a time
// here, and each chunk is released before the next is built.
async function insertRunLinksStreaming(serviceClient, edges, toRow, include = () => true) {
  let written = 0;
  let chunk = [];
  const flush = async () => {
    if (!chunk.length) return;
    unwrap(await serviceClient.from("crawl_run_links").insert(chunk));
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
  return unwrap(
    await client
      .from("crawl_run_links")
      .select("from_url, to_url, anchor, nofollow")
      .eq("run_id", runId)
      .limit(limit),
  );
}

// Clear a reclaimed run's partial rows before it is retried, so the retry does not
// append to a half-finished result set.
async function deleteRunResults(serviceClient, runId) {
  unwrap(await serviceClient.from("crawl_run_results").delete().eq("run_id", runId));
  unwrap(await serviceClient.from("crawl_run_findings").delete().eq("run_id", runId));
  // A retry re-derives the graph from scratch; leaving the previous attempt's
  // edges would double every count in the clustering.
  unwrap(await serviceClient.from("crawl_run_links").delete().eq("run_id", runId));
}

async function listResults(client, runId, { limit = 500, offset = 0, owner = null } = {}) {
  let query = client.from("crawl_run_results").select("data").eq("run_id", runId);
  if (owner) query = query.eq("owner", owner);
  return unwrap(await query.order("id", { ascending: true }).range(offset, offset + limit - 1));
}

// Patches one page's stored result with PageSpeed Insights data, keyed by
// (run_id, url) rather than a dedicated table — a page's PSI data lives
// alongside everything else the crawl already knows about it, the same way
// title/meta/word-count all live inside `data`. There's no unique constraint
// on (run_id, url) (a page is only ever inserted once per run in practice,
// but nothing enforces that), so this reads the row, merges in `pagespeed`,
// and writes the merge back by id rather than trying an upsert that assumes
// uniqueness it doesn't have. Read-modify-write, not a jsonb concat operator,
// so a concurrent PATCH to some other part of `data` isn't clobbered.
async function updateResultPagespeed(serviceClient, runId, url, pagespeed) {
  const rows = unwrap(
    await serviceClient
      .from("crawl_run_results")
      .select("id, data")
      .eq("run_id", runId)
      .eq("url", url)
      .order("id", { ascending: true })
      .limit(1),
  );
  const row = firstRow(rows);
  if (!row) return null;
  const data = { ...(row.data || {}), pagespeed };
  unwrap(
    await serviceClient
      .from("crawl_run_results")
      .update({ data })
      .eq("id", row.id)
      .select("id, data"),
  );
  return data;
}

// ── Page category (V10.0) ───────────────────────────────────────────────────
// See supabase/migrations/0022_page_category.sql for why these are RPCs
// rather than .from() calls: a per-row PATCH loop over a 10,000-page crawl is
// 10,000 round trips, and "skip rows a human already corrected" can't be
// expressed by a plain upsert.

// Patches { pageCategory } onto crawl_run_results.data for one run, in one
// statement — the fix for the "—" the Category column has shown since V5
// (categorizePage() always ran; its output just never reached the table the
// UI reads). `patches` is [{ url, category }, ...]. Best-effort: called from
// a fire-and-forget context in run/manager.js, same as the link-graph write
// it sits next to — losing this patch costs one crawl's worth of category
// display, not the run itself.
async function patchResultCategories(serviceClient, runId, patches) {
  if (!patches.length) return;
  unwrap(
    await serviceClient.rpc("patch_crawl_run_result_categories", {
      p_run_id: runId,
      patches,
    }),
  );
}

// Upserts a project's classification, skipping any URL a human has already
// manually corrected (manual_override = true) — enforced by the RPC's own
// WHERE clause, not here, so it holds regardless of caller. `entries` is
// [{ url, category, secondary_categories?, confidence?, signals? }, ...].
// No-op (not an error) for a run with no project_id — a one-off spider/list
// crawl has nowhere to key a cross-crawl override on.
async function upsertPageCategories(serviceClient, projectId, entries) {
  if (!projectId || !entries.length) return;
  unwrap(
    await serviceClient.rpc("upsert_page_categories", {
      p_project_id: projectId,
      entries,
    }),
  );
}

async function listPageCategories(serviceClient, projectId) {
  if (!projectId) return [];
  return unwrap(
    await serviceClient
      .from("page_category")
      .select("url, category, secondary_categories, category_confidence, signals_matched, manual_override, override_reason")
      .eq("project_id", projectId),
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
// This used to filter `.eq("owner", owner)` while saveFindingReviews upserts on
// (run_id, finding_id) — so a second reviewer's decision OVERWROTE the first
// reviewer's row, and then neither could read the other's back. One row, two
// people, each seeing only their own writes to it.
//
// The row was always shared; only the read pretended otherwise. `reviewed_by`
// carries who decided, which is the attribution the UI actually shows. The
// caller has already authorized the run, and the run is the boundary.
async function listFindingReviews(client, runId) {
  return unwrap(
    await client
      .from("crawl_finding_reviews")
      .select("finding_id,rule_id,review_status,reviewer_notes,reviewed_by,updated_at")
      .eq("run_id", runId),
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
  return unwrap(
    await client
      .from("crawl_finding_reviews")
      .upsert(rows, { onConflict: "run_id,finding_id" })
      .select(),
  );
}

module.exports = {
  canViewRow,
  viewerFilter,
  getRunForViewer,
  listRunsForViewer,
  listProjectsForViewer,
  getProjectForViewer,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
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
  deleteRunResults,
  listResults,
  updateResultPagespeed,
  patchResultCategories,
  upsertPageCategories,
  listPageCategories,
  listFindingReviews,
  saveFindingReviews,
};
