// Regression: pressing Stop made no visible change, and the crawl looked like
// it carried on.
//
// crawler.stop() did halt fetching, but the run row went on reading 'running'
// with progress frozen until the partial audit was written — minutes, on a
// large site — so the page watching it could not tell a stopped crawl from one
// that had ignored the button. The crawl now reports progress.phase, and the
// run manager writes it the moment it changes, ahead of the terminal write.
//
// Also covered: a pause or resume arriving after a stop must not write
// 'paused' / 'running' over a crawl on its way to 'stopped'.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");
const repo = require("../db/repo");
const { RunManager } = require("../run/manager");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

// Six links a page, so the crawl is still in flight when it is stopped.
function makeSite() {
  return http.createServer((request, response) => {
    const n = Number((request.url.match(/^\/p(\d+)$/) || [])[1]);
    response.statusCode = Number.isFinite(n) ? 200 : 404;
    response.setHeader("Content-Type", "text/html");
    if (!Number.isFinite(n)) return response.end("Not found");
    const links = Array.from({ length: 6 }, (_, i) => `<a href="/p${n * 6 + i + 1}">n</a>`).join("");
    response.end(`<!doctype html><html><head><title>Page ${n}</title></head><body><h1>Page ${n}</h1>${links}</body></html>`);
  });
}

function waitFor(predicate, ms = 4_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (predicate() || Date.now() - started > ms) return resolve();
      setTimeout(tick, 20).unref();
    };
    tick();
  });
}

const OPTIONS = { maxUrls: 500, concurrency: 2, respectRobots: false, timeout: 5_000, perHostDelay: 0 };

test("the crawler reports its phase, and ignores pause/resume once stopped", async (t) => {
  const server = makeSite();
  t.after(() => server.close());
  const port = await listen(server);

  const crawler = new SeoCrawler(OPTIONS);
  const states = [];
  crawler.on("state", (s) => states.push(s.state));
  const started = crawler.start(`http://127.0.0.1:${port}/p0`);
  await waitFor(() => crawler.results.length >= 2);

  assert.equal(crawler._progress().phase, undefined, "no phase while crawling");
  crawler.stop();
  assert.equal(crawler._progress().phase, "stopping");

  crawler.pause();
  crawler.resume();
  assert.equal(crawler.paused, false, "a pause after a stop is ignored");
  assert.ok(!states.includes("paused") && !states.includes("running"), `no pause/resume state emitted: ${states}`);

  const summary = await started;
  assert.equal(summary.stopped, true);
});

test("a crawl that finishes on its own reports that it is analysing", async (t) => {
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><html><head><title>Only page</title></head><body><h1>Hi</h1></body></html>");
  });
  t.after(() => server.close());
  const port = await listen(server);

  const crawler = new SeoCrawler(OPTIONS);
  const phases = [];
  crawler.on("state", (s) => {
    if (s.state === "finishing") phases.push(crawler._progress().phase);
  });
  await crawler.start(`http://127.0.0.1:${port}/`);
  assert.deepEqual(phases, ["analysing"]);
});

test("RunManager writes the stopping phase before the terminal status", async (t) => {
  const server = makeSite();
  t.after(() => server.close());
  const port = await listen(server);

  const previousPrivate = process.env.CRAWL_ALLOW_PRIVATE_HOSTS;
  process.env.CRAWL_ALLOW_PRIVATE_HOSTS = "true";
  t.after(() => {
    if (previousPrivate === undefined) delete process.env.CRAWL_ALLOW_PRIVATE_HOSTS;
    else process.env.CRAWL_ALLOW_PRIVATE_HOSTS = previousPrivate;
  });

  // Every write the manager makes to the run row, in order.
  const updates = [];
  let stored = 0;
  const stubs = {
    resultEdgesSupported: async () => false,
    updateRun: async (_db, _id, patch) => { updates.push(patch); return {}; },
    readControlRequest: async () => null,
    clearControlRequest: async () => {},
    insertResults: async (_db, rows) => { stored += rows.length; },
    insertFindings: async () => {},
    insertRunFindingInstances: async () => {},
    previousComparableRun: async () => null,
    insertRunLinksStreaming: async () => 0,
    clearResultEdges: async () => {},
    patchResultCategories: async () => {},
    upsertPageCategories: async () => {},
    patchResultData: async () => {},
    lockRun: async () => null,
  };
  const originals = {};
  for (const [name, fn] of Object.entries(stubs)) {
    originals[name] = repo[name];
    repo[name] = fn;
  }
  t.after(() => Object.assign(repo, originals));

  const db = { tx: async (fn) => fn(db), rows: async () => [], maybeOne: async () => null, query: async () => ({}) };
  const manager = new RunManager({ serviceClient: () => db });
  const run = {
    id: "run-stop-visible",
    owner: "owner",
    workspace_id: null,
    project_id: null,
    url: `http://127.0.0.1:${port}/p0`,
    options: OPTIONS,
  };

  const execution = manager.execute(run, { claimed: true });
  await waitFor(() => manager.isActive(run.id) && manager.crawlers.get(run.id).results.length >= 3);

  assert.equal(manager.stop(run.id), true, "the stop is applied in this process");
  manager.pause(run.id);
  await execution;

  const stoppingAt = updates.findIndex((u) => u.progress?.phase === "stopping");
  const terminalAt = updates.findIndex((u) => u.status === "stopped");
  assert.ok(stoppingAt >= 0, "the stopping phase was written to the run");
  assert.ok(terminalAt > stoppingAt, "and before the terminal status");
  assert.ok(!updates.some((u) => u.status === "paused"), "a pause after the stop wrote nothing");
  assert.ok(stored >= 3, "the pages crawled before the stop were stored");
});
