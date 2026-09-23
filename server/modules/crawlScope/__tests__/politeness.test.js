const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("retries a 429 with Retry-After and then succeeds", async (t) => {
  let homeHits = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      homeHits += 1;
      if (homeHits === 1) {
        response.statusCode = 429;
        response.setHeader("Retry-After", "0");
        response.end("slow down");
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<!doctype html><html><head><title>Recovered page after backoff</title>" +
          '<meta name="description" content="A sufficiently long description for the SEO audit fixture to pass extraction checks here.">' +
          "</head><body><h1>Home</h1><p>" +
          "Content ".repeat(220) +
          "</p></body></html>",
      );
      return;
    }
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/plain");
    response.end("Not found");
  });
  t.after(() => server.close());

  const port = await listen(server);
  const logs = [];
  const crawler = new SeoCrawler({
    maxUrls: 3,
    concurrency: 1,
    respectRobots: false,
    discoverSitemaps: false,
    checkExternalLinks: false,
    crawlAssets: false,
    timeout: 5_000,
    retryBaseDelay: 100,
    maxRetries: 2,
  });
  crawler.on("log", (entry) => logs.push(entry));
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);

  const home = summary.results.find((item) => item.url.endsWith(`${port}/`));
  assert.equal(home.status, 200, "should recover to 200 after the 429");
  assert.equal(homeHits, 2, "should have retried the home page exactly once");
  assert.ok(
    logs.some((entry) => /returned 429/.test(entry.message)),
    "should log the backoff",
  );
});

test("gives up after maxRetries when a host keeps returning 503", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.statusCode = 503;
      response.end("unavailable");
      return;
    }
    response.statusCode = 404;
    response.end("nope");
  });
  t.after(() => server.close());

  const port = await listen(server);
  const crawler = new SeoCrawler({
    maxUrls: 3,
    concurrency: 1,
    respectRobots: false,
    discoverSitemaps: false,
    checkExternalLinks: false,
    crawlAssets: false,
    timeout: 5_000,
    retryBaseDelay: 50,
    maxRetries: 1,
  });
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);
  const home = summary.results.find((item) => item.url.endsWith(`${port}/`));
  assert.equal(home.status, 503, "should surface the 503 after exhausting retries");
});

// Production never passes maxRetries: shared/options.js#parseCrawlRequest has no
// such field, so the crawler's own default is the only retry budget a hosted
// crawl gets. That default used to evaluate to NaN (`Number(undefined) ?? 2`),
// and `attempt < NaN` is always false — every 429/503 and every reset connection
// became a permanent error on the first try. Every test above passes maxRetries
// explicitly, which is exactly why none of them could see it.
test("retries with the default budget when maxRetries is not passed", async (t) => {
  let hits = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      hits += 1;
      if (hits === 1) {
        response.statusCode = 503;
        response.setHeader("Retry-After", "0");
        response.end("busy");
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><html><head><title>Recovered</title></head><body><h1>Ok</h1></body></html>");
      return;
    }
    response.statusCode = 404;
    response.end("nope");
  });
  t.after(() => server.close());

  const port = await listen(server);
  const crawler = new SeoCrawler({
    maxUrls: 3,
    concurrency: 1,
    respectRobots: false,
    discoverSitemaps: false,
    checkExternalLinks: false,
    crawlAssets: false,
    timeout: 5_000,
    retryBaseDelay: 100,
  });
  assert.equal(crawler.options.maxRetries, 2, "the documented default budget is 2 retries");
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);
  const home = summary.results.find((item) => item.url.endsWith(`${port}/`));
  assert.equal(home.status, 200, "a single 503 must be retried, not recorded as a server error");
  assert.equal(hits, 2);
});

test("an explicit maxRetries of 0 still disables retries", () => {
  const crawler = new SeoCrawler({ maxRetries: 0 });
  assert.equal(crawler.options.maxRetries, 0);
});
