-- ── Content Architect: keyword research per topic ───────────────────────────
--
-- The Hub & Spoke report runs Keyword Research inline on a suggested hub or
-- spoke topic (HubSpokeReport.jsx, the /api/keyword-research pipeline). A run
-- spends SEMrush units, search calls and three LLM calls, but its result and
-- the user's primary/secondary picks lived only in component state: collapsing
-- the cluster row or reloading the page threw both away.
--
-- One row per (project, cluster, topic). `result` is the pipeline's output as
-- the client assembled it from the stream (seed keyword, query variants,
-- competitor URLs, per-URL keywords, the full scored pool, the AI shortlist and
-- any warning); `selection` is the user's edited { primary, secondary }. A
-- re-run replaces the row, it does not accumulate a history — tool_runs already
-- keeps that.
--
-- project_id is a content_architect_projects id ("proj_..."), stored as text
-- with no foreign key, the same relationship 0029's spoke suggestions have.
create table if not exists content_architect_keyword_research (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  cluster_id text not null,
  topic text not null,
  intent text not null default 'informational',
  result jsonb not null,
  selection jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_content_architect_keyword_research_topic
  on content_architect_keyword_research (project_id, cluster_id, topic);

create index if not exists idx_content_architect_keyword_research_project
  on content_architect_keyword_research (project_id);
