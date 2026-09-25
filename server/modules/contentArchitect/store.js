// ── Persistence — backed by Postgres ─────────────────────────────────────────
// Was one shared JSON list file plus four per-project sidecar files, all
// written atomically (temp-file-then-rename). Now content_architect_projects
// and content_architect_artifacts; see
// supabase/migrations/0032_content_architect_to_postgres.sql for why.
//
// Every exported name, argument and return shape is unchanged, so routes.js,
// the pipeline stages and the client need no changes. Records keep their exact
// previous field names (camelCase createdAt/updatedAt, not the columns'
// created_at/updated_at) because those names are what the client reads.
//
// Three things the file version could not do, which came for free here:
//
//   * ensureProject() converges on one row per platform project even when the
//     web process and the module worker race. It was serialized by an
//     in-process promise chain, which two processes do not share.
//   * updateProject() is a single statement, so a concurrent patch cannot lose
//     the other's fields. mutateProjects() read the whole list, mutated it and
//     wrote it back; only writes inside ONE process were ordered.
//   * assertSafeFileId is gone, with the vulnerability class it guarded. Ids
//     reached this module from req.params and were interpolated into file
//     paths, so `../../x` addressed files outside the data root and
//     deleteProject() unlinked four of them. Ids are bound query parameters
//     now and name nothing on disk.

const db = require('../../services/db');
const crypto = require('crypto');

function genId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

// The two mirrored columns are uuid, and everything that legitimately fills them
// comes from crawl_projects.id / workspaces.id. A value that is not a uuid is
// therefore data from somewhere it should not have come from: stored in `data`
// (so nothing is silently dropped from the record) but left out of the column,
// rather than failing the whole write on a cast error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (value) => (UUID_RE.test(String(value || '')) ? String(value) : null);

// The two columns say whether a record is linked, never the copies of them
// inside `data`. The two can disagree: scripts/importFileStores.js kept each
// record's `data` exactly as it was on disk, and for every record whose platform
// project does not exist in this database it dropped the COLUMN but not the
// field. Read from `data`, those records still named a platform project, so the
// routes' access check looked it up, found nothing, and answered "Project not
// found" for an analysis the importer had reported as kept — and the project
// list filtered them out for the same reason. The old ids stay in `data` as the
// record of where each one came from; they are just never what a caller is told.
const COLUMNS = 'data, platform_project_id, workspace_id';
const fromRow = (row) => ({
  ...row.data,
  platformProjectId: row.platform_project_id ?? null,
  workspaceId: row.workspace_id ?? null,
});

// ── Projects ────────────────────────────────────────────────────────────────

// Insertion order, which is what the JSON array gave callers and what the
// module's own project list still shows.
async function listProjects() {
  const found = await db.rows(
    `select ${COLUMNS} from content_architect_projects order by created_at asc, id asc`
  );
  return found.map(fromRow);
}

async function getProject(id) {
  const row = await db.maybeOne(
    `select ${COLUMNS} from content_architect_projects where id = $1`, [id]
  );
  return row ? fromRow(row) : null;
}

function newProject({ domain, host, platformProjectId = null, workspaceId = null }) {
  return {
    id: genId('proj'),
    platformProjectId,
    workspaceId,
    domain, // canonical origin, e.g. "https://www.example.com"
    name: host,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workflowState: platformProjectId ? 'waiting_for_crawl' : 'created',
    vertical: null,
    // Set once (Domains-style input, not asked again per spoke-suggestion
    // request) and reused automatically by spokeSuggestions.js's competitive
    // signal — see routes.js PUT /projects/:id/competitors.
    competitors: [],
    sitemapSource: null,
    crawlMode: null,
    stats: { urlsFound: 0, urlsSelected: 0, urlsAnalyzed: 0, urlsExcluded: 0, clusterCount: 0, gapHubCount: 0, orphanCount: 0, unassignedCount: 0, meanHealth: null },
  };
}

// Shared by createProject and ensureProject. `client` lets a caller run it
// inside a transaction; unset, it is its own statement.
async function insertProject(project, client = null) {
  const run = client ? client.query.bind(client) : db.query;
  await run(
    `insert into content_architect_projects
       (id, platform_project_id, workspace_id, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $5)`,
    [
      project.id,
      asUuid(project.platformProjectId),
      asUuid(project.workspaceId),
      db.json(project),
      project.createdAt,
    ]
  );
  // What a read of this row will say, so the caller holding the returned record
  // and the next caller to read it back cannot disagree about its link.
  return {
    ...project,
    platformProjectId: asUuid(project.platformProjectId),
    workspaceId: asUuid(project.workspaceId),
  };
}

async function createProject(input) {
  return insertProject(newProject(input));
}

// Postgres unique_violation. ensureProject races on
// uq_content_architect_projects_platform by design.
const UNIQUE_VIOLATION = '23505';

const siteOf = (value) => {
  try { return new URL(value).host.toLowerCase().replace(/^www\./, ''); }
  catch { return null; }
};

/** A stable module entry per platform project, including before its first crawl. */
async function ensureProject({ platformProjectId, workspaceId, domain, host }) {
  if (!platformProjectId) throw new Error('A platform project is required.');
  // Loud, rather than falling through to asUuid's null. platform_project_id is
  // the column the uniqueness and the foreign key hang off; a value that cannot
  // go in it would make every call look like "no entry yet" and append another
  // unlinked row — the duplicate-per-call bug, silently.
  if (!asUuid(platformProjectId)) {
    throw new Error(`A platform project id must be a uuid, got: ${platformProjectId}`);
  }

  const byPlatform = async () => {
    const row = await db.maybeOne(
      `select ${COLUMNS} from content_architect_projects where platform_project_id = $1`,
      [asUuid(platformProjectId)]
    );
    return row ? fromRow(row) : null;
  };

  const existing = await byPlatform();
  if (existing) return existing;

  // Legacy standalone analyses can be reused once. Never share a linked record
  // between projects/workspaces that happen to track the same site.
  //
  // The host comparison stays in JavaScript rather than becoming SQL: it strips
  // `www.` and lowercases through the URL parser, and a SQL expression that
  // approximated that would be a second, subtly different definition of "same
  // site". Only unlinked rows are candidates, and there are few of them.
  //
  // And only one this workspace could already see: a standalone analysis, or
  // one already in this workspace. An unlinked row can still belong to another
  // workspace — the importer kept a workspace link it could resolve after
  // dropping a platform link it could not — and adopting that row would move
  // that workspace's analysis into this one.
  const site = siteOf(domain);
  if (site) {
    const candidates = await db.rows(
      `select id, data, workspace_id from content_architect_projects
        where platform_project_id is null
        order by created_at asc, id asc`
    );
    const workspace = asUuid(workspaceId);
    const legacy = candidates.find((r) => siteOf(r.data.domain) === site
      && (!r.workspace_id || r.workspace_id === workspace));
    if (legacy) {
      // Conditional on STILL being unlinked, so two processes adopting the same
      // row cannot both believe they won. The loser falls through to the insert
      // below and then to the unique-violation recovery.
      const adopted = await db.maybeOne(
        `update content_architect_projects
            set data = data || $2::jsonb,
                platform_project_id = $3,
                workspace_id = $4,
                updated_at = now()
          where id = $1 and platform_project_id is null
        returning ${COLUMNS}`,
        [
          legacy.id,
          db.json({
            platformProjectId,
            workspaceId,
            updatedAt: new Date().toISOString(),
          }),
          asUuid(platformProjectId),
          asUuid(workspaceId),
        ]
      );
      if (adopted) return fromRow(adopted);
    }
  }

  const project = newProject({ domain, host, platformProjectId, workspaceId });
  try {
    return await insertProject(project);
  } catch (error) {
    // Another process created the row between our lookup and our insert. Its
    // row is as good as the one we were about to write, so read it back rather
    // than failing a request over a race the caller cannot do anything about.
    const cause = error?.cause || error;
    if (cause?.code === UNIQUE_VIOLATION || /duplicate key/i.test(error?.message || '')) {
      const winner = await byPlatform();
      if (winner) return winner;
    }
    throw error;
  }
}

async function updateProject(id, patch) {
  // One statement: read-modify-write in the application lost fields whenever two
  // updates overlapped. `data || patch` is a shallow merge, which is exactly
  // what `{ ...existing, ...patch }` did.
  const merged = { ...patch, updatedAt: new Date().toISOString() };

  // Whether the patch touches a mirrored column is known here, in JavaScript,
  // so the statement does not have to ask jsonb the same question.
  const setsPlatform = Object.prototype.hasOwnProperty.call(patch, 'platformProjectId');
  const setsWorkspace = Object.prototype.hasOwnProperty.call(patch, 'workspaceId');

  const row = await db.maybeOne(
    `update content_architect_projects
        set data = data || $2::jsonb,
            platform_project_id = case when $3 then $4::uuid else platform_project_id end,
            workspace_id        = case when $5 then $6::uuid else workspace_id end,
            updated_at = now()
      where id = $1
    returning ${COLUMNS}`,
    [
      id, db.json(merged),
      setsPlatform, setsPlatform ? asUuid(patch.platformProjectId) : null,
      setsWorkspace, setsWorkspace ? asUuid(patch.workspaceId) : null,
    ]
  );
  if (!row) throw new Error('Project not found');
  return fromRow(row);
}

async function deleteProject(id) {
  // The four artifacts go with it: ON DELETE CASCADE in 0032. The file version
  // unlinked them one by one and left them behind whenever the project row was
  // removed by any other path.
  await db.query(`delete from content_architect_projects where id = $1`, [id]);
}

// ── Per-project artifacts ───────────────────────────────────────────────────
// patterns / urls / clusters / full_analysis. Missing reads return null, the
// same fallback the file version gave when a sidecar did not exist yet.

async function getArtifact(projectId, kind) {
  const row = await db.maybeOne(
    `select data from content_architect_artifacts where project_id = $1 and kind = $2`,
    [projectId, kind]
  );
  return row ? row.data : null;
}

async function saveArtifact(projectId, kind, payload) {
  await db.query(
    `insert into content_architect_artifacts (project_id, kind, data)
     values ($1, $2, $3)
     on conflict (project_id, kind)
       do update set data = excluded.data, updated_at = now()`,
    [projectId, kind, db.json(payload)]
  );
}

const getPatterns = (id) => getArtifact(id, 'patterns');
const savePatterns = (id, patterns) => saveArtifact(id, 'patterns', patterns);

// The raw discovered/crawled URL list ({ url, lastmod }[]), persisted once at
// discovery time. Stage 2's pattern table only keeps 3 example URLs per pattern
// (see patternClassifier.js) — Stage 3 needs every confirmed URL and must make
// no network calls, so the full list has to be stored rather than re-fetched or
// re-derived from examples alone.
const getUrls = (id) => getArtifact(id, 'urls');
const saveUrls = (id, urls) => saveArtifact(id, 'urls', urls);

const getClusters = (id) => getArtifact(id, 'clusters');
const saveClusters = (id, clusters) => saveArtifact(id, 'clusters', clusters);

const getFullAnalysis = (id) => getArtifact(id, 'full_analysis');
const saveFullAnalysis = (id, analysis) => saveArtifact(id, 'full_analysis', analysis);

// Removes a stored analysis that no longer describes what the tool produces.
// Used by the project-linked run when an analysis built from EVERY crawled page
// (before informational-only selection) would otherwise stay on offer next to a
// verdict that says there is not enough informational content to cluster.
async function deleteFullAnalysis(id) {
  await db.query(
    `delete from content_architect_artifacts where project_id = $1 and kind = $2`,
    [id, 'full_analysis']
  );
}

module.exports = {
  listProjects, getProject, createProject, ensureProject, updateProject, deleteProject,
  getPatterns, savePatterns, getUrls, saveUrls, getClusters, saveClusters,
  getFullAnalysis, saveFullAnalysis, deleteFullAnalysis,
};
