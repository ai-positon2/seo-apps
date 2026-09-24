const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");

// Sitemap URLs are queued after the start page's links. Every one of them
// already found through a link used to count as "did not fit within the crawl
// budget", so a two-page site whose sitemap lists both pages was told "Only 0
// of 2 sitemap URLs fitted within the crawl budget", reported as a robots.txt
// and sitemap configuration issue. Running out of budget is the crawl's limit,
// not the site's configuration: it belongs with what the crawl did not cover.

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const page = (title, links = []) =>
  `<!doctype html><html lang="en"><head><title>${title} sitemap fixture page</title></head><body><h1>${title}</h1>` +
  `${links.map((href) => `<a href="${href}">${href}</a>`).join("")}</body></html>`;

async function crawl({ sitemapPaths, homeLinks, options = {} }) {
  const server = http.createServer((request, response) => {
    const host = request.headers.host;
    if (request.url === "/robots.txt") {
      response.setHeader("Content-Type", "text/plain");
      response.end(`User-agent: *\nAllow: /\nSitemap: http://${host}/sitemap.xml`);
      return;
    }
    if (request.url === "/sitemap.xml") {
      response.setHeader("Content-Type", "application/xml");
      response.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapPaths.map((path) => `<url><loc>http://${host}${path}</loc></url>`).join("")}</urlset>`);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(request.url === "/" ? page("Home", homeLinks) : page(request.url));
  });
  const port = await listen(server);
  try {
    const crawler = new SeoCrawler({ checkExternalLinks: false, ...options });
    return await crawler.start(`http://127.0.0.1:${port}/`);
  } finally {
    server.close();
  }
}

test("sitemap URLs the links already found are not reported as not fitting the budget", async () => {
  const summary = await crawl({ sitemapPaths: ["/", "/a"], homeLinks: ["/a"], options: { maxUrls: 50 } });
  assert.ok(!summary.siteDiagnostics.sitemapConfigIssue);
  assert.ok(!summary.findings.some((f) => f.ruleId === "sitemap-robots-config"));
});

test("sitemap URLs a page budget left uncrawled are counted with what the crawl did not cover", async () => {
  // A budget of 5 keeps a fifth back for pages found by links: the home page
  // and three sitemap URLs are crawled, and nothing links to the other seven.
  const paths = Array.from({ length: 10 }, (_, i) => `/p${i}`);
  const summary = await crawl({ sitemapPaths: paths, homeLinks: [], options: { maxUrls: 5 } });
  assert.ok(!summary.findings.some((f) => f.ruleId === "sitemap-robots-config"), "a budget is not a sitemap configuration issue");
  const entry = summary.coverage.pagesNotAudited.find((e) => /listed in the sitemaps/.test(e.reason));
  assert.ok(entry, "the report says how many sitemap URLs were not crawled");
  assert.equal(entry.count, 7);
  assert.equal(entry.reason, "7 URLs listed in the sitemaps were not crawled: the crawl reached its page budget first.");
});

test("sitemap URLs the scope rules leave out are not counted as over budget either", async () => {
  const summary = await crawl({
    sitemapPaths: ["/", "/blog/a", "/shop/x", "/shop/y"],
    homeLinks: [],
    options: { maxUrls: 50, includePatterns: ["/blog/*"] },
  });
  assert.ok(!summary.siteDiagnostics.sitemapConfigIssue);
  assert.ok(!summary.coverage.pagesNotAudited.some((e) => /listed in the sitemaps/.test(e.reason)));
});
