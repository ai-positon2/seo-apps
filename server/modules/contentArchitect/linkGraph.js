// ── Stage 4/7 support: link graph + click depth ──────────────────────────────
// The link graph is built ONLY from the confirmed/crawled page set's mutual
// links — Stage 4 only crawls that set, not the whole site. That set almost
// never includes the homepage itself (it's classified 'static', excluded by
// default), so click depth needs a seed: the homepage is fetched separately
// (one extra request, not part of the analyzed set) purely to find its
// outbound links INTO the confirmed set, giving BFS a real starting point.
const cheerio = require('cheerio');
const { fetchSafe } = require('./urlSafety');
const { normalizeUrl } = require('./urlNormalizer');
const { CRAWL_REQUEST_TIMEOUT_MS } = require('./config');

async function fetchHomepageLinks(origin, host) {
  try {
    const res = await fetchSafe(origin, { timeout: CRAWL_REQUEST_TIMEOUT_MS });
    const $ = cheerio.load(res.data);
    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#')) return;
      const abs = normalizeUrl(href, res.finalUrl);
      if (!abs) return;
      try { if (new URL(abs).hostname !== host) return; } catch { return; }
      links.push(abs);
    });
    return links;
  } catch {
    return []; // homepage unreachable — depths simply can't be computed, not fatal
  }
}

// pages: Page[] (already crawled, with .url and .outboundLinks[]). Returns
// { inboundCounts: number[], depths: number[] } aligned to `pages`' index
// order. depths[i] is Infinity when unreachable from the homepage.
async function buildLinkGraphAndDepths(pages, origin) {
  const host = new URL(origin).hostname;
  const urlToIndex = new Map(pages.map((p, i) => [p.url, i]));
  const n = pages.length;

  const graph = new Array(n).fill(null).map(() => new Set());
  const inboundCounts = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (const link of pages[i].outboundLinks || []) {
      const targetIdx = urlToIndex.get(normalizeUrl(link.href));
      if (targetIdx !== undefined && targetIdx !== i) graph[i].add(targetIdx);
    }
  }
  for (let i = 0; i < n; i++) for (const j of graph[i]) inboundCounts[j]++;

  const homepageLinks = await fetchHomepageLinks(origin, host);
  const depths = new Array(n).fill(Infinity);
  const queue = [];
  for (const link of homepageLinks) {
    const idx = urlToIndex.get(normalizeUrl(link));
    if (idx !== undefined && depths[idx] > 1) { depths[idx] = 1; queue.push(idx); }
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const next of graph[cur]) {
      if (depths[next] > depths[cur] + 1) {
        depths[next] = depths[cur] + 1;
        queue.push(next);
      }
    }
  }

  return { graph, inboundCounts, depths, homepageReachable: homepageLinks.length > 0 };
}

module.exports = { buildLinkGraphAndDepths, fetchHomepageLinks };
