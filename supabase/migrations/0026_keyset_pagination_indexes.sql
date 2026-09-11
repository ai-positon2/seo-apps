-- ═══════════════════════════════════════════════════════════════════════════
-- 0026: composite (run_id, id) indexes for keyset-paginated bulk reads
-- ═══════════════════════════════════════════════════════════════════════════
--
-- crawledPages.js / crawlToArchitect.js page through crawl_run_links and
-- crawl_run_results with a keyset cursor (WHERE run_id = X AND id > lastSeenId
-- ORDER BY id LIMIT 1000), switched from OFFSET pagination because OFFSET's
-- cost grows with how deep into the table a page is.
--
-- That fix still needs an index that actually supports it. The only index on
-- either table is on (run_id) alone (0010/0012), so a query filtering by
-- run_id AND ordering by id still forces Postgres to gather every matching row
-- for that run_id and sort it in memory before applying the id filter and
-- limit — meaning every single page costs roughly the same as reading the
-- WHOLE run, not just the 1,000 rows asked for. A 272k-row run's link graph
-- pays that full-run cost on every one of its ~272 pages, which is exactly
-- what pushed individual pages past Postgres's own statement_timeout even
-- after switching away from OFFSET.
--
-- A composite (run_id, id) index lets Postgres seek directly to the cursor
-- position and read the next 1,000 rows in order — genuinely O(page size),
-- not O(rows in the run), regardless of how large the run is.
--
-- Additive and re-runnable. Does not replace the existing (run_id) indexes:
-- inboundCounts/crawlToArchitect always filter by run_id AND paginate by id
-- together, but idx_crawl_run_links_to/idx_crawl_run_links_from (run_id,
-- to_url/from_url) serve a different lookup and stay as they are.

create index if not exists idx_crawl_run_links_run_id
  on crawl_run_links (run_id, id);

create index if not exists idx_crawl_run_results_run_id
  on crawl_run_results (run_id, id);
