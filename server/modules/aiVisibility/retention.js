// ── Retention sweeper ───────────────────────────────────────────────────────
//
// Raw provider payloads are kept for 12 months, then dropped.
//
// The sweeper NULLS `raw` — it does not delete the capture row. That
// distinction is the whole design: the capture IS the evidence every historical
// metric was computed from, and METRICS.md §11 requires every number shown to a
// client to stay reproducible from stored captures at any later date. Deleting
// rows would rewrite history. Dropping the bulky original response does not:
// `answer_text`, the mention rows, the citation rows and their classification
// all survive, and they are what the metrics are actually built from.
//
// What is lost is the ability to RE-extract a 13-month-old capture under a new
// ruleset. That is an accepted trade — re-extraction is for recent captures
// while a rule is being tuned, and `extraction_version` on the row records
// which rules produced what is stored.

const { getSupabase, isSupabaseConfigured } = require('../../services/supabase');

const RETENTION_MONTHS = Number(process.env.AIV_RAW_RETENTION_MONTHS) || 12;

// Bounded per sweep. A first run against a year of backlog would otherwise try
// to rewrite every row at once, and a single enormous UPDATE holding locks is a
// worse outage than a sweep that takes a few days to catch up.
const BATCH = Number(process.env.AIV_RETENTION_BATCH) || 500;

function cutoffIso(months = RETENTION_MONTHS, now = new Date()) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

/**
 * One sweep.
 *
 * @param {object} [options]
 * @param {number} [options.months]
 * @param {number} [options.batch]
 * @param {boolean} [options.dryRun] count what would be cleared, change nothing
 * @returns {Promise<{cutoff, found, cleared, dryRun}>}
 */
async function sweep({ months = RETENTION_MONTHS, batch = BATCH, dryRun = false } = {}) {
  const cutoff = cutoffIso(months);
  const result = {
    cutoff, found: 0, cleared: 0, dryRun: Boolean(dryRun),
  };
  if (!isSupabaseConfigured()) return result;

  const db = getSupabase();

  // Select ids first rather than issuing a blind UPDATE with a WHERE. PostgREST
  // gives no easy LIMIT on an update, and an unbounded one is exactly the lock
  // held too long that the batching exists to avoid.
  const { data: due, error } = await db
    .from('ai_visibility_captures')
    .select('id')
    .lt('captured_at', cutoff)
    .not('raw', 'is', null)
    .order('captured_at', { ascending: true })
    .limit(batch);

  if (error) {
    // A missing column means 0018/0019 have not been applied. Nothing to do is
    // the right answer; throwing would take a scheduled job down over a pending
    // migration.
    if (/column .* does not exist|schema cache/i.test(error.message || '')) return result;
    throw new Error(`[aiVisibility.retention] ${error.message}`);
  }

  result.found = (due || []).length;
  if (dryRun || !result.found) return result;

  const { error: updateError } = await db
    .from('ai_visibility_captures')
    .update({ raw: null })
    .in('id', due.map((r) => r.id));

  if (updateError) throw new Error(`[aiVisibility.retention] ${updateError.message}`);
  result.cleared = result.found;
  return result;
}

/** How much is outstanding, so a sweep can be scheduled rather than guessed at. */
async function pending({ months = RETENTION_MONTHS } = {}) {
  if (!isSupabaseConfigured()) return { cutoff: cutoffIso(months), pending: 0 };
  const { count, error } = await getSupabase()
    .from('ai_visibility_captures')
    .select('id', { count: 'exact', head: true })
    .lt('captured_at', cutoffIso(months))
    .not('raw', 'is', null);
  if (error) return { cutoff: cutoffIso(months), pending: 0 };
  return { cutoff: cutoffIso(months), pending: count || 0 };
}

module.exports = {
  RETENTION_MONTHS, BATCH, cutoffIso, sweep, pending,
};
