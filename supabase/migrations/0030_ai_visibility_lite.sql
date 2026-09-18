-- ═══════════════════════════════════════════════════════════════════════════
-- 0030 — ai_visibility_lite: the same question, asked through the APIs
--
-- Why a second module rather than a flag on the first
-- ──────────────────────────────────────────────────
-- 0016's module measures CONSUMER SURFACES: a real browser against the
-- logged-out chatgpt.com and gemini.google.com UIs. That is the honest way to
-- answer "what does a buyer see", and it costs 25–110 seconds per capture, so
-- a 20-prompt run is 10–35 minutes and cannot be made faster.
--
-- This module asks the MODELS DIRECTLY, over their APIs, with each provider's
-- web-search tool switched on. A capture is a few seconds. A whole run is
-- minutes, not half an hour, which is what makes a one-click flow possible.
--
-- These are different claims and the reports must never merge them. 0016
-- already encoded that distinction in `access` ('scraped' | 'api') and this
-- module is the 'api' half. Separate tables keep it structural rather than a
-- filter somebody can forget: a v1 report cannot accidentally read a v2 row,
-- because it does not know the table exists.
--
-- ── The columns are deliberately identical to 0016's ───────────────────────
--
-- Every metric in server/modules/aiVisibility/metrics/ is a PURE FUNCTION over
-- capture rows. Naming these columns exactly as 0016 names them is what lets
-- this module reuse all four metric files and scoring.js by `require`, with no
-- adapter and no copied arithmetic. Renaming a column here would fork the
-- metric layer, which is the one thing this module must not do.
--
-- So: `mentioned` stays NULLABLE and load-bearing (NULL = not measured, which
-- is not the same claim as "not named"), `prominence` keeps its 0–1 check, and
-- `prompt_text` is still stored per capture so editing a prompt cannot rewrite
-- what an old capture says it asked.
--
-- Additive and re-runnable. No RLS: every query carries its own project filter,
-- and that filter IS the tenancy check (see 0012–0016).
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Let the two new module keys exist ────────────────────────────────────────
--
-- Same trap 0016 documented: project_module_runs.module_key carries a CHECK
-- constraint listing the modules by name, and adding the key to the JavaScript
-- lists is not enough — the insert is refused by the database at startRun,
-- before any module code runs, and the route reports a generic failure because
-- a constraint error carries no HTTP status.
--
-- Two keys, not one:
--
--   ai_visibility_lite        one measurement run. THIS is what the 20-run
--                             per-project cap counts.
--   ai_visibility_lite_setup  the one-time identify-the-business and write-the
--                             -prompts job. Deliberately NOT counted against
--                             the cap — it is setup, not measurement, and
--                             charging a run for it would mean a project that
--                             regenerated its prompts got fewer measurements.
--
-- Every pre-existing key is carried forward. 'on_page' is still here for the
-- reason 0016 gave: it is no longer live, but historical runs carry it and
-- dropping it would make the table refuse rows it already contains.

do $mig$
begin
  if exists (
    select 1 from pg_constraint where conname = 'project_module_runs_module_check'
  ) then
    alter table project_module_runs drop constraint project_module_runs_module_check;
  end if;

  alter table project_module_runs add constraint project_module_runs_module_check
    check (module_key in (
      'on_page', 'seo_geo', 'agent_readiness', 'competitor', 'hub_spoke',
      'ai_visibility', 'ai_visibility_prompts',
      'ai_visibility_lite', 'ai_visibility_lite_setup'
    ));
end
$mig$;


-- ── What the business actually is ──────────────────────────────────────────
--
-- One row per project: the module's answer to "who is this and what do they
-- sell", derived from the site itself and then used to write the questions.
--
-- Stored rather than recomputed because it is the AUDIT TRAIL for the prompts.
-- When somebody asks why the module is asking "best pediatric dentist in
-- Raleigh", the answer has to be a row they can read, not a model call nobody
-- kept. `source_urls` records which pages were read to reach it.
--
-- `brand_aliases` matters more than it looks: it is what capture-time mention
-- matching runs against. A business whose model-facing name differs from its
-- domain stem ("Brush and Floss" vs "brushandfloss") is invisible to a matcher
-- that only knows the domain, and that failure looks exactly like a real zero.

create table if not exists aiv_lite_profiles (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references crawl_projects(id) on delete cascade,
  workspace_id  uuid references workspaces(id) on delete set null,

  business_name text not null,
  -- One paragraph a person can check against the site in ten seconds.
  summary       text,
  -- ["dental implants", "invisalign", ...] — what they sell, in the words the
  -- site uses. These become the subject of the generated questions.
  products      jsonb not null default '[]'::jsonb,
  services      jsonb not null default '[]'::jsonb,
  -- Names a model would actually write, including the legal name and any
  -- trading names. Drives mention matching. See the note above.
  brand_aliases jsonb not null default '[]'::jsonb,
  -- Competitor names the profile pass proposed, for share-of-voice.
  competitors   jsonb not null default '[]'::jsonb,
  -- Where the business operates, when the site says. Shapes the questions: a
  -- single-location practice asked a national question measures nothing.
  locations     jsonb not null default '[]'::jsonb,

  -- The pages that were read to produce this. The audit trail.
  source_urls   jsonb not null default '[]'::jsonb,
  model_version text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One profile per project. Regenerating overwrites rather than accumulating —
-- a second row would leave "which one wrote these prompts" unanswerable.
create unique index if not exists uq_aiv_lite_profile
  on aiv_lite_profiles (project_id);


-- ── The question set ───────────────────────────────────────────────────────
--
-- Up to 20 per project: 10 written by the setup pass, up to 10 more added by
-- hand. The cap is enforced in store.js against `active` rows, not here — a
-- partial unique index cannot count.
--
-- `source` distinguishes them for display ONLY. Once created they behave
-- identically: same edit, same delete, same participation in every run. That
-- is a product requirement, so nothing downstream is allowed to branch on it.
--
-- ── "Delete" is a retire ───────────────────────────────────────────────────
--
-- The UI offers delete and this table performs a retire (active = false,
-- retired_at set). Both halves are deliberate:
--
--   • A retired prompt frees its slot against the 20-prompt cap, so the person
--     gets exactly the behaviour the button promises.
--   • Its captures keep pointing at a row that still exists, so a report run
--     last week still knows what it asked. A hard delete would null the
--     prompt_id on historical captures and quietly rewrite the evidence the
--     numbers were computed from.
--
-- This is 0016's rule, kept for the same reason, with a friendlier verb.

create table if not exists aiv_lite_prompts (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references crawl_projects(id) on delete cascade,
  workspace_id  uuid references workspaces(id) on delete set null,

  text          text not null,
  -- 'auto'   — written by the setup pass from the profile
  -- 'custom' — typed by a person
  -- Display only. Never branch behaviour on this.
  source        text not null default 'custom'
                check (source in ('auto', 'custom')),
  intent        text check (intent in ('commercial', 'informational', 'navigational', 'comparison')),

  active        boolean not null default true,
  retired_at    timestamptz,

  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One live prompt per project, case- and whitespace-insensitive. Partial on
-- `active` so retiring a question and asking it again later is allowed —
-- unlike 0016, where the set is curated and a re-add is usually a mistake.
-- Here the person is expected to churn their own 10.
create unique index if not exists uq_aiv_lite_prompt_active
  on aiv_lite_prompts (project_id, lower(btrim(text)))
  where active;

create index if not exists idx_aiv_lite_prompts_active
  on aiv_lite_prompts (project_id) where active and retired_at is null;


-- ── The evidence ───────────────────────────────────────────────────────────
--
-- One answer, from one model, at one moment. Append-only.
--
-- Column-for-column compatible with ai_visibility_captures on everything the
-- metric layer reads. The differences are additive and API-specific:
--
--   search_queries  what the provider's web-search tool actually searched for.
--                   0016 calls this web_queries; the name is kept identical
--                   below so metrics/core.js reads it unchanged.
--   grounded        did the web-search tool actually fire? A model that
--                   answered from training data alone is measuring a different
--                   thing from one that searched, and without this column the
--                   two are indistinguishable in the stored row. This is the
--                   single most important column that 0016 does not have —
--                   ungrounded answers are why the spec insists the tools be
--                   switched on.

create table if not exists aiv_lite_captures (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references project_module_runs(id) on delete cascade,
  prompt_id     uuid references aiv_lite_prompts(id) on delete set null,
  project_id    uuid not null references crawl_projects(id) on delete cascade,
  workspace_id  uuid references workspaces(id) on delete set null,

  -- As sent. A later edit to the prompt must not change what this row claims.
  prompt_text   text not null,

  engine        text not null,          -- 'openai' | 'anthropic' | 'google'
  provider      text not null,          -- 'api'
  -- Always 'api' here. The column exists so a row from this table and a row
  -- from 0016's are self-describing when they meet in the same report shape.
  access        text not null default 'api' check (access in ('scraped', 'api')),
  surface_label text not null,          -- what the report is allowed to call it

  status        text not null
                check (status in ('captured', 'no_answer', 'failed')),
  failure_reason text,

  answer_text   text,
  -- [{url, title, domain, index}] — the provider's own citation array. A
  -- citation and a text mention are SEPARATE signals and both feed the metrics.
  citations     jsonb not null default '[]',

  -- NULL = not measured. The whole safety property of the module. A provider
  -- timeout stored as `false` tells a client they are invisible when in fact
  -- the pipeline broke.
  mentioned     boolean,
  cited         boolean,
  prominence    numeric(4,3) check (prominence is null or (prominence >= 0 and prominence <= 1)),
  competitors_mentioned jsonb not null default '[]',
  -- Named to match 0016 so metrics/core.js reads it with no adapter.
  web_queries   jsonb not null default '[]',

  -- Did the web-search / grounding tool actually run on this call? NULL when
  -- the provider does not say. See the header — an ungrounded answer is a
  -- measurement of the training data, not of the live web.
  grounded      boolean,

  model_version text,
  -- NULL is an unknown cost, never a free one.
  task_cost     numeric(10,5),
  raw           jsonb,

  captured_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists idx_aiv_lite_captures_run
  on aiv_lite_captures (run_id, engine);
create index if not exists idx_aiv_lite_captures_prompt
  on aiv_lite_captures (prompt_id, captured_at desc);
-- Trend queries read one project's history for one engine.
create index if not exists idx_aiv_lite_captures_trend
  on aiv_lite_captures (project_id, engine, captured_at desc);
-- The run-cap count and the period scoping both read project + time.
create index if not exists idx_aiv_lite_captures_project_captured
  on aiv_lite_captures (project_id, captured_at, id);


-- ── updated_at ─────────────────────────────────────────────────────────────
-- Reuses the shared trigger function from 0012 rather than defining another.

drop trigger if exists aiv_lite_profiles_touch on aiv_lite_profiles;
create trigger aiv_lite_profiles_touch
  before update on aiv_lite_profiles
  for each row execute function platform_touch_updated_at();

drop trigger if exists aiv_lite_prompts_touch on aiv_lite_prompts;
create trigger aiv_lite_prompts_touch
  before update on aiv_lite_prompts
  for each row execute function platform_touch_updated_at();
