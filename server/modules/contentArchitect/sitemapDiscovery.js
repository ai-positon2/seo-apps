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
const { MAX_SITEMAP_URLS, MAX_SITEMAP_RECURSION_DEPTH, MAX_CHILD_SITEMAPS, CRAWL_FALLBACK_DEPTH, CRAWL_FALLBACK_MAX_URLS } = require('./config');

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
  if (depth > MAX_SITEMAP_RECURSION_DEPTH) { state.capped = true; state.capReason = 'recursion depth'; return; }
  if (state.sitemapsFetched >= MAX_CHILD_SITEMAPS) { state.capped = true; state.capReason = 'child sitemap count'; return; }
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
    for (const entry of asArray(parsed.sitemapindex.sitemap)) {
      const loc = typeof entry === 'string' ? entry : entry?.loc;
      if (!loc) continue;
      if (state.urls.size >= MAX_SITEMAP_URLS || state.sitemapsFetched >= MAX_CHILD_SITEMAPS) { state.capped = true; state.capReason = state.capReason || 'child sitemap count'; break; }
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
// Returns { source, urls: [{url, lastmod}], capped, capReason, skippedSitemaps, mode }
// mode: 'sitemap' | 'crawl-fallback'
async function discoverUrls(origin) {
  const fromRobots = await extractSitemapUrlsFromRobots(origin);
  const candidates = dedupeUrls([...fromRobots, ...FALLBACK_SITEMAP_PATHS.map((p) => `${origin}${p}`)]);

  // Accumulated across every attempted candidate — even on total failure,
  // the caller (and the log) should be able to see WHY each one didn't pan
  // out, rather than that information being silently discarded per-attempt.
  const allSkipped = [];
  for (const candidate of candidates) {
    const state = { urls: new Map(), sitemapsFetched: 0, capped: false, capReason: null, skippedSitemaps: [] };
    await resolveSitemap(candidate, 1, state);
    allSkipped.push(...state.skippedSitemaps);
    if (state.urls.size > 0) {
      return {
        mode: 'sitemap',
        source: candidate,
        urls: [...state.urls.values()],
        capped: state.capped,
        capReason: state.capReason,
        skippedSitemaps: state.skippedSitemaps,
      };
    }
  }

  // No sitemap resolved anything — caller decides whether to invoke
  // crawlFallback() (it's exposed separately so the UI can warn/confirm first
  // rather than this function silently taking minutes on a large site).
  return { mode: 'not-found', source: null, urls: [], capped: false, capReason: null, skippedSitemaps: allSkipped };
}

module.exports = { discoverUrls, crawlFallback, HtmlAtSitemapUrlError };
