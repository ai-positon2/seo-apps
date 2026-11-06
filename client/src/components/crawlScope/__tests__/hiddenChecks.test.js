import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hiddenRuleSet, withoutHidden, hiddenCheckRows, hiddenChecksNote, addHidden, removeHidden,
  hideConfirmText, runWithoutHiddenComparison,
} from '../hiddenChecks.js';
import { healthMetrics, issueGroups, crawlComparison } from '../crawlHelpers.js';
import { techWorking } from '../../chat/screenWorking.js';

const page = (url) => ({ url, scope: 'Internal', contentType: 'text/html', status: 200, issues: [] });
const finding = (ruleId, url, severity = 'error') => ({ id: `${ruleId}|${url}`, ruleId, url, severity, scope: 'page' });

test('nothing hidden: the very same arrays, so the score is unchanged', () => {
  const findings = [finding('page-4xx', 'a')];
  assert.equal(withoutHidden(findings, hiddenRuleSet([])), findings);
  assert.equal(withoutHidden(null, hiddenRuleSet(['x'])), null);
});

test('a hidden check is out of the score, the bars and the groups', () => {
  const pages = [page('https://s/a'), page('https://s/b')];
  const findings = [
    finding('page-4xx', 'https://s/a', 'error'),
    finding('missing-title', 'https://s/b', 'warning'),
  ];
  const hidden = hiddenRuleSet([{ ruleId: 'page-4xx' }]);
  const all = healthMetrics(pages, findings);
  const scored = healthMetrics(pages, withoutHidden(findings, hidden));
  assert.ok(scored.health > all.health, `${scored.health} > ${all.health}`);
  assert.equal(scored.affectedErrorPages, 0);
  // The scoring function itself is untouched: the same as a crawl that never
  // found the hidden check.
  const never = healthMetrics(pages, [findings[1]]);
  for (const key of ['health', 'exactLoss', 'errors', 'warnings', 'affectedErrorPages', 'affectedWarningPages']) {
    assert.deepEqual(scored[key], never[key], key);
  }
  assert.deepEqual(scored.ruleLoss, never.ruleLoss);
  const groups = issueGroups(pages, withoutHidden(findings, hidden));
  assert.equal(groups.some((g) => g.id === 'page-4xx'), false);
});

test('the Hidden checks rows count this crawl, preferring the full rollup', () => {
  const catalogById = new Map([['page-4xx', { title: '4XX pages', severity: 'error' }]]);
  const findings = [finding('page-4xx', 'a'), finding('page-4xx', 'a'), finding('page-4xx', 'b')];
  const [row] = hiddenCheckRows([{ ruleId: 'page-4xx', hiddenBy: 'me@x.com' }], { catalogById, findings });
  assert.deepEqual(
    { title: row.title, count: row.count, pages: row.pages, hiddenBy: row.hiddenBy },
    { title: '4XX pages', count: 3, pages: 2, hiddenBy: 'me@x.com' },
  );
  const [capped] = hiddenCheckRows(['page-4xx'], {
    catalogById, findings, rollup: [{ ruleId: 'page-4xx', count: 900, pages: 450 }],
  });
  assert.equal(capped.count, 900);
  assert.equal(capped.pages, 450);
  const [absent] = hiddenCheckRows(['cwv-inp-poor'], { catalogById, findings });
  assert.equal(absent.count, 0);
  assert.equal(absent.title, 'cwv-inp-poor');
});

test('the note and the confirm say what hiding does', () => {
  assert.equal(hiddenChecksNote(0), null);
  assert.equal(hiddenChecksNote(1), '1 check hidden — excluded from this score');
  assert.equal(hiddenChecksNote(3), '3 checks hidden — excluded from this score');
  const text = hideConfirmText('4XX pages');
  assert.match(text, /removed from the site health score for this client on every crawl/);
});

test('optimistic add and remove keep the list consistent', () => {
  const list = [{ ruleId: 'a' }];
  assert.equal(addHidden(list, { ruleId: 'a' }), list);
  assert.deepEqual(addHidden(list, { ruleId: 'b' }).map((h) => h.ruleId), ['a', 'b']);
  assert.deepEqual(removeHidden(addHidden(list, { ruleId: 'b' }), 'b'), list);
  assert.deepEqual(removeHidden(null, 'a'), []);
});

test('the "since the last crawl" counts leave hidden checks out of both crawls', () => {
  const run = {
    summary: {
      comparison: {
        totals: { new: 5, fixed: 3, persisting: 10 },
        byRule: {
          'page-4xx': { new: 4, fixed: 1, persisting: 6 },
          'missing-title': { new: 1, fixed: 2, persisting: 4 },
        },
      },
    },
  };
  assert.equal(runWithoutHiddenComparison(run, hiddenRuleSet([])), run);
  assert.equal(runWithoutHiddenComparison(run, hiddenRuleSet(['other'])), run);
  const out = crawlComparison(runWithoutHiddenComparison(run, hiddenRuleSet(['page-4xx'])));
  assert.deepEqual(out.totals, { new: 1, fixed: 2, persisting: 4 });
  assert.equal('page-4xx' in out.byRule, false);
  // The run itself is not changed.
  assert.equal(run.summary.comparison.totals.new, 5);
});

test('Ask SEO Studio\'s working lists hidden checks only when there are some', () => {
  const metrics = healthMetrics([page('https://s/a')], []);
  assert.equal('hiddenChecks' in techWorking({ metrics }), false);
  const working = techWorking({ metrics, hiddenChecks: [{ ruleId: 'page-4xx', title: '4XX pages', count: 2 }] });
  assert.deepEqual(working.hiddenChecks, [{ ruleId: 'page-4xx', rule: '4XX pages', occurrences: 2 }]);
});
