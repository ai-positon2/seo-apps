-- ── Content Architect: projects and analyses, in the database ───────────────
--
-- Content Architect was one of six modules listed in server/services/dataRoot.js
-- as keeping their state as JSON on disk rather than in Postgres. The cost of
-- that split is not hypothetical and is not only about deploys:
--
--   * project_module_runs.payload->>'reportRef' stores a Content Architect
--     project id (server/modules/projects/moduleRunners.js), and the dashboard
--     card built from that row links to /content-architect/<that id>. The id was
--     resolved against projects.json on the SERVER'S OWN DISK. A database shared
--     between machines plus a per-machine file store means the card renders a
--     score while its report 404s "Project not found" — on a container platform
--     after any deploy, and on any developer machine pointed at a shared
--     database.
--   * 0029_content_architect_spoke_suggestions.sql already moved one slice of
--     this module's state here for exactly that reason, and had to declare
--     project_id as text with no foreign key because the parent rows lived in a
--     filesystem this database cannot see. This migration is what makes that
--     foreign key possible.
--
-- Ids stay TEXT and keep their existing "proj_..." shape. They are already
-- stored in project_module_runs payloads, in 0029's spoke-suggestion rows and in
-- URLs people have open; renumbering them to uuids would invalidate all three
-- for no gain.

create table if not exists content_architect_projects (
  id                  text primary key,
  -- The link this module's whole dangling-pointer problem was about. A real
  -- foreign key now, so a platform project cannot be deleted out from under an
  -- analysis and leave a card pointing at nothing.
  --
  -- ON DELETE SET NULL, not CASCADE: today deleting a platform project leaves
  -- the Content Architect analysis on disk, and an analysis someone paid API
  -- units for should not disappear because a project was tidied up. It unlinks
  -- and stays readable as a standalone analysis, which is also the state
  -- ensureProject() already knows how to adopt (see its `legacy` branch).
  platform_project_id uuid references crawl_projects(id) on delete set null,
  workspace_id        uuid references workspaces(id) on delete set null,
  -- The full record, same shape as the old projects.json entries, so the store's
  -- return values are byte-for-byte what routes and the client already expect.
  -- id/platform_project_id/workspace_id are mirrored into columns above for the
  -- primary key, the foreign keys and the indexed lookups below.
  data                jsonb not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ensureProject() must converge on ONE row per platform project.
--
-- The file store serialized this through an in-process promise chain
-- (mutateProjects), which was never enough: this app runs a web process AND a
-- module worker (worker-module.js), and they both call ensureProject. Two
-- processes could each read "no row for this platform project" and each append
-- one, and the duplicate then decided arbitrarily which analysis a reader got.
-- A unique index makes concurrent writers collide in the database instead, which
-- is the only place that can see both of them.
--
-- Partial: standalone analyses (no platform project) are legitimately unlinked,
-- and there can be many of them.
create unique index if not exists uq_content_architect_projects_platform
  on content_architect_projects (platform_project_id)
  where platform_project_id is not null;

create index if not exists idx_content_architect_projects_workspace
  on content_architect_projects (workspace_id);

-- ensureProject()'s adoption path looks a standalone analysis up by site, and
-- listProjects() is filtered by host on the module's own screen.
create index if not exists idx_content_architect_projects_domain
  on content_architect_projects ((data->>'domain'));

-- ── The four sidecars ───────────────────────────────────────────────────────
-- patterns / urls / clusters / full_analysis were four files per project
-- (<id>_patterns.json and friends). They are one row each here, keyed by the
-- pair, because every access is "this project's <kind>" — there is no query that
-- wants all patterns across projects, and four tables would repeat this one.
--
-- The payloads are large: full_analysis runs to ~2MB on a big site. That is well
-- inside jsonb's limits, but it is why these are NOT folded into the project row
-- itself — the project list is read on every screen in the module and must not
-- drag two megabytes of analysis behind it.
create table if not exists content_architect_artifacts (
  project_id text not null
    references content_architect_projects(id) on delete cascade,
  kind       text not null
    check (kind in ('patterns', 'urls', 'clusters', 'full_analysis')),
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, kind)
);

-- deleteProject() unlinked all four sidecars by hand. ON DELETE CASCADE above
-- does it now, which also closes the case the file version could not: a sidecar
-- whose project row was removed by some other path stayed on disk forever.

comment on table content_architect_projects is
  'Content Architect projects. Was server/modules/contentArchitect/data/projects.json.';
comment on table content_architect_artifacts is
  'Content Architect per-project payloads: discovered urls, url patterns, draft clusters, full analysis.';
