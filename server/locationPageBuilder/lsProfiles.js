// ── Location + Service page profiles (docs/ybh-ls-pages.md) ─────────────────
// One place that answers "what does THIS brand's location+service page look
// like?" — brand name, own domain, YMYL rules, schema type, URL shape, and
// the character/count budgets every downstream module gates on.
//
// Why a profile rather than a second wizard: the template is explicit that the
// framework must work unchanged across services, conditions, treatments,
// locations and brands (§0, §16), and that nothing page-specific may be
// hard-coded. The Gentle Dental flow proved the pipeline but bakes one client
// into it — GD_CLIENT_ID and OWN_DOMAIN are constants, the ladders are dental
// ladders, and the budgets live in config.dental. Everything that differs
// between brands is resolved here instead, so lsBrief / lsWriter / lsQa /
// lsCompose never name a client.
//
// Two sources feed a profile, and the split matters:
//   - the CLIENT ROW in the store (name, brand_static, brand_rules) — data the
//     SEO team edits, seeded per client;
//   - config.lsPages (defaults + per-client overrides) — tunables the team
//     retunes without a re-seed.
// Nothing is duplicated between them: if a value is already on the client row
// it is never copied into config.

const config = require('./config');
const { slugify } = require('./urlBuilder');
const text = require('./text');

// The page_type stamped on every row this engine writes. Deliberately distinct
// from 'location_service' (the Neuro pipeline) and 'dental_location_service'
// (the GD wizard): all three share the `pages` collection, and each dashboard
// filters on the type it can actually render.
const LS_PAGE_TYPE = 'ls_location_service';

// Merges a per-client override onto the defaults ONE LEVEL DEEP per key, which
// is what lets `{ faqs: { max: 6 } }` keep the default min and minLocalized.
// A deeper merge would be worse here, not better: every value below the second
// level is a scalar or a list meant to be replaced wholesale.
function mergeBudgets(defaults, override = {}) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(override)) {
    const base = defaults[key];
    out[key] = (value && typeof value === 'object' && !Array.isArray(value)
      && base && typeof base === 'object' && !Array.isArray(base))
      ? { ...base, ...value }
      : value;
  }
  return out;
}

// The hostname of the client's own site, so competitor research can exclude
// the pages we are writing against. Derived from the client row's base_url
// rather than configured separately — two copies of the same domain is one
// copy too many, and the one in the client row is the one the URLs are built
// from.
function ownDomainOf(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('//') ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

// Everything downstream reads a profile, never a client id. Takes the client
// ROW (already loaded by compose.loadLayers) so this stays a pure function —
// no store access, no async, testable without a database.
function resolveProfile(client = {}) {
  const clientId = client.id || '';
  const overrides = config.lsPages.clients[clientId] || {};
  const budgets = mergeBudgets(config.lsPages.defaults, overrides);
  const baseUrl = String(client.brand_static?.base_url || '').replace(/\/+$/, '');

  return {
    clientId,
    pageType: LS_PAGE_TYPE,
    brandName: client.name || '',
    baseUrl,
    ownDomain: ownDomainOf(baseUrl),
    // YMYL posture and the claims that must never appear, straight off the
    // client row — the writer prompt and the QC gates both read these, so a
    // brand's prohibited-claims list is edited in one place.
    ymyl: !!client.brand_rules?.ymyl,
    prohibitedClaims: client.brand_rules?.prohibited_claims || [],
    licensingLanguage: client.brand_rules?.licensing_language || '',
    // schema.org type for the business node. MedicalBusiness is the safe
    // default for the health verticals this engine was built for; a non-health
    // brand overrides it on its global template.
    businessType: overrides.businessType || 'MedicalBusiness',
    // Added to a SERP query when the service name alone is ambiguous ("PHP",
    // "IOP", "Sealants"). See qualifySeed.
    seedQualifier: overrides.seedQualifier || '',
    // Words the brand's pages carry implicitly, dropped on the retry pass of
    // the keyword-identity gates (see lsQa). Empty by default: dropping a word
    // the page does NOT imply would let a keyword clear a gate it should fail.
    verticalWords: overrides.verticalWords || [],
    urlPattern: budgets.urlPattern,
    trailingSlash: !!budgets.trailingSlash,
    budgets,
  };
}

// The budgets alone, resolved from a client ID with no store access. The QC
// engine needs them and must stay pure and synchronous (it runs inside every
// save path), so it cannot load a client row to get them — and stamping them
// onto each page row instead would freeze every page at the numbers it was
// written to, which is the opposite of "retunable in config".
function budgetsFor(clientId) {
  return mergeBudgets(config.lsPages.defaults, config.lsPages.clients[clientId] || {});
}

// Ambiguous service names ("PHP", "IOP") return the wrong SERP entirely
// without the vertical attached, and attaching it unconditionally gives you
// "mental health anxiety treatment torrance" — a query nobody types. The rule
// itself lives in text.qualifySeed, shared with keywordAdapter; this wrapper
// just reads the qualifier off the profile.
function qualifySeed(seed, profile = {}) {
  return text.qualifySeed(seed, profile.seedQualifier);
}

// Template §2: /locations/{location-slug}/{service-slug}. The pattern lives on
// the profile so a client whose site nests location pages differently changes
// one config value instead of getting a branch in the URL builder.
//
// `location_slug` falls back to the city when a location row carries no slug
// of its own, so a half-populated seed still produces a usable URL rather than
// "/locations//anxiety-treatment".
function lsPageUrl(profile, location = {}, service = {}) {
  const locationSlug = slugify(location.location_slug || location.city || location.location_name || '');
  const serviceSlug = slugify(service.slug || service.name || '');
  const path = String(profile.urlPattern || config.lsPages.defaults.urlPattern)
    .replace('{location_slug}', locationSlug)
    .replace('{service_slug}', serviceSlug)
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  return profile.trailingSlash ? `${path}/` : path;
}

function lsCanonicalUrl(profile, location, service) {
  return `${profile.baseUrl || ''}${lsPageUrl(profile, location, service)}`;
}

module.exports = {
  LS_PAGE_TYPE, resolveProfile, budgetsFor, qualifySeed, lsPageUrl, lsCanonicalUrl,
  mergeBudgets, ownDomainOf,
};
