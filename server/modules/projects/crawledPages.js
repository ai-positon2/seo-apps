// ── The pages of a project's latest crawl ────────────────────────────────────
//
// One definition of "this project's pages", shared by every module that audits
// them. Without it each module would answer the question slightly differently
// and two cards would disagree about how many pages the site has.
//
// A page qualifies when the crawl reached it, it is on this site, it returned a
// 2xx, and it is not an asset. Everything else is excluded for a stated reason
// rather than filtered out silently.

const { getSupabase, isSupabaseConfigured } = require('../../services/supabase');
const adminLimits = require('../../services/adminLimits');

// PostgREST caps a response at its configured maximum whatever .limit() asks
// for, so bulk reads page through. Learned the hard way: a single-shot read of a
// crawl's link graph returned 4 of 316 usable rows, silently.
const PAGE_SIZE = 1000;

function notConfigured() {
  return Object.assign(
    new Error('Reading crawled pages needs Supabase configured.'),
    { status: 503, code: 'not_configured' },
  );
}

async function fetchAll(build, label) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`[crawledPages.${label}] ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** The newest completed crawl for a project, or null. */
async function latestCompletedCrawl(projectId) {
  if (!isSupabaseConfigured()) throw notConfigured();
  const { data, error } = await getSupabase()
    .from('crawl_runs')
    .select('id, status, finished_at, created_at, options')
    .eq('project_id', projectId)
    .in('status', ['completed', 'stopped'])
    .order('finished_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`[crawledPages.latestCompletedCrawl] ${error.message}`);
  return (data || [])[0] || null;
}

/**
 * One spelling per page, so an edge's target matches a crawled page.
 *
 * The link graph stores hrefs as resolved from the markup, which vary in ways
 * that do not make a different page: a fragment, a trailing slash, casing of the
 * host. Left unnormalised the join misses and every page looks unlinked.
 */
function canonicalKey(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '/';
    return `${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return String(url);
  }
}

/**
 * How many DISTINCT pages of the site link to each page.
 *
 * The crawl's own `data.inlinks` field is 0 on every row — it is not populated —
 * so the crawler's stored link graph is the only real measure of which pages the
 * site itself treats as important. Distinct sources rather than edges: one page
 * linking to another five times in a mega-menu is one page's worth of intent.
 *
 * Returns an empty Map when there is no graph, which the caller reads as
 * "no signal" rather than "every page has zero inbound links".
 */
async function inboundCounts(runId) {
  const edges = await fetchAll(
    () => getSupabase()
      .from('crawl_run_links')
      .select('from_url, to_url')
      .eq('run_id', runId)
      .order('id', { ascending: true }),
    'links',
  );

  const sources = new Map();
  for (const edge of edges) {
    const to = canonicalKey(edge.to_url);
    const from = canonicalKey(edge.from_url);
    if (!to || !from || to === from) continue;  // a self-link is not a vote
    if (!sources.has(to)) sources.set(to, new Set());
    sources.get(to).add(from);
  }

  const counts = new Map();
  for (const [url, from] of sources) counts.set(url, from.size);
  return counts;
}

/** How far a URL's path is from the root, as a tiebreak of last resort. */
function pathSegments(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 99;
  }
}

/**
 * Which pages to audit, and in what order.
 *
 * Ordered by crawl depth, then by how many pages of the site link to it, then by
 * how near the root its path is. When a budget cuts the list short this ordering
 * decides what gets audited, so it has to be defensible — and on a real site the
 * first two keys are often not enough on their own: a sitemap-fed crawl puts
 * nearly every page at depth 1, which left the earlier version of this function
 * choosing 9 of 49 pages by row id.
 *
 * @param {Array} rows      crawl_run_results rows
 * @param {Map}   [inbound] canonicalKey -> distinct linking pages
 */
function auditOrder(rows, inbound = null) {
  // One source for the whole run, not per row. The crawl's own field and the
  // link graph are different measurements, and a page missing from the graph
  // falling back to a stale non-zero field would outrank a page the graph
  // actually counted — comparing 20 measured inbound links against 99 from a
  // field nothing populates.
  const useGraph = Boolean(inbound && inbound.size);
  const linkedFrom = (row) => (useGraph
    ? (inbound.get(canonicalKey(row.data?.url || row.url)) || 0)
    : (Number(row.data?.inlinks) || 0));

  return [...rows].sort((a, b) => {
    const depthA = Number(a.data?.depth);
    const depthB = Number(b.data?.depth);
    const da = Number.isFinite(depthA) ? depthA : 99;
    const db = Number.isFinite(depthB) ? depthB : 99;
    if (da !== db) return da - db;

    const la = linkedFrom(a);
    const lb = linkedFrom(b);
    if (la !== lb) return lb - la;

    const urlA = a.data?.url || a.url || '';
    const urlB = b.data?.url || b.url || '';
    const sa = pathSegments(urlA);
    const sb = pathSegments(urlB);
    if (sa !== sb) return sa - sb;

    // Alphabetical last, so the same crawl always yields the same audit set.
    return String(urlA).localeCompare(String(urlB));
  });
}

/**
 * @param {string} projectId
 * @param {object} [opts]
 * @param {number} [opts.limit]       how many pages may be audited
 * @param {string} [opts.workspaceId] for the effective admin limit
 * @returns {Promise<object>} {
 *   crawl, pages, crawledCount, skipped, limit, capped, excluded, linkGraph
 * }
 *   `pages` are [{ url, depth, inlinks, title, ordinal }] in audit order.
 */
async function listCrawledPages(projectId, { limit = null, workspaceId = null } = {}) {
  if (!isSupabaseConfigured()) throw notConfigured();

  const crawl = await latestCompletedCrawl(projectId);
  if (!crawl) {
    return {
      crawl: null, pages: [], crawledCount: 0, skipped: 0,
      limit: null, capped: false, crawlCapped: null, crawlLimit: null,
      excluded: {}, linkGraph: false,
    };
  }

  const [rows, inbound] = await Promise.all([
    fetchAll(
      () => getSupabase()
        .from('crawl_run_results')
        .select('url, status, data')
        .eq('run_id', crawl.id)
        .eq('data->>scope', 'Internal')
        .order('id', { ascending: true }),
      'results',
    ),
    inboundCounts(crawl.id),
  ]);

  // Counted, not just dropped: "50 pages crawled, 6 audited" needs the 44 to be
  // accountable.
  const excluded = { asset: 0, notOk: 0, noUrl: 0 };
  const usable = rows.filter((r) => {
    const d = r.data || {};
    if (!(d.url || r.url)) { excluded.noUrl += 1; return false; }
    if (d.isAsset) { excluded.asset += 1; return false; }
    const status = Number(d.status ?? r.status);
    if (Number.isFinite(status) && (status < 200 || status >= 300)) { excluded.notOk += 1; return false; }
    return true;
  });

  const budget = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : (await adminLimits.limit('maxPagesPerModuleAudit', { workspaceId })) || usable.length;

  // ── Did the CRAWL stop short, as opposed to the audit budget? ────────────
  //
  // Two different questions that were both called "capped":
  //
  //   capped       the audit budget truncated the ranked list — "we could audit
  //                more of what we have"
  //   crawlCapped  the crawler stopped at its own maxUrls — "there are pages we
  //                never looked at"
  //
  // Only the second one means a page's absence proves nothing, which is what
  // project_pages retirement turns on. Reading the first for the second silently
  // inverted that guard: syncFromCrawl asks for an unlimited budget, so `capped`
  // is false by construction there, and retirement went ahead on a crawl that had
  // demonstrably stopped at 50 of an unknown number of URLs.
  //
  // null, not false, when the run does not record a usable maxUrls: "we cannot
  // tell" is a third answer, and the caller must not read it as "not capped".
  const maxUrls = Number(crawl.options?.maxUrls);
  const crawlCapped = Number.isFinite(maxUrls) && maxUrls > 0
    ? rows.length >= maxUrls
    : null;

  const ordered = auditOrder(usable, inbound);
  const pages = ordered.slice(0, budget).map((r, i) => {
    const url = r.data?.url || r.url;
    const depth = Number(r.data?.depth);
    return {
      url,
      // Number(undefined) is NaN, and NaN ?? null is NaN — an unknown depth has
      // to be an explicit null or it travels as a number that is not one.
      depth: Number.isFinite(depth) ? depth : null,
      // Same source the ordering used, so the number shown explains the order.
      inlinks: inbound.size
        ? (inbound.get(canonicalKey(url)) || 0)
        : (Number(r.data?.inlinks) || 0),
      title: r.data?.title || null,
      ordinal: i,
    };
  });

  return {
    crawl,
    pages,
    crawledCount: usable.length,
    skipped: Math.max(0, ordered.length - pages.length),
    limit: budget,
    capped: ordered.length > pages.length,
    // The crawler's own ceiling. See the note above for why this is not `capped`.
    crawlCapped,
    crawlLimit: Number.isFinite(maxUrls) && maxUrls > 0 ? maxUrls : null,
    excluded,
    // Whether the ordering had a real importance signal to work with.
    linkGraph: inbound.size > 0,
  };
}

/**
 * Crawled pages with their on-page text signals, in the same audit order
 * `listCrawledPages` uses — one file keeps knowing the `crawl_run_results.data`
 * shape, so a caller does not have to learn that the crawler stores `words`
 * rather than `wordCount`, or that `h1`/`h2` are pipe-joined strings.
 *
 * Unlike `listCrawledPages`, `limit` here has NOTHING to do with
 * `maxPagesPerModuleAudit` — that budget governs a per-page AUDIT run, and
 * reading page titles for prompt grounding is a different, much cheaper
 * operation. Pass `limit` explicitly, or the default below applies; there is
 * no admin-limit fallback to silently narrow it to 10.
 *
 * @param {string} projectId
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @returns {Promise<Array<{url, title, h1, h2, metaDescription, wordCount, depth, inlinks}>>}
 */
async function listPageContent(projectId, { limit = 60 } = {}) {
  if (!isSupabaseConfigured()) throw notConfigured();

  const crawl = await latestCompletedCrawl(projectId);
  if (!crawl) return [];

  const [rows, inbound] = await Promise.all([
    fetchAll(
      () => getSupabase()
        .from('crawl_run_results')
        .select('url, status, data')
        .eq('run_id', crawl.id)
        .eq('data->>scope', 'Internal')
        .order('id', { ascending: true }),
      'pageContent',
    ),
    inboundCounts(crawl.id),
  ]);

  const usable = rows.filter((r) => {
    const d = r.data || {};
    if (!(d.url || r.url)) return false;
    if (d.isAsset) return false;
    const status = Number(d.status ?? r.status);
    if (Number.isFinite(status) && (status < 200 || status >= 300)) return false;
    return true;
  });

  return auditOrder(usable, inbound).slice(0, limit).map((r) => {
    const d = r.data || {};
    const url = d.url || r.url;
    const depth = Number(d.depth);
    return {
      url,
      title: d.title || null,
      h1: d.h1 || null,
      h2: d.h2 || null,
      metaDescription: d.metaDescription || null,
      wordCount: Number.isFinite(Number(d.words)) ? Number(d.words) : null,
      depth: Number.isFinite(depth) ? depth : null,
      inlinks: inbound.size ? (inbound.get(canonicalKey(url)) || 0) : (Number(d.inlinks) || 0),
    };
  });
}

module.exports = {
  listCrawledPages,
  listPageContent,
  latestCompletedCrawl,
  auditOrder,
  inboundCounts,
  canonicalKey,
  PAGE_SIZE,
};
