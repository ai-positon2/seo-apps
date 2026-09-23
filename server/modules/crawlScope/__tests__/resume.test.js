const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");

// A crawl interrupted mid-way resumes from its checkpoint. Three things went
// wrong across that restart:
//   * a page in flight when the checkpoint was taken was in `seen` and in no
//     queue, so the resumed run never fetched it;
//   * so was a page whose result was produced but still buffered, unstored;
//   * the resumed run's analysis saw only the pages it fetched itself, so every
//     earlier page had no findings and the site-wide checks ran on part of it.
const page = (title, links = "") =>
  `<!doctype html><html><head><title>${title}</title><meta name="description" content="A description long enough for the resume fixture pages to pass."></head><body><h1>${title}</h1><p>${"Resume fixture words. ".repeat(40)}</p>${links}</body></html>`;

function fixture() {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const onHang = [];
  const server = http.createServer(async (request, response) => {
    const routes = {
      "/": page("Resume fixture home", '<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>'),
      // /a and /b share a title, and /a links to a page that does not exist.
      "/a": page("Shared title for the resume fixture", '<a href="/gone">Gone</a>'),
      "/b": page("Shared title for the resume fixture"),
      "/c": page("Resume fixture page C"),
    };
    if (request.url === "/c") {
      onHang.forEach((fn) => fn());
      await released;
    }
    const body = routes[request.url];
    response.statusCode = body ? 200 : 404;
    response.setHeader("Content-Type", "text/html");
    response.end(body || "<html><head><title>Not found</title></head><body>Not found</body></html>");
  });
  return { server, release, whenHanging: () => new Promise((resolve) => onHang.push(resolve)) };
}

const options = {
  maxUrls: 50, concurrency: 1, respectRobots: false, discoverSitemaps: false, crawlAssets: false,
  checkExternalLinks: false, timeout: 10_000, perHostDelay: 0,
};

test("a checkpoint keeps in-flight and unstored pages, and a resume analyses the whole crawl", async (t) => {
  const { server, release, whenHanging } = fixture();
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ── The first attempt: fetch /, /a and /b, then die while /c is in flight.
  const first = new SeoCrawler(options);
  const emitted = new Map();
  first.on("result", (result, pageEdges) => emitted.set(new URL(result.url).pathname, { result, pageEdges }));
  const hanging = whenHanging();
  const firstRun = first.start(`${base}/`);
  await hanging;
  assert.deepEqual([...emitted.keys()], ["/", "/a", "/b"]);
  assert.ok(emitted.get("/a").pageEdges.linkEdges.some((e) => e.targetUrl.endsWith("/gone")), "a page's own edges come with its result");

  // /b's row is still in the caller's write buffer.
  const checkpoint = first.snapshot({ unstoredResults: [emitted.get("/b").result] });
  const queued = checkpoint.queue.map((job) => new URL(job.url).pathname);
  assert.deepEqual(queued.slice(0, 2).sort(), ["/b", "/c"], "the in-flight and the unstored page go back first");
  assert.ok(queued.includes("/gone"));
  first.stop();
  release();
  await firstRun;

  // ── The second attempt, given what the first stored: /, /a (not /b).
  const stored = ["/", "/a"].map((path) => emitted.get(path));
  const second = new SeoCrawler(options);
  const fetched = [];
  second.on("result", (result) => fetched.push(new URL(result.url).pathname));
  assert.ok(second.restore(checkpoint, {
    storedUrls: new Set(stored.map(({ result }) => result.url)),
    results: stored.map(({ result }) => result),
    linkEdges: stored.flatMap(({ pageEdges }) => pageEdges.linkEdges),
    resourceEdges: stored.flatMap(({ pageEdges }) => pageEdges.resourceEdges),
  }));
  const summary = await second.start();
  assert.deepEqual(fetched.sort(), ["/b", "/c", "/gone"], "nothing stored is fetched again, nothing unstored is lost");
  assert.deepEqual(summary.resumed, { priorPages: 2, withoutLinkData: 0 });

  // Findings on and between pages the first attempt fetched.
  const on = (ruleId) => summary.findings.filter((f) => f.ruleId === ruleId).map((f) => new URL(f.url).pathname).sort();
  assert.deepEqual(on("broken-internal-links"), ["/a"], "the broken link on a page fetched before the restart");
  assert.deepEqual(on("title-duplicate"), ["/a", "/b"]);
  assert.equal(summary.results.find((r) => r.url.endsWith("/a")).inlinks, 1, "links from before the restart count");
});

test("a resume without the earlier pages' links says those checks were partly run", async (t) => {
  const { server, release, whenHanging } = fixture();
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = new SeoCrawler(options);
  const emitted = [];
  first.on("result", (result) => emitted.push(result));
  const hanging = whenHanging();
  const firstRun = first.start(`${base}/`);
  await hanging;
  const checkpoint = first.snapshot();
  first.stop();
  release();
  await firstRun;

  const second = new SeoCrawler(options);
  second.restore(checkpoint, {
    storedUrls: new Set(emitted.map((r) => r.url)),
    results: emitted,
    pagesWithoutEdges: emitted.length,
  });
  const summary = await second.start();
  const partly = summary.coverage.partial.map((entry) => entry.ruleId);
  assert.ok(partly.includes("broken-internal-links"));
  assert.match(summary.coverage.partial[0].reason, /interrupted and resumed/);
});
