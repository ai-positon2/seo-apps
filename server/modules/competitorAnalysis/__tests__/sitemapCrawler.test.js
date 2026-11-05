// ── Sitemap crawl: every declared sitemap, and a blocked check is not "0" ────
//
// Run: node --test modules/competitorAnalysis/__tests__/sitemapCrawler.test.js
//
// Nike's robots.txt declares seven sitemaps; only the first (its help centre,
// 113 URLs) was read, so the report called Nike lean. 8x8's robots.txt answers
// with a 429 Vercel checkpoint and vonage.com's sitemap with a 403 Cloudflare
// challenge; both were reported as "no sitemap" with 0 pages. axios is stubbed:
// nothing here touches the network.

const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const { crawlDomain } = require('../contentAnalysis/sitemapCrawler');
const { sitemapListingLine, SITEMAP_DATA_RULES } = require('../contentAnalysis/summarizer');

const urlset = (urls) => `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const index = (locs) => `<?xml version="1.0"?><sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`;
const range = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function httpError(status, data = '', headers = {}) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data, headers };
  return err;
}

// routes: url -> { status, data, headers } (2xx resolves, others reject like axios)
function stubAxios(t, routes) {
  const seen = [];
  t.mock.method(axios, 'get', async (url) => {
    seen.push(url);
    const r = routes[url];
    if (!r) throw httpError(404, 'not found');
    const res = { status: r.status || 200, data: r.data, headers: r.headers || {} };
    if (res.status >= 400) throw httpError(res.status, res.data, res.headers);
    return res;
  });
  return seen;
}

test('every robots.txt Sitemap: entry is read into one total', async (t) => {
  stubAxios(t, {
    'https://shop.test/robots.txt': { data: [
      'User-agent: *',
      'Sitemap: https://shop.test/help.xml',
      'Sitemap: https://shop.test/pdp-index.xml',
      'Sitemap: https://shop.test/missing.xml',
    ].join('\n') },
    'https://shop.test/help.xml': { data: urlset(range('https://shop.test/help/', 5)) },
    'https://shop.test/pdp-index.xml': { data: index(['https://shop.test/pdp-1.xml', 'https://shop.test/pdp-2.xml']) },
    'https://shop.test/pdp-1.xml': { data: urlset(range('https://shop.test/p/a', 10)) },
    'https://shop.test/pdp-2.xml': { data: urlset(range('https://shop.test/p/b', 10)) },
  });
  const r = await crawlDomain('shop.test');
  assert.strictEqual(r.sitemapStatus, 'found');
  assert.strictEqual(r.totalUrls, 25, 'help (5) + both product sitemaps (20), not just the first entry');
  assert.deepStrictEqual(r.sitemapUrls, ['https://shop.test/help.xml', 'https://shop.test/pdp-index.xml']);
  assert.strictEqual(r.capped, false);
  assert.strictEqual(r.partial, true, 'one declared sitemap could not be read, so the count is a lower bound');
  const missing = r.checks.find((c) => c.url === 'https://shop.test/missing.xml');
  assert.strictEqual(missing.status, 404, 'each candidate keeps its HTTP status');
});

test('a fully read set of sitemaps is not partial', async (t) => {
  stubAxios(t, {
    'https://ok.test/robots.txt': { data: 'Sitemap: https://ok.test/a.xml\nSitemap: https://ok.test/b.xml' },
    'https://ok.test/a.xml': { data: urlset(range('https://ok.test/a/', 3)) },
    'https://ok.test/b.xml': { data: urlset(range('https://www.ok.test/b/', 4)) },
  });
  const r = await crawlDomain('https://ok.test/');
  assert.strictEqual(r.totalUrls, 7);
  assert.strictEqual(r.partial, false);
});

test('a 429 security checkpoint on every fetch is blocked, with no page count', async (t) => {
  const wall = '<html><head><title>Vercel Security Checkpoint</title></head><body></body></html>';
  const routes = {};
  for (const base of ['https://blocked.test', 'https://www.blocked.test']) {
    for (const p of ['/robots.txt', '/sitemap_index.xml', '/sitemap.xml', '/sitemap-index.xml', '/wp-sitemap.xml']) {
      routes[base + p] = { status: 429, data: wall };
    }
  }
  stubAxios(t, routes);
  const r = await crawlDomain('blocked.test');
  assert.strictEqual(r.sitemapStatus, 'blocked');
  assert.strictEqual(r.totalUrls, null);
  assert.match(r.error, /blocked our request \(HTTP 429\)/);
  assert.ok(r.checks.some((c) => c.url === 'https://blocked.test/robots.txt' && c.status === 429 && c.blocked));
});

test('robots.txt readable but its sitemap behind a challenge page is blocked', async (t) => {
  stubAxios(t, {
    'https://cf.test/robots.txt': { data: 'Sitemap: https://cf.test/sitemap.xml' },
    'https://cf.test/sitemap.xml': { status: 403, data: '<html><title>Just a moment...</title></html>', headers: { 'cf-mitigated': 'challenge' } },
    'https://www.cf.test/robots.txt': { data: 'Sitemap: https://cf.test/sitemap.xml' },
  });
  const r = await crawlDomain('cf.test');
  assert.strictEqual(r.sitemapStatus, 'blocked');
  assert.strictEqual(r.totalUrls, null);
});

test('a challenge page served with 200 is a block, not a sitemap', async (t) => {
  stubAxios(t, {
    'https://soft.test/robots.txt': { data: '<html><head><title>Just a moment...</title></head></html>' },
  });
  const r = await crawlDomain('soft.test');
  assert.strictEqual(r.sitemapStatus, 'blocked');
});

test('plain 404s everywhere are not-found, not blocked', async (t) => {
  stubAxios(t, {});
  const r = await crawlDomain('nothing.test');
  assert.strictEqual(r.sitemapStatus, 'not-found');
});

test('the sitemap summary prompt treats blocked and partial domains as unavailable data', () => {
  const blocked = sitemapListingLine({ isClient: true, label: '8x8', domain: '8x8.com', sitemapStatus: 'blocked', error: 'Site blocked our request (HTTP 429).' });
  assert.match(blocked, /DATA UNAVAILABLE/);
  assert.match(blocked, /blocked/);
  const partial = sitemapListingLine({ isClient: true, label: 'Nike', domain: 'nike.com', sitemapStatus: 'found', totalUrls: 113, partial: true, capped: false, pageTypeCounts: { help: 113 } });
  assert.match(partial, /at least 113 URLs \(PARTIAL COUNT/);
  assert.match(SITEMAP_DATA_RULES, /do not describe its structure/);
});
