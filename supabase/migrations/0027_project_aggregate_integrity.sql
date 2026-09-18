-- ═══════════════════════════════════════════════════════════════════════════
-- Project aggregate integrity — one writer, one invariant.
--
-- The product's Project spans two tables: crawl_projects holds the row,
-- project_domains holds the authoritative primary and competitor domains
-- (PRD §8.1, §30.6). Two endpoints used to create projects and only one wrote
-- both, so CrawlScope-created projects had no primary domain and no country.
-- They read back with primaryDomainSource 'legacy_url_column', rendered as
-- "Missing" in the projects screen, and nothing in the app could repair them.
--
-- The application side is fixed (modules/projects/store.js createProject is now
-- the only writer; crawlScope/db/repo.js createProject is deleted). This file
-- repairs the data and then makes the broken shape unrepresentable, so a third
-- writer cannot quietly reintroduce it:
--
--   1-3. backfill: personal workspaces, project workspaces, primary domains
--   4.   project_domains.workspace_id backfilled from its project
--   5.   both workspace_id columns become NOT NULL
--   6.   both workspace_id foreign keys become ON DELETE RESTRICT
--   7.   a deferred constraint trigger rejects a project with no primary domain
--
-- ── Why RESTRICT, and why this file has to fix the FKs ─────────────────────
-- crawl_projects.workspace_id was ON DELETE SET NULL (0010) while
-- project_domains.workspace_id was ON DELETE CASCADE (0011) — the same parent,
-- opposite rules. Deleting a workspace row therefore orphaned the project
-- (workspace_id → NULL, row survives) while destroying its domains outright:
-- precisely the unrecoverable state described above, manufactured by one DELETE.
--
-- SET NULL is also no longer legal once step 5 lands — a NOT NULL column cannot
-- be nulled by a foreign-key action, so the delete would fail with a confusing
-- not-null violation instead of a clear one. RESTRICT says what is actually
-- meant: a workspace holding projects cannot be deleted out from under them.
-- Nothing in the app does that. workspaceLifecycle.purge() deletes
-- crawl_projects first and then only MARKS the workspace row 'purged'
-- (see PURGE_ORDER), so this constraint never fires on the supported path — it
-- fires on the unsupported one, which is the point.
--
-- ── What this file does NOT do ─────────────────────────────────────────────
--   * No row is deleted. A project whose `url` will not parse cannot be given a
--     primary domain by backfill; it is REPORTED by the verification queries at
--     the bottom and by server/scripts/auditProjectIntegrity.js, and left alone.
--     Inventing a domain for it would be inventing evidence (§24.2).
--   * The step-7 trigger fires on INSERT into crawl_projects only. It constrains
--     new writes; it does not retroactively invalidate legacy rows, and it does
--     not police later domain edits — removeDomain already refuses to remove a
--     primary, and setPrimaryDomain retires and inserts in one transaction.
--
-- Re-runnable: every step is guarded and can be applied repeatedly.
-- Verification queries and rollback notes are at the bottom of the file.
-- ═══════════════════════════════════════════════════════════════════════════

-- pgcrypto is deliberately not created here — see the block at the top of
-- 0008_identity_workspaces.sql. Short version: gen_random_uuid() is core from
-- PG 13 on, nothing here uses any other pgcrypto function, and CREATE EXTENSION
-- needs a database-level privilege the RDS app role does not have.


-- ── 1. Personal workspaces for owners who have none ────────────────────────
-- A workspace-less project is adopted into its owner's personal workspace. Some
-- owners do not have one yet (it is created lazily, on first authenticated
-- request — see identityStore.ensurePersonalWorkspace), so a plain UPDATE has
-- nothing to point at. Create those first.
--
-- Mirrors ensurePersonalWorkspace: is_personal = true, created_by = the user,
-- plus an 'owner' membership row. The partial unique index on
-- workspaces(created_by) where is_personal keeps this to one per user even if
-- the file is re-run.
insert into workspaces (name, created_by, is_personal)
select distinct
       coalesce(nullif(split_part(u.email, '@', 1), ''), 'My') || '''s workspace',
       p.owner,
       true
  from crawl_projects p
  join app_users u on u.id = p.owner
 where p.workspace_id is null
   and not exists (
     select 1 from workspaces w
      where w.created_by = p.owner and w.is_personal
   );

-- The owner membership. Separate statement so a workspace that already existed
-- but somehow lost its membership row is repaired too.
insert into workspace_members (workspace_id, user_id, role)
select w.id, w.created_by, 'owner'
  from workspaces w
 where w.is_personal
   and not exists (
     select 1 from workspace_members m
      where m.workspace_id = w.id and m.user_id = w.created_by
   )
on conflict (workspace_id, user_id) do nothing;


-- ── 2. Adopt workspace-less projects ───────────────────────────────────────
update crawl_projects p
   set workspace_id = w.id
  from workspaces w
 where p.workspace_id is null
   and w.created_by = p.owner
   and w.is_personal;


-- ── 3. Backfill missing primary domains ────────────────────────────────────
-- Same conservative normalization 0011 used, and the same reason: lowercase the
-- host, drop path/query/fragment, keep the raw url as raw_input. source is
-- 'backfill' so a migrated row is never mistaken for something a user typed.
--
-- Only projects whose url yields a usable host and an http(s) scheme are
-- repaired. The rest are reported, not guessed at.
insert into project_domains (workspace_id, project_id, role, normalized_origin, host, scheme, raw_input, source, created_by)
select
  p.workspace_id,
  p.id,
  'primary',
  p.scheme || '://' || p.host,
  p.host,
  p.scheme,
  p.url,
  'backfill',
  p.owner
from (
  select
    cp.id,
    cp.url,
    cp.owner,
    cp.workspace_id,
    coalesce(nullif(lower(substring(cp.url from '^([a-zA-Z][a-zA-Z0-9+.-]*)://')), ''), 'https') as scheme,
    lower(regexp_replace(
      regexp_replace(cp.url, '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''),
      '[/?#].*$', ''
    )) as host
  from crawl_projects cp
) p
where p.host <> ''
  and p.host not like '%/%'
  and p.scheme in ('http', 'https')
  and p.workspace_id is not null
  and not exists (
    select 1 from project_domains d
     where d.project_id = p.id and d.role = 'primary' and d.status = 'active'
  );


-- ── 4. Backfill project_domains.workspace_id from its project ──────────────
-- The column is denormalised (it lets a domain be authorised without joining up
-- to the project), so a row written before its project had a workspace can
-- carry a NULL the project no longer has.
update project_domains d
   set workspace_id = p.workspace_id
  from crawl_projects p
 where d.project_id = p.id
   and d.workspace_id is distinct from p.workspace_id;


-- ── 5. workspace_id becomes mandatory on both tables ───────────────────────
-- Guarded so the file stays re-runnable, and deliberately placed AFTER the
-- backfill: if steps 1-4 left a violating row, this raises and the migration
-- stops rather than half-applying.
do $mig$
begin
  if exists (
    select 1 from information_schema.columns
     where table_name = 'crawl_projects' and column_name = 'workspace_id'
       and is_nullable = 'YES'
  ) then
    alter table crawl_projects alter column workspace_id set not null;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_name = 'project_domains' and column_name = 'workspace_id'
       and is_nullable = 'YES'
  ) then
    alter table project_domains alter column workspace_id set not null;
  end if;
end $mig$;


-- ── 6. Both workspace_id foreign keys become ON DELETE RESTRICT ────────────
-- Looked up by column rather than by name: these constraints were created
-- inline in 0010 and 0011, so their names are whatever Postgres assigned.
-- confdeltype 'r' is RESTRICT, 'c' CASCADE, 'n' SET NULL, 'a' NO ACTION.
do $mig$
declare
  cname text;
begin
  select c.conname into cname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.contype = 'f'
     and t.relname = 'crawl_projects'
     and a.attname = 'workspace_id'
     and c.confdeltype <> 'r';
  if cname is not null then
    execute format('alter table crawl_projects drop constraint %I', cname);
    alter table crawl_projects add constraint crawl_projects_workspace_id_fkey
      foreign key (workspace_id) references workspaces(id) on delete restrict;
  end if;

  select c.conname into cname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.contype = 'f'
     and t.relname = 'project_domains'
     and a.attname = 'workspace_id'
     and c.confdeltype <> 'r';
  if cname is not null then
    execute format('alter table project_domains drop constraint %I', cname);
    alter table project_domains add constraint project_domains_workspace_id_fkey
      foreign key (workspace_id) references workspaces(id) on delete restrict;
  end if;
end $mig$;


-- ── 7. The invariant, enforced ─────────────────────────────────────────────
--   no crawl_projects row may exist without an active primary project_domains row
--
-- A DEFERRED constraint trigger, not a CHECK: the condition spans two tables and
-- is only meaningful once both inserts have happened. Deferring to COMMIT is
-- what lets the legitimate writer insert the project and then its domains in one
-- transaction, while a bare `insert into crawl_projects` — the shape this whole
-- migration exists to eliminate — fails when it tries to commit.
--
-- The error message names the function to call, because the person who hits this
-- is writing a new code path and needs to know there is already one.
create or replace function platform_require_primary_domain()
returns trigger language plpgsql as $fn$
begin
  -- The project may have been deleted later in the same transaction (a test
  -- fixture, a rollback-and-retry). Nothing to enforce if it is already gone.
  if not exists (select 1 from crawl_projects where id = new.id) then
    return null;
  end if;

  if not exists (
    select 1 from project_domains
     where project_id = new.id and role = 'primary' and status = 'active'
  ) then
    raise exception
      'crawl_projects row % has no active primary domain. A project is the row AND its primary domain: write both in one transaction via modules/projects/store.js createProject.',
      new.id
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$fn$;

drop trigger if exists crawl_projects_require_primary_domain on crawl_projects;
create constraint trigger crawl_projects_require_primary_domain
  after insert on crawl_projects
  deferrable initially deferred
  for each row execute function platform_require_primary_domain();

comment on function platform_require_primary_domain() is
  'Deferred check (migration 0027): every new crawl_projects row must have an active primary project_domains row by COMMIT. Enforces the single-writer invariant that modules/projects/store.js createProject implements.';


-- ── Verification (PRD §24.4: every migration ships its checks) ──────────────
-- Run these after applying; each should return the stated result.
-- server/scripts/auditProjectIntegrity.js runs the same set and exits non-zero
-- on any of them, which is the form to use in CI.
--
--   -- every project has a workspace
--   select id, name from crawl_projects where workspace_id is null;              -- 0 rows
--
--   -- every project has exactly one active primary domain
--   select p.id, p.name, p.url from crawl_projects p
--     left join project_domains d
--       on d.project_id = p.id and d.role = 'primary' and d.status = 'active'
--    group by p.id, p.name, p.url having count(d.id) <> 1;                        -- 0 rows
--   -- A row surviving here is a project whose `url` would not parse. It was
--   -- deliberately not guessed at; give it a domain through the app
--   -- (POST /api/projects/:id/domains/primary) rather than by hand.
--
--   -- every domain agrees with its project about the workspace
--   select d.id from project_domains d join crawl_projects p on p.id = d.project_id
--    where d.workspace_id is distinct from p.workspace_id;                        -- 0 rows
--
--   -- both foreign keys are RESTRICT ('r')
--   select t.relname, c.conname, c.confdeltype from pg_constraint c
--     join pg_class t on t.oid = c.conrelid
--     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
--    where c.contype = 'f' and a.attname = 'workspace_id'
--      and t.relname in ('crawl_projects', 'project_domains');                    -- both 'r'
--
--   -- the invariant really is enforced (this must RAISE at commit)
--   -- begin;
--   --   insert into crawl_projects (owner, workspace_id, url, cron)
--   --     select owner, workspace_id, 'https://invariant-probe.invalid', '0 3 * * *'
--   --       from crawl_projects limit 1;
--   -- commit;   -- expected: "has no active primary domain"
--
-- Rollback: drop the trigger to stop enforcing
--   drop trigger if exists crawl_projects_require_primary_domain on crawl_projects;
-- and, if the NOT NULL constraints need to come off,
--   alter table crawl_projects  alter column workspace_id drop not null;
--   alter table project_domains alter column workspace_id drop not null;
-- The backfilled rows are real data and are NOT rolled back — a project that
-- gained its primary domain here keeps it.
