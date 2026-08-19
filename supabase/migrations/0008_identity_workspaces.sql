-- ═══════════════════════════════════════════════════════════════════════════
-- Identity + workspaces — backs Google sign-in (server/routes/auth.js), the
-- required post-login profile step, workspaces shared across users, and a
-- lightweight trail of what each user runs in the app. Typed columns (not the
-- generic jsonb store) since this is relational (foreign keys, membership
-- joins, uniqueness on email) rather than fetched-by-id blobs.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- One row per person who has ever completed Google sign-in.
create table if not exists app_users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  role          text not null default 'seo',
  created_at    timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);

-- Required after first login (see ProfileSetupPage.jsx). `company_locked`
-- is true for @position2.com emails — the server always forces
-- company = 'Position2' for those regardless of what the client sends,
-- this column just records that a request to change it should be rejected.
create table if not exists user_profiles (
  user_id        uuid primary key references app_users(id) on delete cascade,
  full_name      text not null,
  company        text not null,
  company_locked boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Shared containers multiple users can belong to.
create table if not exists workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references app_users(id) on delete cascade,
  role         text not null default 'member', -- 'owner' | 'member'
  added_at     timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists idx_workspace_members_user on workspace_members (user_id);

-- Always-on trail of authenticated API calls ("what users are running"),
-- independent of any tool's own data. See requireAuth in routes/auth.js.
create table if not exists activity_log (
  id           bigint generated always as identity primary key,
  user_id      uuid references app_users(id) on delete set null,
  workspace_id uuid references workspaces(id) on delete set null,
  method       text not null,
  path         text not null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_activity_log_user on activity_log (user_id, created_at desc);

-- Future: full per-run input/output, opt-in per tool (not wired into every
-- module yet — this table is ready for a module to start writing to it).
create table if not exists runs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references app_users(id) on delete set null,
  workspace_id uuid references workspaces(id) on delete set null,
  tool_id      text not null,
  status       text not null default 'completed', -- 'running' | 'completed' | 'failed'
  input        jsonb,
  output       jsonb,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_runs_user on runs (user_id, created_at desc);
create index if not exists idx_runs_workspace on runs (workspace_id, created_at desc);
