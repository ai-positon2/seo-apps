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

const { getSupabase, isSupabaseConfigured } = require('../../services/supabase');

// CrawlScope joins H2/H3 text with this separator when it stores a result.
const HEADING_SEPARATOR = ' | ';

// A crawl of a handful of pages cannot be clustered meaningfully: MIN_CLUSTER_SIZE
// is 3, so below this there is nothing for the pipeline to find.
const MIN_PAGES_TO_ANALYZE = 5;

// PostgREST caps every response at its server-configured maximum (1,000 rows
// here) NO MATTER what .limit() asks for. An unpaginated read of a big table
// therefore returns a silently truncated slice: measured on a real 50-page crawl,
// reading the link graph in one call saw 4 usable edges where 316 existed,
// because the first thousand rows were all outbound links from the homepage.
//
// Worse, the same flaw applied to the pages themselves — any crawl over 1,000
// URLs would have been clustered from a fraction of its pages, with no error and
// a plausible-looking result. So every bulk read here pages through explicitly.
const PAGE_SIZE = 1000;

async function fetchAll(build, { label, cap = 500000 }) {
  const rows = [];
  for (let from = 0; from < cap; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`[crawlToArchitect.${label}] ${error.message}`);
    if (!data || !data.length) break;
    rows.push(...data);
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
    new Error('Reading a crawl needs Supabase configured.'),
    { status: 503, code: 'not_configured' },
  );
}

/** The newest completed crawl for a project, or null. */
async function latestCompletedCrawl(projectId) {
  if (!isSupabaseConfigured()) throw notConfigured();
  const { data, error } = await getSupabase()
    .from('crawl_runs')
    .select('id, status, finished_at, created_at, summary, options')
    .eq('project_id', projectId)
    .in('status', ['completed', 'stopped'])
    .order('finished_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`[crawlToArchitect.latestCompletedCrawl] ${error.message}`);
  return (data || [])[0] || null;
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
    title: d.title || null,
    h1: d.h1 || null,
    // Stored as one separator-joined string; the pipeline wants the array back.
    h2s: d.h2 ? String(d.h2).split(HEADING_SEPARATOR).map((h) => h.trim()).filter(Boolean) : [],
    metaDescription: d.metaDescription || null,
    // CrawlScope keeps a 240-character visible-text sample rather than the first
    // paragraph proper. It carries the lowest term weight of any field (0.5), so
    // the approximation costs little.
    firstParagraph: d.contentSample || null,
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

/**
 * Builds the pipeline's inputs from one stored crawl.
 *
 * @returns {Promise<object|null>} { crawlResult, linkGraph, meta, limitations }
 *   or null when the crawl stored too little to analyse.
 */
async function buildFromCrawl(runId, { maxUrls = null } = {}) {
  if (!isSupabaseConfigured()) throw notConfigured();
  const db = getSupabase();

  // Internal pages only: an external URL was status-checked, not read, so it has
  // no title or body to cluster on.
  const results = await fetchAll(
    () => db.from('crawl_run_results')
      .select('url, status, data')
      .eq('run_id', runId)
      .eq('data->>scope', 'Internal')
      .order('id', { ascending: true }),
    { label: 'results' },
  );

  const rows = (results || []).filter((r) => {
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

  const pages = rows.map(pageFromResult);
  const indexByUrl = new Map(pages.map((p, i) => [p.url, i]));

  // The link graph, straight from stored edges. Depths come from the crawl's own
  // record of how far each page was from the start URL, so nothing is re-fetched
  // to work them out.
  const edges = await fetchAll(
    () => db.from('crawl_run_links')
      .select('from_url, to_url')
      .eq('run_id', runId)
      .order('id', { ascending: true }),
    { label: 'links' },
  );

  const graph = pages.map(() => new Set());
  const inboundCounts = new Array(pages.length).fill(0);
  let edgesUsed = 0;

  for (const edge of edges || []) {
    const from = indexByUrl.get(edge.from_url);
    const to = indexByUrl.get(edge.to_url);
    if (from === undefined || to === undefined || from === to) continue;
    if (!graph[from].has(to)) {
      graph[from].add(to);
      inboundCounts[to] += 1;
      edgesUsed += 1;
    }
    // hubSelection reads outboundLinks off the page to explain its choice.
    pages[from].outboundLinks.push({ href: edge.to_url });
  }

  // Crawl depth is 0 at the start URL; Content Architect counts the homepage as
  // depth 1, so shift to match — BURIED_CLICK_DEPTH (4) is calibrated to theirs.
  const depths = rows.map((r) => {
    const depth = Number(r.data?.depth);
    return Number.isFinite(depth) ? depth + 1 : Infinity;
  });

  // Did the crawl see the whole site, or stop at its URL cap?
  //
  // This decides whether "no inbound links" means anything. On a capped crawl
  // most pages are reached from the sitemap rather than from a fetched page, so
  // their linking page was never read — measured on a 50-URL crawl of a large
  // site, 40 of 50 pages had no in-set inbound link and NONE of them was an
  // orphan. Reporting them as orphans would be a false statement about the site,
  // so completeness is recorded and the caller suppresses that finding.
  const cap = Number(maxUrls) || null;
  const capped = Boolean(cap && pages.length >= cap);

  const limitations = [
    'Published and modified dates are not recorded by the crawler, so pages cannot be judged stale — only thin.',
    'JSON-LD schema types are not carried over from the crawl.',
  ];
  if (!edgesUsed) {
    limitations.push(
      'This crawl stored no internal link graph (crawls predating migration 0012 did not), '
      + 'so link density, orphan detection and the link boost had nothing to work with. Re-crawl to fix.',
    );
  }
  if (capped) {
    limitations.push(
      `This crawl stopped at its ${cap}-URL cap, so it did not see the whole site. `
      + 'Orphan detection is withheld: a page with no inbound link here is almost certainly '
      + 'linked from a page the crawl never fetched. Cluster health is measured across the '
      + 'pages that WERE crawled.',
    );
  }

  return {
    crawlResult: {
      pages,
      excluded: [],
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
      pageCount: pages.length,
      // Distinct in-set edges, and how many the crawl stored in total. Most of a
      // capped crawl's edges point at pages it never fetched, so the gap between
      // these two numbers is expected — and worth showing rather than hiding.
      edgeCount: edgesUsed,
      edgesStored: (edges || []).length,
      hasLinkGraph: edgesUsed > 0,
      // Whether the crawl covered the whole site. Only a complete crawl can
      // support a claim that a page has no inbound links.
      capped,
      urlCap: cap,
      complete: Boolean(cap) && !capped,
    },
    limitations,
  };
}

module.exports = {
  MIN_PAGES_TO_ANALYZE,
  HEADING_SEPARATOR,
  pageFromResult,
  latestCompletedCrawl,
  buildFromCrawl,
};
