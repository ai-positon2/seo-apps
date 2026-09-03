// ── Location + Service Page Content Builder — module config ──────────────────
// All tunables live here so the SEO team can adjust without code changes.
// Build Spec Sections 3, 6, 7, 9, 15, 18.

const path = require('path');

module.exports = {
  // Feature flag — the whole module is gated on this (Spec §0.2).
  enabled: process.env.LPB_ENABLED !== 'false',

  // Where the file-based store persists (matches kbStore's data-root convention).
  dataRoot: process.env.LPB_DATA_ROOT || path.join(__dirname, '../../data/location-page-builder'),

  // Stage-3 competitor scoring weights (Spec §6 Stage 3). Tunable.
  serpScoreWeights: {
    rankingFrequency: 25, // appears across several seed SERPs
    pageTypeMatch: 20,    // real local service / location+service page
    localIntentMatch: 15, // same city/state/nearby area
    serviceIntentMatch: 15, // clearly the selected service
    conversionIntent: 10, // call/book/quote/appointment CTAs
    organicPosition: 10,  // top 3 / top 10
    schemaQuality: 5,     // LocalBusiness/MedicalBusiness/Service/FAQ/Breadcrumb
  },
  serp: {
    maxPerDomain: 2,        // cap ~2 URLs per domain
    modelAfterCount: 10,    // take top 10 into model_after
    // Directory domains tagged discovery_only (used for keywords, not modelled).
    directoryDomains: [
      'yelp.com', 'angi.com', 'angieslist.com', 'thumbtack.com', 'bbb.org',
      'yellowpages.com', 'healthgrades.com', 'zocdoc.com', 'webmd.com',
      'psychologytoday.com', 'vitals.com', 'wellness.com', 'mapquest.com',
      'facebook.com', 'tripadvisor.com',
    ],
  },

  // Stage-4 SEMrush extraction (Spec §6 Stage 4).
  semrush: {
    keywordsPerUrl: 30,
    database: 'us',
  },

  // Stage-5 LLM relevance / generation (Spec §6 Stage 5, §7).
  llm: {
    classificationModel: process.env.LPB_LLM_MODEL || 'gpt-5.4-mini',
    generationModel: process.env.LPB_GEN_MODEL || 'claude-sonnet-5',
    // Gentle Dental wizard runs two models: Sonnet PLANS the educational-body
    // H2 outline (grading the scraped competitor headings against the fallback
    // ladder), and the cheaper writer model produces every generated string.
    // Both are resolved through llmProviders.resolveModelId, so an unknown id
    // silently degrades to that module's default rather than erroring.
    dentalOutlineModel: process.env.LPB_DENTAL_OUTLINE_MODEL || 'claude-sonnet-5',
    dentalWriterModel: process.env.LPB_DENTAL_WRITER_MODEL || 'gpt-5.4-mini',
    classificationTemperature: 0, // Spec §6 Stage 5: temperature 0
    // Master pool cap fed to the LLM. Must cover the full live pull
    // (TOP_URLS x semrush.keywordsPerUrl = 300) plus keywords.universePoolSize
    // (100), or the selection prompt silently truncates the pool.
    maxKeywordsToClassify: 400,
  },

  // Gentle Dental educational-body shape + readability budget.
  //
  // These numbers are shared by three places that MUST agree: the writer
  // prompt (contentGenerator), the outline planner's repair logic
  // (dentalOutline), and the QC gates (qaEngine). They started out duplicated
  // across those files — the paragraph cap was literally written twice — which
  // meant editing one silently decoupled what the model is asked to write from
  // what QC will accept. They live here so the SEO team can retune them in one
  // place, and so they cannot drift apart.
  //
  // They also interlock arithmetically. The page word count QC measures is
  // hero intro + block bodies + FAQ Q&As, so at the extremes:
  //   floor   30 + (12 paragraphs x 30 words) + (4 FAQs x ~33) = 522
  //   ceiling 40 + (14 paragraphs x 40 words) + (6 FAQs x ~48) = 888
  // Both sit inside pageWords.accept, which is what makes the instructions
  // satisfiable. Widening paragraphsPerPage or paragraphWords without checking
  // that arithmetic is how you get a prompt that cannot pass its own gate
  // (regression-tested in __tests__/run.js).
  dental: {
    blocks: { min: 6, max: 7 },
    paragraphsPerBlock: { min: 1, max: 3 },
    paragraphsPerPage: { min: 12, max: 14 },
    paragraphWords: { min: 30, max: 40, hardMax: 45, hardMaxChars: 260 },
    listItemMaxWords: 25,
    // The SERP snippet window. A two-sided range: too short wastes the slot,
    // too long gets truncated by Google. Read by the writer prompt, the QC
    // gate and the wizard's character counts.
    metaDescription: { min: 150, max: 160 },
    // Practice name per page. Almost every office trades as Gentle Dental, but
    // some carry their own local brand and must NEVER be called Gentle Dental
    // — the name is the practice's identity in the title tag, the body copy,
    // the schema and the exported document, so it is resolved in one place
    // (compose.dentalBrandName) and read from the page object everywhere else.
    //
    // Keyed by location_page_url so an exception applies to existing rows
    // without re-seeding — re-seeding locations would wipe the NAP fields the
    // SEO team populates by hand. A location row's own `brand_name` wins over
    // this map, so per-office overrides can also be edited as data later.
    brand: {
      default: 'Gentle Dental',
      legalName: 'Gentle Dental of New England',
      byLocationPageUrl: {
        '/dental-offices/ma/boston/newbury-st': 'Newbury Dental Associates',
      },
    },
    // A MINIMUM presence, deliberately low. See DENTAL_MIN_KEYWORD_USES in
    // qaEngine.js: a high number is what forces the writer to paste the search
    // string into prose.
    minKeywordUses: 1,
    faqAnswerMaxWords: 40,
    // FAQ count. `min` is a CRITICAL QC gate (FAQ schema needs real questions),
    // so the writer prompt, the regeneration retry guard and the gate itself
    // all have to read the same number — the prompt used to say "4-6" in prose
    // while the gate held its own copy of 4, and a regeneration that returned
    // a single FAQ silently replaced a passing page's whole FAQ block.
    faqs: { min: 4, max: 6 },
    // accept* is the QC gate; target* is what the writer is asked for —
    // deliberately inside the gate so normal variance still passes.
    pageWords: { acceptMin: 500, acceptMax: 900, targetMin: 600, targetMax: 860 },
  },

  keywords: {
    maxPrimary: 2,
    maxSecondary: 10,
    // Rows pulled from the imported keyword universe per service+city,
    // highest search volume first (see keywordUniverseStore).
    universePoolSize: 100,
    // The universe is queried by Cluster, which is broader than a service's own
    // relevance terms (the "Sleep Apnea & Snoring" cluster also carries CPAP
    // supply keywords). Fetching exactly universePoolSize and then filtering
    // would leave far fewer than that, so over-fetch by this factor, filter,
    // then trim back to universePoolSize.
    universeOverfetch: 3,
  },

  // Stage-7 uniqueness controls (Spec §7.3, §15.6). REQUIRED guardrails.
  uniqueness: {
    minBodyWordCount: 600,          // ≥ 600 words of unique body copy
    crossPageSimilarityThreshold: 0.80, // block if L3 body too similar to a sibling page
    competitorOverlapThreshold: 0.80,   // plagiarism block vs scraped competitor copy
    requireLocalSpecificsBlock: true,
  },

  // Internal-link caps (Spec §16, §18) to avoid manipulative sibling patterns.
  internalLinks: {
    maxTotal: 12,
    maxSiblingLocations: 3,
  },

  // Caching TTLs for billed API calls (Spec §14). Milliseconds.
  cache: {
    serpTtlMs: 7 * 24 * 60 * 60 * 1000,    // 7 days
    // SEMrush pulls are the billed data and are RETAINED (and reused) for 180
    // days -- deliberately far longer than the derived artefacts below, which
    // are cheap to recompute once the raw keywords are already on hand.
    semrushTtlMs: 180 * 24 * 60 * 60 * 1000, // 180 days
    llmTtlMs: 30 * 24 * 60 * 60 * 1000,    // 30 days
  },

  // Tone-profile usability (Spec §13, §18).
  tone: {
    minSampleCount: 2,
  },
};
