// ── A run holding more findings than one read returns says so ──────────────
//
// listAllRunFindingInstances stops at a cap (50,000). The report received the
// first 50,000 and called them the audit; now the read reports how many the
// run holds, and the findings route passes on "capped".
//
// Run: TEST_DATABASE_URL=postgres://... node modules/crawlScope/__dbtests__/findingsCap.test.js

const assert = require("node:assert/strict");
require("dotenv").config({ path: require("path").join(__dirname, "../../../../.env") });
const { useTestDatabase } = require("../../../services/__tests__/helpers/testDatabase");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

if (!useTestDatabase("findings read cap (database)")) {
  process.exit(0);
}

const db = require("../../../services/db");
const repo = require("../db/repo");

(async () => {
  console.log("\nfindings read cap\n");
  const email = `_findingscap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@position2.com`;
  const user = await db.one("insert into app_users (email) values ($1) returning id", [email]);
  try {
    const run = await db.one(
      "insert into crawl_runs (owner, url, status) values ($1, 'https://cap.invalid/', 'completed') returning id",
      [user.id],
    );
    for (let n = 1; n <= 3; n += 1) {
      await db.query(
        `insert into crawl_run_finding_instances (run_id, owner, finding_id, rule_id, data)
           values ($1, $2, $3, 'page-4xx', $4)`,
        [run.id, user.id, `f${n}`, JSON.stringify({ id: `f${n}`, ruleId: "page-4xx", url: `https://cap.invalid/${n}` })],
      );
    }

    await test("the read reports the run's total alongside the capped rows", async () => {
      const meta = {};
      const rows = await repo.listAllRunFindingInstances(db, run.id, { cap: 2, meta });
      assert.equal(rows.length, 2);
      assert.equal(meta.total, 3);
    });

    await test("without a meta object the read is unchanged", async () => {
      const rows = await repo.listAllRunFindingInstances(db, run.id);
      assert.equal(rows.length, 3);
      assert.equal(repo.FINDINGS_READ_CAP, 50_000);
    });
  } finally {
    await db.query("delete from app_users where id = $1", [user.id]);
    await db.end?.();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
