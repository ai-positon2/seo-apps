const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// A stopped crawl never saw part of the link graph, so "nothing links here" is
// unknowable for any page it reached — the page that links to it may simply not
// have been fetched yet. orphan-page and single-inlink were only suppressed when
// the crawl hit a cap (`truncated`); stop() never set that, so a crawl stopped
// early reported sitemap pages as orphans that the rest of the site links to.
test("a stopped crawl does not report orphan or single-inlink pages", async (t) => {
  let port;
  const page = (title, body = "") =>
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
  const server = http.createServer((request, response) => {
    const send = (status, type, body) => {
      response.statusCode = status;
      response.setHeader("Content-Type", type);
      response.end(body);
    };
    if (request.url === "/robots.txt") return send(200, "text/plain", "User-agent: *\nAllow: /\n");
    if (request.url === "/sitemap.xml") {
      return send(200, "application/xml",
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
        `<url><loc>http://127.0.0.1:${port}/b</loc></url><url><loc>http://127.0.0.1:${port}/c</loc></url></urlset>`);
    }
    if (request.url === "/") return send(200, "text/html", page("Home page of the stop fixture"));
    if (request.url === "/b") return send(200, "text/html", page("Page B of the stop fixture"));
    if (request.url === "/c") return send(200, "text/html", page("Page C links to B", '<a href="/b">B</a>'));
    return send(404, "text/plain", "nope");
  });
  t.after(() => server.close());
  port = await listen(server);

  const crawler = new SeoCrawler({
    maxUrls: 20,
    concurrency: 1,
    respectRobots: true,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });
  crawler.on("result", (result) => {
    if (result.url.endsWith("/b")) crawler.stop();
  });
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);

  assert.equal(summary.stopped, true);
  assert.ok(summary.results.some((r) => r.url.endsWith("/b")), "B was fetched before the stop");
  assert.ok(!summary.results.some((r) => r.url.endsWith("/c")), "C, which links to B, was not");
  const partialOnly = summary.findings.filter((f) => ["orphan-page", "single-inlink"].includes(f.ruleId));
  assert.deepEqual(partialOnly.map((f) => `${f.ruleId} ${f.url}`), []);
});
