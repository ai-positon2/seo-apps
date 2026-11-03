// ── One page per article, not one per locale ────────────────────────────────
//
// Translated and regional copies of one article (/en-au/…, /en-gb/…, /en-in/…)
// read as near-identical pages, so they clustered tightly and scored as
// healthy topics: 63 of Thoughtworks' 70 clusters were copies of a single
// article ("AI Value From POC to Impact", seven copies, similarity 1.00), and
// its Hub & Spoke score — the highest of any client — rested on them.
//
// Before clustering, pages that are copies of each other are collapsed to one:
//   • the same path once a locale segment is removed (/en-au/insights/x and
//     /insights/x) — the titles of such copies differ only in a suffix like
//     "| Thoughtworks Australia", so a title match alone missed them;
//   • the same title on locale paths (first path segment like "en-au", "de"), or
//   • the same title and nearly the same length anywhere.
// The copy kept is the one without a locale segment, else the shortest path.

const LOCALE_SEGMENT = /^\/([a-z]{2}(?:[-_][a-z]{2,4})?)(?=\/|$)/i;
const SAME_LENGTH = 0.15;

const normTitle = (title) => String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();

function pathOf(url) {
  try { return new URL(url).pathname; } catch { return String(url || ''); }
}

function hasLocale(url) {
  return LOCALE_SEGMENT.test(pathOf(url));
}

/** The path with any leading locale segment removed, without a trailing slash. */
function pathWithoutLocale(url) {
  return pathOf(url).replace(LOCALE_SEGMENT, '').replace(/\/+$/, '') || '/';
}

function sameLength(a, b) {
  const x = Number(a?.wordCount) || 0;
  const y = Number(b?.wordCount) || 0;
  if (!x || !y) return x === y;
  return Math.abs(x - y) / Math.max(x, y) <= SAME_LENGTH;
}

function isCopy(a, b) {
  if (hasLocale(a.url) || hasLocale(b.url)) return true;
  return sameLength(a, b);
}

/** The copy to keep: no locale segment, then the shortest path, then the first. */
function better(a, b) {
  const la = hasLocale(a.url);
  const lb = hasLocale(b.url);
  if (la !== lb) return la ? b : a;
  return pathOf(b.url).length < pathOf(a.url).length ? b : a;
}

/**
 * @param {Array<{url, title, wordCount}>} pages
 * @returns {{ keep: number[], collapsed: Array<{url, keptUrl}> }}
 *   indices of the pages to analyse, and every copy left out with its keeper
 */
function collapseCopies(pages) {
  const drop = new Map(); // index -> kept index

  // 1. Locale alternates: one path, several locale prefixes.
  const byPath = new Map();
  pages.forEach((page, index) => {
    if (!page?.url) return;
    const key = pathWithoutLocale(page.url);
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(index);
  });
  for (const indices of byPath.values()) {
    if (indices.length < 2 || !indices.some((i) => hasLocale(pages[i].url))) continue;
    const keeper = indices.reduce((k, i) => (better(pages[k], pages[i]) === pages[i] ? i : k));
    for (const i of indices) if (i !== keeper) drop.set(i, keeper);
  }

  // 2. The same title elsewhere.
  const groups = new Map();
  pages.forEach((page, index) => {
    if (drop.has(index)) return;
    const key = normTitle(page?.title);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });

  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    // Pick a keeper among the copies, then drop each copy of it.
    const pool = [...indices];
    while (pool.length > 1) {
      const keeper = pool.reduce((k, i) => (better(pages[k], pages[i]) === pages[i] ? i : k));
      const rest = pool.filter((i) => i !== keeper);
      const copies = rest.filter((i) => isCopy(pages[keeper], pages[i]));
      for (const i of copies) drop.set(i, keeper);
      // Same title but genuinely different pages stay, and are compared among themselves.
      const remaining = rest.filter((i) => !drop.has(i));
      if (remaining.length === rest.length) break;
      pool.length = 0;
      pool.push(...remaining);
    }
  }

  const keep = pages.map((_, i) => i).filter((i) => !drop.has(i));
  const collapsed = [...drop.entries()].map(([i, k]) => ({ url: pages[i].url, keptUrl: pages[k].url }));
  return { keep, collapsed };
}

/**
 * The link graph re-indexed to the kept pages. A link to a dropped copy counts
 * as a link to the copy that was kept.
 */
function reindexLinkGraph(linkGraph, pages, keep, collapsed) {
  if (!linkGraph) return null;
  const newIndex = new Map(keep.map((oldI, newI) => [oldI, newI]));
  const urlToOld = new Map(pages.map((p, i) => [p.url, i]));
  for (const { url, keptUrl } of collapsed) newIndex.set(urlToOld.get(url), newIndex.get(urlToOld.get(keptUrl)));

  const graph = keep.map(() => new Set());
  linkGraph.graph.forEach((targets, oldI) => {
    const from = newIndex.get(oldI);
    if (from === undefined) return;
    for (const oldJ of targets) {
      const to = newIndex.get(oldJ);
      if (to !== undefined && to !== from) graph[from].add(to);
    }
  });
  const inboundCounts = keep.map(() => 0);
  graph.forEach((targets) => { for (const j of targets) inboundCounts[j] += 1; });
  const depths = keep.map((oldI) => linkGraph.depths?.[oldI] ?? Infinity);
  return { ...linkGraph, graph, inboundCounts, depths };
}

module.exports = { collapseCopies, reindexLinkGraph, hasLocale };
