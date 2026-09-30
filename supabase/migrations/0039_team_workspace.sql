-- ── One team workspace: everyone with a Position2 email shares it ──────────
--
-- Until now every user got a personal workspace on first use, and a project
-- lived in whichever workspace its creator happened to be "recording in". The
-- same client ended up as separate projects in several people's personal
-- workspaces (Riccobene in three, Acalvio in three, Gentle Dental in two — see
-- docs/design-audit/02-plan-one-client.md), each with its own crawl history.
--
-- From here on a workspace can name an email domain. Anyone who signs in with
-- that domain joins it automatically and works in it by default
-- (identityStore.ensureHomeWorkspace). Position2 is the first such workspace,
-- created on first use. A client company onboarded later gets a workspace of its
-- own the same way, made by a platform administrator.
--
-- What this migration does:
--   * workspaces.auto_join_domain  the email domain whose users join this
--     workspace. At most one ACTIVE workspace per domain.
--   * workspaces.merged_into / merged_at, and a 'merged' lifecycle status: a
--     workspace whose contents were moved into another one by
--     server/scripts/consolidateTeamWorkspace.js. The row stays, like a purged
--     one, so audit_events that name it still resolve.
--   * frees the personal-workspace slot of every purged workspace. The partial
--     unique index uq_workspaces_personal_owner covers `where is_personal`, so a
--     purged personal row kept that user from ever getting a new one, and
--     getPersonalWorkspace kept returning the purged row: a workspace the user
--     was no longer a member of, which made project creation 404 for them.
--
-- What it does NOT do: create the Position2 workspace or move anything into it.
-- The app creates the workspace on first sign-in; moving projects is the
-- reviewed script above, run by a person.
--
-- Rollback: drop the three columns and restore the old lifecycle CHECK (after
-- setting any 'merged' rows back to 'active'). The is_personal fix is not worth
-- reverting — it only affects rows nobody can use.

alter table workspaces add column if not exists auto_join_domain text;
alter table workspaces add column if not exists merged_into uuid references workspaces(id) on delete set null;
alter table workspaces add column if not exists merged_at   timestamptz;

do $mig$
begin
  -- Stored exactly as it is compared: lowercase, trimmed, no '@'.
  if not exists (select 1 from pg_constraint where conname = 'workspaces_auto_join_domain_check') then
    alter table workspaces add constraint workspaces_auto_join_domain_check
      check (auto_join_domain is null
          or (auto_join_domain = lower(btrim(auto_join_domain))
              and auto_join_domain <> ''
              and position('@' in auto_join_domain) = 0));
  end if;
end $mig$;

-- One active workspace per domain, so "which workspace does this email join"
-- always has one answer. Partial on 'active' so a merged or purged one does not
-- block its replacement.
create unique index if not exists uq_workspaces_auto_join_domain
  on workspaces (auto_join_domain)
  where auto_join_domain is not null and lifecycle_status = 'active';

-- 'merged' joins the lifecycle. Dropped and re-added rather than guarded by
-- name, because the name already exists with the old list.
alter table workspaces drop constraint if exists workspaces_lifecycle_status_check;
alter table workspaces add constraint workspaces_lifecycle_status_check
  check (lifecycle_status in ('active', 'pending_deletion', 'purged', 'merged'));

update workspaces
   set is_personal = false
 where is_personal
   and lifecycle_status = 'purged';

comment on column workspaces.auto_join_domain is
  'Email domain whose users join this workspace automatically on sign-in, and work in it by default (identityStore.ensureHomeWorkspace).';
comment on column workspaces.merged_into is
  'Set when this workspace''s contents were moved into another by scripts/consolidateTeamWorkspace.js; lifecycle_status is then ''merged''.';

-- ── Verification ────────────────────────────────────────────────────────────
--   -- no purged row still holds a personal slot
--   select count(*) from workspaces where is_personal and lifecycle_status = 'purged';   -- 0
--   -- at most one active workspace per domain
--   select auto_join_domain, count(*) from workspaces
--    where auto_join_domain is not null and lifecycle_status = 'active'
--    group by 1 having count(*) > 1;                                                     -- 0 rows
