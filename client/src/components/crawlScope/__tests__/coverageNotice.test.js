// ── What the report says about a crawl that did not see everything ─────────
//
// Run: npm test --prefix client
//
// Two defects: the notice said "it reached its budget" (and advised raising
// it) whenever the crawler's `truncated` bit was set, which a depth limit or a
// crawl trap also sets; and nothing named the checks the crawl could not run,
// so their empty result read as a pass.

import { test } from 'node:test';
import assert from 'node:assert';

import { crawlCoverageNotice, listOptionText } from '../crawlHelpers.js';

const catalogById = new Map([
  ['orphan-page', { id: 'orphan-page', title: 'Orphaned pages' }],
  ['single-inlink', { id: 'single-inlink', title: 'Pages with only one incoming internal link' }],
  ['broken-external-link', { id: 'broken-external-link', title: 'Broken external links' }],
]);
const run = (summary, extra = {}) => ({ status: 'completed', options: { maxUrls: 500 }, summary, ...extra });

test('a crawl trap alone is not a budget to raise', () => {
  const notice = crawlCoverageNotice(run({ truncated: true, budgetReached: false, trapTemplates: ['/calendar/{n}'] }), catalogById);
  assert.strictEqual(notice.partial, true);
  assert.strictEqual(notice.budgetReached, false);
  assert.deepStrictEqual(notice.reasons, ['1 URL pattern was capped as a crawler trap']);
});

test('the budget, when it did run out', () => {
  const notice = crawlCoverageNotice(run({ truncated: true, budgetReached: true }), catalogById);
  assert.strictEqual(notice.budgetReached, true);
  assert.deepStrictEqual(notice.reasons, ['it reached its budget of 500 pages']);
});

test('a run from before budgetReached existed reads its budget from truncated alone', () => {
  assert.strictEqual(crawlCoverageNotice(run({ truncated: true }), catalogById).budgetReached, true);
  assert.strictEqual(crawlCoverageNotice(run({ truncated: true, depthLimited: true }), catalogById).budgetReached, false);
});

test('a stopped crawl says so', () => {
  const notice = crawlCoverageNotice(run({}, { status: 'stopped' }), catalogById);
  assert.deepStrictEqual(notice.reasons, ['it was stopped before it finished']);
});

test('checks the crawl could not run are named, with the reason, grouped by reason', () => {
  const reason = 'The crawl did not see the whole site.';
  const notice = crawlCoverageNotice(run({
    coverage: {
      notEvaluated: [{ ruleId: 'orphan-page', reason }, { ruleId: 'single-inlink', reason }],
      partial: [{ ruleId: 'broken-external-link', reason: '37 external URLs were not requested.' }],
    },
  }), catalogById);
  assert.deepStrictEqual(notice.notEvaluated, [
    { reason, titles: ['Orphaned pages', 'Pages with only one incoming internal link'] },
  ]);
  assert.deepStrictEqual(notice.partlyChecked, [
    { reason: '37 external URLs were not requested.', titles: ['Broken external links'] },
  ]);
});

test('a resumed crawl is partial only when its earlier pages could not be reloaded', () => {
  assert.strictEqual(crawlCoverageNotice(run({ resumed: { priorPages: 120, withoutLinkData: 0 } }), catalogById).partial, false);
  const failed = crawlCoverageNotice(run({ resumed: { priorPages: 0, withoutLinkData: 0, reloadFailed: true } }), catalogById);
  assert.strictEqual(failed.partial, true);
  assert.match(failed.reasons[0], /could not be reloaded/);
});

test('pages robots.txt closes to CrawlScope alone are named as not audited', () => {
  const reason = 'robots.txt closes 2 URLs to CrawlScope but not to Googlebot, so Google can crawl them and this audit did not.';
  const notice = crawlCoverageNotice(run({ coverage: { notEvaluated: [], partial: [], pagesNotAudited: [{ count: 2, reason }] } }), catalogById);
  assert.deepStrictEqual(notice.pagesNotAudited, [reason]);
  assert.deepStrictEqual(crawlCoverageNotice(run({}), catalogById).pagesNotAudited, []);
});

test("a list option is edited as one entry per line, saved as an array or typed as text", () => {
  assert.equal(listOptionText(["/blog/*", "/news/*"]), "/blog/*\n/news/*");
  assert.equal(listOptionText("/blog/*\n"), "/blog/*\n");
  assert.equal(listOptionText(undefined), "");
});
