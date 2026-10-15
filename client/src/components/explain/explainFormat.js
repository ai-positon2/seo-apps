// ── Formatting figures for the explainer copy ───────────────────────────────
//
// Every helper returns null for a missing number so the caller can fall back to
// wording that does not need one. None of them turns "missing" into 0: a zero in
// an explanation is a claim that something was measured and came out empty
// (PRD §16.11).

export const NOT_MEASURED = 'not measured yet';

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 1284 → "1,284". */
export const num = (v) => (isNum(v) ? Math.round(v).toLocaleString('en-US') : null);

/** 18400 → "18.4K", 30000 → "30K", 2500000 → "2.5M". */
export function compact(v) {
  if (!isNum(v)) return null;
  const abs = Math.abs(v);
  const one = (x) => String(Math.round(x * 10) / 10);
  if (abs >= 1e6) return `${one(v / 1e6)}M`;
  if (abs >= 1e3) return `${one(v / 1e3)}K`;
  return String(Math.round(v));
}

export const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

/** ['a'] → "a", ['a','b'] → "a and b", ['a','b','c'] → "a, b and c". */
export function list(items) {
  const xs = (items || []).filter(Boolean);
  if (xs.length <= 1) return xs[0] || '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
