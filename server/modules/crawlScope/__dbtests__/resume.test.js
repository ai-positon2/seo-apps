// ── A resumed run analyses every page its interrupted attempt stored ────────
//
// The first attempt is played by hand: a crawler fetches three pages, their rows
// are stored the way the run manager stores them (with each page's own edges),
// and the checkpoint is taken while a fourth page is in flight, as the
// heartbeat would. Then the run manager executes the run, which must reload
// those rows and finish the crawl without fetching a stored page again.
//
// Run: TEST_DATABASE_URL=postgres://... node modules/crawlScope/__dbtests__/resume.test.js

const assert = require("node:assert/strict");
const http = require("node:http");
require("dotenv").config({ path: require("path").join(__dirname, "../../../../.env") });
const { useTestDatabase } = require("../../../services/__tests__/helpers/testDatabase");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

if (!useTestDatabase("crawl resume (database)")) {
  process.exit(0);
}
process.env.CRAWL_ALLOW_PRIVATE_HOSTS = "true";
delete process.env.CRAWLSCOPE_AUTO_PAGESPEED;

const db = require("../../../services/db");
const repo = require("../db/repo");
const { RunManager, resultRow } = require("../run/manager");
const { SeoCrawler } = require("../crawler");
const { parseCrawlRequest } = require("../shared/options");

(async () => {
  console.log("\ncrawl resume — the whole crawl is analysed\n");
  const page = (title, links = "") =>
    `<!doctype html><html><head><title>${title}</title><meta name="description" content="A description long enough for the resume fixture pages to pass."></head><body><h1>${title}</h1><p>${"Resume fixture words. ".repeat(40)}</p>${links}</body></html>`;
  let hold = true;
  let onHang = null;
  const waiting = [];
  const server = http.createServer(async (request, response) => {
    const routes = {
      "/": page("Resume fixture home", '<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>'),
      "/a": page("Shared title for the resume fixture", '<a href="/gone">Gone</a>'),
      "/b": page("Shared title for the resume fixture"),
      "/c": page("Resume fixture page C"),
    };
    if (request.url === "/c" && hold) {
      onHang?.();
      await new Promise((resolve) => waiting.push(resolve));
    }
    const body = routes[request.url];
    response.statusCode = body ? 200 : 404;
    response.setHeader("Content-Type", "text/html");
    response.end(body || "<html><head><title>Not found</title></head><body>Not found</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const email = `_resume_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@position2.com`;
  const user = await db.one("insert into app_users (email) values ($1) returning id", [email]);

  try {
    const { url, options } = parseCrawlRequest({
      url: `${base}/`,
      options: { checkExternalLinks: false, discoverSitemaps: false, perHostDelay: 0, concurrency: 1 },
    });
    const run = await repo.createRun(db, { owner: user.id, url, options, trigger: "manual" });

    // ── First attempt, interrupted with /c in flight.
    const withEdges = await repo.resultEdgesSupported(db);
    assert.ok(withEdges, "migration 0031 is applied to the test database");
    const first = new SeoCrawler({ ...options, concurrency: 1 });
    const rows = [];
    first.on("result", (result, pageEdges) => rows.push(resultRow(run, result, pageEdges, { withEdges })));
    const hanging = new Promise((resolve) => { onHang = resolve; });
    const firstRun = first.start(url);
    await hanging;
    await repo.insertResults(db, rows);
    const checkpoint = first.snapshot();
    first.stop();
    hold = false;
    waiting.forEach((resolve) => resolve());
    await firstRun;
    await repo.updateRun(db, run.id, { status: "queued", checkpoint });

    // ── The resumed run.
    await new RunManager({ serviceClient: () => db }).execute(run);

    await test("every page is stored once: nothing refetched, nothing lost", async () => {
      const stored = await db.rows("select url from crawl_run_results where run_id = $1 order by url", [run.id]);
      assert.deepEqual(stored.map((r) => r.url.slice(base.length)), ["/", "/a", "/b", "/c", "/gone"]);
    });

    await test("findings cover the pages fetched before the interruption", async () => {
      const findings = await repo.listAllRunFindingInstances(db, run.id);
      const on = (ruleId) => findings.filter((f) => f.ruleId === ruleId).map((f) => f.url.slice(base.length)).sort();
      assert.deepEqual(on("broken-internal-links"), ["/a"]);
      assert.deepEqual(on("title-duplicate"), ["/a", "/b"]);
    });

    await test("the run says it was resumed, and its page edges are cleared", async () => {
      const stored = await db.one("select status, summary from crawl_runs where id = $1", [run.id]);
      assert.equal(stored.status, "completed");
      assert.deepEqual(stored.summary.resumed, { priorPages: 3, withoutLinkData: 0 });
      const left = await db.one("select count(*)::int as n from crawl_run_results where run_id = $1 and edges is not null", [run.id]);
      assert.equal(left.n, 0);
    });
  } finally {
    await db.query("delete from app_users where id = $1", [user.id]);
    server.close();
    await db.end?.();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
