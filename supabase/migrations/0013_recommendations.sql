-- ═══════════════════════════════════════════════════════════════════════════
-- 0013 — Recommendations and the approval workflow (PRD phase 6)
--
-- Why this exists
-- ───────────────
-- Every module now stores findings against a project (0012), but a finding is an
-- observation: "47 pages have no meta description". What a client agrees to, and
-- what somebody is accountable for shipping, is a different object with a
-- different lifecycle — and §7.2 already carves out the roles for it
-- (editRecommendation, approveRecommendation, recordShippedDate,
-- overrideMachineOutcome). This table is that object.
--
-- The lifecycle is deliberately narrow:
--
--   draft ──▶ proposed ──▶ approved ──▶ shipped
--                   └────▶ rejected
--
-- What the design refuses to do:
--
--   • No edit-in-place of an approval. Approving records WHO approved and WHEN,
--     and a later change to the text does not silently inherit that approval —
--     material edits send it back to 'proposed' (enforced in the service, which
--     is where "material" can be judged).
--
--   • No machine-approved recommendations. A machine may propose; approval is a
--     person accepting responsibility for the advice. The approved_by column is
--     NOT NULL for anything in 'approved' or 'shipped', so an automated path
--     cannot quietly become the approver.
--
--   • No deletion. A rejected recommendation stays, with its reason. "Why didn't
--     we do the thing the audit suggested" is exactly the question a retro asks.
--
-- Additive and re-runnable. No RLS: every query carries its own workspace filter.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function platform_touch_updated_at()
returns trigger language plpgsql as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;


create table if not exists recommendations (
  id              uuid primary key default gen_random_uuid(),

  project_id      uuid not null references crawl_projects(id) on delete cascade,
  workspace_id    uuid references workspaces(id) on delete set null,

  -- Where it came from. A recommendation raised by hand has module_key null and
  -- source_run_id null, which is a legitimate state: not every good idea comes
  -- out of an audit.
  module_key      text,
  source_run_id   uuid references project_module_runs(id) on delete set null,
  rule_id         text,

  title           text not null,
  body            text,

  -- 'priority' is the team's judgement of what to do first. It is NOT derived
  -- from severity: an error affecting one page can matter less than a warning
  -- affecting six hundred, and pretending a machine can rank business impact is
  -- the kind of false precision §6.2 is written against.
  priority        text not null default 'medium',
  effort          text,

  status          text not null default 'draft',

  -- Who did what. Recorded per transition rather than as a single "last actor",
  -- because "who approved this" must survive somebody later marking it shipped.
  proposed_by     uuid references app_users(id) on delete set null,
  proposed_at     timestamptz,
  approved_by     uuid references app_users(id) on delete set null,
  approved_at     timestamptz,
  rejected_by     uuid references app_users(id) on delete set null,
  rejected_at     timestamptz,
  rejection_reason text,
  shipped_by      uuid references app_users(id) on delete set null,
  shipped_at      timestamptz,

  -- The findings this advice rests on, copied at proposal time. A snapshot, not
  -- a join: the next crawl changes the live findings, and an approval has to
  -- stay interpretable against what was true when it was given.
  evidence        jsonb not null default '{}'::jsonb,

  created_by      uuid references app_users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz
);

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'recommendations_status_check') then
    alter table recommendations add constraint recommendations_status_check
      check (status in ('draft', 'proposed', 'approved', 'rejected', 'shipped'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'recommendations_priority_check') then
    alter table recommendations add constraint recommendations_priority_check
      check (priority in ('low', 'medium', 'high', 'urgent'));
  end if;

  -- An approval with no approver is the thing this table exists to prevent.
  if not exists (select 1 from pg_constraint where conname = 'recommendations_approved_by_check') then
    alter table recommendations add constraint recommendations_approved_by_check
      check (status not in ('approved', 'shipped') or approved_by is not null);
  end if;

  -- A rejection with no reason is not a decision anybody can learn from.
  if not exists (select 1 from pg_constraint where conname = 'recommendations_rejection_check') then
    alter table recommendations add constraint recommendations_rejection_check
      check (status <> 'rejected' or (rejected_by is not null and rejection_reason is not null));
  end if;

  -- Shipped means it went live on a date. Without one, "shipped" is a feeling.
  if not exists (select 1 from pg_constraint where conname = 'recommendations_shipped_check') then
    alter table recommendations add constraint recommendations_shipped_check
      check (status <> 'shipped' or shipped_at is not null);
  end if;
end
$mig$;

-- The board's read pattern: one project's recommendations grouped by status.
create index if not exists idx_recommendations_project
  on recommendations (project_id, status, created_at desc);

create index if not exists idx_recommendations_workspace
  on recommendations (workspace_id, created_at desc);

-- "What came out of this audit run" — the link back to the evidence.
create index if not exists idx_recommendations_source_run
  on recommendations (source_run_id)
  where source_run_id is not null;

drop trigger if exists trg_recommendations_touch on recommendations;
create trigger trg_recommendations_touch
  before update on recommendations
  for each row execute function platform_touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════════════════
-- An approval with no approver must be refused:
--   insert into recommendations (project_id, title, status)
--   values ('<a real project id>', 'x', 'approved');
--   -- expected: violates recommendations_approved_by_check
--
-- A rejection with no reason must be refused:
--   insert into recommendations (project_id, title, status, rejected_by)
--   values ('<a real project id>', 'x', 'rejected', null);
--   -- expected: violates recommendations_rejection_check
--
-- Rollback (development only — discards decisions, which is the point of not
-- doing this in production):
--   drop table if exists recommendations;
