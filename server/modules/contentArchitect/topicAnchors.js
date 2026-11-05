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
// (Jaccard >= 0.5). An item with no anchor (saved before this) stays on its
// stored cluster when it was saved after the analysis it would be shown on (for
// an analysis older than `generatedAt`, the run that produced it); otherwise
// its own text (topic, keywords; a spoke suggestion's source topic only)
// decides, and with no telling text it stays only when the times are unknown.
// Anything that cannot be placed is returned as work "from an earlier analysis"
// instead of being shown under a topic it was not made for.
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

// ── Evidence for items saved before anchors existed ─────────────────────────
//
// An unanchored item still says what it was about: a keyword set's topic, seed
// and picks, an article's topic and keyword, a spoke suggestion's source topic. Each
// current cluster is described by its name, its pages' titles and H1s, and
// their URL slugs. A term counts for more the fewer clusters share it, so a
// brand word in every title ("Position²") counts for nothing.

const STOP = new Set(('the and for with your you from that this what how why are was were can will into '
  + 'about vs versus our their its not but all any more most best top guide tips ways www com html htm '
  + 'http https blog page pages index').split(' '));

function stem(t) {
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function terms(...texts) {
  const out = new Set();
  for (const text of texts) {
    for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
      out.add(stem(raw));
    }
  }
  return out;
}

function slugOf(url) {
  try { return new URL(String(url)).pathname; } catch { return String(url || ''); }
}

/** What an unanchored saved item says it was about. */
function itemTerms(item) {
  const picks = (list) => (Array.isArray(list) ? list.map((k) => (typeof k === 'string' ? k : k?.keyword)) : []);
  return terms(
    item?.topic, item?.seed, item?.keyword, item?.title,
    ...picks(item?.primary), ...picks(item?.secondary),
  );
}

// Below this the best match is too weak to say anything: one term every other
// cluster also has.
const MIN_EVIDENCE = 1;
// The stored cluster agrees when it scores at least this share of the best.
const AGREE_SHARE = 0.75;

function evidenceIndex(analysis) {
  const pageById = new Map((analysis?.pages || []).map((p) => [p.id, p]));
  const profiles = (analysis?.clusters || []).map((c) => {
    const ps = [c.hubPageId, ...(c.spokeIds || [])].map((id) => pageById.get(id)).filter(Boolean);
    return {
      id: c.id,
      terms: terms(c.name, c.hubTitle, ...ps.flatMap((p) => [p.title, p.h1, slugOf(p.url)])),
    };
  });
  const df = new Map();
  for (const p of profiles) for (const t of p.terms) df.set(t, (df.get(t) || 0) + 1);
  const n = profiles.length;
  const weight = (t) => (df.has(t) ? Math.log((n + 1) / df.get(t)) : 0);
  /** 'agrees' | 'disagrees' | 'none' — whether the item's text backs its stored cluster. */
  return function verdict(item, storedId) {
    const words = [...itemTerms(item)];
    if (!words.length) return 'none';
    let best = 0;
    let stored = 0;
    for (const p of profiles) {
      let score = 0;
      for (const t of words) if (p.terms.has(t)) score += weight(t);
      if (score > best) best = score;
      if (p.id === storedId) stored = score;
    }
    if (best < MIN_EVIDENCE) return 'none';
    return stored > 0 && stored >= best * AGREE_SHARE ? 'agrees' : 'disagrees';
  };
}

/**
 * A resolver over one analysis: item → { clusterId, orphaned }.
 * `item` is { clusterId, anchor?, updatedAt?, generatedAt?, sameAnalysis?, ...text }.
 * `analysedAt` stands in for an analysis made before it carried `generatedAt`
 * (the run that produced it finished then).
 */
function resolverFor(analysis, { analysedAt: fallbackAt = null } = {}) {
  const urlById = pageUrlById(analysis);
  const clusters = (analysis?.clusters || []).map((c) => ({ id: c.id, members: clusterMembers(c, urlById) }));
  const ids = new Set(clusters.map((c) => c.id));
  const analysedAt = Date.parse(analysis?.generatedAt || fallbackAt || '');
  let verdictOf = null;

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
    // No anchor: saved before anchors existed, so its id is positional and
    // may now name another topic.
    //  - Saved after this analysis was produced: it was made against this
    //    clustering, so its stored cluster is right whatever its words say.
    //  - Saved before it, or when either time is unknown: its own text decides
    //    when it says something (backs the stored cluster, or points elsewhere).
    //  - No telling text: saved before -> earlier work; time unknown -> kept
    //    where it was stored (nothing says it moved).
    if (!ids.has(stored)) return { clusterId: stored, orphaned: true };
    if (item?.sameAnalysis) return { clusterId: stored, orphaned: false };
    const savedAt = Date.parse(item?.updatedAt || item?.generatedAt || '');
    const timesKnown = Number.isFinite(analysedAt) && Number.isFinite(savedAt);
    if (timesKnown && savedAt >= analysedAt) return { clusterId: stored, orphaned: false };
    if (!verdictOf) verdictOf = evidenceIndex(analysis);
    const verdict = verdictOf(item, stored);
    if (verdict !== 'none') return { clusterId: stored, orphaned: verdict !== 'agrees' };
    return { clusterId: stored, orphaned: timesKnown };
  };
}

/** The page URL → current cluster id, for work saved against a page. */
function clusterByPage(analysis) {
  const urlById = pageUrlById(analysis);
  const out = new Map();
  for (const c of analysis?.clusters || []) {
    for (const key of clusterMembers(c, urlById)) if (!out.has(key)) out.set(key, c.id);
  }
  return out;
}

const orphanId = (clusterId) => `${EARLIER_PREFIX}${clusterId ?? 'unknown'}`;

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * The /work response placed on the current analysis. Keyword research moves by
 * its anchor; an article follows the keyword research of its topic when there
 * is one, else its own origin anchor or the timestamp rule.
 */
function remapWork(work, analysis, opts = {}) {
  if (!work || !analysis) return work;
  const resolve = resolverFor(analysis, opts);
  const krPlace = new Map();
  const keywordResearch = (work.keywordResearch || []).map((kr) => {
    const placed = resolve(kr);
    krPlace.set(`${kr.clusterId}\u0000${norm(kr.topic)}`, placed);
    return place(kr, placed);
  });
  const articles = (work.articles || []).map((a) => {
    const viaTopic = krPlace.get(`${a.clusterId}\u0000${norm(a.topic)}`);
    return place(a, viaTopic || resolve({
      clusterId: a.clusterId, anchor: a.origin?.anchor, updatedAt: a.updatedAt,
      topic: a.topic, keyword: a.keyword, title: a.title,
    }));
  });
  // An enhancement is saved against a page, so it belongs to whichever cluster
  // holds that page now (the report already shows it by URL).
  const byPage = clusterByPage(analysis);
  const enhancements = (work.enhancements || []).map((e) => {
    const now = byPage.get(urlKey(e.url));
    return now && now !== e.clusterId ? { ...e, clusterId: now, formerClusterId: e.clusterId } : e;
  });
  return { ...work, keywordResearch, articles, enhancements };
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
function remapSuggestions(stored, analysis, opts = {}) {
  const byCluster = {};
  const earlier = [];
  if (!stored || !analysis) return { byCluster: stored || {}, earlier };
  const resolve = resolverFor(analysis, opts);
  const own = analysis.spokeSuggestionsByCluster || {};
  for (const [clusterId, payload] of Object.entries(stored)) {
    // The analysis keeps its own copy of every suggestion made on it (a re-run
    // starts without any), so one at least as new as that copy was made here.
    const ownAt = own[clusterId]?.generatedAt;
    const sameAnalysis = Boolean(ownAt) && String(payload?.generatedAt || '') >= String(ownAt);
    // Only the SOURCE topic speaks for where it belongs. The suggested spokes'
    // titles describe new pages, which may well read like a sibling topic.
    const placed = resolve({
      clusterId, anchor: payload?.anchor, generatedAt: payload?.generatedAt,
      topic: payload?.topic || payload?.hubTitle || payload?.clusterName || payload?.anchor?.name || null,
      sameAnalysis,
    });
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
function storedIdsFor(clusterId, summaries, analysis, opts = {}) {
  if (!analysis) return [clusterId];
  const resolve = resolverFor(analysis, opts);
  const out = new Set();
  for (const s of summaries || []) {
    const placed = resolve(s);
    if (!placed.orphaned && placed.clusterId === clusterId) out.add(s.clusterId);
  }
  return [...out];
}

module.exports = {
  MIN_OVERLAP, EARLIER_PREFIX, urlKey, clusterMembers, anchorFor, jaccard, resolverFor, itemTerms,
  remapWork, remapSuggestions, storedIdsFor,
};
