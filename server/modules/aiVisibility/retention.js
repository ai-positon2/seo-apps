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

const db = require('../../services/db');

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
  if (!db.isDatabaseConfigured()) return result;

  // The batch is chosen by a subquery inside the statement itself. This used to
  // be a select of ids followed by a second `update ... in (ids)` round trip,
  // because PostgREST offered no LIMIT on an update — an unbounded one being
  // exactly the lock held too long that the batching exists to avoid. In SQL the
  // bound goes where it belongs, and the two steps cannot disagree about which
  // rows were swept.
  const due = `
    select id from ai_visibility_captures
     where captured_at < $1 and raw is not null
     order by captured_at asc
     limit $2`;

  try {
    if (dryRun) {
      result.found = await db.count(`select count(*) from (${due}) d`, [cutoff, batch]);
      return result;
    }

    const swept = await db.rows(
      `update ai_visibility_captures set raw = null
        where id in (${due})
        returning id`,
      [cutoff, batch]
    );
    result.found = swept.length;
    result.cleared = swept.length;
    return result;
  } catch (error) {
    // A missing column means 0018/0019 have not been applied. Nothing to do is
    // the right answer; throwing would take a scheduled job down over a pending
    // migration. 42703 is undefined_column, 42P01 undefined_table.
    if (error.code === '42703' || error.code === '42P01'
      || /column .* does not exist|relation .* does not exist/i.test(error.message || '')) {
      return result;
    }
    throw new Error(`[aiVisibility.retention] ${error.message}`);
  }
}

/** How much is outstanding, so a sweep can be scheduled rather than guessed at. */
async function pending({ months = RETENTION_MONTHS } = {}) {
  const cutoff = cutoffIso(months);
  if (!db.isDatabaseConfigured()) return { cutoff, pending: 0 };
  try {
    const n = await db.count(
      `select count(*) from ai_visibility_captures
        where captured_at < $1 and raw is not null`,
      [cutoff]
    );
    return { cutoff, pending: n };
  } catch {
    return { cutoff, pending: 0 };
  }
}

module.exports = {
  RETENTION_MONTHS, BATCH, cutoffIso, sweep, pending,
};
