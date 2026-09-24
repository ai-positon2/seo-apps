const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { buildFindings } = require("../analyzer");
const { SeoCrawler } = require("../crawler");

const H = "https://example.com";
const page = (url, extra = {}) => ({
  url, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: `Title for ${url}`, titleCount: 1, titleLength: 30, metaDescription: `Description for ${url} `.repeat(4),
  metaLength: 120, viewport: "width=device-width", h1Count: 1, h1: `H1 ${url}`, words: 400, textHtmlRatio: 0.3,
  canonical: url, hreflangs: [], robots: "", indexability: "Indexable", inlinks: 3, depth: 1, hash: url,
  responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [], openGraphInvalidUrls: [],
  ...extra,
});
const asset = (url, status, extra = {}) => ({
  url, scope: "Internal", status, statusText: status === 404 ? "Not Found" : "", contentType: "text/html",
  isAsset: true, depth: 1, ...extra,
});

// A broken image, stylesheet or script used to be reported as "Pages returning
// 4XX errors" on the FILE's own URL — no page named, so nothing to open and fix
// — and a broken script was reported twice (page-4xx and broken-javascript),
// both on the script URL. Semrush reports these on the pages that use them.
test("broken images, stylesheets, scripts and fonts are reported on the pages that use them", () => {
  const { findings } = buildFindings({
    results: [
      page(`${H}/`),
      asset(`${H}/hero.png`, 404),
      asset(`${H}/site.css`, 404),
      asset(`${H}/app.js`, 500, { statusText: "Server Error" }),
      asset(`${H}/font.woff2`, 404),
      asset(`${H}/ok.png`, 200, { contentType: "image/png" }),
    ],
    resourceEdges: [
      { sourceUrl: `${H}/`, targetUrl: `${H}/hero.png`, tag: "img", sourceAttribute: "src", alt: "Hero", elementHint: 'img.hero via src="/hero.png"' },
      { sourceUrl: `${H}/`, targetUrl: `${H}/site.css`, tag: "link", rel: "stylesheet", sourceAttribute: "href" },
      { sourceUrl: `${H}/`, targetUrl: `${H}/app.js`, tag: "script", sourceAttribute: "src" },
      { sourceUrl: `${H}/`, targetUrl: `${H}/font.woff2`, tag: "css", sourceAttribute: "url()" },
      { sourceUrl: `${H}/`, targetUrl: `${H}/ok.png`, tag: "img", sourceAttribute: "src", alt: "Fine" },
    ],
    startUrl: `${H}/`,
    sitemapsChecked: false,
  });
  const onHome = (ruleId) => findings.filter((f) => f.ruleId === ruleId && f.url === `${H}/`).map((f) => f.targetUrl);

  assert.deepEqual(onHome("broken-internal-image"), [`${H}/hero.png`]);
  assert.deepEqual(onHome("broken-javascript").sort(), [`${H}/app.js`, `${H}/site.css`]);
  assert.deepEqual(onHome("broken-internal-resource"), [`${H}/font.woff2`]);
  const image = findings.find((f) => f.ruleId === "broken-internal-image");
  assert.equal(image.statusCode, 404);
  assert.match(image.detectedValue, /img\.hero/);

  // Nothing is filed against the asset URLs themselves any more.
  const onAssets = findings.filter((f) => /\.(png|css|js|woff2)$/.test(f.url));
  assert.deepEqual(onAssets.map((f) => `${f.ruleId} ${f.url}`), []);
});

test("a resource blocked by robots.txt is not reported broken", () => {
  const { findings } = buildFindings({
    results: [page(`${H}/`), asset(`${H}/private/x.png`, 0, { statusText: "Blocked by robots.txt" })],
    resourceEdges: [{ sourceUrl: `${H}/`, targetUrl: `${H}/private/x.png`, tag: "img", sourceAttribute: "src", alt: "x" }],
    startUrl: `${H}/`,
    sitemapsChecked: false,
  });
  assert.ok(!findings.some((f) => f.ruleId.startsWith("broken-")));
  assert.ok(findings.some((f) => f.ruleId === "blocked-resource"));
});

test("a resource that redirects to a broken URL is reported broken", () => {
  const { findings } = buildFindings({
    results: [
      page(`${H}/`),
      asset(`${H}/old.png`, 301, { redirectUrl: `${H}/new.png`, contentType: "" }),
      asset(`${H}/new.png`, 404),
    ],
    resourceEdges: [{ sourceUrl: `${H}/`, targetUrl: `${H}/old.png`, tag: "img", sourceAttribute: "src", alt: "x" }],
    startUrl: `${H}/`,
    sitemapsChecked: false,
  });
  const image = findings.find((f) => f.ruleId === "broken-internal-image");
  assert.ok(image, JSON.stringify(findings.map((f) => f.ruleId)));
  assert.equal(image.statusCode, 404);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("a crawl attributes a missing stylesheet to the page that loads it", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html><head><title>Stylesheet fixture home</title><link rel="stylesheet" href="/missing.css"></head><body><h1>Home</h1></body></html>');
      return;
    }
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/html");
    response.end("<html><body>Not found</body></html>");
  });
  t.after(() => server.close());
  const port = await listen(server);
  const crawler = new SeoCrawler({ maxUrls: 10, respectRobots: false, discoverSitemaps: false, checkExternalLinks: false, timeout: 5_000 });
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);
  const css = summary.findings.find((f) => f.ruleId === "broken-javascript");
  assert.ok(css, JSON.stringify(summary.findings.map((f) => f.ruleId)));
  assert.equal(css.url, `http://127.0.0.1:${port}/`);
  assert.equal(css.targetUrl, `http://127.0.0.1:${port}/missing.css`);
  assert.ok(!summary.findings.some((f) => f.ruleId === "page-4xx"));
});
