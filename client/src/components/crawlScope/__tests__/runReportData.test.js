import test from 'node:test';
import assert from 'node:assert/strict';
import {
  uniqueByUrl, applyRuleRollup, reconcileFindings, crawledLine, ageInDays, shortDate, reportSearch, pageIssueCount,
} from '../runReportData.js';
import { inflateFindingTexts } from '../../../lib/crawlScopeApi.js';

test('stored rows keep the first copy of each URL', () => {
  const rows = uniqueByUrl([{ url: 'a', n: 1 }, { url: 'b' }, { url: 'a', n: 2 }]);
  assert.deepEqual(rows.map((r) => r.url), ['a', 'b']);
  assert.equal(rows[0].n, 1);
});

test('a capped list takes its counts from the rollup and marks what it left out', () => {
  const groups = [
    { id: 'broken-internal-links', severity: 'error', urls: ['u1', 'u2'], count: 2, pages: 2 },
    { id: 'page-4xx', severity: 'error', urls: ['u3'], count: 1, pages: 1 },
  ];
  const rollup = [
    { ruleId: 'broken-internal-links', severity: 'error', count: 3661, pages: 3658 },
    { ruleId: 'page-4xx', severity: 'error', count: 1, pages: 1 },
    { ruleId: 'mixed-content', severity: 'error', title: 'Mixed content', count: 40, pages: 40 },
  ];
  const out = applyRuleRollup(groups, rollup, []);
  const byId = Object.fromEntries(out.map((g) => [g.id, g]));
  assert.equal(byId['broken-internal-links'].count, 3661);
  assert.equal(byId['broken-internal-links'].pages, 3658);
  assert.equal(byId['broken-internal-links'].partial, true);
  assert.equal(byId['broken-internal-links'].loaded, 2);
  assert.equal(byId['page-4xx'].partial, undefined);
  // A rule with nothing loaded still has its row, so it is not missing from the tabs.
  assert.equal(byId['mixed-content'].count, 40);
  assert.equal(byId['mixed-content'].partial, true);
});

test('a dismissed finding comes off its rule’s count', () => {
  const groups = [{ id: 'r', severity: 'warning', urls: ['u2'], count: 1, pages: 1 }];
  const findings = [
    { ruleId: 'r', url: 'u1', reviewStatus: 'False positive' },
    { ruleId: 'r', url: 'u2', reviewStatus: 'Needs review' },
  ];
  const [g] = applyRuleRollup(groups, [{ ruleId: 'r', severity: 'warning', count: 10, pages: 10 }], findings);
  assert.equal(g.count, 9);
});

test('without a rollup the groups are untouched', () => {
  const groups = [{ id: 'r', urls: ['u'], count: 1, pages: 1 }];
  assert.equal(applyRuleRollup(groups, null, []), groups);
});

test('the analyser check compares per severity at today’s severities', () => {
  // Stored when title-long was a warning; the catalog now calls it a notice.
  const run = {
    summary: {
      counts: { error: 1, warning: 2, notice: 0 },
      ruleOrder: [
        { ruleId: 'page-4xx', severity: 'error', count: 1 },
        { ruleId: 'title-long', severity: 'warning', count: 2 },
      ],
    },
  };
  const catalogById = new Map([['title-long', { severity: 'notice' }], ['page-4xx', { severity: 'error' }]]);
  const findings = [
    { ruleId: 'page-4xx', severity: 'error' },
    { ruleId: 'title-long', severity: 'notice' },
    { ruleId: 'title-long', severity: 'notice' },
  ];
  const check = reconcileFindings({ run, findings, catalogById });
  assert.equal(check.agrees, true);

  // Totals equal but the severities disagree: not "complete".
  const off = reconcileFindings({ run: { summary: { counts: { error: 1, warning: 2 } } }, findings, catalogById });
  assert.equal(off.analyser, off.shown);
  assert.equal(off.agrees, false);
});

test('a capped run is checked against the rollup, not the loaded list', () => {
  const run = { summary: { ruleOrder: [{ ruleId: 'r', severity: 'notice', count: 100 }] } };
  const check = reconcileFindings({
    run, findings: [{ ruleId: 'r', severity: 'notice' }],
    rollup: [{ ruleId: 'r', severity: 'notice', count: 100 }], capped: { shown: 1, total: 100 },
  });
  assert.equal(check.agrees, true);
});

test('the header says when, in plain words', () => {
  const now = new Date(2026, 10, 4, 12).getTime();
  const run = { finished_at: new Date(2026, 9, 9, 15, 50).toISOString() };
  assert.equal(crawledLine(run, 'completed', now), 'Crawled 9 Oct 2026 · 26 days ago');
  assert.equal(crawledLine(run, 'running', now), null);
  assert.equal(ageInDays(new Date(2026, 10, 4, 1), now), 'today');
  assert.equal(ageInDays(new Date(2026, 10, 3, 23), now), 'yesterday');
  assert.equal(shortDate('2026-09-01T12:00:00'), '1 Sep 2026');
});

test('report addresses change only the parameters named', () => {
  assert.equal(reportSearch('?tab=error', { issue: 'page-4xx' }), '?tab=error&issue=page-4xx');
  assert.equal(reportSearch('?tab=error&issue=x', { issue: null }), '?tab=error');
  assert.equal(reportSearch('', { issue: null }), '');
});

test('shared rule text is put back on every finding', () => {
  const out = inflateFindingTexts({
    findings: [{ id: 'a', recommendationRef: 0, descriptionRef: 1 }, { id: 'b' }],
    texts: ['Fix.', 'Why.'],
    capped: false,
  });
  assert.deepEqual(out.findings, [{ id: 'a', recommendation: 'Fix.', description: 'Why.' }, { id: 'b' }]);
  assert.equal(out.texts, undefined);
  assert.equal(out.capped, false);
  const plain = { findings: [{ id: 'a', recommendation: 'x' }] };
  assert.equal(inflateFindingTexts(plain), plain);
});

test('a capped run counts each page over every finding and marks a partial list (UX-192)', () => {
  const counts = { 'https://x.test/a': [7, 9] };
  assert.deepEqual(pageIssueCount('https://x.test/a', 2, counts, 'table'), { count: 7, partial: true });
  assert.deepEqual(pageIssueCount('https://x.test/a', 2, counts, 'list'), { count: 9, partial: true });
  // Everything loaded: nothing to mark.
  assert.deepEqual(pageIssueCount('https://x.test/a', 7, counts, 'table'), { count: 7, partial: false });
  // Not capped (no counts) or a page the counts do not name: the loaded number, as before.
  assert.deepEqual(pageIssueCount('https://x.test/a', 2, null), { count: 2, partial: false });
  assert.deepEqual(pageIssueCount('https://x.test/b', 1, counts), { count: 1, partial: false });
});
