-- ═══════════════════════════════════════════════════════════════════════════
-- 0021 — Index crawl_run_results for per-URL lookup
--
-- Why this exists
-- ────────────────
-- On-demand PageSpeed Insights (repo.js#updateResultPagespeed) reads a run's
-- result row for one specific URL, merges in PSI data, and writes it back.
-- crawl_run_results had only idx_crawl_run_results_run (run_id alone), so
-- that lookup was a full scan of every row in the run to find one url match —
-- fine on a 40-page crawl, not fine on a 5,000-page one.
--
-- Additive and re-runnable. No column changes, no data touched.
-- ═══════════════════════════════════════════════════════════════════════════

create index if not exists idx_crawl_run_results_run_url
  on crawl_run_results (run_id, url);
