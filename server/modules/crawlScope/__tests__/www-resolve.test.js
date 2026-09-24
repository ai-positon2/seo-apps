const test = require("node:test");
const assert = require("node:assert/strict");
const { SeoCrawler } = require("../crawler");

// www.example.com and example.com both answering with the site is two copies
// of it: links and signals split between them. Semrush reports it as a WWW
// resolve issue; the crawler never looked at the other host.
function fakeFetch(apex) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const html = (title) =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
    let reply;
    if (u.host === "www.site.test") {
      if (u.protocol === "http:") reply = { status: 301, headers: { Location: `https://www.site.test${u.pathname}` } };
      else if (u.pathname === "/") reply = { status: 200, headers: { "Content-Type": "text/html" }, body: html("The site's home page on www") };
      else reply = { status: 404, headers: { "Content-Type": "text/html" }, body: html("Not found") };
    } else if (u.host === "site.test") {
      reply = apex(u);
    }
    if (!reply) throw new TypeError("fetch failed"); // no such host
    return new Response(init.method === "HEAD" ? null : reply.body ?? "", { status: reply.status, headers: reply.headers || {} });
  };
}
const crawl = (apex) => new SeoCrawler({
  maxUrls: 5, concurrency: 1, respectRobots: false, discoverSitemaps: false, crawlAssets: false,
  checkExternalLinks: false, timeout: 3_000, perHostDelay: 0, maxRetries: 0, fetch: fakeFetch(apex),
}).start("https://www.site.test/");
const wwwResolve = (summary) => summary.findings.filter((f) => f.ruleId === "www-resolve");

test("the bare domain serving the site too is a WWW resolve issue", async () => {
  const summary = await crawl(() => ({ status: 200, headers: { "Content-Type": "text/html" }, body: "<!doctype html><html><head><title>Same site, other host</title></head><body>Copy</body></html>" }));
  const findings = wwwResolve(summary);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].targetUrl, "https://site.test/");
  assert.match(findings[0].detail, /answers HTTP 200 instead of redirecting to https:\/\/www\.site\.test/);
});

test("a redirect to the crawled host, or no such host, is fine", async () => {
  assert.deepEqual(wwwResolve(await crawl(() => ({ status: 301, headers: { Location: "https://www.site.test/" } }))), []);
  assert.deepEqual(wwwResolve(await crawl(() => null)), []);
});
