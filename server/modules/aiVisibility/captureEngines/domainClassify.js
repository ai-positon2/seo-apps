// ── Classifying the sources an answer cited ─────────────────────────────────
//
// Pure. METRICS.md §5.1 (normalisation), §5.3 (domain type) and §5.4 (URL
// type). Everything here is stamped with RULESET_VERSION and stored AS OF
// INGEST — §5.3 is explicit that percentages must stay reproducible for a past
// period, so a row keeps the verdict the rules gave when it was captured, and
// retuning the rules never silently rewrites history.

// Bump when a rule changes. Rows keep the version that classified them, so a
// period can always be recomputed under the rules that produced it.
//
// 2026.08.2 — added government and academic ccSLDs to MULTI_PART_SUFFIXES.
// Before it, every gov.sg / ac.nz / com.cn site collapsed into a single
// registrable domain, so one row in the domains and gaps tables stood for
// dozens of unrelated sources. Rows classified before the change keep
// 2026.08.1 and remain reproducible under it.
const RULESET_VERSION = '2026.08.2';

// ── §5.1 URL normalisation ─────────────────────────────────────────────────

// Tracking parameters that identify a visit, not a page. Two URLs differing
// only by these are the same page, and grouping them apart would split one
// source's retrievals across several rows.
const TRACKING_PARAMS = [
  /^utm_/i, /^gclid$/i, /^fbclid$/i, /^msclkid$/i, /^ref$/i, /^referrer$/i,
  /^ct-referrer$/i, /^srsltid$/i, /^igshid$/i, /^mc_cid$/i, /^mc_eid$/i,
  /^_hsenc$/i, /^_hsmi$/i, /^vero_id$/i, /^yclid$/i,
];

// Multi-part public suffixes, so bbc.co.uk is the registrable domain and
// co.uk is not. Not the full Public Suffix List — a real PSL is a large
// dependency and a moving target; this covers the suffixes that actually
// occur in these clients' citation sets. Anything unlisted falls back to the
// last two labels, which is correct for .com/.org/.net/.edu/.gov.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'co.za', 'co.jp', 'co.in', 'co.kr',
  'com.br', 'com.mx', 'com.sg', 'com.hk', 'com.tr',
  // Government and academic ccSLDs. Without these, every Singapore government
  // site collapsed to one registrable domain — one row in the domains table
  // standing for dozens of unrelated sources.
  'gov.sg', 'edu.sg', 'org.sg', 'ac.nz', 'govt.nz', 'net.nz', 'org.nz',
  'ac.in', 'gov.in', 'net.in', 'org.in', 'com.cn', 'gov.cn', 'edu.cn',
  'gov.za', 'ac.za', 'org.za', 'com.ar', 'com.co', 'com.pe', 'com.ph', 'com.my',
]);

/** Full hostname, lowercased, without a leading www. */
function hostOf(url) {
  try {
    const u = new URL(String(url));
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // Accept a bare host too — ChatGPT gives domains, not URLs.
    const bare = String(url || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    return bare.includes('.') ? bare : null;
  }
}

/** The registrable domain: adanews.ada.org → ada.org, bbc.co.uk → bbc.co.uk. */
function registrableDomain(hostOrUrl) {
  const host = hostOf(hostOrUrl);
  if (!host) return null;
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

/**
 * §5.1. Lowercase scheme and host, strip www, drop the fragment and tracking
 * params, KEEP path case, strip one trailing slash, collapse duplicate slashes.
 *
 * The original is never discarded by the caller — §5.1 notes the provenance
 * (`?ct-referrer=perplexity`) is worth showing even though it is normalised
 * away for grouping.
 */
function normaliseUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;

  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.protocol = u.protocol.toLowerCase();

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }

  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/$/, '');
  u.pathname = path;

  const search = u.searchParams.toString();
  return `${u.protocol}//${u.hostname}${u.pathname}${search ? `?${search}` : ''}`;
}

// ── §5.3 Domain type ───────────────────────────────────────────────────────

const UGC_HOSTS = /(^|\.)(reddit|quora|yelp|tripadvisor|trustpilot|facebook|instagram|twitter|x|tiktok|youtube|pinterest|nextdoor|patient|healthunlocked|mumsnet)\./i;
const REFERENCE_HOSTS = /(^|\.)(zocdoc|healthgrades|vitals|ratemds|wellness|yellowpages|bbb|angi|angieslist|homeadvisor|thumbtack|findlaw|avvo|lawyers|martindale|nolo|expertise|opencare|dentaldepartures|birdeye|nexhealth)\./i;
const EDITORIAL_HOSTS = /(^|\.)(nytimes|washingtonpost|bbc|cnn|forbes|healthline|webmd|medicalnewstoday|verywell|prevention|self|menshealth|womenshealth|guardian|reuters|apnews|npr|boston|globe)\./i;
const INSTITUTIONAL_TLD = /\.(gov|edu|mil)$/i;
// Professional bodies and non-profits that carry authority rather than
// commercial intent.
const INSTITUTIONAL_HOSTS = /(^|\.)(ada|aap|aaoms|who|cdc|nih|nhs|heart|cancer|diabetes|mayoclinic|clevelandclinic|hopkinsmedicine)\./i;

/**
 * §5.3, first match wins. `you` and `competitor` are decided by the configured
 * measured set, never by pattern — a client's own domain must never be
 * classified as anything else, whatever it looks like.
 *
 * @param {string} hostOrUrl
 * @param {object} [sets]
 * @param {string[]} [sets.clientDomains]
 * @param {string[]} [sets.competitorDomains]
 */
function classifyDomain(hostOrUrl, { clientDomains = [], competitorDomains = [] } = {}) {
  const host = hostOf(hostOrUrl);
  if (!host) return 'other';
  const domain = registrableDomain(host);

  const matches = (list) => list
    .map((d) => registrableDomain(d))
    .filter(Boolean)
    .some((d) => d === domain);

  if (matches(clientDomains)) return 'you';
  if (matches(competitorDomains)) return 'competitor';
  if (INSTITUTIONAL_TLD.test(host) || INSTITUTIONAL_HOSTS.test(host)) return 'institutional';
  if (UGC_HOSTS.test(host)) return 'ugc';
  if (EDITORIAL_HOSTS.test(host)) return 'editorial';
  if (REFERENCE_HOSTS.test(host)) return 'reference';
  // .org that is not a recognised professional body is still usually a
  // non-profit rather than a shop.
  if (/\.org$/i.test(host)) return 'institutional';
  if (/\.(com|net|io|co|biz)$/i.test(host)) return 'corporate';
  return 'other';
}

// §6 type_weight — a directory you can get listed in is worth more than a
// competitor's own site you can never appear on.
const TYPE_WEIGHT = {
  competitor: 1.0,
  reference: 1.0,
  institutional: 0.9,
  editorial: 0.8,
  ugc: 0.7,
  corporate: 0.6,
  you: 0.0, // your own site is not a gap
  other: 0.5,
};

function typeWeight(domainType) {
  return TYPE_WEIGHT[domainType] ?? 0.5;
}

// ── §5.4 URL type ──────────────────────────────────────────────────────────

const LISTICLE_TITLE = /^\s*(top|best)\s+\d+|\b\d+\s+(best|top|greatest)\b/i;
const ARTICLE_PATH = /\/(blog|article|articles|news|post|posts|insights|resources|guides?|learn|education|advice)(\/|$)/i;
const DISCUSSION_PATH = /\/(forum|forums|thread|threads|discussion|community|comments|r)(\/|$)/i;
const PRODUCT_PATH = /\/(product|products|shop|store|item|buy)(\/|$)/i;
const CATEGORY_PATH = /\/(category|categories|directory|browse|listings?|all|search)(\/|$)/i;
// A leaf page describing one practice/person: /dental-offices/ma/boston/newbury-st
const PROFILE_PATH = /\/(dentists?|doctors?|providers?|offices?|locations?|practices?|profile|team|staff|dental-offices)(\/|$)/i;

/**
 * §5.4, in the spec's stated order: homepage → profile → category → product →
 * article → listicle → discussion → other.
 *
 * `title` is optional and only used for the listicle test, which is a title
 * signal ("20 best dentists…") rather than a URL shape.
 */
function classifyUrl(url, { title = '' } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { return 'other'; }

  const path = u.pathname.replace(/\/+$/, '');
  if (!path || path === '') return 'homepage';

  if (LISTICLE_TITLE.test(title)) return 'listicle';
  if (DISCUSSION_PATH.test(path)) return 'discussion';
  if (PRODUCT_PATH.test(path)) return 'product';
  if (CATEGORY_PATH.test(path)) return 'category';
  if (ARTICLE_PATH.test(path)) return 'article';
  if (PROFILE_PATH.test(path)) {
    // A profile is a LEAF under one of those sections; the section index
    // itself is a category.
    const depth = path.split('/').filter(Boolean).length;
    return depth >= 3 ? 'profile' : 'category';
  }
  return 'other';
}

/** Everything the citation row needs, in one call. */
function classifyCitation({ url, host, title } = {}, sets = {}) {
  const resolvedHost = hostOf(url || host);
  return {
    url: url ? normaliseUrl(url) : null,
    originalUrl: url || null,
    host: resolvedHost,
    domain: registrableDomain(resolvedHost),
    domainType: classifyDomain(resolvedHost, sets),
    // Only answerable with a path, which ChatGPT does not give — null rather
    // than a guess, so the URLs report can say what it does not know.
    urlType: url ? classifyUrl(url, { title }) : null,
    rulesetVersion: RULESET_VERSION,
  };
}

module.exports = {
  RULESET_VERSION,
  hostOf,
  registrableDomain,
  normaliseUrl,
  classifyDomain,
  classifyUrl,
  classifyCitation,
  typeWeight,
  TYPE_WEIGHT,
};
