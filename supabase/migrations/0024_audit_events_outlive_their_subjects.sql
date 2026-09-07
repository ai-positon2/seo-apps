-- ═══════════════════════════════════════════════════════════════════════════
-- 0024 — append-only tables keep their references when subjects are deleted
--
-- NUMBERING: this shipped as 0023 and was applied to at least one database
-- under that name before origin/unified-app turned out to have its own 0023
-- (crawl_run_finding_instances). Renumbered to 0024 so the sequence has one
-- meaning; the two are independent — this drops foreign keys on audit_events
-- and admin_limit_policies, that one adds a table — so the order they ran in
-- does not matter, and a database that already ran this under the old name
-- needs nothing further. `drop constraint if exists` makes it a no-op on a
-- re-run either way.
--
-- Why this exists
-- ────────────────
-- 0011 gave audit_events two rules that cancel each other out:
--
--   L181-183   workspace_id / project_id / actor_user_id
--              ... references <parent>(id) ON DELETE SET NULL
--   L203-204   create trigger audit_events_append_only
--                before update or delete on audit_events
--                for each row execute function platform_reject_mutation();
--
-- ON DELETE SET NULL is implemented as an UPDATE on the child row. The
-- append-only trigger rejects UPDATE. So the referential action can never
-- fire, and the parent delete fails with:
--
--   audit_events is append-only: UPDATE rejected. Write a new row instead.
--
-- The practical consequence is that NO row in crawl_projects, workspaces or
-- app_users could ever be deleted once a single audit event referenced it —
-- which is immediately, because creating any of them writes one. Deleting a
-- project was impossible.
--
-- This went unnoticed for eleven migrations because nothing ever tried. Every
-- "delete" in the product is a soft delete: crawl_projects.lifecycle_status
-- moves to 'deleted' and the row stays. The contradiction only surfaced when
-- store.purgeProject() attempted a real DELETE.
--
-- What this changes, and why this direction
-- ──────────────────────────────────────────
-- The three foreign keys are dropped. The columns stay exactly as they are —
-- same names, same uuid type, same indexes — they simply stop being enforced
-- references.
--
-- The trigger is NOT touched. It is the half of the pair that is correct.
--
-- That choice is not just about unblocking the delete. ON DELETE SET NULL is
-- the wrong behaviour for an audit trail on its own terms: it means that at
-- the exact moment a project, workspace or user is deleted — the moment the
-- trail matters most — every event about it silently loses the identifier that
-- made it findable. The rows survive as unattributable orphans, and the
-- question "what happened to project X" becomes unanswerable. Keeping the raw
-- uuid preserves the trail: there is no longer a row to join to, which is the
-- truth, but every event for that id can still be found.
--
-- The alternative considered and rejected: teach platform_reject_mutation() to
-- permit an UPDATE that only nulls a foreign key. That keeps referential
-- integrity, but it puts a documented hole in an append-only guarantee written
-- for PRD §17.7, and it still destroys the event-to-subject link. It trades
-- the more valuable property for the less valuable one.
--
-- What this does NOT do
-- ──────────────────────
-- It does not delete anything, and it does not make any delete cascade
-- further. Callers still decide what to remove; see store.purgeProject(),
-- which deletes crawl_runs explicitly precisely BECAUSE its own FK is
-- ON DELETE SET NULL and would otherwise leave the crawl history orphaned and
-- indistinguishable from ad-hoc one-off crawls.
--
-- The fourth instance
-- ─────────────────────
-- admin_limit_policies carries the same append-only trigger (0011 L245-246)
-- and the same kind of key:
--
--   admin_limit_policies.created_by  references app_users(id) ON DELETE SET NULL
--
-- It is fixed here too. It was going to be left out as out-of-scope — nothing
-- in the product deletes an app_users row today — but that reasoning does not
-- survive being written down: the defect is identical, the fix is one line,
-- and the alternative is a known-broken constraint sitting behind a comment
-- explaining that it is known to be broken. Deleting a user would have failed
-- exactly the way deleting a project did, with the same baffling error.
--
-- server/services/__tests__/appendOnlySchema.test.js enforces the whole
-- invariant statically from here on, and found this one.
-- ═══════════════════════════════════════════════════════════════════════════

-- Dropped by their generated names. Postgres names an inline `references`
-- constraint <table>_<column>_fkey, and `if exists` keeps this file safe to
-- re-run and safe on a database where 0011 was applied by hand under different
-- names — in which case the checks at the bottom will still catch it.
alter table audit_events drop constraint if exists audit_events_project_id_fkey;
alter table audit_events drop constraint if exists audit_events_workspace_id_fkey;
alter table audit_events drop constraint if exists audit_events_actor_user_id_fkey;
alter table admin_limit_policies drop constraint if exists admin_limit_policies_created_by_fkey;

-- The columns and their indexes are untouched and still carry the same values.
-- Restated here so the intent is unmistakable to anyone reading a diff: this
-- migration removes enforcement, not data.
comment on column audit_events.project_id is
  'The project this event concerned. Not a foreign key: an audit row outlives '
  'its subject, and this id stays readable after the project is deleted. See '
  'migration 0023.';
comment on column audit_events.workspace_id is
  'The workspace this event concerned. Not a foreign key — see 0023.';
comment on column audit_events.actor_user_id is
  'The user who acted. Not a foreign key — see 0023.';
comment on column admin_limit_policies.created_by is
  'The user who set this policy. Not a foreign key — see 0023.';

-- ── Verification ───────────────────────────────────────────────────────────
-- Run after applying. Each must give the stated answer.
--
--   -- no foreign keys left on either append-only table (the whole point)
--   select conrelid::regclass, conname from pg_constraint
--    where conrelid in ('audit_events'::regclass, 'admin_limit_policies'::regclass)
--      and contype = 'f';                                                -- 0 rows
--
--   -- the trigger is still there and still refuses edits (must raise)
--   -- update audit_events set action = 'x' where id = (select min(id) from audit_events);
--
--   -- a project row can now actually be deleted. Against a throwaway project
--   -- ONLY — this is the real thing, and store.purgeProject() is the supported
--   -- path because it removes the crawl history first:
--   -- delete from crawl_projects where id = '<throwaway-project-uuid>';
--
--   -- audit rows for a purged project are still findable by its id
--   select count(*) from audit_events where project_id = '<purged-project-uuid>';
--
-- Rollback: re-add the three constraints. Note that doing so restores the
-- contradiction — project, workspace and user deletion all become impossible
-- again — so it is only safe on a database where nothing has been purged since:
--
--   alter table audit_events add constraint audit_events_project_id_fkey
--     foreign key (project_id) references crawl_projects(id) on delete set null;
--   alter table audit_events add constraint audit_events_workspace_id_fkey
--     foreign key (workspace_id) references workspaces(id) on delete set null;
--   alter table audit_events add constraint audit_events_actor_user_id_fkey
--     foreign key (actor_user_id) references app_users(id) on delete set null;
--   alter table admin_limit_policies add constraint admin_limit_policies_created_by_fkey
--     foreign key (created_by) references app_users(id) on delete set null;
--
-- Any audit row whose project_id now points at a deleted project would make
-- that ALTER fail, which is the correct outcome: it means the trail is holding
-- a reference the constraint would have destroyed.
