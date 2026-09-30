// ── Which sitemaps a site's URL list is read from ────────────────────────────
//
// fetchSafe refuses local addresses, so these tests replace it with a map of
// URL → body before sitemapDiscovery.js loads (it takes fetchSafe at require
// time). No network.
//
// Run: node --test modules/contentArchitect/__tests__/sitemapDiscovery.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const urlSafety = require('../urlSafety');

let site = {};
urlSafety.fetchSafe = async (url) => {
  if (!(url in site)) throw Object.assign(new Error(`HTTP 404 ${url}`), { status: 404 });
  const body = site[url];
  return { status: 200, headers: {}, data: Buffer.from(body) };
};

const { discoverUrls, sharedBudget, prioritizeSitemaps, resolveSitemapUrls } = require('../sitemapDiscovery');
const { MAX_SITEMAP_URLS } = require('../config');

const O = 'https://www.example.test';
const urlset = (paths, lastmod) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
  paths.map((p, i) => `<url><loc>${O}${p}</loc>${lastmod ? `<lastmod>${lastmod(i)}</lastmod>` : ''}</url>`).join('')}</urlset>`;
const index = (locs) => `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
  locs.map((l) => `<sitemap><loc>${O}${l}</loc></sitemap>`).join('')}</sitemapindex>`;
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('every sitemap robots.txt declares is read, not only the first', async () => {
  // Measured on a SaaS site: the first of ten declared sitemaps held its
  // integration pages, and the blog's own sitemap was never opened.
  site = {
    [`${O}/robots.txt`]: `User-agent: *\nSitemap: ${O}/apps-sitemap.xml\nSitemap: ${O}/blog/sitemap.xml\n`,
    [`${O}/apps-sitemap.xml`]: urlset(range(30, (i) => `/apps/app-${i}`)),
    [`${O}/blog/sitemap.xml`]: urlset(range(12, (i) => `/blog/post-${i}`)),
  };
  const result = await discoverUrls(O);
  assert.equal(result.mode, 'sitemap');
  assert.equal(result.urls.filter((u) => u.url.includes('/blog/')).length, 12);
  assert.equal(result.urls.filter((u) => u.url.includes('/apps/')).length, 30);
  // The blog's sitemap names informational content, so it is read first.
  assert.equal(result.source, `${O}/blog/sitemap.xml`);
  assert.deepEqual(result.sources.map((s) => s.count), [12, 30]);
  assert.equal(result.capped, false);
});

test('the fallback paths are tried only when robots.txt declares nothing that resolves', async () => {
  site = {
    [`${O}/robots.txt`]: 'User-agent: *\nDisallow:\n',
    [`${O}/sitemap.xml`]: urlset(['/a', '/b']),
    [`${O}/sitemap_index.xml`]: urlset(['/c']),
  };
  const result = await discoverUrls(O);
  assert.deepEqual(result.urls.map((u) => new URL(u.url).pathname), ['/a', '/b']);
  site = { [`${O}/robots.txt`]: '' };
  assert.equal((await discoverUrls(O)).mode, 'not-found');
});

test('one shared URL budget: no single sitemap crowds out the others', () => {
  assert.deepEqual(sharedBudget([100, 100], 50), [25, 25]);
  // What a short list leaves unused passes to the longer ones.
  assert.deepEqual(sharedBudget([5, 100, 100], 105), [5, 50, 50]);
  assert.deepEqual(sharedBudget([0, 10], 100), [0, 10]);
  assert.equal(sharedBudget([MAX_SITEMAP_URLS, MAX_SITEMAP_URLS, 7], MAX_SITEMAP_URLS).reduce((a, b) => a + b, 0), MAX_SITEMAP_URLS);
});

test('a cut sitemap keeps its most recently modified URLs', async () => {
  const big = MAX_SITEMAP_URLS + 10;
  site = {
    [`${O}/robots.txt`]: `Sitemap: ${O}/blog/sitemap.xml\nSitemap: ${O}/pages.xml\n`,
    [`${O}/blog/sitemap.xml`]: urlset(range(big, (i) => `/blog/p${i}`), (i) => `2020-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`),
    [`${O}/pages.xml`]: urlset(['/about', '/contact']),
  };
  const result = await discoverUrls(O);
  assert.equal(result.urls.length, MAX_SITEMAP_URLS);
  assert.equal(result.capped, true);
  assert.ok(result.urls.some((u) => u.url.endsWith('/about')), 'the small sitemap is not crowded out');
});

test('informational child sitemaps of an index are read first', async () => {
  assert.deepEqual(
    prioritizeSitemaps(['/pages.xml', '/products-1.xml', '/post-sitemap.xml', '/glossary/sitemap.xml']),
    ['/post-sitemap.xml', '/glossary/sitemap.xml', '/pages.xml', '/products-1.xml'],
  );
  site = {
    [`${O}/blog/sitemap_index.xml`]: index(['/blog/post-sitemap1.xml']),
    [`${O}/blog/post-sitemap1.xml`]: urlset(['/blog/one', '/blog/two']),
  };
  const section = await resolveSitemapUrls(`${O}/blog/sitemap_index.xml`);
  assert.deepEqual(section.urls.map((u) => new URL(u.url).pathname), ['/blog/one', '/blog/two']);
  assert.deepEqual((await resolveSitemapUrls(`${O}/nothing.xml`)).urls, []);
});
