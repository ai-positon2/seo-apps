// ── What changed since the last crawl ──────────────────────────────────────
//
// Run: npm test --prefix client
//
// The analyzer's run summary now carries a comparison with the previous crawl
// of the same site (new / fixed / persisting issues per rule). These are the
// sentences the report shows for it.

import { test } from 'node:test';
import assert from 'node:assert';

import { crawlComparison, ruleTrend } from '../crawlHelpers.js';

const run = (comparison) => ({ summary: { comparison } });

test('no previous crawl, no comparison', () => {
  assert.strictEqual(crawlComparison(run(null)), null);
  assert.strictEqual(crawlComparison({}), null);
});

test('the totals, as one sentence', () => {
  const comparison = crawlComparison(run({
    previousFinishedAt: '2026-09-16T10:00:00.000Z',
    totals: { new: 12, fixed: 30, persisting: 140 },
    byRule: {},
    carriedReviews: 4,
  }));
  assert.strictEqual(
    comparison.sentence,
    'Since the crawl of 16 Sep 2026: 12 new issues, 30 fixed, 140 still open. 4 false positives were carried over from it.',
  );
});

test('one rule\'s movement, or nothing when it did not move', () => {
  const comparison = crawlComparison(run({
    totals: { new: 3, fixed: 1, persisting: 5 },
    byRule: { 'broken-internal-links': { new: 2, fixed: 1, persisting: 0 }, 'title-long': { new: 0, fixed: 0, persisting: 5 } },
  }));
  assert.strictEqual(ruleTrend(comparison, 'broken-internal-links'), '2 new, 1 fixed since the last crawl');
  assert.strictEqual(ruleTrend(comparison, 'title-long'), null);
  assert.strictEqual(ruleTrend(comparison, 'h1-missing'), null);
  assert.strictEqual(ruleTrend(null, 'title-long'), null);
});

test('issue groups follow the run\'s importance order and carry its reason', async () => {
  const { orderIssueGroups } = await import('../crawlHelpers.js');
  const groups = [
    { id: 'h1-missing', severity: 'warning', pages: 40 },
    { id: 'title-long', severity: 'warning', pages: 1 },
    { id: 'page-4xx', severity: 'error', pages: 2 },
  ];
  // Without an order: severity, then pages.
  assert.deepStrictEqual(orderIssueGroups(groups, null).map((g) => g.id), ['page-4xx', 'h1-missing', 'title-long']);
  const ruleOrder = [
    { ruleId: 'page-4xx', rank: 1, reason: 'On 2 pages.' },
    { ruleId: 'title-long', rank: 2, reason: 'On 1 page, the homepage.' },
    { ruleId: 'h1-missing', rank: 3, reason: 'On 40 pages.' },
  ];
  const ordered = orderIssueGroups(groups, ruleOrder);
  assert.deepStrictEqual(ordered.map((g) => g.id), ['page-4xx', 'title-long', 'h1-missing']);
  assert.strictEqual(ordered[1].reason, 'On 1 page, the homepage.');
});
