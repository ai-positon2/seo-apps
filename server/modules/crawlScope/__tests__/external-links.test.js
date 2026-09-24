const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");

function listen(server, host) {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

// The site is served on 127.0.0.1; "external" destinations on localhost, which
// the crawler treats as another host.
async function crawlWithExternal(t, externalHandler, links, options = {}) {
  const external = http.createServer(externalHandler);
  t.after(() => external.close());
  const externalPort = await listen(external, "localhost");
  const site = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url !== "/") {
      response.statusCode = 404;
      response.end("nope");
      return;
    }
    const anchors = links.map((p) => `<a href="http://localhost:${externalPort}${p}">x</a>`).join("");
    response.end(`<!doctype html><html><head><title>External link fixture home</title></head><body><h1>Home</h1>${anchors}</body></html>`);
  });
  t.after(() => site.close());
  const port = await listen(site, "127.0.0.1");
  const crawler = new SeoCrawler({
    maxUrls: 5, respectRobots: false, discoverSitemaps: false, crawlAssets: false, timeout: 5_000,
    maxRetries: 0, ...options,
  });
  return crawler.start(`http://127.0.0.1:${port}/`);
}

test("an external page that answers HEAD with 404 but GET with 200 is not broken", async (t) => {
  const summary = await crawlWithExternal(t, (request, response) => {
    response.statusCode = request.method === "HEAD" ? 404 : 200;
    response.end("ok");
  }, ["/article"]);
  const checked = summary.results.find((r) => r.url.includes("/article"));
  assert.equal(checked.status, 200);
  assert.ok(!summary.findings.some((f) => f.ruleId === "broken-external-link"));
});

test("401, 429 and 999 are refusals, not broken links", async (t) => {
  const statuses = { "/login": 401, "/busy": 429, "/linkedin": 999, "/gone": 404 };
  const summary = await crawlWithExternal(t, (request, response) => {
    response.statusCode = statuses[request.url.split("?")[0]] || 200;
    response.end();
  }, Object.keys(statuses));
  const refused = summary.findings.filter((f) => f.ruleId === "external-403").map((f) => f.statusCode).sort();
  const broken = summary.findings.filter((f) => f.ruleId === "broken-external-link").map((f) => f.statusCode);
  assert.deepEqual(refused, [401, 429, 999]);
  assert.deepEqual(broken, [404]);
});

test("external links past the limit are counted as unchecked", async (t) => {
  const summary = await crawlWithExternal(t, (request, response) => {
    response.end("ok");
  }, ["/a", "/b", "/c", "/d"], { maxExternalUrls: 1 });
  assert.equal(summary.results.filter((r) => r.scope === "External").length, 1);
  assert.equal(summary.siteDiagnostics.externalLinksUnchecked, 3);
});

test("maxExternalUrls: 0 checks no external links", async (t) => {
  let hits = 0;
  const summary = await crawlWithExternal(t, (request, response) => {
    hits += 1;
    response.end("ok");
  }, ["/a", "/b"], { maxExternalUrls: 0 });
  assert.equal(hits, 0);
  assert.equal(summary.results.filter((r) => r.scope === "External").length, 0);
});
