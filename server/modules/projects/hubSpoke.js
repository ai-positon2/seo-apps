// ── Hub-and-spoke clustering from a crawl link graph — NOT WIRED IN ──────────
//
// UNREFERENCED. The "Hub and Spoke" card is served by the Content Architect
// module instead (see moduleRunners.js runHubSpoke), which already does this
// analysis properly: it clusters by topic similarity with a link boost, names the
// clusters, selects hubs, and scores cluster health.
//
// This file computed a simpler structural version from crawl_run_links. Keeping
// two implementations of one idea is what §32's "prefer service extraction over
// parallel replacement" rules out, so nothing calls this. It is left in the tree
// only because its tests document the structural approach; delete both when you
// are sure you do not want it.
//
// Reads the internal link graph a crawl already recorded (crawl_run_links,
// migration 0012) and reports how the site's internal linking is organised:
// which pages act as hubs, which clusters exist, which pages are orphaned, and
// where a hub links out without being linked back to.
//
// Two constraints shape this file:
//
//   • It NEVER fetches anything. §32 forbids re-crawling inside an audit
//     module, and everything here is derivable from stored edges. If a project's
//     crawls predate migration 0012, the honest answer is "no graph stored yet",
//     not a fresh crawl.
//
//   • It produces NO score. Whether a site's internal linking is "78/100" would
//     be a scoring methodology invented here, which §6.2 rules out. It reports
//     structure and named findings; the composite leaves it out rather than
//     averaging in a number nobody can defend.
//
// The clustering is deliberately simple and explainable: a hub is a page whose
// outbound internal links exceed a threshold, a spoke belongs to the hub that
// links to it, and everything else is unclustered. A community-detection
// algorithm would produce prettier groups and no way to answer "why is this page
// in that cluster".

// A page needs at least this many outbound internal links to be called a hub.
// Below it, a page linking to two or three others is just a page.
const HUB_MIN_OUTLINKS = 5;

// A hub that links to almost everything is navigation (header, footer, sitemap
// page), not a topic hub. Expressed as a share of all crawled pages.
const NAV_LINK_SHARE = 0.6;

// The navigation test needs enough pages to be meaningful. On a nine-page site a
// hub linking to five pages IS the structure, not a nav bar — and applying the
// share test there reclassified every legitimate hub as navigation, leaving no
// clusters at all. Below this, a hub is judged only by HUB_MIN_OUTLINKS.
const MIN_PAGES_FOR_NAV_TEST = 10;

/** Strips the scheme and trailing slash so /a and /a/ are one page. */
function pathKey(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.host}${path}`;
  } catch {
    return String(url || '').replace(/\/+$/, '');
  }
}

/**
 * Builds the hub-and-spoke structure from stored edges.
 *
 * @param {Array} edges  [{ from_url, to_url, anchor, nofollow }]
 * @param {Array} pages  every crawled internal URL, so orphans can be found —
 *                       a page nothing links to has no edge to appear in, and
 *                       is invisible if you only look at the graph.
 * @returns {object} the structure plus normalised findings
 */
function analyze(edges = [], pages = []) {
  const pageSet = new Set(pages.map(pathKey));
  const outbound = new Map();   // hub -> Set(spoke)
  const inbound = new Map();    // page -> Set(source)
  const anchors = new Map();    // "from->to" -> anchor text

  for (const edge of edges) {
    const from = pathKey(edge.from_url);
    const to = pathKey(edge.to_url);
    if (!from || !to || from === to) continue;

    // Self-referential and off-site edges are already excluded upstream, but a
    // link to a page the crawl never reached (capped by maxUrls) would otherwise
    // become a phantom node.
    if (pageSet.size && !pageSet.has(to)) continue;

    if (!outbound.has(from)) outbound.set(from, new Set());
    outbound.get(from).add(to);
    if (!inbound.has(to)) inbound.set(to, new Set());
    inbound.get(to).add(from);
    if (edge.anchor) anchors.set(`${from}->${to}`, edge.anchor);
  }

  const totalPages = pageSet.size || new Set([...outbound.keys(), ...inbound.keys()]).size;
  const navTestApplies = totalPages >= MIN_PAGES_FOR_NAV_TEST;
  const navThreshold = Math.ceil(totalPages * NAV_LINK_SHARE);

  const hubs = [];
  for (const [page, targets] of outbound) {
    if (targets.size < HUB_MIN_OUTLINKS) continue;
    // Site-wide navigation looks exactly like a hub by link count. Calling the
    // footer a topic hub would make every cluster meaningless, so it is
    // classified rather than dropped — the distinction is itself a finding.
    const isNavigation = navTestApplies && targets.size >= navThreshold;
    hubs.push({
      url: page,
      outboundCount: targets.size,
      inboundCount: inbound.get(page)?.size || 0,
      kind: isNavigation ? 'navigation' : 'topic',
    });
  }
  hubs.sort((a, b) => b.outboundCount - a.outboundCount);

  const topicHubs = hubs.filter((h) => h.kind === 'topic');

  // A spoke belongs to the topic hub with the FEWEST outbound links that points
  // at it — the most specific hub, rather than whichever one happens to be
  // first. A page linked from both "/services" and "/services/dental-implants"
  // belongs to the latter.
  const clusterOf = new Map();
  const hubBySize = [...topicHubs].sort((a, b) => a.outboundCount - b.outboundCount);
  for (const hub of hubBySize) {
    for (const spoke of outbound.get(hub.url) || []) {
      if (!clusterOf.has(spoke)) clusterOf.set(spoke, hub.url);
    }
  }

  const clusters = topicHubs.map((hub) => ({
    hub: hub.url,
    outboundCount: hub.outboundCount,
    inboundCount: hub.inboundCount,
    spokes: [...clusterOf.entries()].filter(([, h]) => h === hub.url).map(([spoke]) => spoke),
  })).filter((c) => c.spokes.length > 0);

  const orphans = [...pageSet].filter((page) => !inbound.has(page));
  const unclustered = [...pageSet].filter(
    (page) => !clusterOf.has(page) && !topicHubs.some((h) => h.url === page),
  );

  // ── Findings ──────────────────────────────────────────────────────────────
  const findings = [];

  if (orphans.length) {
    findings.push({
      ruleId: 'hubspoke-orphan-pages',
      title: 'Pages with no internal links pointing to them',
      severity: 'error',
      category: 'Internal linking',
      count: orphans.length,
      detail: orphans.slice(0, 20).join(', '),
      recommendation:
        'Link these from a relevant hub or category page. A page nothing links to is reachable '
        + 'only from the sitemap, and accrues no internal authority.',
    });
  }

  const thinlyLinked = [...pageSet].filter((page) => {
    const count = inbound.get(page)?.size || 0;
    return count > 0 && count < 2 && !topicHubs.some((h) => h.url === page);
  });
  if (thinlyLinked.length) {
    findings.push({
      ruleId: 'hubspoke-single-inbound',
      title: 'Pages reachable from only one other page',
      severity: 'warning',
      category: 'Internal linking',
      count: thinlyLinked.length,
      detail: thinlyLinked.slice(0, 20).join(', '),
      recommendation: 'Add a second contextual link so the page does not depend on one route.',
    });
  }

  if (unclustered.length) {
    findings.push({
      ruleId: 'hubspoke-unclustered',
      title: 'Pages that belong to no topic cluster',
      severity: 'notice',
      category: 'Site structure',
      count: unclustered.length,
      detail: unclustered.slice(0, 20).join(', '),
      recommendation:
        'These are linked, but only from navigation. Grouping them under a topic hub is what '
        + 'makes a hub-and-spoke structure legible to a crawler.',
    });
  }

  const danglingHubs = topicHubs.filter((h) => h.inboundCount === 0);
  if (danglingHubs.length) {
    findings.push({
      ruleId: 'hubspoke-hub-not-linked',
      title: 'Hub pages that nothing links to',
      severity: 'warning',
      category: 'Site structure',
      count: danglingHubs.length,
      detail: danglingHubs.map((h) => h.url).slice(0, 20).join(', '),
      recommendation: 'A hub that cannot be reached from the site cannot pass authority to its spokes.',
    });
  }

  if (!topicHubs.length && totalPages > HUB_MIN_OUTLINKS) {
    findings.push({
      ruleId: 'hubspoke-no-topic-hubs',
      title: 'No topic hubs found — internal linking is navigation only',
      severity: 'warning',
      category: 'Site structure',
      count: totalPages,
      detail:
        `${hubs.length} page(s) link out widely enough to be a hub, and all of them link to `
        + `${Math.round(NAV_LINK_SHARE * 100)}%+ of the site, which is navigation rather than a topic grouping.`,
      recommendation:
        'Add category or pillar pages that link to a focused set of related pages.',
    });
  }

  return {
    structure: {
      pagesAnalyzed: totalPages,
      edgeCount: edges.length,
      hubCount: topicHubs.length,
      navigationHubCount: hubs.length - topicHubs.length,
      clusterCount: clusters.length,
      orphanCount: orphans.length,
      unclusteredCount: unclustered.length,
      hubMinOutlinks: HUB_MIN_OUTLINKS,
      navigationLinkShare: NAV_LINK_SHARE,
      // Recorded so a reader can tell whether a hub was judged against the
      // share test at all, rather than wondering why a wide-linking page on a
      // small site was still called a topic hub.
      navigationTestApplied: navTestApplies,
    },
    hubs: hubs.slice(0, 25),
    clusters: clusters
      .sort((a, b) => b.spokes.length - a.spokes.length)
      .slice(0, 15)
      .map((c) => ({ ...c, spokes: c.spokes.slice(0, 25) })),
    orphans: orphans.slice(0, 50),
    findings,
  };
}

module.exports = { analyze, pathKey, HUB_MIN_OUTLINKS, NAV_LINK_SHARE, MIN_PAGES_FOR_NAV_TEST };
