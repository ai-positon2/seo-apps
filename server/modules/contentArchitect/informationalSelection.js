// ── Which crawled pages a project's hub and spoke analysis is built from ─────
//
// Hub and spoke maps a site's INFORMATIONAL content: blog posts, articles,
// guides, how-tos, explainers, glossary entries, FAQs and help articles. The
// project-linked run used to cluster every page the crawl read, and on a
// multi-location site that meant location, service-in-a-city, dentist-bio and
// booking pages outnumbered the articles several times over. Those pages share
// city and brand words rather than a topic, so TF-IDF grouped them by city
// ("Rock Hill SC Dental Services"), and the hub scorer's location penalty then
// left every one of those clusters without a hub.
//
// How pages are chosen, in order:
//
//   1. Technical pre-filter — pages that are not a distinct, indexable page in
//      their own right: the homepage, noindex, canonicalised elsewhere, a query-
//      string view, pagination, a trailing-slash or case duplicate.
//   2. URL templates — extractTemplates groups the rest by path shape
//      ("/articles/{slug}", "/locations/{slug}").
//   3. The model judges each template from its URLs alone. Root buckets
//      ("/{slug}", where one-off top-level pages of every kind collapse
//      together), one-off URLs, and templates the model calls "mixed" are
//      judged URL by URL instead.
//   4. The listing page of an informational section ("/articles" above
//      "/articles/{slug}") is dropped: it lists the articles, it is not one.
//
// Verdicts are cached (see `cache` below), so the same crawl structure gives the
// same pages on the next run rather than reshuffling the clusters.
//
// With no model (no key, a failed batch, over budget) the URL rules decide what
// they can decide confidently and nothing else gets in — precision over
// recall, for the reason clusterEngine gives: a wrongly merged cluster costs
// more trust than an honestly omitted page. Every such fallback is named in
// `summary.limitations`.
//
// Pure apart from the injected classifier: no DB, no network of its own. It
// never throws for a model failure; a thrown error here is a bug.

const { extractTemplates, ruleVerdict } = require('./patternClassifier');
const { detectPagination } = require('../competitorAnalysis/contentAnalysis/pageRules');
const { URL_CATEGORIES, TEMPLATE_CATEGORIES } = require('./informationalClassifier');
const {
  INFORMATIONAL_SELECTION_VERSION, SELECTION_INCLUDED_CATEGORIES, LISTING_MIN_CHILDREN,
  SELECTION_TEMPLATE_EXAMPLES, SELECTION_MAX_URL_CHECKS, SELECTION_AI_BUDGET_MS,
  SELECTION_CACHE_TTL_DAYS, SELECTION_ROOT_BUCKET_TEMPLATE_MIN,
} = require('./config');

const DAY_MS = 24 * 60 * 60 * 1000;

// One label per exclusion code. These are what a reader sees next to every page
// that was left out, in the report and the Excel "Excluded" tab.
const REASON_LABELS = {
  homepage: 'The homepage',
  not_indexable: 'Not indexable (noindex)',
  canonical_elsewhere: 'Canonical points to another page',
  canonical_to_homepage: 'Canonical points to the homepage',
  parameterised: 'Parameterised URL (a filtered or duplicate view)',
  paginated: 'Paginated listing page',
  duplicate: 'Duplicate of another crawled URL',
  other_language: 'Another language version',
  utility: 'Form, confirmation or account page',
  invalid_url: 'Unreadable URL',
  listing: 'Listing or index page',
  news: 'News, press or events page',
  service: 'Service or product page',
  location: 'Location page',
  people: 'People page',
  media: 'Podcast or video page',
  other: 'Company, utility or other non-informational page',
  unknown: 'Could not be classified',
  unclassified: 'Could not be judged without the AI check',
  not_checked: 'Not checked this run (URL-check cap reached)',
  // Found only once the page was read (buildFromDiscovery).
  redirected: 'Redirects to another page',
  fetch_failed: 'Could not be read (error or not found)',
  not_html: 'Not an HTML page',
  fetch_cap: 'Not read this run (page limit reached)',
};

// The last path segment of a page that LISTS informational content rather than
// being one: rule (ii) of the listing check.
const SECTION_WORDS = new Set([
  'blog', 'blogs', 'article', 'articles', 'news', 'insights', 'resources', 'resource-center',
  'guides', 'learn', 'learning-center', 'library', 'knowledge-base', 'knowledgebase', 'help',
  'help-center', 'faq', 'faqs', 'glossary', 'posts', 'education', 'patient-education',
]);

// A confident rule-based "article" under one of these folders is news, which
// the informational definition leaves out. (press, newsroom, events and the
// like never reach "article" — patternClassifier's section rule sends them to
// "static" first.)
const NEWS_SEGMENTS = new Set(['news']);

function safeUrl(value) {
  try { return new URL(String(value)); } catch { return null; }
}

function pathSegments(url) {
  const u = safeUrl(url);
  return u ? u.pathname.split('/').filter(Boolean) : [];
}

function hostOf(url) {
  const u = safeUrl(url);
  return u ? u.host.toLowerCase().replace(/^www\./, '') : '';
}

function normalizedPath(url) {
  const u = safeUrl(url);
  if (!u) return '';
  return (u.pathname.replace(/\/+$/, '') || '/').toLowerCase();
}

/**
 * What makes two URLs the same page for this module: host without "www.", path
 * without its trailing slash, case-folded; protocol and fragment ignored. The
 * query string is kept, so a filtered view never collapses into its page.
 */
function pageKey(url) {
  const u = safeUrl(url);
  if (!u) return null;
  return `${hostOf(url)}${normalizedPath(url)}${u.search}`;
}

// Up to `n` example URLs spread evenly across the template, always including the
// first and last in sorted order — the first three in crawl order were often
// three near-identical siblings.
function spreadExamples(urls, n = SELECTION_TEMPLATE_EXAMPLES) {
  const sorted = [...urls].sort();
  if (sorted.length <= n) return sorted;
  const picked = [];
  for (let k = 0; k < n; k += 1) {
    const url = sorted[Math.round((k * (sorted.length - 1)) / (n - 1))];
    if (picked[picked.length - 1] !== url) picked.push(url);
  }
  return picked;
}

// "/articles/{slug}" -> "/articles"; "/blog/{date}/{slug}" -> "/blog"; null when
// the template starts with a placeholder and so has no section page.
function literalPrefix(pattern) {
  const literal = [];
  for (const seg of pattern.split('/').filter(Boolean)) {
    if (seg.includes('{')) break;
    literal.push(seg);
  }
  return literal.length ? `/${literal.join('/')}` : null;
}

// "/articles/some-post" -> "/articles/{slug}". A one-off URL is judged by the
// section it sits in, never by the words of its own slug: as a literal pattern,
// "/blog/ransomware/protecting-financial-services-firms" hit the SERVICE rule on
// "services", and "/the-post-human-breach" hit the article rule on "post".
function folderPatternOf(url) {
  const segs = pathSegments(url);
  if (segs.length < 2) return null; // a top-level page has no folder to judge by
  return `/${segs.slice(0, -1).join('/')}/{slug}`;
}

// The URL rules' answer, mapped onto this module's categories. Only a CONFIDENT
// rule verdict counts; the rules' last-resort guesses are exactly what AI-first
// selection exists to replace.
function ruleCategory(pattern, count, examples) {
  const v = ruleVerdict({ pattern, count, examples });
  if (!v.confident) return 'unclassified';
  switch (v.classification) {
    case 'article': {
      const segs = pattern.toLowerCase().split('/').filter(Boolean);
      return segs.some((s) => NEWS_SEGMENTS.has(s)) ? 'news' : 'informational';
    }
    case 'service': return 'service';
    case 'location': return 'location';
    case 'people': return 'people';
    case 'exclude': return 'listing';
    case 'static': return 'other';
    default: return 'unclassified';
  }
}

function validEntry(entry, allowed, now, ttlMs) {
  if (!entry || typeof entry !== 'object' || !allowed.includes(entry.category)) return null;
  const decided = Date.parse(entry.decidedAt);
  if (!Number.isFinite(decided) || now - decided > ttlMs) return null;
  return entry;
}

// Language codes that appear as a locale path segment ("/de/", "/pt-br/",
// "/help/ja/"). A list rather than "any two letters", so "/us/", "/in/", "/go/"
// and "/ai/" are never read as languages.
const LANGUAGE_CODES = new Set([
  'ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'he', 'hi', 'hr', 'hu', 'id', 'it',
  'ja', 'ko', 'lt', 'lv', 'ms', 'nb', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'th',
  'tr', 'uk', 'vi', 'zh',
]);
const LOCALE_SEGMENT_RE = /^([a-z]{2})(?:[-_]([a-z]{2}|[a-z]{4}|419))?$/i;

/** The language of a locale segment in the first two path segments, or null. */
function localeOf(url) {
  const segs = pathSegments(url).slice(0, 2);
  for (const seg of segs) {
    const m = LOCALE_SEGMENT_RE.exec(seg);
    if (m && LANGUAGE_CODES.has(m[1].toLowerCase())) return m[1].toLowerCase();
  }
  return null;
}

// Path words that make a page a form, a confirmation or an account screen,
// whatever else its slug says. Matched as whole hyphen-separated words, so
// "subscribers" or "confirmation-bias" in a title do not trip it — measured on
// a blog whose "…-subscription-confirmed" pages the URL check called articles.
const UTILITY_WORDS = new Set([
  'thank', 'thanks', 'thankyou', 'confirm', 'confirmed', 'unsubscribe', 'unsubscribed',
  'login', 'logout', 'signin', 'signup', 'checkout', 'cart', 'myaccount', 'password',
]);
const UTILITY_PHRASES = ['thank-you', 'log-in', 'sign-in', 'sign-up', 'my-account', 'subscription-confirmed', 'email-confirmed'];
function isUtilityPath(url) {
  const segs = pathSegments(url).map((s) => s.toLowerCase());
  return segs.some((seg) => UTILITY_PHRASES.some((p) => seg.includes(p))
    || seg.split(/[-_.]/).some((w) => UTILITY_WORDS.has(w)));
}

function isNonIndexable(candidate) {
  return String(candidate.indexability || '').toLowerCase() === 'non-indexable';
}

// The canonical this page names, when it names a DIFFERENT page. CrawlScope
// records the page's own URL when there is no canonical tag, so a missing tag
// and a self-canonical both come back null here.
function canonicalElsewhere(candidate) {
  if (!candidate.canonical) return null;
  const own = pageKey(candidate.url);
  const target = pageKey(candidate.canonical);
  return target && target !== own ? String(candidate.canonical) : null;
}

/**
 * @param {Array<{url, canonical?, indexability?, indexabilityReason?, inlinks?}>} candidates
 *        the crawl's internal 2xx, non-asset pages, in crawl order
 * @param {object}  [opts]
 * @param {object}  [opts.classifier]  informationalClassifier instance, or null for rules only
 * @param {object}  [opts.cache]       the previous run's `verdicts`
 * @param {number}  [opts.now]         epoch ms, for cache freshness
 * @param {object}  [opts.limits]      overrides for the config constants (tests)
 * @param {Array}   [opts.hints]       [{label, path}] — sections the site's own menus
 *                                     label as informational, passed to the model
 * @returns {Promise<{version, method, model, includedIdx: number[], aliasOf: Map<number, number>,
 *          excluded: Array<{url, code, reason, detail, source}>, summary: object, verdicts: object}>}
 */
async function selectInformationalPages(candidates, {
  classifier = null, cache = null, now = Date.now(), limits = {}, hints = [],
} = {}) {
  const L = {
    includedCategories: SELECTION_INCLUDED_CATEGORIES,
    maxUrlChecks: SELECTION_MAX_URL_CHECKS,
    budgetMs: SELECTION_AI_BUDGET_MS,
    ttlDays: SELECTION_CACHE_TTL_DAYS,
    examples: SELECTION_TEMPLATE_EXAMPLES,
    listingMinChildren: LISTING_MIN_CHILDREN,
    rootBucketTemplateMin: SELECTION_ROOT_BUCKET_TEMPLATE_MIN,
    ...limits,
  };
  const list = candidates || [];
  const decisions = new Array(list.length).fill(null); // { code, source, detail }
  const aliasOf = new Map();
  const sourcesUsed = new Set();
  const ttlMs = L.ttlDays * DAY_MS;
  const nowIso = new Date(now).toISOString();
  // The model's clock, not the injectable `now`: a batch must not start after
  // the budget has really run out, whatever the test clock says.
  const deadline = Date.now() + L.budgetMs;

  const decide = (i, code, source, detail = null) => {
    decisions[i] = { code, source, detail };
  };

  // A cache from another selection version describes a different definition of
  // "informational" and is ignored whole.
  const prior = cache && cache.version === INFORMATIONAL_SELECTION_VERSION ? cache : null;
  const nextCache = { version: INFORMATIONAL_SELECTION_VERSION, templates: {}, urls: {} };
  // Carried forward so a verdict outlives one run's structure, but only while
  // it is fresh — the TTL is what eventually re-asks.
  for (const [k, e] of Object.entries(prior?.templates || {})) {
    if (validEntry(e, TEMPLATE_CATEGORIES, now, ttlMs)) nextCache.templates[k] = e;
  }
  for (const [k, e] of Object.entries(prior?.urls || {})) {
    if (validEntry(e, URL_CATEGORIES, now, ttlMs)) nextCache.urls[k] = e;
  }

  // ── 1. Technical pre-filter ────────────────────────────────────────────────
  const survivors = [];
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i] || {};
    const u = safeUrl(c.url);
    if (!u) { decide(i, 'invalid_url', 'prefilter'); continue; }
    const canonical = canonicalElsewhere(c);
    if (normalizedPath(c.url) === '/') decide(i, 'homepage', 'prefilter');
    else if (isNonIndexable(c)) decide(i, 'not_indexable', 'prefilter', c.indexabilityReason || null);
    else if (u.search) decide(i, 'parameterised', 'prefilter', u.search);
    else if (canonical) {
      decide(i, normalizedPath(canonical) === '/' ? 'canonical_to_homepage' : 'canonical_elsewhere',
        'prefilter', `Canonical: ${canonical}`);
    } else if (detectPagination(c.url).is_paginated) decide(i, 'paginated', 'prefilter');
    else if (isUtilityPath(c.url)) decide(i, 'utility', 'prefilter');
    else survivors.push(i);
  }

  // Other-language copies. A help centre in six languages, or /de-de/ and
  // /es-es/ copies of a blog, are translations of pages already here, not new
  // topics — clustered, they split every topic by language. When the site has
  // more than one language version, only its main one is kept: the most common
  // locale bucket, where "no locale in the path" is a bucket of its own (and,
  // when that one is the main bucket, /en/ pages count with it).
  {
    const bucketOf = (url) => localeOf(url) || 'none';
    const counts = new Map();
    for (const i of survivors) counts.set(bucketOf(list[i].url), (counts.get(bucketOf(list[i].url)) || 0) + 1);
    const locales = [...counts.keys()].filter((k) => k !== 'none');
    if (locales.length >= 2 || (locales.length === 1 && counts.has('none'))) {
      const primary = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      const keep = new Set([primary, 'none', ...(primary === 'none' ? ['en'] : [])]);
      for (let k = survivors.length - 1; k >= 0; k -= 1) {
        const i = survivors[k];
        const bucket = bucketOf(list[i].url);
        if (!keep.has(bucket)) {
          decide(i, 'other_language', 'prefilter', `Language version: ${bucket}`);
          survivors.splice(k, 1);
        }
      }
    }
  }

  // Duplicates: the same page under two spellings. The alphabetically first URL
  // is kept so the choice does not depend on crawl order; links to the other
  // spelling are credited to it (aliasOf), so nothing looks orphaned for it.
  const byKey = new Map();
  for (const i of survivors) {
    const key = pageKey(list[i].url);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(i);
  }
  const kept = [];
  for (const idxs of byKey.values()) {
    const keeper = idxs.reduce((best, i) => (String(list[i].url) < String(list[best].url) ? i : best), idxs[0]);
    kept.push(keeper);
    for (const i of idxs) {
      if (i === keeper) continue;
      aliasOf.set(i, keeper);
      decide(i, 'duplicate', 'prefilter', `Same page as ${list[keeper].url}`);
    }
  }
  kept.sort((a, b) => a - b);

  // ── 2. URL templates ───────────────────────────────────────────────────────
  // Keyed by host when the crawl spans several, so "/blog/{slug}" on two
  // subdomains is two sections, not one.
  const hosts = new Set(kept.map((i) => hostOf(list[i].url)));
  const multiHost = hosts.size > 1;
  const sectionKeyOf = (url) => `${multiHost ? hostOf(url) : ''}${normalizedPath(url)}`;

  const groups = new Map();
  for (const i of kept) {
    const host = multiHost ? hostOf(list[i].url) : '';
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(i);
  }
  const templates = [];
  for (const [host, idxs] of groups) {
    const idxByUrl = new Map(idxs.map((i) => [list[i].url, i]));
    for (const t of extractTemplates(idxs.map((i) => list[i].url))) {
      templates.push({
        key: `${host}${t.pattern}`,
        host,
        pattern: t.pattern,
        count: t.count,
        urls: t.urls,
        idxs: t.urls.map((u) => idxByUrl.get(u)),
      });
    }
  }
  templates.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  // A template whose first segment is a placeholder is where one-off top-level
  // pages of every kind collapse together (privacy, contact and a blog post can
  // all be "/{slug}"), so no single verdict can be right for it.
  const isRootBucket = (t) => {
    const first = t.pattern.split('/').filter(Boolean)[0] || '';
    return first === '{slug}' || first === '{n}';
  };
  const templateQueue = [];
  const urlQueue = [];
  for (const t of templates) {
    // A large root bucket is usually one thing repeated — thousands of
    // /{state}/{city} pages on one marketplace used up the whole URL-check cap
    // one page at a time. So from a size up it is asked about as a template
    // first; the model can still answer "mixed", which sends every page back to
    // the per-URL check. Small buckets, where one-off pages of every kind
    // collapse together, are checked page by page from the start.
    if (t.count >= 2 && (!isRootBucket(t) || t.count >= L.rootBucketTemplateMin)) templateQueue.push(t);
    else for (const i of t.idxs) urlQueue.push({ idx: i, template: t, rootBucket: isRootBucket(t) });
  }

  const aiChecks = {
    templatesAsked: 0, urlsAsked: 0, fromCache: 0, failed: 0, outOfTime: 0, notChecked: 0,
  };
  const errors = [];

  // ── 3a. Template verdicts ──────────────────────────────────────────────────
  const templateVerdict = new Map();
  const pendingTemplates = [];
  for (const t of templateQueue) {
    const hit = validEntry(prior?.templates?.[t.key], TEMPLATE_CATEGORIES, now, ttlMs);
    if (hit) {
      templateVerdict.set(t.key, { category: hit.category, source: 'cache' });
      aiChecks.fromCache += 1;
    } else {
      pendingTemplates.push(t);
    }
  }
  if (classifier && pendingTemplates.length) {
    aiChecks.templatesAsked = pendingTemplates.length;
    const res = await classifier.classifyTemplates(pendingTemplates.map((t) => ({
      key: t.key, pattern: t.pattern, examples: spreadExamples(t.urls, L.examples),
    })), { deadline, hints });
    for (const t of pendingTemplates) {
      const category = res.verdicts.get(t.key);
      if (!category) continue;
      templateVerdict.set(t.key, { category, source: 'ai' });
      nextCache.templates[t.key] = { category, decidedAt: nowIso };
    }
    aiChecks.failed += res.failedKeys.size;
    aiChecks.outOfTime += res.skippedKeys.size;
    if (res.error) errors.push(res.error);
  }
  for (const t of templateQueue) {
    if (!templateVerdict.has(t.key)) {
      templateVerdict.set(t.key, { category: ruleCategory(t.pattern, t.count, spreadExamples(t.urls, 3)), source: 'rules' });
    }
  }
  for (const t of templateQueue) {
    const v = templateVerdict.get(t.key);
    sourcesUsed.add(v.source);
    if (v.category === 'mixed') {
      for (const i of t.idxs) urlQueue.push({ idx: i, template: t, rootBucket: false });
      continue;
    }
    for (const i of t.idxs) decide(i, v.category, v.source, `URL template ${t.pattern}`);
  }

  // ── 3b. URL-by-URL verdicts ────────────────────────────────────────────────
  // Most-linked first, so a cap spends its checks on the pages that matter most.
  urlQueue.sort((a, b) => (Number(list[b.idx].inlinks) || 0) - (Number(list[a.idx].inlinks) || 0)
    || String(list[a.idx].url).localeCompare(String(list[b.idx].url)));
  const urlDetail = (q) => (q.template.count >= 2 ? `URL template ${q.template.pattern} (judged per page)` : null);

  const pendingUrls = [];
  for (const q of urlQueue) {
    const key = pageKey(list[q.idx].url);
    const hit = validEntry(prior?.urls?.[key], URL_CATEGORIES, now, ttlMs);
    if (hit) {
      decide(q.idx, hit.category, 'cache', urlDetail(q));
      sourcesUsed.add('cache');
      aiChecks.fromCache += 1;
    } else {
      pendingUrls.push({ ...q, key });
    }
  }

  const fallbackForUrl = (q) => {
    if (q.rootBucket) return 'unclassified';
    const folder = folderPatternOf(list[q.idx].url);
    return folder ? ruleCategory(folder, 2, [list[q.idx].url]) : 'unclassified';
  };

  if (classifier && pendingUrls.length) {
    const toAsk = pendingUrls.slice(0, L.maxUrlChecks);
    const overCap = pendingUrls.slice(L.maxUrlChecks);
    aiChecks.urlsAsked = toAsk.length;
    const res = await classifier.classifyUrls(toAsk.map((q) => ({ key: q.key, url: list[q.idx].url })), { deadline, hints });
    for (const q of toAsk) {
      const category = res.verdicts.get(q.key);
      if (category) {
        decide(q.idx, category, 'ai', urlDetail(q));
        sourcesUsed.add('ai');
        nextCache.urls[q.key] = { category, decidedAt: nowIso };
      } else {
        decide(q.idx, fallbackForUrl(q), 'rules', urlDetail(q));
        sourcesUsed.add('rules');
      }
    }
    aiChecks.failed += res.failedKeys.size;
    aiChecks.outOfTime += res.skippedKeys.size;
    if (res.error) errors.push(res.error);
    for (const q of overCap) decide(q.idx, 'not_checked', 'cap', urlDetail(q));
    aiChecks.notChecked = overCap.length;
  } else {
    for (const q of pendingUrls) {
      decide(q.idx, fallbackForUrl(q), 'rules', urlDetail(q));
      sourcesUsed.add('rules');
    }
  }

  // ── 4. Listing pages ───────────────────────────────────────────────────────
  const isIncluded = (i) => decisions[i] && L.includedCategories.includes(decisions[i].code);
  const includedNow = kept.filter(isIncluded);

  // (i) The page at an informational template's literal prefix: "/articles"
  //     above "/articles/{slug}".
  const sectionPrefixes = new Set();
  for (const t of templateQueue) {
    if (!L.includedCategories.includes(templateVerdict.get(t.key).category)) continue;
    const prefix = literalPrefix(t.pattern);
    if (prefix) sectionPrefixes.add(`${t.host}${prefix.toLowerCase()}`);
  }
  // (ii) A section page above several informational pages — the case (i) cannot
  //      see, where a small section's posts stayed literal URLs instead of
  //      collapsing into a {slug} template. The section word is required so a
  //      pillar guide with its own sub-guides is NOT dropped.
  const childCount = new Map();
  for (const i of includedNow) {
    const key = sectionKeyOf(list[i].url);
    const host = multiHost ? hostOf(list[i].url) : '';
    const segs = key.slice(host.length).split('/').filter(Boolean);
    for (let d = 1; d < segs.length; d += 1) {
      const ancestor = `${host}/${segs.slice(0, d).join('/')}`;
      childCount.set(ancestor, (childCount.get(ancestor) || 0) + 1);
    }
  }
  for (const i of includedNow) {
    const key = sectionKeyOf(list[i].url);
    const segs = pathSegments(list[i].url);
    const last = (segs[segs.length - 1] || '').toLowerCase();
    if (sectionPrefixes.has(key)) {
      decide(i, 'listing', 'listing', 'The index page of an informational section');
    } else if ((childCount.get(key) || 0) >= L.listingMinChildren && SECTION_WORDS.has(last)) {
      decide(i, 'listing', 'listing', `Lists ${childCount.get(key)} informational pages below it`);
    }
  }

  // ── 5. Result ──────────────────────────────────────────────────────────────
  const includedIdx = [];
  const excluded = [];
  for (let i = 0; i < list.length; i += 1) {
    const d = decisions[i] || { code: 'unknown', source: 'rules', detail: null };
    if (L.includedCategories.includes(d.code)) {
      includedIdx.push(i);
    } else {
      excluded.push({
        url: String(list[i]?.url || ''),
        code: d.code,
        reason: REASON_LABELS[d.code] || d.code,
        detail: d.detail || null,
        source: d.source,
      });
    }
  }

  const byReason = new Map();
  for (const e of excluded) byReason.set(e.code, (byReason.get(e.code) || 0) + 1);
  const excludedByReason = [...byReason.entries()]
    .map(([code, count]) => ({ code, label: REASON_LABELS[code] || code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  // Every template with more than one page, with how it was judged. One-offs
  // are left out of this list: there can be thousands, and each already has its
  // own line in `excluded`.
  const templateSummary = templates
    .filter((t) => t.count >= 2)
    .slice(0, 500)
    .map((t) => {
      const v = templateVerdict.get(t.key);
      const perPage = !v || v.category === 'mixed';
      return {
        pattern: t.key,
        count: t.count,
        category: perPage ? 'per_page' : v.category,
        source: perPage ? (isRootBucket(t) ? 'root_bucket' : 'ai_mixed') : v.source,
        included: t.idxs.filter(isIncluded).length,
        examples: spreadExamples(t.urls, 3),
      };
    });

  const limitations = [];
  const usedModel = sourcesUsed.has('ai');
  if (!classifier) {
    limitations.push(
      'The AI check was unavailable (no API key is configured), so informational pages were chosen '
      + 'by URL rules alone. Pages the rules cannot judge from the folder they sit in — top-level pages '
      + 'among them — were left out.',
    );
  }
  if (aiChecks.failed) {
    limitations.push(
      `The AI check failed for ${aiChecks.failed} template(s) or URL(s)`
      + (errors.length ? ` (${errors[0]})` : '')
      + '; those were judged by URL rules instead.',
    );
  }
  if (aiChecks.outOfTime) {
    limitations.push(
      `The AI check ran out of its ${Math.round(L.budgetMs / 1000)}-second budget; `
      + `${aiChecks.outOfTime} template(s) or URL(s) were judged by URL rules instead.`,
    );
  }
  if (aiChecks.notChecked) {
    limitations.push(
      `${aiChecks.notChecked} page(s) were not checked this run because the ${L.maxUrlChecks}-URL check `
      + 'cap was reached. They are left out for now and will be checked on later runs.',
    );
  }

  const method = ['ai', 'cache', 'rules'].filter((s) => sourcesUsed.has(s)).join('+') || 'rules';
  const model = usedModel ? classifier.model || null : null;

  return {
    version: INFORMATIONAL_SELECTION_VERSION,
    method,
    model,
    includedIdx,
    aliasOf,
    excluded,
    summary: {
      scope: 'informational',
      version: INFORMATIONAL_SELECTION_VERSION,
      method,
      model,
      includedCategories: L.includedCategories,
      crawledPageCount: list.length,
      analysedPageCount: includedIdx.length,
      excludedByReason,
      templates: templateSummary,
      limitations,
      aiChecks,
    },
    verdicts: nextCache,
  };
}

/**
 * What is stored with the analysis: the summary a reader sees, and the verdict
 * cache the next run reads back. The page lists themselves are not repeated
 * here — the included pages ARE the analysis, and the excluded ones are its
 * `excludedUrls`.
 */
function persistableSelection(selection, { decidedAt = new Date().toISOString() } = {}) {
  return {
    version: selection.version,
    method: selection.method,
    model: selection.model,
    decidedAt,
    summary: selection.summary,
    verdicts: selection.verdicts,
  };
}

module.exports = {
  selectInformationalPages,
  persistableSelection,
  pageKey,
  localeOf,
  spreadExamples,
  literalPrefix,
  folderPatternOf,
  ruleCategory,
  REASON_LABELS,
  SECTION_WORDS,
};
