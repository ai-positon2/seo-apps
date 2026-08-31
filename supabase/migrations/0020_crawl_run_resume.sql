-- ═══════════════════════════════════════════════════════════════════════════
-- 0020 — Resumable crawl runs
--
-- Why this exists
-- ───────────────
-- A crawl killed mid-flight (OOM, host loss, redeploy) lost everything it had
-- done. reapStaleRuns requeued the run, deleteRunResults wiped its partial
-- rows, and the retry started again from the seed URL — because the FRONTIER
-- (which URLs had been seen, and which were still queued) lived only in the
-- crawler's memory and died with the process.
--
-- For a forty-minute crawl killed at 95% that is forty minutes thrown away, and
-- RUN_MAX_ATTEMPTS=2 means the second failure abandons the run altogether. On a
-- large site the odds of two consecutive clean forty-minute windows are exactly
-- the odds of the client ever receiving a report.
--
--   crawl_runs.checkpoint   the crawler's frontier, written periodically while
--                           the run executes and read back when it is reclaimed.
--                           Holds { seen, queue, inlinks, sitemapMembership,
--                           siteDiagnostics, robots... } — see
--                           SeoCrawler#snapshot() in modules/crawlScope/crawler.js.
--
-- The already-stored crawl_run_results rows are the other half: on resume they
-- are NOT deleted, they are counted as pages already done. So a resumed run
-- re-fetches only what it had not reached.
--
-- Additive and re-runnable. Drops nothing, rewrites no existing row's meaning.
-- A run with a NULL checkpoint resumes exactly the way it always did — from the
-- seed — so nothing that predates this migration changes behaviour.
-- ═══════════════════════════════════════════════════════════════════════════

alter table if exists crawl_runs
  add column if not exists checkpoint jsonb;

comment on column crawl_runs.checkpoint is
  'Crawler frontier snapshot for resuming an interrupted run. NULL means "start from the seed".';

-- The reaper reads status + heartbeat and then needs the checkpoint for exactly
-- the rows it is about to reclaim, so the existing status/heartbeat index still
-- does the selection work and this column is only ever fetched by id.
