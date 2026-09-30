// ── Named caps, all in one place per the build spec's guardrails ─────────────
module.exports = {
  MAX_SITEMAP_URLS: 25000,
  MAX_SITEMAP_RECURSION_DEPTH: 3,
  MAX_CHILD_SITEMAPS: 50, // safety valve independent of the URL cap — one bloated index can't hang discovery
  // Every sitemap robots.txt declares is read (sitemapDiscovery.discoverUrls),
  // up to this many, sharing MAX_CHILD_SITEMAPS between them — but never fewer
  // than MIN_CHILD_SITEMAPS_PER_SOURCE each, so a site declaring twenty still
  // gets a few child files read from every one.
  MAX_SITEMAP_SOURCES: 20,
  MIN_CHILD_SITEMAPS_PER_SOURCE: 5,
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

  // ── Informational page selection (project-linked runs) ────────────────────
  // Hub and spoke is a map of the site's informational content. Location,
  // service, people and utility pages share city and brand words rather than a
  // topic, so letting them in grouped pages by city ("Rock Hill SC Dental
  // Services") and gave every cluster a gap hub. See informationalSelection.js.
  //
  // Bumped whenever the prompt, the categories or the included set change, so a
  // cached verdict from the old definition is never reused under the new one.
  // 2: the prompt's news/other definitions and the "mixed" rule for blogs that
  // carry company news (2026-09-25).
  INFORMATIONAL_SELECTION_VERSION: 2,
  // The categories that count as informational. A config flip, not a code
  // change, if the policy ever widens (e.g. to 'media').
  SELECTION_INCLUDED_CATEGORIES: ['informational'],
  // Same floor as the crawl itself: a cluster is three pages, so below five
  // there is nothing for the pipeline to find.
  MIN_INFORMATIONAL_PAGES: 5,
  // A section page needs at least this many informational children before the
  // parent rule treats it as a listing rather than an article.
  LISTING_MIN_CHILDREN: 2,
  SELECTION_TEMPLATE_EXAMPLES: 8,
  SELECTION_TEMPLATE_BATCH_SIZE: 40,
  SELECTION_URL_BATCH_SIZE: 100,
  // Per run, and only uncached URLs count, so coverage of a large root-level
  // blog fills in across successive crawls rather than stalling at the cap.
  SELECTION_MAX_URL_CHECKS: 1000,
  SELECTION_AI_CONCURRENCY: 4,
  SELECTION_AI_TIMEOUT_MS: 45000,
  // The SDK's retries cover HTTP failures only. A batch whose reply is not
  // valid JSON — seen live on a 100-URL batch — is asked once more before its
  // items fall back to the URL rules.
  SELECTION_AI_MAX_RETRIES: 1,
  SELECTION_AI_BATCH_ATTEMPTS: 2,
  // Whole-selection wall clock. Batches not started by then fall back to the
  // cache or the URL rules, with a limitation line saying so. The hub_spoke
  // run allowance (moduleEvidence FLAT_MINUTES) is sized with this in it.
  SELECTION_AI_BUDGET_MS: 180000,
  SELECTION_CACHE_TTL_DAYS: 90,
  // A root bucket ("/{slug}"-first template) this big is asked about as a
  // template before falling back to per-URL checks. See informationalSelection.
  SELECTION_ROOT_BUCKET_TEMPLATE_MIN: 50,
  // A template judged informational with at least this many pages also has its
  // pages checked one by one, with the URL checks left after the templates and
  // mixed buckets — to catch the case studies and company news its 8 examples
  // missed. See informationalSelection 3c.
  SELECTION_RECHECK_TEMPLATE_MIN: 20,
  // The project-linked run also checks, just before reading, the pages it is
  // about to read that no per-page check has covered yet: up to this many, in
  // at most this long (crawlToArchitect.buildFromDiscovery).
  SELECTION_MAX_RECHECKS: 900,
  SELECTION_RECHECK_BUDGET_MS: 120000,
  // A dated series ("best-of-the-week-mar-06-2015") this long is a digest.
  SELECTION_DIGEST_SERIES_MIN: 5,

  // ── Informational page discovery (project-linked runs) ────────────────────
  // Hub and spoke finds its own candidate pages rather than taking whatever the
  // site crawl reached: the site's sitemaps, plus the listing pages that its
  // header/footer menus label as informational (Blog, Resources, Learn…),
  // walked through their pagination. See informationalDiscovery.js.
  DISCOVERY_MAX_LISTINGS: 6,          // informational menu links walked as listings
  DISCOVERY_MAX_LISTING_PAGES: 40,    // pagination pages walked per listing
  DISCOVERY_LISTING_DELAY_MS: 150,    // between pagination fetches on one site
  // Informational pages fetched for analysis per run. Past it, pages are left
  // out with a limitation line; the verdict cache means later runs do not
  // re-ask for the ones already judged, but each run fetches afresh.
  DISCOVERY_MAX_FETCH: 800,
  DISCOVERY_FETCH_CONCURRENCY: 4,
  DISCOVERY_FETCH_DELAY_MS: 150,
  // A site's robots.txt Crawl-delay, which the site crawl already honours, is
  // honoured here too: listing walks and page reads are spaced by it. It is
  // capped as the crawler caps it, and page reads then fit a time budget, so a
  // 10-second delay reads ~50 pages rather than 800 at 4-per-150ms (measured:
  // a publisher began refusing requests part-way through the faster pace).
  // The trade-off, measured: on a health system asking for 10 seconds this
  // reads 48 pages instead of 800, and far fewer clusters form. false restores
  // the old pace (4 at a time, 150ms apart) whatever robots.txt asks.
  // Off by choice (2026-09-30): complete clusters matter more than the delay.
  DISCOVERY_HONOUR_CRAWL_DELAY: false,
  DISCOVERY_MAX_CRAWL_DELAY_MS: 60000,
  DISCOVERY_LISTING_BUDGET_MS: 3 * 60 * 1000,
  DISCOVERY_FETCH_BUDGET_MS: 8 * 60 * 1000,
  // A section's own sitemap ("/blog/sitemap_index.xml") adds at most this many.
  DISCOVERY_SECTION_SITEMAP_MAX: 10000,
};
