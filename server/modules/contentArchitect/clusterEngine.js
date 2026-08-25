// ── Stage 5d: clustering + cleanup rules ─────────────────────────────────────
// Core architectural rule from the spec: deterministic signals do the
// grouping, the LLM (Stage 5e, not built yet — Checkpoint 4) only names and
// explains. Mechanical names here (top-2 TF-IDF terms) are what Stage 5e's
// own fallback uses too, so this is not throwaway Checkpoint-2-only code.
//
const { MIN_CLUSTER_SIZE, MAX_CLUSTER_SIZE, DUAL_CLUSTER_MARGIN, SIMILARITY_THRESHOLD, MECHANICAL_NAME_TERM_COUNT } = require('./config');
const { agglomerativeAverageLinkage } = require('./agglomerativeClustering');
const { computeIdf } = require('./similarity');

function titleCase(term) {
  return term.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

// Top-N TF-IDF terms for a cluster, skipping a candidate that's a substring/
// superstring of an already-chosen term (an n-gram vocabulary can otherwise
// pick "invisalign" then "invisalign cost" and produce a redundant-looking
// pair). Shared by mechanicalName (n=2, the fallback/Stage-3-draft name) and
// llmNaming.js's prompt payload (n=15, "distinguishing terms" per spec 5e).
function topTermsForCluster(memberIndices, profiles, idf, n) {
  const totals = new Map();
  for (const i of memberIndices) {
    for (const [term, weight] of profiles[i]) {
      totals.set(term, (totals.get(term) || 0) + weight * (idf.get(term) || 0));
    }
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const chosen = [];
  for (const [term] of ranked) {
    if (chosen.length >= n) break;
    const overlaps = chosen.some((c) => c.includes(term) || term.includes(c));
    if (!overlaps) chosen.push(term);
  }
  return chosen;
}

function mechanicalName(memberIndices, profiles, idf) {
  const chosen = topTermsForCluster(memberIndices, profiles, idf, MECHANICAL_NAME_TERM_COUNT);
  return chosen.length ? chosen.map(titleCase).join(' & ') : 'Unnamed Cluster';
}

function meanIntraClusterSimilarity(indices, matrix) {
  if (indices.length < 2) return 1;
  let sum = 0;
  let pairs = 0;
  for (let a = 0; a < indices.length; a++) {
    for (let b = a + 1; b < indices.length; b++) {
      sum += matrix[indices[a]][indices[b]];
      pairs++;
    }
  }
  return pairs === 0 ? 1 : sum / pairs;
}

// Descends into an oversized cluster's two dendrogram children (agnes builds
// a strictly binary merge tree, so "both halves" is literal) and keeps the
// split only if EVERY resulting half's mean intra-cluster similarity holds
// at or above the original global threshold — recurses into a half that's
// still oversized, and gives up on a half that fails the coherence bar,
// keeping that half's whole ancestor group intact rather than forcing a bad
// split (per spec: "keep the split only if... coherent").
function subdivide(node, matrix, threshold) {
  const indices = node.indices();
  if (indices.length <= MAX_CLUSTER_SIZE || node.isLeaf || node.children.length < 2) return [indices];

  const halves = node.children.map((child) => child.indices());
  const allCoherent = halves.every((half) => meanIntraClusterSimilarity(half, matrix) >= threshold);
  if (!allCoherent) return [indices];

  const result = [];
  for (const child of node.children) {
    if (child.indices().length > MAX_CLUSTER_SIZE) result.push(...subdivide(child, matrix, threshold));
    else result.push(child.indices());
  }
  return result;
}

// Runs Stage 5d clustering (and, when `draft` is true, doubles as Stage 3 —
// same engine, slug-only term profiles produce the same code path). Returns
// { clusters, unassignedIndices } — every index in [0, pages.length) appears
// in exactly one of the two, asserted below.
async function runClustering(profiles, matrix, { threshold = SIMILARITY_THRESHOLD, draft = false } = {}) {
  const n = profiles.length;
  if (n === 0) return { clusters: [], unassignedIndices: [] };
  if (n === 1) return { clusters: [], unassignedIndices: [0] };

  const idf = computeIdf(profiles);

  const distanceMatrix = matrix.map((row) => Array.from(row, (v) => 1 - v));
  const tree = agglomerativeAverageLinkage(distanceMatrix);
  const cut = tree.cut(1 - threshold);

  const groups = cut.flatMap((node) => subdivide(node, matrix, threshold));

  const clusters = [];
  const unassignedIndices = [];
  for (const indices of groups) {
    if (indices.length < MIN_CLUSTER_SIZE) {
      unassignedIndices.push(...indices);
      continue;
    }
    clusters.push({
      id: `cluster_${clusters.length}`,
      memberIndices: indices,
      name: mechanicalName(indices, profiles, idf),
      draft,
      meanSimilarity: meanIntraClusterSimilarity(indices, matrix),
    });
  }

  // Dual-cluster flag: a page whose mean similarity to some OTHER cluster is
  // within DUAL_CLUSTER_MARGIN of its mean similarity to its own cluster.
  for (const cluster of clusters) {
    cluster.dualClusterFlags = new Set();
  }
  const meanSimTo = (pageIdx, memberIndices) => {
    const others = memberIndices.filter((i) => i !== pageIdx);
    if (others.length === 0) return 0;
    return others.reduce((sum, i) => sum + matrix[pageIdx][i], 0) / others.length;
  };
  for (let ci = 0; ci < clusters.length; ci++) {
    for (const pageIdx of clusters[ci].memberIndices) {
      const ownSim = meanSimTo(pageIdx, clusters[ci].memberIndices);
      for (let oi = 0; oi < clusters.length; oi++) {
        if (oi === ci) continue;
        const otherSim = meanSimTo(pageIdx, clusters[oi].memberIndices);
        if (ownSim - otherSim <= DUAL_CLUSTER_MARGIN) {
          clusters[ci].dualClusterFlags.add(pageIdx);
          break;
        }
      }
    }
  }

  const seen = new Set();
  for (const c of clusters) for (const i of c.memberIndices) seen.add(i);
  for (const i of unassignedIndices) seen.add(i);
  if (seen.size !== n) {
    throw new Error(`Clustering invariant violated: ${n} pages in, ${seen.size} accounted for.`);
  }

  return { clusters, unassignedIndices };
}

module.exports = { runClustering, mechanicalName, topTermsForCluster, meanIntraClusterSimilarity, titleCase };
