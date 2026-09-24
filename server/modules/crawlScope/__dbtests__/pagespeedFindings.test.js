// ── PageSpeed Insights results become Core Web Vitals findings ──────────────
//
// A finished crawl of three pages; PageSpeed results then land on its pages the
// way the post-crawl sample and the report's per-page check store them. Each
// landing replaces the run's Core Web Vitals findings, and keeps the run's
// counts, ordering and coverage in step with them.
//
// Run: TEST_DATABASE_URL=postgres://... node modules/crawlScope/__dbtests__/pagespeedFindings.test.js

const assert = require("node:assert/strict");
const http = require("node:http");
require("dotenv").config({ path: require("path").join(__dirname, "../../../../.env") });
const { useTestDatabase } = require("../../../services/__tests__/helpers/testDatabase");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

if (!useTestDatabase("Core Web Vitals findings (database)")) {
  process.exit(0);
}
process.env.CRAWL_ALLOW_PRIVATE_HOSTS = "true";
delete process.env.CRAWLSCOPE_AUTO_PAGESPEED;

const db = require("../../../services/db");
const repo = require("../db/repo");
const { RunManager } = require("../run/manager");
const { refreshPageSpeedFindings, CWV_RULES } = require("../run/pagespeed-findings");
const { parseCrawlRequest } = require("../shared/options");

const fieldPsi = (metrics) => ({
  mobile: { lcpMs: 1500, cls: "0.02", field: { scope: "page", overall: "SLOW", metrics } },
  desktop: { lcpMs: 900, cls: "0.01", field: null },
  checkedAt: new Date().toISOString(),
});
const labPsi = ({ lcpMs, cls }) => ({
  mobile: { lcpMs, cls, field: null },
  desktop: { lcpMs: 900, cls: "0.01", field: null },
  checkedAt: new Date().toISOString(),
});

(async () => {
  console.log("\nCore Web Vitals findings — from stored PageSpeed Insights results\n");
  const page = (title, links = "") =>
    `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="A description long enough for the PageSpeed fixture pages to pass."></head><body><h1>${title}</h1><p>${"PageSpeed fixture words. ".repeat(40)}</p>${links}</body></html>`;
  const routes = {
    "/": page("PageSpeed fixture home", '<a href="/slow">Slow</a><a href="/b">B</a>'),
    "/slow": page("PageSpeed fixture slow page"),
    "/b": page("PageSpeed fixture page B"),
  };
  const server = http.createServer((request, response) => {
    const body = routes[request.url];
    response.statusCode = body ? 200 : 404;
    response.setHeader("Content-Type", "text/html");
    response.end(body || "<html><head><title>Not found</title></head><body>Not found</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const email = `_cwv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@position2.com`;
  const user = await db.one("insert into app_users (email) values ($1) returning id", [email]);

  const summaryOf = async (runId) => (await db.one("select summary from crawl_runs where id = $1", [runId])).summary;
  const cwvInstances = async (runId) =>
    (await repo.listAllRunFindingInstances(db, runId))
      .filter((f) => CWV_RULES.includes(f.ruleId))
      .map((f) => `${f.ruleId}@${new URL(f.url).pathname}`)
      .sort();
  const cwvRollup = async (runId) =>
    Object.fromEntries((await repo.listRunFindingRollup(db, runId))
      .filter((row) => CWV_RULES.includes(row.rule_id))
      .map((row) => [row.rule_id, row.count]));

  try {
    const request = parseCrawlRequest({
      url: `${base}/`,
      options: { checkExternalLinks: false, discoverSitemaps: false, perHostDelay: 0, renderCheck: false },
    });
    const crawlOnce = async () => {
      const run = await repo.createRun(db, { owner: user.id, url: request.url, options: request.options, trigger: "manual" });
      await new RunManager({ serviceClient: () => db }).execute(run);
      return run;
    };

    const first = await crawlOnce();
    const before = await summaryOf(first.id);
    assert.ok(Array.isArray(before.ruleOrder), "fixture: the crawl stored its rule order");

    await test("a page poor for real users becomes a finding on that page, counted in the run", async () => {
      await repo.updateResultPagespeed(db, first.id, `${base}/slow`, fieldPsi({ lcp: "SLOW", cls: "FAST", inp: "FAST" }));
      const outcome = await refreshPageSpeedFindings(db, first.id);
      assert.equal(outcome.checked, 1);
      assert.deepEqual(await cwvInstances(first.id), ["cwv-lcp-poor@/slow"]);
      assert.deepEqual(await cwvRollup(first.id), { "cwv-lcp-poor": 1 });
      const after = await summaryOf(first.id);
      assert.equal(after.counts.warning, before.counts.warning + 1);
      assert.equal(after.findingsCount, before.findingsCount + 1);
    });

    await test("it takes its place in the run's order, and coverage says how many pages were checked", async () => {
      const after = await summaryOf(first.id);
      const order = after.ruleOrder;
      assert.deepEqual(order.map((row) => row.rank), order.map((_, index) => index + 1));
      const lcp = order.find((row) => row.ruleId === "cwv-lcp-poor");
      assert.ok(lcp, "the new rule is in the order");
      const firstNotice = order.find((row) => row.severity === "notice");
      if (firstNotice) assert.ok(lcp.rank < firstNotice.rank, "a warning ranks above every notice");
      const partial = after.coverage.partial.find((entry) => entry.ruleId === "cwv-lcp-poor");
      assert.match(partial.reason, /Checked on the 1 page with a PageSpeed Insights result, of 3 crawled/);
    });

    await test("a later result replaces the earlier findings instead of adding to them", async () => {
      await repo.updateResultPagespeed(db, first.id, `${base}/slow`, fieldPsi({ lcp: "FAST", cls: "FAST", inp: "FAST" }));
      await repo.updateResultPagespeed(db, first.id, `${base}/b`, labPsi({ lcpMs: 5200, cls: "0.31" }));
      await refreshPageSpeedFindings(db, first.id);
      assert.deepEqual(await cwvInstances(first.id), ["cwv-cls-poor@/b", "cwv-lcp-poor@/b"]);
      assert.deepEqual(await cwvRollup(first.id), { "cwv-cls-poor": 1, "cwv-lcp-poor": 1 });
      const after = await summaryOf(first.id);
      assert.equal(after.counts.warning, before.counts.warning + 2);
      assert.equal(after.findingsCount, before.findingsCount + 2);
      assert.match(after.coverage.partial.find((entry) => entry.ruleId === "cwv-cls-poor").reason, /the 2 pages/);
    });

    await test("refreshing again with nothing new changes nothing", async () => {
      const once = await summaryOf(first.id);
      await refreshPageSpeedFindings(db, first.id);
      assert.deepEqual(await cwvInstances(first.id), ["cwv-cls-poor@/b", "cwv-lcp-poor@/b"]);
      const twice = await summaryOf(first.id);
      assert.deepEqual(twice.counts, once.counts);
      assert.equal(twice.findingsCount, once.findingsCount);
      assert.deepEqual(twice.ruleOrder, once.ruleOrder);
    });

    await test("a run that has not finished is left alone until it does", async () => {
      const queued = await repo.createRun(db, { owner: user.id, url: `${base}/`, options: request.options, trigger: "manual" });
      await repo.insertResults(db, [{ run_id: queued.id, owner: user.id, url: `${base}/b`, data: { url: `${base}/b`, pagespeed: labPsi({ lcpMs: 6000, cls: "0.5" }) } }]);
      assert.equal(await refreshPageSpeedFindings(db, queued.id), null);
      assert.deepEqual(await cwvInstances(queued.id), []);
    });

    // The next crawl of the site: the reviewer had dismissed /b's lab LCP.
    const firstLcp = (await repo.listAllRunFindingInstances(db, first.id))
      .find((f) => f.ruleId === "cwv-lcp-poor" && f.url === `${base}/b`);
    await repo.saveFindingReviews(db, first.id, user.id, [
      { findingId: firstLcp.id, ruleId: "cwv-lcp-poor", reviewStatus: "False positive", reviewerNotes: "Lab fluke" },
    ], user.id);
    const second = await crawlOnce();

    await test("the next crawl's comparison does not call the last crawl's Core Web Vitals issues fixed", async () => {
      const comparison = (await summaryOf(second.id)).comparison;
      assert.equal(comparison.previousRunId, first.id);
      for (const ruleId of CWV_RULES) assert.equal(comparison.byRule[ruleId], undefined, ruleId);
    });

    await test("a false positive carries over to the same finding when its PageSpeed result arrives", async () => {
      await repo.updateResultPagespeed(db, second.id, `${base}/b`, labPsi({ lcpMs: 4800, cls: "0.02" }));
      await refreshPageSpeedFindings(db, second.id);
      const lcp = (await repo.listAllRunFindingInstances(db, second.id))
        .find((f) => f.ruleId === "cwv-lcp-poor" && f.url === `${base}/b`);
      assert.ok(lcp, "the second crawl's /b has a poor lab LCP");
      assert.equal(lcp.detectedValue, "4.8 s (lab, mobile)");
      const reviews = await repo.listFindingReviews(db, second.id);
      const carried = reviews.find((review) => review.finding_id === lcp.id);
      assert.equal(carried?.review_status, "False positive");
      assert.match(carried.reviewer_notes, /Lab fluke/);
    });
  } finally {
    await db.query("delete from app_users where id = $1", [user.id]);
    server.close();
    await db.end?.();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
