// ── A run with more findings than one read returns ──────────────────────────
//
// The report read the first 50,000 findings by id, which for Eventgroove were
// nearly all notices: its 3,661 broken internal links were missing and the
// Errors tab listed 13 pages. A capped read is now filled most serious first,
// with a sample of every rule, and carries every rule's full count.
//
// Run: node --test modules/crawlScope/__tests__/capped-findings.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');
const repo = require('../db/repo');
const { shareFindingTexts } = require('../api/findingTexts');

test('the cap is filled errors first, then warnings, then notices, with every rule sampled', () => {
  const rollup = [
    { ruleId: 'heading-skip', severity: 'notice', count: 9_000 },
    { ruleId: 'og-incomplete', severity: 'notice', count: 8_000 },
    { ruleId: 'meta-missing', severity: 'warning', count: 3_000 },
    { ruleId: 'broken-internal-links', severity: 'error', count: 3_661 },
    { ruleId: 'page-4xx', severity: 'error', count: 4 },
  ];
  const plan = repo.planCappedRead(rollup, 10_000);
  const take = Object.fromEntries(plan.map((p) => [p.ruleId, p.limit]));
  assert.equal(plan.reduce((s, p) => s + p.limit, 0), 10_000);
  assert.equal(take['broken-internal-links'], 3_661);
  assert.equal(take['page-4xx'], 4);
  assert.equal(take['meta-missing'], 3_000);
  // Every notice rule keeps at least its sample.
  assert.ok(take['heading-skip'] >= 100 && take['og-incomplete'] >= 100);
  // Errors come before warnings, warnings before notices.
  assert.deepEqual(plan.map((p) => p.ruleId).slice(0, 3), ['page-4xx', 'broken-internal-links', 'meta-missing']);
});

test('a cap smaller than one sample per rule still never exceeds the cap', () => {
  const rollup = Array.from({ length: 10 }, (_, i) => ({ ruleId: `r${i}`, severity: 'notice', count: 50 }));
  const plan = repo.planCappedRead(rollup, 7);
  assert.equal(plan.reduce((s, p) => s + p.limit, 0), 7);
});

// A stand-in for the Postgres client: answers the four statements the read
// makes from an in-memory table.
function fakeClient(instances) {
  return {
    async rows(sql, params) {
      const run = instances.filter((r) => r.run_id === params[0]);
      if (sql.includes('row_number()')) {
        const [, page, cap] = params;
        return run.map((r, i) => ({ id: r.id, n: i + 1, total: run.length }))
          .filter((r) => (r.n - 1) % page === 0 && r.n <= cap);
      }
      if (sql.includes('select distinct')) {
        return [...new Set(run.map((r) => r.data.recommendation))].map((rec) => ({
          rk: `k:${rec}`, rec, dk: 'd', descr: 'Rule text.',
        }));
      }
      if (sql.includes('group by rule_id')) {
        const byRule = new Map();
        for (const r of run) {
          const e = byRule.get(r.rule_id) || { rule_id: r.rule_id, severity: r.data.severity, count: 0, urls: new Set() };
          e.count += 1;
          e.urls.add(r.data.url);
          byRule.set(r.rule_id, e);
        }
        return [...byRule.values()].map((e) => ({ ...e, pages: e.urls.size }));
      }
      if (sql.includes('rule_id = $2')) {
        const [, ruleId, after, limit] = params;
        return run.filter((r) => r.rule_id === ruleId && r.id > after).slice(0, limit)
          .map((r) => ({ id: r.id, d: { ...r.data, recommendation: undefined }, rk: `k:${r.data.recommendation}`, dk: 'd' }));
      }
      if (sql.includes('id >= $2')) {
        const [, from, to] = params;
        return run.filter((r) => r.id >= from && (sql.includes('id < $3') ? r.id < to : true))
          .slice(0, sql.includes('limit $3') ? to : undefined)
          .map((r) => ({ d: { ...r.data }, rk: `k:${r.data.recommendation}`, dk: 'd' }));
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
}

test('a capped read holds every error even when the errors were stored last', async () => {
  const instances = [];
  let id = 0;
  const add = (ruleId, severity, n) => {
    for (let i = 0; i < n; i += 1) {
      id += 1;
      instances.push({
        id, run_id: 'run', rule_id: ruleId,
        data: { id: `${ruleId}-${i}`, ruleId, severity, url: `https://x.test/${i}`, recommendation: `Fix ${ruleId}.` },
      });
    }
  };
  add('heading-hierarchy-skipped', 'notice', 600);
  add('broken-internal-links', 'error', 150);
  const meta = {};
  const rows = await repo.listAllRunFindingInstances(fakeClient(instances), 'run', { cap: 300, meta });
  assert.equal(meta.total, 750);
  assert.equal(rows.length, 300);
  assert.equal(rows.filter((f) => f.ruleId === 'broken-internal-links').length, 150);
  assert.equal(rows[0].recommendation, 'Fix broken-internal-links.');
  assert.equal(rows[0].description, 'Rule text.');
  // The rollup counts every finding, not the 300 returned.
  const total = meta.rollup.reduce((s, r) => s + r.count, 0);
  assert.equal(total, 750);
  assert.equal(meta.rollup.find((r) => r.ruleId === 'broken-internal-links').pages, 150);
});

test('a read under the cap is unchanged: every finding, in id order, and no rollup', async () => {
  const instances = [1, 2, 3].map((n) => ({
    id: n, run_id: 'run', rule_id: 'page-4xx',
    data: { id: `f${n}`, ruleId: 'page-4xx', severity: 'error', url: `https://x.test/${n}`, recommendation: 'Fix it.' },
  }));
  const meta = {};
  const rows = await repo.listAllRunFindingInstances(fakeClient(instances), 'run', { meta });
  assert.deepEqual(rows.map((f) => f.id), ['f1', 'f2', 'f3']);
  assert.equal(meta.rollup, undefined);
});

test('rule text is sent once per response and points back by index', () => {
  const findings = [
    { id: 'a', recommendation: 'Long fix.', description: 'Long description.' },
    { id: 'b', recommendation: 'Long fix.', description: 'Long description.' },
    { id: 'c' },
  ];
  const { findings: shared, texts } = shareFindingTexts(findings);
  assert.deepEqual(texts, ['Long fix.', 'Long description.']);
  assert.deepEqual(shared[1], { id: 'b', recommendationRef: 0, descriptionRef: 1 });
  assert.deepEqual(shared[2], { id: 'c' });
});

test('a finished run’s stored rows are read in keyset pages, all of them', async () => {
  const stored = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, run_id: 'run', data: { url: `https://x.test/${i}` } }));
  const client = {
    async rows(_sql, [runId, after, limit]) {
      return stored.filter((r) => r.run_id === runId && r.id > after).slice(0, limit);
    },
  };
  const rows = await repo.listAllResults(client, 'run', { page: 2 });
  assert.deepEqual(rows.map((r) => r.url), stored.map((r) => r.data.url));
});
