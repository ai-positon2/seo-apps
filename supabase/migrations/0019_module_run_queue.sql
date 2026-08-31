-- ── 0019: a real queue for module runs, and per-project schedules ───────────
--
-- Hand-applied, idempotent, no down-migration (matching every migration here).
--
-- WHY THIS EXISTS
--
-- AI Visibility at ten clients is ~2,800 captures a day. `run.js` measures
-- prompt × surface serially at 25–110s each, which is 19–85 hours of wall clock
-- — it does not fit in a day, let alone a maintenance window. Fitting it needs
-- work that can be claimed by more than one worker, and that needs a queue.
--
-- `project_module_runs` is already the run row for every module, but it has no
-- `queued` status and no way for a worker to take ownership: work is currently
-- fire-and-forget through the `detached: true` path. A process that dies mid-run
-- leaves a row stuck in `running` for ever, and nothing retries it.
--
-- This adds the same claim/heartbeat/reaper mechanism CrawlScope already runs
-- (`modules/crawlScope/db/repo.js`), rather than inventing a second one. That
-- design is load-bearing in three places and each is repeated here as a comment
-- so the next reader does not have to go and find it.
--
-- WHAT THIS DOES NOT DO
--
-- It does not move any module onto the queue. Every existing caller keeps
-- writing `status = 'running'` directly and is unaffected — `queued` is simply
-- now a legal value. Enqueueing is opt-in, per module, in application code.
--
-- ── PRE-FLIGHT ──────────────────────────────────────────────────────────────
-- Run this first. It must return zero rows; a non-empty result means some other
-- process is already using one of these column names for something else.
--
--   select column_name from information_schema.columns
--    where table_name = 'project_module_runs'
--      and column_name in ('worker_id','heartbeat_at','attempts','scheduled_for','claimed_at');
--
--   select 1 from information_schema.tables where table_name = 'project_module_schedules';

begin;

-- ── 1. Widen the status vocabulary ─────────────────────────────────────────
--
-- `queued` is new. Nothing writes it yet, so no existing row changes and no
-- existing reader sees a status it does not recognise — but a reader that
-- filters `status = 'running'` to mean "in flight" will need to include
-- `queued` once a module is actually enqueued. The ones that matter today
-- (overview.js, moduleDetail.js) treat anything non-terminal as in flight.

do $mig$
begin
  if exists (
    select 1 from pg_constraint where conname = 'project_module_runs_status_check'
  ) then
    alter table project_module_runs drop constraint project_module_runs_status_check;
  end if;

  alter table project_module_runs add constraint project_module_runs_status_check
    check (status in (
      'queued', 'running', 'completed', 'failed', 'cancelled', 'insufficient_data'
    ));
end
$mig$;

-- ── 2. Ownership and retry columns ─────────────────────────────────────────

alter table project_module_runs
  -- Which worker holds this row. Informational for operators; the CAS on
  -- `status` is what actually prevents two workers running the same job.
  add column if not exists worker_id text,

  -- Stamped periodically by the worker executing the run. Its ABSENCE past a
  -- threshold is how a dead worker is detected — a run cannot report its own
  -- crash, so the only reliable signal is the heartbeat stopping.
  add column if not exists heartbeat_at timestamptz,

  -- How many times this run has been claimed. The reaper increments it, and a
  -- run that has burned its attempts is failed rather than requeued for ever.
  -- Poison work must not be able to occupy a worker permanently.
  add column if not exists attempts integer not null default 0,

  -- When the run becomes eligible. The scheduler writes a future time; the
  -- claimer refuses anything still in the future. This is what lets work be
  -- enqueued now and run later, and what `staggerMinute` spreads.
  add column if not exists scheduled_for timestamptz,

  add column if not exists claimed_at timestamptz;

-- The claim query: oldest eligible queued row first.
--
-- Partial on `status = 'queued'` deliberately. The vast majority of rows in this
-- table are terminal and will never be claimed again; indexing them would grow
-- the index without bound for a query that can never return them.
create index if not exists idx_module_runs_claimable
  on project_module_runs (scheduled_for nulls first, created_at)
  where status = 'queued';

-- The reaper query: running rows whose heartbeat has gone quiet.
--
-- The NULL-heartbeat case matters more than it looks. In SQL,
-- `heartbeat_at < now() - interval` evaluates to NULL when the column is NULL,
-- and NULL is not true — so a row that was set running WITHOUT a heartbeat would
-- be invisible to a reaper that only compared timestamps. The reaper has to
-- check `heartbeat_at is null` as a separate arm, and this index covers both.
create index if not exists idx_module_runs_stale
  on project_module_runs (heartbeat_at nulls first)
  where status = 'running';

comment on column project_module_runs.heartbeat_at is
  'Stamped by the executing worker. Absence past a threshold means the worker died — '
  'a run cannot report its own crash. NULL is a distinct case the reaper must test '
  'separately, because `heartbeat_at < x` is NULL (not true) for a NULL column.';

comment on column project_module_runs.attempts is
  'Claims so far. Bounded so poison work fails instead of occupying a worker for ever.';

-- ── 3. Per-project module schedules ────────────────────────────────────────
--
-- One row per (project, module) that runs on a cadence. Separate from
-- `crawl_projects.settings` because a scheduler polls this every minute and
-- must not read a wide, frequently-written jsonb blob to do it.

create table if not exists project_module_schedules (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references crawl_projects(id) on delete cascade,
  workspace_id  uuid references workspaces(id) on delete set null,
  module_key    text not null,

  enabled       boolean not null default false,

  -- A 5-field cron with `*` for day-of-month and month, as CrawlScope's
  -- shared/cron.js parses. The minute is expected to be a per-project stagger
  -- (FNV-1a over the project id) rather than :00 — otherwise every client fires
  -- on the same minute and the worker chews through them serially while each
  -- one waits.
  cron          text not null default '0 3 * * *',
  timezone      text not null default 'UTC',

  -- Computed by the scheduler from cron+timezone, so the poll is an indexed
  -- timestamp comparison rather than parsing every row's cron every minute.
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  last_run_id   uuid references project_module_runs(id) on delete set null,

  -- §Budget: a hard monthly ceiling in USD, per project. The scheduler stops and
  -- reports coverage honestly when it is hit — it does NOT silently measure a
  -- subset and present the result as though the whole set had been asked.
  -- NULL means no ceiling configured, which is not the same as zero.
  monthly_budget_usd numeric(10, 4),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One schedule per module per project. A second row would mean two cadences
-- racing to enqueue the same work.
create unique index if not exists uq_module_schedule
  on project_module_schedules (project_id, module_key);

-- The scheduler's own poll.
create index if not exists idx_module_schedule_due
  on project_module_schedules (next_run_at)
  where enabled;

do $mig$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'project_module_schedules_module_check'
  ) then
    alter table project_module_schedules add constraint project_module_schedules_module_check
      check (module_key in (
        'on_page', 'seo_geo', 'agent_readiness', 'competitor', 'hub_spoke',
        'ai_visibility', 'ai_visibility_prompts'
      ));
  end if;
end
$mig$;

drop trigger if exists trg_module_schedules_touch on project_module_schedules;
create trigger trg_module_schedules_touch
  before update on project_module_schedules
  for each row execute function platform_touch_updated_at();

-- ── 4. Retention: 12 months of raw payloads ────────────────────────────────
--
-- `ai_visibility_captures.raw` is the whole provider payload and is the largest
-- thing this module stores. The decision was 12 months, and the sweeper NULLS
-- the column rather than deleting the row: the capture itself is the evidence
-- every historical metric was computed from, and deleting it would rewrite
-- history. Only the bulky original response goes.
create index if not exists idx_captures_raw_sweep
  on ai_visibility_captures (captured_at)
  where raw is not null;

commit;

-- ── POST-APPLY VERIFICATION ────────────────────────────────────────────────
--
-- 1. `queued` is legal and the other statuses still are:
--      select conname, pg_get_constraintdef(oid) from pg_constraint
--       where conname = 'project_module_runs_status_check';
--
-- 2. No existing run was touched (every row should still be terminal):
--      select status, count(*) from project_module_runs group by status;
--
-- 3. The claim index is partial, not full:
--      select indexdef from pg_indexes where indexname = 'idx_module_runs_claimable';
--
-- 4. A second schedule for the same (project, module) is refused:
--      -- expect a unique violation on the second insert.
