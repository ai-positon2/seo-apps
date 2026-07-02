const semrushCA = require('../../services/semrushCA');
const { getPageSpeedForAllDomains } = require('../../services/pageSpeedCA');
const semrushBudget = require('./semrushBudget');

// Same cost lesson learned from the earlier tracker build: keyword sample
// capped and sorted by volume so a small sample still captures what matters.
// BRANDED_QUERY_LIMIT/AIO_QUERY_LIMIT cap worst-case cost too: both filter the
// domain_organic report, which bills per row *returned*, not requested — a
// domain whose brand name is a common phrase can otherwise return thousands
// of matching rows and burn the entire daily budget on one domain.
const KEYWORD_SAMPLE_SIZE = 150;
const TOP_PAGES_SAMPLE_SIZE = 100;
const BRANDED_QUERY_LIMIT = 500;
const AIO_QUERY_LIMIT = 500;
const MAX_HISTORY_POINTS = 12; // ~3 months of weekly refreshes, bounded file size

async function fetchDomainData(domainEntry, database) {
  const { domain, label, isClient } = domainEntry;
  const homepageUrl = `https://${domain}`;

  const [domainRank, backlinksOverview, homepageAuthority, keywords, topPages, refDomains, geo, aioKeywords, brandedCount] = await Promise.all([
    semrushCA.getDomainRank(domain, database).catch(() => null),
    semrushCA.getBacklinksOverview(domain, 'root_domain').catch(() => null),
    semrushCA.getBacklinksOverview(homepageUrl, 'url').catch(() => null),
    semrushCA.getKeywordsFull(domain, database, KEYWORD_SAMPLE_SIZE, 'nq_desc').catch(() => []),
    semrushCA.getTopPages(domain, database, 10, TOP_PAGES_SAMPLE_SIZE).catch(() => []),
    semrushCA.getBacklinksRefdomains(domain).catch(() => []),
    semrushCA.getBacklinksGeo(domain, 'root_domain').catch(() => []),
    semrushCA.getAIOKeywords(domain, database, AIO_QUERY_LIMIT).catch(() => ({ count: 0, keywords: [] })),
    semrushCA.getBrandedKeywordCount(domain, database, label || domain, BRANDED_QUERY_LIMIT).catch(() => 0),
  ]);

  return {
    domain,
    label,
    isClient,
    domainRank: domainRank ? { organicKeywords: domainRank.organicKeywords, organicTraffic: domainRank.organicTraffic } : null,
    authorityScore: backlinksOverview?.authorityScore ?? null,
    homepageAuthorityScore: homepageAuthority?.authorityScore ?? null,
    backlinks: backlinksOverview
      ? { totalBacklinks: backlinksOverview.totalBacklinks, referringDomains: backlinksOverview.referringDomains }
      : null,
    keywords,
    topPages,
    refDomains,
    geoDistribution: geo,
    aioKeywordCount: aioKeywords.count,
    brandedKeywordCount: brandedCount,
    // True count may be higher — the query is capped at BRANDED_QUERY_LIMIT rows
    // to bound cost, so hitting the cap exactly means we truncated real matches.
    brandedKeywordCountCapped: brandedCount >= BRANDED_QUERY_LIMIT,
    nonBrandedKeywordCount: Math.max(0, (domainRank?.organicKeywords || keywords.length) - brandedCount),
  };
}

/**
 * Fetches everything needed for one client's dashboard: the client's own
 * domain plus every configured competitor, respecting the shared SEMrush
 * daily credit cap. PageSpeed is fetched once for all domains together.
 * Returns { domains: [...], budgetExceeded, skipped } — pure data, no LLM.
 */
async function fetchClientDashboardData(client, database) {
  const allEntries = [
    { domain: client.domain, label: client.brandName || client.name, isClient: true },
    ...(client.competitors || []).map(c => ({ domain: c.domain, label: c.label || c.domain, isClient: false, competitorId: c.id })),
  ].filter(e => e.domain);

  const domains = [];
  let budgetExceeded = false;
  const skipped = [];

  for (const entry of allEntries) {
    const usage = await semrushBudget.getTodayUsage();
    if (usage.usedToday !== null && usage.usedToday >= usage.cap) {
      budgetExceeded = true;
      skipped.push(entry.domain);
      continue;
    }
    try {
      domains.push(await fetchDomainData(entry, database));
    } catch (err) {
      console.error(`[CompetitorAnalysis] Failed fetching ${entry.domain}:`, err.message);
      domains.push({ domain: entry.domain, label: entry.label, isClient: entry.isClient, error: err.message });
    }
  }

  const pageSpeedResults = await getPageSpeedForAllDomains(domains.map(d => d.domain));
  domains.forEach((d, i) => { d.pageSpeed = pageSpeedResults[i]; });

  return { domains, budgetExceeded, skipped, capturedAt: new Date().toISOString() };
}

/**
 * Appends a lightweight trend point (traffic/keywords per domain) to the
 * snapshot's history, bounded to MAX_HISTORY_POINTS, for scoreboard sparklines.
 */
function appendHistory(previousSnapshot, newSnapshot) {
  const history = previousSnapshot?.history ? [...previousSnapshot.history] : [];
  history.push({
    capturedAt: newSnapshot.capturedAt,
    domains: newSnapshot.domains.map(d => ({
      domain: d.domain,
      organicTraffic: d.domainRank?.organicTraffic ?? null,
      organicKeywords: d.domainRank?.organicKeywords ?? null,
    })),
  });
  if (history.length > MAX_HISTORY_POINTS) history.splice(0, history.length - MAX_HISTORY_POINTS);
  return history;
}

module.exports = { fetchClientDashboardData, appendHistory };
