// ── A finished crawl's stored rows carry the whole-crawl link counts ────────
//
// crawl_run_results rows are written as pages are fetched, so `data.inlinks`
// used to be whatever the crawler had counted at that moment — "0 on every row"
// per projects/crawledPages.js — and the report's Inlinks column and CSV export
// showed it. The completion step now writes the analyzer's distinct-page counts
// back onto the rows.
//
// Run: TEST_DATABASE_URL=postgres://... node modules/crawlScope/__dbtests__/resultPatches.test.js

const assert = require("node:assert/strict");
const http = require("node:http");
require("dotenv").config({ path: require("path").join(__dirname, "../../../../.env") });
const { useTestDatabase } = require("../../../services/__tests__/helpers/testDatabase");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

if (!useTestDatabase("crawl result patches (database)")) {
  process.exit(0);
}
process.env.CRAWL_ALLOW_PRIVATE_HOSTS = "true";
delete process.env.CRAWLSCOPE_AUTO_PAGESPEED;

const db = require("../../../services/db");
const repo = require("../db/repo");
const { RunManager } = require("../run/manager");
const { parseCrawlRequest } = require("../shared/options");

(async () => {
  console.log("\ncrawl result patches — whole-crawl values on stored rows\n");
  const page = (title, body = "") =>
    `<!doctype html><html><head><title>${title} of the patch fixture</title></head><body><h1>${title}</h1>${body}</body></html>`;
  const server = http.createServer((request, response) => {
    const routes = {
      // /a is linked twice from the home page (nav + footer) and once from /b.
      "/": page("Home", '<nav><a href="/a">A</a><a href="/b">B</a></nav><footer><a href="/a">A again</a></footer>'),
      "/a": page("Page A"),
      "/b": page("Page B", '<a href="/a">A</a>'),
    };
    const body = routes[request.url];
    response.statusCode = body ? 200 : 404;
    response.setHeader("Content-Type", body ? "text/html" : "text/plain");
    response.end(body || "nope");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const email = `_resultpatch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@position2.com`;
  const user = await db.one("insert into app_users (email) values ($1) returning id", [email]);

  try {
    await test("stored rows carry distinct linking-page counts after the crawl", async () => {
      const { url, options } = parseCrawlRequest({
        url: `${base}/`,
        options: { checkExternalLinks: false, discoverSitemaps: false, perHostDelay: 0 },
      });
      const run = await repo.createRun(db, { owner: user.id, url, options, trigger: "manual" });
      await new RunManager({ serviceClient: () => db }).execute(run);
      const rows = await db.rows(
        `select url, (data->>'inlinks')::int as inlinks, (data->>'followInlinks')::int as follow
           from crawl_run_results where run_id = $1 order by url`,
        [run.id],
      );
      const at = (path) => rows.find((r) => r.url === `${base}${path}`);
      assert.equal(at("/a").inlinks, 2, "home (twice) and /b are two linking pages");
      assert.equal(at("/b").inlinks, 1);
      assert.equal(at("/a").follow, 2);
    });
  } finally {
    await db.query("delete from app_users where id = $1", [user.id]);
    server.close();
    await db.end?.();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
