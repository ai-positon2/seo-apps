// ── Where hub and spoke finds its pages ─────────────────────────────────────
//
// informationalDiscovery.js finds candidate pages from a site's sitemaps and
// from the listing pages its menus label as informational, walked through their
// pagination. Every fetcher is injected, so these run with no network.
//
// Run: node modules/contentArchitect/__tests__/informationalDiscovery.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const d = require('../informationalDiscovery');

const ORIGIN = 'https://www.example-dental.com';
const html = (body) => `<!doctype html><html><body>${body}</body></html>`;
const header = `<header><nav>
  <a href="/services">Services</a><a href="/locations">Locations</a>
  <a href="/blog">Blog</a><a href="/patient-resources">Patient Resources</a><a href="/contact">Contact</a>
</nav></header>`;
const footer = '<footer><a href="/privacy-policy">Privacy</a><a href="/faq">FAQ</a><a href="https://other.com/x">Partner</a></footer>';

test('menu links are read from the header and the footer, own site only', () => {
  const links = d.extractMenuLinks(html(`${header}<main><a href="/in-body">Body link</a></main>${footer}`), ORIGIN);
  const byArea = (area) => links.filter((l) => l.area === area).map((l) => new URL(l.url).pathname);
  assert.deepEqual(byArea('header'), ['/services', '/locations', '/blog', '/patient-resources', '/contact']);
  assert.deepEqual(byArea('footer'), ['/privacy-policy', '/faq']);
});

test('only menu links that name an informational section are kept, header first', () => {
  const links = d.extractMenuLinks(html(`${header}${footer}`), ORIGIN);
  const info = d.informationalMenuLinks(links).map((l) => new URL(l.url).pathname);
  assert.deepEqual(info, ['/blog', '/patient-resources', '/faq']);
  // News is never walked: it is excluded from hub and spoke anyway.
  const news = d.informationalMenuLinks([{ url: `${ORIGIN}/news`, label: 'News', area: 'header' }]);
  assert.equal(news.length, 0);
});

test('a featured article in the menu is not walked as a section', () => {
  // Seen live: a header linking "How to Build an Audience From Scratch In 2026".
  const links = [
    { url: `${ORIGIN}/blog/`, label: 'Blog', area: 'header' },
    { url: `${ORIGIN}/how-to-build-an-audience-from-scratch/`, label: 'How to Build an Audience From Scratch In 2026', area: 'header' },
    { url: `${ORIGIN}/help-center`, label: 'Support', area: 'footer' },
  ];
  assert.deepEqual(d.informationalMenuLinks(links).map((l) => new URL(l.url).pathname), ['/blog/', '/help-center']);
});

test('a listing page gives its content links, not its menus or itself', () => {
  const page = html(`${header}
    <main>
      <article><a href="/why-we-floss">Why we floss</a></article>
      <article><a href="/what-is-a-crown/">What is a crown</a></article>
      <a href="/blog">All posts</a><a href="/logo.png">Logo</a>
    </main>
    <aside><a href="/sidebar-post">Popular</a></aside>${footer}`);
  const links = d.listingContentLinks(page, `${ORIGIN}/blog`).map((u) => new URL(u).pathname);
  assert.deepEqual(links.sort(), ['/what-is-a-crown/', '/why-we-floss']);
});

test('the next page is found from rel=next, from "Next" text, and from page-number shapes', () => {
  const blog = `${ORIGIN}/blog`;
  assert.equal(d.nextPageUrl(`<link rel="next" href="/blog/page/2">`, blog, blog, 1), `${ORIGIN}/blog/page/2`);
  assert.equal(d.nextPageUrl(html('<a href="/blog?page=2">Next</a>'), blog, blog, 1), `${ORIGIN}/blog?page=2`);
  assert.equal(d.nextPageUrl(html('<a href="/blog/3">3</a><a href="/blog/2">2</a>'), blog, blog, 1), `${ORIGIN}/blog/2`);
  assert.equal(d.nextPageUrl(html('<a href="/blog/page-3">3</a>'), `${ORIGIN}/blog/page-2`, blog, 2), `${ORIGIN}/blog/page-3`);
  assert.equal(d.nextPageUrl(html('<a href="/blog?paged=4">4</a>'), `${ORIGIN}/blog?paged=3`, blog, 3), `${ORIGIN}/blog?paged=4`);
  assert.equal(d.nextPageUrl(html('<a aria-label="Next page" href="/blog/page/2">›</a>'), blog, blog, 1), `${ORIGIN}/blog/page/2`);
  assert.equal(d.nextPageUrl(html('<a href="/other/2">2</a>'), blog, blog, 1), null, 'another section\'s page 2 is not ours');
});

// A three-page blog whose posts live at the site root.
function blogSite() {
  const pages = {
    [`${ORIGIN}/blog`]: html(`${header}<main><a href="/post-a">A</a><a href="/post-b">B</a><a href="/blog/page/2">Next</a></main>`),
    [`${ORIGIN}/blog/page/2`]: html(`<main><a href="/post-c">C</a><a href="/post-d">D</a><a href="/blog/page/3" rel="next">Next</a></main>`),
    [`${ORIGIN}/blog/page/3`]: html('<main><a href="/post-e">E</a></main>'),
  };
  const fetched = [];
  const fetchHtml = async (url) => {
    fetched.push(url);
    if (!(url in pages)) throw new Error('404');
    return pages[url];
  };
  return { fetchHtml, fetched };
}

test('a listing is walked through every page of its pagination', async () => {
  const { fetchHtml, fetched } = blogSite();
  const walk = await d.walkListing({ url: `${ORIGIN}/blog`, label: 'Blog' }, { fetchHtml, delayMs: 0 });
  assert.equal(walk.pagesWalked, 3);
  assert.deepEqual(walk.found.map((u) => new URL(u).pathname).sort(), ['/post-a', '/post-b', '/post-c', '/post-d', '/post-e']);
  assert.equal(walk.stoppedBecause, 'last page reached');
  assert.deepEqual(fetched, [`${ORIGIN}/blog`, `${ORIGIN}/blog/page/2`, `${ORIGIN}/blog/page/3`]);
  assert.ok(walk.edges.some((e) => e.from_url === `${ORIGIN}/blog/page/2` && e.to_url.endsWith('/post-c')));
});

test('a walk stops at its page limit, on a loop, on robots.txt, and says why', async () => {
  const { fetchHtml } = blogSite();
  const capped = await d.walkListing({ url: `${ORIGIN}/blog` }, { fetchHtml, maxPages: 2, delayMs: 0 });
  assert.equal(capped.pagesWalked, 2);
  assert.match(capped.stoppedBecause, /2-page limit/);

  const loop = await d.walkListing({ url: `${ORIGIN}/blog` }, {
    fetchHtml: async () => html('<main><a href="/x">x</a><a href="/blog" rel="next">Next</a></main>'), delayMs: 0,
  });
  assert.equal(loop.pagesWalked, 1);

  const blocked = await d.walkListing({ url: `${ORIGIN}/blog` }, { fetchHtml, allowed: () => false, delayMs: 0 });
  assert.equal(blocked.pagesWalked, 0);
  assert.match(blocked.stoppedBecause, /robots/);

  const loadMore = await d.walkListing({ url: `${ORIGIN}/blog` }, {
    fetchHtml: async () => html('<main><a href="/p1">p1</a><button>Load more</button></main>'), delayMs: 0,
  });
  assert.match(loadMore.stoppedBecause, /JavaScript/);
});

test('candidates come from the sitemap and the menu listings, and nothing else', async () => {
  const { fetchHtml } = blogSite();
  const home = html(`${header}<main><a href="/some-unlisted-page">Deep link</a></main>${footer}`);
  const result = await d.discoverInformationalCandidates(ORIGIN, {
    sitemapDiscover: async () => ({ mode: 'sitemap', source: `${ORIGIN}/sitemap.xml`, urls: [{ url: `${ORIGIN}/services/implants` }, { url: `${ORIGIN}/post-a` }] }),
    fetchHtml: async (url) => {
      if (url === `${ORIGIN}/robots.txt`) return 'User-agent: *\nDisallow: /private';
      if (url === ORIGIN) return home;
      return fetchHtml(url);
    },
    listingDelayMs: 0,
  });
  const paths = result.candidates.map((c) => new URL(c.url).pathname).sort();
  assert.ok(paths.includes('/services/implants') && paths.includes('/post-e'));
  assert.ok(!paths.includes('/some-unlisted-page'), 'a homepage body link is not followed');
  const a = result.candidates.find((c) => c.url.endsWith('/post-a'));
  assert.deepEqual(a.sources.sort(), ['listing', 'sitemap']);
  assert.equal(result.sitemap.count, 2);
  assert.deepEqual(result.hints.map((h) => h.path), ['/blog', '/patient-resources', '/faq']);
  assert.equal(result.listings.find((l) => l.url === `${ORIGIN}/blog`).pagesWalked, 3);
});

test('with no sitemap, the menus and their listings are the only source, and it says so', async () => {
  const { fetchHtml } = blogSite();
  const result = await d.discoverInformationalCandidates(ORIGIN, {
    sitemapDiscover: async () => ({ mode: 'not-found', urls: [] }),
    fetchHtml: async (url) => (url === ORIGIN ? html(header) : fetchHtml(url)),
    listingDelayMs: 0,
  });
  assert.equal(result.sitemap.count, 0);
  assert.ok(result.candidates.some((c) => c.url.endsWith('/post-e')));
  assert.ok(result.limitations.some((l) => /No usable sitemap/.test(l)));
});

test('a homepage with no marked-up menus has its own links read as navigation, image maps included', async () => {
  // One real essay site: table layout, and the only menu an image map.
  const home = html('<map name="nav"><area shape="rect" coords="0,0,1,1" href="articles.html"><area href="books.html"></map><table><tr><td><a href="index.html">Home</a></td></tr></table>');
  const links = d.extractMenuLinks(home, `${ORIGIN}/`);
  assert.ok(links.some((l) => l.url.endsWith('/articles.html') && l.area === 'page'));
  const info = d.informationalMenuLinks(links).map((l) => new URL(l.url).pathname);
  assert.deepEqual(info, ['/articles.html']);
  const result = await d.discoverInformationalCandidates(ORIGIN, {
    sitemapDiscover: async () => ({ mode: 'not-found', urls: [] }),
    fetchHtml: async (url) => {
      if (url === ORIGIN) return home;
      if (url.endsWith('/articles.html')) return html('<a href="essay-one.html">One</a><a href="essay-two.html">Two</a>');
      throw new Error('404');
    },
    listingDelayMs: 0,
  });
  assert.ok(result.candidates.some((c) => c.url.endsWith('/essay-two.html')));
  assert.ok(result.limitations.some((l) => /no marked-up header or footer/.test(l)));
});

test('menus the homepage HTML does not contain are reported, not guessed at', async () => {
  const result = await d.discoverInformationalCandidates(ORIGIN, {
    sitemapDiscover: async () => ({ mode: 'sitemap', urls: [{ url: `${ORIGIN}/post-a` }] }),
    fetchHtml: async (url) => (url === ORIGIN ? html('<div id="app"></div>') : Promise.reject(new Error('404'))),
    listingDelayMs: 0,
  });
  assert.equal(result.listings.length, 0);
  assert.ok(result.limitations.some((l) => /JavaScript cannot be read/.test(l)));
});

// ── Redirects are followed to the page a listed URL lands on ────────────────

test('a listed URL that redirects is read at the page it lands on', async () => {
  // Measured: a sitemap listing every article without its trailing slash made
  // all 800 fetched pages "redirects", and nothing was analysed.
  const { fetchFollowingRedirects } = require('../../projects/crawlToArchitect');
  const passes = [];
  const fetch = async (urls) => {
    passes.push(urls);
    return {
      results: urls.map((url) => (url.endsWith('/')
        ? { url, status: 200, title: 'Final' }
        : { url, status: 301, redirectUrl: `${url}/` })),
      linkEdges: [],
    };
  };
  const out = await fetchFollowingRedirects([`${ORIGIN}/a`, `${ORIGIN}/b/`], fetch, ORIGIN);
  assert.equal(passes.length, 2, 'one extra pass for the redirect targets');
  assert.deepEqual(passes[1], [`${ORIGIN}/a/`]);
  assert.equal(out.redirected, 1);
  assert.equal(out.byKey.size, 2);
  assert.ok([...out.byKey.values()].every((r) => r.status === 200));
});

// ── buildFromDiscovery, end to end with a stub database ─────────────────────

test('buildFromDiscovery reads only the informational pages and keeps the crawl\'s link graph', async () => {
  const stubDb = {
    isDatabaseConfigured: () => true,
    async rows(sql, params) {
      const lastId = params[params.length - 2];
      const limit = params[params.length - 1];
      const source = /crawl_run_links/.test(sql) ? this.links : this.results;
      return source.filter((r) => r.id > lastId).slice(0, limit);
    },
    results: [
      { id: 1, url: `${ORIGIN}/`, status: 200, data: { url: `${ORIGIN}/`, scope: 'Internal', status: 200, depth: 0 } },
      { id: 2, url: `${ORIGIN}/services/implants`, status: 200, data: { url: `${ORIGIN}/services/implants`, scope: 'Internal', status: 200, depth: 1 } },
    ],
    links: [{ id: 3, from_url: `${ORIGIN}/services/implants`, to_url: `${ORIGIN}/post-1` }],
  };
  const dbPath = require.resolve('../../../services/db');
  const saved = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stubDb };
  delete require.cache[require.resolve('../../projects/crawlToArchitect')];
  const c2a = require('../../projects/crawlToArchitect');
  try {
    const posts = Array.from({ length: 6 }, (_, i) => `${ORIGIN}/post-${i + 1}`);
    let fetchedUrls = null;
    const input = await c2a.buildFromDiscovery('run-1', {
      origin: ORIGIN,
      classifier: {
        model: 'stub',
        classifyTemplates: async (items) => ({ verdicts: new Map(items.map((t) => [t.key, 'service'])), failedKeys: new Set(), skippedKeys: new Set() }),
        classifyUrls: async (items) => ({
          verdicts: new Map(items.map((t) => [t.key, /post-/.test(t.url) ? 'informational' : 'listing'])),
          failedKeys: new Set(),
          skippedKeys: new Set(),
        }),
      },
      discover: async () => ({
        candidates: [...posts, `${ORIGIN}/blog`, `${ORIGIN}/services/implants`].map((url) => ({ url, sources: ['sitemap'] })),
        sitemap: { mode: 'sitemap', count: 8 },
        menu: { header: 3, footer: 2, informational: [] },
        listings: [{ url: `${ORIGIN}/blog`, label: 'Blog', pagesWalked: 1, found: 6, stoppedBecause: 'last page reached' }],
        listingEdges: posts.map((to) => ({ from_url: `${ORIGIN}/blog`, to_url: to })),
        hints: [{ label: 'Blog', path: '/blog' }],
        limitations: [],
      }),
      fetch: async (urls) => {
        fetchedUrls = urls;
        return {
          results: urls.map((url, i) => ({
            url, status: i === 5 ? 404 : 200, contentType: 'text/html', indexability: 'Indexable',
            canonical: url, title: `Post ${i}`, h1: `Post ${i}`, words: 900,
          })),
          linkEdges: [],
        };
      },
    });
    assert.deepEqual(fetchedUrls.sort(), [...posts].sort(), 'only the informational candidates are fetched');
    assert.equal(input.meta.pageCount, 5, 'the page that returned 404 is left out');
    assert.equal(input.meta.crawledPageCount, 8, 'counted against what discovery found');
    assert.ok(input.crawlResult.excluded.some((e) => e.code === 'fetch_failed'));
    const first = input.crawlResult.pages.findIndex((p) => p.url.endsWith('/post-1'));
    assert.ok(input.linkGraph.inboundCounts[first] >= 2, 'linked from a crawled service page and from the blog listing');
    assert.ok(input.limitations[0].includes('found in its sitemaps and informational listings'));
    assert.equal(input.crawlResult.selection.summary.discovery.candidates, 8);
    assert.ok(input.linkGraph.depths.every((dep) => dep === Infinity), 'no click depth is claimed for pages the crawl never reached');
  } finally {
    if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
  }
});

// ── 10-site review, 2026-09-29 ──────────────────────────────────────────────

test('a section is named by its label, not by a word inside a product name or a button', () => {
  const O = 'https://zapier.example';
  const links = [
    // Seen live: an integration page walked as the "Help" section.
    { url: `${O}/apps/help-scout/integrations`, label: 'Help Scout', area: 'header' },
    // HubSpot and Moz: product pages behind "Learn more" buttons.
    { url: `${O}/products/crm/ai-crm`, label: 'Learn more', area: 'header' },
    // Single articles, matched by their slug's last word.
    { url: `${O}/blog/zapier-copilot-guide/`, label: 'Zapier Copilot A personalized automation assistant', area: 'header' },
    { url: `${O}/pie-baking-guide`, label: 'Pie season', area: 'header' },
    { url: `${O}/blog/get-started-with-zapier/`, label: 'Zapier quick-start guide', area: 'header' },
    { url: `${O}/apps/categories/it-operations-education`, label: 'Online Courses', area: 'header' },
    // Real sections, named or pathed as one.
    { url: `${O}/patient-resources`, label: 'Patient Resources', area: 'header' },
    { url: `${O}/training`, label: 'Moz Academy', area: 'header' },
    { url: `${O}/pro/reference`, label: 'Resources & Reference', area: 'footer' },
    { url: `${O}/blog/category/product-blog/`, label: 'What’s new?', area: 'header' },
  ];
  assert.deepEqual(
    d.informationalMenuLinks(links).map((l) => new URL(l.url).pathname),
    ['/patient-resources', '/training', '/blog/category/product-blog/', '/pro/reference'],
  );
});

test('a mega-menu link is named by its first line, not its name and strapline run together', () => {
  const O = 'https://zapier.example';
  const menu = html('<header><nav><a href="/resources/guides"><span>Guides</span><span>Go deep with dedicated guidance</span></a>'
    + '<a href="/pricing"><span>Pricing</span><span>Plans that help you grow</span></a></nav></header>');
  const links = d.extractMenuLinks(menu, O);
  assert.equal(links[0].label, 'Guides Go deep with dedicated guidance');
  assert.equal(links[0].firstText, 'Guides');
  assert.deepEqual(d.informationalMenuLinks(links).map((l) => new URL(l.url).pathname), ['/resources/guides']);
});

test("a section's own sitemap is read when the root sitemap does not list it", async () => {
  const probed = [];
  const result = await d.discoverInformationalCandidates(ORIGIN, {
    sitemapDiscover: async () => ({ mode: 'sitemap', source: `${ORIGIN}/sitemap.xml`, urls: [{ url: `${ORIGIN}/services/implants` }] }),
    sectionSitemap: async (url) => {
      probed.push(new URL(url).pathname);
      return url.endsWith('/blog/sitemap_index.xml')
        ? { urls: [{ url: `${ORIGIN}/blog/deep-post`, lastmod: '2026-09-01' }] }
        : null;
    },
    fetchHtml: async (url) => {
      if (url === ORIGIN) return html(header);
      if (url.endsWith('/robots.txt')) return '';
      return html('<main></main>');
    },
    listingDelayMs: 0,
  });
  assert.ok(probed.includes('/blog/sitemap.xml') && probed.includes('/blog/sitemap_index.xml'));
  const deep = result.candidates.find((c) => c.url.endsWith('/blog/deep-post'));
  assert.deepEqual(deep.sources, ['sitemap']);
  assert.equal(deep.lastmod, '2026-09-01');
  assert.ok(result.limitations.some((l) => /only in \/blog\/sitemap_index\.xml/.test(l)));
});

test('a site that refuses every request is reported as blocking, not as having no sitemap', async () => {
  const refuse = async () => { throw Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } }); };
  const result = await d.discoverInformationalCandidates(ORIGIN, {
    sitemapDiscover: async () => ({ mode: 'not-found', urls: [] }),
    fetchHtml: refuse,
    listingDelayMs: 0,
  });
  assert.equal(result.blocked.status, 403);
  assert.ok(!result.limitations.some((l) => /JavaScript cannot be read/.test(l)), 'no guess about JavaScript menus');

  const open = await d.discoverInformationalCandidates(ORIGIN, {
    sitemapDiscover: async () => ({ mode: 'not-found', urls: [] }),
    fetchHtml: async () => html('<div></div>'),
    listingDelayMs: 0,
  });
  assert.equal(open.blocked, null);
});

test("robots.txt's Crawl-delay paces the listing walk, and the walk stops at its time limit", async () => {
  assert.equal(d.robotsCheck('User-agent: *\nCrawl-delay: 10\n').crawlDelayMs, 10000);
  assert.equal(d.robotsCheck('User-agent: *\nDisallow:\n').crawlDelayMs, 0);

  const { fetchHtml } = blogSite();
  const walk = await d.walkListing({ url: `${ORIGIN}/blog` }, { fetchHtml, delayMs: 50, deadline: Date.now() + 20 });
  assert.equal(walk.pagesWalked, 1, 'the first page is read; the next would pass the deadline');
  assert.equal(walk.stoppedBecause, 'stopped at the time limit');

  const politeSite = {
    sitemapDiscover: async () => ({ mode: 'sitemap', urls: [{ url: `${ORIGIN}/post-a` }] }),
    fetchHtml: async (url) => (url.endsWith('/robots.txt') ? 'User-agent: *\nCrawl-delay: 5\n' : html('<main></main>')),
    listingDelayMs: 0,
  };
  const result = await d.discoverInformationalCandidates(ORIGIN, { ...politeSite, honourCrawlDelay: true });
  assert.equal(result.crawlDelayMs, 5000);
  assert.ok(result.limitations.some((l) => /5 second\(s\) between requests/.test(l)));

  // Off by default (config DISCOVERY_HONOUR_CRAWL_DELAY): the old pace, no delay.
  const fast = await d.discoverInformationalCandidates(ORIGIN, politeSite);
  assert.equal(fast.crawlDelayMs, 0);
});

test('under the read limit, every section is represented, newest first — not the alphabetical head', () => {
  const { readOrder, readSectionOf } = require('../../projects/crawlToArchitect');
  assert.equal(readSectionOf(`${ORIGIN}/blog/2015/02/13/post`), '/blog');
  assert.equal(readSectionOf(`${ORIGIN}/health/diseases/flu`), '/health/diseases');
  assert.equal(readSectionOf(`${ORIGIN}/top-level-post`), '/');

  // Measured: a health library's 800 reads were all "/departments/…". Shares
  // follow each section's size, so the sample looks like the site.
  const pages = [
    ...Array.from({ length: 50 }, (_, i) => ({ url: `${ORIGIN}/departments/heart/p${i}`, inlinks: 0 })),
    ...Array.from({ length: 300 }, (_, i) => ({ url: `${ORIGIN}/health/diseases/d${i}`, inlinks: 0 })),
    ...Array.from({ length: 300 }, (_, i) => ({ url: `${ORIGIN}/health/drugs/x${i}`, inlinks: 0 })),
  ];
  const read = readOrder(pages, { limit: 130 }).slice(0, 130);
  const count = (s) => read.filter((p) => p.url.includes(s)).length;
  assert.deepEqual([count('/departments/'), count('/diseases/'), count('/drugs/')], [10, 60, 60]);

  // Within a section, the most recently modified come first; the site's own
  // listing comes before everything.
  const dated = [
    { url: `${ORIGIN}/blog/2008/01/01/old`, inlinks: 0, lastmod: '2008-01-01' },
    { url: `${ORIGIN}/blog/2026/09/01/new`, inlinks: 0, lastmod: '2026-09-01' },
    { url: `${ORIGIN}/blog/2012/01/01/listed`, inlinks: 0, lastmod: '2012-01-01' },
  ];
  const { pageKey } = require('../informationalSelection');
  const listed = new Set([pageKey(`${ORIGIN}/blog/2012/01/01/listed`)]);
  assert.deepEqual(readOrder(dated, { limit: 2, listed }).map((p) => p.url.split('/').pop()), ['listed', 'new', 'old']);
});

async function withStubDb(fn) {
  const stubDb = {
    isDatabaseConfigured: () => true,
    async rows(sql, params) {
      const lastId = params[params.length - 2];
      const limit = params[params.length - 1];
      const source = /crawl_run_links/.test(sql) ? this.links : this.results;
      return source.filter((r) => r.id > lastId).slice(0, limit);
    },
    results: [{ id: 1, url: `${ORIGIN}/`, status: 200, data: { url: `${ORIGIN}/`, scope: 'Internal', status: 200, depth: 0 } }],
    links: [],
  };
  const dbPath = require.resolve('../../../services/db');
  const c2aPath = require.resolve('../../projects/crawlToArchitect');
  const saved = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stubDb };
  delete require.cache[c2aPath];
  try {
    return await fn(require('../../projects/crawlToArchitect'), stubDb);
  } finally {
    if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
    delete require.cache[c2aPath];
  }
}

const discovered = (urls, extra = {}) => async () => ({
  candidates: urls.map((url) => ({ url, sources: ['sitemap'] })),
  sitemap: { mode: 'sitemap', count: urls.length },
  menu: { header: 1, footer: 0, informational: [] },
  listings: [],
  listingEdges: [],
  hints: [],
  limitations: [],
  ...extra,
});
const pageResult = (url, extra = {}) => ({
  url, status: 200, contentType: 'text/html', indexability: 'Indexable', canonical: url, title: url, h1: url, words: 900, ...extra,
});
const allInformational = (urlVerdict = () => 'informational') => ({
  model: 'stub',
  classifyTemplates: async (items) => ({ verdicts: new Map(items.map((t) => [t.key, 'informational'])), failedKeys: new Set(), skippedKeys: new Set() }),
  classifyUrls: async (items) => ({ verdicts: new Map(items.map((t) => [t.key, urlVerdict(t.url)])), failedKeys: new Set(), skippedKeys: new Set() }),
});

test('a URL that redirects to a page judged non-informational is left out, with the reason', async () => {
  // Seen live: FAQ URLs that 301 to a service page's #faq anchor.
  await withStubDb(async (c2a) => {
    const posts = Array.from({ length: 6 }, (_, i) => `${ORIGIN}/patient-resources/faq/topic-${i}-faq`);
    const input = await c2a.buildFromDiscovery('run-1', {
      origin: ORIGIN,
      classifier: allInformational((url) => (/dental-implants/.test(url) ? 'service' : 'informational')),
      discover: discovered(posts),
      fetch: async (urls) => ({
        results: urls.map((url) => (url.endsWith('topic-0-faq')
          ? { url, status: 301, redirectUrl: `${ORIGIN}/dental-implants/#implantsfaq` }
          : pageResult(url))),
        linkEdges: [],
      }),
    });
    const red = input.crawlResult.excluded.find((e) => e.url.endsWith('topic-0-faq'));
    assert.equal(red.code, 'redirected');
    assert.match(red.detail, /dental-implants/);
    assert.ok(!input.crawlResult.pages.some((p) => p.url.includes('/dental-implants')), 'the service page is not analysed');
    assert.equal(input.meta.pageCount, 5);
  });
});

test('the listing pages discovery walked are never analysed as articles', async () => {
  await withStubDb(async (c2a) => {
    const posts = Array.from({ length: 6 }, (_, i) => `${ORIGIN}/dental-care-resources/post-${i}`);
    let fetchedUrls = [];
    const input = await c2a.buildFromDiscovery('run-1', {
      origin: ORIGIN,
      classifier: allInformational(),
      discover: discovered([`${ORIGIN}/dental-care-resources/`, ...posts], {
        listings: [{ url: `${ORIGIN}/dental-care-resources/`, pagesWalked: 1, found: 6 }],
        listingPages: [`${ORIGIN}/dental-care-resources/`],
      }),
      fetch: async (urls) => { fetchedUrls = urls; return { results: urls.map((u) => pageResult(u)), linkEdges: [] }; },
    });
    assert.equal(fetchedUrls.length, 6);
    assert.ok(!fetchedUrls.some((u) => u.endsWith('/dental-care-resources/')));
    assert.equal(input.crawlResult.excluded.find((e) => e.url.endsWith('/dental-care-resources/')).code, 'listing');
  });
});

test('a robots.txt Crawl-delay paces the page reads and shrinks the read to the time budget', async () => {
  await withStubDb(async (c2a) => {
    const posts = Array.from({ length: 200 }, (_, i) => `${ORIGIN}/resources/post-${i}`);
    const calls = [];
    const input = await c2a.buildFromDiscovery('run-1', {
      origin: ORIGIN,
      classifier: allInformational(),
      discover: discovered(posts, { crawlDelayMs: 10000 }),
      fetch: async (urls, opts) => { calls.push({ n: urls.length, opts }); return { results: urls.map((u) => pageResult(u)), linkEdges: [] }; },
    });
    const { DISCOVERY_FETCH_BUDGET_MS } = require('../config');
    assert.equal(calls[0].n, Math.floor(DISCOVERY_FETCH_BUDGET_MS / 10000));
    assert.deepEqual(calls[0].opts, { crawlerOptions: { perHostDelay: 10000, concurrency: 1 } });
    assert.ok(input.limitations.some((l) => /10 second\(s\) between requests/.test(l)));
  });
});

test('pages about to be read from a large informational template are checked one by one first', async () => {
  // Seen live: a SaaS blog judged informational as a whole, whose customer
  // stories and award posts were then clustered.
  await withStubDb(async (c2a) => {
    const posts = Array.from({ length: 30 }, (_, i) => `${ORIGIN}/blog/how-to-automate-thing-${i}`);
    const stories = [`${ORIGIN}/blog/customer-story-acme`, `${ORIGIN}/blog/award-winners-june`];
    const asked = [];
    let fetchedUrls = [];
    const input = await c2a.buildFromDiscovery('run-1', {
      origin: ORIGIN,
      classifier: {
        model: 'stub',
        classifyTemplates: async (items) => ({ verdicts: new Map(items.map((t) => [t.key, 'informational'])), failedKeys: new Set(), skippedKeys: new Set() }),
        classifyUrls: async (items) => {
          asked.push(...items.map((t) => t.url));
          return {
            verdicts: new Map(items.map((t) => [t.key, /customer-story/.test(t.url) ? 'other' : /award/.test(t.url) ? 'news' : 'informational'])),
            failedKeys: new Set(),
            skippedKeys: new Set(),
          };
        },
      },
      discover: discovered([...posts, ...stories]),
      maxFetch: 20,
      // Selection's own URL checks used up (as on a large site), so the check
      // happens just before reading.
      selectionLimits: { maxUrlChecks: 0 },
      fetch: async (urls) => { fetchedUrls = urls; return { results: urls.map((u) => pageResult(u)), linkEdges: [] }; },
    });
    assert.ok(!fetchedUrls.some((u) => /customer-story|award/.test(u)), 'neither is read');
    assert.equal(fetchedUrls.length, 20, 'the next pages in line take their places');
    assert.ok(asked.length <= 22 && asked.length >= 20, `only pages about to be read are checked (${asked.length})`);
    assert.equal(input.crawlResult.excluded.find((e) => e.url.endsWith('customer-story-acme')).detail, 'Checked page by page before reading');
    assert.equal(input.crawlResult.excluded.find((e) => e.url.endsWith('customer-story-acme')).code, 'other');
    assert.equal(input.crawlResult.excluded.find((e) => e.url.endsWith('award-winners-june')).code, 'news');
  });
});

test('a site that refuses every request is marked blocked', async () => {
  await withStubDb(async (c2a, db) => {
    db.results = [{ id: 1, url: `${ORIGIN}/`, status: 403, data: { url: `${ORIGIN}/`, scope: 'Internal', status: 403 } }];
    const input = await c2a.buildFromDiscovery('run-1', {
      origin: ORIGIN, classifier: null, discover: discovered([]), fetch: async () => ({ results: [], linkEdges: [] }),
    });
    assert.equal(input.tooFewInformational, true);
    assert.equal(input.meta.blocked.status, 403);
  });
});
