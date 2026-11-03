/**
 * The verdict a 0-100 score earns, on the same bands the dashboard colours it
 * with (80+ green, 60-79 amber, below 60 red). Null when there is no score, so
 * callers fall back to the run status instead of inventing a judgement.
 *
 * Kept in its own dependency-free module so the node test runner can load it.
 */
export function scoreVerdict(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return null;
  const s = Math.round(Number(score));
  if (s >= 80) return { label: 'Good', tone: 'accent' };
  if (s >= 60) return { label: 'Needs attention', tone: 'warn' };
  return { label: 'At risk', tone: 'neg' };
}

/**
 * The colour a 0-100 score is drawn in, on the same bands as scoreVerdict.
 * Null when there is no score, so the caller draws a muted dash rather than a
 * red one.
 */
export function scoreBandColor(score) {
  const verdict = scoreVerdict(score);
  if (!verdict) return null;
  return { accent: 'var(--primary)', warn: 'var(--viz-warn)', neg: 'var(--viz-neg)' }[verdict.tone];
}

/**
 * The same bands as a tone name ('success' | 'warning' | 'danger'), for screens
 * that colour with the semantic tokens. Every 0–100 score on the platform uses
 * these thresholds (80 / 60): SEO & GEO used 75 / 60, Hub & Spoke 70 / 40 and
 * Agent Readiness 75 / 50, so one number changed colour and verdict from one
 * screen to the next. A module may word its bands differently; it may not move
 * them. Null when there is no score.
 */
export function scoreTone(score) {
  const verdict = scoreVerdict(score);
  if (!verdict) return null;
  return { accent: 'success', warn: 'warning', neg: 'danger' }[verdict.tone];
}

export const SCORE_GOOD_AT = 80;
export const SCORE_WATCH_AT = 60;
