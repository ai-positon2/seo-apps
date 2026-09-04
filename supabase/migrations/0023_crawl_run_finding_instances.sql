-- ═══════════════════════════════════════════════════════════════════════════
-- 0023 — Move per-occurrence findings out of crawl_runs.summary
--
-- Why this exists — a real production incident, not a preventive change
-- ────────────────────────────────────────────────────────────────────
-- crawl_runs.summary.findings has always held the FULL per-occurrence findings
-- list (title/detail/detectedValue/recommendation repeated on every row) for a
-- run, written in one shot in the single UPDATE that finalizes a crawl
-- (run/manager.js). That comment already existed elsewhere in this codebase —
-- "summary... carries every finding and reaches tens of megabytes on a large
-- crawl" — but the write path itself was never fixed to match, only the read
-- paths that could afford to skip it (listRuns/listRunsForViewer's narrow
-- selects).
--
-- Raising the crawl ceiling from 500 to 10,000 pages made this a live outage:
-- a ~2,600-page gentledental.com crawl produces roughly 18,000-20,000 finding
-- objects, and the single UPDATE embedding all of them started failing with
-- "canceling statement due to statement timeout" — confirmed against three
-- real failed runs, all timing out around that same page count, while every
-- run's crawl_run_results (chunked writes) and crawl_run_links (also chunked)
-- finished storing correctly in the same run.
--
-- results and links already solved exactly this problem this way; findings
-- gets the same treatment now:
--
--   crawl_run_finding_instances   one row per occurrence, chunked-inserted
--                                 (INSERT, not one big UPDATE) the same way
--                                 crawl_run_links already handles a quarter
--                                 million rows without incident. `data` holds
--                                 the finding exactly as analyzer.js produced
--                                 it, so every existing reader of a "finding
--                                 object" (title/severity/detectedValue/...)
--                                 needs no shape change — only where it reads
--                                 the array FROM changes.
--
-- crawl_run_findings (the per-rule rollup with a count) is untouched — several
-- other modules (projects/overview, projects/moduleDetail) already depend on
-- its existing one-row-per-rule shape, and repurposing it would have broken
-- them silently instead of fixing the actual problem.
--
-- Additive. No existing column, table, or row is touched.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crawl_run_finding_instances (
  id bigint generated always as identity primary key,
  run_id uuid not null references crawl_runs(id) on delete cascade,
  owner uuid not null references app_users(id) on delete cascade,
  finding_id text not null,
  rule_id text not null,
  data jsonb not null
);

create index if not exists idx_crawl_run_finding_instances_run on crawl_run_finding_instances (run_id);
