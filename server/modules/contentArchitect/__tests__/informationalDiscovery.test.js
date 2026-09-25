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
