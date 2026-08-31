// ── Periods and deltas ──────────────────────────────────────────────────────
//
// METRICS.md §3.8: every delta is the current period against the immediately
// preceding period of EQUAL LENGTH, same prompts, same models.
//
// The clause doing the real work is "same prompts". This module's whole reason
// for existing is the prompt-set intersection rule:
//
//   If the prompt set changed between periods, compute deltas on the
//   INTERSECTION of prompts and flag the header.
//
// Without it, approving five easy prompts would show up as a visibility jump —
// a number that moved because the questions changed, presented to a client as
// though their position improved. That is the single most misleading thing this
// module could do, so the comparison narrows to the questions both periods
// actually asked, and says how many that was.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight UTC for a date-only string or a Date. */
function startOfDay(d) {
  const date = d instanceof Date ? new Date(d) : new Date(`${String(d).slice(0, 10)}T00:00:00Z`);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * The current window and the one immediately before it, of equal length.
 *
 * `to` is INCLUSIVE — a 30-day period ending today includes today — so the
 * length is the day count, not the difference. Getting this wrong by one day
 * makes the previous period a different size from the current one, and every
 * delta on the page becomes a comparison between windows of unequal length.
 *
 * @param {object} [input]
 * @param {string|Date} [input.from]
 * @param {string|Date} [input.to]
 * @param {number} [input.days=30] used when `from` is not given
 */
function periods({ from = null, to = null, days = 30 } = {}) {
  const end = startOfDay(to || new Date());
  const start = from ? startOfDay(from) : new Date(end.getTime() - (days - 1) * DAY_MS);
  const length = Math.round((end - start) / DAY_MS) + 1;

  const prevEnd = new Date(start.getTime() - DAY_MS);
  const prevStart = new Date(prevEnd.getTime() - (length - 1) * DAY_MS);

  return {
    days: length,
    current: { from: iso(start), to: iso(end) },
    previous: { from: iso(prevStart), to: iso(prevEnd) },
  };
}

/** Captures whose `capturedAt` falls inside a window, `to` inclusive. */
function inPeriod(captures, { from, to }) {
  const start = startOfDay(from).getTime();
  const end = startOfDay(to).getTime() + DAY_MS - 1;
  return (captures || []).filter((c) => {
    const t = new Date(c.capturedAt).getTime();
    return Number.isFinite(t) && t >= start && t <= end;
  });
}

/**
 * §3.8's intersection rule.
 *
 * Returns the prompt ids both periods measured, plus what the header has to
 * say. `changed` being true is not an error — prompt sets are meant to grow —
 * it is a disclosure, and the report must carry it beside the deltas rather
 * than presenting a narrowed comparison as if it were the whole set.
 */
function promptIntersection(currentCaptures, previousCaptures) {
  const now = new Set(currentCaptures.map((c) => c.promptId).filter(Boolean));
  const before = new Set(previousCaptures.map((c) => c.promptId).filter(Boolean));
  const shared = [...now].filter((id) => before.has(id));

  const changed = shared.length !== now.size || shared.length !== before.size;
  return {
    promptIds: shared,
    currentCount: now.size,
    previousCount: before.size,
    sharedCount: shared.length,
    changed,
    // §3.8's own wording: "comparison on 47 of 50 prompts".
    note: changed && shared.length
      ? `Comparison on ${shared.length} of ${now.size} prompts — the question set changed between periods.`
      : null,
    // A delta over zero shared prompts is not a narrow comparison, it is no
    // comparison at all. Better to show no delta than one built on nothing.
    comparable: shared.length > 0,
  };
}

/**
 * Split captures into the two windows and resolve the comparison basis.
 *
 * Everything a report needs to compute both sides of a delta correctly, in one
 * call — so no report has to remember to apply the intersection itself.
 *
 * @returns {{period, current, previous, comparison, warnings}}
 */
function split(captures, options = {}) {
  const period = periods(options);
  const current = inPeriod(captures, period.current);
  const previous = inPeriod(captures, period.previous);
  const comparison = promptIntersection(current, previous);

  const warnings = [];
  if (comparison.changed) warnings.push('prompt_set_changed');
  if (!comparison.comparable) warnings.push('no_comparable_period');

  return {
    period,
    current,
    previous,
    comparison,
    // The rows each side of a delta must be computed over: the intersection
    // only. Headline values still use the full current period — a client's
    // visibility this month is over the prompts asked this month, not a subset
    // chosen to match last month.
    currentForDelta: comparison.comparable
      ? current.filter((c) => comparison.promptIds.includes(c.promptId))
      : [],
    previousForDelta: comparison.comparable
      ? previous.filter((c) => comparison.promptIds.includes(c.promptId))
      : [],
    warnings,
  };
}

module.exports = {
  DAY_MS,
  startOfDay,
  periods,
  inPeriod,
  promptIntersection,
  split,
};
