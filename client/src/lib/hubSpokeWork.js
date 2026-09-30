// ── Work made from the Hub & Spoke report, indexed for the report ────────────
//
// GET /api/content-architect/projects/:id/work returns flat lists (keyword
// sets, articles, enhancements). The report asks three questions of them, all
// answered here so the rules are tested once (__tests__/hubSpokeWork.test.js):
//
//   what exists for this suggested topic   → its keyword set and its articles
//   what exists for this existing page     → its saved enhancement
//   how much has this cluster produced     → the tally on the collapsed row
//
// Pure and dependency-free.

const EMPTY = { keywordResearch: [], articles: [], enhancements: [] };

export function topicKey(clusterId, topic) {
  return `${clusterId}\u0000${String(topic || '').trim().toLowerCase()}`;
}

/** Page URLs compared without scheme, www., trailing slash, or case in the host. */
export function pageKey(url) {
  const raw = String(url || '').trim();
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '') || '';
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${path}${u.search}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * @param {object|null} work  the /work response
 * @returns {{ forTopic(clusterId, topic): { keywords, articles }, forPage(url): object|null, tally(cluster, pageById): object }}
 */
export function indexWork(work) {
  const w = work || EMPTY;
  const topics = new Map();
  const entry = (k) => {
    if (!topics.has(k)) topics.set(k, { keywords: null, articles: [] });
    return topics.get(k);
  };
  const entryFor = (clusterId, topic) => {
    const e = entry(topicKey(clusterId, topic));
    e.clusterId = clusterId;
    e.topic = e.topic || topic;
    return e;
  };
  for (const kr of w.keywordResearch || []) entryFor(kr.clusterId, kr.topic).keywords = kr;
  const articles = [...(w.articles || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  for (const a of articles) entryFor(a.clusterId, a.topic).articles.push(a);

  const pages = new Map();
  for (const e of w.enhancements || []) {
    const k = pageKey(e.url);
    if (!pages.has(k)) pages.set(k, e); // newest first from the server
  }

  const byCluster = new Map();
  for (const kr of w.keywordResearch || []) bump(byCluster, kr.clusterId, 'keywords');
  for (const a of articles) bump(byCluster, a.clusterId, a.stage === 'draft' ? 'drafts' : 'briefs');

  return {
    forTopic: (clusterId, topic) => topics.get(topicKey(clusterId, topic)) || { keywords: null, articles: [] },
    /**
     * This cluster's topics with work that the report is not currently
     * showing — a suggestion replaced by "Re-suggest", say — newest first.
     */
    earlierTopics(clusterId, shownTopics) {
      const shown = new Set((shownTopics || []).map((t) => topicKey(clusterId, t)));
      return [...topics.entries()]
        .filter(([k, e]) => e.clusterId === clusterId && !shown.has(k))
        .map(([, e]) => e)
        .sort((a, b) => latest(b).localeCompare(latest(a)));
    },
    /**
     * Work that no longer has a place on the report: topics of clusters this
     * analysis no longer has, and enhancements of pages it no longer lists.
     */
    orphans(clusterIds, pageUrls) {
      const ids = new Set(clusterIds);
      const urls = new Set([...(pageUrls || [])].map(pageKey));
      return {
        topics: [...topics.values()].filter((e) => !ids.has(e.clusterId)).sort((a, b) => latest(b).localeCompare(latest(a))),
        enhancements: [...pages.entries()].filter(([k]) => !urls.has(k)).map(([, e]) => e),
      };
    },
    forPage: (url) => (url ? pages.get(pageKey(url)) || null : null),
    // Enhancements count by the cluster's pages as they are NOW, so a page that
    // moved cluster on a re-run is counted where it sits.
    tally(cluster, pageById) {
      const t = { keywords: 0, briefs: 0, drafts: 0, enhanced: 0, ...(byCluster.get(cluster.id) || {}) };
      const urls = [cluster.hubPageId, ...(cluster.spokeIds || [])]
        .map((id) => pageById?.get(id)?.url).filter(Boolean);
      t.enhanced = urls.filter((u) => pages.has(pageKey(u))).length;
      t.total = t.keywords + t.briefs + t.drafts + t.enhanced;
      return t;
    },
  };
}

const latest = (e) => String(e.articles[0]?.updatedAt || e.keywords?.updatedAt || '');

function bump(map, clusterId, field) {
  const t = map.get(clusterId) || {};
  t[field] = (t[field] || 0) + 1;
  map.set(clusterId, t);
}

/**
 * The three stages a suggested topic moves through, for the progress rail.
 * `keywordsSaved` is the panel's own saved record, which can be newer than the
 * summary the page last loaded.
 */
export function topicStages({ keywords, articles }, keywordsSaved = null) {
  const lead = articles[0] || null;
  const kwDone = Boolean(keywords || keywordsSaved?.result);
  const { primary: p, secondary: s } = currentPicks(keywords, keywordsSaved);
  const primary = p.length;
  const secondary = s.length;
  return [
    { id: 'keywords', label: 'Keywords', done: kwDone, meta: kwDone ? `${primary} P · ${secondary} S` : 'Not researched' },
    { id: 'brief', label: 'Brief', done: Boolean(lead && lead.sections > 0), meta: lead?.sections ? `${lead.sections} sections` : lead ? 'Started' : 'Not started' },
    { id: 'draft', label: 'Draft', done: Boolean(lead && lead.words > 0), meta: lead?.words ? `${lead.words.toLocaleString('en-US')} words` : 'Not written' },
  ];
}

/**
 * A topic's current primary/secondary picks. The panel's own saved record
 * wins: it changes with every edit, while the summary is as of the last load.
 */
export function currentPicks(keywords, keywordsSaved = null) {
  const sel = keywordsSaved?.selection;
  const ai = keywordsSaved?.result?.result;
  if (keywordsSaved?.result) {
    return {
      primary: (Array.isArray(sel?.primary) ? sel.primary : ai?.primary) || [],
      secondary: (Array.isArray(sel?.secondary) ? sel.secondary : ai?.secondary) || [],
    };
  }
  return { primary: keywords?.primary || [], secondary: keywords?.secondary || [] };
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Content Writer URL that opens a saved article. */
export function articleHref(article) {
  return `/content-writer?${new URLSearchParams({ project: article.projectId, article: article.id })}`;
}
