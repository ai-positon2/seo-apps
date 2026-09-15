-- ═══════════════════════════════════════════════════════════════════════════
-- 0028: indexes for the sort and filter columns the hot read paths already use
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every index here serves a query that is already in the codebase, character
-- for character. Nothing about WHAT is read, by WHOM, or under WHICH filter
-- moves -- which matters more here than in most schemas, because there is no
-- RLS with policies: the app connects as owner and the workspace/owner filter
-- in each query IS the tenancy check (0010:9-15, 0012:29-30, 0016:23-24). An
-- index cannot weaken that. A rewritten WHERE clause could, which is why this
-- migration adds indexes and changes no SQL.
--
-- ── 1. crawl_run_finding_instances (run_id, id) ────────────────────────────
-- 0026 gave crawl_run_links and crawl_run_results a composite (run_id, id) for
-- exactly this access shape, and the third table with the same shape was left
-- out. Its only index is (run_id) alone (0023:53), so all three readers --
-- projects/overview.js:315-322, crawlScope/db/repo.js:676-680 and :699-703 --
-- filter by run_id and then ORDER BY id with nothing supporting both columns.
--
-- Measured rather than assumed, against a 90,365-row table whose largest run
-- holds 17,642 instances:
--
--   page 0   Seq Scan, Rows Removed by Filter: 72,723 -- the whole table read
--            to find one run -- then a WindowAgg for the count(*) over ()
--            that spills to disk (Storage: Disk, Maximum Storage: 19,183kB),
--            then a top-N sort.  70.4 ms, shared hit=14,868, temp r/w 4297/2399
--   deep     Index Scan using the PRIMARY KEY (id), filtering run_id and
--            discarding 37,095 rows on the way.  21.8 ms, shared hit=10,713
--
-- So be precise about what this index does and does not buy. It removes the
-- seq scan: (run_id, id) seeks straight to the run and reads it already in id
-- order. It does NOT remove the disk spill on page 0 -- count(*) over ()
-- materialises every matching row, data blob and all, whatever the access
-- path is. That window is a logic change, not an index, and is deliberately
-- left alone here.
--
-- Those numbers also understate the production case, because the run measured
-- is ~20% of its table, which is why the planner chose a seq scan at all. A
-- 2,600-page crawl produces 18,000-20,000 instances (0023's header), and as
-- runs accumulate each becomes a smaller fraction of the whole -- the regime
-- where a missing composite index hurts most, and where overview.js compounds
-- it: page 0 computes the total, then :343-345 fires every REMAINING offset
-- page in PARALLEL off it, against a pool of ten connections, on a dashboard
-- that polls every 8 seconds while a crawl is live.
--
-- ── What happened when this was applied ────────────────────────────────────
-- Recorded so nobody re-derives it: on the database described above the index
-- is created, valid, and NOT CHOSEN. After applying, page 0 still plans as a
-- Seq Scan with identical buffers (shared hit=14,868) and the identical 19 MB
-- spill; deep pages still use the primary key. Forcing the issue with
-- enable_seqscan=off does not select it either -- Postgres still prefers
-- crawl_run_finding_instances_pkey.
--
-- That is the planner being right, not the index being wrong. `id` is an
-- identity column and a run's instances are written in one burst, so the heap
-- is already physically clustered by (run_id, id); scanning the pkey through a
-- contiguous region beats 1,000 random heap fetches driven by a secondary
-- index. It holds only while a run is a large, contiguous share of the table
-- (here: 17,642 of 90,365 rows, ~20%). As runs accumulate and interleave, that
-- clustering decays and the composite index is what keeps these reads O(page).
--
-- So this index is insurance bought at 3.6 MB, not a measured win, and it must
-- not be reported as one. Re-check it against a production-shaped dataset
-- before believing the dashboard poll got cheaper.
--
-- ── 2. crawl_runs (project_id, status, finished_at desc) ───────────────────
-- `where project_id = $1 and status in ('completed','stopped')
--  order by finished_at desc limit 1` -- projects/crawledPages.js:66-70 and
-- projects/crawlToArchitect.js:99-103, reached from roughly seven call sites on
-- every module audit, page sync and Content Architect build. finished_at is
-- indexed nowhere: 0010:211-216 and 0025:89 cover owner, project_id alone,
-- status alone, workspace_id, heartbeat and control_request. Leading with
-- status lets the IN list be walked as two ordered streams and merged, instead
-- of scanning finished_at desc past every running and failed run to find the
-- first completed one.
--
-- ── 3. crawl_runs (project_id, created_at desc) ────────────────────────────
-- `where project_id = $1 order by created_at desc limit 12` --
-- projects/overview.js:144-147, called from five places including
-- liveCrawlStatus (:573-575), which the app shell polls every 4 seconds on
-- EVERY screen. idx_crawl_runs_project (0010:212) is (project_id) alone, so
-- the twelve newest rows are found by sorting all of that project's runs.
--
-- ── 4. ai_visibility_captures (project_id, captured_at, id) ────────────────
-- ~2,800 captures a day at design volume (0019's header).
-- aiVisibility/store.js:1356-1381 pages `where project_id = $1
-- [and captured_at >= .. and captured_at <= ..] order by captured_at asc,
-- id asc`, and aiVisibility/budget.js:48-51 sums task_cost over the same
-- filter. Neither is served today. 0016:154's (project_id, engine,
-- captured_at desc) has `engine` BETWEEN the two columns these filter on, so
-- it cannot produce captured_at order for a query that does not fix engine;
-- and 0018:243's (project_id, captured_at) is PARTIAL on `extracted_at is
-- null`, which is the complement of the rows a report reads. `id` is included
-- because it is the tie-break, and store.js:1377-1381 explains why that
-- tie-break is load-bearing: captured_at is not unique, and an unstable order
-- across a page boundary silently moves every denominator in the report.
--
-- ── 5. project_pages (project_id, inbound_links desc nulls last, id asc) ───
-- projects/pages.js:326-328 sorts on inbound_links, which is indexed nowhere
-- (0015:116-126 are all partial indexes on other columns), inside readAll's
-- 1,000-row OFFSET loop (:104-121) -- so the project's whole page set is
-- re-sorted for every page of it. `nulls last` is spelled out because a btree
-- DESC column defaults to NULLS FIRST and the query says NULLS LAST; without
-- it the index ordering would not match and Postgres would sort anyway.
--
-- ── 6. project_module_page_runs (project_id, url, created_at desc, id desc) ─
-- projects/pages.js:509-512, `where project_id = $1 and page_id is null and
-- url = $2 order by created_at desc, id desc`. The nearest existing index,
-- idx_pmpr_page_history (0014:115-116), is (project_id, module_key, url,
-- created_at desc) -- module_key sits between the two columns this filters on
-- and is not constrained here, so it cannot serve this lookup. Partial on
-- `page_id is null`, which is both the query's own predicate and, since 0015
-- introduced page_id, the minority of rows.
--
-- ── Applying this ──────────────────────────────────────────────────────────
-- scripts/migrate.js:291 runs each file inside db.tx(), so CREATE INDEX
-- CONCURRENTLY cannot appear here -- Postgres refuses it inside a transaction
-- block, and a multi-statement simple query is itself an implicit one. These
-- are therefore plain CREATE INDEX, which takes a SHARE lock: reads continue,
-- writes to that table block for the build. Apply with no crawl and no AI
-- Visibility run in flight. If a table has grown past the point where that
-- pause is acceptable, build that one index by hand with CONCURRENTLY over the
-- DIRECT (non-pooler) endpoint and let the statement below no-op.
--
-- Additive and re-runnable. No column, table or row is touched, and no
-- existing index is dropped -- each of these sits alongside the one it
-- complements, which still serves the lookup it was made for.
-- ═══════════════════════════════════════════════════════════════════════════

create index if not exists idx_crawl_run_finding_instances_run_id
  on crawl_run_finding_instances (run_id, id);

create index if not exists idx_crawl_runs_project_status_finished
  on crawl_runs (project_id, status, finished_at desc);

create index if not exists idx_crawl_runs_project_created
  on crawl_runs (project_id, created_at desc);

create index if not exists idx_ai_visibility_captures_project_captured
  on ai_visibility_captures (project_id, captured_at, id);

create index if not exists idx_project_pages_inbound
  on project_pages (project_id, inbound_links desc nulls last, id asc);

create index if not exists idx_pmpr_project_url_unlinked
  on project_module_page_runs (project_id, url, created_at desc, id desc)
  where page_id is null;
