// ── Where a project's hub and spoke analysis finds its pages ─────────────────
//
// Hub and spoke used to take whatever the site crawl had reached. Two things
// went wrong with that on real sites: the crawl's URL budget was spent on
// whatever the site has most of (290 product pages on one store left room for
// 11 blog posts), and link-following fills the set with filtered views, tag
// archives and pagination that are never content.
//
// So the candidate pages come from where a site declares its content instead:
//
//   1. Its sitemaps (robots.txt, then the usual paths) — sitemapDiscovery.js,
//      the same resolver the standalone tool uses.
//   2. Its header and footer menus. Links labelled like Blog, Resources,
//      Learn, Guides, Help or FAQ name the site's informational sections. They
//      are passed to the page check as hints, and each is treated as a
//      listing page:
//   3. walked through its pagination (rel="next", "Next/Older" links,
//      /page/2, /2, ?page=2 …), collecting the pages it lists. This is what
//      finds articles a sitemap leaves out, and posts that live at the site
//      root rather than under a /blog/ folder.
//
// Deliberately NOT followed: any other link. No link crawl is used as a
// fallback either — a site with no usable sitemap is analysed from its menus
// and listings alone, and says so.
//
// Every network call goes through fetchSafe (SSRF-guarded) or the crawler's own
// fetch, respects robots.txt, and is spaced. The fetchers are injectable, so
// the rules below are testable without a network.

const cheerio = require('cheerio');
const { discoverUrls } = require('./sitemapDiscovery');
const { fetchSafe } = require('./urlSafety');
const {
  DISCOVERY_MAX_LISTINGS, DISCOVERY_MAX_LISTING_PAGES, DISCOVERY_LISTING_DELAY_MS,
  DISCOVERY_FETCH_CONCURRENCY, DISCOVERY_FETCH_DELAY_MS,
} = require('./config');

// Menu labels (or the link's own path words) that name an informational
// section. "news" is left out on purpose: news is excluded from hub and spoke,
// and walking its listing would only fetch pages to throw away.
const INFO_SECTION_RE = /\b(blogs?|articles?|resources?|resource cent(er|re)|learn(ing)?( cent(er|re))?|guides?|insights?|knowledge( base| cent(er|re))?|library|help( cent(er|re))?|faqs?|education|tips|academy|how[- ]to|glossary|answers)\b/i;
const ASSET_EXT_RE = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|zip|gz|docx?|xlsx?|pptx?|css|js|json|xml|txt|ics|rss)$/i;
const NEXT_TEXT_RE = /^(next|next page|older|older posts|older entries|older articles|more posts|more articles|›|»|→|>|>>)$/i;
const LOAD_MORE_RE = /\b(load|show|view) more\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeUrl(value, base) {
  try {
    const u = base ? new URL(value, base) : new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

const hostKey = (u) => u.host.toLowerCase().replace(/^www\./, '');
function sameSite(url, origin) {
  const a = safeUrl(url);
  const b = safeUrl(origin);
  return Boolean(a && b && hostKey(a) === hostKey(b));
}
const trimSlash = (path) => (path.replace(/\/+$/, '') || '/');
const keyOf = (u) => `${hostKey(u)}${trimSlash(u.pathname).toLowerCase()}${u.search}`;

function textOf($, el) {
  const $el = $(el);
  return ($el.text() || $el.attr('aria-label') || $el.attr('title') || '').replace(/\s+/g, ' ').trim();
}

/**
 * The links in a page's header navigation and its footer.
 * @returns {Array<{url: string, label: string, area: 'header'|'footer'}>}
 */
function extractMenuLinks(html, pageUrl) {
  const $ = cheerio.load(String(html || ''));
  const out = [];
  const seen = new Set();
  const take = (el, area) => {
    const u = safeUrl($(el).attr('href'), pageUrl);
    if (!u || !sameSite(u.href, pageUrl)) return;
    const key = `${area}|${keyOf(u)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: u.href, label: textOf($, el), area });
  };
  $('footer a[href], [role="contentinfo"] a[href]').each((_, el) => take(el, 'footer'));
  $('header a[href], nav a[href], [role="navigation"] a[href], [role="banner"] a[href]').each((_, el) => {
    if ($(el).closest('footer, [role="contentinfo"]').length) return;
    take(el, 'header');
  });
  // A site with no marked-up header or footer still has navigation — tables,
  // or an image map with no text at all (one essay site's only menu was
  // <area href="articles.html">). Then the homepage's own links, image-map
  // areas included, stand in for the menus; the caller says so.
  if (!out.length) {
    $('area[href], a[href]').each((_, el) => take(el, 'page'));
  }
  return out;
}

/** Menu links that name an informational section, most specific first, deduped. */
function informationalMenuLinks(menuLinks) {
  const byKey = new Map();
  for (const link of menuLinks || []) {
    const u = safeUrl(link.url);
    if (!u || trimSlash(u.pathname) === '/') continue;
    // A SECTION link is named in a word or two ("Blog", "Help Center"). A menu
    // can also feature single articles — one site's header linked "How to Build
    // an Audience From Scratch In 2026" — and walking an article as a listing
    // follows its "next post" links through the archive. So the label, or the
    // link's last path segment, has to be short as well as match.
    const label = String(link.label || '').trim();
    const lastSegment = (u.pathname.split('/').filter(Boolean).pop() || '').replace(/\.[a-z]+$/i, '');
    const labelOk = label.split(/\s+/).filter(Boolean).length <= 4 && INFO_SECTION_RE.test(label);
    const pathOk = lastSegment.split(/[-_]/).filter(Boolean).length <= 3 && INFO_SECTION_RE.test(lastSegment.replace(/[-_]/g, ' '));
    if (!labelOk && !pathOk) continue;
    const key = keyOf(u);
    if (!byKey.has(key)) byKey.set(key, { ...link, url: u.href });
  }
  // Header links before footer links: the main menu is the site's own ranking.
  return [...byKey.values()].sort((a, b) => (a.area === b.area ? 0 : a.area === 'header' ? -1 : 1));
}

/**
 * The links in a listing page's content — everything outside the header,
 * footer, navigation and sidebars, which repeat on every page and are not
 * what the listing lists.
 */
function listingContentLinks(html, pageUrl) {
  const $ = cheerio.load(String(html || ''));
  $('header, footer, nav, aside, script, style, noscript, [role="navigation"], [role="banner"], [role="contentinfo"]').remove();
  const out = new Set();
  const self = safeUrl(pageUrl);
  $('a[href]').each((_, el) => {
    const u = safeUrl($(el).attr('href'), pageUrl);
    if (!u || !sameSite(u.href, pageUrl)) return;
    if (ASSET_EXT_RE.test(u.pathname)) return;
    if (self && keyOf(u) === keyOf(self)) return;
    out.add(u.href);
  });
  return [...out];
}

/**
 * The next page of a paginated listing, or null. In order of how explicit the
 * site is about it: rel="next"; a link whose text is "Next"/"Older"/"›"; a link
 * shaped like page N+1 of this listing (/page/3, /3, /page-3, ?page=3,
 * ?paged=3, ?pg=3, ?p=3).
 */
function nextPageUrl(html, pageUrl, listingUrl, pageNumber) {
  const $ = cheerio.load(String(html || ''));
  const candidates = [];
  $('link[rel~="next"][href], a[rel~="next"][href]').each((_, el) => candidates.push($(el).attr('href')));
  $('a[href]').each((_, el) => {
    const text = textOf($, el);
    const aria = String($(el).attr('aria-label') || '');
    if (NEXT_TEXT_RE.test(text) || /\bnext\b/i.test(aria)) candidates.push($(el).attr('href'));
  });

  const listing = safeUrl(listingUrl);
  if (listing) {
    const base = trimSlash(listing.pathname).replace(/\/$/, '');
    const n = pageNumber + 1;
    const shapes = [
      `${base}/page/${n}`, `${base}/${n}`, `${base}/page-${n}`, `${base}/p/${n}`, `${base}/p${n}`,
    ].map((p) => p.replace(/^\/\//, '/'));
    $('a[href]').each((_, el) => {
      const u = safeUrl($(el).attr('href'), pageUrl);
      if (!u || !sameSite(u.href, listingUrl)) return;
      const path = trimSlash(u.pathname);
      const query = ['page', 'paged', 'pg', 'p'].some((k) => u.searchParams.get(k) === String(n));
      if (shapes.includes(path) || (query && trimSlash(u.pathname) === trimSlash(listing.pathname))) {
        candidates.push(u.href);
      }
    });
  }

  const current = safeUrl(pageUrl);
  for (const raw of candidates) {
    const u = safeUrl(raw, pageUrl);
    if (u && sameSite(u.href, listingUrl) && (!current || keyOf(u) !== keyOf(current))) return u.href;
  }
  return null;
}

// A "Load more" / "Show more" control. Read per element: the page's text as a
// whole runs neighbours together ("p1Load more") and hides the word boundary.
function hasLoadMoreControl(html) {
  const $ = cheerio.load(String(html || ''));
  let found = false;
  $('button, a, [role="button"], input[type="button"], input[type="submit"]').each((_, el) => {
    const text = `${textOf($, el)} ${$(el).attr('value') || ''}`;
    if (LOAD_MORE_RE.test(text)) { found = true; return false; }
    return undefined;
  });
  return found;
}

/**
 * Walks one listing page through its pagination.
 * @returns {Promise<{url, label, pagesWalked, found: string[], edges: Array<{from_url, to_url}>, stoppedBecause}>}
 */
async function walkListing(listing, {
  fetchHtml, maxPages = DISCOVERY_MAX_LISTING_PAGES, allowed = () => true, delayMs = DISCOVERY_LISTING_DELAY_MS,
} = {}) {
  const found = new Set();
  const edges = [];
  const visited = new Set();
  const visitedUrls = [];
  let url = listing.url;
  let page = 1;
  let stale = 0;
  let stoppedBecause = 'last page reached';
  let pagesWalked = 0;

  while (url) {
    const u = safeUrl(url);
    if (!u || visited.has(keyOf(u))) { stoppedBecause = 'pagination looped'; break; }
    if (!allowed(url)) { stoppedBecause = 'blocked by robots.txt'; break; }
    visited.add(keyOf(u));
    visitedUrls.push(url);
    let html;
    try {
      // eslint-disable-next-line no-await-in-loop
      html = await fetchHtml(url);
    } catch (e) {
      stoppedBecause = page === 1 ? `could not be fetched (${e.message})` : 'a later page could not be fetched';
      break;
    }
    pagesWalked += 1;
    const before = found.size;
    for (const link of listingContentLinks(html, url)) {
      if (!allowed(link)) continue;
      found.add(link);
      edges.push({ from_url: url, to_url: link });
    }
    stale = found.size === before ? stale + 1 : 0;
    if (stale >= 2) { stoppedBecause = 'pages stopped listing anything new'; break; }
    if (page >= maxPages) { stoppedBecause = `stopped at the ${maxPages}-page limit`; break; }
    const next = nextPageUrl(html, url, listing.url, page);
    if (!next) {
      if (hasLoadMoreControl(html)) {
        stoppedBecause = 'more posts load with a button (needs JavaScript), so only the first page was read';
      }
      break;
    }
    // The listing links to its next page; recorded so a post that first appears
    // on page 7 is reachable from the listing in the link graph, not stranded.
    edges.push({ from_url: url, to_url: next });
    url = next;
    page += 1;
    // eslint-disable-next-line no-await-in-loop
    if (delayMs) await sleep(delayMs);
  }

  // The listing's own pagination pages are listings, not candidates.
  for (const v of visited) {
    for (const f of [...found]) {
      const fu = safeUrl(f);
      if (fu && keyOf(fu) === v) found.delete(f);
    }
  }
  const pages = [...visitedUrls];
  return { url: listing.url, label: listing.label, area: listing.area, pagesWalked, pages, found: [...found], edges, stoppedBecause };
}

async function defaultFetchHtml(url) {
  const res = await fetchSafe(url, { responseType: 'text' });
  const type = String(res.headers?.['content-type'] || '');
  if (type && !/html|xml|text/i.test(type)) throw new Error(`not an HTML page (${type})`);
  return typeof res.data === 'string' ? res.data : String(res.data || '');
}

function robotsCheck(robotsTxt) {
  if (!robotsTxt) return () => true;
  try {
    // eslint-disable-next-line global-require
    const { parseRobots, isAllowedByRobots } = require('../crawlScope/crawler');
    const { rules } = parseRobots(robotsTxt, 'crawlscope');
    return (url) => {
      try { return isAllowedByRobots(url, rules); } catch { return true; }
    };
  } catch {
    return () => true;
  }
}

/**
 * Every candidate page for a site's hub and spoke analysis.
 *
 * @param {string} origin  the project's primary origin
 * @param {object} [opts]
 * @param {Function} [opts.sitemapDiscover]  (origin) => { mode, source, urls: [{url}], capped }
 * @param {Function} [opts.fetchHtml]        (url) => html string; throws on failure
 * @returns {Promise<{candidates: Array<{url, sources: string[]}>, sitemap, menu, listings,
 *          listingEdges, hints, limitations}>}
 */
async function discoverInformationalCandidates(origin, {
  sitemapDiscover = discoverUrls, fetchHtml = defaultFetchHtml,
  maxListings = DISCOVERY_MAX_LISTINGS, maxListingPages = DISCOVERY_MAX_LISTING_PAGES,
  listingDelayMs = DISCOVERY_LISTING_DELAY_MS,
} = {}) {
  const limitations = [];
  const candidates = new Map(); // key -> { url, sources: Set }
  const add = (url, source) => {
    const u = safeUrl(url);
    if (!u || !sameSite(u.href, origin) || ASSET_EXT_RE.test(u.pathname)) return;
    const key = keyOf(u);
    if (!candidates.has(key)) candidates.set(key, { url: u.href, sources: new Set() });
    candidates.get(key).sources.add(source);
  };

  let robotsTxt = null;
  try { robotsTxt = await fetchHtml(new URL('/robots.txt', origin).href); } catch { /* none */ }
  const allowed = robotsCheck(robotsTxt);

  // 1. Sitemaps.
  let sitemap = { mode: 'not-found', source: null, count: 0, capped: false };
  try {
    const found = await sitemapDiscover(origin);
    const urls = (found?.urls || []).map((e) => (typeof e === 'string' ? e : e.url)).filter(Boolean);
    for (const url of urls) if (allowed(url)) add(url, 'sitemap');
    sitemap = { mode: found?.mode || 'not-found', source: found?.source || null, count: urls.length, capped: Boolean(found?.capped) };
  } catch (e) {
    sitemap = { mode: 'error', source: null, count: 0, capped: false, error: e.message };
  }
  if (!sitemap.count) {
    limitations.push('No usable sitemap was found, so pages were found only through the listing pages the site\'s menus link to.');
  } else if (sitemap.capped) {
    limitations.push(`The sitemap was larger than the ${sitemap.count}-URL reading limit, so some of its pages were not considered.`);
  }

  // 2. Menus.
  let menuLinks = [];
  try {
    menuLinks = extractMenuLinks(await fetchHtml(origin), origin);
  } catch (e) {
    limitations.push(`The homepage could not be read (${e.message}), so its menus gave no hints.`);
  }
  const informational = informationalMenuLinks(menuLinks).filter((l) => allowed(l.url));
  if (menuLinks.length && menuLinks.every((l) => l.area === 'page')) {
    limitations.push('The homepage has no marked-up header or footer menu, so its own links (image-map navigation included) were read as its navigation.');
  }
  if (menuLinks.length && !informational.length) {
    // Said, because it changes how the result should be read.
    limitations.push('The site\'s header and footer menus link to no informational section (Blog, Resources, Learn…).');
  } else if (!menuLinks.length) {
    limitations.push('No header or footer menu links were found in the homepage HTML (menus built by JavaScript cannot be read), so no listing pages were walked.');
  }

  // 3. Listing pages, walked through their pagination.
  const listings = [];
  const listingEdges = [];
  for (const link of informational.slice(0, maxListings)) {
    add(link.url, 'menu');
    // eslint-disable-next-line no-await-in-loop
    const walk = await walkListing(link, { fetchHtml, maxPages: maxListingPages, allowed, delayMs: listingDelayMs });
    for (const url of walk.found) add(url, 'listing');
    for (const edge of walk.edges) listingEdges.push(edge);
    listings.push({
      url: walk.url, label: walk.label, area: walk.area, pagesWalked: walk.pagesWalked, pages: walk.pages,
      found: walk.found.length, stoppedBecause: walk.stoppedBecause,
    });
    if (/needs JavaScript/.test(walk.stoppedBecause)) {
      limitations.push(`"${walk.label || walk.url}" loads more posts with a button, which needs JavaScript; only its first page was read.`);
    }
  }
  if (informational.length > maxListings) {
    limitations.push(`${informational.length - maxListings} further informational menu link(s) were not walked (limit ${maxListings}).`);
  }

  return {
    candidates: [...candidates.values()].map((c) => ({ url: c.url, sources: [...c.sources] })),
    sitemap,
    menu: {
      header: menuLinks.filter((l) => l.area === 'header').length,
      footer: menuLinks.filter((l) => l.area === 'footer').length,
      informational: informational.map((l) => ({ label: l.label, url: l.url, area: l.area })),
    },
    listings,
    listingEdges,
    // Every listing page walked, pagination included: link sources for the graph.
    listingPages: listings.flatMap((l) => l.pages || []),
    // For the page check: the site's own words for its informational sections.
    hints: informational.map((l) => ({ label: l.label || null, path: safeUrl(l.url)?.pathname || l.url })),
    limitations,
  };
}

/**
 * Fetches the pages chosen for analysis with the site crawler in list mode, so
 * each page is read exactly as a crawl reads it (title, headings, word counts,
 * canonical, indexability, links) without following anything.
 *
 * @returns {Promise<{results: object[], linkEdges: Array<{sourceUrl, targetUrl}>}>}
 */
async function fetchPages(urls, { crawlerOptions = {} } = {}) {
  if (!urls.length) return { results: [], linkEdges: [] };
  // eslint-disable-next-line global-require
  const { SeoCrawler } = require('../crawlScope/crawler');
  // eslint-disable-next-line global-require
  const { createFetch } = require('../crawlScope/net/egress');
  const crawler = new SeoCrawler({
    maxUrls: urls.length + 10,
    concurrency: DISCOVERY_FETCH_CONCURRENCY,
    perHostDelay: DISCOVERY_FETCH_DELAY_MS,
    timeout: 20000,
    checkExternalLinks: false,
    crawlAssets: false,
    discoverSitemaps: false,
    renderCheck: false,
    fetch: createFetch({
      mode: process.env.EGRESS_MODE || 'direct',
      proxyUrl: process.env.PROXY_URL,
      allowPrivateHosts: process.env.CRAWL_ALLOW_PRIVATE_HOSTS === 'true',
    }),
    ...crawlerOptions,
  });
  const summary = await crawler.start(urls);
  return {
    results: summary.results || [],
    linkEdges: (summary.linkEdges || []).filter((e) => e.sourceUrl && e.targetUrl),
  };
}

module.exports = {
  discoverInformationalCandidates,
  fetchPages,
  extractMenuLinks,
  informationalMenuLinks,
  listingContentLinks,
  nextPageUrl,
  walkListing,
  INFO_SECTION_RE,
};
