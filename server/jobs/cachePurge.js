// ── Cache retention sweeper ─────────────────────────────────────────────────
// The `cache` table is keyed by an opaque sha1 and its TTL is applied ON READ
// (supabaseStore.cacheGet), so without this job nothing is ever physically
// deleted: expired rows, and every row orphaned by a hand-bumped key prefix
// (e.g. 'dental-kw-adapter-v7' after the bump to v8), accumulate forever.
//
// This is what makes the module's retention policy real rather than advisory —
// notably the 180-day retention on billed SEMrush pulls
// (locationPageBuilder/config.js -> cache.semrushTtlMs).
//
// Scoped to the `cache` table ONLY. Durable records — lpb_pages,
// lpb_keywordselections, lpb_keyword_universe — are kept forever unless
// explicitly deleted, and are never touched here.

const cron = require('node-cron');
const { isSupabaseConfigured } = require('../services/supabase');
const supabaseStore = require('../services/supabaseStore');

// Daily at 03:15 — off-peak, and frequent enough that the table never carries
// more than a day of dead rows.
const SCHEDULE = process.env.LPB_CACHE_PURGE_CRON || '15 3 * * *';

let scheduledJob = null;

async function runPurge() {
  if (!isSupabaseConfigured()) return null;
  const result = await supabaseStore.purgeExpired();
  console.log(`[CachePurge] Removed ${result.expired} expired + ${result.stale} stale cache rows.`);
  return result;
}

function init() {
  if (scheduledJob) {
    scheduledJob.destroy();
    scheduledJob = null;
  }
  if (!isSupabaseConfigured()) {
    console.log('[CachePurge] Supabase not configured — sweeper not scheduled.');
    return;
  }
  if (!cron.validate(SCHEDULE)) {
    console.error(`[CachePurge] Invalid cron expression "${SCHEDULE}" — sweeper not scheduled.`);
    return;
  }
  // A purge failure must never take the process down; it just means dead rows
  // linger until the next run.
  scheduledJob = cron.schedule(SCHEDULE, () => {
    runPurge().catch(err => console.error('[CachePurge] Purge failed:', err.message));
  });
  console.log(`[CachePurge] Scheduler initialised — ${SCHEDULE}`);
}

module.exports = { init, runPurge };
