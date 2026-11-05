// ── Saved work stays with the topic it was made for (UX-159) ────────────────
//
// Cluster ids are positional, so after a re-run cluster_23's saved spoke ideas
// rendered under whatever topic was now 23rd. topicAnchors places each saved
// item by the pages of the cluster it was made for.
//
// Run: node --test modules/contentArchitect/__tests__/topicAnchors.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const anchors = require('../topicAnchors');

const page = (id, path) => ({ id, url: `https://www.site.com${path}` });
const pages = [
  page('p1', '/blog/mobile-apps-vs-websites'), page('p2', '/blog/deep-linking'), page('p3', '/blog/app-store'),
  page('p4', '/blog/responsive-basics'), page('p5', '/blog/media-queries'), page('p6', '/blog/fluid-grids'),
];

// The first run: Mobile is cluster_0, Responsive is cluster_1.
const first = {
  generatedAt: '2026-10-01T00:00:00Z',
  pages,
  clusters: [
    { id: 'cluster_0', name: 'Mobile Apps vs Websites', hubPageId: 'p1', spokeIds: ['p2', 'p3'] },
    { id: 'cluster_1', name: 'Responsive Web Design Basics', hubPageId: 'p4', spokeIds: ['p5', 'p6'] },
  ],
};
// The re-run: a page was added and the order flipped.
const second = {
  generatedAt: '2026-10-20T00:00:00Z',
  pages: [...pages, page('p7', '/blog/viewport')],
  clusters: [
    { id: 'cluster_0', name: 'Responsive Web Design Basics', hubPageId: 'p4', spokeIds: ['p5', 'p6', 'p7'] },
    { id: 'cluster_1', name: 'Mobile Apps vs Websites', hubPageId: 'p1', spokeIds: ['p2', 'p3'] },
  ],
};

test('a saved suggestion follows its topic to its new cluster id, never onto another topic', () => {
  const stored = {
    cluster_0: { suggestions: [{ title: 'Deep links explained' }], generatedAt: '2026-10-05T00:00:00Z', anchor: anchors.anchorFor(first, 'cluster_0') },
  };
  const { byCluster, earlier } = anchors.remapSuggestions(stored, second);
  assert.deepEqual(Object.keys(byCluster), ['cluster_1'], 'Mobile is cluster_1 now');
  assert.equal(byCluster.cluster_1.suggestions[0].title, 'Deep links explained');
  assert.equal(earlier.length, 0);
});

test('a topic that is gone, or a legacy item older than the analysis, is "from an earlier analysis"', () => {
  const gone = { ...second, clusters: [second.clusters[0]] };
  const stored = {
    cluster_0: { suggestions: [], generatedAt: '2026-10-05T00:00:00Z', anchor: anchors.anchorFor(first, 'cluster_0') },
    cluster_9: { suggestions: [], generatedAt: '2026-10-02T00:00:00Z' },
  };
  const { byCluster, earlier } = anchors.remapSuggestions(stored, gone);
  assert.deepEqual(byCluster, {});
  assert.deepEqual(earlier.map((e) => e.formerClusterId).sort(), ['cluster_0', 'cluster_9']);
  assert.equal(earlier.find((e) => e.formerClusterId === 'cluster_0').topic, 'Mobile Apps vs Websites');
});

test('an unanchored item made after the analysis it sits on is trusted; with no analysis date nothing moves', () => {
  const resolve = anchors.resolverFor(second);
  assert.deepEqual(resolve({ clusterId: 'cluster_1', updatedAt: '2026-10-21T00:00:00Z' }), { clusterId: 'cluster_1', orphaned: false });
  assert.equal(resolve({ clusterId: 'cluster_1', updatedAt: '2026-10-02T00:00:00Z' }).orphaned, true);
  const legacy = anchors.resolverFor({ ...second, generatedAt: undefined });
  assert.equal(legacy({ clusterId: 'cluster_1', updatedAt: '2026-10-02T00:00:00Z' }).orphaned, false);
});

test('keyword sets and their articles move together; an orphan cannot match a current cluster id', () => {
  const work = {
    keywordResearch: [{ clusterId: 'cluster_0', topic: 'Deep links explained', anchor: anchors.anchorFor(first, 'cluster_0'), updatedAt: '2026-10-05T00:00:00Z' }],
    articles: [{ id: 'a1', clusterId: 'cluster_0', topic: 'deep links explained ', updatedAt: '2026-10-06T00:00:00Z' }],
    enhancements: [],
  };
  const out = anchors.remapWork(work, second);
  assert.equal(out.keywordResearch[0].clusterId, 'cluster_1');
  assert.equal(out.articles[0].clusterId, 'cluster_1');

  const orphan = anchors.remapWork({ ...work, keywordResearch: [{ ...work.keywordResearch[0], anchor: null, updatedAt: '2026-10-05T00:00:00Z' }] }, second);
  assert.equal(orphan.keywordResearch[0].orphaned, true);
  assert.ok(orphan.keywordResearch[0].clusterId.startsWith(anchors.EARLIER_PREFIX));
  assert.equal(orphan.articles[0].orphaned, true, 'the article follows its keyword set');
});

test('the per-cluster read finds rows under the id their topic used to have', () => {
  const summaries = [
    { clusterId: 'cluster_0', topic: 'Deep links explained', anchor: anchors.anchorFor(first, 'cluster_0') },
    { clusterId: 'cluster_1', topic: 'Media queries 101', anchor: anchors.anchorFor(first, 'cluster_1') },
  ];
  assert.deepEqual(anchors.storedIdsFor('cluster_1', summaries, second), ['cluster_0']);
  assert.deepEqual(anchors.storedIdsFor('cluster_0', summaries, second), ['cluster_1']);
  assert.deepEqual(anchors.storedIdsFor('cluster_0', summaries, null), ['cluster_0'], 'no analysis: ids are taken as stored');
});

test('member URLs compare without scheme, www. or trailing slash', () => {
  assert.equal(anchors.urlKey('https://www.Site.com/blog/a/'), anchors.urlKey('http://site.com/blog/a'));
  assert.equal(anchors.jaccard(['a', 'b'], ['a', 'b', 'c']), 2 / 3);
});
