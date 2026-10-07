-- ═══════════════════════════════════════════════════════════════════════════
-- Durable jobs for tool runs.
--
-- Long tool work (article enhancement, keyword research, image alt audits, …)
-- used to live in an in-memory Map behind a one-shot SSE token: a refresh, a
-- dropped connection or a deploy lost the job and its results. A job is now a
-- tool_runs row that does its work after the response, appends ordered events
-- a client can replay from any point (GET /api/runs/:id/events with
-- Last-Event-ID), and heartbeats so a restart is noticed within minutes
-- instead of being left at 'running'.
--
-- Writer: server/services/jobs.js   Reader: server/routes/runs.js
-- ═══════════════════════════════════════════════════════════════════════════

alter table tool_runs add column if not exists is_job              boolean not null default false;
alter table tool_runs add column if not exists progress            jsonb;
alter table tool_runs add column if not exists heartbeat_at        timestamptz;
alter table tool_runs add column if not exists cancel_requested_at timestamptz;

-- One row per event, in the order the job wrote them. `id` doubles as the SSE
-- event id, so a reconnecting client resumes exactly where it left off.
create table if not exists tool_run_events (
  id         bigserial primary key,
  run_id     uuid not null references tool_runs(id) on delete cascade,
  event      text not null,
  data       jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_tool_run_events_run on tool_run_events (run_id, id);

-- The interrupted-job sweep looks only at running jobs by heartbeat age.
create index if not exists idx_tool_runs_job_heartbeat
  on tool_runs (heartbeat_at)
  where is_job and status = 'running';
