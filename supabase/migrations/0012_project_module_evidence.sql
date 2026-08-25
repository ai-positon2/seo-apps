-- ═══════════════════════════════════════════════════════════════════════════
-- 0012 — Project-scoped module evidence (PRD phase 3, and the groundwork for 4)
--
-- Why this exists
-- ───────────────
-- Before this migration exactly one module could put evidence on a project's
-- dashboard: CrawlScope, because crawl_runs carries project_id. Every other
-- module was a request/response tool — it computed a result, returned JSON, and
-- kept nothing that a project could be looked up by. tool_runs tracked THAT a
-- tool ran (module, status, duration, actor) but has no project_id and no
-- normalised result, so five of the six cards on the audit profile could only
-- say "not connected to this project yet".
--
-- Two tables close that gap:
--
--   project_module_runs   one row per module execution against a project, with
--                         the module's OWN score (never a new one invented
--                         here — PRD §6.2) plus normalised findings the
--                         dashboard can render without re-running anything.
--
--   crawl_run_links       the internal link graph of a crawl. crawl_run_results
--                         stores outlinks/inlinks as COUNTS, which cannot
--                         reconstruct which page links to which, and §32
--                         forbids re-crawling inside an audit module. Hub-and-
--                         spoke needs the edges, so the crawler records them.
--                         Only crawls that run AFTER this migration have them.
--
-- Additive and re-runnable. Drops nothing, rewrites no existing row's meaning.
-- No RLS, consistent with the rest of this app: every query carries its own
-- workspace filter, and the service-role key never reaches the browser.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Shared helpers (0011 defines the same ones; both are idempotent) ────────
create or replace function platform_touch_updated_at()
returns trigger language plpgsql as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. project_module_runs
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One row per (project, module) execution. The latest terminal row per module is
-- what the audit profile reads.
--
-- On scores: `score` is whatever the module itself computes, and `score_basis`
-- names that methodology in words. A module with no rubric of its own stores
-- NULL — CrawlScope reports severity counts and has no 0-100 scale, and
-- inventing one to fill the ring would be exactly the new scoring methodology
-- PRD §6.2 rules out. NULL means "this module does not score", never zero.
create table if not exists project_module_runs (
  id            uuid primary key default gen_random_uuid(),

  project_id    uuid not null references crawl_projects(id) on delete cascade,
  -- Denormalised so every read can filter by workspace without a join. This app
  -- has no RLS: the filter in the query IS the tenancy check.
  workspace_id  uuid references workspaces(id) on delete set null,

  module_key    text not null,
  status        text not null default 'running',
  trigger       text not null default 'manual',

  -- What was actually measured. Recorded per run because a project's primary
  -- domain or country can change, and a stored result must stay interpretable
  -- against the inputs it was produced from.
  target_url    text,
  country_code  text,

  -- The module's own score. See the note above on why this is nullable.
  score         numeric,
  score_max     numeric,
  score_basis   text,
  band          text,

  -- Normalised for the dashboard: counts by severity, and the findings
  -- themselves in the same shape crawl_run_findings uses, so one card
  -- component renders either source.
  counts        jsonb not null default '{}'::jsonb,
  findings      jsonb not null default '[]'::jsonb,

  -- Trimmed module output, for drilling in without re-running. Capped by the
  -- writer, not here: a jsonb column will happily store megabytes.
  payload       jsonb,
  payload_truncated boolean not null default false,

  -- The generic tracking row for the same execution, when there is one.
  tool_run_id   uuid references tool_runs(id) on delete set null,

  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  created_by    uuid references app_users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);

do $mig$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'project_module_runs_status_check'
  ) then
    alter table project_module_runs add constraint project_module_runs_status_check
      check (status in ('running', 'completed', 'failed', 'cancelled', 'insufficient_data'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'project_module_runs_module_check'
  ) then
    -- Closed vocabulary, matching MODULES in server/modules/projects/overview.js.
    -- 'technical' is absent on purpose: CrawlScope has its own richer tables and
    -- writes nothing here, so allowing it would invite two sources of truth.
    alter table project_module_runs add constraint project_module_runs_module_check
      check (module_key in ('on_page', 'seo_geo', 'agent_readiness', 'competitor', 'hub_spoke'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'project_module_runs_score_check'
  ) then
    alter table project_module_runs add constraint project_module_runs_score_check
      check (score is null or (score >= 0 and score <= coalesce(score_max, 100)));
  end if;

  -- A score without a stated basis is a number nobody can defend later.
  if not exists (
    select 1 from pg_constraint where conname = 'project_module_runs_score_basis_check'
  ) then
    alter table project_module_runs add constraint project_module_runs_score_basis_check
      check (score is null or score_basis is not null);
  end if;
end
$mig$;

-- The dashboard's only read pattern: newest terminal run for one module of one
-- project.
create index if not exists idx_pmr_project_module
  on project_module_runs (project_id, module_key, created_at desc);

create index if not exists idx_pmr_workspace
  on project_module_runs (workspace_id, created_at desc);

-- The sweeper's read pattern: rows left 'running' by a restart.
create index if not exists idx_pmr_running
  on project_module_runs (status, started_at)
  where status = 'running';

drop trigger if exists trg_pmr_touch on project_module_runs;
create trigger trg_pmr_touch
  before update on project_module_runs
  for each row execute function platform_touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. crawl_run_links — the internal link graph
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hub-and-spoke asks "which pages cluster around which hub", which is a
-- question about edges. crawl_run_results has outlinks/inlinks as integers,
-- and a count cannot answer it.
--
-- Internal edges only. External links are already status-checked per result row
-- and would multiply this table for no clustering value.
--
-- bigint identity rather than uuid: this is the one high-cardinality table here
-- (pages x links-per-page), and it is only ever read by run_id.
create table if not exists crawl_run_links (
  id          bigint generated by default as identity primary key,
  run_id      uuid not null references crawl_runs(id) on delete cascade,
  project_id  uuid references crawl_projects(id) on delete set null,
  from_url    text not null,
  to_url      text not null,
  anchor      text,
  rel         text,
  nofollow    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists idx_crawl_run_links_run on crawl_run_links (run_id);
create index if not exists idx_crawl_run_links_to  on crawl_run_links (run_id, to_url);
create index if not exists idx_crawl_run_links_from on crawl_run_links (run_id, from_url);


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Audit-event vocabulary — deliberately NOT constrained here
-- ═══════════════════════════════════════════════════════════════════════════
-- Module runs are auditable, so three actions are added to ACTIONS in
-- server/services/auditEvents.js. No CHECK constraint is added to
-- audit_events.action, and that is on purpose:
--
--   • 0011 left the column unconstrained for exactly this reason. The closed
--     vocabulary lives in the service, which is where writes are composed.
--   • A DB-side list has to be migrated in lockstep with the code. Get it out
--     of step and every audit write fails — and audit writes are deliberately
--     fire-and-forget (services/auditEvents.js), so the failure would be
--     silent: actions would keep succeeding while the trail quietly stopped
--     recording them. A silent audit gap is worse than an unconstrained column.
--
-- The trail's integrity comes from the append-only trigger 0011 installed, which
-- rejects UPDATE and DELETE. That is the property worth enforcing in SQL.

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification (run by hand after applying)
-- ═══════════════════════════════════════════════════════════════════════════
-- select count(*) from project_module_runs;
-- select count(*) from crawl_run_links;
-- select conname from pg_constraint where conrelid = 'project_module_runs'::regclass;
--
-- A score with no basis must be refused:
--   insert into project_module_runs (project_id, module_key, score)
--   values ('00000000-0000-0000-0000-000000000000', 'seo_geo', 70);
--   -- expected: violates project_module_runs_score_basis_check
--
-- Rollback (development only — drops stored evidence):
--   drop table if exists crawl_run_links;
--   drop table if exists project_module_runs;
--   -- Nothing to revert on audit_events: no constraint was added (see section 3).
