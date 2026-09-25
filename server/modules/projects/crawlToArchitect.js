// ── A CrawlScope run, as Content Architect input ─────────────────────────────
//
// CrawlScope already discovers a site's sitemaps, fetches every internal page,
// and stores exactly what Content Architect's clustering needs: title, H1, H2s,
// meta description, word count and depth per page (crawl_run_results), plus the
// internal link graph (crawl_run_links, migration 0012).
//
// So the Hub and Spoke card does not need a second crawl and does not need
// somebody to sit through Content Architect's discovery and URL-pattern review.
// This adapter reshapes stored crawl rows into the page shape
// contentArchitect/crawler.js produces, and hands them to the SAME analysis
// pipeline (fullAnalysis.analyzeCrawledPages). Nothing is re-fetched — §32
// forbids re-crawling inside an audit module — and no clustering logic is
// reimplemented here.
//
// What is genuinely lost by not using Content Architect's own crawler:
//
//   • published/modified dates. CrawlScope does not extract them, so the
//     "stale" half of the thin-or-stale diagnostic cannot fire. Thin (word
//     count) still does. Reported in `limitations` rather than left to look
//     like "no stale pages found".
//   • JSON-LD schema types, for the same reason.
//
// Both are absences, not wrong values, and they are named in the result so a
// card or a report can say so.
//
// ── Only informational pages are clustered ──────────────────────────────────
//
// Hub and spoke maps a site's articles, guides and FAQs. Every other crawled
// page — location, service, people, booking, legal — is left out before the
// pipeline sees it, and listed with the reason (informationalSelection.js).
// Two things still use the WHOLE crawl, because they are facts about the site
// rather than about the clustered pages:
//
//   • inbound links. An article linked only from a service page is linked;
//     counting sources inside the clustered set alone would call it an orphan.
//   • completeness (`capped`) and whether a link graph exists at all.

const db = require('../../services/db');
const {
  selectInformationalPages, persistableSelection, pageKey, REASON_LABELS,
} = require('../contentArchitect/informationalSelection');
const { discoverInformationalCandidates, fetchPages } = require('../contentArchitect/informationalDiscovery');
const { createInformationalClassifier } = require('../contentArchitect/informationalClassifier');
const { MIN_INFORMATIONAL_PAGES, DISCOVERY_MAX_FETCH } = require('../contentArchitect/config');

// CrawlScope joins H2/H3 text with this separator when it stores a result.
const HEADING_SEPARATOR = ' | ';

// A crawl of a handful of pages cannot be clustered meaningfully: MIN_CLUSTER_SIZE
// is 3, so below this there is nothing for the pipeline to find.
const MIN_PAGES_TO_ANALYZE = 5;

// An unpaginated read of a big table returns a silently truncated slice:
// measured on a real 50-page crawl, reading the link graph in one call saw 4
// usable edges where 316 existed, because the first thousand rows were all
// outbound links from the homepage. Worse, the same flaw applied to the pages
// themselves — any crawl over 1,000 URLs would have been clustered from a
// fraction of its pages, with no error and a plausible-looking result. So
// every bulk read here pages through explicitly.
//
// Keyset (id > lastSeenId), not OFFSET — OFFSET's cost grows with how deep
// into the table a page is, and a 272k-row crawl's link graph started failing
// past the halfway point even paginated. Keyset costs the same per page
// regardless of how many pages came before it, so `sql` must select `id` and
// end in "order by id asc" with no LIMIT/OFFSET of its own — this appends the
// cursor condition and the window.
const PAGE_SIZE = 500;

const ORDER_CLAUSE = 'order by id asc';

async function fetchAll(sql, params, { label, cap = 500000 }) {
  const idx = sql.lastIndexOf(ORDER_CLAUSE);
  if (idx === -1) {
    throw new Error(`[crawlToArchitect.${label}] fetchAll expects SQL ending in "${ORDER_CLAUSE}"`);
  }
  const beforeOrder = sql.slice(0, idx).trimEnd();

  const rows = [];
  let lastId = 0;
  for (;;) {
    const cursorIdx = params.length + 1;
    const paged = `${beforeOrder} and id > $${cursorIdx} ${ORDER_CLAUSE} limit $${cursorIdx + 1}`;
    let data;
    try {
      // eslint-disable-next-line no-await-in-loop
      data = await db.rows(paged, [...params, lastId, PAGE_SIZE]);
    } catch (error) {
      throw new Error(`[crawlToArchitect.${label}] ${error.message}`);
    }
    if (!data.length) break;
    rows.push(...data);
    lastId = data[data.length - 1].id;
    if (data.length < PAGE_SIZE) break;
    if (rows.length >= cap) {
      // A cap that silently truncated would be the very bug this function
      // exists to prevent, so say so.
      console.warn(`[crawlToArchitect.${label}] hit the ${cap}-row cap; results are partial`);
      break;
    }
  }
  return rows;
}

function notConfigured() {
  return Object.assign(
    new Error('Reading a crawl needs the database configured.'),
    { status: 503, code: 'not_configured' },
  );
}

/** The newest completed crawl for a project, or null. */
async function latestCompletedCrawl(projectId) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  try {
    return await db.maybeOne(
      `select id, status, finished_at, created_at, summary, options
         from crawl_runs
        where project_id = $1 and status in ('completed', 'stopped')
        order by finished_at desc
        limit 1`,
      [projectId]
    );
  } catch (error) {
    throw new Error(`[crawlToArchitect.latestCompletedCrawl] ${error.message}`);
  }
}

// A site that HTML-encodes its titles twice ("&amp;amp;") leaves one layer
// after the crawler's own decoding, and "Gum Disease &amp; Alzheimer's" then
// shows in the report as written — and feeds "amp" and "nbsp" to term profiling
// as if they were words. Only that one leftover layer is undone, and only the
// entities that actually turn up in page text.
const NAMED_ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
function decodeLeftoverEntities(text) {
  if (!text) return text;
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    const decoded = NAMED_ENTITIES[name.toLowerCase()];
    return decoded === undefined ? match : decoded;
  }).replace(/ /g, ' ');
}

/**
 * One stored crawl result row -> one Content Architect page.
 *
 * Field names are that module's, so its termProfile weights (title 3.0, h1 2.5,
 * h2h3 1.5, metaDescription 1.0, firstParagraph 0.5) apply unchanged.
 */
function pageFromResult(row) {
  const d = row.data || {};
  return {
    url: d.url || row.url,
    finalUrl: d.url || row.url,
    status: d.status ?? row.status ?? null,
    canonical: d.canonical || null,
    noindex: String(d.indexability || '').toLowerCase() === 'non-indexable',
    title: decodeLeftoverEntities(d.title) || null,
    h1: decodeLeftoverEntities(d.h1) || null,
    // Stored as one separator-joined string; the pipeline wants the array back.
    h2s: d.h2
      ? String(d.h2).split(HEADING_SEPARATOR).map((h) => decodeLeftoverEntities(h).trim()).filter(Boolean)
      : [],
    metaDescription: decodeLeftoverEntities(d.metaDescription) || null,
    // CrawlScope keeps a 240-character visible-text sample rather than the first
    // paragraph proper. It carries the lowest term weight of any field (0.5), so
    // the approximation costs little.
    firstParagraph: decodeLeftoverEntities(d.contentSample) || null,
    wordCount: Number(d.words) || 0,
    // Not extracted by CrawlScope — see `limitations` on the result.
    publishedAt: null,
    modifiedAt: null,
    schemaType: null,
    crawlStatus: 'crawled',
    estimated: false,
    // Filled in from crawl_run_links below.
    outboundLinks: [],
  };
}

// The fields that decide whether a page is clustered at all. Kept apart from
// pageFromResult on purpose: that is the pipeline's page shape, this is only
// what selection reads.
function candidateFromRow(row) {
  const d = row.data || {};
  return {
    url: d.url || row.url,
    canonical: d.canonical || null,
    indexability: d.indexability || row.indexability || null,
    indexabilityReason: d.indexabilityReason || null,
    inlinks: Number(d.inlinks) || 0,
  };
}

/**
 * Did the crawl see the whole site?
 *
 * This decides whether "no inbound links" means anything. On a capped crawl
 * most pages are reached from the sitemap rather than from a fetched page, so
 * their linking page was never read — measured on a 50-URL crawl of a large
 * site, 40 of 50 pages had no in-set inbound link and NONE of them was an
 * orphan. Reporting them as orphans would be a false statement about the site,
 * so completeness is recorded and the caller suppresses that finding.
 *
 * Hitting the URL cap is one way to be partial. The crawler records three more
 * (crawl_runs.summary), and a stopped crawl is partial by definition. Each gets
 * its own reason, so the sentence a reader sees fits the cause.
 */
function crawlCompleteness({ crawledPageCount, cap = null, crawlSummary = null, crawlStatus = null }) {
  const s = crawlSummary || {};
  let incompleteReason = null;
  if ((cap && crawledPageCount >= cap) || s.budgetReached || s.truncated) incompleteReason = 'url_cap';
  else if (crawlStatus === 'stopped') incompleteReason = 'stopped';
  else if (s.depthLimited) incompleteReason = 'depth_limit';
  else if (s.edgesTruncated) incompleteReason = 'links_truncated';
  return { capped: Boolean(incompleteReason), incompleteReason };
}

const INCOMPLETE_SENTENCES = {
  url_cap: (cap) => (cap
    ? `This crawl stopped at its ${cap}-URL cap, so it did not see the whole site. `
    : 'This crawl stopped at its URL budget, so it did not see the whole site. '),
  stopped: () => 'This crawl was stopped before it finished, so it did not see the whole site. ',
  depth_limit: () => 'This crawl reached its depth limit, so pages deeper in the site were not fetched. ',
  links_truncated: () => 'This crawl stored only part of its link graph, so some internal links are missing. ',
};

function orphanWithheldLimitation(incompleteReason, cap) {
  return (INCOMPLETE_SENTENCES[incompleteReason] || INCOMPLETE_SENTENCES.url_cap)(cap)
    + 'Orphan detection is withheld: a page with no inbound link here is almost certainly '
    + 'linked from a page the crawl never fetched. Cluster health is measured across the '
    + 'pages that WERE crawled.';
}

/**
 * The pipeline's inputs from rows already read. Pure, so every rule here is a
 * fixture away from a test — the fake DB cannot run buildFromCrawl's SQL.
 *
 * `rows` are the crawl's internal 2xx pages in crawl order, and
 * `selection.includedIdx` indexes into them. Every positional array the
 * pipeline receives (pages, graph, inboundCounts, depths) is built from that one
 * index list, so they cannot fall out of line with each other.
 */
function assembleInput({
  runId, rows, edges, selection, maxUrls = null, crawlSummary = null, crawlStatus = null,
  redirects = null,
  // When the analysed pages were found some other way than the crawl itself
  // (buildFromDiscovery): how many candidates there were and where they came
  // from, and how many pages the SITE crawl read — completeness is still a
  // question about that crawl.
  candidateCount = null, candidateSource = null, crawlPageCount = null,
}) {
  const urlOf = (r) => (r.data?.url || r.url);
  const rowIndexByUrl = new Map();
  const rowIndexByKey = new Map();
  rows.forEach((r, i) => {
    if (!rowIndexByUrl.has(urlOf(r))) rowIndexByUrl.set(urlOf(r), i);
    const key = pageKey(urlOf(r));
    if (key && !rowIndexByKey.has(key)) rowIndexByKey.set(key, i);
  });
  const aliasOf = selection.aliasOf || new Map();
  const keptIdx = (i) => (aliasOf.has(i) ? aliasOf.get(i) : i);

  // A link's URL is not always the crawled page's URL. Sites link to an old
  // path that 301s to the page, or to the http:// or no-trailing-slash spelling
  // of it; the link graph records the URL as written. Matching only the exact
  // string made those pages look unlinked — measured on a medical-device site,
  // 7 of 21 informational pages were reported as orphans while every one of
  // them was linked through a redirect. So a link target is resolved: exact
  // URL, then the same page under another spelling, then through the crawl's
  // own redirects (a few hops at most).
  const resolveRow = (url) => {
    let current = url;
    for (let hop = 0; hop < 5 && current; hop += 1) {
      if (rowIndexByUrl.has(current)) return rowIndexByUrl.get(current);
      const key = pageKey(current);
      if (key && rowIndexByKey.has(key)) return rowIndexByKey.get(key);
      current = redirects ? (redirects.get(current) || (key && redirects.get(key)) || null) : null;
    }
    return undefined;
  };

  // Distinct links between crawled pages, a duplicate spelling credited to the
  // page it duplicates. Every crawled page counts as a SOURCE, clustered or not:
  // this is the site's link graph, and an article linked only from a service
  // page is linked.
  const pairs = [];
  const seenPairs = new Set();
  const inboundFrom = new Map();
  for (const edge of edges || []) {
    const from = resolveRow(edge.from_url);
    const to = resolveRow(edge.to_url);
    if (from === undefined || to === undefined) continue;
    const f = keptIdx(from);
    const t = keptIdx(to);
    if (f === t) continue;
    const key = `${f}>${t}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    pairs.push([f, t]);
    inboundFrom.set(t, (inboundFrom.get(t) || 0) + 1);
  }

  const includedIdx = selection.includedIdx || [];
  const subIndexOf = new Map(includedIdx.map((rowIdx, k) => [rowIdx, k]));
  const pages = includedIdx.map((rowIdx) => pageFromResult(rows[rowIdx]));
  const graph = pages.map(() => new Set());
  const inboundCounts = includedIdx.map((rowIdx) => inboundFrom.get(rowIdx) || 0);
  let edgeCount = 0;
  for (const [f, t] of pairs) {
    const a = subIndexOf.get(f);
    const b = subIndexOf.get(t);
    if (a === undefined || b === undefined) continue;
    graph[a].add(b);
    edgeCount += 1;
    // hubSelection reads outboundLinks off the page to explain its choice.
    pages[a].outboundLinks.push({ href: pages[b].url });
  }

  // Crawl depth is 0 at the start URL; Content Architect counts the homepage as
  // depth 1, so shift to match — BURIED_CLICK_DEPTH (4) is calibrated to theirs.
  // Click depth where the crawl measured it. Where it did not — a page only a
  // sitemap or a listing led to — it is measured the same way, as the shortest
  // link path from the homepage, over every link known here (the crawl's, the
  // listings' and the fetched pages' own). Without this nearly every discovered
  // page had no depth, and cluster health lost its click-depth points for every
  // cluster. Unreachable stays unknown (Infinity), never guessed.
  const homeIdx = rows.findIndex((r) => {
    try { return (new URL(urlOf(r)).pathname.replace(/\/+$/, '') || '/') === '/'; } catch { return false; }
  });
  const linkDistance = new Map();
  if (homeIdx !== -1) {
    const out = new Map();
    for (const [f, t] of pairs) {
      if (!out.has(f)) out.set(f, []);
      out.get(f).push(t);
    }
    linkDistance.set(homeIdx, 0);
    let frontier = [homeIdx];
    while (frontier.length) {
      const next = [];
      for (const f of frontier) {
        for (const t of out.get(f) || []) {
          if (linkDistance.has(t)) continue;
          linkDistance.set(t, linkDistance.get(f) + 1);
          next.push(t);
        }
      }
      frontier = next;
    }
  }
  const depths = includedIdx.map((rowIdx) => {
    const depth = Number(rows[rowIdx].data?.depth);
    if (Number.isFinite(depth)) return depth + 1;
    return linkDistance.has(rowIdx) ? linkDistance.get(rowIdx) + 1 : Infinity;
  });

  const cap = Number(maxUrls) || null;
  const { capped, incompleteReason } = crawlCompleteness({
    crawledPageCount: crawlPageCount ?? rows.length, cap, crawlSummary, crawlStatus,
  });
  const hasLinkGraph = pairs.length > 0;
  const consideredCount = candidateCount ?? rows.length;

  const limitations = [
    `Only informational pages (articles, guides, FAQs and the like) were clustered: ${pages.length} of the `
    + `${consideredCount} ${candidateSource || 'pages the crawl read'}. Every other page is listed with the reason it was left out.`,
    'Published and modified dates are not recorded by the crawler, so pages cannot be judged stale — only thin.',
    'JSON-LD schema types are not carried over from the crawl.',
    ...((selection.summary && selection.summary.limitations) || []),
  ];
  if (!hasLinkGraph) {
    limitations.push(
      'This crawl stored no internal link graph (crawls predating migration 0012 did not), '
      + 'so link density, orphan detection and the link boost had nothing to work with. Re-crawl to fix.',
    );
  }
  if (capped) limitations.push(orphanWithheldLimitation(incompleteReason, cap));

  return {
    crawlResult: {
      pages,
      excluded: selection.excluded || [],
      // Stored with the analysis: what a reader sees about the selection, and
      // the verdict cache the next run reads back.
      selection: persistableSelection(selection),
      sampled: false,
      sampleSize: pages.length,
      budgetHit: false,
      abortedForFailureRate: false,
      crawlMode: 'crawlscope',
    },
    // Supplied so the pipeline skips its own link-graph pass, whose only network
    // call is a homepage fetch to seed depths we already have.
    linkGraph: { graph, inboundCounts, depths },
    meta: {
      runId,
      // The pages clustered, and the pages the crawl read.
      pageCount: pages.length,
      crawledPageCount: consideredCount,
      // Links between clustered pages (what the link boost and hub scoring
      // used), links between any two crawled pages, and every link the crawl
      // stored. Most of a capped crawl's edges point at pages it never fetched,
      // so the gaps between these numbers are expected — and worth showing.
      edgeCount,
      fullEdgeCount: pairs.length,
      edgesStored: (edges || []).length,
      hasLinkGraph,
      // Whether the crawl covered the whole site. Only a complete crawl can
      // support a claim that a page has no inbound links.
      capped,
      incompleteReason,
      urlCap: cap,
      complete: Boolean(cap) && !capped,
    },
    limitations,
    selection,
  };
}

/**
 * Builds the pipeline's inputs from one stored crawl — its informational pages
 * only (see the note at the top of this file).
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {number} [opts.maxUrls]          the crawl's URL cap
 * @param {object} [opts.crawlSummary]     crawl_runs.summary
 * @param {string} [opts.crawlStatus]      crawl_runs.status
 * @param {object} [opts.selectionCache]   the previous analysis's selection verdicts
 * @param {object|null} [opts.classifier]  injected by tests; the real one otherwise
 * @returns {Promise<object>} one of
 *   { tooSmall, pageCount, minimum } — the crawl itself read too few pages;
 *   { tooFewInformational, pageCount, crawledPageCount, minimum, selection, meta };
 *   { crawlResult, linkGraph, meta, limitations, selection } — ready for the pipeline.
 */
async function buildFromCrawl(runId, {
  maxUrls = null, crawlSummary = null, crawlStatus = null, selectionCache = null, classifier,
} = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  // Internal pages only: an external URL was status-checked, not read, so it has
  // no title or body to cluster on.
  const results = await fetchAll(
    `select id, url, status, data from crawl_run_results
      where run_id = $1 and data->>'scope' = 'Internal'
      order by id asc`,
    [runId],
    { label: 'results' },
  );

  const rows = results.filter((r) => {
    const d = r.data || {};
    // Assets carry no clusterable content, and a page that never returned 200
    // has nothing to read.
    if (d.isAsset) return false;
    const status = Number(d.status ?? r.status);
    return !Number.isFinite(status) || (status >= 200 && status < 300);
  });

  if (rows.length < MIN_PAGES_TO_ANALYZE) {
    return {
      tooSmall: true,
      pageCount: rows.length,
      minimum: MIN_PAGES_TO_ANALYZE,
    };
  }

  // Which of those pages are informational. The classifier is null without an
  // API key, and selection then runs on its URL rules and says so.
  const selection = await selectInformationalPages(rows.map(candidateFromRow), {
    classifier: classifier === undefined ? createInformationalClassifier() : classifier,
    cache: selectionCache,
  });

  // Too few to cluster. Said before the link graph is read, since nothing below
  // would use it.
  if (selection.includedIdx.length < MIN_INFORMATIONAL_PAGES) {
    const cap = Number(maxUrls) || null;
    const { capped, incompleteReason } = crawlCompleteness({
      crawledPageCount: rows.length, cap, crawlSummary, crawlStatus,
    });
    return {
      tooFewInformational: true,
      pageCount: selection.includedIdx.length,
      crawledPageCount: rows.length,
      minimum: MIN_INFORMATIONAL_PAGES,
      selection,
      meta: { capped, incompleteReason, urlCap: cap },
    };
  }

  // The link graph, straight from stored edges. Depths come from the crawl's own
  // record of how far each page was from the start URL, so nothing is re-fetched
  // to work them out.
  const edges = await fetchAll(
    `select id, from_url, to_url from crawl_run_links
      where run_id = $1
      order by id asc`,
    [runId],
    { label: 'links' },
  );

  return assembleInput({
    runId, rows, edges, selection, maxUrls, crawlSummary, crawlStatus, redirects: redirectMap(results),
  });
}

/**
 * Builds the pipeline's inputs from the site's own declared content — its
 * sitemaps and the listing pages its menus link to (informationalDiscovery.js)
 * — rather than from whatever the site crawl reached. The crawl is still read,
 * for the two things only it knows: who links to whom, and whether it saw the
 * whole site.
 *
 * Order: read the crawl's pages and links; discover candidates; judge them
 * from their URLs (informationalSelection.js); fetch only the informational
 * ones; drop any that turn out noindex, canonicalised elsewhere, redirected or
 * unreadable once read; assemble.
 *
 * @returns {Promise<object>} the same shapes as buildFromCrawl, minus tooSmall
 */
async function buildFromDiscovery(runId, {
  origin, maxUrls = null, crawlSummary = null, crawlStatus = null, selectionCache = null, classifier,
  discover = discoverInformationalCandidates, fetch = fetchPages, maxFetch = DISCOVERY_MAX_FETCH,
} = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const results = await fetchAll(
    `select id, url, status, data from crawl_run_results
      where run_id = $1 and data->>'scope' = 'Internal'
      order by id asc`,
    [runId],
    { label: 'results' },
  );
  const crawlRows = results.filter((r) => {
    const d = r.data || {};
    if (d.isAsset) return false;
    const status = Number(d.status ?? r.status);
    return !Number.isFinite(status) || (status >= 200 && status < 300);
  });
  const edges = await fetchAll(
    `select id, from_url, to_url from crawl_run_links
      where run_id = $1
      order by id asc`,
    [runId],
    { label: 'links' },
  );
  const crawlByKey = new Map();
  for (const r of crawlRows) {
    const key = pageKey(r.data?.url || r.url);
    if (key && !crawlByKey.has(key)) crawlByKey.set(key, r);
  }

  // 1. Candidates: sitemaps, then informational listings from the menus.
  const discovery = await discover(origin);
  const candidates = discovery.candidates.map((c) => ({
    url: c.url,
    canonical: null,
    indexability: null,
    // Where the crawl measured it, so the URL check spends a cap on the
    // best-linked pages first.
    inlinks: Number(crawlByKey.get(pageKey(c.url))?.data?.inlinks) || 0,
  }));

  // 2. Which of them are informational, judged from their URLs.
  const selection = await selectInformationalPages(candidates, {
    classifier: classifier === undefined ? createInformationalClassifier() : classifier,
    cache: selectionCache,
    hints: discovery.hints,
  });

  // 3. Read only those pages. Under the per-run limit, the pages the site
  // itself puts forward come first: those its own listings show, then the
  // best-linked. (One SaaS site had ~6,400 informational candidates; in sitemap
  // order the first 800 read were an arbitrary slice.)
  const listed = new Set(discovery.candidates.filter((c) => c.sources.includes('listing')).map((c) => pageKey(c.url)));
  const chosen = selection.includedIdx
    .map((i) => candidates[i])
    .sort((a, b) => (listed.has(pageKey(b.url)) - listed.has(pageKey(a.url)))
      || (b.inlinks - a.inlinks)
      || String(a.url).localeCompare(String(b.url)))
    .map((c) => c.url);
  const toFetch = chosen.slice(0, maxFetch);
  const overCap = chosen.slice(maxFetch);
  const fetched = await fetchFollowingRedirects(toFetch, fetch, origin);
  const fetchedByKey = fetched.byKey;

  // 4. What reading them showed: the technical checks the URL alone could not.
  const keptRows = [];
  const lateExclusions = [];
  const exclude = (url, code, detail = null) => lateExclusions.push({
    url, code, reason: REASON_LABELS[code] || code, detail, source: 'fetch',
  });
  const keptKeys = new Set();
  for (const url of toFetch) {
    const r = fetchedByKey.get(pageKey(url));
    const status = Number(r?.status);
    // Two listed URLs that land on one page are one page.
    if (r && status >= 200 && status < 300 && keptKeys.has(pageKey(r.url))) {
      exclude(url, 'duplicate', `Same page as ${r.url}`);
      continue;
    }
    if (!r) { exclude(url, 'fetch_failed'); continue; }
    if (status >= 300 && status < 400) { exclude(url, 'redirected', r.redirectUrl ? `Redirects to ${r.redirectUrl}` : null); continue; }
    if (!(status >= 200 && status < 300)) { exclude(url, 'fetch_failed', status ? `HTTP ${status}` : (r.bodyError || null)); continue; }
    if (r.contentType && !/html/i.test(r.contentType)) { exclude(url, 'not_html', r.contentType); continue; }
    if (String(r.indexability || '').toLowerCase() === 'non-indexable') { exclude(url, 'not_indexable', r.indexabilityReason || null); continue; }
    const canonicalKey = r.canonical ? pageKey(r.canonical) : null;
    if (canonicalKey && canonicalKey !== pageKey(r.url)) {
      const toHome = (() => { try { return (new URL(r.canonical).pathname.replace(/\/+$/, '') || '/') === '/'; } catch { return false; } })();
      exclude(url, toHome ? 'canonical_to_homepage' : 'canonical_elsewhere', `Canonical: ${r.canonical}`);
      continue;
    }
    // Depth is the crawl's click depth where the crawl reached the page; a page
    // only a sitemap or listing led to has none, and none is claimed.
    const crawlMatch = crawlByKey.get(pageKey(r.url));
    keptKeys.add(pageKey(r.url));
    keptRows.push({ url: r.url, status: r.status, data: { ...r, scope: 'Internal', depth: crawlMatch ? crawlMatch.data?.depth : undefined } });
  }
  for (const url of overCap) exclude(url, 'fetch_cap');

  const excluded = [...selection.excluded, ...lateExclusions];
  const byReason = new Map();
  for (const e of excluded) byReason.set(e.code, (byReason.get(e.code) || 0) + 1);
  const limitations = [
    ...discovery.limitations,
    ...(fetched.redirected ? [`${fetched.redirected} listed URL(s) redirect to another address (for example a missing trailing slash); the page each lands on was read instead. A sitemap should list final URLs.`] : []),
    ...(overCap.length ? [`${overCap.length} informational page(s) were not read this run: the per-run limit is ${maxFetch} pages.`] : []),
    ...((selection.summary && selection.summary.limitations) || []),
  ];
  const summary = {
    ...selection.summary,
    analysedPageCount: keptRows.length,
    excludedByReason: [...byReason.entries()]
      .map(([code, count]) => ({ code, label: REASON_LABELS[code] || code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    limitations,
    discovery: {
      sitemap: discovery.sitemap,
      menu: discovery.menu,
      listings: discovery.listings,
      candidates: candidates.length,
      fromSitemap: discovery.candidates.filter((c) => c.sources.includes('sitemap')).length,
      fromListings: discovery.candidates.filter((c) => c.sources.includes('listing') && !c.sources.includes('sitemap')).length,
    },
  };
  const finalSelection = { ...selection, excluded, summary };

  const cap = Number(maxUrls) || null;
  if (keptRows.length < MIN_INFORMATIONAL_PAGES) {
    const { capped, incompleteReason } = crawlCompleteness({
      crawledPageCount: crawlRows.length, cap, crawlSummary, crawlStatus,
    });
    return {
      tooFewInformational: true,
      pageCount: keptRows.length,
      crawledPageCount: candidates.length,
      minimum: MIN_INFORMATIONAL_PAGES,
      selection: finalSelection,
      meta: { capped, incompleteReason, urlCap: cap, noSitemap: !discovery.sitemap?.count },
    };
  }

  // Listing pages link to every page they list; they count as link sources
  // even where the site crawl never fetched them.
  const known = new Set([...keptRows, ...crawlRows].map((r) => pageKey(r.data?.url || r.url)));
  const listingRows = [];
  // Every page walked, pagination included — a post first listed on page 7 is
  // linked from page 7.
  const walkedPages = discovery.listingPages || (discovery.listings || []).map((l) => l.url);
  for (const url of walkedPages) {
    const key = pageKey(url);
    if (key && !known.has(key)) { known.add(key); listingRows.push({ url, data: { url } }); }
  }

  const rows = [...keptRows, ...crawlRows, ...listingRows];
  const allEdges = [
    ...edges,
    ...(fetched.linkEdges || []).map((e) => ({ from_url: e.sourceUrl, to_url: e.targetUrl })),
    ...(discovery.listingEdges || []),
  ];
  return assembleInput({
    runId,
    rows,
    edges: allEdges,
    selection: { ...finalSelection, includedIdx: keptRows.map((_, i) => i), aliasOf: new Map() },
    maxUrls,
    crawlSummary,
    crawlStatus,
    redirects: redirectMap(results),
    candidateCount: candidates.length,
    candidateSource: 'pages found in its sitemaps and informational listings',
    crawlPageCount: crawlRows.length,
  });
}

/**
 * Fetches pages, following same-site redirects to the page each URL lands on.
 *
 * The crawler's list mode records a 301 and stops. Sitemaps very often list the
 * redirecting spelling — measured: one publisher's sitemap listed every article
 * without its trailing slash, so all 800 pages fetched came back "redirects" and
 * nothing was analysed. Each same-site target is fetched in a further pass (up
 * to three hops), and the ORIGINAL url maps to the final page.
 *
 * @returns {Promise<{byKey: Map<string, object>, linkEdges: Array, redirected: number}>}
 */
async function fetchFollowingRedirects(urls, fetch, origin, { maxHops = 3 } = {}) {
  const byKey = new Map();
  const linkEdges = [];
  let redirected = 0;
  if (!urls.length) return { byKey, linkEdges, redirected };

  const sameSite = (u) => {
    try { return new URL(u).host.replace(/^www\./, '') === new URL(origin).host.replace(/^www\./, ''); } catch { return false; }
  };
  // Keyed by the EXACT url: pageKey deliberately treats /a and /a/ as one page,
  // which is precisely the redirect this has to see.
  const exact = (u) => String(u || '').split('#')[0];
  const resultByKey = new Map();
  let pending = [...urls];
  for (let hop = 0; hop <= maxHops && pending.length; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    const out = await fetch(pending);
    // A loop, not push(...array): 800 fetched articles carry hundreds of
    // thousands of links, and spreading them as arguments overflowed the stack.
    for (const edge of out.linkEdges || []) linkEdges.push(edge);
    for (const r of out.results || []) {
      const key = exact(r.url);
      if (key && !resultByKey.has(key)) resultByKey.set(key, r);
    }
    const next = [];
    for (const url of pending) {
      const r = resultByKey.get(exact(url));
      const status = Number(r?.status);
      const target = r && status >= 300 && status < 400 ? (r.redirectUrl || r.finalUrl) : null;
      if (target && sameSite(target) && !resultByKey.has(exact(target)) && hop < maxHops) next.push(target);
    }
    pending = [...new Set(next)];
  }

  // Each requested url resolves through its redirects to the page it lands on.
  for (const url of urls) {
    let r = resultByKey.get(exact(url));
    let hops = 0;
    while (r && Number(r.status) >= 300 && Number(r.status) < 400 && hops < maxHops) {
      const target = r.redirectUrl || r.finalUrl;
      const landed = target && sameSite(target) ? resultByKey.get(exact(target)) : null;
      if (!landed || landed === r) break;
      r = landed;
      hops += 1;
    }
    if (hops) redirected += 1;
    if (r) byKey.set(pageKey(url), r);
  }
  return { byKey, linkEdges, redirected };
}

// Where each redirecting internal URL the crawl fetched leads, keyed by its
// exact URL and by its page key. Built from the rows the page filter above
// drops, so a link to an old path is credited to the page it now lands on.
function redirectMap(results) {
  const map = new Map();
  for (const r of results) {
    const d = r.data || {};
    const status = Number(d.status ?? r.status);
    if (!(status >= 300 && status < 400)) continue;
    const from = d.url || r.url;
    const to = d.redirectUrl || (d.finalUrl && d.finalUrl !== from ? d.finalUrl : null);
    if (!from || !to || to === from) continue;
    map.set(from, to);
    const key = pageKey(from);
    if (key && !map.has(key)) map.set(key, to);
  }
  return map;
}

module.exports = {
  MIN_PAGES_TO_ANALYZE,
  HEADING_SEPARATOR,
  pageFromResult,
  decodeLeftoverEntities,
  candidateFromRow,
  crawlCompleteness,
  assembleInput,
  redirectMap,
  latestCompletedCrawl,
  buildFromCrawl,
  buildFromDiscovery,
  fetchFollowingRedirects,
};
