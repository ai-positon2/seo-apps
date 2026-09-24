const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

// responseTime is a measurement of the SERVER. It used to start before
// _politeFetch, so it also counted the time a request spent waiting for its
// per-host politeness slot. With the worker's settings (500ms per host,
// concurrency 4) every request waits roughly 2s for its slot, so a server that
// answered instantly was reported as a 2,000ms "slow page" on nearly every URL.
test("responseTime excludes the per-host politeness wait", async (t) => {
  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><html><head><title>Fast page</title></head><body><h1>Fast</h1></body></html>");
  });
  t.after(() => server.close());
  const port = await listen(server);

  const urls = [...Array(6).keys()].map((i) => `http://127.0.0.1:${port}/p${i}`);
  const crawler = new SeoCrawler({
    maxUrls: urls.length,
    concurrency: 4,
    perHostDelay: 500,
    respectRobots: false,
    discoverSitemaps: false,
    checkExternalLinks: false,
    crawlAssets: false,
    timeout: 5_000,
  });
  const summary = await crawler.start(urls);

  assert.equal(summary.results.length, urls.length);
  for (const result of summary.results) {
    assert.ok(
      result.responseTime < 400,
      `${result.url} reported ${result.responseTime}ms for an instant response`,
    );
  }
  assert.equal(summary.findings.filter((f) => f.ruleId === "slow-page").length, 0);
});

test("responseTime still reports a genuinely slow server", async (t) => {
  const server = http.createServer((request, response) => {
    setTimeout(() => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><html><head><title>Slow page</title></head><body><h1>Slow</h1></body></html>");
    }, 1_200);
  });
  t.after(() => server.close());
  const port = await listen(server);

  const crawler = new SeoCrawler({
    maxUrls: 1,
    concurrency: 1,
    respectRobots: false,
    discoverSitemaps: false,
    checkExternalLinks: false,
    crawlAssets: false,
    timeout: 5_000,
  });
  const summary = await crawler.start([`http://127.0.0.1:${port}/slow`]);
  const [result] = summary.results;
  assert.ok(result.responseTime >= 1_100, `expected ~1200ms, got ${result.responseTime}`);
  assert.equal(summary.findings.filter((f) => f.ruleId === "slow-page").length, 1);
});
