const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings } = require("../analyzer");

// A check that did not run produced no findings, and "no findings" was counted
// as passed: a crawl stopped at its page limit read "orphan pages: clean", and
// a crawl with sitemaps turned off read "every sitemap check: clean". The
// analyzer now says which checks it could not evaluate, and why.
const H = "https://example.com";
const page = (path, extra = {}) => ({
  url: `${H}${path}`, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: `Title for ${path} on the coverage fixture`, titleCount: 1, titleLength: 40,
  metaDescription: "A description long enough to pass the meta length checks without any trouble.",
  metaLength: 90, viewport: "width=device-width", h1Count: 1, h1: `H1 ${path}`, words: 400,
  canonical: `${H}${path}`, hreflangs: [], robots: "", indexability: "Indexable", depth: 1, hash: path,
  responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [], openGraphInvalidUrls: [],
  ...extra,
});
const fullSite = {
  sitemapsChecked: true,
  externalLinksChecked: true,
  robotsRespected: true,
  siteDiagnostics: {
    robotsUrl: `${H}/robots.txt`,
    llmsStatus: "found",
    missingPageProbe: { url: `${H}/crawlscope-missing-page-check-1`, status: 404 },
  },
};
const coverageOf = (options) =>
  buildFindings({ results: [page("/")], linkEdges: [], startUrl: `${H}/`, ...fullSite, ...options }).coverage;
const ids = (list) => list.map((entry) => entry.ruleId).sort();

test("a complete crawl evaluated everything", () => {
  const coverage = coverageOf({});
  assert.deepEqual(coverage.notEvaluated, []);
  assert.deepEqual(coverage.partial, []);
});

test("a capped or stopped crawl cannot say a page has no links to it", () => {
  const coverage = coverageOf({ crawlTruncated: true });
  assert.deepEqual(ids(coverage.notEvaluated), ["orphan-page", "single-inlink"]);
  assert.match(coverage.notEvaluated[0].reason, /whole site/);
});

test("sitemaps not read: no sitemap check ran, and orphans are defined by the sitemap", () => {
  const coverage = coverageOf({ sitemapsChecked: false });
  const skipped = ids(coverage.notEvaluated);
  for (const id of ["sitemap-missing-indexable", "sitemap-incorrect-url", "sitemap-redirect", "sitemap-duplicate", "sitemap-http-url", "orphan-page"]) {
    assert.ok(skipped.includes(id), `${id} is not evaluated`);
  }
});

test("external links not checked, or only up to the limit", () => {
  assert.deepEqual(ids(coverageOf({ externalLinksChecked: false }).notEvaluated), ["broken-external-link", "external-403"]);
  const capped = coverageOf({ siteDiagnostics: { ...fullSite.siteDiagnostics, externalLinksUnchecked: 37 } });
  assert.deepEqual(ids(capped.partial), ["broken-external-link", "external-403"]);
  assert.match(capped.partial[0].reason, /37 external URLs/);
});

test("robots.txt ignored, site files unread, a URL list", () => {
  assert.deepEqual(ids(coverageOf({ robotsRespected: false }).notEvaluated), ["blocked-resource", "robots-blocked"]);
  const noSiteFiles = coverageOf({ siteDiagnostics: { robotsUrl: `${H}/robots.txt` } });
  for (const id of ["llms-missing", "soft-404-site", "http-homepage"]) {
    assert.ok(ids(noSiteFiles.notEvaluated).includes(id), `${id} is not evaluated`);
  }
  const list = coverageOf({ clickDepthFromStart: false });
  for (const id of ["deep-page", "javascript-rendered-site", "crawl-trap"]) {
    assert.ok(ids(list.notEvaluated).includes(id), `${id} is not evaluated for a URL list`);
  }
});

test("a check that fired is never listed as not evaluated", () => {
  const { findings, coverage } = buildFindings({
    results: [page("/"), page("/lonely", { fromSitemap: true })],
    linkEdges: [],
    startUrl: `${H}/`,
    ...fullSite,
    sitemapsChecked: false,
  });
  const fired = new Set(findings.map((f) => f.ruleId));
  assert.ok(coverage.notEvaluated.every((entry) => !fired.has(entry.ruleId)));
});

test("a crawl trap is not the page budget running out", async (t) => {
  const http = require("node:http");
  const { SeoCrawler } = require("../crawler");
  // /calendar/1 links /calendar/2 links /calendar/3 ... : one URL pattern, unbounded.
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    const day = Number((/^\/calendar\/(\d+)$/.exec(request.url) || [])[1]);
    if (request.url === "/") {
      response.end('<!doctype html><html><head><title>Trap fixture home page</title></head><body><a href="/calendar/1">Calendar</a></body></html>');
    } else if (day) {
      response.end(`<!doctype html><html><head><title>Day ${day} of the trap fixture</title></head><body><a href="/calendar/${day + 1}">Next day</a></body></html>`);
    } else {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const crawl = (options) => new SeoCrawler({
    concurrency: 2, respectRobots: false, discoverSitemaps: false, crawlAssets: false,
    checkExternalLinks: false, timeout: 5_000, perHostDelay: 0, ...options,
  }).start(`http://127.0.0.1:${server.address().port}/`);

  const trapped = await crawl({ maxUrls: 100, maxUrlsPerTemplate: 5 });
  assert.equal(trapped.truncated, true);
  assert.equal(trapped.budgetReached, false, "the pattern was capped; the budget was not reached");
  assert.equal(trapped.trapTemplates.length, 1);

  const budgeted = await crawl({ maxUrls: 4, maxUrlsPerTemplate: 50 });
  assert.equal(budgeted.budgetReached, true);
});
