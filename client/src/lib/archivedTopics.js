// ── Archived Hub and Spoke topics, on the client ────────────────────────────
//
// The server leaves archived topics out of the analysis it sends
// (server/modules/contentArchitect/archivedClusters.js) and lists them under
// `analysis.archivedClusters`. These are the optimistic versions of the two
// changes, so the report moves the moment Archive or Restore is pressed; the
// page reloads the analysis once the server answers, and puts the previous one
// back if it refuses.

export const ARCHIVE_CONFIRM_TEXT = 'This topic will be excluded from the Hub & Spoke score and lists for this client, '
  + 'including future analyses.';

export const ARCHIVE_DENIED_TOOLTIP = 'Only approvers, admins and owners (or whoever created this client) can archive topics.';

/** The analysis with one cluster, and its pages, moved to the archived list. */
export function withClusterArchived(analysis, cluster) {
  if (!analysis || !cluster) return analysis;
  const ids = new Set([cluster.hubPageId, ...(cluster.spokeIds || [])].filter(Boolean));
  const pages = analysis.pages || [];
  const urls = pages.filter((p) => ids.has(p.id)).map((p) => p.url);
  return {
    ...analysis,
    clusters: (analysis.clusters || []).filter((c) => c.id !== cluster.id),
    pages: pages.filter((p) => !ids.has(p.id) && p.clusterId !== cluster.id),
    archivedClusters: [
      ...(analysis.archivedClusters || []),
      {
        key: `pending:${cluster.id}`,
        name: cluster.name || null,
        clusterId: cluster.id,
        inAnalysis: true,
        health: Number.isFinite(cluster.health) ? cluster.health : null,
        isGap: Boolean(cluster.isGap),
        spokeCount: (cluster.spokeIds || []).length,
        pageUrls: urls,
        pending: true,
      },
    ],
  };
}

/** The analysis with one archived topic taken off the archived list. */
export function withTopicRestored(analysis, key) {
  if (!analysis) return analysis;
  return { ...analysis, archivedClusters: (analysis.archivedClusters || []).filter((a) => a.key !== key) };
}

/** How many archived topics are in this analysis (and so left out of its score). */
export function archivedInAnalysis(analysis) {
  return (analysis?.archivedClusters || []).filter((a) => a.inAnalysis).length;
}

/** "2 topics archived — excluded from this score", or null with none. */
export function archivedScoreNote(analysis) {
  const n = archivedInAnalysis(analysis);
  return n ? `${n} topic${n === 1 ? '' : 's'} archived — excluded from this score` : null;
}

/** Cluster ids and page URLs saved work may belong to, archived topics included. */
export function archivedWorkKeys(analysis) {
  const archived = analysis?.archivedClusters || [];
  return {
    clusterIds: archived.map((a) => a.clusterId).filter(Boolean),
    pageUrls: archived.flatMap((a) => a.pageUrls || []),
  };
}
