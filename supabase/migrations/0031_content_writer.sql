-- Editable article work belongs to a project. No historical versions are kept.
create table if not exists content_writer_articles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references crawl_projects(id) on delete cascade,
  document jsonb not null default '{}'::jsonb,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists content_writer_articles_project_idx
  on content_writer_articles(project_id, updated_at desc);
-- Access is checked through projectAccess on every API operation.
alter table content_writer_articles enable row level security;
