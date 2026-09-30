-- ── Content Architect: saved article enhancements, per page ─────────────────
--
-- "Enhance hub" / "Enhance article" in the Hub & Spoke report opens Article
-- Enhancement on that page. The enhancement (recommendations, the rewritten
-- article with its [NEW] additions, the coverage report) was never stored:
-- tool_runs keeps only the payloads of events named result/report/…, and this
-- stream names none of them, so a run's row has its input and no output. The
-- report's "View Recommendation" then opened a run with nothing in it.
--
-- When the enhancement was started from a Content Architect project, the
-- stream now writes its result here, and the report shows it beside the page.
-- One row per (project, page URL): a re-run replaces it.
--
-- project_id is a content_architect_projects id ("proj_..."), text with no
-- foreign key, the same relationship 0029 and 0040 have.
create table if not exists content_architect_enhancements (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  cluster_id text,
  url text not null,
  content_type text not null default 'article',
  title text,
  result jsonb not null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_content_architect_enhancements_page
  on content_architect_enhancements (project_id, url);
