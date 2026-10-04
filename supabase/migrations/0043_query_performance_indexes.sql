-- ═══════════════════════════════════════════════════════════════════════════
-- 0043: indexes for filters the code already uses, and drops for ones it never does
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Same rule as 0028: every index added here serves a query already in the
-- codebase, predicate for predicate, and no WHERE clause changes because of
-- it. An index cannot change what a query returns, only how it is found, so
-- nothing here changes a result, a tenancy check or an API response.
--
-- Timings are from PGlite (single-threaded, in memory) holding the full
-- migration stack plus a synthetic run of 60,000 pages, 240,000 finding
-- instances and 480,000 link edges. Absolute numbers will differ on RDS; the
-- ratios are the point.
--
-- ── Added: read paths ──────────────────────────────────────────────────────
-- 1. crawl_run_results (run_id, id) WHERE data->>'scope' = 'Internal'
--    The exact predicate of seven readers: projects/overview.js
--    internalPageCount and internalHtmlPageCount, crawledPages.js (two
--    keyset readers), crawlToArchitect.js (two), streamingAudit.js. Without it
--    each one detoasts every page's `data` blob to test the scope, including
--    the overview's two counts that re-run on every dashboard poll.
--    count(*) of a run's internal pages: 1,091 ms -> 13 ms (index-only).
--
-- 2. crawl_run_results (run_id, url, id) WHERE data ? 'pagespeed'
--    repo.js listRunPageSpeed, `where run_id = $1 and data ? 'pagespeed'
--    order by url, id`, inside the locked PageSpeed-refresh transaction.
--    Only rows with a PSI result are indexed, so it is tiny. 759 ms -> 2 ms.
--
-- 3. crawl_run_finding_instances (run_id, rule_id)
--    repo.js replaceRuleFindings, `delete ... where run_id = $1 and
--    rule_id = any($2)`, same transaction. 1,903 ms -> 235 ms.
--
-- 4. project_module_runs (project_id, created_at desc)
--    moduleEvidence.js latestByModule, `where project_id = $1 order by
--    created_at desc limit $2`, on every project overview. The existing
--    idx_pmr_project_module has module_key between the two columns, so it
--    cannot produce that order and every run of the project was sorted.
--
-- 5. project_pages (project_id, id)
--    pages.js syncFromCrawl and keyToId now read in keyset order
--    (`id > $last order by id`). This is the index that makes each page a seek.
--
-- ── Added: foreign keys that deletes check ─────────────────────────────────
-- Postgres does not index a referencing column for you. ON DELETE SET NULL /
-- CASCADE has to find the child rows, and without an index that is a scan of
-- the child table for every parent row deleted.
--   project_pages.first_seen_run / last_seen_run -> crawl_runs: every crawl_runs
--     delete (supersedeActiveRuns, purge) scanned project_pages twice.
--     Deleting one small run: 1,467 ms -> 657 ms.
--   crawl_run_links.project_id -> crawl_projects (project purge)
--   project_module_runs.tool_run_id -> tool_runs (workspace purge)
--   ai_visibility_prompts.generation_run_id -> project_module_runs
--   capture_attribute.brand_id / project_id (brand and project cascades; the
--     only project_id index is partial on attribute_id is not null)
-- Partial on `is not null` where the column is optional, which is all the
-- delete check ever looks for.
--
-- ── Dropped: indexes nothing needs ─────────────────────────────────────────
-- Each one is either the leading prefix of another index on the same table,
-- which serves every lookup it could, or filters on columns no query filters
-- on. crawl_run_links is the largest table (2.1M rows, 754 MB on production,
-- 2026-10-04) and takes a whole crawl's edges in bulk: inserting 10,000 edges
-- took 781 ms with its current five indexes and 341 ms without the three
-- dropped below. Production pg_stat_user_indexes since 2026-08-27:
--   idx_crawl_run_links_run   (run_id)          2 scans, 13 MB -> (run_id, id)
--   idx_crawl_run_links_to    (run_id, to_url)   0 scans, 26 MB
--   idx_crawl_run_links_from  (run_id, from_url) 0 scans, 24 MB
--     0012 created to/from and nothing has ever queried by either column: the
--     link graph is only read whole, by run, in id order. Checked across
--     server/ and every migration's SQL before dropping.
--   idx_crawl_runs_project    (project_id)       0 scans -> (project_id, created_at desc)
--   idx_page_category_project (project_id)       1 scan  -> unique (project_id, url)
--
-- Kept on purpose, although each is a prefix of a wider index: production
-- shows them in regular use, they are small (16 kB to 1.7 MB), and keeping
-- them is the conservative choice. idx_crawl_runs_status (94k scans),
-- idx_crawl_run_finding_instances_run (10k), idx_crawl_run_results_run (5k),
-- idx_admin_limit_policies_effective (3.4k) and the two Content Architect
-- project_id indexes (100 and 31).
-- Recreating any dropped index is one CREATE INDEX.
--
-- ── Applying this ──────────────────────────────────────────────────────────
-- scripts/migrate.js runs each file inside db.tx(), so CONCURRENTLY cannot be
-- used here (see 0028). Plain CREATE INDEX takes a SHARE lock: reads continue,
-- writes to that table wait for the build. Index 1 has to read and detoast
-- every row of crawl_run_results, so apply with no crawl, module run or AI
-- Visibility run in flight. If that pause is not acceptable, build the large
-- ones by hand first with CREATE INDEX CONCURRENTLY over the direct endpoint;
-- the IF NOT EXISTS below then no-ops. DROP INDEX takes a brief exclusive lock.
--
-- Re-runnable. No column, table or row is touched.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── read paths ─────────────────────────────────────────────────────────────

create index if not exists idx_crawl_run_results_run_internal
  on crawl_run_results (run_id, id)
  where (data->>'scope') = 'Internal';

create index if not exists idx_crawl_run_results_run_pagespeed
  on crawl_run_results (run_id, url, id)
  where data ? 'pagespeed';

create index if not exists idx_crawl_run_finding_instances_run_rule
  on crawl_run_finding_instances (run_id, rule_id);

create index if not exists idx_pmr_project_created
  on project_module_runs (project_id, created_at desc);

create index if not exists idx_project_pages_project_id
  on project_pages (project_id, id);

-- ── foreign keys that deletes check ────────────────────────────────────────

create index if not exists idx_project_pages_first_seen_run
  on project_pages (first_seen_run)
  where first_seen_run is not null;

create index if not exists idx_project_pages_last_seen_run
  on project_pages (last_seen_run)
  where last_seen_run is not null;

create index if not exists idx_crawl_run_links_project
  on crawl_run_links (project_id)
  where project_id is not null;

create index if not exists idx_pmr_tool_run
  on project_module_runs (tool_run_id)
  where tool_run_id is not null;

create index if not exists idx_ai_visibility_prompts_generation_run
  on ai_visibility_prompts (generation_run_id)
  where generation_run_id is not null;

create index if not exists idx_capture_attribute_brand
  on capture_attribute (brand_id);

create index if not exists idx_capture_attribute_project
  on capture_attribute (project_id);

-- ── redundant or unused ────────────────────────────────────────────────────

drop index if exists idx_crawl_run_links_run;
drop index if exists idx_crawl_runs_project;
drop index if exists idx_page_category_project;
drop index if exists idx_crawl_run_links_to;
drop index if exists idx_crawl_run_links_from;
