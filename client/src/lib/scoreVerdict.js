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
