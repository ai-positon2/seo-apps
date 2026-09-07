// ── Deterministic rules over a model verdict ────────────────────────────────
//
// Pure: (pageData, verdict) -> ClassificationResult. No network, no clock read
// beyond the caller's, no I/O — every function here is a fixture away from a
// unit test, which is the point.
//
// The model classifies; these rules constrain. They exist because some of the
// spec's precedence is not a judgement call at all — a URL ending /cart is a
// cart whatever the title says — and because the rules that ARE judgement calls
// need a floor the model cannot talk itself under. Rule 4 is the clearest case:
// "converting well is not sufficient" to be a `landing`, and a model reading a
// persuasive page will reach for it constantly.
//
// ── What this classifier can and cannot see ────────────────────────────────
//
// It runs over Competitor Analysis top pages, which store a URL, a title, and
// SEMrush traffic figures. There is no DOM, no JSON-LD, no H1, no nav, no
// sitemap membership — those belong to the site crawler, which fetches pages;
// this module reads a list.
//
// So the spec's signal order (rule 6: JSON-LD @type > URL path token >
// breadcrumb > H1 > title) is implemented from its third rung down: URL path
// token, then title. The rungs above are absent, not ignored, and every facet
// that needs them (primary_schema_type, indexable, in_sitemap, word_count,
// has_form, ...) is stored as null rather than guessed. A null facet is a
// missing measurement; a fabricated one is a wrong answer that looks measured.
const {
  UTILITY_SUBTYPES, INDEX_SUBTYPES, familyOf, funnelStageOf, contentFormatOf, isValidSubtype,
} = require('./pageTaxonomy');

// Below this, a verdict is not trusted enough to stand as an answer (rule 8).
const CONFIDENCE_THRESHOLD = 0.4;
// Rule 7: two candidates this close are both worth storing.
const SECONDARY_GAP = 0.15;

// ── Signals ────────────────────────────────────────────────────────────────
// Every rule that fires appends one of these. `signals` is the explanation of a
// verdict, and the reason a surprising classification can be argued with rather
// than merely disbelieved.
const signal = (rule, detail, from) => ({ rule, detail, from });

// URL path tokens that settle a utility page on their own (rule 1). Matched as
// whole path segments — `/account/` is an account page, `/my-account-manager`
// is not.
const UTILITY_TOKENS = [
  [/^(cart|basket|shopping-cart)$/, 'cart'],
  [/^(checkout|payment)$/, 'checkout'],
  [/^(order-confirmation|order-complete|receipt)$/, 'order_confirmation'],
  [/^(login|signin|sign-in|log-in)$/, 'login'],
  [/^(account|my-account|profile-settings)$/, 'account'],
  [/^(portal|client-portal|partner-portal|customer-portal)$/, 'portal'],
  [/^(search|search-results)$/, 'search_results'],
  [/^(sitemap|site-map|html-sitemap)$/, 'sitemap_html'],
  [/^(404|not-found|error)$/, 'error'],
];

// Legal is a utility type but reads as a phrase more often than a bare segment.
const LEGAL_TOKENS = /^(privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|terms-of-use|disclaimer|accessibility|cookie|cookies|cookie-policy|legal|legal-notices|hipaa|hipaa-notice|gdpr|dsar)$/;

// Query keys that mean somebody paid to land a visitor here — the only
// campaign-scoping evidence available without the DOM (rule 4).
const PAID_PARAMS = /^(utm_|gclid|fbclid|msclkid|gbraid|wbraid|mc_cid|li_fat_id)/i;

const LOCALE_SEGMENT = /^([a-z]{2})(?:[-_]([a-z]{2}))?$/i;
// Two-letter segments that are far more likely to be a section than a language.
const NOT_LOCALES = new Set(['ai', 'hr', 'it', 'is', 'in', 'no', 'me', 'do', 'go', 'be', 'we', 'us', 'id', 'so', 'my', 'up', 'on', 'at', 'to', 'or', 'by']);

const PAGINATION = [
  /^page[-/]?(\d+)$/i,
  /^p(\d+)$/i,
];

function segmentsOf(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean).map((s) => s.toLowerCase()); }
  catch { return String(url || '').split('/').filter(Boolean).map((s) => s.toLowerCase()); }
}

function queryOf(url) {
  try { return new URL(url).searchParams; } catch { return new URLSearchParams(); }
}

// ── Facets ─────────────────────────────────────────────────────────────────

// A geo token in the URL or title. Deliberately structural rather than a city
// gazetteer: a US-state code or a "<something>-in-<place>" / "<place>-<service>"
// shape is evidence; a list of 30,000 place names in this file is a maintenance
// burden that would still miss most of the world.
const US_STATES = /^(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|ia|id|il|in|ks|ky|la|ma|md|me|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy)$/;
const GEO_PATH_HINT = /(^|\/)(locations?|offices?|stores?|branches|dealers?|find-a-|near-me)(\/|$)/i;

function detectGeo(url, title) {
  const segs = segmentsOf(url);
  if (segs.some((s) => US_STATES.test(s))) return true;
  if (GEO_PATH_HINT.test(`/${segs.join('/')}/`)) return true;
  if (/\b(in|near)\s+[A-Z][a-z]+/.test(title || '')) return true;
  return false;
}

function detectLocale(url) {
  const segs = segmentsOf(url);
  if (!segs.length) return null;
  const first = segs[0];
  if (NOT_LOCALES.has(first)) return null;
  const m = first.match(LOCALE_SEGMENT);
  if (!m) return null;
  return m[2] ? `${m[1].toLowerCase()}-${m[2].toUpperCase()}` : m[1].toLowerCase();
}

function detectPagination(url) {
  const segs = segmentsOf(url);
  for (let i = 0; i < segs.length; i += 1) {
    // "/page-3" and "/p3" — the number rides on the segment.
    for (const re of PAGINATION) {
      const m = segs[i].match(re);
      if (m) return { is_paginated: true, page_number: Number(m[1]) };
    }
    // "/page/3" — the far more common shape, where the number is its own
    // segment. Matching only within a segment missed every WordPress-style
    // paginated archive on the web.
    if (/^(page|pg)$/.test(segs[i]) && /^\d+$/.test(segs[i + 1] || '')) {
      return { is_paginated: true, page_number: Number(segs[i + 1]) };
    }
  }
  const q = queryOf(url);
  for (const key of ['page', 'p', 'pg']) {
    const v = q.get(key);
    if (v && /^\d+$/.test(v)) return { is_paginated: true, page_number: Number(v) };
  }
  return { is_paginated: false, page_number: null };
}

function detectCampaignScoped(url) {
  const q = queryOf(url);
  for (const key of q.keys()) if (PAID_PARAMS.test(key)) return true;
  return false;
}

/**
 * Facets derivable from a URL and a title alone. Anything needing the page body
 * is null — see the note at the top of this file.
 */
function deriveFacets(page, subtype) {
  const url = page.fullUrl || page.url || '';
  const { is_paginated, page_number } = detectPagination(url);
  return {
    is_index_page: INDEX_SUBTYPES.includes(subtype),
    is_paginated,
    page_number,
    is_gated: null,               // needs the page body
    is_campaign_scoped: detectCampaignScoped(url),
    geo_modified: detectGeo(url, page.title),
    funnel_stage: funnelStageOf(subtype),
    content_format: contentFormatOf(subtype),
    primary_schema_type: null,    // needs JSON-LD
    template_fingerprint: null,   // needs the DOM
    indexable: null,              // needs robots/meta
    canonical_self: null,         // needs <link rel=canonical>
    in_sitemap: null,             // not known for competitor domains
    in_nav: null,                 // needs the DOM
    orphan: null,                 // needs the link graph
    word_count: null,             // needs the page body
    has_price: null,              // needs the page body
    has_nap: null,                // needs the page body
    has_form: null,               // needs the page body
    has_date_byline: null,        // needs the page body
    locale: detectLocale(url),
  };
}

// ── Precedence rules ───────────────────────────────────────────────────────

/** Rule 1 — utility overrides everything. */
function applyUtilityOverride(page, subtype, signals) {
  const segs = segmentsOf(page.fullUrl || page.url || '');
  for (const seg of segs) {
    if (LEGAL_TOKENS.test(seg)) {
      if (subtype !== 'legal') signals.push(signal('utility_override', `path segment "${seg}" is legal/utility`, 'url'));
      return 'legal';
    }
    for (const [re, forced] of UTILITY_TOKENS) {
      if (re.test(seg)) {
        if (subtype !== forced) signals.push(signal('utility_override', `path segment "${seg}" is a ${forced} page`, 'url'));
        return forced;
      }
    }
  }
  // A model-assigned utility type with no URL evidence is left alone — the
  // title may be the only thing that says "Page not found".
  if (UTILITY_SUBTYPES.includes(subtype)) signals.push(signal('utility_kept', `model assigned utility subtype "${subtype}"`, 'model'));
  return subtype;
}

/** Rule 2 — the most specific entity intersection wins. */
function applyIntersection(page, subtype, signals) {
  const segs = segmentsOf(page.fullUrl || page.url || '');
  const path = `/${segs.join('/')}/`;

  // job_posting > careers_hub: a careers path with something specific under it.
  if (subtype === 'careers_hub' && /(^|\/)(careers?|jobs?)(\/)/.test(path) && segs.length >= 2) {
    signals.push(signal('intersection', 'an individual posting under a careers path outranks the hub', 'url'));
    return 'job_posting';
  }
  // location_service > service, and > geo_landing: a geo token AND a service
  // token in the same path is the intersection, not either half.
  if ((subtype === 'service' || subtype === 'geo_landing') && detectGeo(page.fullUrl || page.url, page.title)
      && /(^|\/)(services?|treatments?|procedures?|repair|cleaning|installation)(\/|-)/.test(path)) {
    signals.push(signal('intersection', 'service token and geo token in one path outrank either alone', 'url'));
    return 'location_service';
  }
  return subtype;
}

/**
 * Rule 4 — `landing` requires campaign scoping, and converting well is not
 * enough. Without the DOM the only evidence available is a paid entry param, so
 * an unevidenced `landing` is demoted rather than trusted.
 */
function applyLandingGuard(page, subtype, facets, signals) {
  if (subtype !== 'landing') return subtype;
  if (facets.is_campaign_scoped) {
    signals.push(signal('landing_confirmed', 'paid entry parameter present', 'url'));
    return 'landing';
  }
  signals.push(signal(
    'landing_demoted',
    'no campaign-scoping evidence (nav, noindex and sitemap membership are not available here), so a persuasive page is not a landing page',
    'rule',
  ));
  return 'lead_form';
}

/** Rule 5 — a dated, bylined post under a blog path is a post, not a guide. */
function applyDatedPost(page, subtype, signals) {
  if (subtype !== 'guide') return subtype;
  const segs = segmentsOf(page.fullUrl || page.url || '');
  const dated = segs.some((s) => /^(19|20)\d{2}$/.test(s));
  const underBlog = segs.some((s) => /^(blog|news|posts?|articles?|insights?)$/.test(s));
  if (dated && underBlog) {
    signals.push(signal('dated_post', 'a date segment under a blog path outranks evergreen guide', 'url'));
    return 'blog_post';
  }
  return subtype;
}

/** Rule 3 — a listing subtype sets is_index_page; pagination implies a listing. */
function applyIndexRule(subtype, facets, signals) {
  if (facets.is_index_page) {
    signals.push(signal('index_page', `"${subtype}" lists sibling entities`, 'taxonomy'));
  } else if (facets.is_paginated) {
    facets.is_index_page = true;
    signals.push(signal('index_page', `page ${facets.page_number} of a paginated series`, 'url'));
  }
}

/** Rule 8 — a weak verdict becomes unclassified, and says why. */
function applyConfidenceFloor(subtype, confidence, reason, signals) {
  if (confidence >= CONFIDENCE_THRESHOLD) return { subtype, reason: null };
  signals.push(signal('below_threshold', `confidence ${confidence} < ${CONFIDENCE_THRESHOLD}`, 'rule'));
  return {
    subtype: 'unclassified',
    reason: reason || `The classifier's best guess was "${subtype}" at ${confidence} confidence, below the ${CONFIDENCE_THRESHOLD} floor.`,
  };
}

/**
 * Applies every rule, in the spec's order, to one model verdict.
 *
 * @param {object} page     { fullUrl, url, title }
 * @param {object} verdict  { subtype, confidence, secondary, secondaryConfidence, reason }
 * @returns {object} ClassificationResult
 */
function classifyPage(page, verdict) {
  const signals = [];
  let subtype = isValidSubtype(verdict?.subtype) ? verdict.subtype : 'unclassified';
  const confidence = Number.isFinite(verdict?.confidence) ? verdict.confidence : 0;

  if (subtype !== verdict?.subtype) {
    signals.push(signal('invalid_subtype', `model returned "${verdict?.subtype}", which is not in the taxonomy`, 'model'));
  } else {
    signals.push(signal('model', `classified as "${subtype}" at ${confidence}`, 'model'));
  }

  // 1 — utility first, because it overrides everything below.
  subtype = applyUtilityOverride(page, subtype, signals);
  const isUtility = UTILITY_SUBTYPES.includes(subtype);

  // 2 and 5 refine a non-utility verdict.
  if (!isUtility) {
    subtype = applyIntersection(page, subtype, signals);
    subtype = applyDatedPost(page, subtype, signals);
  }

  let facets = deriveFacets(page, subtype);

  // 4 — only after the facets exist, since it reads is_campaign_scoped.
  if (!isUtility) {
    const guarded = applyLandingGuard(page, subtype, facets, signals);
    if (guarded !== subtype) { subtype = guarded; facets = deriveFacets(page, subtype); }
  }

  // 3 — index detection, which can also set the flag from pagination.
  applyIndexRule(subtype, facets, signals);

  // 8 — the floor, last, so it judges the subtype actually being stored.
  const floored = applyConfidenceFloor(subtype, confidence, verdict?.reason, signals);
  subtype = floored.subtype;
  if (floored.subtype === 'unclassified') facets = deriveFacets(page, subtype);

  // 7 — a runner-up close enough to be worth keeping.
  let typeSecondary = null;
  if (isValidSubtype(verdict?.secondary) && Number.isFinite(verdict?.secondaryConfidence)
      && confidence - verdict.secondaryConfidence < SECONDARY_GAP) {
    typeSecondary = familyOf(verdict.secondary);
    signals.push(signal('close_call', `"${verdict.secondary}" at ${verdict.secondaryConfidence} is within ${SECONDARY_GAP}`, 'model'));
  }

  return {
    type: familyOf(subtype),
    subtype,
    subtype_secondary: typeSecondary ? verdict.secondary : null,
    type_secondary: typeSecondary,
    confidence,
    reason: floored.reason,
    signals,
    facets,
  };
}

module.exports = {
  classifyPage, deriveFacets, detectGeo, detectLocale, detectPagination, detectCampaignScoped,
  applyUtilityOverride, applyIntersection, applyLandingGuard, applyDatedPost, applyConfidenceFloor,
  CONFIDENCE_THRESHOLD, SECONDARY_GAP,
};
