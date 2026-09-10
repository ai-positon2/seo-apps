// ── Keyword adapter — Build Brief §3 Step 2 ─────────────────────────────────
// Thin adapter over the app's shared SERP + SEMrush primitives — NOT the
// standalone SSE `/api/keyword-research` route (which has no city/state
// params and no callable function to wrap) and NOT LPB's heavier
// generateSeeds/rankCompetitors/extractKeywords/classifyKeywords pipeline
// (which pulls in an LLM classification pass this wizard doesn't need).
//
// Builds a seed query, pulls the top organic result URLs for it, extracts
// each URL's ranking keywords via SEMrush (`url_organic`), merges/dedupes them
// with the client's imported keyword universe, and hands the pool to
// keywordRelevance for Primary/Secondary selection. Returns
// { candidates, primary, secondary, rejected, reviewFailures, lowVolume } --
// `candidates` is the full pool the wizard's Step 2 table sorts/picks from.

const store = require('./store');
const config = require('./config');
const { escapeRegex, baseCity, qualifySeed } = require('./text');
const { searchGoogle } = require('../services/googleSearch');
const { getUrlKeywords } = require('../services/semrush');
const { getUniverseCandidates, getKnownCities } = require('./keywordUniverseStore');
const { relevanceTermsFor } = require('./keywordUniverseMap');
const { selectPrimaryAndSecondary } = require('./keywordRelevance');

const TOP_URLS = 10;

function classifyIntent(keyword) {
  const kw = String(keyword || '').toLowerCase();
  if (/\b(what is|how|why|guide|vs\.?|difference|symptoms|causes)\b/.test(kw)) return 'informational';
  if (/\b(book|appointment|schedule|near me|call|cost|price|emergency)\b/.test(kw)) return 'commercial';
  return 'commercial';
}

// Several Gentle Dental service names are ambiguous outside a dental context
// ("Sealants" and "Crowns & Bridges" read as construction/civil-engineering
// terms, "Braces" as orthopedic, "Implants" as medical/cosmetic-surgery) — a
// bare "{service} {city} {state}" SERP query for these returns building
// departments, civic pages, etc. instead of dental competitors. Disambiguate
// by ensuring "dental" is in the query whenever it isn't already implied.
function disambiguate(seed) {
  return /dental|dentist/i.test(seed) ? seed : `Dental ${seed}`;
}

// The vertical-neutral form lives in text.js (text.qualifySeed) so lsProfiles
// can share it without importing this module's SERP/SEMrush stack.

// escapeRegex and baseCity now live in text.js, so compose.js can resolve the
// same parent city without importing this module's SERP/SEMrush/LLM chain.

// A competitor's SEMrush ranking-keyword set spans every city they compete
// in, not just the page's own — e.g. a "Veneers Derry" search surfaces a
// multi-location competitor whose top keywords include "veneers manchester
// nh", "veneers goffstown nh", etc. Those aren't off-topic, just off-location
// for this page, so build a regex of every OTHER city — this client's own
// office cities, plus the broader place-name vocabulary the imported
// keyword universe already knows about — and drop live-pool keywords that
// mention one.
// The broader region and the state are NOT rival cities — a secondary keyword
// naming "Greater Boston" or "Massachusetts" is legitimate reach for this
// page. `allowTerms` is exempted from the block list even when a place-name
// source (this client's own office cities, or the universe's vocabulary)
// happens to contain it.
// Removes the mentions this page is allowed to make (its own broader region
// and state) from a keyword before rival-city matching runs.
//
// Without this, the region exception silently fails: "greater boston" is kept
// out of the block list, but the list still contains the rival office city
// "boston", and a word-boundary match on that also fires inside "invisalign
// greater boston" -- blocking the very keyword the exception exists to allow.
// Longest term first so "greater boston" is consumed before a bare "boston"
// could be.
function stripAllowedRegions(keyword, allowTerms = []) {
  return allowTerms
    .filter(Boolean)
    .map(t => String(t).toLowerCase().trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((acc, t) => acc.replace(
      new RegExp('\\b' + escapeRegex(t) + '\\b', 'gi'), ' '),
      String(keyword || '').toLowerCase());
}

// Pure half of the other-city filter, split out so it is testable without a
// store. Given the page's own city, the place names it may legitimately
// mention (its region + state), and every known place name, returns the rival
// locations to block.
//
// Two exclusions beyond the obvious "not the target itself":
//   - allowTerms: the broader region and state are this office's own reach.
//   - anything contained in the target: a shorter office city can sit inside
//     this page's city -- "Boston" inside "South Boston", "Nashua" inside
//     "South Nashua". Blocking it would throw out the page's OWN city
//     keywords, since a word-boundary match on "boston" also hits
//     "invisalign south boston".
function rivalCities({ targetCity, allowTerms = [], knownCities = [] }) {
  const target = String(targetCity || '').toLowerCase().trim();
  const allow = new Set(allowTerms.filter(Boolean).map(t => String(t).toLowerCase().trim()));
  const containedInTarget = c => new RegExp('\\b' + escapeRegex(c) + '\\b').test(target);
  return [...new Set(knownCities.filter(Boolean).map(c => String(c).toLowerCase().trim()))]
    .filter(c => c && c !== target && !allow.has(c) && !containedInTarget(c));
}

async function getOtherCityRegex(clientId, targetCity, allowTerms = []) {
  if (!clientId) return null;
  try {
    const [locations, universeCities] = await Promise.all([
      store.list('locations', { client_id: clientId }),
      getKnownCities(clientId),
    ]);
    const others = rivalCities({
      targetCity,
      allowTerms,
      knownCities: [...locations.map(l => baseCity(l.city, l.region)), ...universeCities],
    });
    if (!others.length) return null;
    // NOTE: this is a template literal, so the word-boundary escapes must be
    // doubled. A single backslash-b here is the backspace character and the
    // regex silently matches nothing, letting every rival city through.
    return new RegExp(`\\b(${others.map(escapeRegex).join('|')})\\b`, 'i');
  } catch {
    return null;
  }
}

// `qualifier` is the vertical word the SERP needs when the service name alone
// is ambiguous. Gentle Dental passes none and keeps `disambiguate`'s "Dental"
// default, which is correct for a dental catalogue and wrong for every other
// brand — a behavioral-health page searching "Dental IOP Long Beach" returns
// nothing usable. Template-driven clients pass their own from their profile
// (lsProfiles.seedQualifier).
async function getKeywordCandidates({ service, city, state, stateName, region, seedQuery, clientId, serviceSlug, qualifier }) {
  const rawSeed = (seedQuery || `${service} ${city} ${state}`).trim();
  if (!rawSeed) throw new Error('A service+city+state or seedQuery is required.');
  if (!process.env.SEMRUSH_API_KEY) throw new Error('SEMRUSH_API_KEY not configured on server.');
  const seed = qualifier ? qualifySeed(rawSeed, qualifier) : disambiguate(rawSeed);
  // Strip any sub-area label before matching keywords (see baseCity).
  const searchCity = baseCity(city, region);

  // Region + state are allowed in Secondary (broader-region reach); every
  // other place name stays blocked. Threaded into both the live-pool filter
  // and the LLM selection prompt so the two agree.
  const regionTerms = [region, state, stateName].filter(Boolean);

  // v8: bumped after two further changes to what the pool contains -- the
  // universe is now over-fetched then filtered then trimmed, and the
  // other-city filter strips allowed region mentions before matching (so
  // region keywords survive). A v7 pool predates both and is wrong.
  // v7 resolved sub-area office labels to their parent city
  // (baseCity), which changes both the universe match and the other-city
  // filter. v6 widened the SERP pull to 10 URLs x 30 keywords, and
  // after exempting region/state from the other-city filter (both change the
  // cached pool's contents). v5 had applied the topical relevance filter to
  // universe candidates too, previously live-pool only.
  const cacheK = store.cacheKey('dental-kw-adapter-v8', seed, clientId, serviceSlug, regionTerms, searchCity);
  // Non-fatal: a store outage (or an unconfigured Supabase) must degrade to a
  // fresh pull, not fail the request.
  let cached = null;
  try { cached = await store.cacheGet(cacheK, config.cache.serpTtlMs); } catch { /* recompute */ }
  const relevanceTerms = serviceSlug ? relevanceTermsFor(serviceSlug) : null;
  const candidates = cached || await buildCandidatePool({ seed, city: searchCity, clientId, serviceSlug, relevanceTerms, regionTerms });
  if (!cached) { try { await store.cacheSet(cacheK, candidates, { kind: 'serp', ttlMs: config.cache.serpTtlMs }); } catch { /* non-fatal */ } }

  // Spread the whole selection result: it carries lowVolume and reviewFailures
  // as well as primary/secondary/rejected, and the wizard needs all of them.
  const selection = await selectPrimaryAndSecondary({
    service, city: searchCity, state, region, candidates, relevanceTerms, regionTerms,
  });
  return { candidates, ...selection };
}

// The billed SEMrush call, cached per URL for config.cache.semrushTtlMs (180
// days). Two things matter here:
//   * the key is IDENTICAL to the one pipeline.js uses, so the Neuro pipeline
//     and this wizard share one cache rather than each paying separately;
//   * the RAW rows are cached, before isRelevant() filtering, so changing the
//     relevance rules (or bumping the pool key below) re-filters what we
//     already hold instead of re-billing SEMrush.
// Cache failures are non-fatal, matching getKeywordCandidates' own handling --
// an unconfigured/unavailable store must degrade to a live pull, not a 500.
async function semrushKeywordsCached(url) {
  const cacheK = store.cacheKey('semrush', url, config.semrush.keywordsPerUrl);
  try {
    const hit = await store.cacheGet(cacheK, config.cache.semrushTtlMs);
    if (hit) return hit;
  } catch { /* fall through to a live pull */ }

  const kws = await getUrlKeywords(url, process.env.SEMRUSH_API_KEY, config.semrush.keywordsPerUrl, config.semrush.database);
  try {
    await store.cacheSet(cacheK, kws, { kind: 'semrush', ttlMs: config.cache.semrushTtlMs });
  } catch { /* non-fatal */ }
  return kws;
}

async function buildCandidatePool({ seed, city, clientId, serviceSlug, relevanceTerms, regionTerms }) {
  const serp = await searchGoogle(seed);
  const urls = (serp.results || []).slice(0, TOP_URLS).map(r => r.url).filter(Boolean);

  // With no topical filter, a competitor URL's SEMrush ranking keywords are
  // dominated by unrelated brand/generic-dentist terms for niche services
  // (e.g. "Veneers" pulling in "vanguard dental", "dentist manchester nh" —
  // nothing veneers-specific at all). Keep only keywords containing one of
  // the service's relevance terms, when we have them for this service.
  const otherCityRe = await getOtherCityRegex(clientId, city, regionTerms);
  const isRelevant = kw => {
    const lower = kw.toLowerCase();
    if (relevanceTerms && !relevanceTerms.some(t => lower.includes(t))) return false;
    // Match rivals against the keyword with its allowed region/state mentions
    // removed, so "invisalign greater boston" survives even though "boston" is
    // itself a rival office city.
    if (otherCityRe && otherCityRe.test(stripAllowedRegions(lower, regionTerms))) return false;
    return true;
  };

  // Fire the per-URL SEMrush lookups together. Sequentially, TOP_URLS (10)
  // calls at getUrlKeywords' own 15s timeout could reach 150s, and
  // server.timeout is 180s — the SERP call and two LLM passes on top of that
  // put the request over the edge, killing it after all the billed API spend.
  // Each URL keeps its own catch, so one failure still can't fail the request.
  const perUrl = await Promise.all(urls.map(async (url) => {
    try {
      const kws = await semrushKeywordsCached(url);
      return kws.filter(k => isRelevant(k.keyword || '')).map(k => ({ ...k, source: 'live' }));
    } catch {
      return [];
    }
  }));
  const pool = perUrl.flat();

  // The live SERP+SEMrush pull borrows whatever a competitor's page ranks
  // for — for niche service+location combos that's often off-topic (the page
  // ranks mainly for unrelated terms). Merge in the client's own pre-scored
  // keyword universe, when one has been imported, to fill that gap.
  if (clientId && serviceSlug) {
    try {
      const universe = await getUniverseCandidates({
        clientId, serviceSlug, city,
        limit: config.keywords.universePoolSize * config.keywords.universeOverfetch,
      });
      // The universe's cluster tagging is broader than this service's own
      // relevance terms (e.g. "Sleep Apnea & Snoring" also covers CPAP
      // supplies, not just the treatment service) — re-apply the same
      // topical filter used on the live pool rather than trusting cluster
      // membership alone.
      pool.push(...universe
        .filter(k => isRelevant(k.keyword || ''))
        .slice(0, config.keywords.universePoolSize));
    } catch {
      // Universe lookup is a supplement, not a dependency — never fail the
      // whole request because of it.
    }
  }

  // Client wants location-specific keywords, not generic "near me" phrasing —
  // drop those outright rather than just deprioritizing (even a 0-volume
  // location-specific keyword beats a high-volume "near me" one here).
  const NEAR_ME_RE = /\bnear me\b/i;

  const byKeyword = new Map();
  for (const k of pool) {
    const key = (k.keyword || '').toLowerCase().trim();
    if (!key || NEAR_ME_RE.test(key)) continue;
    const existing = byKeyword.get(key);
    if (!existing || (k.volume || 0) > (existing.volume || 0)) {
      byKeyword.set(key, {
        keyword: k.keyword,
        volume: k.volume || 0,
        difficulty: k.difficulty || 0,
        intent: classifyIntent(k.keyword),
        source: k.source || 'live',
      });
    }
  }

  return [...byKeyword.values()].sort((a, b) => b.volume - a.volume);
}

module.exports = { getKeywordCandidates, disambiguate, baseCity, rivalCities, stripAllowedRegions };
