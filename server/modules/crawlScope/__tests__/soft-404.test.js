const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { buildFindings } = require("../analyzer");
const { SeoCrawler } = require("../crawler");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const html = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const NOT_FOUND = html(
  "Page not found | Example",
  "<h1>Sorry, we could not find that page</h1><p>Try the search box or go back to the home page.</p>",
);

// A site that answers 200 with a "not found" page for URLs that do not exist
// never shows up as broken links or 4xx pages: every check keyed on status
// sees a healthy 200. Google reports these as soft 404s and drops them.
async function crawlSite(t, unknown) {
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/") {
      response.end(html("Home of the soft 404 fixture", '<h1>Home</h1><a href="/deleted-page">Old article</a><a href="/about">About</a>'));
      return;
    }
    if (request.url === "/about") {
      response.end(html("About the soft 404 fixture", `<h1>About</h1><p>${"Real content about us. ".repeat(60)}</p>`));
      return;
    }
    unknown(request, response);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const crawler = new SeoCrawler({ maxUrls: 10, respectRobots: false, discoverSitemaps: false, checkExternalLinks: false, timeout: 5_000 });
  return { port, summary: await crawler.start(`http://127.0.0.1:${port}/`) };
}

test("a site that serves 200 for missing URLs is reported, and its not-found pages are flagged", async (t) => {
  const { port, summary } = await crawlSite(t, (request, response) => {
    response.statusCode = 200;
    response.end(NOT_FOUND);
  });
  const site = summary.findings.find((f) => f.ruleId === "soft-404-site");
  assert.ok(site, JSON.stringify(summary.findings.map((f) => f.ruleId)));
  assert.match(site.detail, /200/);
  const soft = summary.findings.filter((f) => f.ruleId === "soft-404").map((f) => f.url);
  assert.deepEqual(soft, [`http://127.0.0.1:${port}/deleted-page`]);
});

test("a site that redirects missing URLs is reported too", async (t) => {
  const { summary } = await crawlSite(t, (request, response) => {
    response.statusCode = 302;
    response.setHeader("Location", "/");
    response.end();
  });
  const site = summary.findings.find((f) => f.ruleId === "soft-404-site");
  assert.ok(site);
  assert.match(site.detail, /redirect/i);
});

test("a site that answers 404 for missing URLs is not reported", async (t) => {
  const { summary } = await crawlSite(t, (request, response) => {
    response.statusCode = 404;
    response.end(NOT_FOUND);
  });
  assert.ok(!summary.findings.some((f) => f.ruleId === "soft-404-site" || f.ruleId === "soft-404"));
});

const page = (url, extra = {}) => ({
  url, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html", titleCount: 1,
  metaDescription: "d".repeat(120), metaLength: 120, viewport: "width=device-width", h1Count: 1,
  textHtmlRatio: 0.3, canonical: url, hreflangs: [], robots: "", indexability: "Indexable", depth: 1,
  hash: url, responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [],
  openGraphInvalidUrls: [], ...extra,
});

test("a thin page titled like an error page is a possible soft 404; an article about 404s is not", () => {
  const H = "https://example.com";
  const { findings } = buildFindings({
    results: [
      page(`${H}/`, { title: "Home", titleLength: 4, h1: "Home", words: 500 }),
      page(`${H}/gone`, { title: "404 - Page Not Found", titleLength: 20, h1: "Oops", words: 30 }),
      page(`${H}/blog/fix-404`, { title: "How to fix 404 errors on your site", titleLength: 34, h1: "How to fix 404 errors", words: 1400 }),
    ],
    startUrl: `${H}/`,
    sitemapsChecked: false,
  });
  const soft = findings.filter((f) => f.ruleId === "soft-404").map((f) => f.url);
  assert.deepEqual(soft, [`${H}/gone`]);
});
