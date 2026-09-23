// ── Site Health's page counts, against a real database ──────────────────────
//
// healthAffectedPages() computes siteHealth's numerator in SQL: distinct
// internal HTML pages with at least one counted finding, per severity. Which
// findings count is the whole point, and it is decided by a join and four
// predicates — scope, content type, refusal, review status — so it is tested
// where those predicates actually run.
//
// The rule it must match is the crawl report's own (client crawlHelpers.js
// healthMetrics): page- and template-scoped findings count; site and resource
// findings do not; a finding on a URL that is not an internal HTML page cannot
// make that "page" affected; a reviewer's False positive / Resolved takes the
// finding out.
//
// Skips without TEST_DATABASE_URL; see services/__tests__/helpers/testDatabase.js.
//
// Run: TEST_DATABASE_URL=postgres://... node modules/projects/__tests__/siteHealthDb.test.js

const assert = require('node:assert/strict');
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env') });
const { useTestDatabase } = require('../../../services/__tests__/helpers/testDatabase');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

if (!useTestDatabase('siteHealth (database)')) {
  process.exit(0);
}

const db = require('../../../services/db');
const overview = require('../overview');

const H = 'https://health.invalid';

(async () => {
  console.log('\nsiteHealth — affected-page counts\n');

  const email = `_sitehealth_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@position2.com`;
  const user = await db.one('insert into app_users (email) values ($1) returning id', [email]);

  const newRun = () => db.one(
    `insert into crawl_runs (owner, url, status) values ($1, $2, 'completed') returning id`,
    [user.id, `${H}/`],
  );
  const addResult = (runId, url, contentType, scope = 'Internal', extra = {}) => db.query(
    `insert into crawl_run_results (run_id, owner, url, status, content_type, data)
       values ($1, $2, $3, 200, $4, $5)`,
    [runId, user.id, url, contentType, JSON.stringify({ url, scope, contentType, ...extra })],
  );
  let findingSeq = 0;
  const addFinding = async (runId, finding) => {
    findingSeq += 1;
    const id = `f${findingSeq}`;
    await db.query(
      `insert into crawl_run_finding_instances (run_id, owner, finding_id, rule_id, data)
         values ($1, $2, $3, $4, $5)`,
      [runId, user.id, id, finding.ruleId || 'rule', JSON.stringify({ id, ...finding })],
    );
    return id;
  };

  try {
    const run = await newRun();
    for (const p of ['p0', 'p1', 'p2', 'p3']) await addResult(run.id, `${H}/${p}`, 'text/html; charset=utf-8');
    await addResult(run.id, `${H}/img/hero.png`, 'image/png');
    await addResult(run.id, 'https://elsewhere.invalid/page', 'text/html', 'External');

    await addFinding(run.id, { severity: 'error', scope: 'page', url: `${H}/p0` });
    await addFinding(run.id, { severity: 'error', scope: 'page', url: `${H}/img/hero.png` });
    for (const p of ['p0', 'p1', 'p2']) {
      await addFinding(run.id, { severity: 'warning', scope: 'template', url: `${H}/${p}` });
    }
    await addFinding(run.id, { severity: 'warning', scope: 'site', url: `${H}/p3` });
    await addFinding(run.id, { severity: 'notice', scope: 'resource', url: `${H}/img/hero.png` });
    await addFinding(run.id, { severity: 'error', url: 'https://elsewhere.invalid/page', scope: 'page' });
    // A finding stored before `scope` existed is a page finding.
    await addFinding(run.id, { severity: 'notice', url: `${H}/p1` });
    const dismissed = await addFinding(run.id, { severity: 'error', scope: 'page', url: `${H}/p3` });
    await db.query(
      `insert into crawl_finding_reviews (run_id, finding_id, owner, rule_id, review_status)
         values ($1, $2, $3, 'rule', 'False positive')`,
      [run.id, dismissed, user.id],
    );

    await test('counts page and template findings on internal HTML pages only', async () => {
      const counts = await overview.healthAffectedPages(run.id);
      assert.deepEqual(counts, { error: 1, warning: 3, notice: 1 });
    });

    await test('the dashboard score from those counts matches the report formula', async () => {
      const counts = await overview.healthAffectedPages(run.id);
      const score = overview.siteHealth({ summary: { counts: {} } }, 4, [], counts);
      assert.equal(score.score, Math.round(100 - (1 / 4) * 45 - (3 / 4) * 22 - (1 / 4) * 8));
    });

    await test('pages that refused the crawler leave both sides of the score', async () => {
      // The analyzer marks a response that refused the crawler (crawlRefused);
      // it was not audited, so it is neither a page with an error nor a clean one.
      const blocked = await newRun();
      await addResult(blocked.id, `${H}/`, 'text/html');
      for (const p of ['a', 'b', 'c']) {
        await addResult(blocked.id, `${H}/${p}`, 'text/html', 'Internal', { crawlRefused: true });
        await addFinding(blocked.id, { severity: 'error', scope: 'page', url: `${H}/${p}`, crawlRefused: true });
      }
      await addFinding(blocked.id, { severity: 'warning', scope: 'page', url: `${H}/` });
      assert.equal(await overview.internalHtmlPageCount(blocked.id), 1);
      assert.deepEqual(await overview.healthAffectedPages(blocked.id), { error: 0, warning: 1, notice: 0 });
    });

    await test('a run with no stored instances returns null so the caller can fall back', async () => {
      const empty = await newRun();
      assert.equal(await overview.healthAffectedPages(empty.id), null);
    });
  } finally {
    await db.query('delete from app_users where id = $1', [user.id]);
    await db.end?.();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
