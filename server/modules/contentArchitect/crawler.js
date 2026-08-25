// ── Stage 4: crawler + link graph ────────────────────────────────────────────
// One plain HTTP GET per URL, no headless browser, no JS execution — matches
// this app's established lightweight-scraping architecture. p-limit is
// ESM-only ("type": "module"), bridged via dynamic import() same as the
// clustering engine originally bridged ml-hclust.
const cheerio = require('cheerio');
const robotsParserLib = require('robots-parser');
const { fetchSafe, USER_AGENT } = require('./urlSafety');
const { normalizeUrl } = require('./urlNormalizer');
const {
  CRAWL_CONCURRENCY, CRAWL_REQUEST_TIMEOUT_MS, CRAWL_TOTAL_BUDGET_MS,
  LARGE_SELECTION_THRESHOLD, CRAWL_SAMPLE_SIZE, CRAWL_FAILURE_ABORT_THRESHOLD, CRAWL_FAILURE_CHECK_AFTER,
} = require('./config');

const BOILERPLATE_SELECTORS = [
  'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'svg', 'form',
  '[class*="cookie" i]', '[id*="cookie" i]', '[class*="consent" i]', '[id*="consent" i]',
  '[class*="nav" i]', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
];

// Booking/scheduling pages are functional CTAs, not content — a real user
// flagged one ("/request-an-appointment") appearing as a spoke alongside
// genuine articles. Matched by exact path segment (not substring) so a real
// article like "/blog/preparing-for-your-first-appointment" is never caught
// by this — same lesson as the earlier "tag" inside "tag-management" bug.
const TRANSACTIONAL_UTILITY_SEGMENTS = new Set([
  'request-an-appointment', 'schedule-an-appointment', 'schedule-appointment',
  'book-appointment', 'book-an-appointment', 'make-an-appointment', 'appointment-request', 'appointments',
]);

function isTransactionalUtilityPage(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).some((seg) => TRANSACTIONAL_UTILITY_SEGMENTS.has(seg.toLowerCase()));
  } catch {
    return false;
  }
}

function asArray(v) { return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]); }

// Deterministic, evenly-spread sample across the input array — not just the
// first N, so an oversized site's sample still touches its full URL range
// rather than one arbitrary prefix (e.g. only the alphabetically-first
// pattern group).
function evenSample(items, n) {
  if (items.length <= n) return items;
  const step = items.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

function parseJsonLd($) {
  const results = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      for (const entry of asArray(parsed['@graph'] || parsed)) results.push(entry);
    } catch { /* malformed JSON-LD is common in the wild — skip, don't fail the page */ }
  });
  return results;
}

function extractDates($, jsonLd) {
  for (const entry of jsonLd) {
    if (entry?.datePublished || entry?.dateModified) {
      return { publishedAt: entry.datePublished || null, modifiedAt: entry.dateModified || entry.datePublished || null };
    }
  }
  const timeTag = $('time[datetime]').first().attr('datetime');
  if (timeTag) return { publishedAt: timeTag, modifiedAt: timeTag };
  const metaPublished = $('meta[property="article:published_time"]').attr('content');
  if (metaPublished) return { publishedAt: metaPublished, modifiedAt: metaPublished };
  return { publishedAt: null, modifiedAt: null };
}

function extractSchemaType(jsonLd) {
  for (const entry of jsonLd) if (entry?.['@type']) return String(entry['@type']);
  return null;
}

function mainContentText($) {
  const $clone = $.root().clone();
  for (const sel of BOILERPLATE_SELECTORS) $clone.find(sel).remove();
  return $clone.find('body').text().replace(/\s+/g, ' ').trim();
}

function firstParagraph($) {
  const $clone = $.root().clone();
  for (const sel of BOILERPLATE_SELECTORS) $clone.find(sel).remove();
  const candidates = $clone.find('p').toArray().map((el) => $clone.find(el).text().replace(/\s+/g, ' ').trim());
  const real = candidates.find((t) => t.length > 40) || candidates[0] || '';
  return real.slice(0, 300);
}

function extractOutboundLinks($, baseUrl, host) {
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#')) return;
    const anchorText = $(el).text().replace(/\s+/g, ' ').trim();
    const abs = normalizeUrl(href, baseUrl);
    if (!abs) return;
    try {
      if (new URL(abs).hostname !== host) return; // internal links only
    } catch { return; }
    if (abs === normalizeUrl(baseUrl)) return; // self-link
    links.push({ href: abs, anchorText });
  });
  return links;
}

// Parses one already-fetched HTML page into the canonical Page shape (minus
// id/clusterId/role — those are assigned downstream). Returns
// { dropped: false, data } or { dropped: true, reason }.
function parsePage(html, finalUrl, host, statusCode) {
  const $ = cheerio.load(html);

  const canonicalHref = $('link[rel="canonical"]').attr('href');
  if (canonicalHref) {
    const canonicalAbs = normalizeUrl(canonicalHref, finalUrl);
    if (canonicalAbs && canonicalAbs !== normalizeUrl(finalUrl)) {
      return { dropped: true, reason: 'non-canonical duplicate', detail: `canonical points to ${canonicalAbs}` };
    }
  }

  const metaRobots = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  if (metaRobots.includes('noindex')) return { dropped: true, reason: 'noindex' };

  const jsonLd = parseJsonLd($);
  const dates = extractDates($, jsonLd);
  const mainText = mainContentText($);
  const wordCount = mainText ? mainText.split(/\s+/).filter(Boolean).length : 0;

  return {
    dropped: false,
    data: {
      url: normalizeUrl(finalUrl),
      finalUrl,
      status: statusCode,
      canonical: canonicalHref ? normalizeUrl(canonicalHref, finalUrl) : null,
      noindex: false,
      title: $('title').first().text().trim() || null,
      h1: $('h1').first().text().trim() || null,
      h2s: $('h2, h3').toArray().map((el) => $(el).text().replace(/\s+/g, ' ').trim()).filter(Boolean),
      metaDescription: $('meta[name="description"]').attr('content')?.trim() || null,
      firstParagraph: firstParagraph($),
      wordCount,
      publishedAt: dates.publishedAt,
      modifiedAt: dates.modifiedAt,
      schemaType: extractSchemaType(jsonLd),
      crawlStatus: 'crawled',
      estimated: false,
      outboundLinks: extractOutboundLinks($, finalUrl, host),
    },
  };
}

async function fetchWithRetry(url, timeout) {
  try {
    return await fetchSafe(url, { timeout });
  } catch (err) {
    if (err.response?.status >= 500 && err.response?.status < 600) {
      return await fetchSafe(url, { timeout }); // one retry, 5xx only
    }
    throw err;
  }
}

// Crawls `urls` (already the user-confirmed set). Returns:
// { pages: Page[], excluded: [{url, reason, detail}], sampled: bool,
//   sampleSize, budgetHit, abortedForFailureRate, crawlMode }
async function crawlSite(urls, origin, { onProgress } = {}) {
  const { default: pLimit } = await import('p-limit');
  const host = new URL(origin).hostname;

  let robots = null;
  let concurrency = CRAWL_CONCURRENCY;
  try {
    const res = await fetchSafe(`${origin}/robots.txt`, { timeout: CRAWL_REQUEST_TIMEOUT_MS });
    robots = robotsParserLib(`${origin}/robots.txt`, res.data);
    const delay = robots.getCrawlDelay(USER_AGENT) || robots.getCrawlDelay('*');
    if (delay) concurrency = Math.max(1, Math.min(concurrency, Math.floor(CRAWL_CONCURRENCY / Math.max(1, delay))));
  } catch { /* no robots.txt is common and fine — nothing to restrict on */ }

  let targetUrls = urls;
  const sampled = urls.length > LARGE_SELECTION_THRESHOLD;
  if (sampled) targetUrls = evenSample(urls, CRAWL_SAMPLE_SIZE);

  const pages = [];
  const excluded = [];
  const startTime = Date.now();
  let budgetHit = false;
  let abortedForFailureRate = false;
  let completed = 0;
  let failed = 0;
  let aborted = false;

  const limit = pLimit(concurrency);

  const tasks = targetUrls.map((url) => limit(async () => {
    if (aborted) return;
    if (Date.now() - startTime > CRAWL_TOTAL_BUDGET_MS) { budgetHit = true; return; }
    if (robots && !robots.isAllowed(url, USER_AGENT) && !robots.isAllowed(url, '*')) {
      excluded.push({ url, reason: 'robots.txt disallow' });
      return;
    }

    try {
      // fetchSafe's validateStatus only resolves for 200-399 (after
      // following redirects itself) — anything else throws, so the non-200
      // case is handled in the catch below via the error's response status,
      // not this branch (kept as a narrow safety net for odd 2xx/3xx codes
      // like 204/206 that resolve but aren't exactly 200).
      const res = await fetchWithRetry(url, CRAWL_REQUEST_TIMEOUT_MS);
      if (res.status !== 200) {
        excluded.push({ url, reason: `HTTP ${res.status}` });
        failed++;
      } else if (normalizeUrl(res.finalUrl) === normalizeUrl(origin) && normalizeUrl(url) !== normalizeUrl(origin)) {
        // A confirmed URL that redirects to the site root isn't distinct
        // content — the homepage is excluded from Stage 2's confirmed set by
        // design, so a stray redirect landing there shouldn't sneak back in
        // as if it were real, analyzable content for this cluster.
        excluded.push({ url, reason: 'redirects to homepage', detail: 'not distinct content' });
      } else if (isTransactionalUtilityPage(res.finalUrl)) {
        excluded.push({ url, reason: 'transactional/utility page', detail: 'booking or scheduling page, not content' });
      } else {
        const parsed = parsePage(res.data, res.finalUrl, host, res.status);
        if (parsed.dropped) {
          excluded.push({ url, reason: parsed.reason, detail: parsed.detail });
        } else {
          pages.push(parsed.data);
        }
      }
    } catch (err) {
      const status = err.response?.status;
      excluded.push({ url, reason: status ? `HTTP ${status}` : 'crawl failed', detail: err.message });
      failed++;
    } finally {
      completed++;
      if (onProgress) onProgress({ completed, total: targetUrls.length });
      if (completed === CRAWL_FAILURE_CHECK_AFTER && failed / completed > CRAWL_FAILURE_ABORT_THRESHOLD) {
        aborted = true;
        abortedForFailureRate = true;
      }
    }
  }));

  await Promise.all(tasks);

  // Two different confirmed URLs can both redirect to the same final URL
  // (e.g. two retired slugs both 301-ing to the same current page) — keep
  // the first, exclude the rest as duplicates. Without this, duplicate
  // .url values silently corrupt the link graph's URL -> index map (a Map
  // can't hold two entries under the same key), producing wrong edges for
  // whichever page loses the collision.
  const seenFinalUrls = new Set();
  const deduped = [];
  for (const p of pages) {
    if (seenFinalUrls.has(p.url)) {
      excluded.push({ url: p.finalUrl, reason: 'duplicate final URL', detail: `another confirmed URL already resolved to ${p.url}` });
      continue;
    }
    seenFinalUrls.add(p.url);
    deduped.push(p);
  }
  pages.length = 0;
  pages.push(...deduped);

  // Anything not crawled (sampled out, budget-cut, or failure-rate-aborted)
  // falls back to slug-only estimation rather than being silently dropped —
  // per spec, a page that couldn't be crawled is marked, not discarded.
  const crawledUrlSet = new Set(pages.map((p) => p.url));
  const excludedUrlSet = new Set(excluded.map((e) => e.url));
  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (!crawledUrlSet.has(normalized) && !excludedUrlSet.has(url)) {
      pages.push({
        url: normalized, finalUrl: url, status: null, canonical: null, noindex: false,
        title: null, h1: null, h2s: [], metaDescription: null, firstParagraph: null, wordCount: 0,
        publishedAt: null, modifiedAt: null, schemaType: null,
        crawlStatus: abortedForFailureRate ? 'skipped' : 'failed', estimated: true, outboundLinks: [],
      });
    }
  }

  return {
    pages, excluded, sampled, sampleSize: sampled ? CRAWL_SAMPLE_SIZE : urls.length,
    budgetHit, abortedForFailureRate, crawlMode: sampled ? 'sampled' : (abortedForFailureRate ? 'slug-only' : 'crawled'),
  };
}

module.exports = { crawlSite, parsePage, mainContentText, firstParagraph, evenSample };
