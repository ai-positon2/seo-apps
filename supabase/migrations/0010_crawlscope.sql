-- ═══════════════════════════════════════════════════════════════════════════
-- CrawlScope — hosted technical-SEO crawler with scheduled crawls.
--
-- Ported from the standalone CrawlScope app, which shipped this schema as
-- 0001_init.sql + 0002_projects.sql. Three things are deliberately different
-- here, and all three follow how the rest of this app already works:
--
--  1. Identity. CrawlScope keyed every owner column to Supabase Auth
--     (auth.users) and enforced tenancy with RLS on `auth.uid()`. This app has
--     no Supabase Auth session — users sign in with Google against `app_users`
--     and carry a JWT we sign ourselves — so `auth.uid()` would always be NULL
--     and an RLS-scoped read could never return a row. Owners therefore
--     reference app_users(id), and tenancy is enforced in the query layer
--     (server/modules/crawlScope/db/repo.js always filters on `owner`), exactly
--     like tool_runs in 0009. No RLS policies are created.
--
--  2. Table names. CrawlScope's `runs`, `projects` and `profiles` are generic
--     enough to be actively confusing next to this app's `tool_runs` and
--     `user_profiles`, so everything is prefixed `crawl_`. Its `profiles` table
--     (a 1:1 shadow of auth.users) is dropped entirely — `app_users` and
--     `user_profiles` already do that job.
--
--  3. Workspaces. Every row records the workspace it was created in, matching
--     tool_runs, so crawl activity can be reported alongside everything else.
--     Access is still scoped by `owner` (a crawl project belongs to the person
--     who made it, as it did in CrawlScope), NOT by workspace — making projects
--     workspace-shared would be a behaviour change, not a port.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- updated_at ────────────────────────────────────────────────────────────────
-- Defined up front because two tables below attach a trigger to it
-- (crawl_projects and crawl_finding_reviews), and Postgres resolves the
-- function at CREATE TRIGGER time — so it has to exist before either.
--
-- Namespaced function name: this is the first trigger in this app's schema, and
-- a bare `touch_updated_at` is the kind of name a later migration would collide
-- with by accident.
create or replace function crawl_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- A project is a saved crawl configuration + recipients + a recurrence.
-- (CrawlScope called this `schedules` in 0001 and renamed it in 0002; there is
-- nothing to rename here, so it arrives already named `crawl_projects`.)
create table if not exists crawl_projects (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null references app_users(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete set null,
  name         text,
  url          text not null,
  options      jsonb not null default '{}'::jsonb,
  cron         text not null,                 -- standard 5-field cron, evaluated in `timezone`
  timezone     text not null default 'UTC',   -- IANA name, e.g. America/Chicago
  recipients   text[] not null default '{}',  -- report email recipients
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  next_run_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on column crawl_projects.cron is
  'standard 5-field cron, evaluated in the row''s timezone';
comment on column crawl_projects.timezone is
  'IANA timezone name (e.g. America/Chicago) used to evaluate cron';

create table if not exists crawl_runs (
  id               uuid primary key default gen_random_uuid(),
  owner            uuid not null references app_users(id) on delete cascade,
  workspace_id     uuid references workspaces(id) on delete set null,
  project_id       uuid references crawl_projects(id) on delete set null,
  url              text not null,
  options          jsonb not null default '{}'::jsonb,
  status           text not null default 'queued',
  progress         jsonb not null default '{}'::jsonb,
  error            text,
  summary          jsonb,               -- findings + counts + robotsStatus
  site_diagnostics jsonb,
  trigger          text not null default 'manual',
  scheduled_for    timestamptz,         -- intended fire slot; NULL for manual/on-demand
  heartbeat_at     timestamptz,         -- liveness stamp from the executing worker
  worker_id        text,                -- which worker holds it
  attempts         integer not null default 0,
  report_path      text,                -- Storage object path of the built .xlsx
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

comment on column crawl_runs.scheduled_for is
  'the schedule slot this run was created for; NULL for manual and on-demand runs';
comment on column crawl_runs.heartbeat_at is
  'last liveness stamp from the executing worker; drives stale-run recovery';
comment on column crawl_runs.report_path is
  'Storage path of the generated .xlsx, so downloads do not rebuild it';

-- Named constraints, added guardedly so this migration stays re-runnable.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crawl_runs_status_check') then
    alter table crawl_runs add constraint crawl_runs_status_check
      check (status in ('queued','running','paused','completed','failed','stopped'));
  end if;
end $$;

-- 'initial' marks the immediate first crawl of a new project and on-demand
-- "run now" crawls. Both must be claimable by the worker so they get emailed,
-- unlike 'manual' runs, which execute in the web process.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crawl_runs_trigger_check') then
    alter table crawl_runs add constraint crawl_runs_trigger_check
      check (trigger in ('manual','schedule','initial'));
  end if;
end $$;

-- Exactly-once enqueue per (project, slot). Without this, two worker replicas
-- ticking the same due project would both insert a run, producing a duplicate
-- crawl AND a duplicate client email.
--
-- Deliberately NOT a partial index: PostgREST emits `ON CONFLICT (project_id,
-- scheduled_for)` with no WHERE clause, and Postgres cannot infer a partial
-- index from that. Postgres's default NULLS DISTINCT means manual/on-demand
-- runs (scheduled_for NULL) are left entirely unconstrained.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crawl_runs_project_slot_uniq') then
    alter table crawl_runs add constraint crawl_runs_project_slot_uniq
      unique (project_id, scheduled_for);
  end if;
end $$;

-- Per-URL rows streamed during the crawl. The full record lives in `data`; a
-- few hot columns are promoted for filtering and report generation.
create table if not exists crawl_run_results (
  id           bigint generated always as identity primary key,
  run_id       uuid not null references crawl_runs(id) on delete cascade,
  owner        uuid not null references app_users(id) on delete cascade,
  url          text not null,
  status       integer,
  content_type text,
  indexability text,
  depth        integer,
  data         jsonb not null,
  created_at   timestamptz not null default now()
);

create table if not exists crawl_run_findings (
  id        bigint generated always as identity primary key,
  run_id    uuid not null references crawl_runs(id) on delete cascade,
  owner     uuid not null references app_users(id) on delete cascade,
  rule_id   text not null,
  severity  text,
  category  text,
  count     integer not null default 0,
  detail    jsonb
);

-- Issue review ──────────────────────────────────────────────────────────────
-- New in this app, not a port. In the standalone CrawlScope the Issue Review
-- screen kept status and notes on in-memory objects only: they vanished on
-- reload, and in the hosted path they never even reached the downloaded
-- workbook (which is rebuilt server-side from crawl_runs.summary, where no
-- review state exists). That made the whole screen decorative once it left
-- Electron, so the state is persisted here instead.
--
-- Keyed per FINDING INSTANCE, which is not what crawl_run_findings holds —
-- that table is a per-rule rollup carrying a count. A finding instance is
-- identified by analyzer.js's findingId(): sha1(ruleId|url|targetUrl|detail),
-- truncated to 16 hex chars. That is derived from the crawl evidence rather
-- than an array position, so it stays stable across reloads and re-fetches,
-- which is exactly what a durable review needs.
create table if not exists crawl_finding_reviews (
  run_id         uuid not null references crawl_runs(id) on delete cascade,
  finding_id     text not null,
  owner          uuid not null references app_users(id) on delete cascade,
  -- Denormalized so the review screen can count and filter by rule without
  -- re-deriving every finding id from the summary blob.
  rule_id        text not null,
  review_status  text not null default 'Needs review',
  reviewer_notes text,
  reviewed_by    uuid references app_users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  primary key (run_id, finding_id)
);

-- The four statuses the review UI offers. Anything else is a bug, not a value.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crawl_finding_reviews_status_check') then
    alter table crawl_finding_reviews add constraint crawl_finding_reviews_status_check
      check (review_status in ('Needs review','Confirmed issue','False positive','Resolved'));
  end if;
end $$;

drop trigger if exists crawl_finding_reviews_touch on crawl_finding_reviews;
create trigger crawl_finding_reviews_touch before update on crawl_finding_reviews
  for each row execute function crawl_touch_updated_at();

-- Indexes ───────────────────────────────────────────────────────────────────
create index if not exists idx_crawl_projects_owner     on crawl_projects (owner);
create index if not exists idx_crawl_projects_due       on crawl_projects (enabled, next_run_at);
create index if not exists idx_crawl_projects_workspace on crawl_projects (workspace_id, created_at desc);

create index if not exists idx_crawl_runs_owner_created on crawl_runs (owner, created_at desc);
create index if not exists idx_crawl_runs_project       on crawl_runs (project_id);
create index if not exists idx_crawl_runs_status        on crawl_runs (status);
create index if not exists idx_crawl_runs_workspace     on crawl_runs (workspace_id, created_at desc);
-- The reaper scans for running runs with a stale heartbeat.
create index if not exists idx_crawl_runs_heartbeat     on crawl_runs (status, heartbeat_at);

create index if not exists idx_crawl_run_results_run  on crawl_run_results (run_id);
create index if not exists idx_crawl_run_findings_run on crawl_run_findings (run_id);

-- The review screen loads one run's reviews at a time, and filters by rule.
create index if not exists idx_crawl_finding_reviews_run_rule on crawl_finding_reviews (run_id, rule_id);

-- Triggers ──────────────────────────────────────────────────────────────────
-- crawl_touch_updated_at() is defined at the top of this file, before the
-- tables, because CREATE TRIGGER resolves it immediately.
drop trigger if exists crawl_projects_touch on crawl_projects;
create trigger crawl_projects_touch before update on crawl_projects
  for each row execute function crawl_touch_updated_at();

-- Report storage ────────────────────────────────────────────────────────────
-- This file used to end with:
--
--   insert into storage.buckets (id, name, public)
--   values ('reports', 'reports', false) on conflict (id) do nothing;
--
-- creating a private Supabase Storage bucket for the audit workbook, which was
-- then served through a short-lived signed URL.
--
-- REMOVED, because it made the schema impossible to rebuild. `storage.buckets`
-- is a Supabase-managed table; this app now speaks to plain Postgres, where
-- that relation does not exist, so applying this migration to a new database
-- failed at the last statement with `relation "storage.buckets" does not
-- exist`. Every existing database predates the move and already has the schema,
-- so the breakage was invisible — until a fresh database was created and the
-- whole chain stopped at 0010.
--
-- Nothing reads the bucket any more. Workbooks are written under the data root
-- (see modules/crawlScope/run/report.js, which says so at the top), and
-- REPORT_STORAGE_BUCKET is now a directory name rather than a bucket id. The
-- statement was dead in every environment before it was deleted here.
