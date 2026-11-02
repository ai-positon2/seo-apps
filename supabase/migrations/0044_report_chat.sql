-- ── Report chat: saved conversations, per user, per project ─────────────────
--
-- The "Ask about this report" assistant answers questions about a project's
-- reports. A conversation is kept so a reader can come back tomorrow and carry
-- on, and each answer records the tokens it used so the cost is visible.
--
-- One ACTIVE thread per (project, user): "New conversation" archives the old
-- one rather than deleting it. Threads are private to the person who asked;
-- nothing here is shared across a workspace.
--
-- user_id is on messages as well as threads so the daily message cap is one
-- indexed count, not a join.
create table if not exists report_chat_threads (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references crawl_projects(id) on delete cascade,
  user_id     uuid not null references app_users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);

create unique index if not exists uq_report_chat_threads_active
  on report_chat_threads (project_id, user_id)
  where archived_at is null;

create table if not exists report_chat_messages (
  id            uuid primary key default gen_random_uuid(),
  thread_id     uuid not null references report_chat_threads(id) on delete cascade,
  user_id       uuid not null references app_users(id) on delete cascade,
  role          text not null check (role in ('user', 'assistant')),
  content       text not null,
  screen        text,
  model         text,
  input_tokens  integer,
  output_tokens integer,
  created_at    timestamptz not null default now()
);

create index if not exists idx_report_chat_messages_thread
  on report_chat_messages (thread_id, created_at);

create index if not exists idx_report_chat_messages_user_recent
  on report_chat_messages (user_id, created_at)
  where role = 'user';
