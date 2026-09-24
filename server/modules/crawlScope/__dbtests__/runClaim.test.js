// ── One queued crawl runs once, however many executors reach for it ─────────
//
// A project's first crawl is created 'queued' with trigger 'initial' and then
// executed at once in the web process (projects/crawlAutostart.js). The worker
// claims 'initial' runs too (worker/index.js WORKER_TRIGGERS), and its claim is
// atomic — but the web path marked the run 'running' with an unguarded UPDATE.
// A worker poll landing between the INSERT and that UPDATE ran the same crawl
// twice into one run id: every page stored twice, every finding counted twice.
//
// Needs a real database: the guarantee is a Postgres row-level one. Lives
// outside __tests__ because it exits early without TEST_DATABASE_URL, and the
// crawlScope node:test suite runs every file in __tests__ in one process.
//
// Run: TEST_DATABASE_URL=postgres://... node modules/crawlScope/__dbtests__/runClaim.test.js

const assert = require("node:assert/strict");
const http = require("node:http");
require("dotenv").config({ path: require("path").join(__dirname, "../../../../.env") });
const { useTestDatabase } = require("../../../services/__tests__/helpers/testDatabase");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

if (!useTestDatabase("crawl run claim (database)")) {
  process.exit(0);
}
// The fixture site is on loopback, which the SSRF guard refuses by design.
process.env.CRAWL_ALLOW_PRIVATE_HOSTS = "true";
delete process.env.CRAWLSCOPE_AUTO_PAGESPEED;

const db = require("../../../services/db");
const repo = require("../db/repo");
const { RunManager } = require("../run/manager");
const { parseCrawlRequest } = require("../shared/options");

function site() {
  const page = (title, links = "") =>
    `<!doctype html><html><head><title>${title} of the claim fixture</title></head><body><h1>${title}</h1>${links}</body></html>`;
  return http.createServer((request, response) => {
    const routes = {
      "/": page("Home", '<a href="/a">A</a><a href="/b">B</a>'),
      "/a": page("Page A"),
      "/b": page("Page B"),
    };
    const body = routes[request.url];
    response.statusCode = body ? 200 : 404;
    response.setHeader("Content-Type", body ? "text/html" : "text/plain");
    response.end(body || "nope");
  });
}

(async () => {
  console.log("\ncrawl run claim — one execution per run\n");
  const server = site();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const email = `_runclaim_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@position2.com`;
  const user = await db.one("insert into app_users (email) values ($1) returning id", [email]);

  const newRun = async (trigger = "initial") => {
    const { url: parsedUrl, options } = parseCrawlRequest({
      url,
      options: { checkExternalLinks: false, discoverSitemaps: false, perHostDelay: 0 },
    });
    return repo.createRun(db, { owner: user.id, url: parsedUrl, options, trigger });
  };
  const count = async (table, runId) =>
    Number((await db.one(`select count(*)::int as n from ${table} where run_id = $1`, [runId])).n);

  try {
    await test("a run can be claimed from 'queued' exactly once", async () => {
      const run = await newRun();
      const first = await repo.claimRun(db, run.id);
      const second = await repo.claimRun(db, run.id);
      assert.equal(first?.status, "running");
      assert.equal(second, null);
    });

    await test("two executors racing for one queued run crawl it once", async () => {
      const run = await newRun();
      // Two managers, as the web process and the in-process worker each have.
      const web = new RunManager({ serviceClient: () => db });
      const worker = new RunManager({ serviceClient: () => db });
      const outcomes = await Promise.all([web.execute(run), worker.execute(run)]);

      assert.equal(outcomes.filter((o) => o?.skipped).length, 1, "one of the two must stand aside");
      const rows = await count("crawl_run_results", run.id);
      const distinct = Number((await db.one(
        "select count(distinct url)::int as n from crawl_run_results where run_id = $1", [run.id],
      )).n);
      assert.equal(rows, distinct, `${rows} result rows for ${distinct} URLs — pages were stored twice`);
      assert.equal(distinct, 3);
      const ran = outcomes.find((o) => !o?.skipped);
      assert.equal(await count("crawl_run_finding_instances", run.id), ran.summary.findings.length);
      const stored = await db.one("select status from crawl_runs where id = $1", [run.id]);
      assert.equal(stored.status, "completed");
    });

    await test("a run the worker already claimed is executed when handed over as claimed", async () => {
      const run = await newRun();
      const claimed = await repo.claimRun(db, run.id);
      const outcome = await new RunManager({ serviceClient: () => db }).execute(claimed, { claimed: true });
      assert.ok(!outcome?.skipped);
      assert.equal(await count("crawl_run_results", run.id), 3);
    });
  } finally {
    await db.query("delete from app_users where id = $1", [user.id]);
    server.close();
    await db.end?.();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
