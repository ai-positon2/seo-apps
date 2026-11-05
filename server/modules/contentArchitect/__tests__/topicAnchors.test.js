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

test('an unanchored item with no telling text is trusted only when made after the analysis', () => {
  const resolve = anchors.resolverFor(second);
  assert.deepEqual(resolve({ clusterId: 'cluster_1', updatedAt: '2026-10-21T00:00:00Z' }), { clusterId: 'cluster_1', orphaned: false });
  assert.equal(resolve({ clusterId: 'cluster_1', updatedAt: '2026-10-02T00:00:00Z' }).orphaned, true);
  // An analysis from before generatedAt: dated by the run that made it. With
  // neither (a standalone project, no completed run) nothing says the item
  // moved, so it stays where it was stored.
  const legacy = anchors.resolverFor({ ...second, generatedAt: undefined });
  assert.equal(legacy({ clusterId: 'cluster_1', updatedAt: '2026-10-02T00:00:00Z' }).orphaned, false);
  assert.equal(legacy({ clusterId: 'cluster_1' }).orphaned, false);
  const dated = anchors.resolverFor({ ...second, generatedAt: undefined }, { analysedAt: '2026-10-20T00:00:00Z' });
  assert.equal(dated({ clusterId: 'cluster_1', updatedAt: '2026-10-21T00:00:00Z' }).orphaned, false);
  assert.equal(dated({ clusterId: 'cluster_1', updatedAt: '2026-10-02T00:00:00Z' }).orphaned, true);
  const ownGeneratedAtWins = anchors.resolverFor(second, { analysedAt: '2026-12-01T00:00:00Z' });
  assert.equal(ownGeneratedAtWins({ clusterId: 'cluster_1', updatedAt: '2026-10-21T00:00:00Z' }).orphaned, false);
});

// ── Legacy work on a legacy analysis: Position2 (UX-159 residual) ───────────
// The stored analysis has no generatedAt. Saved work carries no anchor. The
// deep-linking page sat in cluster_23 when the work was saved and now sits in
// cluster_18 'Mobile Apps vs Websites'; cluster_23 is 'Responsive Web Design Basics'.
const p2 = (id, path, title) => ({ id, url: `https://www.position2.com${path}`, title: `${title} | Position²` });
const position2 = {
  pages: [
    p2('page_28631628fb1b', '/blog/mobile-apps-vs-websites', 'Mobile Apps vs Websites: Which Is Right for You'),
    p2('page_27996fbe4218', '/blog/take-mobile-app-marketing-campaigns-next-level-deep-linking', 'Take Your Mobile App Marketing Campaigns to the Next Level with Deep Linking'),
    p2('page_m3', '/blog/app-store-optimization', 'App Store Optimization for Mobile Apps'),
    p2('page_0352f4c5e48c', '/blog/responsive-web-design-basics', 'Responsive Web Design Basics'),
    p2('page_r2', '/blog/css-media-queries', 'CSS Media Queries Explained'),
    p2('page_r3', '/blog/fluid-grid-layouts', 'Fluid Grid Layouts for Responsive Sites'),
    p2('page_x1', '/blog/b2b-email-nurture', 'B2B Email Nurture Programs'),
    p2('page_x2', '/blog/email-subject-lines', 'Email Subject Lines That Work'),
    p2('page_x3', '/blog/email-deliverability', 'Email Deliverability Checklist'),
  ],
  clusters: [
    { id: 'cluster_18', name: 'Mobile Apps vs Websites', hubPageId: 'page_28631628fb1b', spokeIds: ['page_27996fbe4218', 'page_m3'] },
    { id: 'cluster_23', name: 'Responsive Web Design Basics', hubPageId: 'page_0352f4c5e48c', spokeIds: ['page_r2', 'page_r3'] },
    { id: 'cluster_4', name: 'Email Marketing', hubPageId: 'page_x1', spokeIds: ['page_x2', 'page_x3'] },
  ],
};
const RUN_AT = { analysedAt: '2026-11-03T08:47:47.172Z' };

test('Position2: legacy deep-linking work saved under cluster_23 is not shown under Responsive Web Design', () => {
  const work = {
    keywordResearch: [
      { clusterId: 'cluster_23', topic: 'Deep Linking for Mobile App Campaigns', seed: 'mobile deep linking', primary: [{ keyword: 'deep linking mobile apps' }], secondary: [], anchor: null, updatedAt: '2026-10-26T10:00:00Z' },
      { clusterId: 'cluster_23', topic: 'Responsive Breakpoints for Fluid Grids', seed: 'responsive breakpoints', primary: [], secondary: [], anchor: null, updatedAt: '2026-10-26T10:00:00Z' },
    ],
    articles: [
      { id: 'a1', clusterId: 'cluster_23', topic: 'Deep Linking for Mobile App Campaigns', keyword: 'deep linking mobile apps', updatedAt: '2026-10-27T00:00:00Z' },
      { id: 'a2', clusterId: 'cluster_23', topic: 'Mobile App Install Campaigns', keyword: 'app install campaigns', title: 'Mobile App Install Campaigns', updatedAt: '2026-10-27T00:00:00Z' },
    ],
    enhancements: [
      { clusterId: 'cluster_23', url: 'https://www.position2.com/blog/take-mobile-app-marketing-campaigns-next-level-deep-linking', updatedAt: '2026-10-26T00:00:00Z' },
    ],
  };
  const out = anchors.remapWork(work, position2, RUN_AT);
  const [deep, responsive] = out.keywordResearch;
  assert.equal(deep.orphaned, true, 'its text points at Mobile Apps, not the topic now called cluster_23');
  assert.equal(deep.formerClusterId, 'cluster_23');
  assert.ok(deep.clusterId.startsWith(anchors.EARLIER_PREFIX));
  assert.equal(responsive.clusterId, 'cluster_23', 'its text agrees with the topic it is stored under');
  assert.ok(!responsive.orphaned);
  assert.equal(out.articles[0].orphaned, true, 'follows its keyword set');
  assert.equal(out.articles[1].orphaned, true, 'its own text points elsewhere');
  assert.equal(out.enhancements[0].clusterId, 'cluster_18', 'an enhancement follows its page');
  assert.equal(out.enhancements[0].formerClusterId, 'cluster_23');

  // The per-cluster read follows the same rule.
  assert.deepEqual(anchors.storedIdsFor('cluster_23', out.keywordResearch.map((k) => ({ ...k, clusterId: k.formerClusterId || k.clusterId })), position2, RUN_AT), ['cluster_23']);
});

test('Position2: legacy spoke suggestions are placed by their source topic, or by being made on this analysis', () => {
  const stored = {
    cluster_23: { generatedAt: '2026-10-25T00:00:00Z', suggestions: [{ title: 'Deferred Deep Linking for Mobile App Installs' }, { title: 'Deep Links in App Marketing Campaigns' }] },
    cluster_4: { generatedAt: '2026-10-25T00:00:00Z', topic: 'B2B Email Nurture Programs', suggestions: [{ title: 'Email Nurture Cadence for B2B' }] },
    cluster_18: { generatedAt: '2026-10-25T00:00:00Z', suggestions: [{ title: 'Quarterly Planning Template' }] },
  };
  const { byCluster, earlier } = anchors.remapSuggestions(stored, position2, RUN_AT);
  assert.deepEqual(Object.keys(byCluster), ['cluster_4'], 'only the one whose source topic backs its cluster stays');
  assert.deepEqual(earlier.map((e) => e.formerClusterId).sort(), ['cluster_18', 'cluster_23'],
    'no source topic and older than the run: earlier work (titles of new spokes are not evidence)');

  // A suggestion the analysis itself still carries was made on it.
  const own = { ...position2, spokeSuggestionsByCluster: { cluster_18: stored.cluster_18 } };
  assert.ok(anchors.remapSuggestions(stored, own, RUN_AT).byCluster.cluster_18);
});

test('an unanchored item saved AFTER the analysis keeps its cluster even if its words lean elsewhere', () => {
  const resolve = anchors.resolverFor(position2, RUN_AT);
  const r = resolve({ clusterId: 'cluster_23', topic: 'Deep Linking for Mobile App Campaigns', updatedAt: '2026-11-04T00:00:00Z' });
  assert.deepEqual(r, { clusterId: 'cluster_23', orphaned: false });
  // Time unknown and the text clearly points elsewhere: earlier work.
  const unknown = anchors.resolverFor(position2);
  assert.equal(unknown({ clusterId: 'cluster_23', topic: 'Deep Linking for Mobile App Campaigns' }).orphaned, true);
  assert.equal(unknown({ clusterId: 'cluster_23', topic: 'Position2 blog' }).orphaned, false, 'no verdict, no time: stays');
});

test('a spoke suggestion saved after the analysis is not moved by its suggested titles', () => {
  const stored = { cluster_23: { generatedAt: '2026-11-04T00:00:00Z', suggestions: [{ title: 'Deep Linking for Mobile App Installs' }] } };
  assert.ok(anchors.remapSuggestions(stored, position2, RUN_AT).byCluster.cluster_23);
});

test('evidence ignores words every topic shares, such as the brand in each title', () => {
  const resolve = anchors.resolverFor(position2, RUN_AT);
  assert.equal(resolve({ clusterId: 'cluster_23', topic: 'Position2 blog', updatedAt: '2026-11-04T00:00:00Z' }).orphaned, false,
    'no telling text, made after the run: trusted');
  assert.equal(resolve({ clusterId: 'cluster_23', topic: 'Position2 blog', updatedAt: '2026-10-04T00:00:00Z' }).orphaned, true);
  assert.ok(anchors.itemTerms({ topic: 'Deep Linking Apps', primary: ['links'] }).has('link'));
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
