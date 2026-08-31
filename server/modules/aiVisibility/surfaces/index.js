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
//     features,        string[]        — what the engine DID: 'web_search',
//                                        'map', 'prose'. Top level. Existing
//                                        adapters put it in `raw` and
//                                        capture.js reads both, but a new one
//                                        should return it here.
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
const chatgptScraped = require('./chatgptScraped');
const geminiScraped = require('./geminiScraped');
const { aiOverview: googleAiOverviewScraped, aiMode: googleAiModeScraped } = require('./googleAiScraped');

// Two surfaces can measure the same ENGINE through different providers —
// 'chatgpt:dataforseo' (vendor-driven) and 'chatgpt:scraped' (our own browser).
// They are kept side by side deliberately: the self-hosted path owns the raw
// answer, the vendor path is the fallback when it is blocked. `provider` is
// what distinguishes them, and it travels onto every stored capture row.
const SURFACES = {
  [`${dataForSeoChatGpt.ENGINE}:${dataForSeoChatGpt.PROVIDER}`]: dataForSeoChatGpt,
  [`${dataForSeoAiOverview.ENGINE}:${dataForSeoAiOverview.PROVIDER}`]: dataForSeoAiOverview,
  [`${chatgptScraped.ENGINE}:${chatgptScraped.PROVIDER}`]: chatgptScraped,
  [`${geminiScraped.ENGINE}:${geminiScraped.PROVIDER}`]: geminiScraped,
  [`${googleAiOverviewScraped.ENGINE}:${googleAiOverviewScraped.PROVIDER}`]: googleAiOverviewScraped,
  [`${googleAiModeScraped.ENGINE}:${googleAiModeScraped.PROVIDER}`]: googleAiModeScraped,
};

// Which surfaces cannot run without a rotating residential proxy. Measured,
// not assumed: from a plain ISP address Google refused `/search` on the first
// request and `udm=50` on the second. A caller scheduling these without a
// proxy will get honest `failed` rows rather than silence — this list lets the
// scheduler skip them instead, and say why.
const NEEDS_PROXY = new Set([
  `${googleAiOverviewScraped.ENGINE}:${googleAiOverviewScraped.PROVIDER}`,
  `${googleAiModeScraped.ENGINE}:${googleAiModeScraped.PROVIDER}`,
]);

/** Every surface id, e.g. 'chatgpt:dataforseo'. */
function surfaceIds() {
  return Object.keys(SURFACES);
}

/** One surface, or null for an id we do not serve. Never throws on a typo. */
function surfaceFor(id) {
  return SURFACES[id] || null;
}

/** Does this surface need a residential proxy to stand a chance? */
function needsProxy(id) {
  return NEEDS_PROXY.has(id);
}

// ── Availability ───────────────────────────────────────────────────────────
//
// A surface can be REGISTERED but not currently selectable. The distinction
// matters: `surfaceFor` must keep resolving a disabled surface for ever,
// because stored captures reference it by id and a report has to be able to
// name what produced a row it is still showing. Only NEW runs are gated.
//
// Two different reasons a surface is unavailable, and they behave differently:
//
//   turned off    a deliberate choice (the DataForSEO pair). Comes back by
//                 changing this list or AIV_DISABLED_SURFACES.
//   needs a proxy Google refuses a plain ISP address. Comes back BY ITSELF the
//                 moment AIV_PROXIES is configured — no code change, because
//                 tying it to the actual precondition is more reliable than
//                 remembering to flip a second switch.
const DEFAULT_DISABLED = [
  `${dataForSeoChatGpt.ENGINE}:${dataForSeoChatGpt.PROVIDER}`,
  `${dataForSeoAiOverview.ENGINE}:${dataForSeoAiOverview.PROVIDER}`,
];

function disabledSet() {
  const raw = process.env.AIV_DISABLED_SURFACES;
  if (raw === undefined) return new Set(DEFAULT_DISABLED);
  // An explicitly empty value means "nothing disabled", which is different
  // from the variable being unset.
  return new Set(String(raw).split(',').map((x) => x.trim()).filter(Boolean));
}

/**
 * Why this surface cannot be measured right now, or null if it can.
 *
 * Returns a reason rather than a boolean so callers can SAY why a surface was
 * skipped instead of silently shortening the list — a run that quietly measured
 * two surfaces instead of four would change every denominator with nothing on
 * screen explaining it.
 */
function unavailableReason(id) {
  if (!surfaceFor(id)) return 'not_registered';
  if (disabledSet().has(id)) return 'turned_off';
  if (needsProxy(id)) {
    // Required lazily: proxyPool reads env at first use, and requiring it at
    // module load would freeze the config before dotenv has run.
    const proxyPool = require('../captureEngines/proxyPool');
    if (!proxyPool.isConfigured()) return 'needs_proxy';
  }
  return null;
}

function isAvailable(id) {
  return unavailableReason(id) === null;
}

/** Every surface that can actually run right now. */
function availableSurfaceIds() {
  return surfaceIds().filter(isAvailable);
}

module.exports = {
  SURFACES,
  surfaceIds,
  surfaceFor,
  needsProxy,
  NEEDS_PROXY,
  DEFAULT_DISABLED,
  unavailableReason,
  isAvailable,
  availableSurfaceIds,
};
