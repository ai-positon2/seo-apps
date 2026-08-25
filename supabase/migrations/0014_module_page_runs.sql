-- ═══════════════════════════════════════════════════════════════════════════
-- 0014 — Per-page module reports (SEO & GEO, On-Page, Agent Readiness)
--
-- Why this exists
-- ───────────────
-- These three modules audit ONE page. Until now a project run audited the
-- primary domain and stopped, so a card's score described the homepage and was
-- read as describing the site.
--
-- They now run across the pages the crawl found, which needs a row per page:
--
--   • Size. One SEO & GEO report is 62-94 KB. Fifty of them is ~4.7 MB, and
--     project_module_runs.payload is capped at 400 KB precisely so one row
--     cannot balloon. Per-page rows also mean the dashboard reads none of them.
--
--   • Reading. The report UI shows one page at a time, so it should fetch one
--     page at a time rather than a megabyte to render a single URL.
--
--   • Honesty. Per-page rows let the parent run say "24 of 50 pages audited"
--     and let a page that failed be a failed page rather than a missing one.
--
-- The parent project_module_runs row keeps its meaning: its score is the mean of
-- its pages' scores, and score_basis says so. Nothing about the dashboard's
-- reads changes.
--
-- Additive and re-runnable. No RLS: every query carries its own project filter.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function platform_touch_updated_at()
returns trigger language plpgsql as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;


create table if not exists project_module_page_runs (
  id            uuid primary key default gen_random_uuid(),

  -- The module run this page belongs to. Cascades: a deleted run's pages are
  -- meaningless on their own.
  run_id        uuid not null references project_module_runs(id) on delete cascade,
  -- Denormalised so a page can be read and authorised without joining up to the
  -- parent. This app has no RLS; the filter in the query IS the tenancy check.
  project_id    uuid not null references crawl_projects(id) on delete cascade,
  module_key    text not null,

  url           text not null,
  -- Where this page came from, so a reader can tell a crawled page from one
  -- somebody configured by hand.
  source        text not null default 'crawl',
  -- Position in the audit order, kept so "the first 24 of 50" is reproducible
  -- rather than a set nobody can reconstruct.
  ordinal       integer,

  status        text not null default 'running',

  -- This page's own score, from the module's own methodology. NULL when the
  -- module does not score (on-page reports pass/fail checks) — never 0, which
  -- would drag a site average down for a page that was never scored at all.
  score         numeric,
  score_max     numeric,
  band          text,

  counts        jsonb not null default '{}'::jsonb,
  findings      jsonb not null default '[]'::jsonb,

  -- The module's OWN report for this page, so its report UI renders exactly what
  -- an individual run renders. This is the big column, and it is only ever read
  -- one row at a time.
  payload       jsonb,
  payload_truncated boolean not null default false,

  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'pmpr_status_check') then
    alter table project_module_page_runs add constraint pmpr_status_check
      check (status in ('running', 'completed', 'failed', 'skipped', 'insufficient_data'));
  end if;

  -- Only the per-page modules write here. CrawlScope has its own tables, and
  -- competitor/hub_spoke are site-level by nature: there is no per-page
  -- competitor comparison or per-page cluster map.
  if not exists (select 1 from pg_constraint where conname = 'pmpr_module_check') then
    alter table project_module_page_runs add constraint pmpr_module_check
      check (module_key in ('seo_geo', 'on_page', 'agent_readiness'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pmpr_score_check') then
    alter table project_module_page_runs add constraint pmpr_score_check
      check (score is null or (score >= 0 and score <= coalesce(score_max, 100)));
  end if;

  -- One row per URL per run. A retry that double-inserted would silently skew
  -- the parent's mean.
  if not exists (select 1 from pg_constraint where conname = 'pmpr_run_url_unique') then
    alter table project_module_page_runs add constraint pmpr_run_url_unique
      unique (run_id, url);
  end if;
end
$mig$;

-- The report UI's read: this run's pages, in audit order.
create index if not exists idx_pmpr_run on project_module_page_runs (run_id, ordinal);

-- "How has this URL scored over time" — the per-page trend.
create index if not exists idx_pmpr_page_history
  on project_module_page_runs (project_id, module_key, url, created_at desc);

create index if not exists idx_pmpr_running
  on project_module_page_runs (status, started_at)
  where status = 'running';

drop trigger if exists trg_pmpr_touch on project_module_page_runs;
create trigger trg_pmpr_touch
  before update on project_module_page_runs
  for each row execute function platform_touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════════════════
-- select count(*) from project_module_page_runs;
-- select conname from pg_constraint where conrelid = 'project_module_page_runs'::regclass;
--
-- A site-level module must be refused:
--   insert into project_module_page_runs (run_id, project_id, module_key, url)
--   values ('<a real run id>', '<a real project id>', 'competitor', 'https://x.com');
--   -- expected: violates pmpr_module_check
--
-- Two rows for one URL in one run must be refused:
--   -- insert the same (run_id, url) twice
--   -- expected: violates pmpr_run_url_unique
--
-- Rollback (development only — discards per-page reports):
--   drop table if exists project_module_page_runs;
