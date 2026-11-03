// ── Stage 7: diagnostics ──────────────────────────────────────────────────────
// Every finding carries machine-readable evidence, not just a label — that's
// what makes the deliverable defensible to a client (spec's own framing).
// Cannibalization is labeled "possible" everywhere user-facing: it's inferred
// from content similarity, never measured from impressions.
const {
  BURIED_CLICK_DEPTH, CANNIBALIZATION_SIMILARITY_THRESHOLD, THIN_WORD_COUNT, STALE_MONTHS, CLUSTER_HEALTH_WEIGHTS,
  UNVERIFIED_HUB_CREDIT,
} = require('./config');
const { breadthScore } = require('./hubSelection');

const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;

function monthsSince(dateStr, now) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return (now - d.getTime()) / MS_PER_MONTH;
}

// Per-page flags: orphan, buried, thin-or-stale. Cross-page (cannibalization)
// is computed separately per cluster, below.
function pageFlags(pageIndex, pages, inboundCounts, depths, now) {
  const flags = [];
  const page = pages[pageIndex];

  if (inboundCounts[pageIndex] === 0) flags.push({ type: 'orphan', severity: 'medium', evidence: {} });

  const depth = depths[pageIndex];
  if (depth !== Infinity && depth >= BURIED_CLICK_DEPTH) {
    flags.push({ type: 'buried', severity: 'low', evidence: { depth } });
  }

  const age = monthsSince(page.modifiedAt, now);
  const thin = (page.wordCount || 0) > 0 && page.wordCount < THIN_WORD_COUNT;
  const stale = age !== null && age > STALE_MONTHS;
  if (thin || stale) {
    flags.push({
      type: 'thin-or-stale', severity: 'medium',
      evidence: { wordCount: page.wordCount, modifiedAt: page.modifiedAt, monthsSinceModified: age !== null ? Math.round(age) : null, thin, stale },
    });
  }

  return flags;
}

// Every pair within a cluster whose similarity is at/above threshold —
// labeled "possible" per spec, never asserted as confirmed cannibalization.
function cannibalizationPairs(memberIndices, matrix, pages, profiles) {
  const pairs = [];
  for (let a = 0; a < memberIndices.length; a++) {
    for (let b = a + 1; b < memberIndices.length; b++) {
      const i = memberIndices[a];
      const j = memberIndices[b];
      const sim = matrix[i][j];
      if (sim >= CANNIBALIZATION_SIMILARITY_THRESHOLD) {
        const sharedTerms = [...profiles[i].keys()].filter((t) => profiles[j].has(t)).slice(0, 10);
        pairs.push({ pageA: pages[i].url, pageB: pages[j].url, similarity: sim, sharedTerms });
      }
    }
  }
  return pairs;
}

function clusterLinkDensity(memberIndices, graph) {
  const n = memberIndices.length;
  if (n < 2) return 0;
  const memberSet = new Set(memberIndices);
  let actual = 0;
  for (const i of memberIndices) for (const j of graph[i]) if (memberSet.has(j)) actual++;
  const possible = n * (n - 1); // directed pairs
  return possible === 0 ? 0 : actual / possible;
}

// Hub <-> spoke linking, 0-1: the share of spokes that link up to the hub and
// the share the hub links down to, averaged. What hub and spoke asks for —
// clusterLinkDensity scored every page linking to every other page as ideal.
function hubSpokeLinking(hubIndex, memberIndices, graph) {
  const spokes = memberIndices.filter((i) => i !== hubIndex);
  if (!spokes.length) return 0;
  // graph entries are Sets in the pipeline (arrays in some callers).
  const linksOf = (i) => new Set(graph[i] || []);
  const hubLinks = linksOf(hubIndex);
  const up = spokes.filter((i) => linksOf(i).has(hubIndex)).length;
  const down = spokes.filter((i) => hubLinks.has(i)).length;
  return (up + down) / (2 * spokes.length);
}

// 0-100 composite — an obvious place for a user with many clusters to start,
// per spec ("show as a colored ring on each cluster card").
function clusterHealth(cluster, hubResult, memberIndices, depths, graph, profiles) {
  const w = CLUSTER_HEALTH_WEIGHTS;
  let score = 0;

  // Full credit for a hub the selection is sure of; part for one it only
  // suggests, or a glossary index standing in, until someone confirms it.
  const unverified = hubResult.hubConfidence === 'suggested' || hubResult.hubConfidence === 'reference';
  if (!hubResult.isGap) score += w.hubPresent * (unverified ? UNVERIFIED_HUB_CREDIT : 1);

  if (!hubResult.isGap && hubResult.hubPageIndex !== null) {
    score += w.hubTermCoverage * breadthScore(hubResult.hubPageIndex, memberIndices, profiles);
    score += w.hubSpokeLinking * hubSpokeLinking(hubResult.hubPageIndex, memberIndices, graph);
  }

  const finiteDepths = memberIndices.map((i) => depths[i]).filter((d) => d !== Infinity);
  if (finiteDepths.length) {
    const meanDepth = finiteDepths.reduce((s, d) => s + d, 0) / finiteDepths.length;
    score += w.clickDepth * Math.max(0, 1 - meanDepth / 8);
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

// Runs all of Stage 7 for one project. `hubResults` is a Map<clusterId,
// hubSelection.selectHub() result>. Returns { pageFlags: Map<pageIndex,
// flag[]>, cannibalization: [{clusterId, pairs}], clusterHealthById: Map }.
function runDiagnostics(clusters, hubResults, pages, matrix, profiles, graph, inboundCounts, depths, now) {
  const flagsByPage = new Map();
  for (let i = 0; i < pages.length; i++) flagsByPage.set(i, pageFlags(i, pages, inboundCounts, depths, now));

  const cannibalization = [];
  const clusterHealthById = new Map();
  for (const cluster of clusters) {
    const pairs = cannibalizationPairs(cluster.memberIndices, matrix, pages, profiles);
    if (pairs.length) cannibalization.push({ clusterId: cluster.id, pairs });

    const hubResult = hubResults.get(cluster.id);
    clusterHealthById.set(cluster.id, clusterHealth(cluster, hubResult, cluster.memberIndices, depths, graph, profiles));
  }

  return { flagsByPage, cannibalization, clusterHealthById };
}

module.exports = { runDiagnostics, pageFlags, cannibalizationPairs, clusterLinkDensity, hubSpokeLinking, clusterHealth };
