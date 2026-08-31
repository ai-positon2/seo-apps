// ── The metric envelope ─────────────────────────────────────────────────────
//
// METRICS.md §12: every number leaves the API pre-formatted AND raw —
// `{value, display, delta, deltaDisplay, direction}` — and the UI never does
// metric maths. That is not a style preference. The moment a component divides
// two numbers, the spec stops being the single source of truth and the same
// metric starts reading differently in two places.
//
// §11 is the whole of the formatting contract, and the part that matters most
// is the three-state rule:
//
//   no data in scope   → '—'
//   zero measured      → '—'
//   a real zero        → '0%'
//
// These are different claims. "We asked and you were never named" is a finding;
// "we could not ask" is not. Collapsing them tells a client they are invisible
// when the truth is that nothing was measured — the exact failure the nullable
// `mentioned` column exists to prevent.

const EMPTY = '—';

/**
 * Round half-up, symmetrically.
 *
 * `Math.round(-2.5)` is -2 — half rounds toward +Infinity, so a negative delta
 * of -2.5 would display as -2 while +2.5 displayed as +3. Deltas are compared
 * to each other in the UI, so the asymmetry has to go.
 */
function halfUp(n, decimals = 0) {
  const f = 10 ** decimals;
  const scaled = n * f;
  const r = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return r / f;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * A ratio as a percentage string.
 *
 * `dense` is §11's table-cell form (0 decimals); the default is the hero form
 * (1 decimal). 100% is never shown for anything short of exactly 1.0 —
 * 0.9996 rendering as "100%" would claim a perfect score that was not earned.
 */
function pct(ratio, { dense = false } = {}) {
  if (!isNum(ratio)) return EMPTY;
  const decimals = dense ? 0 : 1;
  let out = halfUp(ratio * 100, decimals);
  if (out >= 100 && ratio < 1) out = dense ? 99 : 99.9;
  if (out <= 0 && ratio > 0) out = dense ? 1 : 0.1;
  return `${out.toFixed(decimals)}%`;
}

// Read when used, not at require time — the same rule surfaces/index.js
// follows for AIV_DISABLED_SURFACES. A module-level read freezes the value
// before dotenv has run in some entry points.
const locale = () => process.env.AIV_NUMBER_LOCALE || 'en-US';

/** Integers with thousands separators (§11): 2305 → "2,305". */
function count(n) {
  if (!isNum(n)) return EMPTY;
  return Math.round(n).toLocaleString(locale());
}

/**
 * Abbreviated for bar labels and rail stats (§11).
 *
 * TRUNCATED, not rounded: 1,999 is "1.9k". Rounding up would let a bar label
 * read "2.0k" for a number that never reached 2,000.
 */
function compact(n) {
  if (!isNum(n)) return EMPTY;
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  const [div, suffix] = abs >= 1e6 ? [1e6, 'm'] : [1e3, 'k'];
  const truncated = Math.trunc((n / div) * 10) / 10;
  return `${truncated}${suffix}`;
}

/** Rates and averages — one decimal (§11). */
function rate(n) {
  if (!isNum(n)) return EMPTY;
  return halfUp(n, 1).toFixed(1);
}

/** Average rank: "#3.7" (§3.5). */
function position(n) {
  if (!isNum(n)) return EMPTY;
  return `#${halfUp(n, 1).toFixed(1)}`;
}

/** Sentiment is an integer, and `—` when nothing was scored (§3.6). */
function sentiment(n) {
  if (!isNum(n)) return EMPTY;
  return String(halfUp(n, 0));
}

const KINDS = {
  // §3.8: percentages move in percentage POINTS, counts in percent change.
  percent: { display: pct, deltaKind: 'points' },
  percentDense: { display: (v) => pct(v, { dense: true }), deltaKind: 'points' },
  count: { display: count, deltaKind: 'percent' },
  compact: { display: compact, deltaKind: 'percent' },
  rate: { display: rate, deltaKind: 'absolute' },
  position: { display: position, deltaKind: 'absolute' },
  // Whole points, matching the display. A value of "62" beside a delta of
  // "+3.5" implies a precision the 0-100 scale does not carry.
  sentiment: { display: sentiment, deltaKind: 'wholeAbsolute' },
  score: { display: (v) => (isNum(v) ? String(halfUp(v, 0)) : EMPTY), deltaKind: 'absolute' },
};

function formatDelta(kind, now, prev) {
  if (!isNum(now) || !isNum(prev)) return { delta: null, deltaDisplay: null };

  const { deltaKind } = KINDS[kind] || KINDS.count;
  const sign = (v) => (v > 0 ? '+' : '');

  if (deltaKind === 'points') {
    const d = now - prev;
    // "pts", not "%": a move from 20% to 30% is +10 points, not +50%, and
    // labelling it "%" is the most common way this number gets misread.
    return { delta: d, deltaDisplay: `${sign(d)}${halfUp(d * 100, 1).toFixed(1)} pts` };
  }

  if (deltaKind === 'percent') {
    // §3.8: a previous value of zero has no percent change. Showing +100% or ∞
    // would invent a trend out of a single first observation.
    if (prev === 0) return { delta: null, deltaDisplay: null };
    const d = (now - prev) / prev;
    return { delta: d, deltaDisplay: `${sign(d)}${halfUp(d * 100, 1).toFixed(1)}%` };
  }

  if (deltaKind === 'wholeAbsolute') {
    const d = now - prev;
    return { delta: d, deltaDisplay: `${sign(d)}${halfUp(d, 0)}` };
  }

  const d = now - prev;
  return { delta: d, deltaDisplay: `${sign(d)}${halfUp(d, 1).toFixed(1)}` };
}

/**
 * Build one metric.
 *
 * `direction` tells the UI which way is good WITHOUT it having to know what the
 * metric means. Position is the case that forces this: a rank moving from #4 to
 * #2 is a -2 delta and an improvement, and colouring by sign alone would paint
 * the best result on the page red.
 *
 * @param {number|null} value    null = not measurable in scope
 * @param {string} kind          a key of KINDS
 * @param {object} [opts]
 * @param {number|null} [opts.previous]
 * @param {'higher_is_better'|'lower_is_better'|'neutral'} [opts.direction]
 * @param {string} [opts.note]   why a value is null, when there is a reason
 */
function metric(value, kind = 'count', {
  previous = null, direction = 'higher_is_better', note = null,
} = {}) {
  const spec = KINDS[kind] || KINDS.count;
  const v = isNum(value) ? value : null;
  const { delta, deltaDisplay } = formatDelta(kind, v, isNum(previous) ? previous : null);

  return {
    value: v,
    display: spec.display(v),
    delta,
    deltaDisplay,
    direction,
    ...(note ? { note } : {}),
  };
}

/**
 * A ratio, guarding the three §11 states.
 *
 * A zero denominator returns null (`—`), never 0. "0 of 0" is not a zero
 * percent — it is nothing measured, and the difference is the whole point.
 */
function ratio(numerator, denominator) {
  if (!isNum(numerator) || !isNum(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

module.exports = {
  EMPTY,
  halfUp,
  pct,
  count,
  compact,
  rate,
  position,
  sentiment,
  formatDelta,
  metric,
  ratio,
  KINDS,
};
