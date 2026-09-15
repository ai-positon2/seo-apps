-- ═══════════════════════════════════════════════════════════════════════════
-- 0022 — Page category classification (V10.0 Part 0 + Part 3)
--
-- Why this exists
-- ────────────────
-- The `Category` column has read "—" on every row since it was added: the
-- classifier (categorizePage(), analyzer.js) has always run correctly, but its
-- output had nowhere to land. It's computed once, at crawl completion, into
-- analysis.results — but run/manager.js's stored run summary deliberately
-- omits the per-page results array (it doesn't belong in one JSONB summary
-- column), and the rows the UI actually reads (crawl_run_results) are written
-- LIVE, per page, DURING the crawl — before categorization has run — and
-- nothing ever patches them afterward. `.issues` had this same problem once;
-- it was patched around client-side by re-deriving from crawl_run_findings
-- (which does get written in full). Category isn't a byproduct of findings,
-- so there's no equivalent table to re-derive it from — until now.
--
-- Two tables:
--
--   page_category   One row per (project, normalized URL) — NOT per run. A
--                    crawl_run_results row is wiped and rewritten by every
--                    crawl (deleteRunResults); a manual correction stored
--                    there would be silently lost on the next crawl. Keying
--                    on project_id instead is what makes a manual override
--                    survive re-crawling, per this release's non-negotiable
--                    requirement.
--   category_rule    Per-project classification rules a human can add via the
--                     UI (V10.0 Part 3/4) — a client's own taxonomy on top of
--                     the built-in schema/URL/content signals.
--
-- Two RPCs, both because a REST-level upsert/update can't express "skip this
-- row if a human already corrected it" or "update N different rows to N
-- different values" in one round trip the way supabase-js's .from() can:
--
--   upsert_page_categories()          ON CONFLICT ... WHERE NOT manual_override
--                                      — an automatic re-classification never
--                                      clobbers a human's correction.
--   patch_crawl_run_result_categories()  bulk-merges { pageCategory } into
--                                      crawl_run_results.data for one run in
--                                      a single statement, instead of one
--                                      UPDATE per page (the difference between
--                                      one round trip and up to 10,000 on a
--                                      full-size crawl).
--
-- Additive. No existing column or row is touched.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists page_category (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references crawl_projects(id) on delete cascade,
  url text not null,
  category text not null,
  secondary_categories text[] not null default '{}',
  category_confidence text not null default 'medium'
    check (category_confidence in ('high', 'medium', 'low')),
  signals_matched text[] not null default '{}',
  client_rule_id uuid,
  manual_override boolean not null default false,
  override_reason text,
  updated_at timestamptz not null default now(),
  unique (project_id, url)
);

create index if not exists idx_page_category_project on page_category (project_id);

create table if not exists category_rule (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references crawl_projects(id) on delete cascade,
  category text not null,
  priority int not null default 0,
  match_type text not null
    check (match_type in ('url_pattern', 'schema_type', 'body_class', 'cms_post_type', 'selector', 'content_signal')),
  pattern text not null,
  enabled boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);

-- Guarded like every other constraint in this schema (see 0012, 0027). Postgres
-- has no ADD CONSTRAINT IF NOT EXISTS, and this statement was the one piece of
-- DDL in this file that was not re-runnable — the two create tables and both
-- indexes above all carry `if not exists`.
--
-- It matters for a database that had 0022 applied by hand before the migration
-- runner existed and was never baselined: the runner sees 0022 as pending,
-- re-runs it, and this line raises 42710 (constraint already exists). The
-- runner stops at the first failure by design, so that one statement blocks
-- 0023 through 0027 as well. Wrapping it costs nothing and removes the trap.
do $mig$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'page_category_client_rule_fk'
  ) then
    alter table page_category
      add constraint page_category_client_rule_fk
      foreign key (client_rule_id) references category_rule(id) on delete set null;
  end if;
end
$mig$;

create index if not exists idx_category_rule_project on category_rule (project_id, priority);

-- Automatic (re-)classification for a project. `entries` is a JSON array of
-- {url, category, secondary_categories?, confidence?, signals?}. A row a
-- human has already corrected (manual_override = true) is left untouched —
-- the WHERE clause on the DO UPDATE, not application code, is what enforces
-- this, so it holds no matter which caller reclassifies.
create or replace function upsert_page_categories(p_project_id uuid, entries jsonb)
returns void
language plpgsql
as $$
begin
  insert into page_category (
    project_id, url, category, secondary_categories, category_confidence, signals_matched
  )
  select
    p_project_id,
    e.url,
    e.category,
    coalesce(e.secondary_categories, '{}'::text[]),
    coalesce(e.confidence, 'medium'),
    coalesce(e.signals, '{}'::text[])
  from jsonb_to_recordset(entries) as e(
    url text, category text, secondary_categories text[], confidence text, signals text[]
  )
  on conflict (project_id, url) do update
    set category = excluded.category,
        secondary_categories = excluded.secondary_categories,
        category_confidence = excluded.category_confidence,
        signals_matched = excluded.signals_matched,
        updated_at = now()
    where page_category.manual_override = false;
end;
$$;

-- Patches { pageCategory } into crawl_run_results.data for every (url,
-- category) pair in `patches`, scoped to one run, in one statement.
-- jsonb `||` merges only the pageCategory key — everything else already on
-- the row (status, title, schemaTypes, ...) is untouched.
create or replace function patch_crawl_run_result_categories(p_run_id uuid, patches jsonb)
returns void
language plpgsql
as $$
begin
  update crawl_run_results r
  set data = r.data || jsonb_build_object('pageCategory', p.category)
  from jsonb_to_recordset(patches) as p(url text, category text)
  where r.run_id = p_run_id and r.url = p.url;
end;
$$;
