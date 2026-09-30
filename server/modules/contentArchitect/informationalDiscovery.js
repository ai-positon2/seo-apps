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
//   1. Its header and footer menus. Links whose label names an informational
//      section (Blog, Patient Resources, Help Center, FAQ…) are the site's
//      informational sections. They are passed to the page check as hints.
//   2. Its sitemaps — every one robots.txt declares, else the usual paths
//      (sitemapDiscovery.js, the same resolver the standalone tool uses) —
//      plus each informational section's own sitemap, which the root one does
//      not always list.
//   3. Each informational section walked as a listing through its pagination
//      (rel="next", "Next/Older" links, /page/2, /2, ?page=2 …), collecting the
//      pages it lists. This is what finds articles a sitemap leaves out, and
//      posts that live at the site root rather than under a /blog/ folder.
//
// Deliberately NOT followed: any other link. No link crawl is used as a
// fallback either — a site with no usable sitemap is analysed from its menus
// and listings alone, and says so.
//
// Every network call goes through fetchSafe (SSRF-guarded) or the crawler's own
// fetch, respects robots.txt — its Crawl-delay included — and is spaced. A site
// that refuses the requests (401/403/429) is reported as blocking, not as
// empty. The fetchers are injectable, so the rules below are testable without a
// network.

const cheerio = require('cheerio');
const { discoverUrls, resolveSitemapUrls } = require('./sitemapDiscovery');
const { fetchSafe } = require('./urlSafety');
const {
  DISCOVERY_MAX_LISTINGS, DISCOVERY_MAX_LISTING_PAGES, DISCOVERY_LISTING_DELAY_MS, DISCOVERY_LISTING_BUDGET_MS,
  DISCOVERY_FETCH_CONCURRENCY, DISCOVERY_FETCH_DELAY_MS, DISCOVERY_MAX_CRAWL_DELAY_MS, DISCOVERY_SECTION_SITEMAP_MAX,
  DISCOVERY_HONOUR_CRAWL_DELAY,
  MAX_SITEMAP_URLS, MAX_CHILD_SITEMAPS,
} = require('./config');

// Menu labels (or the link's own path words) that name an informational
// section. "news" is left out on purpose: news is excluded from hub and spoke,
// and walking its listing would only fetch pages to throw away.
const INFO_SECTION_RE = /\b(blogs?|articles?|resources?|resource cent(er|re)|learn(ing)?( cent(er|re))?|guides?|insights?|knowledge( base| cent(er|re))?|library|help( cent(er|re))?|faqs?|education|tips|academy|how[- ]to|glossary|answers)\b/i;
// A section's NAME ends in one of those words: "Blog", "Patient Resources",
// "Moz Academy", "Help Center". Containing one is not enough — seen live, a
// "Help Scout" integration page was walked as the Help section, and HubSpot's
// and Moz's "Learn more" buttons (product pages) as Learn sections.
const SECTION_NAME_END_RE = /\b(blogs?|articles?|resources?|resource cent(er|re)|learn(ing)?( cent(er|re))?|guides?|insights?|knowledge( base| cent(er|re))?|library|help( cent(er|re))?|faqs?|education|tips|academy|how[- ]to|glossary|answers)$/i;
// The last path segment of a section: exactly a section word, or ending in one
// that names a collection ("patient-resources", "product-blog"). A singular
// "guide", "article" or "resource" at the end of a longer slug is one article
// ("zapier-copilot-guide", "pie-baking-guide"), not a section.
const SECTION_SEGMENT_RE = /(^|-)(blogs?|articles|resources|resource-cent(er|re)|learn(ing)?(-cent(er|re))?|guides|insights|knowledge(-base|-cent(er|re))?|knowledgebase|library|help(-cent(er|re))?|faqs?|education|tips|academy|how-to|glossary|answers)$|^(guide|article|resource|insight)$/i;
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

// Text nodes are joined with spaces: a mega-menu link is often
// <span>Guides</span><span>Go deep with dedicated guidance</span>, and cheerio's
// .text() ran those together as "GuidesGo deep with dedicated guidance".
function textOf($, el) {
  const $el = $(el);
  const text = textChunks($, el).join(' ');
  return (text || $el.attr('aria-label') || $el.attr('title') || '').replace(/\s+/g, ' ').trim();
}

function textChunks($, el) {
  const chunks = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.type === 'text') {
        const t = String(child.data || '').replace(/\s+/g, ' ').trim();
        if (t) chunks.push(t);
      } else if (child.type === 'tag' && !/^(script|style|noscript|svg|template)$/i.test(child.name)) {
        walk(child);
      }
    }
  };
  walk($(el).get(0) || {});
  return chunks;
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
    out.push({ url: u.href, label: textOf($, el), firstText: textChunks($, el)[0] || null, area });
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
    //
    // A mega-menu link carries a name and a strapline ("Guides" / "Go deep with
    // dedicated guidance"): its first text chunk is judged as well as the whole.
    // "Resources & Reference" is two names, either of which can be the section.
    const names = [link.label, link.firstText]
      .map((s) => String(s || '').replace(/[\s:›»→>…]+$/g, '').trim())
      .filter(Boolean)
      .flatMap((s) => [s, ...s.split(/\s*(?:&|\/|,|\band\b)\s*/i)])
      .filter(Boolean);
    const lastSegment = (u.pathname.split('/').filter(Boolean).pop() || '').replace(/\.[a-z]+$/i, '').toLowerCase();
    // A singular "guide"/"article"/"resource" ends a section's name only when
    // the name is that short ("SEO Guide"); a longer one is an article's title
    // ("Zapier quick-start guide").
    const labelOk = names.some((name) => {
      const words = name.split(/\s+/).length;
      if (words > 4 || !SECTION_NAME_END_RE.test(name)) return false;
      return words <= 2 || !/\b(guide|article|resource|insight)$/i.test(name);
    });
    const pathOk = lastSegment.split(/[-_]/).filter(Boolean).length <= 2 && SECTION_SEGMENT_RE.test(lastSegment.replace(/_/g, '-'));
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
  deadline = null,
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
    // A site's Crawl-delay can make 40 pages of pagination take many minutes;
    // the walk stops at the run's discovery time limit instead.
    if (deadline && page > 1 && Date.now() + delayMs > deadline) { stoppedBecause = 'stopped at the time limit'; break; }
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

// robots.txt as the crawler reads it: which URLs may be fetched, and the
// Crawl-delay (ms) the site asks for, which the site crawl already honours.
function robotsCheck(robotsTxt) {
  const none = { allowed: () => true, crawlDelayMs: 0 };
  if (!robotsTxt) return none;
  try {
    // eslint-disable-next-line global-require
    const { parseRobots, isAllowedByRobots } = require('../crawlScope/crawler');
    const { rules, crawlDelay } = parseRobots(robotsTxt, 'crawlscope');
    return {
      allowed: (url) => {
        try { return isAllowedByRobots(url, rules); } catch { return true; }
      },
      crawlDelayMs: Number.isFinite(crawlDelay) && crawlDelay > 0
        ? Math.min(crawlDelay * 1000, DISCOVERY_MAX_CRAWL_DELAY_MS)
        : 0,
    };
  } catch {
    return none;
  }
}

// The HTTP status a failed fetch carried, when it carried one.
function statusOf(error) {
  const status = Number(error?.response?.status ?? error?.status);
  if (Number.isFinite(status) && status > 0) return status;
  const m = /status code (\d{3})/i.exec(String(error?.message || ''));
  return m ? Number(m[1]) : null;
}
const REFUSED = new Set([401, 403, 429]);

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
  // A caller that injects its own sitemap reader (tests) gets no section
  // probes unless it injects those too, so nothing reaches the network.
  sitemapDiscover = discoverUrls,
  sectionSitemap = sitemapDiscover === discoverUrls ? resolveSitemapUrls : async () => null,
  fetchHtml = defaultFetchHtml,
  maxListings = DISCOVERY_MAX_LISTINGS, maxListingPages = DISCOVERY_MAX_LISTING_PAGES,
  listingDelayMs = DISCOVERY_LISTING_DELAY_MS, listingBudgetMs = DISCOVERY_LISTING_BUDGET_MS,
  honourCrawlDelay = DISCOVERY_HONOUR_CRAWL_DELAY,
} = {}) {
  const limitations = [];
  const candidates = new Map(); // key -> { url, sources: Set, lastmod }
  const add = (url, source, lastmod = null) => {
    const u = safeUrl(url);
    if (!u || !sameSite(u.href, origin) || ASSET_EXT_RE.test(u.pathname)) return false;
    const key = keyOf(u);
    if (!candidates.has(key)) candidates.set(key, { url: u.href, sources: new Set(), lastmod: null });
    const c = candidates.get(key);
    c.sources.add(source);
    if (lastmod && !c.lastmod) c.lastmod = lastmod;
    return true;
  };
  // Statuses of the site's own front door. When the homepage, robots.txt and
  // the sitemaps all refuse the request, the site is blocking the crawler — and
  // saying "publish a sitemap" would be the wrong advice.
  const refusals = [];

  let robotsTxt = null;
  try {
    robotsTxt = await fetchHtml(new URL('/robots.txt', origin).href);
  } catch (e) {
    if (REFUSED.has(statusOf(e))) refusals.push({ what: 'robots.txt', status: statusOf(e) });
  }
  const robots = robotsCheck(robotsTxt);
  const { allowed } = robots;
  // One switch for both the listing walks here and the page reads that
  // follow (buildFromDiscovery reads crawlDelayMs off the result).
  const crawlDelayMs = honourCrawlDelay ? robots.crawlDelayMs : 0;
  const delayMs = Math.max(listingDelayMs, crawlDelayMs);

  // 1. Menus — read first, because the sections they name are where a site
  // keeps section sitemaps its root sitemap does not always list.
  let menuLinks = [];
  let homepageStatus = null;
  try {
    menuLinks = extractMenuLinks(await fetchHtml(origin), origin);
  } catch (e) {
    homepageStatus = statusOf(e);
    if (REFUSED.has(homepageStatus)) refusals.push({ what: 'homepage', status: homepageStatus });
    limitations.push(`The homepage could not be read (${e.message}), so its menus gave no hints.`);
  }
  const informational = informationalMenuLinks(menuLinks).filter((l) => allowed(l.url));

  // 2. Sitemaps: every one robots.txt declares, then each informational
  // section's own (measured: one SaaS site's blog sitemap sat at
  // /blog/sitemap_index.xml, listed in neither robots.txt nor its root index).
  let sitemap = { mode: 'not-found', source: null, count: 0, capped: false, capReason: null, sectionSitemaps: [] };
  try {
    const found = await sitemapDiscover(origin);
    const entries = (found?.urls || []).map((e) => (typeof e === 'string' ? { url: e } : e)).filter((e) => e?.url);
    for (const e of entries) if (allowed(e.url)) add(e.url, 'sitemap', e.lastmod || null);
    sitemap = {
      mode: found?.mode || 'not-found',
      source: found?.source || null,
      sources: found?.sources || null,
      count: entries.length,
      capped: Boolean(found?.capped),
      capReason: found?.capReason || null,
      sectionSitemaps: [],
    };
  } catch (e) {
    if (REFUSED.has(statusOf(e))) refusals.push({ what: 'sitemap', status: statusOf(e) });
    sitemap = { mode: 'error', source: null, count: 0, capped: false, capReason: null, sectionSitemaps: [], error: e.message };
  }
  const probed = new Set([sitemap.source, ...(sitemap.sources || []).map((s) => s.url)].filter(Boolean));
  for (const link of informational.slice(0, maxListings)) {
    const u = safeUrl(link.url);
    const base = u ? trimSlash(u.pathname).replace(/\.[a-z]+$/i, '') : '/';
    if (!u || base === '/') continue;
    for (const name of ['sitemap.xml', 'sitemap_index.xml']) {
      const url = new URL(`${base}/${name}`, origin).href;
      if (probed.has(url) || !allowed(url)) continue;
      probed.add(url);
      let section;
      // eslint-disable-next-line no-await-in-loop
      try { section = await sectionSitemap(url); } catch { section = null; }
      const entries = (section?.urls || []).slice(0, DISCOVERY_SECTION_SITEMAP_MAX);
      let added = 0;
      for (const e of entries) {
        const before = candidates.size;
        if (allowed(e.url) && add(e.url, 'sitemap', e.lastmod || null) && candidates.size > before) added += 1;
      }
      if (entries.length) {
        sitemap.sectionSitemaps.push({ url, count: entries.length, added });
        sitemap.count += added;
        if (sitemap.mode !== 'sitemap') sitemap.mode = 'sitemap';
        break; // sitemap.xml and sitemap_index.xml are alternatives
      }
    }
  }

  if (!sitemap.count) {
    limitations.push('No usable sitemap was found, so pages were found only through the listing pages the site\'s menus link to.');
  } else if (sitemap.capped) {
    limitations.push(sitemap.capReason === 'child sitemap count'
      ? `The site's sitemaps list more files than the ${MAX_CHILD_SITEMAPS} read per run, so some of their pages were not considered.`
      : `The site's sitemaps list more than the ${MAX_SITEMAP_URLS.toLocaleString('en-US')} URLs read per run, so some of their pages were not considered.`);
  }
  for (const s of sitemap.sectionSitemaps) {
    if (s.added) limitations.push(`${s.added} page(s) were found only in ${new URL(s.url).pathname}, a sitemap that neither robots.txt nor the main sitemap lists.`);
  }

  if (menuLinks.length && menuLinks.every((l) => l.area === 'page')) {
    limitations.push('The homepage has no marked-up header or footer menu, so its own links (image-map navigation included) were read as its navigation.');
  }
  if (menuLinks.length && !informational.length) {
    // Said, because it changes how the result should be read.
    limitations.push('The site\'s header and footer menus link to no informational section (Blog, Resources, Learn…).');
  } else if (!menuLinks.length && homepageStatus === null) {
    limitations.push('No header or footer menu links were found in the homepage HTML (menus built by JavaScript cannot be read), so no listing pages were walked.');
  }
  if (crawlDelayMs > DISCOVERY_LISTING_DELAY_MS) {
    limitations.push(`robots.txt asks for ${Math.round(crawlDelayMs / 1000)} second(s) between requests, so listing pages were read at that pace.`);
  }

  // 3. Listing pages, walked through their pagination.
  const listings = [];
  const listingEdges = [];
  const listingDeadline = Date.now() + listingBudgetMs;
  for (const link of informational.slice(0, maxListings)) {
    add(link.url, 'menu');
    // eslint-disable-next-line no-await-in-loop
    const walk = await walkListing(link, {
      fetchHtml, maxPages: maxListingPages, allowed, delayMs, deadline: listingDeadline,
    });
    for (const url of walk.found) add(url, 'listing');
    for (const edge of walk.edges) listingEdges.push(edge);
    listings.push({
      url: walk.url, label: walk.label, area: walk.area, pagesWalked: walk.pagesWalked, pages: walk.pages,
      found: walk.found.length, stoppedBecause: walk.stoppedBecause,
    });
    if (/needs JavaScript/.test(walk.stoppedBecause)) {
      limitations.push(`"${walk.label || walk.url}" loads more posts with a button, which needs JavaScript; only its first page was read.`);
    } else if (/time limit/.test(walk.stoppedBecause)) {
      limitations.push(`"${walk.label || walk.url}" was read for ${walk.pagesWalked} page(s) of its pagination before the ${Math.round(listingBudgetMs / 60000)}-minute listing limit.`);
    }
  }
  if (informational.length > maxListings) {
    limitations.push(`${informational.length - maxListings} further informational menu link(s) were not walked (limit ${maxListings}).`);
  }

  const blocked = refusals.some((r) => r.what === 'homepage') && !sitemap.count && !listings.some((l) => l.pagesWalked);

  return {
    candidates: [...candidates.values()].map((c) => ({ url: c.url, sources: [...c.sources], lastmod: c.lastmod })),
    sitemap,
    // The site refused the requests (401/403/429) rather than having nothing
    // to find. { status } of the homepage when so, null otherwise.
    blocked: blocked ? { status: homepageStatus, refusals } : null,
    crawlDelayMs,
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
  robotsCheck,
  extractMenuLinks,
  informationalMenuLinks,
  listingContentLinks,
  nextPageUrl,
  walkListing,
  INFO_SECTION_RE,
};
