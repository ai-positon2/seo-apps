// How a run ends when it is not simply crawled to the end: a deploy, a pause
// held too long, a resume, the long write after the last page, and the
// requests a rendered page makes.
//
//   * A deploy ran the whole analysis of the half-finished crawl before it
//     could requeue it, which on a large site outlasted the drain window.
//   * A list crawl caught by a deploy was finished as "stopped", for good.
//   * A pause held past MAX_PAUSE_MS was requeued, and a worker picked it up
//     and carried on crawling a site the user had paused.
//   * No heartbeat was written while the findings were stored, so on a large
//     crawl the reaper requeued a run that was still writing them.
//   * A resume lost the links of pages queued at the checkpoint and stored
//     after it.
//   * A rendered page's requests lost the page's deadline and were retried.

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

// Six links a page and a short delay per response, so a crawl is still in
// flight when it is interrupted.
function makeSite({ delayMs = 15 } = {}) {
  return http.createServer((request, response) => {
    const n = Number((request.url.match(/^\/p(\d+)$/) || [])[1]);
    setTimeout(() => {
      response.statusCode = Number.isFinite(n) ? 200 : 404;
      response.setHeader("Content-Type", "text/html");
      if (!Number.isFinite(n)) return response.end("Not found");
      const links = Array.from({ length: 6 }, (_, i) => `<a href="/p${n * 6 + i + 1}">n</a>`).join("");
      response.end(`<!doctype html><html><head><title>Page ${n}</title></head><body><h1>Page ${n}</h1>${links}</body></html>`);
    }, delayMs);
  });
}

function waitFor(predicate, ms = 5_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (predicate() || Date.now() - started > ms) return resolve();
      setTimeout(tick, 10).unref();
    };
    tick();
  });
}

const OPTIONS = { maxUrls: 500, concurrency: 2, respectRobots: false, discoverSitemaps: false, timeout: 5_000, perHostDelay: 0 };

// The run manager against a recording stand-in for the database.
function harness(t, { insertFindings = async () => {} } = {}) {
  const previousPrivate = process.env.CRAWL_ALLOW_PRIVATE_HOSTS;
  process.env.CRAWL_ALLOW_PRIVATE_HOSTS = "true";
  t.after(() => {
    if (previousPrivate === undefined) delete process.env.CRAWL_ALLOW_PRIVATE_HOSTS;
    else process.env.CRAWL_ALLOW_PRIVATE_HOSTS = previousPrivate;
  });
  const calls = { updates: [], parked: [], restarted: [], findings: 0, cleared: [] };
  const stubs = {
    resultEdgesSupported: async () => false,
    updateRun: async (_db, _id, patch) => { calls.updates.push(patch); return {}; },
    readControlRequest: async () => null,
    readRunControl: async () => ({ exists: true, request: null }),
    clearControlRequest: async (_db, _id, request) => { calls.cleared.push(request); },
    deleteRunCompletion: async () => {},
    insertResults: async () => {},
    insertFindings: async (...args) => { calls.findings += 1; return insertFindings(...args); },
    insertRunFindingInstances: async () => {},
    previousComparableRun: async () => null,
    insertRunLinksStreaming: async () => 0,
    clearResultEdges: async () => {},
    patchResultCategories: async () => {},
    upsertPageCategories: async () => {},
    patchResultData: async () => {},
    lockRun: async () => null,
    parkRun: async (_db, id, { checkpoint }) => { calls.parked.push({ id, checkpoint }); },
    restartRun: async (_db, id) => { calls.restarted.push(id); },
  };
  const originals = {};
  for (const [name, fn] of Object.entries(stubs)) {
    originals[name] = repo[name];
    repo[name] = fn;
  }
  t.after(() => Object.assign(repo, originals));
  const db = { tx: async (fn) => fn(db), rows: async () => [], maybeOne: async () => null, query: async () => ({}) };
  return { db, calls };
}

test("a deploy requeues a crawl from its checkpoint without analysing it first", async (t) => {
  const server = makeSite();
  t.after(() => server.close());
  const port = await listen(server);
  const { db, calls } = harness(t);
  const manager = new RunManager({ serviceClient: () => db });
  const run = { id: "run-deploy", owner: "o", url: `http://127.0.0.1:${port}/p0`, options: OPTIONS };

  const execution = manager.execute(run, { claimed: true });
  await waitFor(() => manager.crawlers.get(run.id)?.results.length >= 3);
  await manager.shutdown({ timeoutMs: 5_000 });
  const result = await execution;

  assert.equal(result.requeued, true);
  assert.equal(result.summary.abandoned, true, "the partial crawl was not analysed");
  assert.equal(calls.findings, 0, "no findings were written for an interrupted crawl");
  const requeue = calls.updates.find((u) => u.status === "queued");
  assert.equal(requeue?.checkpoint?.version, 1, "back on the queue with its frontier");
  assert.ok(requeue.checkpoint.queue.length || requeue.checkpoint.candidates.length, "and the frontier is not empty");
  assert.ok(!calls.updates.some((u) => u.status === "stopped"), "never finished as stopped");
});

test("a list crawl caught by a deploy starts over instead of ending as stopped", async (t) => {
  const server = makeSite({ delayMs: 40 });
  t.after(() => server.close());
  const port = await listen(server);
  const { db, calls } = harness(t);
  const manager = new RunManager({ serviceClient: () => db });
  const urls = Array.from({ length: 30 }, (_, i) => `http://127.0.0.1:${port}/p${i}`);
  const run = { id: "run-list-deploy", owner: "o", url: "List crawl (30 URLs)", options: { ...OPTIONS, urls } };

  const execution = manager.execute(run, { claimed: true });
  await waitFor(() => manager.crawlers.get(run.id)?.results.length >= 2);
  await manager.shutdown({ timeoutMs: 5_000 });
  const result = await execution;

  assert.equal(result.requeued, true);
  assert.deepEqual(calls.restarted, [run.id], "requeued to start over, its rows cleared");
  assert.equal(calls.findings, 0);
  assert.ok(!calls.updates.some((u) => u.status === "stopped"));
});

test("a pause held too long parks the run as paused instead of resuming it", async (t) => {
  const server = makeSite();
  t.after(() => server.close());
  const port = await listen(server);
  const { db, calls } = harness(t);
  const manager = new RunManager({ serviceClient: () => db, heartbeatMs: 20, maxPauseMs: 60 });
  const run = { id: "run-pause", owner: "o", url: `http://127.0.0.1:${port}/p0`, options: OPTIONS };

  const execution = manager.execute(run, { claimed: true });
  await waitFor(() => manager.crawlers.get(run.id)?.results.length >= 3);
  manager.pause(run.id);
  const result = await execution;

  assert.equal(result.requeued, true);
  assert.equal(result.parked, true);
  assert.equal(calls.parked.length, 1);
  assert.equal(calls.parked[0].checkpoint?.version, 1, "parked with its frontier, ready to resume");
  assert.ok(!calls.updates.some((u) => u.status === "queued"), "not put back on the queue");
  assert.equal(calls.findings, 0);
});

test("a run keeps heart-beating while its findings are stored", async (t) => {
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><html><head><title>Only page</title></head><body><h1>Hi</h1></body></html>");
  });
  t.after(() => server.close());
  const port = await listen(server);
  let storing = false;
  const { db, calls } = harness(t, {
    insertFindings: async () => {
      storing = true;
      await new Promise((resolve) => setTimeout(resolve, 150));
      storing = false;
    },
  });
  const beatsWhileStoring = [];
  const updateRun = repo.updateRun;
  repo.updateRun = async (client, id, patch, options) => {
    if (storing && patch.heartbeat_at) beatsWhileStoring.push(patch);
    return updateRun(client, id, patch, options);
  };
  const manager = new RunManager({ serviceClient: () => db, heartbeatMs: 20 });
  const run = { id: "run-liveness", owner: "o", url: `http://127.0.0.1:${port}/`, options: OPTIONS };

  await manager.execute(run, { claimed: true });

  assert.ok(beatsWhileStoring.length >= 2, `heartbeats while storing: ${beatsWhileStoring.length}`);
  assert.ok(beatsWhileStoring.every((patch) => !("checkpoint" in patch)), "liveness only, no checkpoint");
  assert.ok(calls.updates.some((u) => u.status === "completed"));
  const count = calls.updates.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.updates.length, count, "nothing written after the terminal status");
});

test("a stop waiting on the row when the run is claimed is applied at once", async (t) => {
  const server = makeSite();
  t.after(() => server.close());
  const port = await listen(server);
  const { db, calls } = harness(t);
  const manager = new RunManager({ serviceClient: () => db });
  const run = {
    id: "run-pending-stop", owner: "o", url: `http://127.0.0.1:${port}/p0`, options: OPTIONS, control_request: "stop",
  };

  const result = await manager.execute(run, { claimed: true });

  assert.equal(result.summary.stopped, true);
  assert.ok(result.summary.results.length <= 3, `fetched ${result.summary.results.length} pages after a stop`);
  assert.deepEqual(calls.cleared, ["stop"]);
  assert.ok(calls.updates.some((u) => u.status === "stopped"));
});

test("a parked run is paused with no executor", () => {
  assert.equal(repo.isParkedRun({ status: "paused", heartbeat_at: null, started_at: null }), true);
  assert.equal(repo.isParkedRun({ status: "paused", heartbeat_at: "2026-09-28T00:00:00Z", started_at: "2026-09-28T00:00:00Z" }), false);
  assert.equal(repo.isParkedRun({ status: "queued", heartbeat_at: null, started_at: null }), false);
});

test("an abandoned crawl settles without its analysis", async (t) => {
  const server = makeSite();
  t.after(() => server.close());
  const port = await listen(server);
  const crawler = new SeoCrawler(OPTIONS);
  const started = crawler.start(`http://127.0.0.1:${port}/p0`);
  await waitFor(() => crawler.results.length >= 3);
  crawler.stop({ abandon: true });
  const summary = await started;
  assert.equal(summary.abandoned, true);
  assert.deepEqual(summary.findings, []);
});

test("a resume follows the links of a page queued at the checkpoint and stored after it", async (t) => {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let onHang;
  const hanging = new Promise((resolve) => { onHang = resolve; });
  const page = (title, links = "") =>
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${links}</body></html>`;
  const routes = {
    "/": page("Home", '<a href="/a">A</a><a href="/c">C</a>'),
    "/a": page("A"),
    "/c": page("C", '<a href="/d">D</a>'),
    "/d": page("D"),
  };
  const server = http.createServer(async (request, response) => {
    if (request.url === "/c") {
      onHang();
      await released;
    }
    response.statusCode = routes[request.url] ? 200 : 404;
    response.setHeader("Content-Type", "text/html");
    response.end(routes[request.url] || "Not found");
  });
  t.after(() => server.close());
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const options = { ...OPTIONS, concurrency: 1, checkExternalLinks: false, crawlAssets: false };

  // The first attempt: checkpoint while /c is in flight, then /c is stored.
  const first = new SeoCrawler(options);
  const emitted = new Map();
  first.on("result", (result, pageEdges) => {
    emitted.set(new URL(result.url).pathname, { result, pageEdges });
    if (result.url.endsWith("/c")) first.stop();
  });
  const firstRun = first.start(`${base}/`);
  await hanging;
  const checkpoint = first.snapshot();
  release();
  await firstRun;
  assert.ok(emitted.has("/c"), "/c was stored after the checkpoint");
  assert.ok(!emitted.has("/d"));

  const stored = [...emitted.values()];
  const second = new SeoCrawler(options);
  const fetched = [];
  second.on("result", (result) => fetched.push(new URL(result.url).pathname));
  assert.ok(second.restore(checkpoint, {
    storedUrls: new Set(stored.map(({ result }) => result.url)),
    results: stored.map(({ result }) => result),
    linkEdges: stored.flatMap(({ pageEdges }) => pageEdges?.linkEdges || []),
    resourceEdges: stored.flatMap(({ pageEdges }) => pageEdges?.resourceEdges || []),
  }));
  await second.start();
  assert.deepEqual(fetched, ["/d"], "the link on /c is followed, and nothing stored is fetched again");
});

test("a rendered page's requests keep the page's deadline and are not retried", async () => {
  const seen = [];
  const crawler = new SeoCrawler({
    ...OPTIONS,
    fetch: async (url, init) => {
      seen.push(init.signal);
      return new Response("busy", { status: 503 });
    },
  });
  crawler.hostname = "example.com";
  const pageDeadline = new AbortController();
  const response = await crawler._renderFetch()("https://cdn.example.net/app.js", { signal: pageDeadline.signal });

  assert.equal(response.status, 503);
  assert.equal(seen.length, 1, "a 503 is not retried for a rendered page");
  assert.ok(crawler._hostState.get("cdn.example.net").delayMs > 0, "but the host is still slowed down");
  pageDeadline.abort();
  assert.equal(seen[0].aborted, true, "the page giving up aborts its request");
});
