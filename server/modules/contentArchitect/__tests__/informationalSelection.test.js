// ── Which crawled pages hub and spoke clusters ───────────────────────────────
//
// informationalSelection.js decides, for a project-linked run, which of the
// crawl's pages are informational. These tests use a stub in place of the model,
// so every rule here holds whether or not the model is reachable — and the
// fallback rules are tested with no model at all.
//
// Run: node modules/contentArchitect/__tests__/informationalSelection.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  selectInformationalPages, pageKey, spreadExamples, literalPrefix, folderPatternOf,
} = require('../informationalSelection');
const { INFORMATIONAL_SELECTION_VERSION } = require('../config');

const ORIGIN = 'https://www.example-dental.com';
const page = (path, extra = {}) => ({
  url: `${ORIGIN}${path}`, canonical: null, indexability: 'Indexable', inlinks: 0, ...extra,
});
const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i + 1));
const pathOf = (url) => new URL(url).pathname;

// A multi-location practice, shaped like the site that prompted this: articles
// outnumbered several times over by location, service-in-a-city, people and
// booking pages.
function practiceSite() {
  return [
    page('/'),
    page('/articles'),
    ...range(12, (i) => page(`/articles/how-to-care-for-teeth-${i}`)),
    ...range(10, (i) => page(`/locations/city-${i}`)),
    ...range(10, (i) => page(`/location-service/city-${i}-dental-implants`)),
    ...range(10, (i) => page(`/our-dentists/dr-${i}`)),
    ...range(10, (i) => page(`/appointments/city-${i}`)),
    ...range(10, (i) => page(`/dental-services/service-${i}`)),
    page('/contact'),
    page('/careers'),
    page('/privacy-policy'),
  ];
}

// What a model would say about that site, keyed by template and by path.
const PRACTICE_TEMPLATES = {
  '/articles/{slug}': 'informational',
  '/locations/{slug}': 'location',
  '/location-service/{slug}': 'location',
  '/our-dentists/{slug}': 'people',
  '/appointments/{slug}': 'other',
  '/dental-services/{slug}': 'service',
};
const PRACTICE_URLS = {
  '/articles': 'listing', '/contact': 'other', '/careers': 'other', '/privacy-policy': 'other',
};

/**
 * A stand-in for informationalClassifier. `templates` and `urls` map a pattern
 * or a path to a category (or are functions); anything unmapped is 'unknown',
 * exactly as a real well-formed reply that omitted it would be.
 */
function stubClassifier({ templates = {}, urls = {}, failTemplates = false, failUrls = false } = {}) {
  const calls = { templates: [], urls: [] };
  const answer = (map, key) => (typeof map === 'function' ? map(key) : map[key]) || 'unknown';
  const run = async (items, { deadline } = {}, fail, lookup) => {
    const verdicts = new Map();
    const failedKeys = new Set();
    const skippedKeys = new Set();
    for (const item of items) {
      if (deadline && Date.now() > deadline) skippedKeys.add(item.key);
      else if (fail) failedKeys.add(item.key);
      else verdicts.set(item.key, lookup(item));
    }
    return { verdicts, failedKeys, skippedKeys, batches: 1, error: fail ? 'upstream 529' : null };
  };
  return {
    model: 'stub-model',
    calls,
    async classifyTemplates(items, opts) {
      calls.templates.push(items);
      return run(items, opts, failTemplates, (item) => answer(templates, item.pattern));
    },
    async classifyUrls(items, opts) {
      calls.urls.push(items);
      return run(items, opts, failUrls, (item) => answer(urls, pathOf(item.url)));
    },
  };
}

const includedPaths = (candidates, selection) => selection.includedIdx.map((i) => pathOf(candidates[i].url));
const codeFor = (selection, path) => selection.excluded.find((e) => pathOf(e.url) === path)?.code;

// ── Pre-filter ───────────────────────────────────────────────────────────────

test('technical exclusions are recorded, each with its own code', async () => {
  const candidates = [
    ...range(6, (i) => page(`/blog/post-number-${i}`)),
    page('/'),
    page('/blog/hidden-post', { indexability: 'Non-indexable', indexabilityReason: 'Meta robots contains noindex' }),
    page('/blog/moved-post', { canonical: `${ORIGIN}/blog/post-number-1` }),
    page('/blog/template-bug', { canonical: `${ORIGIN}/` }),
    page('/blog?author=jane'),
    page('/blog/page/2'),
    page('/blog/post-number-1/'),
  ];
  const selection = await selectInformationalPages(candidates, {
    classifier: stubClassifier({ templates: { '/blog/{slug}': 'informational' }, urls: { '/blog': 'listing' } }),
  });
  assert.equal(codeFor(selection, '/'), 'homepage');
  assert.equal(codeFor(selection, '/blog/hidden-post'), 'not_indexable');
  assert.equal(codeFor(selection, '/blog/moved-post'), 'canonical_elsewhere');
  assert.equal(codeFor(selection, '/blog/template-bug'), 'canonical_to_homepage');
  assert.equal(selection.excluded.find((e) => e.url.endsWith('?author=jane')).code, 'parameterised');
  assert.equal(codeFor(selection, '/blog/page/2'), 'paginated');
  assert.equal(codeFor(selection, '/blog/post-number-1/'), 'duplicate');
  const noindex = selection.excluded.find((e) => e.code === 'not_indexable');
  assert.match(noindex.detail, /noindex/);
});

test('other-language copies are left out; the site\'s main language is kept', async () => {
  const candidates = [
    ...range(10, (i) => page(`/blog/post-number-${i}`)),
    ...range(4, (i) => page(`/de-de/blog/beitrag-${i}`)),
    ...range(3, (i) => page(`/help/ja/articles/${i}-kiji`)),
    ...range(3, (i) => page(`/help/en/articles/${i}-article`)),
    page('/us/pricing'), page('/in/contact'), // country-like segments, not languages
  ];
  const selection = await selectInformationalPages(candidates, { classifier: stubClassifier({ templates: () => 'informational', urls: () => 'informational' }) });
  const other = selection.excluded.filter((e) => e.code === 'other_language').map((e) => pathOf(e.url));
  assert.equal(other.length, 7);
  assert.ok(other.every((p) => p.startsWith('/de-de/') || p.startsWith('/help/ja/')));
  assert.ok(!selection.excluded.some((e) => e.code === 'other_language' && /\/help\/en\//.test(e.url)), '/en/ goes with the unprefixed main site');
  assert.ok(!selection.excluded.some((e) => e.code === 'other_language' && /\/(us|in)\//.test(e.url)));

  // A single-language site loses nothing.
  const plain = await selectInformationalPages(range(6, (i) => page(`/blog/p-${i}`)), { classifier: stubClassifier({ templates: () => 'informational', urls: () => 'informational' }) });
  assert.equal(plain.excluded.filter((e) => e.code === 'other_language').length, 0);
});

test('confirmation, thank-you and account pages are left out before any model call', async () => {
  const candidates = [
    page('/email-subscription-confirmed/'), page('/thank-you'), page('/newsletter-confirm'),
    page('/my-account/orders'), page('/log-in'),
    page('/how-to-grow-subscribers'), page('/confirmation-bias-in-copywriting'),
  ];
  const selection = await selectInformationalPages(candidates, { classifier: stubClassifier({ urls: () => 'informational' }) });
  const utility = selection.excluded.filter((e) => e.code === 'utility').map((e) => pathOf(e.url)).sort();
  assert.deepEqual(utility, ['/email-subscription-confirmed/', '/log-in', '/my-account/orders', '/newsletter-confirm', '/thank-you']);
  assert.ok(includedPaths(candidates, selection).includes('/confirmation-bias-in-copywriting'), 'a topic word is not a utility word');
});

test('a canonical that differs only by trailing slash, www or protocol is the same page', async () => {
  const candidates = [
    page('/guide/one', { canonical: 'http://example-dental.com/guide/one/' }),
    page('/guide/two', { canonical: `${ORIGIN}/guide/two/` }),
    page('/guide/three', { canonical: `${ORIGIN}/GUIDE/three` }),
  ];
  const selection = await selectInformationalPages(candidates, {
    classifier: stubClassifier({ templates: { '/guide/{slug}': 'informational' }, urls: () => 'informational' }),
  });
  assert.equal(selection.excluded.filter((e) => e.code.startsWith('canonical')).length, 0);
});

test('a duplicate spelling is aliased to the kept page, whatever the crawl order', async () => {
  const a = [page('/tips/a-b-c/'), page('/tips/a-b-c')];
  const b = [page('/tips/a-b-c'), page('/tips/a-b-c/')];
  for (const candidates of [a, b]) {
    // eslint-disable-next-line no-await-in-loop
    const selection = await selectInformationalPages(candidates, { classifier: stubClassifier({ urls: () => 'informational' }) });
    const keptIdx = candidates.findIndex((c) => c.url.endsWith('/tips/a-b-c'));
    const dupIdx = candidates.findIndex((c) => c.url.endsWith('/tips/a-b-c/'));
    assert.equal(selection.aliasOf.get(dupIdx), keptIdx);
    assert.equal(codeFor(selection, '/tips/a-b-c/'), 'duplicate');
  }
});

// ── Routing ──────────────────────────────────────────────────────────────────

test('each multi-page template is asked about once, from URLs only', async () => {
  const candidates = practiceSite();
  const classifier = stubClassifier({ templates: PRACTICE_TEMPLATES, urls: PRACTICE_URLS });
  await selectInformationalPages(candidates, { classifier });
  const asked = classifier.calls.templates.flat();
  assert.deepEqual(asked.map((t) => t.pattern).sort(), Object.keys(PRACTICE_TEMPLATES).sort());
  for (const item of asked) {
    // No titles, no rule verdict, nothing to anchor on: the pattern and URLs.
    assert.deepEqual(Object.keys(item).sort(), ['examples', 'key', 'pattern']);
    assert.ok(item.examples.length <= 8);
    assert.ok(item.examples.every((u) => typeof u === 'string' && u.startsWith('http')));
  }
  const articles = asked.find((t) => t.pattern === '/articles/{slug}');
  const sorted = candidates.map((c) => c.url).filter((u) => /\/articles\/./.test(u)).sort();
  assert.equal(articles.examples[0], sorted[0], 'the examples include the first URL');
  assert.equal(articles.examples.at(-1), sorted.at(-1), 'and the last');
});

test('one-off URLs and root buckets are judged URL by URL, never as a template', async () => {
  const candidates = [
    ...range(6, (i) => page(`/blog/post-${i}-long-slug`)),
    // Ten one-off top-level pages collapse into "/{slug}" — privacy next to a
    // blog post next to a contact page. No single verdict can be right for it.
    ...['privacy-policy', 'terms', 'contact', 'why-we-floss-daily', 'about', 'sitemap',
      'reviews-page', 'financing', 'new-patients', 'what-is-a-crown'].map((s) => page(`/${s}`)),
  ];
  const classifier = stubClassifier({
    templates: { '/blog/{slug}': 'informational' },
    urls: { '/why-we-floss-daily': 'informational', '/what-is-a-crown': 'informational', '/blog': 'listing' },
  });
  const selection = await selectInformationalPages(candidates, { classifier });
  const templatesAsked = classifier.calls.templates.flat().map((t) => t.pattern);
  assert.ok(!templatesAsked.includes('/{slug}'), 'the root bucket never gets a template verdict');
  const urlsAsked = classifier.calls.urls.flat().map((u) => pathOf(u.url));
  assert.ok(urlsAsked.includes('/privacy-policy') && urlsAsked.includes('/what-is-a-crown'));
  const kept = includedPaths(candidates, selection);
  assert.ok(kept.includes('/what-is-a-crown') && kept.includes('/why-we-floss-daily'));
  assert.ok(!kept.includes('/privacy-policy'));
});

test('a large root bucket is asked about as a template first, and "mixed" still splits it', async () => {
  const cities = range(60, (i) => page(`/state-${i % 6}/city-${i}`));
  const same = stubClassifier({ templates: () => 'location', urls: () => 'informational' });
  const one = await selectInformationalPages(cities, { classifier: same });
  assert.equal(same.calls.urls.flat().length, 0, 'one template verdict, not 60 URL checks');
  assert.equal(one.includedIdx.length, 0);

  const mixed = stubClassifier({ templates: () => 'mixed', urls: () => 'location' });
  await selectInformationalPages(cities, { classifier: mixed });
  assert.equal(mixed.calls.urls.flat().length, 60);
});

test('a template the model calls mixed is re-judged page by page', async () => {
  const candidates = range(10, (i) => page(`/resources/item-${i}`));
  const classifier = stubClassifier({
    templates: { '/resources/{slug}': 'mixed' },
    urls: (path) => (Number(path.split('-').pop()) % 2 ? 'informational' : 'other'),
  });
  const selection = await selectInformationalPages(candidates, { classifier });
  assert.equal(classifier.calls.urls.flat().length, 10);
  assert.equal(selection.includedIdx.length, 5);
});

// ── What counts ──────────────────────────────────────────────────────────────

test('only informational pages are kept — location, service, people, news, media and other are not', async () => {
  const candidates = practiceSite();
  const selection = await selectInformationalPages(candidates, {
    classifier: stubClassifier({ templates: PRACTICE_TEMPLATES, urls: PRACTICE_URLS }),
  });
  const kept = includedPaths(candidates, selection);
  assert.equal(kept.length, 12);
  assert.ok(kept.every((p) => p.startsWith('/articles/')));
  const reasons = Object.fromEntries(selection.summary.excludedByReason.map((r) => [r.code, r.count]));
  assert.equal(reasons.location, 20);
  assert.equal(reasons.people, 10);
  assert.equal(reasons.service, 10);

  // Ten per section: fewer than nine siblings stay literal URLs rather than
  // collapsing into a {slug} template (extractTemplates).
  const newsAndMedia = [
    ...range(10, (i) => page(`/newsroom/announcement-${i}`)),
    ...range(10, (i) => page(`/podcast/episode-${i}`)),
    ...range(10, (i) => page(`/help/how-do-i-${i}`)),
  ];
  const second = await selectInformationalPages(newsAndMedia, {
    classifier: stubClassifier({
      templates: { '/newsroom/{slug}': 'news', '/podcast/{slug}': 'media', '/help/{slug}': 'informational' },
    }),
  });
  assert.deepEqual(includedPaths(newsAndMedia, second).map((p) => p.split('/')[1]), Array(10).fill('help'));
});

test('excluded counts add up to everything that was not kept', async () => {
  const candidates = practiceSite();
  const selection = await selectInformationalPages(candidates, {
    classifier: stubClassifier({ templates: PRACTICE_TEMPLATES, urls: PRACTICE_URLS }),
  });
  const total = selection.summary.excludedByReason.reduce((s, r) => s + r.count, 0);
  assert.equal(total, candidates.length - selection.includedIdx.length);
  assert.equal(selection.excluded.length, total);
  assert.equal(selection.summary.crawledPageCount, candidates.length);
  assert.equal(selection.summary.analysedPageCount, selection.includedIdx.length);
});

// ── Listing pages ────────────────────────────────────────────────────────────

test('the index page of an informational section is left out, even if called informational', async () => {
  const candidates = practiceSite();
  const selection = await selectInformationalPages(candidates, {
    classifier: stubClassifier({ templates: PRACTICE_TEMPLATES, urls: { ...PRACTICE_URLS, '/articles': 'informational' } }),
  });
  assert.equal(codeFor(selection, '/articles'), 'listing');
});

test('a small section whose posts stayed literal URLs still has its index dropped', async () => {
  // Three posts: too few to collapse into "/learn/{slug}", so there is no
  // template prefix to go on — the parent rule has to catch it.
  const candidates = [page('/learn'), page('/learn/brushing-basics'), page('/learn/flossing-basics'), page('/learn/mouthwash-guide')];
  const selection = await selectInformationalPages(candidates, {
    classifier: stubClassifier({ urls: () => 'informational' }),
  });
  assert.equal(codeFor(selection, '/learn'), 'listing');
  assert.equal(selection.includedIdx.length, 3);
});

test('a pillar guide with its own sub-guides is kept', async () => {
  const candidates = [page('/dental-implants-guide'), page('/dental-implants-guide/cost'), page('/dental-implants-guide/recovery')];
  const selection = await selectInformationalPages(candidates, {
    classifier: stubClassifier({ urls: () => 'informational' }),
  });
  assert.equal(selection.includedIdx.length, 3, 'no section word, so the parent is a pillar, not a listing');
});

// ── Without the model ────────────────────────────────────────────────────────

test('with no model, the URL rules keep only what they are confident is editorial', async () => {
  const candidates = practiceSite();
  const selection = await selectInformationalPages(candidates, { classifier: null });
  const kept = includedPaths(candidates, selection);
  assert.equal(kept.length, 12);
  assert.ok(kept.every((p) => p.startsWith('/articles/')));
  // /appointments/{slug} is exactly the template the rules used to guess
  // "article" for, from hyphenated slugs. Unconfident guesses no longer count.
  assert.equal(codeFor(selection, '/appointments/city-1'), 'unclassified');
  assert.notEqual(codeFor(selection, '/location-service/city-1-dental-implants'), undefined);
  assert.equal(selection.method, 'rules');
  assert.equal(selection.model, null);
  assert.ok(selection.summary.limitations.some((l) => /AI check was unavailable/.test(l)));
});

test('with no model, a one-off post is judged by its folder, never by its slug', async () => {
  const candidates = [
    page('/blog/why-the-post-office-matters'),
    page('/blog/protecting-financial-services-firms'),
    page('/blog/a-third-article'),
    page('/the-post-human-breach'),
  ];
  const selection = await selectInformationalPages(candidates, { classifier: null });
  const kept = includedPaths(candidates, selection);
  assert.equal(kept.filter((p) => p.startsWith('/blog/')).length, 3, '"services" in a slug no longer makes a blog post a service page');
  assert.ok(!kept.includes('/the-post-human-breach'), 'a top-level page has no folder to vouch for it');
});

test('a failed model batch falls back to the cache first, then the rules, and says so', async () => {
  const candidates = practiceSite();
  const now = Date.parse('2026-09-25T00:00:00Z');
  const cache = {
    version: INFORMATIONAL_SELECTION_VERSION,
    templates: { '/our-dentists/{slug}': { category: 'people', decidedAt: '2026-09-20T00:00:00Z' } },
    urls: {},
  };
  const selection = await selectInformationalPages(candidates, {
    classifier: stubClassifier({ failTemplates: true, urls: PRACTICE_URLS }), cache, now,
  });
  assert.equal(selection.method, 'ai+cache+rules');
  assert.ok(selection.summary.limitations.some((l) => /failed/.test(l) && /upstream 529/.test(l)));
  const templates = Object.fromEntries(selection.summary.templates.map((t) => [t.pattern, t]));
  assert.equal(templates['/our-dentists/{slug}'].source, 'cache');
  assert.equal(templates['/articles/{slug}'].source, 'rules');
  assert.equal(templates['/articles/{slug}'].category, 'informational');
});

// ── Caps, budget and cache ───────────────────────────────────────────────────

test('the URL-check cap spends its checks on the most-linked pages and says what it skipped', async () => {
  const candidates = [
    page('/aa-one-off', { inlinks: 5 }), page('/bb-one-off', { inlinks: 1 }),
    page('/cc-one-off', { inlinks: 9 }), page('/dd-one-off', { inlinks: 3 }),
  ];
  const classifier = stubClassifier({ urls: () => 'informational' });
  const selection = await selectInformationalPages(candidates, { classifier, limits: { maxUrlChecks: 2 } });
  assert.deepEqual(classifier.calls.urls.flat().map((u) => pathOf(u.url)), ['/cc-one-off', '/aa-one-off']);
  assert.equal(codeFor(selection, '/bb-one-off'), 'not_checked');
  assert.equal(codeFor(selection, '/dd-one-off'), 'not_checked');
  assert.ok(selection.summary.limitations.some((l) => /cap/.test(l)));
});

test('cached URLs do not count against the cap', async () => {
  const candidates = [page('/aa-one-off', { inlinks: 5 }), page('/cc-one-off', { inlinks: 9 }), page('/dd-one-off', { inlinks: 3 })];
  const now = Date.parse('2026-09-25T00:00:00Z');
  const cache = {
    version: INFORMATIONAL_SELECTION_VERSION,
    templates: {},
    urls: { [pageKey(`${ORIGIN}/cc-one-off`)]: { category: 'informational', decidedAt: '2026-09-01T00:00:00Z' } },
  };
  const classifier = stubClassifier({ urls: () => 'informational' });
  await selectInformationalPages(candidates, { classifier, cache, now, limits: { maxUrlChecks: 2 } });
  assert.deepEqual(classifier.calls.urls.flat().map((u) => pathOf(u.url)), ['/aa-one-off', '/dd-one-off']);
});

test('past the time budget, nothing new is asked and the rules decide', async () => {
  const candidates = practiceSite();
  const selection = await selectInformationalPages(candidates, {
    classifier: stubClassifier({ templates: PRACTICE_TEMPLATES, urls: PRACTICE_URLS }),
    limits: { budgetMs: -1 },
  });
  assert.ok(selection.summary.limitations.some((l) => /ran out of its/.test(l)));
  assert.equal(includedPaths(candidates, selection).length, 12);
});

test('cached verdicts are reused while fresh, and only model verdicts are cached', async () => {
  const candidates = practiceSite();
  const first = await selectInformationalPages(candidates, {
    classifier: stubClassifier({ templates: PRACTICE_TEMPLATES, urls: PRACTICE_URLS }),
  });
  assert.equal(first.verdicts.version, INFORMATIONAL_SELECTION_VERSION);
  assert.equal(first.verdicts.templates['/articles/{slug}'].category, 'informational');

  // Second run, same structure: nothing to ask.
  const again = stubClassifier({ templates: PRACTICE_TEMPLATES, urls: PRACTICE_URLS });
  const second = await selectInformationalPages(candidates, { classifier: again, cache: first.verdicts });
  assert.equal(again.calls.templates.length, 0);
  assert.equal(again.calls.urls.length, 0);
  assert.deepEqual(second.includedIdx, first.includedIdx);
  assert.equal(second.method, 'cache');

  // A verdict older than the TTL is asked again.
  const later = Date.now() + 200 * 24 * 60 * 60 * 1000;
  const stale = stubClassifier({ templates: PRACTICE_TEMPLATES, urls: PRACTICE_URLS });
  await selectInformationalPages(candidates, { classifier: stale, cache: first.verdicts, now: later });
  assert.ok(stale.calls.templates.length > 0);

  // A cache from another selection version describes another definition.
  const otherVersion = stubClassifier({ templates: PRACTICE_TEMPLATES, urls: PRACTICE_URLS });
  await selectInformationalPages(candidates, {
    classifier: otherVersion, cache: { ...first.verdicts, version: INFORMATIONAL_SELECTION_VERSION + 1 },
  });
  assert.ok(otherVersion.calls.templates.length > 0);

  // Rules decide nothing that is worth remembering.
  const rulesOnly = await selectInformationalPages(candidates, { classifier: null });
  assert.deepEqual(rulesOnly.verdicts.templates, {});
  assert.deepEqual(rulesOnly.verdicts.urls, {});
});

// ── Stability ────────────────────────────────────────────────────────────────

test('the same pages in a different order give the same answer', async () => {
  const candidates = practiceSite();
  const shuffled = [...candidates].reverse();
  const classifierFor = () => stubClassifier({ templates: PRACTICE_TEMPLATES, urls: PRACTICE_URLS });
  const a = await selectInformationalPages(candidates, { classifier: classifierFor() });
  const b = await selectInformationalPages(shuffled, { classifier: classifierFor() });
  assert.deepEqual(includedPaths(candidates, a).sort(), includedPaths(shuffled, b).sort());
  const codes = (sel) => Object.fromEntries(sel.excluded.map((e) => [e.url, e.code]));
  assert.deepEqual(codes(a), codes(b));
});

test('a crawl spanning two hosts keeps their sections apart', async () => {
  const candidates = [
    ...range(4, (i) => ({ ...page(`/blog/post-${i}`), url: `https://blog.example-dental.com/blog/post-${i}` })),
    ...range(4, (i) => ({ ...page(`/blog/post-${i}`), url: `https://shop.example-dental.com/blog/post-${i}` })),
  ];
  const classifier = stubClassifier({ templates: () => 'informational', urls: () => 'informational' });
  await selectInformationalPages(candidates, { classifier });
  const keys = [...classifier.calls.templates.flat(), ...classifier.calls.urls.flat()].map((t) => t.key);
  assert.ok(keys.some((k) => k.startsWith('blog.example-dental.com')));
  assert.ok(keys.some((k) => k.startsWith('shop.example-dental.com')));
});

// ── How the export describes it ──────────────────────────────────────────────

test('the export narrative says the pages are informational, and where the rest went', () => {
  const { buildNarrative } = require('../exporter');
  const base = {
    pages: Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, flags: [] })),
    clusters: [{ spokeIds: ['p1', 'p2'], hubPageId: 'p0', isGap: false, health: 60 }],
    unassignedPages: [{ id: 'p3' }],
    excludedUrls: [{ url: 'https://x.test/locations/a', reason: 'Location page' }],
    crawlMeta: { sampled: false },
  };
  const scoped = buildNarrative({ ...base, selection: { summary: { crawledPageCount: 5 } } }, { domain: 'x.test' });
  assert.match(scoped, /4 informational pages \(articles, guides, FAQs\) out of the 5 found in its sitemaps and informational listings/);
  assert.match(scoped, /left out of hub and spoke by design/);

  const standalone = buildNarrative(base, { domain: 'x.test' });
  assert.match(standalone, /4 confirmed pages/);
  assert.doesNotMatch(standalone, /informational/);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

test('helpers: page keys, example spread, section prefixes and folders', () => {
  assert.equal(pageKey('https://www.X.com/A/b/'), pageKey('http://x.com/a/b'));
  assert.notEqual(pageKey('https://x.com/a?p=1'), pageKey('https://x.com/a'));
  const urls = range(20, (i) => `https://x.com/p/${String(i).padStart(2, '0')}`);
  const spread = spreadExamples(urls, 8);
  assert.equal(spread.length, 8);
  assert.equal(spread[0], urls[0]);
  assert.equal(spread.at(-1), urls.at(-1));
  assert.equal(literalPrefix('/articles/{slug}'), '/articles');
  assert.equal(literalPrefix('/blog/{date}/{slug}'), '/blog');
  assert.equal(literalPrefix('/{slug}'), null);
  assert.equal(folderPatternOf('https://x.com/blog/a-post'), '/blog/{slug}');
  assert.equal(folderPatternOf('https://x.com/a-post'), null);
});
