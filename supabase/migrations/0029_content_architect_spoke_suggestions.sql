-- ── Content Architect: spoke suggestions, in the database ──────────────────
--
-- Suggested spokes/supporting-topics (server/modules/contentArchitect/
-- spokeSuggestions.js, POST /projects/:id/clusters/:clusterId/suggest-spokes)
-- were only ever written into the project's file-backed full-analysis JSON
-- (contentArchitect/store.js's fullAnalysisFile) — one of the six modules
-- documented in server/services/dataRoot.js as storing state on disk rather
-- than in Postgres. On a container platform without a correctly-mounted
-- volume, that JSON resets to empty on every deploy: a suggestion computed
-- (and billed — it spends a SEMrush unit and a search API call) minutes
-- before a redeploy reads back as if it never ran.
--
-- This table is now the durable copy. contentArchitect's project ids are
-- file-store ids (e.g. "proj_..."), not Postgres rows, so project_id is text
-- with no foreign key — the same relationship crawl_run_results has to
-- crawl_runs when the two live in different stores.
create table if not exists content_architect_spoke_suggestions (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  cluster_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per (project, cluster) — "Re-suggest" replaces the prior result,
-- it does not accumulate a history.
create unique index if not exists uq_content_architect_spoke_suggestions_project_cluster
  on content_architect_spoke_suggestions (project_id, cluster_id);

create index if not exists idx_content_architect_spoke_suggestions_project
  on content_architect_spoke_suggestions (project_id);
