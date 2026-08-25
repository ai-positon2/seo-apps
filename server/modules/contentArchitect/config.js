// ── Named caps, all in one place per the build spec's guardrails ─────────────
module.exports = {
  MAX_SITEMAP_URLS: 25000,
  MAX_SITEMAP_RECURSION_DEPTH: 3,
  MAX_CHILD_SITEMAPS: 50, // safety valve independent of the URL cap — one bloated index can't hang discovery
  CRAWL_FALLBACK_DEPTH: 3,
  CRAWL_FALLBACK_MAX_URLS: 500,
  LARGE_SELECTION_THRESHOLD: 800, // above this, offer sample/all/skip before crawling (Stage 4)
  CRAWL_CONCURRENCY: 16,
  CRAWL_REQUEST_TIMEOUT_MS: 6000,
  CRAWL_TOTAL_BUDGET_MS: 90000,
  MAX_REDIRECT_HOPS: 3,
  FETCH_TIMEOUT_MS: 15000, // sitemap/robots fetches (Stage 1) — more lenient than the per-page crawl timeout
  CRAWL_SAMPLE_SIZE: 300, // above LARGE_SELECTION_THRESHOLD, crawl an evenly-spread sample instead of everything
  CRAWL_FAILURE_CHECK_AFTER: 50, // pages completed before the failure-rate abort check kicks in
  CRAWL_FAILURE_ABORT_THRESHOLD: 0.3, // >30% failed after the above → abort, fall back to slug-only

  // ── Stage 5a: term profiles ──────────────────────────────────────────────
  FIELD_WEIGHTS: {
    title: 3.0,
    h1: 2.5,
    slugTokens: 2.0,
    h2h3: 1.5,
    metaDescription: 1.0,
    firstParagraph: 0.5,
  },
  NGRAM_MAX: 3, // keep unigrams, bigrams, trigrams — "clear aligner" beats "clear" + "aligner"
  GENERIC_TERM_DOC_FREQUENCY: 0.6, // a term on >60% of pages carries no discriminating signal, dropped regardless of vertical

  // ── Stage 5d: clustering ─────────────────────────────────────────────────
  // Tuned empirically against real domains spanning ~40 to ~3,350 selected
  // pages (see the Checkpoint 2 report) — one shared constant, not tuned
  // per-site, per the spec's "make every threshold a named constant" rule.
  // Chosen for precision over recall: spot-checking lower values (0.03-0.05)
  // on Tealium's /integrations/{product} pages showed concrete false
  // merges — Anthropic grouped with Google/Digioh/Trbo/AT-Internet, Roku
  // grouped with Epsilon — purely on generic shared substrings, not real
  // topical relation. A wrongly-merged cluster is worse for trust than an
  // honest unassigned page the user can place by hand in the Stage 8
  // workbench, so 0.08 was kept even though it leaves some domains with a
  // higher unassigned rate than the spec's 25% guideline (see report).
  SIMILARITY_THRESHOLD: 0.08,
  MIN_CLUSTER_SIZE: 3,
  MAX_CLUSTER_SIZE: 12,
  DUAL_CLUSTER_MARGIN: 0.05,
  LINK_BOOST_SINGLE: 0.10,
  LINK_BOOST_RECIPROCAL: 0.18,
  LINK_BOOST_CAP: 1.0,
  MECHANICAL_NAME_TERM_COUNT: 2,

  // ── Stage 6: hub selection ────────────────────────────────────────────────
  // Not yet tuned against real ground truth — the spec's own §10 says that
  // requires two hand-labeled client sites the user provides at Checkpoint 4
  // review; these are the spec's stated starting weights, used as-is.
  HUB_WEIGHTS: {
    breadth: 0.30,
    inboundWithinCluster: 0.25,
    wordCount: 0.15,
    urlDepth: 0.10,
    slugSpecificity: 0.10,
    llmAgreement: 0.10,
    titlePatternPenalty: -0.20,
    locationTermPenalty: -0.40,
    // Not in the spec's own table — added after real testing showed a
    // terms-of-use page (4,338 words of legal boilerplate) winning a hub
    // slot on word-count alone despite zero topical relevance. Same
    // structural reasoning as the location penalty above (this page TYPE is
    // never a topical hub, regardless of how it scores elsewhere).
    legalUtilityPenalty: -0.40,
  },
  HUB_SCORE_THRESHOLD: 0.5, // below this, no page qualifies -> gap hub
  HUB_AMBIGUOUS_MARGIN: 0.15, // top two within this relative margin -> ambiguous-hub flag

  // ── Stage 7: diagnostics ─────────────────────────────────────────────────
  BURIED_CLICK_DEPTH: 4,
  CANNIBALIZATION_SIMILARITY_THRESHOLD: 0.75,
  THIN_WORD_COUNT: 500,
  STALE_MONTHS: 18,
  CLUSTER_HEALTH_WEIGHTS: { hubPresent: 30, hubTermCoverage: 20, spokeCountInRange: 15, linkDensity: 20, clickDepth: 15 },
};
