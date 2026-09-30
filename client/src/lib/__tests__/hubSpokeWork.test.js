// ── Work made from the Hub & Spoke report, indexed for the report ────────────
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';

import { indexWork, pageKey, topicStages, currentPicks, timeAgo, articleHref } from '../hubSpokeWork.js';

const work = {
  keywordResearch: [
    { clusterId: 'c1', topic: 'How to Choose an MSP', seed: 'choose msp', primary: [{ keyword: 'choose msp' }, { keyword: 'msp checklist' }], secondary: [{ keyword: 'a' }, { keyword: 'b' }], updatedAt: '2026-09-29T10:00:00Z' },
    { clusterId: 'c1', topic: 'Old Suggestion', seed: 'old', primary: [{ keyword: 'old' }], secondary: [], updatedAt: '2026-09-20T10:00:00Z' },
    { clusterId: 'gone', topic: 'From a previous run', seed: 'prev', primary: [], secondary: [], updatedAt: '2026-09-10T10:00:00Z' },
  ],
  articles: [
    { id: 'a1', projectId: 'p1', clusterId: 'c1', topic: 'How to Choose an MSP', keyword: 'choose msp', sections: 8, words: 0, stage: 'brief', updatedAt: '2026-09-29T11:00:00Z' },
    { id: 'a2', projectId: 'p1', clusterId: 'c1', topic: 'how to choose an msp ', keyword: 'msp checklist', sections: 9, words: 1450, stage: 'draft', updatedAt: '2026-09-30T09:00:00Z' },
  ],
  enhancements: [
    { url: 'https://www.site.com/blog/msp/', clusterId: 'c1', coverage: { covered: 9, total: 12 }, additions: 4, updatedAt: '2026-09-28T00:00:00Z' },
    { url: 'https://site.com/removed-page', clusterId: 'c9', updatedAt: '2026-09-01T00:00:00Z' },
  ],
};

const pageById = new Map([
  ['h', { url: 'https://site.com/blog' }],
  ['s1', { url: 'https://site.com/blog/msp' }],
  ['s2', { url: 'https://site.com/blog/other' }],
]);
const cluster = { id: 'c1', hubPageId: 'h', spokeIds: ['s1', 's2'] };

test('page keys ignore scheme, www., trailing slash and host case', () => {
  assert.strictEqual(pageKey('https://www.Site.com/blog/msp/'), pageKey('http://site.com/blog/msp'));
  assert.notStrictEqual(pageKey('https://site.com/a?x=1'), pageKey('https://site.com/a'));
  assert.strictEqual(pageKey('not a url/'), 'not a url');
});

test('a topic gathers its keyword set and every article, newest first, case- and space-insensitively', () => {
  const idx = indexWork(work);
  const e = idx.forTopic('c1', 'How to Choose an MSP');
  assert.strictEqual(e.keywords.seed, 'choose msp');
  assert.deepStrictEqual(e.articles.map((a) => a.id), ['a2', 'a1']);
  assert.deepStrictEqual(idx.forTopic('c1', 'Nothing here'), { keywords: null, articles: [] });
  assert.deepStrictEqual(idx.forTopic('c2', 'How to Choose an MSP'), { keywords: null, articles: [] }, 'topics are per cluster');
});

test('an enhancement is found from the page URL as the report lists it', () => {
  const idx = indexWork(work);
  assert.strictEqual(idx.forPage('https://site.com/blog/msp').coverage.covered, 9);
  assert.strictEqual(idx.forPage('https://site.com/blog'), null);
  assert.strictEqual(idx.forPage(null), null);
});

test('the collapsed row tally counts keyword sets, briefs, drafts and enhanced pages', () => {
  const t = indexWork(work).tally(cluster, pageById);
  assert.deepStrictEqual(t, { keywords: 2, briefs: 1, drafts: 1, enhanced: 1, total: 5 });
  assert.strictEqual(indexWork(null).tally(cluster, pageById).total, 0);
});

test('earlier topics are this cluster\'s saved work the report no longer shows', () => {
  const idx = indexWork(work);
  assert.deepStrictEqual(idx.earlierTopics('c1', ['How to Choose an MSP']).map((e) => e.topic), ['Old Suggestion']);
  assert.deepStrictEqual(idx.earlierTopics('c1', ['how to choose an msp', 'OLD SUGGESTION']), []);
});

test('orphans: work for clusters and pages this analysis no longer has', () => {
  const o = indexWork(work).orphans(['c1'], [...pageById.values()].map((p) => p.url));
  assert.deepStrictEqual(o.topics.map((e) => e.topic), ['From a previous run']);
  assert.deepStrictEqual(o.enhancements.map((e) => e.url), ['https://site.com/removed-page']);
});

test('topic stages: keywords, brief and draft, from the newest article', () => {
  const idx = indexWork(work);
  const [k, b, d] = topicStages(idx.forTopic('c1', 'How to Choose an MSP'));
  assert.deepStrictEqual([k.done, b.done, d.done], [true, true, true]);
  assert.strictEqual(k.meta, '2 P · 2 S');
  assert.strictEqual(d.meta, '1,450 words');
  const [k2, b2, d2] = topicStages({ keywords: null, articles: [] });
  assert.deepStrictEqual([k2.done, b2.done, d2.done], [false, false, false]);
});

test('the panel\'s own saved picks win over the page summary', () => {
  const summary = { primary: [{ keyword: 'x' }], secondary: [] };
  const saved = { result: { result: { primary: [{ keyword: 'ai' }], secondary: [{ keyword: 's' }] } }, selection: { primary: [{ keyword: 'edited' }], secondary: [] } };
  assert.deepStrictEqual(currentPicks(summary, saved).primary.map((k) => k.keyword), ['edited']);
  assert.deepStrictEqual(currentPicks(summary, { result: saved.result }).secondary.map((k) => k.keyword), ['s'], 'no edits yet: the AI picks');
  assert.deepStrictEqual(currentPicks(summary, null).primary.map((k) => k.keyword), ['x']);
  assert.strictEqual(topicStages({ keywords: summary, articles: [] }, saved)[0].meta, '1 P · 0 S');
});

test('time ago and the Content Writer link', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.strictEqual(timeAgo('2026-09-30T11:59:40Z', now), 'just now');
  assert.strictEqual(timeAgo('2026-09-30T11:15:00Z', now), '45m ago');
  assert.strictEqual(timeAgo('2026-09-30T07:00:00Z', now), '5h ago');
  assert.strictEqual(timeAgo('2026-09-27T12:00:00Z', now), '3d ago');
  assert.strictEqual(timeAgo('nope', now), '');
  assert.strictEqual(articleHref({ projectId: 'p 1', id: 'a1' }), '/content-writer?project=p+1&article=a1');
});
