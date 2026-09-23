const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");

// The canonical was the first <link rel=canonical> anywhere in the page, and
// only the first: two conflicting canonicals (a plugin's and a theme's) went
// unreported, and one in <body>, which search engines ignore, was treated as
// the page's canonical.
const head = (extra) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Canonical tags fixture page</title>${extra}</head>`;
const pages = {
  "/": `${head('<link rel="canonical" href="/">')}<body><h1>Home</h1><a href="/two">Two</a><a href="/body-only">Body</a><a href="/header">Header</a><a href="/same-twice">Same</a></body></html>`,
  "/two": `${head('<link rel="canonical" href="/two"><link rel="canonical" href="/other">')}<body><h1>Two canonicals</h1></body></html>`,
  "/body-only": `${head("")}<body><h1>Body canonical</h1><link rel="canonical" href="/elsewhere"></body></html>`,
  "/same-twice": `${head('<link rel="canonical" href="/same-twice"><link rel="canonical" href="/same-twice#top">')}<body><h1>Same</h1></body></html>`,
  "/header": `${head('<link rel="canonical" href="/header">')}<body><h1>Header conflict</h1></body></html>`,
};

test("canonicals come from <head>; conflicting ones and ones in <body> are reported", async (t) => {
  const server = http.createServer((request, response) => {
    const body = pages[request.url];
    if (request.url === "/header") response.setHeader("Link", '</header-alt>; rel="canonical"');
    response.statusCode = body ? 200 : 404;
    response.setHeader("Content-Type", "text/html");
    response.end(body || "<html><head><title>Not found</title></head><body>Not found</body></html>");
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const summary = await new SeoCrawler({
    maxUrls: 20, concurrency: 1, respectRobots: false, discoverSitemaps: false, crawlAssets: false,
    checkExternalLinks: false, timeout: 5_000, perHostDelay: 0,
  }).start(`${base}/`);
  const result = (path) => summary.results.find((r) => r.url === `${base}${path}`);
  const on = (ruleId) => summary.findings.filter((f) => f.ruleId === ruleId).map((f) => new URL(f.url).pathname).sort();

  assert.equal(result("/body-only").canonical, `${base}/body-only`, "a <body> canonical is not the page's canonical");
  assert.deepEqual(on("canonical-outside-head"), ["/body-only"]);
  assert.deepEqual(on("multiple-canonical"), ["/header", "/two"], "an HTML and a Link-header canonical that disagree conflict too");
  const two = summary.findings.find((f) => f.ruleId === "multiple-canonical" && f.url.endsWith("/two"));
  assert.match(two.detail, /2 different canonical URLs/);
});
