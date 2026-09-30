// ── Stage 1: sitemap discovery ───────────────────────────────────────────────
// Finds and fully resolves a domain's declared sitemap(s) into a flat URL
// list. Falls back to a shallow link-following crawl when no sitemap exists
// at all. See the build spec for the exact parsing requirements this
// implements — gzip, sitemap indexes, namespace variation, HTML-at-sitemap-
// url detection, image/video/news sitemap skipping, hreflang dedup.
const zlib = require('zlib');
const { XMLParser } = require('fast-xml-parser');
const { fetchSafe } = require('./urlSafety');
const { normalizeUrl, dedupeUrls } = require('./urlNormalizer');
const {
  MAX_SITEMAP_URLS, MAX_SITEMAP_RECURSION_DEPTH, MAX_CHILD_SITEMAPS, MAX_SITEMAP_SOURCES, MIN_CHILD_SITEMAPS_PER_SOURCE,
  CRAWL_FALLBACK_DEPTH, CRAWL_FALLBACK_MAX_URLS,
} = require('./config');

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const FALLBACK_SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/sitemap.xml.gz'];

// Filename signal that this sitemap is a DEDICATED media sitemap (images/
// video/news), not a page sitemap — Google's own convention is a separate
// file per media type (e.g. techcrunch.com's own "news-sitemap.xml" next to
// its regular "sitemap.xml"). Deliberately NOT namespace-based: declaring
// the image/video namespace on a urlset is extremely common on completely
// normal PAGE sitemaps that just attach an optional <image:image> tag to
// each <url> entry — treating that declaration alone as "this is an image
// sitemap" produces false positives that skip real page content entirely
// (confirmed against techcrunch.com's actual sitemap-page-*.xml files).
const MEDIA_SITEMAP_FILENAME_RE = /(^|[/_-])(image|images|video|videos|news)([/_-]|-sitemap|sitemap|\.xml)/i;

async function extractSitemapUrlsFromRobots(origin) {
  try {
    const res = await fetchSafe(`${origin}/robots.txt`);
    const matches = String(res.data).match(/^\s*sitemap:\s*(.+)$/gim) || [];
    return matches.map((line) => line.replace(/^\s*sitemap:\s*/i, '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Detects gzip regardless of how (or whether) the server declares it: magic
// bytes are checked directly rather than trusting Content-Encoding or the
// .gz extension alone, since a literal .xml.gz file on disk is very often
// served with no Content-Encoding header at all.
function maybeGunzip(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return zlib.gunzipSync(buffer);
  }
  return buffer;
}

class HtmlAtSitemapUrlError extends Error {
  constructor(url) {
    super(`Expected a sitemap at ${url} but got an HTML page instead.`);
    this.name = 'HtmlAtSitemapUrlError';
  }
}

async function fetchAndParseXml(url) {
  const res = await fetchSafe(url, { responseType: 'arraybuffer' });
  const raw = maybeGunzip(Buffer.from(res.data)).toString('utf8');
  const trimmed = raw.trim();
  if (/^<!DOCTYPE html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    throw new HtmlAtSitemapUrlError(url);
  }
  let parsed;
  try {
    parsed = xmlParser.parse(raw);
  } catch (e) {
    throw new Error(`Not valid XML at ${url}: ${e.message}`);
  }
  if (!parsed || (!parsed.urlset && !parsed.sitemapindex)) {
    throw new HtmlAtSitemapUrlError(url);
  }
  return parsed;
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// Recursively resolves a sitemap (or sitemap index) into { url, lastmod }
// pairs. Depth-capped, URL-capped, child-sitemap-count-capped. A child
// sitemap that fails to fetch/parse is skipped rather than aborting the
// whole discovery — one broken child shouldn't sink an otherwise-good index.
async function resolveSitemap(entryUrl, depth, state) {
  if (state.capped) return;
  const maxChildren = state.maxChildSitemaps ?? MAX_CHILD_SITEMAPS;
  if (depth > MAX_SITEMAP_RECURSION_DEPTH) { state.capped = true; state.capReason = 'recursion depth'; return; }
  if (state.sitemapsFetched >= maxChildren) { state.capped = true; state.capReason = 'child sitemap count'; return; }
  if (state.urls.size >= MAX_SITEMAP_URLS) { state.capped = true; state.capReason = 'total URL count'; return; }

  let parsed;
  try {
    parsed = await fetchAndParseXml(entryUrl);
  } catch (err) {
    state.skippedSitemaps.push({ url: entryUrl, reason: err.message });
    return;
  }
  state.sitemapsFetched++;

  if (parsed.sitemapindex) {
    // Informational children first, so a child-count cap cuts the others.
    const children = asArray(parsed.sitemapindex.sitemap)
      .map((entry) => (typeof entry === 'string' ? entry : entry?.loc))
      .filter(Boolean);
    for (const loc of prioritizeSitemaps(children)) {
      if (state.urls.size >= MAX_SITEMAP_URLS || state.sitemapsFetched >= maxChildren) { state.capped = true; state.capReason = state.capReason || 'child sitemap count'; break; }
      await resolveSitemap(loc, depth + 1, state);
    }
    return;
  }

  // urlset — a page sitemap, unless its filename marks it as a dedicated
  // image/video/news sitemap (see MEDIA_SITEMAP_FILENAME_RE's comment).
  if (MEDIA_SITEMAP_FILENAME_RE.test(entryUrl)) {
    state.skippedSitemaps.push({ url: entryUrl, reason: 'media sitemap (image/video/news) — not page content' });
    return;
  }

  for (const entry of asArray(parsed.urlset?.url)) {
    if (state.urls.size >= MAX_SITEMAP_URLS) { state.capped = true; state.capReason = 'total URL count'; break; }
    const loc = typeof entry === 'string' ? entry : entry?.loc;
    if (!loc) continue;
    const normalized = normalizeUrl(loc);
    if (!normalized) continue;
    // xhtml:link hreflang alternates are intentionally never read here — only
    // this entry's own <loc> counts. The alternates are a different language
    // version of the SAME page group and are dropped, not added separately.
    const lastmod = typeof entry === 'object' ? entry.lastmod : undefined;
    if (!state.urls.has(normalized)) state.urls.set(normalized, { url: normalized, lastmod: lastmod || null });
  }
}

// ── Shallow crawl fallback (no sitemap found) ────────────────────────────────
// A lightweight BFS over <a href> links from the homepage. This is NOT the
// full Stage 4 crawler (no content extraction) — its only job is discovering
// a URL list when there's no sitemap to read one from.
function parseDisallowRules(robotsTxt) {
  const lines = String(robotsTxt || '').split('\n').map((l) => l.trim());
  const disallow = [];
  let inWildcardGroup = false;
  for (const line of lines) {
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) { inWildcardGroup = ua[1].trim() === '*'; continue; }
    const dis = line.match(/^disallow:\s*(.*)$/i);
    if (dis && inWildcardGroup && dis[1].trim()) disallow.push(dis[1].trim());
  }
  return disallow;
}

function isDisallowed(pathname, disallowRules) {
  return disallowRules.some((rule) => pathname.startsWith(rule));
}

async function crawlFallback(origin) {
  const disallowRules = await fetchSafe(`${origin}/robots.txt`).then((r) => parseDisallowRules(r.data)).catch(() => []);
  const host = new URL(origin).hostname;
  const visited = new Set();
  const results = new Map();
  let queue = [{ url: origin, depth: 0 }];

  while (queue.length && results.size < CRAWL_FALLBACK_MAX_URLS) {
    const { url, depth } = queue.shift();
    const normalized = normalizeUrl(url);
    if (!normalized || visited.has(normalized) || depth > CRAWL_FALLBACK_DEPTH) continue;
    visited.add(normalized);
    if (isDisallowed(new URL(normalized).pathname, disallowRules)) continue;

    let html;
    try {
      const res = await fetchSafe(normalized, { timeout: 6000 });
      html = String(res.data);
    } catch {
      continue;
    }
    results.set(normalized, { url: normalized, lastmod: null });
    if (depth === CRAWL_FALLBACK_DEPTH) continue;

    const hrefMatches = html.match(/href\s*=\s*["']([^"']+)["']/gi) || [];
    for (const m of hrefMatches) {
      const href = m.replace(/^href\s*=\s*["']/i, '').replace(/["']$/, '');
      const abs = normalizeUrl(href, normalized);
      if (!abs) continue;
      try {
        if (new URL(abs).hostname !== host) continue;
      } catch { continue; }
      if (!visited.has(abs)) queue.push({ url: abs, depth: depth + 1 });
    }
  }

  return dedupeUrls([...results.keys()]).map((u) => results.get(u));
}

// ── Entry point ──────────────────────────────────────────────────────────────
// Returns { source, sources, urls: [{url, lastmod}], capped, capReason, skippedSitemaps, mode }
// mode: 'sitemap' | 'not-found'
//
// EVERY sitemap robots.txt declares is read, not just the first. A site often
// declares one per section, and the first is rarely its articles: one SaaS site
// listed ten, the first holding 25,000 integration pages, which used the whole
// URL budget while its blog sitemap was never opened. Sitemaps whose address
// names informational content are read first, and the URL budget is shared
// across all of them (sharedBudget), so no single one can crowd out the rest.
//
// The usual paths (/sitemap.xml …) are alternatives to each other rather than
// separate sections, so they are only tried when robots.txt declares none that
// resolve, and the first to yield URLs is used, as before.
async function discoverUrls(origin) {
  const fromRobots = dedupeUrls(await extractSitemapUrlsFromRobots(origin)).slice(0, MAX_SITEMAP_SOURCES);
  const allSkipped = [];

  const resolved = [];
  const childBudget = Math.max(MIN_CHILD_SITEMAPS_PER_SOURCE, Math.floor(MAX_CHILD_SITEMAPS / Math.max(1, fromRobots.length)));
  for (const source of prioritizeSitemaps(fromRobots)) {
    const state = newState(childBudget);
    await resolveSitemap(source, 1, state);
    allSkipped.push(...state.skippedSitemaps);
    if (state.urls.size) resolved.push({ source, state });
  }

  if (!resolved.length) {
    const fallbacks = dedupeUrls(FALLBACK_SITEMAP_PATHS.map((p) => `${origin}${p}`)).filter((u) => !fromRobots.includes(u));
    for (const source of fallbacks) {
      const state = newState(MAX_CHILD_SITEMAPS);
      await resolveSitemap(source, 1, state);
      allSkipped.push(...state.skippedSitemaps);
      if (state.urls.size) { resolved.push({ source, state }); break; }
    }
  }

  // No sitemap resolved anything — caller decides whether to invoke
  // crawlFallback() (it's exposed separately so the UI can warn/confirm first
  // rather than this function silently taking minutes on a large site).
  if (!resolved.length) {
    return { mode: 'not-found', source: null, sources: [], urls: [], capped: false, capReason: null, skippedSitemaps: allSkipped };
  }

  // A URL listed by two sitemaps belongs to the first (highest-priority) one.
  const seen = new Set();
  const lists = resolved.map(({ state }) => [...state.urls.values()].filter((e) => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  }));
  const takes = sharedBudget(lists.map((l) => l.length), MAX_SITEMAP_URLS);
  const urls = [];
  let truncated = false;
  lists.forEach((list, i) => {
    if (takes[i] < list.length) truncated = true;
    urls.push(...newestFirst(list, takes[i]));
  });
  const capReasons = resolved.map(({ state }) => state.capReason).filter(Boolean);
  return {
    mode: 'sitemap',
    source: resolved[0].source,
    sources: resolved.map(({ source, state }, i) => ({ url: source, count: takes[i], capped: state.capped || takes[i] < lists[i].length })),
    urls,
    capped: truncated || capReasons.length > 0,
    capReason: truncated ? 'total URL count' : (capReasons[0] || null),
    skippedSitemaps: allSkipped,
  };
}

function newState(maxChildSitemaps) {
  return { urls: new Map(), sitemapsFetched: 0, maxChildSitemaps, capped: false, capReason: null, skippedSitemaps: [] };
}

// Sitemap addresses that name informational content ("/blog/sitemap.xml",
// "post-sitemap.xml", "wp-sitemap-posts-post-1.xml") come first, then the rest
// in the order the site gave them.
const INFORMATIONAL_SITEMAP_RE = /(blog|posts?|articles?|guides?|learn|resources?|help|faqs?|glossary|knowledge|insights?|academy|library|tips|how-?to)/i;
function prioritizeSitemaps(urls) {
  const pathOf = (u) => { try { return new URL(u).pathname; } catch { return String(u); } };
  return urls
    .map((url, i) => ({ url, i, informational: INFORMATIONAL_SITEMAP_RE.test(pathOf(url)) }))
    .sort((a, b) => (b.informational - a.informational) || (a.i - b.i))
    .map((x) => x.url);
}

/**
 * How many URLs each list may contribute to one shared cap: equal shares,
 * with whatever a short list leaves unused passed on to the longer ones.
 * @param {number[]} sizes  list lengths, in priority order
 * @returns {number[]} how many to take from each
 */
function sharedBudget(sizes, cap) {
  const take = sizes.map(() => 0);
  let remaining = cap;
  let open = sizes.map((_, i) => i).filter((i) => sizes[i] > 0);
  while (remaining > 0 && open.length) {
    const share = Math.max(1, Math.floor(remaining / open.length));
    const stillOpen = [];
    for (const i of open) {
      if (remaining <= 0) break;
      const add = Math.min(share, sizes[i] - take[i], remaining);
      take[i] += add;
      remaining -= add;
      if (take[i] < sizes[i]) stillOpen.push(i);
    }
    open = stillOpen;
  }
  return take;
}

// The `n` most recently modified entries, when a list has to be cut; entries
// without a lastmod keep their sitemap order after the dated ones.
function newestFirst(list, n) {
  if (n >= list.length) return list;
  const time = (e) => { const t = Date.parse(e.lastmod || ''); return Number.isFinite(t) ? t : -Infinity; };
  return list
    .map((e, i) => ({ e, i, t: time(e) }))
    .sort((a, b) => (b.t - a.t) || (a.i - b.i))
    .slice(0, n)
    .map((x) => x.e);
}

/**
 * The URLs of one sitemap (or sitemap index), or [] when there is none there.
 * Used to probe a section's own sitemap ("/blog/sitemap_index.xml"), which a
 * site does not always list in robots.txt or its root index.
 */
async function resolveSitemapUrls(url) {
  const state = newState(MAX_CHILD_SITEMAPS);
  await resolveSitemap(url, 1, state);
  return { urls: [...state.urls.values()], capped: state.capped, capReason: state.capReason };
}

module.exports = {
  discoverUrls, resolveSitemapUrls, crawlFallback, HtmlAtSitemapUrlError, sharedBudget, prioritizeSitemaps,
};
