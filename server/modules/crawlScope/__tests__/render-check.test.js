const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const { compareRendering, findBrowserExecutable } = require("../render-check");
const { SeoCrawler } = require("../crawler");

// The crawler reads served HTML. A site that adds its links and text, or
// changes its head tags, with JavaScript was audited on the HTML alone and
// read as a smaller, emptier site with nothing to say why.

const identity = {
  normalize: (url) => url,
  isInternal: (url) => url.startsWith("https://example.com/"),
  same: (a, b) => a === b,
};
const page = (extra = {}) => ({
  url: "https://example.com/", links: ["https://example.com/a", "https://example.com/b"], words: 200,
  title: "Home", metaDescription: "About us", canonical: "https://example.com/", robots: "", ...extra,
});

test("links and words that only appear after rendering, and tags a script changes", () => {
  const rendered = {
    links: [...Array.from({ length: 10 }, (_, i) => `https://example.com/p${i}`), "https://elsewhere.example/x"],
    words: 900, title: "Home | Rendered", metaDescription: "About us", canonical: "", robots: "noindex",
  };
  const kinds = compareRendering(page(), rendered, identity).map((d) => d.kind);
  assert.deepEqual(kinds, ["links", "words", "title", "robots"], "an absent rendered canonical is the page itself, as served");
});

test("a page scripts only touch lightly is not reported", () => {
  const rendered = { links: ["https://example.com/a", "https://example.com/b", "https://example.com/c"], words: 260, title: "Home", metaDescription: "About us", canonical: "https://example.com/", robots: "" };
  assert.deepEqual(compareRendering(page(), rendered, identity), []);
});

const chrome = findBrowserExecutable()
  || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((path) => fs.existsSync(path));

test("a real render: JavaScript-added links are reported, and page scripts reach nothing the crawler would not", { skip: !chrome && "no Chromium here" }, async (t) => {
  process.env.CRAWLSCOPE_CHROME_PATH = chrome;
  t.after(() => { delete process.env.CRAWLSCOPE_CHROME_PATH; });
  // A server the page's script tries to reach, standing in for an internal
  // address. The crawler's fetch refuses it, as the hosted SSRF guard would.
  let leaks = 0;
  const secret = http.createServer((request, response) => { leaks += 1; response.end("secret"); });
  await new Promise((resolve) => secret.listen(0, "127.0.0.1", resolve));
  const secretUrl = `http://127.0.0.1:${secret.address().port}/leak`;
  const site = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/") {
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Served title for the render fixture</title></head>
        <body><h1>Home</h1><a href="/a">A</a><a href="/b">B</a>
        <script>
          fetch(${JSON.stringify(secretUrl)}).catch(() => {});
          try { new WebSocket("ws://127.0.0.1:${secret.address().port}/"); } catch (e) {}
          const nav = document.createElement("nav");
          for (let i = 0; i < 12; i++) { const a = document.createElement("a"); a.href = "/js-" + i; a.textContent = "Section " + i; nav.appendChild(a); }
          document.body.appendChild(nav);
          document.title = "Rendered title for the render fixture";
        </script></body></html>`);
    } else {
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Render fixture ${request.url}</title></head><body><h1>${request.url}</h1></body></html>`);
    }
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  t.after(() => { site.close(); secret.close(); });
  let refused = 0;
  const guardedFetch = (url, init) => {
    if (String(url).startsWith(`http://127.0.0.1:${secret.address().port}`)) {
      refused += 1;
      return Promise.reject(new Error("Refusing to connect to a non-public address"));
    }
    return fetch(url, init);
  };
  const summary = await new SeoCrawler({
    maxUrls: 5, concurrency: 1, respectRobots: false, discoverSitemaps: false, crawlAssets: false,
    checkExternalLinks: false, timeout: 10_000, perHostDelay: 0, renderCheck: true, renderSampleSize: 3,
    fetch: guardedFetch,
  }).start(`http://127.0.0.1:${site.address().port}/`);

  assert.equal(summary.siteDiagnostics.renderCheck.ran, true, JSON.stringify(summary.siteDiagnostics.renderCheck));
  const finding = summary.findings.find((f) => f.ruleId === "javascript-dependent-content");
  assert.ok(finding, "the scripted page is reported");
  assert.match(finding.detail, /^JavaScript changes what 1 of \d rendered pages? show/);
  assert.match(finding.detail, /\/: links 2 → 14/);
  assert.match(finding.detail, /title "Served title for the render fixture" → "Rendered title for the render fixture"/);
  assert.ok(refused >= 1, "the page's own fetch was answered by the crawler's fetch");
  assert.equal(leaks, 0, "the page's scripts went through the crawler's fetch, which refused them");
});

test("no browser: the check is not evaluated, and says why", async (t) => {
  const site = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><html><head><title>No browser fixture home page</title></head><body>Home</body></html>");
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  t.after(() => site.close());
  const summary = await new SeoCrawler({
    maxUrls: 2, concurrency: 1, respectRobots: false, discoverSitemaps: false, crawlAssets: false,
    checkExternalLinks: false, timeout: 5_000, perHostDelay: 0, renderCheck: true, launchBrowser: async () => null,
  }).start(`http://127.0.0.1:${site.address().port}/`);
  const entry = summary.coverage.notEvaluated.find((e) => e.ruleId === "javascript-dependent-content");
  assert.match(entry.reason, /No headless browser/);
});

test("Render JavaScript: every page is audited as the browser builds it", { skip: !chrome && "no Chromium here" }, async (t) => {
  process.env.CRAWLSCOPE_CHROME_PATH = chrome;
  t.after(() => { delete process.env.CRAWLSCOPE_CHROME_PATH; });
  let documentRequests = 0;
  const site = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/") {
      documentRequests += 1;
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Served title for the rendered crawl</title>
        <script src="/app.js"></script></head><body><h1>Home</h1></body></html>`);
    } else if (request.url === "/app.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(`document.addEventListener("DOMContentLoaded", () => {
        for (const path of ["/js-a", "/js-b"]) { const a = document.createElement("a"); a.href = path; a.textContent = path; document.body.appendChild(a); }
        document.title = "Rendered title for the rendered crawl";
      });`);
    } else {
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rendered crawl page ${request.url}</title></head><body><h1>${request.url}</h1></body></html>`);
    }
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  t.after(() => site.close());
  const crawl = (renderJavaScript) => new SeoCrawler({
    maxUrls: 10, concurrency: 2, respectRobots: false, discoverSitemaps: false, crawlAssets: false,
    checkExternalLinks: false, timeout: 10_000, perHostDelay: 0, renderJavaScript,
  }).start(`http://127.0.0.1:${site.address().port}/`);

  const served = await crawl(false);
  assert.ok(!served.results.some((r) => r.url.endsWith("/js-a")), "without rendering, script-built links are invisible");

  documentRequests = 0;
  const rendered = await crawl(true);
  const home = rendered.results.find((r) => new URL(r.url).pathname === "/");
  assert.equal(home.renderedWithJavaScript, true);
  assert.equal(home.title, "Rendered title for the rendered crawl");
  assert.ok(rendered.results.some((r) => r.url.endsWith("/js-a")) && rendered.results.some((r) => r.url.endsWith("/js-b")),
    "links a script adds are crawled");
  assert.equal(documentRequests, 1, "the page was fetched once; the browser was handed that response");
  assert.equal(rendered.siteDiagnostics.renderCheck.reason, "rendered");
  assert.deepEqual(rendered.siteDiagnostics.renderJavaScript, { rendered: 3, failed: 0, available: true });
});
