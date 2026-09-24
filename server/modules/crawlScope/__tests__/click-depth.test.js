const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings } = require("../analyzer");

// Depth was the crawler's discovery depth, and every sitemap URL was queued at
// depth 1 — so on any site with a sitemap nearly every page was "1 click" from
// home, "more than 3 clicks deep" almost never fired, and both validation sites
// reported a maximum depth of 2. Click depth is now the shortest path over the
// link graph from the start page.
const H = "https://example.com";
const page = (path, extra = {}) => ({
  url: `${H}${path}`, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: `Title for ${path} on the click depth fixture`, titleCount: 1, titleLength: 40,
  metaDescription: "A description long enough to pass the meta length checks without any trouble.",
  metaLength: 90, viewport: "width=device-width", h1Count: 1, h1: `H1 ${path}`, words: 400,
  canonical: `${H}${path}`, hreflangs: [], robots: "", indexability: "Indexable", depth: 1, hash: path,
  responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [], openGraphInvalidUrls: [],
  ...extra,
});
const link = (from, to, extra = {}) => ({ sourceUrl: `${H}${from}`, targetUrl: `${H}${to}`, internal: true, anchorText: to, ...extra });
const analyze = (results, linkEdges, extra = {}) =>
  buildFindings({ results, linkEdges, startUrl: `${H}/`, sitemapsChecked: false, ...extra });
const depthOf = (analysis, path) => analysis.results.find((r) => r.url === `${H}${path}`).clickDepth;

test("a page four clicks from home is deep, whatever depth the crawler found it at", () => {
  const analysis = analyze(
    [page("/"), page("/a"), page("/b"), page("/c"), page("/deep", { depth: 1, fromSitemap: true })],
    [link("/", "/a"), link("/a", "/b"), link("/b", "/c"), link("/c", "/deep")],
  );
  assert.equal(depthOf(analysis, "/"), 0);
  assert.equal(depthOf(analysis, "/deep"), 4);
  const deep = analysis.findings.filter((f) => f.ruleId === "deep-page");
  assert.deepEqual(deep.map((f) => f.url), [`${H}/deep`]);
  assert.equal(deep[0].detail, "4 clicks from the start page");
  assert.equal(deep[0].detectedValue, `${H}/ -> ${H}/a -> ${H}/b -> ${H}/c -> ${H}/deep`);
});

test("the shortest path counts, not the order pages were found in", () => {
  const analysis = analyze(
    [page("/"), page("/a"), page("/b"), page("/c"), page("/d", { depth: 5 })],
    [link("/", "/a"), link("/a", "/b"), link("/b", "/c"), link("/c", "/d"), link("/", "/d")],
  );
  assert.equal(depthOf(analysis, "/d"), 1);
  assert.ok(!analysis.findings.some((f) => f.ruleId === "deep-page"));
});

test("a redirect is not a click, and a nofollow link is not a path", () => {
  const analysis = analyze(
    [
      page("/"),
      page("/old", { status: 301, statusText: "Moved Permanently", redirectUrl: `${H}/new`, contentType: "", indexability: "Non-indexable" }),
      page("/new"),
      page("/hidden"),
    ],
    [link("/", "/old"), link("/", "/hidden", { nofollow: true })],
  );
  assert.equal(depthOf(analysis, "/old"), 1);
  assert.equal(depthOf(analysis, "/new"), 1);
  assert.equal(depthOf(analysis, "/hidden"), null, "only reachable through a nofollow link");
});

test("a page no link reaches has no click depth", () => {
  const analysis = analyze([page("/"), page("/sitemap-only", { fromSitemap: true })], []);
  assert.equal(depthOf(analysis, "/sitemap-only"), null);
  assert.ok(!analysis.findings.some((f) => f.ruleId === "deep-page"));
});

test("a URL list has no start page to count clicks from", () => {
  const analysis = analyze(
    [page("/"), page("/a"), page("/b"), page("/c"), page("/d")],
    [link("/", "/a"), link("/a", "/b"), link("/b", "/c"), link("/c", "/d")],
    { clickDepthFromStart: false },
  );
  assert.equal(depthOf(analysis, "/d"), null);
  assert.ok(!analysis.findings.some((f) => f.ruleId === "deep-page"));
});

test("a real crawl: a sitemap page four links deep is reported deep", async (t) => {
  const http = require("node:http");
  const { SeoCrawler } = require("../crawler");
  const chain = { "/": "/a", "/a": "/b", "/b": "/c", "/c": "/deep", "/deep": null };
  const server = http.createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    if (request.url === "/robots.txt") {
      response.setHeader("Content-Type", "text/plain");
      response.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml`);
      return;
    }
    if (request.url === "/sitemap.xml") {
      response.setHeader("Content-Type", "application/xml");
      response.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
        Object.keys(chain).map((path) => `<url><loc>${origin}${path}</loc></url>`).join("")
      }</urlset>`);
      return;
    }
    if (!(request.url in chain)) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    const next = chain[request.url];
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head><title>Click depth fixture ${request.url}</title></head>
      <body><h1>${request.url}</h1>${next ? `<a href="${next}">Next</a>` : ""}</body></html>`);
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const crawler = new SeoCrawler({
    maxUrls: 20, concurrency: 2, respectRobots: true, discoverSitemaps: true,
    crawlAssets: false, checkExternalLinks: false, timeout: 5_000, perHostDelay: 0,
  });
  const summary = await crawler.start(`http://127.0.0.1:${server.address().port}/`);
  const deep = summary.results.find((r) => r.url.endsWith("/deep"));
  assert.equal(deep.depth, 1, "the crawler found it through the sitemap");
  assert.equal(deep.clickDepth, 4);
  assert.deepEqual(
    summary.findings.filter((f) => f.ruleId === "deep-page").map((f) => new URL(f.url).pathname),
    ["/deep"],
  );
});
