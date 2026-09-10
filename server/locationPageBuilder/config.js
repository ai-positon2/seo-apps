// ── Location + Service Page Content Builder — module config ──────────────────
// All tunables live here so the SEO team can adjust without code changes.
// Build Spec Sections 3, 6, 7, 9, 15, 18.

const path = require('path');

module.exports = {
  // Feature flag — the whole module is gated on this (Spec §0.2).
  enabled: process.env.LPB_ENABLED !== 'false',

  // Where the file-based store persists (matches kbStore's data-root convention).
  // LPB_DATA_ROOT still wins outright; APP_DATA_ROOT is the shared fallback so
  // one variable relocates every file-backed module. See services/dataRoot.js.
  dataRoot: require('../services/dataRoot').resolveDataRoot(
    'location-page-builder',
    path.join(__dirname, '../../data/location-page-builder'),
    'LPB_DATA_ROOT',
  ),

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
    // The template-driven engine (lsBrief plans, lsWriter writes) splits the
    // same two jobs the same way, and gets its own ids so a brand on the
    // template flow can be moved to a different model without touching
    // Gentle Dental. Same defaults, deliberately: the split is what matters.
    lsBriefModel: process.env.LPB_LS_BRIEF_MODEL || 'claude-sonnet-5',
    lsWriterModel: process.env.LPB_LS_WRITER_MODEL || 'claude-sonnet-5',
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
    faqs: {
      min: 4,
      max: 6,
      // How many FAQs must name the location. Two, because one is easy to
      // satisfy with a throwaway mention — but ONLY where the city genuinely
      // changes the answer (availability, which options this office runs), never
      // on a universal clinical question. See text.findForcedFaqLocalization.
      minLocalized: 2,
    },
    // accept* is the QC gate; target* is what the writer is asked for —
    // deliberately inside the gate so normal variance still passes.
    pageWords: { acceptMin: 500, acceptMax: 900, targetMin: 600, targetMax: 860 },
  },

  // ── Template-driven Location + Service pages (docs/ybh-ls-pages.md) ────────
  // The generic engine behind lsProfiles/lsBrief/lsWriter/lsQa. Gentle Dental
  // keeps its own `dental` block above: its budgets were tuned against a
  // different deliverable (finished copy only, 6-7 blocks, 500-900 words) and
  // moving it onto these numbers would silently re-gate every existing page.
  //
  // `defaults` are the template's own numbers. `clients` overrides them per
  // client id, one level deep per key, so the SEO team can retune one brand
  // without touching the others (see lsProfiles.resolveProfile).
  //
  // The numbers interlock the same way the dental ones do. The binding gate is
  // per-SECTION characters (sectionChars), so the page total is derived rather
  // than chosen:
  //   floor   blocks.min x sectionChars.min = 5 x 500 = 2500 chars (~400 words)
  //           + hero 30 + FAQ intro 30 + 5 FAQs x ~35 = ~635 words
  //   ceiling blocks.max x sectionChars.max = 8 x 700 = 5600 chars (~900 words)
  //           + hero 45 + FAQ intro 40 + 7 FAQs x ~60 = ~1405 words
  // Both sit inside pageWords.accept, which is what makes the writer prompt
  // satisfiable against its own QC gates. Widening blocks or sectionChars
  // without re-checking that arithmetic is how you get a prompt that cannot
  // pass (regression-tested in __tests__/lsPages.test.js).
  lsPages: {
    defaults: {
      // Template §3: "approximately 50 to 60 characters where practical".
      seoTitle: { min: 50, max: 60 },
      // Template §4: "Target approximately 140 to 160 characters".
      metaDescription: { min: 140, max: 160 },
      // Template §5: one concise sentence under the H1.
      heroOneLiner: { minWords: 25, maxWords: 45 },
      // Template §7/§8: the section count is decided by competitor coverage,
      // not fixed — this is the band the planner is held to.
      blocks: { min: 5, max: 8 },
      // Template §7: "Suggested content length: 500 to 700 characters".
      sectionChars: { min: 500, max: 700 },
      paragraphsPerBlock: { min: 1, max: 3 },
      paragraphWords: { min: 30, max: 45, hardMax: 50, hardMaxChars: 300 },
      listItemMaxWords: 25,
      // Template §9: "Create 5 to 7 FAQs with answers."
      faqs: {
        min: 5,
        max: 7,
        // How many FAQs must name the location. Template §9 explicitly warns
        // against making every FAQ "...in {location}?", so this is a floor
        // paired with the meaningfulness gate in lsQa — a city may only sit in
        // a question whose answer the location actually changes.
        minLocalized: 2,
      },
      faqAnswerMaxWords: 60,
      // Template §9 FAQ intro: "2 to 3 sentences", "max ~300 characters",
      // "30 to 40 words".
      faqIntro: { maxChars: 300, minWords: 30, maxWords: 40 },
      // A sanity band around the derived total, not a target in its own right.
      // accept* is what QC gates on; target* is what the writer is asked for.
      pageWords: { acceptMin: 600, acceptMax: 1500, targetMin: 800, targetMax: 1300 },
      // Same reasoning as dental.minKeywordUses: a MINIMUM presence. Template
      // §13.8 forbids keyword stuffing outright, so a quota here would be
      // asking the writer to break the rule the page is judged on.
      minKeywordUses: 1,
      maxKeywordDensity: 0.025,
      internalLinksMin: 3,
      // URL shape from template §2. `{location_slug}` and `{service_slug}` are
      // the only placeholders; a client whose site nests pages differently
      // overrides this rather than getting a hardcoded branch.
      urlPattern: '/locations/{location_slug}/{service_slug}',
      trailingSlash: false,
    },
    clients: {
      // Clear Behavioral Health — YMYL behavioral health, California.
      client_clear_behavioral_health: {
        // Service names like "PHP" or "IOP" are meaningless to a SERP without
        // the vertical attached; the qualifier is added only when the query
        // does not already imply it (see lsProfiles.qualifySeed).
        seedQualifier: 'mental health',
      },
    },
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
