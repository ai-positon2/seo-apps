const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { buildFindings } = require("../analyzer");
const { SeoCrawler } = require("../crawler");
const { createUrlIdentity } = require("../url-identity");

const H = "https://example.com";
const page = (url, extra = {}) => ({
  url, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: `Title for ${url}`, titleCount: 1, titleLength: 30, metaDescription: `Description for ${url} `.repeat(4),
  metaLength: 120, viewport: "width=device-width", h1Count: 1, h1: `H1 ${url}`, words: 400, textHtmlRatio: 0.3,
  canonical: url, hreflangs: [], robots: "", indexability: "Indexable", inlinks: 3, depth: 1, hash: url,
  responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [], openGraphInvalidUrls: [],
  ...extra,
});
const rulesOn = (findings, url) => findings.filter((f) => f.url === url).map((f) => f.ruleId);

test("createUrlIdentity maps the crawled host to the crawl scheme and normalizes", () => {
  const identity = createUrlIdentity(`${H}/`);
  assert.equal(identity("http://EXAMPLE.com/a?utm_source=x&b=2&a=1#top"), `${H}/a?a=1&b=2`);
  assert.equal(identity("http://other.com/a"), "http://other.com/a");
  // List mode has no start URL: normalize only, never change a scheme.
  assert.equal(createUrlIdentity("")("http://example.com/a"), "http://example.com/a");
});

// The crawler fetches an http:// link on an https site as https
// (_canonicalScheme) but the link edge keeps the http:// href, and the analyzer
// looked the target up by that exact string — so a broken page behind a
// hard-coded http:// link was never reported as broken.
test("a broken page behind an http:// internal link is reported broken", () => {
  const { findings } = buildFindings({
    results: [page(`${H}/`), page(`${H}/missing`, { status: 404, statusText: "Not Found", indexability: "Non-indexable" })],
    linkEdges: [{ sourceUrl: `${H}/`, targetUrl: "http://example.com/missing", internal: true, anchorText: "Old link" }],
    startUrl: `${H}/`,
    sitemapsChecked: false,
  });
  const broken = findings.filter((f) => f.ruleId === "broken-internal-links");
  assert.equal(broken.length, 1);
  assert.equal(broken[0].targetUrl, "http://example.com/missing", "evidence keeps the link as written");
  assert.equal(broken[0].statusCode, 404);
  const insecure = findings.find((f) => f.ruleId === "https-to-http-link");
  assert.ok(insecure, "the HTTP link itself is still reported");
  assert.match(insecure.detail, /HTTPS version/);
  assert.doesNotMatch(insecure.detail, /not fetched/);
});

// http-redirect.js records the Location as sent, and the chain walk looked the
// next hop up by that exact string: a hop whose Location carried a tracking
// parameter (the crawler fetches it without) ended the chain there.
test("a redirect chain whose middle hop carries a tracking parameter is traced", () => {
  const { findings } = buildFindings({
    results: [
      page(`${H}/`),
      page(`${H}/old`, { status: 301, contentType: "", redirectUrl: `${H}/mid?utm_source=redirect` }),
      page(`${H}/mid`, { status: 301, contentType: "", redirectUrl: `${H}/final` }),
      page(`${H}/final`),
    ],
    linkEdges: [{ sourceUrl: `${H}/`, targetUrl: `${H}/old`, internal: true, anchorText: "Old page" }],
    startUrl: `${H}/`,
    sitemapsChecked: false,
  });
  const chain = findings.find((f) => f.ruleId === "redirect-chain" && f.url === `${H}/old`);
  assert.ok(chain, "the two-hop chain from /old is reported");
  assert.equal(chain.detail, "2 redirect hops");
  // Each hop as the site sends it, tracking parameter included.
  assert.equal(chain.detectedValue, `${H}/old -> ${H}/mid?utm_source=redirect -> ${H}/final`);
  assert.equal(chain.targetUrl, `${H}/final`);
});

// Sitemap entries were matched by exact string against crawled URLs, so an
// http:// <loc> on an https site read as "missing from every sitemap" — while
// the page carried fromSitemap: true, because the crawler had crawled it from
// that very entry.
test("an http:// sitemap entry counts as listed, and is reported as an HTTP URL in the sitemap", () => {
  const { findings } = buildFindings({
    results: [page(`${H}/`), page(`${H}/listed`, { fromSitemap: true })],
    sitemapMembership: {
      [`${H}/`]: [`${H}/sitemap.xml`],
      "http://example.com/listed": [`${H}/sitemap.xml`],
    },
    startUrl: `${H}/`,
  });
  const listed = rulesOn(findings, `${H}/listed`);
  assert.ok(!listed.includes("sitemap-missing-indexable"), "the page is in the sitemap");
  const http = findings.find((f) => f.ruleId === "sitemap-http-url");
  assert.ok(http, "an HTTP URL in the sitemap of an HTTPS site is a finding");
  assert.equal(http.url, `${H}/listed`);
  assert.match(http.detectedValue, /^http:\/\/example\.com\/listed/);
});

test("a canonical pointing at the page's own HTTP version is reported as canonical-to-http", () => {
  const { findings } = buildFindings({
    results: [page(`${H}/`), page(`${H}/page`, { canonical: "http://example.com/page" })],
    startUrl: `${H}/`,
    sitemapsChecked: false,
  });
  const rules = rulesOn(findings, `${H}/page`);
  assert.ok(rules.includes("canonical-to-http"));
  assert.ok(!rules.includes("canonical-chain"), "it is not a chain; it is the same page on the wrong scheme");
});

test("an hreflang self-reference written with the other scheme counts as a self-reference", () => {
  const { findings } = buildFindings({
    results: [
      page(`${H}/`),
      page(`${H}/en`, { hreflangs: [{ lang: "en", url: "http://example.com/en" }, { lang: "fr", url: `${H}/fr` }] }),
      page(`${H}/fr`, { hreflangs: [{ lang: "fr", url: `${H}/fr` }, { lang: "en", url: "http://example.com/en" }] }),
    ],
    startUrl: `${H}/`,
    sitemapsChecked: false,
  });
  assert.ok(!rulesOn(findings, `${H}/en`).includes("hreflang-missing-self"));
  assert.ok(!rulesOn(findings, `${H}/fr`).includes("hreflang-missing-return"));
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// End to end, on the mirror case a local server can serve: an http:// crawl
// with a link written as https:// to the same host. The crawler fetches it as
// http:// (the crawl's scheme); the broken page must still be reported.
test("a crawl reports a broken page behind a link written with the other scheme", async (t) => {
  let port;
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><html><head><title>Scheme fixture home</title></head><body>
        <h1>Home</h1><a href="https://127.0.0.1:${port}/gone">Gone</a></body></html>`);
      return;
    }
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/html");
    response.end("<html><head><title>Not found</title></head><body>Missing</body></html>");
  });
  t.after(() => server.close());
  port = await listen(server);
  const crawler = new SeoCrawler({
    maxUrls: 10, respectRobots: false, discoverSitemaps: false, checkExternalLinks: false,
    crawlAssets: false, timeout: 5_000,
  });
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);
  const broken = summary.findings.filter((f) => f.ruleId === "broken-internal-links");
  assert.equal(broken.length, 1, JSON.stringify(summary.findings.map((f) => f.ruleId)));
  assert.equal(broken[0].statusCode, 404);
});
