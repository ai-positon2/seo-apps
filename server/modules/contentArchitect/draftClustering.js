// ── Stage 3: slug-only draft clustering ──────────────────────────────────────
// Runs the instant the user confirms patterns. No network calls — term
// profiles come from slug tokens only, every other field is simply absent on
// these page stubs. Same clustering engine as Stage 5 (see clusterEngine.js's
// header): one engine, two input qualities, never a second implementation.
const { buildCorpusTermProfiles } = require('./termProfile');
const { buildSimilarityMatrix } = require('./similarity');
const { runClustering } = require('./clusterEngine');

async function buildDraftClusters(urls, { domain, vertical }) {
  const pages = urls.map((url) => ({ url }));
  const profiles = buildCorpusTermProfiles(pages, { domain, vertical });
  const matrix = buildSimilarityMatrix(profiles);
  const { clusters, unassignedIndices } = await runClustering(profiles, matrix, { draft: true });

  return {
    clusters: clusters.map((c) => ({
      name: c.name,
      draft: true,
      urls: c.memberIndices.map((i) => urls[i]),
      dualClusterUrls: [...c.dualClusterFlags].map((i) => urls[i]),
      meanSimilarity: c.meanSimilarity,
    })),
    unassigned: unassignedIndices.map((i) => urls[i]),
  };
}

module.exports = { buildDraftClusters };
