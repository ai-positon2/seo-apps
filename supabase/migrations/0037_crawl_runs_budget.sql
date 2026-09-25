-- ── What page budget did this run actually get, and who set it? ─────────────
--
-- crawl_runs.options records the options the row was CREATED with. The number a
-- run actually crawls with is resolved later, when the run executes, against the
-- workspace's admin limit as it stands at that moment
-- (crawlScope/run/manager.js). Those two numbers differ whenever a policy
-- changed, or whenever a caller asked for more than its workspace allows.
--
-- Nothing recorded the difference. The run page read run.options.maxUrls and
-- labelled it "budget", so a run cut from 5,000 pages to 500 displayed 5,000 —
-- and the only other number on screen was the crawler's progress ceiling
-- (maxUrls + maxExternalUrls), which is a third value nobody configured. "Why
-- did I only get 500 pages" had no answer anywhere in the product.
--
-- manager.js now writes the resolved options back over `options` and records the
-- provenance here:
--
--   { granted: 500, requested: 5000, source: 'workspace', clamped: true }
--
-- `source` is the surface that set the ceiling, straight from
-- adminLimits.effectiveLimits().sources — 'platform' | 'workspace' | 'tier' |
-- 'hard_max' | 'env_fallback' | 'run_override' | 'default'.
--
-- Nullable, and left null for every historical run: there is no honest value to
-- backfill, since the budget those runs used was never recorded. The UI shows
-- the stored options for those, exactly as it does today.

alter table crawl_runs add column if not exists budget jsonb;

comment on column crawl_runs.budget is
  'resolved page budget for this run: {granted, requested, source, clamped}; null for runs that predate the column';
