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
      // lossTotals is v5's per-page loss (40/10/2 per distinct rule), summed
      // over pages: p0 an error and a warning, p1 a warning and a notice, p2 a
      // warning. Every fixture finding shares one rule id.
      assert.deepEqual(counts, { error: 1, warning: 3, notice: 1, lossTotals: { error: 40, warning: 30, notice: 2 } });
    });

    await test('the dashboard score from those counts matches the report formula', async () => {
      const counts = await overview.healthAffectedPages(run.id);
      const score = overview.siteHealth({ summary: { counts: {} } }, 4, [], counts);
      assert.equal(score.score, Math.round(100 - (40 + 30 + 2) / 4));
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
      assert.deepEqual(await overview.healthAffectedPages(blocked.id), {
        error: 0, warning: 1, notice: 0, lossTotals: { error: 0, warning: 10, notice: 0 },
      });
    });

    await test('v5: distinct rules per page, capped at 100 and shared out in proportion', async () => {
      const heavy = await newRun();
      await addResult(heavy.id, `${H}/`, 'text/html');
      for (const ruleId of ['a', 'b', 'c']) await addFinding(heavy.id, { ruleId, severity: 'error', scope: 'page', url: `${H}/` });
      // The same rule twice on one page is one failing rule.
      await addFinding(heavy.id, { ruleId: 'a', severity: 'error', scope: 'page', url: `${H}/` });
      await addFinding(heavy.id, { ruleId: 'd', severity: 'warning', scope: 'page', url: `${H}/` });
      const counts = await overview.healthAffectedPages(heavy.id);
      // Uncapped 3 x 40 + 10 = 130; capped to 100 and split 120:10.
      assert.ok(Math.abs(counts.lossTotals.error - 1200 / 13) < 1e-9, JSON.stringify(counts));
      assert.ok(Math.abs(counts.lossTotals.warning - 100 / 13) < 1e-9, JSON.stringify(counts));
      assert.equal(overview.siteHealth({ summary: { counts: {} } }, 1, [], counts).score, 0);
    });

    // The aggregates moved into one statement (overview.crawlHealthAggregates)
    // that reads each result's JSON once. These are the statements it replaced,
    // verbatim; on every fixture run both must give the same numbers.
    const SCORED_R = `r.content_type ilike '%text/html%'
              and r.data->>'scope' = 'Internal'
              and coalesce(r.data->>'crawlRefused', 'false') <> 'true'
              and coalesce(r.data->>'probe', 'false') <> 'true'
              and coalesce(r.data->>'unrenderedShell', 'false') <> 'true'
              and coalesce(r.data->>'javascriptRedirectUrl', '') = ''
              and (r.status is null or r.status between 200 and 299)`;
    const { SEVERITY_TABLE_JSON } = require('../../crawlScope/currentSeverity');
    const legacy = async (runId) => {
      const html = await db.count(
        `select count(*) from crawl_run_results r where r.run_id = $1 and ${SCORED_R}`, [runId]);
      const [loss] = await db.rows(
        `with counted as (
           select f.data->>'url' as url,
                  coalesce(($7::jsonb)->>(f.data->>'ruleId'), f.data->>'severity') as severity,
                  coalesce(f.data->>'ruleId', '?') as rule
             from crawl_run_finding_instances f
             join crawl_run_results r on r.run_id = f.run_id and r.url = f.data->>'url'
             left join crawl_finding_reviews v on v.run_id = f.run_id and v.finding_id = f.finding_id
            where f.run_id = $1 and coalesce(f.data->>'scope', 'page') = any($2)
              and ${SCORED_R}
              and coalesce(v.review_status, '') <> all($3)
         ), per_page as (
           select url,
                  count(distinct rule) filter (where severity = 'error') * $4::float8 as e,
                  count(distinct rule) filter (where severity = 'warning') * $5::float8 as w,
                  count(distinct rule) filter (where severity = 'notice') * $6::float8 as n
             from counted group by url
         )
         select count(*) filter (where e > 0)::int as error_pages,
                count(*) filter (where w > 0)::int as warning_pages,
                count(*) filter (where n > 0)::int as notice_pages,
                coalesce(sum(case when e + w + n > 0 then e * least(100, e + w + n) / (e + w + n) else 0 end), 0)::float8 as error_loss,
                coalesce(sum(case when e + w + n > 0 then w * least(100, e + w + n) / (e + w + n) else 0 end), 0)::float8 as warning_loss,
                coalesce(sum(case when e + w + n > 0 then n * least(100, e + w + n) / (e + w + n) else 0 end), 0)::float8 as notice_loss
           from per_page`,
        [runId, ['page', 'template'], ['False positive', 'Resolved'], 40, 10, 0, SEVERITY_TABLE_JSON]);
      const site = await db.rows(
        `select coalesce(f.data->>'ruleId', '?') as rule,
                coalesce(($4::jsonb)->>(f.data->>'ruleId'), f.data->>'severity') as severity,
                bool_or(coalesce(f.data->>'scope', 'page') <> all($2)) as site_scoped,
                bool_or(coalesce(f.data->>'scope', 'page') = any($2) and r.url is not null and ${SCORED_R}) as on_scored
           from crawl_run_finding_instances f
           left join crawl_run_results r on r.run_id = f.run_id and r.url = f.data->>'url'
           left join crawl_finding_reviews v on v.run_id = f.run_id and v.finding_id = f.finding_id
          where f.run_id = $1 and coalesce(v.review_status, '') <> all($3)
          group by 1, 2`,
        [runId, ['page', 'template'], ['False positive', 'Resolved'], SEVERITY_TABLE_JSON]);
      const costing = await db.rows(
        `select coalesce(f.data->>'ruleId', '?') as rule,
                coalesce(($4::jsonb)->>(f.data->>'ruleId'), f.data->>'severity') as severity,
                array_agg(distinct f.data->>'url') as urls
           from crawl_run_finding_instances f
           join crawl_run_results r on r.run_id = f.run_id and r.url = f.data->>'url'
           left join crawl_finding_reviews v on v.run_id = f.run_id and v.finding_id = f.finding_id
          where f.run_id = $1 and coalesce(f.data->>'scope', 'page') = any($2)
            and ${SCORED_R}
            and coalesce(v.review_status, '') <> all($3)
          group by 1, 2`,
        [runId, ['page', 'template'], ['False positive', 'Resolved'], SEVERITY_TABLE_JSON]);
      return { html, loss, site, costing };
    };
    const sortRows = (rows, key) => [...rows].map((r) => ({ ...r, ...(r.urls ? { urls: [...r.urls].sort() } : {}) }))
      .sort((a, b) => key(a).localeCompare(key(b)));

    await test('the single statement gives the same numbers as the statements it replaced', async () => {
      for (const id of [run.id]) {
        const old = await legacy(id);
        const agg = await overview.crawlHealthAggregates(id);
        assert.equal(agg.htmlPages, old.html);
        assert.deepEqual(agg.loss, old.loss);
        const k = (r) => `${r.rule}|${r.severity}`;
        assert.deepEqual(sortRows(agg.siteRuleRows, k), sortRows(old.site, k));
        assert.deepEqual(sortRows(agg.costingRows, k), sortRows(old.costing, k));
      }
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
