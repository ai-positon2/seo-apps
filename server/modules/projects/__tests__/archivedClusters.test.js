// ── Archived Hub and Spoke topics, applied to a stored run on read ──────────
//
// The run's score, band, findings and payload were worked out when the
// analysis ran. An archive made later takes effect on read: the figures are
// recomputed from the analysis with the archived clusters left out, by the
// runner's own functions. A project with nothing archived reads the same row.
//
// Run: node --test modules/projects/__tests__/archivedClusters.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const apply = require('../archivedClusters');
const topics = require('../../contentArchitect/archivedClusters');
const { hubSpokeFacts, hubSpokeFindings } = require('../moduleRunners');

const page = (id, p, extra = {}) => ({ id, url: `https://site.com${p}`, ...extra });
const analysis = {
  pages: [
    page('p1', '/a', { clusterId: 'cluster_0', flags: ['orphan'] }),
    page('p2', '/b', { clusterId: 'cluster_0', flags: ['buried'] }),
    page('p3', '/c', { clusterId: 'cluster_0' }),
    page('p4', '/d', { clusterId: 'cluster_1' }),
    page('p5', '/e', { clusterId: 'cluster_1', inboundLinkCount: 2 }),
    page('p6', '/f', { clusterId: 'cluster_2' }),
    page('p7', '/g', { clusterId: 'cluster_2' }),
  ],
  unassignedPages: [],
  cannibalization: [{ clusterId: 'cluster_0', pairs: [{}, {}] }],
  clusters: [
    { id: 'cluster_0', name: 'Archived one', hubPageId: null, spokeIds: ['p1', 'p2', 'p3'], health: 20, isGap: true },
    { id: 'cluster_1', name: 'Kept', hubPageId: 'p4', spokeIds: ['p5'], health: 90, isGap: false },
    { id: 'cluster_2', name: 'Kept too', hubPageId: 'p6', spokeIds: ['p7'], health: 71, isGap: false },
  ],
};
const entry = (() => {
  const anchor = topics.anchorFor(analysis, 'cluster_0');
  return { key: topics.keyFor(anchor), anchor };
})();

const run = {
  id: 'r1', module_key: 'hub_spoke', status: 'completed',
  score: 60, score_max: 100, score_basis: 'Content Architect: mean cluster health (v2)',
  band: '3 clusters', counts: { error: 1, warning: 2, notice: 1, info: 0 },
  findings: [{ ruleId: 'architect-gap-hubs', severity: 'warning' }],
  cardNote: '7 informational page(s) of 30 found · 3 cluster(s), 1 without a hub',
  note: 'Clustered 7 informational page(s).',
};

test('the runner\'s own figures and findings are unchanged by the extraction', () => {
  const facts = hubSpokeFacts(analysis);
  assert.equal(facts.meanHealth, 60);
  const ids = hubSpokeFindings(facts).map((f) => f.ruleId);
  assert.deepEqual(ids, ['architect-gap-hubs', 'architect-orphan-pages', 'architect-buried-pages', 'architect-possible-cannibalization']);
  assert.ok(!hubSpokeFindings(facts, { capped: true }).some((f) => f.ruleId === 'architect-orphan-pages'),
    'a capped crawl withholds orphans');
  const cannibal = hubSpokeFindings(facts).find((f) => f.ruleId === 'architect-possible-cannibalization');
  assert.equal(cannibal.detail, '2 page pair(s) across 1 cluster(s)');
});

test('with nothing archived, the very same row comes back', async () => {
  assert.equal(await apply.applyToRun('p', run, { summary: null }), run);
  const other = { ...run, module_key: 'seo_geo' };
  assert.equal(await apply.applyToRun('p', other, { summary: {} }), other, 'other modules untouched');
  const failed = { ...run, status: 'failed' };
  assert.equal(await apply.applyToRun('p', failed, { summary: {} }), failed);
});

test('an archived cluster leaves the score, band, counts, findings and notes', async () => {
  const { analysis: filtered, archived } = topics.excludeArchived(analysis, [entry]);
  const summary = apply.summarize(filtered, archived);
  assert.equal(summary.matched, 1);
  const out = await apply.applyToRun('p', run, { summary });
  assert.equal(out.score, 81, 'mean of 90 and 71');
  assert.equal(out.band, '2 clusters · 1 topic archived');
  assert.match(out.score_basis, /1 topic archived for this client, left out$/);
  assert.equal(out.cardNote, '7 informational page(s) of 30 found · 2 cluster(s), 0 without a hub · 1 topic archived');
  assert.match(out.note, /1 topic archived for this client is left out/);
  assert.deepEqual(out.findings, [], 'the gap, orphan, buried and cannibalization findings were all in the archived topic');
  assert.deepEqual(out.counts, { error: 0, warning: 0, notice: 0, info: 0 });
  assert.equal(out.archivedClusterCount, 1);
  assert.equal(run.score, 60, 'the stored row is not mutated');
});

test('the full payload is recomputed too, when the row carries one', async () => {
  const { analysis: filtered, archived } = topics.excludeArchived(analysis, [entry]);
  const summary = apply.summarize(filtered, archived);
  const out = await apply.applyToRun('p', {
    ...run,
    payload: { clusterCount: 3, gapHubCount: 1, orphanCount: 1, meanHealth: 60, pagesAnalyzed: 7, clusters: [], cardNote: run.cardNote },
  }, { summary });
  assert.equal(out.payload.clusterCount, 2);
  assert.equal(out.payload.gapHubCount, 0);
  assert.equal(out.payload.orphanCount, 0);
  assert.equal(out.payload.meanHealth, 81);
  assert.equal(out.payload.pagesAnalyzed, 4);
  assert.deepEqual(out.payload.clusters.map((c) => c.name), ['Kept', 'Kept too']);
  const capped = apply.applyToPayload({ orphanCount: null }, summary);
  assert.equal(capped.orphanCount, null, 'withheld stays withheld');
});

test('every reader of the run goes through the archive', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('moduleEvidence.js'), /archivedClusters'\)\.applyToRun\(projectId, hubSpoke\.terminal\)/);
  assert.match(read('overview.js'), /applyToRun\(projectRow\.id, \{ \.\.\.fresh, module_key: 'hub_spoke' \}\)/);
  assert.match(read('moduleDetail.js'), /applyToRun\(projectId, terminal\)/);
  assert.match(read('report.js'), /structureFor\(access\.project\.id, s/);
  assert.match(read('insights/findingIndex.js'), /applyToPayload\(moduleStructure/);
});

test('the store writes only the archivedClusters key, from the row\'s current settings', () => {
  const store = fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8');
  const body = store.slice(store.indexOf('async function archiveCluster'), store.indexOf('async function unarchiveCluster'));
  assert.match(body, /coalesce\(settings, '\{\}'::jsonb\) \|\| jsonb_build_object\('archivedClusters'/);
  assert.doesNotMatch(body, /settings = \$/, 'never a whole settings blob from the client');
});
