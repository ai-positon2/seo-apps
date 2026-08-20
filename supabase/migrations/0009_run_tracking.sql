-- ═══════════════════════════════════════════════════════════════════════════
-- Run tracking — every module records what it ran, for whom, and in which
-- workspace. Extends the tool_runs table stubbed out in 0008 (which nothing
-- wrote to) into the shape the tracking middleware actually needs, and gives
-- every user a personal workspace so a run always has a workspace to land in.
--
-- Writers:  server/middleware/runTracking.js (generic) + the three modules
--           whose work outlives the HTTP response (see req.run.finish()).
-- Readers:  server/routes/runs.js → client/src/pages/RunsPage.jsx
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Personal ("primary user") workspaces ────────────────────────────────────
-- Every run is workspace-scoped, so every user needs at least one workspace
-- without having to create one by hand. The personal workspace is created on
-- demand at first run (workspaceContext.resolveWorkspaceId) and is owned by —
-- created_by + an 'owner' membership row — the user it belongs to. At most one
-- per user, enforced by the partial unique index rather than by app code.
alter table workspaces add column if not exists is_personal boolean not null default false;

create unique index if not exists uq_workspaces_personal_owner
  on workspaces (created_by) where is_personal;

-- ── tool_runs ───────────────────────────────────────────────────────────────
-- 0008 created this table with the bare minimum. These columns are what the
-- middleware captures for every tracked request.
alter table tool_runs add column if not exists action           text;    -- 'run' | 'export' | 'save' | …
alter table tool_runs add column if not exists label            text;    -- human summary: the URL/keyword/client the run was for
alter table tool_runs add column if not exists error            text;
alter table tool_runs add column if not exists duration_ms      integer;
alter table tool_runs add column if not exists actor_email      text;    -- denormalized so the runs list needs no join
alter table tool_runs add column if not exists request_method   text;
alter table tool_runs add column if not exists request_path     text;
alter table tool_runs add column if not exists input_truncated  boolean not null default false;
alter table tool_runs add column if not exists output_truncated boolean not null default false;
alter table tool_runs add column if not exists updated_at       timestamptz;

-- 'running' rows are closed out by the response (or by the module, for work
-- that outlives it). Anything still 'running' after the sweeper's cutoff —
-- server restart mid-run — is flipped to 'failed', never left dangling.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tool_runs_status_check'
  ) then
    alter table tool_runs add constraint tool_runs_status_check
      check (status in ('running', 'completed', 'failed', 'cancelled'));
  end if;
end $$;

-- The runs list is always workspace-scoped and newest-first — already covered
-- by 0008's idx_tool_runs_workspace (workspace_id, created_at desc). This adds
-- only the tool-filtered variant of that query.
create index if not exists idx_tool_runs_workspace_tool on tool_runs (workspace_id, tool_id, created_at desc);
create index if not exists idx_tool_runs_tool_created      on tool_runs (tool_id, created_at desc);
-- Partial index for the stale-run sweeper, which only ever scans 'running'.
create index if not exists idx_tool_runs_running on tool_runs (created_at) where status = 'running';
