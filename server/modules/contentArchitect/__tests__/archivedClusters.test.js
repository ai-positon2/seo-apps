// ── Archived topics: matched across analyses, and left out of everything ────
//
// A client may archive a Hub and Spoke topic it does not target. Cluster ids
// are positional, so an archive is matched to each analysis by its anchor
// (member pages, then hub page, then name), and the matched cluster and its
// pages leave the analysis. With nothing archived the analysis is untouched.
//
// Run: node --test modules/contentArchitect/__tests__/archivedClusters.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const archived = require('../archivedClusters');

const page = (id, path, extra = {}) => ({ id, url: `https://www.site.com${path}`, ...extra });
const pages = [
  page('p1', '/blog/mobile-apps', { clusterId: 'cluster_0', flags: ['orphan'] }),
  page('p2', '/blog/deep-linking', { clusterId: 'cluster_0', flags: ['buried'] }),
  page('p3', '/blog/app-store', { clusterId: 'cluster_0' }),
  page('p4', '/blog/responsive', { clusterId: 'cluster_1' }),
  page('p5', '/blog/media-queries', { clusterId: 'cluster_1', flags: ['thin-or-stale'] }),
  page('p6', '/blog/fluid-grids', { clusterId: 'cluster_1' }),
  page('p7', '/blog/pricing-guide', { clusterId: 'cluster_2' }),
  page('p8', '/blog/pricing-faq', { clusterId: 'cluster_2' }),
];
const first = {
  generatedAt: '2026-10-01T00:00:00Z',
  pages,
  unassignedPages: [page('u1', '/blog/misc')],
  cannibalization: [{ clusterId: 'cluster_0', pairs: [{ pageA: 'a', pageB: 'b', similarity: 0.9 }] }],
  clusters: [
    { id: 'cluster_0', name: 'Mobile Apps', hubPageId: 'p1', spokeIds: ['p2', 'p3'], health: 40, isGap: false },
    { id: 'cluster_1', name: 'Responsive Design', hubPageId: 'p4', spokeIds: ['p5', 'p6'], health: 80, isGap: false },
    { id: 'cluster_2', name: 'Pricing', hubPageId: null, spokeIds: ['p7', 'p8'], health: 30, isGap: true },
  ],
};

const entryFor = (analysis, clusterId, extra = {}) => {
  const anchor = archived.anchorFor(analysis, clusterId);
  return { key: archived.keyFor(anchor), anchor, archivedBy: 'a@b.com', archivedAt: '2026-11-01T00:00:00Z', ...extra };
};

test('an anchor names the cluster by its pages, hub and name, without scheme or www', () => {
  const anchor = archived.anchorFor(first, 'cluster_0');
  assert.deepEqual(anchor, {
    memberUrls: ['site.com/blog/app-store', 'site.com/blog/deep-linking', 'site.com/blog/mobile-apps'],
    hubUrl: 'site.com/blog/mobile-apps',
    name: 'Mobile Apps',
  });
  assert.equal(archived.anchorFor(first, 'cluster_9'), null);
  assert.equal(archived.keyFor(anchor), archived.keyFor({ ...anchor }), 'the key is stable');
  assert.notEqual(archived.keyFor(anchor), archived.keyFor(archived.anchorFor(first, 'cluster_1')));
});

test('with nothing archived the analysis is returned as is', () => {
  assert.equal(archived.excludeArchived(first, []).analysis, first);
  assert.equal(archived.excludeArchived(first, null).analysis, first);
  assert.equal(archived.excludeArchived(first, [{ junk: true }]).analysis, first, 'entries without an anchor are ignored');
});

test('an archived cluster, its pages and its cannibalization leave the analysis', () => {
  const { analysis, archived: list } = archived.excludeArchived(first, [entryFor(first, 'cluster_0')]);
  assert.deepEqual(analysis.clusters.map((c) => c.id), ['cluster_1', 'cluster_2']);
  assert.deepEqual(analysis.pages.map((p) => p.id), ['p4', 'p5', 'p6', 'p7', 'p8']);
  assert.deepEqual(analysis.cannibalization, []);
  assert.equal(analysis.unassignedPages.length, 1, 'unassigned pages stay');
  assert.equal(list.length, 1);
  assert.equal(list[0].clusterId, 'cluster_0');
  assert.equal(list[0].inAnalysis, true);
  assert.equal(list[0].health, 40);
  assert.equal(list[0].pageUrls.length, 3);
  assert.equal(analysis.archivedClusters, list);
  assert.equal(archived.meanHealth(analysis.clusters), 55, 'mean of 80 and 30');
  assert.equal(archived.meanHealth(first.clusters), 50, 'unchanged without archives');
  assert.equal(first.clusters.length, 3, 'the input is not mutated');
});

test('an archive follows its topic to a re-run that renumbers the clusters and adds a page', () => {
  const entry = entryFor(first, 'cluster_0');
  const rerun = {
    pages: [...pages, page('p9', '/blog/app-clips', { clusterId: 'cluster_1' })]
      .map((p) => ({ ...p, clusterId: p.clusterId === 'cluster_0' ? 'cluster_1' : p.clusterId === 'cluster_1' ? 'cluster_0' : p.clusterId })),
    clusters: [
      { id: 'cluster_0', name: 'Responsive Design', hubPageId: 'p4', spokeIds: ['p5', 'p6'], health: 80 },
      { id: 'cluster_1', name: 'Mobile Apps & Clips', hubPageId: 'p1', spokeIds: ['p2', 'p3', 'p9'], health: 45 },
    ],
  };
  const { analysis, archived: list } = archived.excludeArchived(rerun, [entry]);
  assert.deepEqual(analysis.clusters.map((c) => c.name), ['Responsive Design']);
  assert.equal(list[0].clusterId, 'cluster_1');
  assert.equal(list[0].name, 'Mobile Apps & Clips');
});

test('without enough shared pages the hub page, then the name, decide', () => {
  const entry = entryFor(first, 'cluster_1');
  const byHub = {
    pages: [page('p4', '/blog/responsive'), page('n1', '/blog/a'), page('n2', '/blog/b'), page('n3', '/blog/c')],
    clusters: [{ id: 'cluster_0', name: 'Something else', hubPageId: 'p4', spokeIds: ['n1', 'n2', 'n3'], health: 10 }],
  };
  assert.equal(archived.matchArchived(byHub, [entry]).byCluster.get('cluster_0'), entry);
  const byName = {
    pages: [page('m1', '/x'), page('m2', '/y')],
    clusters: [{ id: 'cluster_4', name: 'responsive design ', hubPageId: 'm1', spokeIds: ['m2'], health: 10 }],
  };
  assert.equal(archived.matchArchived(byName, [entry]).byCluster.get('cluster_4'), entry);
  const none = { pages: [page('z1', '/z')], clusters: [{ id: 'cluster_0', name: 'Other', hubPageId: 'z1', spokeIds: [] }] };
  const { analysis, archived: list } = archived.excludeArchived(none, [entry]);
  assert.equal(analysis.clusters.length, 1, 'nothing matched, nothing removed');
  assert.equal(list[0].inAnalysis, false, 'still listed, for Restore');
});

test('one archive claims one cluster, and one cluster is claimed once', () => {
  const a = entryFor(first, 'cluster_0');
  const dup = { ...a, key: 'other' };
  const { byCluster } = archived.matchArchived(first, [a, dup]);
  assert.equal(byCluster.size, 1);
  assert.equal(byCluster.get('cluster_0'), a);
});

test('archiving every cluster leaves no score rather than 0', () => {
  const all = first.clusters.map((c) => entryFor(first, c.id));
  const { analysis } = archived.excludeArchived(first, all);
  assert.equal(analysis.clusters.length, 0);
  assert.equal(archived.meanHealth(analysis.clusters), null);
});
