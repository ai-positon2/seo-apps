// ── Shared intent vocabulary ─────────────────────────────────────────────────
//
// Extracted from two independent copies that had drifted apart in nothing but
// coincidence: routes/keywordResearch.js's CONVERSION_WORDS/
// getConversionIntentScore, and modules/marketPotential/basketAgent.js's
// INFORMATIONAL_RE/NEAR_ME_RE. Behaviour is unchanged — both call sites import
// from here now instead of keeping their own copy.
//
// IMPORTANT for callers building AI Visibility prompts: these are
// CLASSIFIERS, for scoring or filtering keyword candidates that came from
// somewhere else. They are not a "keep only good buyer terms" sanitizer.
// basketAgent.sanitizeTerms uses INFORMATIONAL_RE/NEAR_ME_RE to DROP
// informational queries and "near me" — correct for a commercial-only demand
// basket, wrong for AI Visibility, which wants both: "near me" is a real
// ChatGPT query and cluster_informational is a whole coverage slot. Import the
// regexes to classify; do not reuse a sanitizer built to exclude what this
// module needs.

// A query is asking "which provider" rather than "what is this" — cost,
// scheduling, and comparison words a buyer types when ready to act.
const CONVERSION_WORDS = [
  'cost', 'price', 'pricing', 'book', 'schedule', 'appointment', 'quote',
  'free', 'cheap', 'affordable', 'near me', 'local', 'best',
];

// Narrower than CONVERSION_WORDS — just the money words, for a cost/pricing
// coverage slot that should not also fire on "best" or "local".
const COST_RE = /\b(cost|price|pricing|afford(?:able)?|cheap|quote)\b/i;

const INFORMATIONAL_RE = /^(what|how|why|when|who|is|are|does|can)\b|guide|meaning|definition|symptoms?\b/i;
const NEAR_ME_RE = /\bnear\s?me\b|\bnearby\b|\bin my area\b|\baround me\b/i;

function getConversionIntentScore(titleSnippet) {
  const text = String(titleSnippet || '').toLowerCase();
  const matches = CONVERSION_WORDS.filter((w) => text.includes(w));
  return Math.min(1.0, matches.length / 2);
}

module.exports = {
  CONVERSION_WORDS,
  COST_RE,
  INFORMATIONAL_RE,
  NEAR_ME_RE,
  getConversionIntentScore,
};
