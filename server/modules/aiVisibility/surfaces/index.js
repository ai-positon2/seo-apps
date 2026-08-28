// ── The surfaces we can measure ──────────────────────────────────────────────
//
// Every surface exports one `capture(prompt)` returning the same contract, so
// scoring, share-of-voice and the insight layer never know which one produced a
// row. Adding Perplexity or Copilot is one file and one line here.
//
//   {
//     engine,          'chatgpt' | 'google_ai_overview' | ...
//     provider,        'dataforseo' | ...
//     surfaceLabel,    what the report is allowed to call it
//     access,          'scraped' (a consumer surface) | 'api' (the model direct)
//     answerText,      string | null   — null means no answer, not an empty one
//     citations,       [{ url, title, domain, index }]
//     webQueries,      string[]        — [] when the provider does not expose them
//     providerBrands,  string[]        — the provider's own entity extraction
//     modelVersion,    string | null
//     taskCost,        number | null   — null is unknown, never 0
//     capturedAt,      ISO string
//     raw,             the untouched provider body
//   }
//
// `access` is load-bearing rather than decorative. A scraped surface and an API
// surface answer different questions — the consumer product's retrieval stack
// versus the model's own — and a report that showed them under one label would
// be claiming an equivalence that does not hold.

const dataForSeoChatGpt = require('./dataForSeoChatGpt');
const dataForSeoAiOverview = require('./dataForSeoAiOverview');

const SURFACES = {
  [`${dataForSeoChatGpt.ENGINE}:${dataForSeoChatGpt.PROVIDER}`]: dataForSeoChatGpt,
  [`${dataForSeoAiOverview.ENGINE}:${dataForSeoAiOverview.PROVIDER}`]: dataForSeoAiOverview,
};

/** Every surface id, e.g. 'chatgpt:dataforseo'. */
function surfaceIds() {
  return Object.keys(SURFACES);
}

/** One surface, or null for an id we do not serve. Never throws on a typo. */
function surfaceFor(id) {
  return SURFACES[id] || null;
}

module.exports = { SURFACES, surfaceIds, surfaceFor };
