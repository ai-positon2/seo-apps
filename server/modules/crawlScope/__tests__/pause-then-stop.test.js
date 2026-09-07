// Regression: stopping a PAUSED crawl used to wedge the run forever.
//
// _schedule() opened with a bare `if (this.paused) return`, and stop() works by
// setting `stopped`, clearing the queue and calling _schedule(). While paused,
// that call was turned away before it could reach the completion check, so the
// promise returned by start() never settled: the run row stayed 'running', no
// findings were ever written, and RunManager.shutdown() burned its entire drain
// timeout waiting on an execution that could not finish.
//
// Both buttons render for any non-terminal run (CrawlScopeRunPage), so
// "pause to think, then stop" is an ordinary user flow rather than an edge case.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

// A site with enough internal links that the crawl is still in flight when we
// pause it, so the pause lands mid-run rather than after natural completion.
function makeSite() {
  return http.createServer((request, response) => {
    const n = Number((request.url.match(/^\/p(\d+)$/) || [])[1]);
    response.statusCode = Number.isFinite(n) ? 200 : 404;
    response.setHeader("Content-Type", "text/html");
    if (!Number.isFinite(n)) return response.end("Not found");
    const links = Array.from({ length: 6 }, (_, i) => `<a href="/p${n * 6 + i + 1}">n</a>`).join("");
    response.end(
      `<!doctype html><html><head><title>Page ${n}</title>`
      + `<meta name="description" content="A sufficiently long description for the audit fixture to pass extraction checks here.">`
      + `</head><body><h1>Page ${n}</h1>${links}</body></html>`,
    );
  });
}

test("stop() resolves the crawl even when it was paused first", async (t) => {
  const server = makeSite();
  t.after(() => server.close());
  const port = await listen(server);

  const crawler = new SeoCrawler({
    maxUrls: 500,
    concurrency: 2,
    respectRobots: false,
    timeout: 5_000,
    perHostDelay: 0,
  });

  const started = crawler.start(`http://127.0.0.1:${port}/p0`);

  // Pause once the crawl is genuinely underway, then stop while still paused.
  await new Promise((resolve) => {
    let done = false;
    crawler.on("progress", () => {
      if (done) return;
      if ((crawler.results?.length || 0) >= 2) { done = true; resolve(); }
    });
    setTimeout(() => { if (!done) { done = true; resolve(); } }, 4_000).unref();
  });

  crawler.pause();
  assert.equal(crawler.paused, true, "precondition: the crawler is paused");
  crawler.stop();

  // The whole point: this must settle. Before the fix it hung until the test
  // runner's own timeout, so the race below is what actually asserts the bug.
  const summary = await Promise.race([
    started.then((s) => ({ ok: true, s })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false }), 15_000).unref()),
  ]);

  assert.equal(summary.ok, true, "start() must resolve after stop() on a paused crawl");
  assert.equal(summary.s.stopped, true, "the summary records that it was stopped");
  // A stopped run still reports what it managed to gather, rather than nothing.
  assert.ok(Array.isArray(summary.s.results), "results are present");
  assert.ok(summary.s.results.length >= 1, "the pages crawled before the stop are kept");
  assert.ok(summary.s.findings !== undefined, "findings were built for the partial crawl");
});

test("pause still holds the crawl when no stop follows", async (t) => {
  const server = makeSite();
  t.after(() => server.close());
  const port = await listen(server);

  const crawler = new SeoCrawler({
    maxUrls: 500,
    concurrency: 1,
    respectRobots: false,
    timeout: 5_000,
    perHostDelay: 0,
  });

  const started = crawler.start(`http://127.0.0.1:${port}/p0`);
  await new Promise((resolve) => {
    let done = false;
    crawler.on("progress", () => {
      if (done) return;
      if ((crawler.results?.length || 0) >= 1) { done = true; resolve(); }
    });
    setTimeout(() => { if (!done) { done = true; resolve(); } }, 4_000).unref();
  });

  crawler.pause();
  const countAtPause = crawler.results.length;

  // Idle while paused: the fix must not have turned pause into a no-op.
  await new Promise((resolve) => setTimeout(resolve, 600).unref());
  assert.ok(
    crawler.results.length <= countAtPause + 1,
    `a paused crawl must not keep dequeuing (was ${countAtPause}, now ${crawler.results.length})`,
  );

  // And it must still reach a clean finish. Bounded rather than a bare await:
  // on a regression this hangs forever, and a suite that hangs is harder to
  // diagnose (and blocks CI) than one that fails with a message.
  crawler.stop();
  const settled = await Promise.race([
    started.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 15_000).unref()),
  ]);
  assert.equal(settled, true, "start() must resolve after a pause/stop sequence");
});
