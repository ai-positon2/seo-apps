// ── Page type taxonomy ──────────────────────────────────────────────────────
//
// Single source of truth. Two levels: a `type` (one of thirteen families) and a
// `subtype` (one of ninety-two leaves). Facets are ORTHOGONAL and live in their
// own columns — a paginated, gated, geo-modified page is still one subtype, and
// folding any of that into the enum is what turns a taxonomy into a bag of
// special cases.
//
// This replaced a flat sixteen-value list whose leaves doubled as families
// ('blog', 'resource', 'category'). That list could not tell a blog post from
// the blog index, a case study from a whitepaper, or a demo request from a
// pricing page — every one of which is a different job on a site.
//
// Versioned independently from the classifier (see CLASSIFIER_VERSION in
// pageClassifier.js) so a stored crawl can be re-classified and diffed after a
// taxonomy change without re-fetching anything.
const TAXONOMY_VERSION = '2.0.0';

// family -> [subtype, ...]. Order is the spec's order and is meaningful only for
// display; nothing resolves precedence from it.
const FAMILIES = {
  root: ['home', 'home_locale', 'hub'],
  people: ['person', 'person_directory', 'author_archive'],
  places: ['location', 'location_directory', 'geo_landing'],
  services: ['service', 'service_category', 'location_service', 'service_provider', 'service_provider_directory'],
  solutions: ['solution', 'industry', 'persona', 'integration', 'platform_overview', 'feature'],
  commerce: ['product', 'product_category', 'brand', 'product_comparison', 'cart', 'checkout', 'order_confirmation'],
  pricing: ['pricing', 'quote_request', 'payment_options'],
  company: ['about', 'contact', 'careers_hub', 'job_posting', 'press_release', 'press_coverage', 'investor_relations', 'csr', 'awards_credentials'],
  editorial: ['blog_post', 'news', 'blog_index', 'taxonomy_archive', 'date_archive', 'podcast_episode', 'podcast_hub', 'video', 'video_hub', 'magazine_issue'],
  informational: ['guide', 'faq', 'help_article', 'documentation', 'changelog', 'glossary_term', 'glossary_index', 'case_study', 'case_study_index', 'whitepaper', 'data_study', 'template_download', 'tool', 'quiz', 'comparison', 'alternatives', 'listicle_directory', 'webinar', 'event', 'event_index', 'course', 'lesson', 'portfolio_project', 'gallery', 'testimonials'],
  conversion: ['landing', 'lead_form', 'booking', 'demo_request', 'free_trial', 'offer', 'thank_you'],
  system: ['legal', 'sitemap_html', 'search_results', 'login', 'account', 'portal', 'error', 'paywall_gate', 'redirect_shell', 'parked_stub'],
  fallback: ['unclassified'],
};

// One line per subtype, sent to the model verbatim. A classifier judging against
// a bare label guesses at what the label means; these are the definitions, and
// they are the reason two runs agree with each other.
const SUBTYPE_HINTS = {
  home: 'the site root',
  home_locale: 'a locale or regional root (/uk/, /es/)',
  hub: 'a top-level section index that does NOT list a single entity type (/resources/, /solutions/)',

  person: 'an individual profile — doctor, attorney, agent, staff member',
  person_directory: 'a team, provider, or leadership listing',
  author_archive: 'a posts-by-author listing',

  location: 'a specific physical location — office, clinic, branch, store',
  location_directory: 'a locations index, or a state/region page listing locations',
  geo_landing: 'a city or region page with NO physical address behind it',

  service: 'a single service, treatment, or procedure',
  service_category: 'a hub grouping multiple services',
  location_service: 'a service × location page ("emergency dentist in Austin")',
  service_provider: 'a dealer, franchise, distributor, reseller, or partner profile',
  service_provider_directory: 'a listing of dealers, franchises, resellers, or partners',

  solution: 'a use-case offering',
  industry: 'a vertical page ("for healthcare")',
  persona: 'a role or audience page ("for marketing teams")',
  integration: 'a connector or app-partner page',
  platform_overview: 'the whole-product page that sits above individual features',
  feature: 'a single feature page',

  product: 'a product detail page — one item',
  product_category: 'a product listing, collection, or shop-by page',
  brand: 'a manufacturer or brand page grouping products',
  product_comparison: 'a side-by-side of the site\'s OWN products',
  cart: 'the shopping cart',
  checkout: 'the checkout',
  order_confirmation: 'a post-purchase order confirmation',

  pricing: 'plans, packages, or rate cards',
  quote_request: 'a page whose purpose is an estimate or quote form',
  payment_options: 'financing, insurance accepted, or membership plans',

  about: 'an about page',
  contact: 'a contact page',
  careers_hub: 'a careers or jobs landing page',
  job_posting: 'an individual job description',
  press_release: 'a company-issued press release',
  press_coverage: 'an "in the news" or media-mentions page',
  investor_relations: 'investor relations',
  csr: 'mission, values, sustainability, or community',
  awards_credentials: 'awards, certifications, or credentials',

  blog_post: 'a dated, bylined article',
  news: 'a news or announcement post',
  blog_index: 'the blog listing itself',
  taxonomy_archive: 'a category or tag listing',
  date_archive: 'a by-date archive listing',
  podcast_episode: 'a single podcast episode',
  podcast_hub: 'a podcast index',
  video: 'a single video page',
  video_hub: 'a video index',
  magazine_issue: 'a magazine or digest issue',

  guide: 'evergreen long-form or a pillar page',
  faq: 'a dedicated FAQ page',
  help_article: 'a support knowledge-base article',
  documentation: 'product or API documentation',
  changelog: 'release notes',
  glossary_term: 'a single glossary or "what is X" definition entry',
  glossary_index: 'a glossary index',
  case_study: 'a single customer case study',
  case_study_index: 'a case-study listing',
  whitepaper: 'a report, ebook, or research paper',
  data_study: 'original research or a statistics page',
  template_download: 'a template, checklist, or swipe file',
  tool: 'a calculator, generator, or interactive utility',
  quiz: 'an assessment or self-scoring quiz',
  comparison: 'an "X vs Y" page, including vs-competitor',
  alternatives: 'a "best alternatives to X" page',
  listicle_directory: 'a "top 10 [vendors] in [city]" page listing EXTERNAL entities',
  webinar: 'a live or on-demand webinar',
  event: 'a single event',
  event_index: 'an events listing',
  course: 'a course',
  lesson: 'a single lesson within a course',
  portfolio_project: 'a portfolio or project case page',
  gallery: 'an image or work gallery',
  testimonials: 'a reviews or testimonials collection page',

  landing: 'a campaign-scoped page: stripped navigation, single call to action',
  lead_form: 'a standalone form page',
  booking: 'appointment or scheduling',
  demo_request: 'a demo request',
  free_trial: 'a free trial signup',
  offer: 'a coupon, promo, or seasonal deal',
  thank_you: 'a post-submission confirmation',

  legal: 'privacy, terms, disclaimer, accessibility, cookie, or HIPAA notice',
  sitemap_html: 'an HTML sitemap',
  search_results: 'a search results page',
  login: 'a login page',
  account: 'an account page',
  portal: 'a customer or partner portal',
  error: 'a 404, 410, or soft-404',
  paywall_gate: 'a paywall gate',
  redirect_shell: 'a JS or meta-refresh redirect stub',
  parked_stub: 'a placeholder, coming-soon, or maintenance page',

  unclassified: 'nothing above fits — MUST carry a reason and a confidence score',
};

// Subtypes that rule 1 promotes above everything else. Utility beats meaning: a
// login page that talks about pricing is still a login page.
const UTILITY_SUBTYPES = [
  'error', 'login', 'account', 'portal', 'cart', 'checkout',
  'order_confirmation', 'legal', 'search_results', 'redirect_shell', 'parked_stub',
];

// Subtypes that ARE a listing of sibling entities. Rule 3 reads this both ways:
// it sets is_index_page for them, and it is how a "detail type on a listing
// page" mistake is caught.
const INDEX_SUBTYPES = [
  'hub', 'person_directory', 'author_archive', 'location_directory',
  'service_category', 'service_provider_directory', 'product_category', 'brand',
  'careers_hub', 'blog_index', 'taxonomy_archive', 'date_archive', 'podcast_hub',
  'video_hub', 'glossary_index', 'case_study_index', 'event_index',
  'listicle_directory', 'gallery', 'sitemap_html',
];

// Where a subtype sits in the funnel. A facet, not a type — stored in its own
// column, and derived rather than asked of the model, because it is a property
// of the subtype and not of the individual page.
const FUNNEL_STAGE = {
  awareness: ['blog_post', 'news', 'blog_index', 'taxonomy_archive', 'date_archive',
    'guide', 'glossary_term', 'glossary_index', 'data_study', 'podcast_episode',
    'podcast_hub', 'video', 'video_hub', 'magazine_issue', 'hub', 'home', 'home_locale',
    'csr', 'press_release', 'press_coverage', 'author_archive'],
  consideration: ['service', 'service_category', 'solution', 'industry', 'persona',
    'integration', 'platform_overview', 'feature', 'product', 'product_category',
    'brand', 'case_study', 'case_study_index', 'whitepaper', 'webinar', 'comparison',
    'alternatives', 'product_comparison', 'listicle_directory', 'testimonials',
    'location', 'location_directory', 'geo_landing', 'person', 'person_directory',
    'service_provider', 'service_provider_directory', 'about', 'awards_credentials',
    'documentation', 'help_article', 'faq', 'changelog', 'course', 'lesson',
    'template_download', 'tool', 'quiz', 'event', 'event_index', 'portfolio_project',
    'gallery', 'investor_relations', 'careers_hub', 'job_posting'],
  decision: ['pricing', 'quote_request', 'payment_options', 'contact', 'booking',
    'demo_request', 'free_trial', 'lead_form', 'landing', 'offer', 'cart', 'checkout',
    'order_confirmation', 'thank_you', 'location_service'],
};

// Format is a property of the subtype where the subtype names one. Everything
// else is text until a signal says otherwise.
const CONTENT_FORMAT = {
  video: ['video', 'video_hub'],
  audio: ['podcast_episode', 'podcast_hub'],
  interactive: ['tool', 'quiz', 'search_results'],
  pdf: ['whitepaper', 'template_download'],
};

const FACET_KEYS = [
  'is_index_page', 'is_paginated', 'page_number', 'is_gated', 'is_campaign_scoped',
  'geo_modified', 'funnel_stage', 'content_format', 'primary_schema_type',
  'template_fingerprint', 'indexable', 'canonical_self', 'in_sitemap', 'in_nav',
  'orphan', 'word_count', 'has_price', 'has_nap', 'has_form', 'has_date_byline', 'locale',
];

const SUBTYPES = Object.values(FAMILIES).flat();
const TYPES = Object.keys(FAMILIES);

const FAMILY_OF = {};
for (const [family, subtypes] of Object.entries(FAMILIES)) {
  for (const s of subtypes) FAMILY_OF[s] = family;
}

const SUBTYPE_SET = new Set(SUBTYPES);
const TYPE_SET = new Set(TYPES);

function isValidSubtype(s) { return SUBTYPE_SET.has(s); }
function isValidType(t) { return TYPE_SET.has(t); }
function familyOf(subtype) { return FAMILY_OF[subtype] || null; }
function funnelStageOf(subtype) {
  for (const [stage, list] of Object.entries(FUNNEL_STAGE)) if (list.includes(subtype)) return stage;
  return null;
}
function contentFormatOf(subtype) {
  for (const [format, list] of Object.entries(CONTENT_FORMAT)) if (list.includes(subtype)) return format;
  return 'text';
}

module.exports = {
  TAXONOMY_VERSION,
  FAMILIES, TYPES, SUBTYPES, SUBTYPE_HINTS, FAMILY_OF, FACET_KEYS,
  UTILITY_SUBTYPES, INDEX_SUBTYPES, FUNNEL_STAGE, CONTENT_FORMAT,
  isValidSubtype, isValidType, familyOf, funnelStageOf, contentFormatOf,
};
