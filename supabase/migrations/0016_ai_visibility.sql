-- ═══════════════════════════════════════════════════════════════════════════
-- 0016 — ai_visibility: what the answer engines say about a client
--
-- Why this exists
-- ───────────────
-- Buyers increasingly ask ChatGPT for a recommendation rather than searching.
-- Whether a client is named in that answer, and which sources the model cites
-- instead of them, is not visible anywhere in this product today.
--
-- Two tables, because the two things have different lifetimes:
--
--   ai_visibility_prompts    the question set. Long-lived, curated, edited by
--                            hand. A trend line is only meaningful against a
--                            STABLE set — change the prompts and month-over-
--                            month movement measures the edit, not the client.
--   ai_visibility_captures   one answer, from one surface, at one moment.
--                            Append-only evidence.
--
-- Parent runs reuse project_module_runs with module_key = 'ai_visibility', the
-- same as every other module, so the dashboard card and the run history come
-- for free.
--
-- Additive and re-runnable. No RLS: every query carries its own project filter,
-- and that filter IS the tenancy check (see 0012–0015).
--
-- ── The nullable column that matters ───────────────────────────────────────
--
-- `mentioned boolean` is NULLABLE and that is load-bearing, not laziness.
--
-- A provider timeout recorded as `mentioned = false` tells a client "you are
-- invisible in ChatGPT" when in fact the pipeline broke. During validation one
-- capture in a dozen came back HTTP 500 — so this is the common case, not an
-- edge case. NULL means "not measured" and the run's coverage says how many.
--
-- `cited` is nullable for a subtler reason: Google AI Overview citations arrive
-- as google.com redirects that are resolved at capture time, and resolution can
-- partially fail. With an unresolved citation still outstanding, "the brand is
-- not cited" is not something we know.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Let the module key exist at all ──────────────────────────────────────────
--
-- project_module_runs.module_key carries a CHECK constraint from 0012 listing
-- the modules by name. Adding 'ai_visibility' to the JavaScript lists is not
-- enough — the insert is refused by the database, at startRun, before any
-- module code runs, and the route reports the generic "Something went wrong"
-- because the constraint error carries no HTTP status.
--
-- 'on_page' stays in the list. It is no longer a live module, but 20 historical
-- runs still carry that key and dropping it from the constraint would make the
-- table refuse rows it already contains.

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'project_module_runs_module_check'
  ) then
    alter table project_module_runs drop constraint project_module_runs_module_check;
  end if;

  alter table project_module_runs add constraint project_module_runs_module_check
    check (module_key in (
      'on_page', 'seo_geo', 'agent_readiness', 'competitor', 'hub_spoke', 'ai_visibility'
    ));
end $$;

-- ── The question set ───────────────────────────────────────────────────────

create table if not exists ai_visibility_prompts (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references crawl_projects(id) on delete cascade,
  workspace_id  uuid references workspaces(id) on delete set null,

  text          text not null,
  -- Where it came from, so a reviewer can tell a generated prompt from one a
  -- human wrote and weigh it accordingly.
  source        text not null default 'manual'
                check (source in ('manual', 'cluster', 'keyword', 'competitor')),
  -- What produced it: a cluster name, a keyword, a competitor domain. Null for
  -- manual. Kept so a bad prompt can be traced to the generator that made it.
  source_ref    text,
  intent        text check (intent in ('commercial', 'informational', 'navigational', 'comparison')),

  -- Retired rather than deleted. A prompt removed from the set still has
  -- captures behind it, and deleting it would silently rewrite history.
  active        boolean not null default true,
  retired_at    timestamptz,

  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One prompt per project. Case- and whitespace-insensitive: "Best dentist" and
-- "best dentist  " are the same question, and measuring both would double-count
-- it in every score.
create unique index if not exists uq_ai_visibility_prompt
  on ai_visibility_prompts (project_id, lower(btrim(text)));

create index if not exists idx_ai_visibility_prompts_active
  on ai_visibility_prompts (project_id) where active and retired_at is null;

-- ── The evidence ───────────────────────────────────────────────────────────

create table if not exists ai_visibility_captures (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references project_module_runs(id) on delete cascade,
  prompt_id     uuid references ai_visibility_prompts(id) on delete set null,
  project_id    uuid not null references crawl_projects(id) on delete cascade,
  workspace_id  uuid references workspaces(id) on delete set null,

  -- The prompt text as sent, not just the id. A prompt can be edited later and
  -- this row must keep saying what was actually asked.
  prompt_text   text not null,

  engine        text not null,          -- 'chatgpt' | 'google_ai_overview' | ...
  provider      text not null,          -- 'dataforseo' | ...
  -- 'scraped' (the consumer surface) or 'api' (the model direct). These answer
  -- different questions and a report must not merge them silently.
  access        text not null default 'scraped' check (access in ('scraped', 'api')),
  surface_label text not null,          -- what the report is allowed to call it

  status        text not null
                check (status in ('captured', 'no_answer', 'failed')),
  failure_reason text,

  answer_text   text,
  citations     jsonb not null default '[]',

  -- NULL = not measured. See the header.
  mentioned     boolean,
  cited         boolean,
  -- 0 = opening words, 1 = the end. NULL when not mentioned — never 1, which
  -- would read as a weak presence rather than an absence.
  prominence    numeric(4,3) check (prominence is null or (prominence >= 0 and prominence <= 1)),
  competitors_mentioned jsonb not null default '[]',
  web_queries   jsonb not null default '[]',

  model_version text,
  -- NULL is an unknown cost, not a free one.
  task_cost     numeric(10,5),
  raw           jsonb,

  captured_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists idx_ai_visibility_captures_run
  on ai_visibility_captures (run_id, engine);
create index if not exists idx_ai_visibility_captures_prompt
  on ai_visibility_captures (prompt_id, captured_at desc);
-- Trend queries read one project's history for one engine.
create index if not exists idx_ai_visibility_captures_trend
  on ai_visibility_captures (project_id, engine, captured_at desc);

-- ── updated_at ─────────────────────────────────────────────────────────────
-- Reuses the shared trigger function from 0012 rather than defining another.

drop trigger if exists ai_visibility_prompts_touch on ai_visibility_prompts;
create trigger ai_visibility_prompts_touch
  before update on ai_visibility_prompts
  for each row execute function platform_touch_updated_at();
