const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("list mode fetches exactly the given URLs and never follows links or redirects", async (t) => {
  const server = http.createServer((request, response) => {
    const routes = {
      "/a": [
        200,
        "text/html",
        `<!doctype html><html><head><title>Page A</title>
          <meta name="description" content="A sufficiently long description for the SEO audit fixture to pass extraction checks here.">
        </head><body><h1>A</h1><a href="/b">To B (not in list)</a></body></html>`,
      ],
      "/b": [200, "text/html", "<html><head><title>Page B</title></head><body>B</body></html>"],
      "/redirect": [302, "text/html", ""],
      "/target": [200, "text/html", "<html><head><title>Target</title></head><body>T</body></html>"],
    };
    const [status, type, body] = routes[request.url] || [404, "text/plain", "Not found"];
    response.statusCode = status;
    response.setHeader("Content-Type", type);
    if (request.url === "/redirect") response.setHeader("Location", "/target");
    response.end(body);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  const crawler = new SeoCrawler({
    maxUrls: 20,
    concurrency: 2,
    respectRobots: false,
    timeout: 5_000,
  });
  const summary = await crawler.start([`${base}/a`, `${base}/redirect`]);

  // Exactly the two given URLs were fetched — /b (linked from /a) and /target
  // (the redirect destination) must NOT have been auto-crawled.
  assert.equal(summary.results.length, 2);
  const urls = summary.results.map((r) => r.url).sort();
  assert.deepEqual(urls, [`${base}/a`, `${base}/redirect`]);

  const pageA = summary.results.find((r) => r.url === `${base}/a`);
  const redirect = summary.results.find((r) => r.url === `${base}/redirect`);
  assert.equal(pageA.status, 200);
  assert.equal(pageA.scope, "Internal");
  assert.equal(redirect.status, 302);
  assert.ok(redirect.redirectUrl.endsWith("/target"));

  // No single-site diagnostics in list mode.
  assert.equal(summary.robotsStatus, "Not checked");
});

test("list mode still applies per-page findings (missing meta description, H1)", async (t) => {
  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><html><head><title>No meta or H1</title></head><body><p>Text.</p></body></html>");
  });
  t.after(() => server.close());
  const port = await listen(server);

  const crawler = new SeoCrawler({ maxUrls: 5, respectRobots: false, timeout: 5_000 });
  const summary = await crawler.start([`http://127.0.0.1:${port}/no-meta`]);

  assert.ok(summary.findings.some((f) => f.ruleId === "meta-missing"));
  assert.ok(summary.findings.some((f) => f.ruleId === "h1-missing"));
});

test("list mode dedupes input and respects the maxUrls ceiling", async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/plain");
    response.end("ok");
  });
  t.after(() => server.close());
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  const crawler = new SeoCrawler({ maxUrls: 2, respectRobots: false, timeout: 5_000 });
  const summary = await crawler.start([`${base}/x`, `${base}/x`, `${base}/y`, `${base}/z`]);

  // /x deduped to one job; ceiling of 2 caps total jobs run.
  assert.equal(summary.results.length, 2);
});

test("start() still accepts a single URL string (spider mode unaffected)", async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end("<html><head><title>Solo</title></head><body>ok</body></html>");
  });
  t.after(() => server.close());
  const port = await listen(server);

  const crawler = new SeoCrawler({
    maxUrls: 5,
    respectRobots: false,
    discoverSitemaps: false,
    timeout: 5_000,
  });
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].scope, "Internal");
});
