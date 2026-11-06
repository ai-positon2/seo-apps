// ── Topics a client does not want to target ─────────────────────────────────
//
// A brand may decide a topic cluster is not one it wants to rank for (a
// service it no longer offers, a subject it will not write about). Archiving
// it takes the cluster out of everything Hub and Spoke says about the site:
// the mean cluster health, the cluster and gap counts, the findings about its
// pages, the lists, the exports. An archived cluster behaves as if it did not
// exist.
//
// The choice is stored per platform project, in crawl_projects.settings
// (`archivedClusters`, see projects/store.js), and applied on READ: the stored
// analysis and module run keep their figures, and each reader filters them
// here. So an archive takes effect immediately, a restore puts everything
// back, and a project with nothing archived reads exactly what it read before
// (excludeArchived returns the analysis object itself).
//
// Cluster ids are positional (clusterEngine.js: `cluster_${n}`) and change
// between analyses, so an archive names its topic by an anchor instead — the
// member page URLs, the hub URL and the name — and is matched to the current
// clusters the way saved work is (topicAnchors.js): member overlap (Jaccard)
// >= 0.5 first, then the same hub page, then the same name. One archive
// claims at most one cluster, and one cluster is claimed at most once.
//
// Pure; tested in __tests__/archivedClusters.test.js.

const crypto = require('crypto');
const { MIN_OVERLAP, urlKey, clusterMembers, jaccard } = require('./topicAnchors');

const norm = (s) => String(s || '').trim().toLowerCase();

function pageUrlById(analysis) {
  return new Map((analysis?.pages || []).map((p) => [p.id, p.url]));
}

function hubUrlOf(cluster, urlById) {
  const url = (cluster?.hubPageId && urlById.get(cluster.hubPageId)) || cluster?.referenceIndexUrl || null;
  return url || null;
}

/** What an archive records about the cluster it was made for, or null. */
function anchorFor(analysis, clusterId) {
  const cluster = (analysis?.clusters || []).find((c) => c.id === clusterId);
  if (!cluster) return null;
  const urlById = pageUrlById(analysis);
  const hub = hubUrlOf(cluster, urlById);
  return {
    memberUrls: clusterMembers(cluster, urlById),
    hubUrl: hub ? urlKey(hub) : null,
    name: cluster.name || null,
  };
}

/** A short stable id for one archive, used to restore it. */
function keyFor(anchor) {
  const basis = JSON.stringify([anchor?.memberUrls || [], anchor?.hubUrl || null, norm(anchor?.name)]);
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

/** Stored entries that carry an anchor; anything else is ignored. */
function validEntries(raw) {
  return (Array.isArray(raw) ? raw : []).filter((e) => e && typeof e === 'object' && e.anchor
    && (Array.isArray(e.anchor.memberUrls) || e.anchor.hubUrl || e.anchor.name));
}

/**
 * Which current cluster each archive names: { byCluster: Map(clusterId ->
 * entry), clusterOf: Map(entry -> clusterId) }. Overlap first (best pairs
 * first, across all entries), then hub page, then name.
 */
function matchArchived(analysis, rawEntries) {
  const entries = validEntries(rawEntries);
  const urlById = pageUrlById(analysis);
  const clusters = (analysis?.clusters || []).map((c) => {
    const hub = hubUrlOf(c, urlById);
    return { id: c.id, members: clusterMembers(c, urlById), hubUrl: hub ? urlKey(hub) : null, name: norm(c.name) };
  });
  const byCluster = new Map();
  const clusterOf = new Map();
  const claim = (entry, clusterId) => { byCluster.set(clusterId, entry); clusterOf.set(entry, clusterId); };

  const pairs = [];
  entries.forEach((entry, ei) => {
    const members = Array.isArray(entry.anchor.memberUrls) ? entry.anchor.memberUrls : [];
    if (!members.length) return;
    for (const c of clusters) {
      const score = jaccard(members, c.members);
      if (score >= MIN_OVERLAP) pairs.push({ entry, ei, clusterId: c.id, score });
    }
  });
  pairs.sort((a, b) => b.score - a.score || a.ei - b.ei);
  for (const p of pairs) {
    if (!clusterOf.has(p.entry) && !byCluster.has(p.clusterId)) claim(p.entry, p.clusterId);
  }

  for (const field of ['hubUrl', 'name']) {
    for (const entry of entries) {
      if (clusterOf.has(entry)) continue;
      // hubUrl is stored already keyed (anchorFor), so it is compared as is.
      const want = field === 'name' ? norm(entry.anchor.name) : entry.anchor.hubUrl || null;
      if (!want) continue;
      const c = clusters.find((x) => !byCluster.has(x.id) && x[field] === want);
      if (c) claim(entry, c.id);
    }
  }
  return { entries, byCluster, clusterOf };
}

/** The rounded mean of the clusters' health — the module's one formula. */
function meanHealth(clusters) {
  const list = clusters || [];
  return list.length ? Math.round(list.reduce((s, c) => s + (c.health || 0), 0) / list.length) : null;
}

/**
 * The analysis with the archived clusters, and the pages in them, left out.
 *
 * Returns { analysis, archived }. `archived` lists every archive, matched or
 * not (one whose topic is not in this analysis still applies to the next), for
 * the "Archived topics" list and its Restore. With nothing archived the
 * analysis returned is the one passed in, untouched.
 */
function excludeArchived(analysis, rawEntries) {
  const { entries, byCluster, clusterOf } = matchArchived(analysis, rawEntries);
  if (!analysis || !entries.length) return { analysis, archived: [] };

  const urlById = pageUrlById(analysis);
  const clusterById = new Map((analysis.clusters || []).map((c) => [c.id, c]));
  const archived = entries.map((entry) => {
    const clusterId = clusterOf.get(entry) || null;
    const c = clusterId ? clusterById.get(clusterId) : null;
    const ids = c ? [c.hubPageId, ...(c.spokeIds || [])].filter(Boolean) : [];
    return {
      key: entry.key || keyFor(entry.anchor),
      name: c?.name || entry.anchor.name || null,
      clusterId,
      inAnalysis: Boolean(c),
      health: c && Number.isFinite(c.health) ? c.health : null,
      isGap: c ? Boolean(c.isGap) : null,
      hubUrl: c ? hubUrlOf(c, urlById) : entry.anchor.hubUrl || null,
      spokeCount: c ? (c.spokeIds || []).length : null,
      pageUrls: ids.map((id) => urlById.get(id)).filter(Boolean),
      archivedBy: entry.archivedBy || null,
      archivedAt: entry.archivedAt || null,
      reason: entry.reason || null,
    };
  });
  if (!byCluster.size) return { analysis: { ...analysis, archivedClusters: archived }, archived };

  const archivedPageIds = new Set();
  for (const id of byCluster.keys()) {
    const c = clusterById.get(id);
    for (const pid of [c?.hubPageId, ...(c?.spokeIds || [])]) if (pid) archivedPageIds.add(pid);
  }
  for (const p of analysis.pages || []) if (byCluster.has(p.clusterId)) archivedPageIds.add(p.id);

  const filtered = {
    ...analysis,
    clusters: (analysis.clusters || []).filter((c) => !byCluster.has(c.id)),
    pages: (analysis.pages || []).filter((p) => !archivedPageIds.has(p.id)),
    cannibalization: (analysis.cannibalization || []).filter((g) => !byCluster.has(g.clusterId)),
    archivedClusters: archived,
  };
  return { analysis: filtered, archived };
}

/** "3 topics archived" — the phrase every surface uses. */
function archivedPhrase(n) {
  return `${n} topic${n === 1 ? '' : 's'} archived`;
}

module.exports = {
  anchorFor, keyFor, validEntries, matchArchived, excludeArchived, meanHealth, archivedPhrase,
};
