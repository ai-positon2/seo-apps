// ── A crawl knows what changed since the last one ───────────────────────────
//
// Two crawls of one site by one owner. Between them a broken link is fixed,
// another appears, and a long title stays long (at a different length, so its
// detail and therefore its finding id change). The first crawl's reviewer
// marked that title a false positive.
//
// Run: TEST_DATABASE_URL=postgres://... node modules/crawlScope/__dbtests__/comparison.test.js

const assert = require("node:assert/strict");
const http = require("node:http");
require("dotenv").config({ path: require("path").join(__dirname, "../../../../.env") });
const { useTestDatabase } = require("../../../services/__tests__/helpers/testDatabase");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

if (!useTestDatabase("crawl comparison (database)")) {
  process.exit(0);
}
process.env.CRAWL_ALLOW_PRIVATE_HOSTS = "true";
delete process.env.CRAWLSCOPE_AUTO_PAGESPEED;

const db = require("../../../services/db");
const repo = require("../db/repo");
const { RunManager } = require("../run/manager");
const { parseCrawlRequest } = require("../shared/options");

(async () => {
  console.log("\ncrawl comparison — new, fixed, persisting, carried reviews\n");
  let version = 1;
  const page = (title, links = "") =>
    `<!doctype html><html><head><title>${title}</title><meta name="description" content="A description long enough for the comparison fixture pages to pass."></head><body><h1>${title}</h1><p>${"Comparison fixture words. ".repeat(40)}</p>${links}</body></html>`;
  const server = http.createServer((request, response) => {
    const routes = version === 1
      ? {
          "/": page("Comparison fixture home", '<a href="/a">A</a><a href="/b">B</a>'),
          "/a": page(`A title that is far too long for a search result to show whole ${"x".repeat(10)}`, '<a href="/gone">Gone</a>'),
          "/b": page("Comparison fixture page B"),
        }
      : {
          "/": page("Comparison fixture home", '<a href="/a">A</a><a href="/b">B</a>'),
          "/a": page(`A title that is far too long for a search result to show whole ${"x".repeat(20)}`),
          "/b": page("Comparison fixture page B", '<a href="/missing">Missing</a>'),
        };
    const body = routes[request.url];
    response.statusCode = body ? 200 : 404;
    response.setHeader("Content-Type", "text/html");
    response.end(body || "<html><head><title>Not found</title></head><body>Not found</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const email = `_compare_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@position2.com`;
  const user = await db.one("insert into app_users (email) values ($1) returning id", [email]);

  try {
    const request = parseCrawlRequest({
      url: `${base}/`,
      options: { checkExternalLinks: false, discoverSitemaps: false, perHostDelay: 0 },
    });
    const crawlOnce = async () => {
      const run = await repo.createRun(db, { owner: user.id, url: request.url, options: request.options, trigger: "manual" });
      await new RunManager({ serviceClient: () => db }).execute(run);
      return run;
    };

    const first = await crawlOnce();
    const firstFindings = await repo.listAllRunFindingInstances(db, first.id);
    const longTitle = firstFindings.find((f) => f.ruleId === "title-long" && f.url === `${base}/a`);
    assert.ok(longTitle, "fixture: the first crawl flags /a's title");
    await repo.saveFindingReviews(db, first.id, user.id, [
      { findingId: longTitle.id, ruleId: "title-long", reviewStatus: "False positive", reviewerNotes: "Product name, deliberately long" },
    ], user.id);

    version = 2;
    const second = await crawlOnce();
    const stored = await db.one("select summary from crawl_runs where id = $1", [second.id]);
    const comparison = stored.summary.comparison;

    await test("the second crawl is compared with the first", async () => {
      assert.equal(comparison.previousRunId, first.id);
      assert.deepEqual(comparison.byRule["broken-internal-links"], { new: 1, fixed: 1, persisting: 0 });
      assert.deepEqual(comparison.byRule["title-long"], { new: 0, fixed: 0, persisting: 1 });
    });

    await test("the false positive follows its issue, although its finding id changed", async () => {
      const secondFindings = await repo.listAllRunFindingInstances(db, second.id);
      const again = secondFindings.find((f) => f.ruleId === "title-long" && f.url === `${base}/a`);
      assert.notEqual(again.id, longTitle.id);
      const reviews = await repo.listFindingReviews(db, second.id);
      const carried = reviews.find((r) => r.finding_id === again.id);
      assert.equal(carried?.review_status, "False positive");
      assert.match(carried.reviewer_notes, /Product name, deliberately long/);
      assert.equal(comparison.carriedReviews, 1);
    });

    await test("the first crawl, with nothing before it, has no comparison", async () => {
      const firstStored = await db.one("select summary from crawl_runs where id = $1", [first.id]);
      assert.equal(firstStored.summary.comparison, null);
    });
  } finally {
    await db.query("delete from app_users where id = $1", [user.id]);
    server.close();
    await db.end?.();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
