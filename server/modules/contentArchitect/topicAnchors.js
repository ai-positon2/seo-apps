// ── Saved work stays with the topic it was made for ─────────────────────────
//
// Cluster ids are positional (clusterEngine.js: `cluster_${n}`), and a re-run
// reuses the same Content Architect project. Every saved artefact — spoke
// suggestions, keyword research, article origins — was keyed by that id alone,
// so after a re-run cluster_23's suggestions rendered under whatever topic was
// now 23rd (UX-159).
//
// The fix, without a schema change: each saved item carries an `anchor` in its
// JSON payload — the member page URLs of the cluster it was made for — and on
// read it is placed on the current cluster whose members overlap those most
// (Jaccard >= 0.5). An item with no anchor (saved before this) is trusted only
// if it is newer than the analysis it would be shown on; otherwise its cluster
// cannot be verified. Anything that cannot be placed is returned as work "from
// an earlier analysis" instead of being shown under a topic it was not made for.
//
// Pure; tested in __tests__/topicAnchors.test.js.

const MIN_OVERLAP = 0.5;

// Orphaned items keep a clusterId no current cluster has, so every client
// lookup by cluster id misses them and only the "earlier analysis" list finds them.
const EARLIER_PREFIX = 'earlier:';

/** Page URLs compared without scheme, www., trailing slash, or host case. */
function urlKey(url) {
  const raw = String(url || '').trim();
  try {
    const u = new URL(raw);
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

function pageUrlById(analysis) {
  return new Map((analysis?.pages || []).map((p) => [p.id, p.url]));
}

/** Sorted member URL keys (hub + spokes) of one cluster. */
function clusterMembers(cluster, urlById) {
  const ids = [cluster?.hubPageId, ...(cluster?.spokeIds || [])].filter(Boolean);
  const keys = ids.map((id) => urlById.get(id)).filter(Boolean).map(urlKey);
  return [...new Set(keys)].sort();
}

/** What a saved item records about the topic it was made for. */
function anchorFor(analysis, clusterId) {
  const cluster = (analysis?.clusters || []).find((c) => c.id === clusterId);
  if (!cluster) return null;
  return {
    clusterId,
    name: cluster.name || null,
    members: clusterMembers(cluster, pageUrlById(analysis)),
    analysisAt: analysis.generatedAt || null,
  };
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter((x) => setB.has(x)).length;
  return shared / (a.length + b.length - shared);
}

/**
 * A resolver over one analysis: item → { clusterId, orphaned }.
 * `item` is { clusterId, anchor?, updatedAt? }.
 */
function resolverFor(analysis) {
  const urlById = pageUrlById(analysis);
  const clusters = (analysis?.clusters || []).map((c) => ({ id: c.id, members: clusterMembers(c, urlById) }));
  const ids = new Set(clusters.map((c) => c.id));
  const analysedAt = Date.parse(analysis?.generatedAt || '');

  return function resolve(item) {
    const stored = item?.clusterId ?? null;
    const members = Array.isArray(item?.anchor?.members) ? item.anchor.members : null;
    if (members && members.length) {
      let best = null;
      let bestScore = 0;
      for (const c of clusters) {
        const score = jaccard(members, c.members);
        if (score > bestScore) { best = c; bestScore = score; }
      }
      return best && bestScore >= MIN_OVERLAP
        ? { clusterId: best.id, orphaned: false }
        : { clusterId: stored, orphaned: true };
    }
    // No anchor: saved before anchors existed. Its id is right only if it was
    // made against this analysis, i.e. after it was generated.
    const savedAt = Date.parse(item?.updatedAt || item?.generatedAt || '');
    const predates = Number.isFinite(analysedAt) && (!Number.isFinite(savedAt) || savedAt < analysedAt);
    if (predates || !ids.has(stored)) return { clusterId: stored, orphaned: true };
    return { clusterId: stored, orphaned: false };
  };
}

const orphanId = (clusterId) => `${EARLIER_PREFIX}${clusterId ?? 'unknown'}`;

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * The /work response placed on the current analysis. Keyword research moves by
 * its anchor; an article follows the keyword research of its topic when there
 * is one, else its own origin anchor or the timestamp rule.
 */
function remapWork(work, analysis) {
  if (!work || !analysis) return work;
  const resolve = resolverFor(analysis);
  const krPlace = new Map();
  const keywordResearch = (work.keywordResearch || []).map((kr) => {
    const placed = resolve(kr);
    krPlace.set(`${kr.clusterId}\u0000${norm(kr.topic)}`, placed);
    return place(kr, placed);
  });
  const articles = (work.articles || []).map((a) => {
    const viaTopic = krPlace.get(`${a.clusterId}\u0000${norm(a.topic)}`);
    return place(a, viaTopic || resolve({ clusterId: a.clusterId, anchor: a.origin?.anchor, updatedAt: a.updatedAt }));
  });
  return { ...work, keywordResearch, articles };
}

function place(item, { clusterId, orphaned }) {
  if (!orphaned) return { ...item, clusterId };
  return { ...item, clusterId: orphanId(item.clusterId), formerClusterId: item.clusterId, orphaned: true };
}

/**
 * Stored spoke suggestions ({ [storedClusterId]: payload }) placed on the
 * current analysis: { byCluster, earlier }. Two landing on one cluster keep the
 * newer. `earlier` lists the ones with no topic here any more.
 */
function remapSuggestions(stored, analysis) {
  const byCluster = {};
  const earlier = [];
  if (!stored || !analysis) return { byCluster: stored || {}, earlier };
  const resolve = resolverFor(analysis);
  for (const [clusterId, payload] of Object.entries(stored)) {
    const placed = resolve({ clusterId, anchor: payload?.anchor, generatedAt: payload?.generatedAt });
    if (placed.orphaned) {
      earlier.push({ formerClusterId: clusterId, topic: payload?.anchor?.name || null, ...payload });
      continue;
    }
    const existing = byCluster[placed.clusterId];
    if (!existing || String(payload?.generatedAt || '') > String(existing.generatedAt || '')) {
      byCluster[placed.clusterId] = payload;
    }
  }
  earlier.sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
  return { byCluster, earlier };
}

/**
 * The stored cluster ids whose saved keyword research now belongs to
 * `clusterId`, for the per-cluster read and for updating picks.
 */
function storedIdsFor(clusterId, summaries, analysis) {
  if (!analysis) return [clusterId];
  const resolve = resolverFor(analysis);
  const out = new Set();
  for (const s of summaries || []) {
    const placed = resolve(s);
    if (!placed.orphaned && placed.clusterId === clusterId) out.add(s.clusterId);
  }
  return [...out];
}

module.exports = {
  MIN_OVERLAP, EARLIER_PREFIX, urlKey, clusterMembers, anchorFor, jaccard, resolverFor,
  remapWork, remapSuggestions, storedIdsFor,
};
