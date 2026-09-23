const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const zlib = require("node:zlib");
const { SeoCrawler } = require("../crawler");

// Sitemaps were read with the 5 MB page limit: a larger plain sitemap was cut at
// 5 MB without a word, and a gzip one that inflated past 5 MB was dropped
// whole. The protocol allows 50 MB and 50,000 URLs per file. Entries on another
// host (www vs apex) were dropped silently too.
function site(sitemapBody, { gzip = false } = {}) {
  return http.createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    if (request.url === "/robots.txt") {
      response.setHeader("Content-Type", "text/plain");
      response.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml${gzip ? ".gz" : ""}`);
    } else if (request.url.startsWith("/sitemap.xml")) {
      const body = sitemapBody(origin);
      response.setHeader("Content-Type", gzip ? "application/gzip" : "application/xml");
      response.end(gzip ? zlib.gzipSync(body) : body);
    } else if (request.url === "/" || /^\/p\d+$/.test(request.url)) {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><html><head><title>Sitemap limits fixture ${request.url}</title></head><body><h1>${request.url}</h1></body></html>`);
    } else {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
}
const urlset = (locs) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
    locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("")
  }</urlset>`;
async function crawl(t, server, options = {}) {
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return new SeoCrawler({
    maxUrls: 10, concurrency: 2, respectRobots: true, discoverSitemaps: true, crawlAssets: false,
    checkExternalLinks: false, timeout: 20_000, perHostDelay: 0, ...options,
  }).start(`http://127.0.0.1:${server.address().port}/`);
}

test("a gzip sitemap that inflates past 5 MB is read, not dropped", async (t) => {
  // ~7 MB of XML: under the protocol's 50 MB, over the old 5 MB inflate limit.
  const summary = await crawl(t, site((origin) => urlset([
    `${origin}/p1`,
    ...Array.from({ length: 70_000 }, (_, i) => `${origin}/p1?padding=${"x".repeat(60)}${i}`).slice(0, 49_000),
  ]), { gzip: true }));
  assert.ok(summary.results.some((r) => r.url.endsWith("/p1")), "the sitemap's first URL was crawled");
  assert.ok(!summary.findings.some((f) => f.ruleId === "sitemap-unreadable"));
});

test("a sitemap past the protocol's limits is reported, and read as far as the limit", async (t) => {
  const summary = await crawl(t, site((origin) => urlset(
    Array.from({ length: 50_001 }, (_, i) => `${origin}/p${i}`),
  )));
  const tooLarge = summary.findings.find((f) => f.ruleId === "sitemap-too-large");
  assert.ok(tooLarge, "over 50,000 URLs");
  assert.match(tooLarge.detail, /50,001 URLs/);
});

test("sitemap entries on another host are reported, not silently dropped", async (t) => {
  const summary = await crawl(t, site((origin) => urlset([
    `${origin}/p1`,
    "https://www.elsewhere.invalid/a",
    "https://www.elsewhere.invalid/b",
  ])));
  const offHost = summary.findings.find((f) => f.ruleId === "sitemap-off-host");
  assert.ok(offHost);
  assert.match(offHost.detail, /2 sitemap entries/);
  assert.match(offHost.detail, /www\.elsewhere\.invalid \(2\)/);
});

test("a sitemap over 50 MB is read to 50 MB, reported, and its checks marked partly checked", async (t) => {
  // Compresses to a few hundred KB; inflates to ~57 MB.
  const padded = "y".repeat(80);
  const summary = await crawl(t, site((origin) => urlset([
    `${origin}/p1`,
    ...Array.from({ length: 460_000 }, () => `${origin}/p2?x=${padded}`),
  ]), { gzip: true }));
  assert.ok(summary.results.some((r) => r.url.endsWith("/p1")), "entries before the cut were read");
  const tooLarge = summary.findings.filter((f) => f.ruleId === "sitemap-too-large");
  assert.equal(tooLarge.length, 1, "one finding for the file, however many limits it is over");
  assert.match(tooLarge[0].detail, /larger than 50 MB/);
  assert.match(tooLarge[0].detail, /URLs, over the limit of 50,000/);
  const partly = summary.coverage.partial.map((entry) => entry.ruleId);
  assert.ok(partly.includes("sitemap-missing-indexable"));
});
