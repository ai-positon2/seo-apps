-- ═══════════════════════════════════════════════════════════════════════════
-- Platform foundation — PRD §24.1 step 1 ("Workspace access and project
-- domains"), the first migration of the sitewide SEO/GEO platform.
--
-- Strictly additive, per PRD §24.4: nothing here drops or rewrites a column
-- that 0007–0010 created, and every statement is guarded so the file stays
-- re-runnable. `crawl_projects` remains the physical project table (§30.6) and
-- its `owner` column stays put as creator/legacy attribution — but from this
-- migration on, `workspace_id` is the authorization boundary (§7.4), so it
-- gets backfilled for every existing row.
--
-- What this file deliberately does NOT do:
--   * No RLS. The server holds the service-role key and every read is filtered
--     in the query layer (server/services/projectAccess.js) — the same contract
--     migration 0010 set, for the same reason (no Supabase Auth session here).
--   * No canonical-URL, snapshot, or audit-result tables. Those are PRD phases
--     2–3; shipping their DDL with nothing writing to it would make the schema
--     claim capability the app does not have.
--
-- Verification queries and rollback notes are at the bottom of the file.
-- ═══════════════════════════════════════════════════════════════════════════

-- pgcrypto is deliberately not created here — see the block at the top of
-- 0008_identity_workspaces.sql. Short version: gen_random_uuid() is core from
-- PG 13 on, nothing here uses any other pgcrypto function, and CREATE EXTENSION
-- needs a database-level privilege the RDS app role does not have.

-- Shared updated_at trigger. 0010 introduced crawl_touch_updated_at() for its
-- own tables; this one is named for the platform tables so the two concerns can
-- diverge later without a rename.
create or replace function platform_touch_updated_at()
returns trigger language plpgsql as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

-- Rejects any UPDATE or DELETE on an append-only table. PRD §17.7 requires
-- immutability triggers on evidence-bearing rows; audit_events and
-- admin_limit_policies are the two such tables this migration creates.
create or replace function platform_reject_mutation()
returns trigger language plpgsql as $fn$
begin
  raise exception '% is append-only: % rejected. Write a new row instead.',
    tg_table_name, tg_op;
end;
$fn$;


-- ── 1. Platform administrators (PRD §7.3) ──────────────────────────────────
-- The initial administrator is identified by exact match of the *normalized*
-- authenticated email — trim + lowercase — and the grant lives here, in the
-- database, never in a frontend constant. A grant may exist before that person
-- has ever signed in (user_id NULL); it is linked to app_users at their first
-- authenticated login by server/services/platformAdmin.js.
create table if not exists platform_admin_grants (
  id                uuid primary key default gen_random_uuid(),
  normalized_email  text not null,
  user_id           uuid references app_users(id) on delete set null,
  status            text not null default 'active',
  grant_source      text not null default 'bootstrap',
  granted_by        uuid references app_users(id) on delete set null,
  granted_at        timestamptz not null default now(),
  linked_at         timestamptz,
  revoked_at        timestamptz,
  revoked_by        uuid references app_users(id) on delete set null,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_admin_grants_status_check') then
    alter table platform_admin_grants add constraint platform_admin_grants_status_check
      check (status in ('active', 'revoked'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'platform_admin_grants_source_check') then
    alter table platform_admin_grants add constraint platform_admin_grants_source_check
      check (grant_source in ('bootstrap', 'admin_ui', 'support'));
  end if;
  -- Guards the normalization contract at the storage layer: an un-normalized
  -- email inserted by hand would never match an authenticated login, and the
  -- grant would look mysteriously inert rather than wrong.
  if not exists (select 1 from pg_constraint where conname = 'platform_admin_grants_email_norm_check') then
    alter table platform_admin_grants add constraint platform_admin_grants_email_norm_check
      check (normalized_email = lower(btrim(normalized_email)) and normalized_email <> '');
  end if;
end $mig$;

-- One active grant per email, one per linked user. Both partial, so a revoked
-- grant stays on the record and the same email can be granted again later.
create unique index if not exists uq_platform_admin_grants_email
  on platform_admin_grants (normalized_email) where status = 'active';
create unique index if not exists uq_platform_admin_grants_user
  on platform_admin_grants (user_id) where status = 'active' and user_id is not null;

drop trigger if exists platform_admin_grants_touch on platform_admin_grants;
create trigger platform_admin_grants_touch before update on platform_admin_grants
  for each row execute function platform_touch_updated_at();

-- The initial administrator (PRD §1, §7.3, AC-002). Seeded here so the grant
-- exists before that account's first login; the runtime bootstrap is
-- idempotent and fills in user_id when they do sign in.
insert into platform_admin_grants (normalized_email, grant_source, note)
select 'nikhil.ashok@position2.com', 'bootstrap',
       'Initial platform administrator (PRD §7.3). Seeded by migration 0011.'
where not exists (
  select 1 from platform_admin_grants
   where normalized_email = 'nikhil.ashok@position2.com' and status = 'active'
);


-- ── 2. Workspace roles + lifecycle (PRD §7.1, §7.2, §17.1) ─────────────────
-- 0008 shipped workspace_members.role as free text defaulting to 'member',
-- with only 'owner' | 'member' in play. The product needs four roles;
-- 'member' stays legal and maps to 'contributor' for permission checks
-- (server/services/projectAccess.js) so existing memberships keep working
-- without a data rewrite.
do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_members_role_check') then
    alter table workspace_members add constraint workspace_members_role_check
      check (role in ('owner', 'admin', 'approver', 'contributor', 'member'));
  end if;
end $mig$;

-- Immutable membership history (§17.1) — invites, role changes, removals.
create table if not exists workspace_member_events (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  subject_user  uuid references app_users(id) on delete set null,
  subject_email text,
  actor_user_id uuid references app_users(id) on delete set null,
  actor_email   text,
  action        text not null,
  old_role      text,
  new_role      text,
  reason        text,
  created_at    timestamptz not null default now()
);

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_member_events_action_check') then
    alter table workspace_member_events add constraint workspace_member_events_action_check
      check (action in ('added', 'role_changed', 'removed', 'ownership_transferred'));
  end if;
end $mig$;

create index if not exists idx_workspace_member_events_ws
  on workspace_member_events (workspace_id, created_at desc);

-- 30-day recoverable deletion (PRD §3.3.4, §22.11, AC-061/AC-062). Nothing is
-- purged by this migration; the sweeper that acts on purge_after is phase 8.
alter table workspaces add column if not exists lifecycle_status      text not null default 'active';
alter table workspaces add column if not exists deletion_requested_at timestamptz;
alter table workspaces add column if not exists deletion_requested_by uuid references app_users(id) on delete set null;
alter table workspaces add column if not exists purge_after           timestamptz;
alter table workspaces add column if not exists restored_at           timestamptz;
alter table workspaces add column if not exists restored_by           uuid references app_users(id) on delete set null;
alter table workspaces add column if not exists purged_at             timestamptz;

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_lifecycle_status_check') then
    alter table workspaces add constraint workspaces_lifecycle_status_check
      check (lifecycle_status in ('active', 'pending_deletion', 'purged'));
  end if;
end $mig$;

-- The deletion sweeper scans for workspaces whose recovery window has closed.
create index if not exists idx_workspaces_purge_due
  on workspaces (purge_after) where lifecycle_status = 'pending_deletion';


-- ── 3. Cross-domain audit log (PRD §17.1, §22.10, §23.3) ───────────────────
-- One append-only trail for every sensitive mutation and override: who, what,
-- why, before, after. Overrides that carry a reason (§3.2.4) write here, and
-- the machine evidence they override is never touched.
create table if not exists audit_events (
  id            bigint generated always as identity primary key,
  workspace_id  uuid references workspaces(id) on delete set null,
  project_id    uuid references crawl_projects(id) on delete set null,
  actor_user_id uuid references app_users(id) on delete set null,
  actor_email   text,
  actor_role    text,
  action        text not null,
  entity_type   text,
  entity_id     text,
  reason        text,
  old_state     jsonb,
  new_state     jsonb,
  source        text,
  request_id    text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_audit_events_workspace on audit_events (workspace_id, created_at desc);
create index if not exists idx_audit_events_project   on audit_events (project_id, created_at desc);
create index if not exists idx_audit_events_action    on audit_events (action, created_at desc);
create index if not exists idx_audit_events_actor     on audit_events (actor_user_id, created_at desc);

drop trigger if exists audit_events_append_only on audit_events;
create trigger audit_events_append_only before update or delete on audit_events
  for each row execute function platform_reject_mutation();


-- ── 4. Versioned limit + budget policies (PRD §10.2, §17.1, §20.10) ────────
-- Admin changes create a NEW version rather than rewriting the effective-limit
-- history (§20.10) — which is why these rows are append-only. The effective
-- limit for a request is the most restrictive applicable policy across
-- platform / workspace / tier (§10.2, §30.5), resolved in
-- server/services/adminLimits.js rather than in SQL.
create table if not exists admin_limit_policies (
  id             uuid primary key default gen_random_uuid(),
  scope          text not null,
  scope_ref      text,                       -- workspace id, or tier name; NULL for platform
  version        integer not null,
  limits         jsonb not null default '{}'::jsonb,
  effective_from timestamptz not null default now(),
  created_by     uuid references app_users(id) on delete set null,
  created_at     timestamptz not null default now(),
  note           text
);

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'admin_limit_policies_scope_check') then
    alter table admin_limit_policies add constraint admin_limit_policies_scope_check
      check (scope in ('platform', 'workspace', 'tier'));
  end if;
  -- Platform scope is singular by definition; workspace and tier must say which.
  if not exists (select 1 from pg_constraint where conname = 'admin_limit_policies_ref_check') then
    alter table admin_limit_policies add constraint admin_limit_policies_ref_check
      check ((scope = 'platform' and scope_ref is null)
          or (scope <> 'platform' and scope_ref is not null));
  end if;
end $mig$;

create unique index if not exists uq_admin_limit_policies_version
  on admin_limit_policies (scope, coalesce(scope_ref, ''), version);
create index if not exists idx_admin_limit_policies_effective
  on admin_limit_policies (scope, coalesce(scope_ref, ''), version desc);

drop trigger if exists admin_limit_policies_append_only on admin_limit_policies;
create trigger admin_limit_policies_append_only before update or delete on admin_limit_policies
  for each row execute function platform_reject_mutation();

-- Version 1 of the platform defaults, seeded from what the app enforces today
-- (PRD §10.2, "seed defaults from the current application"). Only inserted when
-- no platform policy exists, so an administrator's later version always wins.
insert into admin_limit_policies (scope, scope_ref, version, limits, note)
select 'platform', null, 1, jsonb_build_object(
  'maxUrlsPerCrawl',          5000,
  'maxCrawlDepth',            10,
  'scheduleMinIntervalHours', 24,
  'perProjectConcurrency',    1,
  'globalCrawlConcurrency',   3,
  'requestTimeoutMs',         30000,
  'renderTimeoutMs',          45000,
  'renderBudgetPerRun',       150,
  'crawlRetryCount',          2,
  'modelCallsPerRun',         500,
  'modelSpendPerRunUsd',      5,
  'providerCallsPerDay',      5000,
  'gscFreshnessDays',         3,
  'measurementRetryDays',     14,
  'rawHtmlRetentionMonths',   12,
  'exportRetentionMonths',    12,
  'workspacePurgeGraceDays',  30
), 'Seeded by migration 0011 from the limits the app enforces today (PRD §10.2).'
where not exists (select 1 from admin_limit_policies where scope = 'platform');


-- ── 5. Feature-flag assignments (PRD §3.1.14, §17.1, AC-063) ───────────────
-- Rollout is feature-flagged for internal users and a pilot group before
-- general availability. Most specific scope wins (user → project → workspace →
-- global), resolved in server/services/featureFlags.js.
create table if not exists feature_flag_assignments (
  id         uuid primary key default gen_random_uuid(),
  flag_key   text not null,
  scope      text not null,
  scope_ref  text,
  enabled    boolean not null default false,
  note       text,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'feature_flag_assignments_scope_check') then
    alter table feature_flag_assignments add constraint feature_flag_assignments_scope_check
      check (scope in ('global', 'workspace', 'project', 'user'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'feature_flag_assignments_ref_check') then
    alter table feature_flag_assignments add constraint feature_flag_assignments_ref_check
      check ((scope = 'global' and scope_ref is null)
          or (scope <> 'global' and scope_ref is not null));
  end if;
end $mig$;

create unique index if not exists uq_feature_flag_assignments
  on feature_flag_assignments (flag_key, scope, coalesce(scope_ref, ''));
create index if not exists idx_feature_flag_assignments_key
  on feature_flag_assignments (flag_key);

drop trigger if exists feature_flag_assignments_touch on feature_flag_assignments;
create trigger feature_flag_assignments_touch before update on feature_flag_assignments
  for each row execute function platform_touch_updated_at();

-- The unified project experience ships dark; enabling it per workspace is the
-- pilot mechanism (AC-063). The legacy CrawlScope screens stay reachable either
-- way, so turning this off is a complete rollback of the new UI surface.
insert into feature_flag_assignments (flag_key, scope, scope_ref, enabled, note)
values ('unified_project_workspace', 'global', null, false,
        'PRD §3.1.14 — off globally; enable per workspace for the internal/pilot rollout.')
on conflict (flag_key, scope, coalesce(scope_ref, '')) do nothing;


-- ── 6. Project: workspace ownership, country, lifecycle (PRD §8.1, §17.2) ──
-- crawl_projects stays the physical project table. These columns turn it into
-- the product's project aggregate without breaking anything reading it today.
alter table crawl_projects add column if not exists country_code     text;
alter table crawl_projects add column if not exists lifecycle_status text not null default 'active';
alter table crawl_projects add column if not exists site_verified_at timestamptz;
alter table crawl_projects add column if not exists site_verified_by uuid references app_users(id) on delete set null;
alter table crawl_projects add column if not exists robots_override  boolean not null default false;
alter table crawl_projects add column if not exists settings         jsonb not null default '{}'::jsonb;
alter table crawl_projects add column if not exists deleted_at       timestamptz;
alter table crawl_projects add column if not exists deleted_by       uuid references app_users(id) on delete set null;

comment on column crawl_projects.country_code is
  'ISO 3166-1 alpha-2, uppercase. Required for projects created through /api/projects (PRD §3.2.3, AC-004); NULL only on rows predating migration 0011.';
comment on column crawl_projects.robots_override is
  'robots.txt is obeyed by default (PRD §3.1.4). True only for a verified primary site, set by an administrator, and always paired with an audit_events row.';

do $mig$
begin
  -- Nullable so 0010 rows stay readable (PRD §24.2: backfill country only where
  -- reliable data exists, otherwise require it on the next edit). New projects
  -- are validated in the API layer, which is where the ISO list lives.
  if not exists (select 1 from pg_constraint where conname = 'crawl_projects_country_code_check') then
    alter table crawl_projects add constraint crawl_projects_country_code_check
      check (country_code is null or country_code ~ '^[A-Z]{2}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crawl_projects_lifecycle_check') then
    alter table crawl_projects add constraint crawl_projects_lifecycle_check
      check (lifecycle_status in ('active', 'archived', 'deleted'));
  end if;
end $mig$;

-- Workspace becomes the authorization boundary (§7.4), so a project needs one.
-- Backfilled from the creator's personal workspace — the workspace their runs
-- already land in (server/services/workspaceContext.js).
update crawl_projects p
   set workspace_id = w.id
  from workspaces w
 where p.workspace_id is null
   and w.created_by = p.owner
   and w.is_personal;

create index if not exists idx_crawl_projects_workspace_lifecycle
  on crawl_projects (workspace_id, lifecycle_status, created_at desc);


-- ── 7. Project domains (PRD §8.2, §17.2) ───────────────────────────────────
-- One active primary domain per project, plus the user-approved competitor
-- domains. `crawl_projects.url` is retained as a compatibility projection of
-- the primary domain (§8.1); new code reads the primary through this table.
create table if not exists project_domains (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid references workspaces(id) on delete cascade,
  project_id         uuid not null references crawl_projects(id) on delete cascade,
  role               text not null,
  normalized_origin  text not null,          -- scheme://host[:port], lowercased, no trailing slash
  host               text not null,
  scheme             text not null default 'https',
  raw_input          text,                   -- exactly what the user typed
  source             text not null default 'user_entered',
  status             text not null default 'active',
  provider_ids       jsonb not null default '{}'::jsonb,
  score_refreshed_at timestamptz,
  created_by         uuid references app_users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_domains_role_check') then
    alter table project_domains add constraint project_domains_role_check
      check (role in ('primary', 'competitor'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_domains_source_check') then
    alter table project_domains add constraint project_domains_source_check
      check (source in ('user_entered', 'suggested', 'accepted', 'backfill'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_domains_status_check') then
    alter table project_domains add constraint project_domains_status_check
      check (status in ('active', 'proposed', 'removed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_domains_scheme_check') then
    alter table project_domains add constraint project_domains_scheme_check
      check (scheme in ('http', 'https'));
  end if;
end $mig$;

-- PRD §17.7: partial unique index for one active primary domain per project.
create unique index if not exists uq_project_domains_active_primary
  on project_domains (project_id) where role = 'primary' and status = 'active';
-- An origin can only be on a project once while active — which is also what
-- stops the primary domain being added as an active competitor (§8.2).
create unique index if not exists uq_project_domains_active_origin
  on project_domains (project_id, normalized_origin) where status = 'active';
create index if not exists idx_project_domains_project
  on project_domains (project_id, role, status);
create index if not exists idx_project_domains_workspace
  on project_domains (workspace_id, created_at desc);

drop trigger if exists project_domains_touch on project_domains;
create trigger project_domains_touch before update on project_domains
  for each row execute function platform_touch_updated_at();

-- Backfill the primary domain from each existing crawl_projects.url
-- (PRD §24.2). Marked source='backfill' so a migrated row is never mistaken for
-- something a user typed. Normalization here is deliberately conservative —
-- lowercase host, drop path/query/fragment — and mirrors normalizeOrigin() in
-- server/modules/projects/domains.js, which is what new rows go through.
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
      regexp_replace(cp.url, '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''),  -- drop scheme
      '[/?#].*$', ''                                              -- drop path/query/fragment
    )) as host
  from crawl_projects cp
) p
where p.host <> ''
  and p.scheme in ('http', 'https')
  and not exists (
    select 1 from project_domains d
     where d.project_id = p.id and d.role = 'primary' and d.status = 'active'
  );


-- ── Verification (PRD §24.4: every migration ships its checks) ──────────────
-- Run these after applying; each should return the stated result.
--
--   -- the initial platform admin grant exists exactly once, normalized
--   select count(*) from platform_admin_grants
--    where normalized_email = 'nikhil.ashok@position2.com' and status = 'active';  -- 1
--
--   -- every project resolves to a workspace (nothing left owner-only)
--   select id, name from crawl_projects where workspace_id is null;                -- 0 rows
--
--   -- every project has exactly one active primary domain
--   select p.id from crawl_projects p
--     left join project_domains d
--       on d.project_id = p.id and d.role = 'primary' and d.status = 'active'
--    group by p.id having count(d.id) <> 1;                                        -- 0 rows
--
--   -- append-only tables really are append-only (both statements must raise)
--   -- update audit_events set action = 'x' where id = (select min(id) from audit_events);
--   -- update admin_limit_policies set version = 99 where scope = 'platform';
--
--   -- platform limits v1 present
--   select version, limits->>'maxUrlsPerCrawl' from admin_limit_policies
--    where scope = 'platform' order by version desc limit 1;                        -- 1, 5000
--
-- Rollback: this migration only adds. To disable everything it introduces
-- without dropping data, leave the unified_project_workspace flag off (its
-- seeded state) — /api/projects and /api/admin stay inert for the UI, and the
-- legacy CrawlScope screens are untouched.
