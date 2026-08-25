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
