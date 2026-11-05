const { crawlDomain } = require('./sitemapCrawler');

// Crawls each domain's declared sitemap(s) and returns the raw same-host URL
// list per domain. Classification (templating + GPT) happens once, centrally,
// in the orchestrator — this stage no longer makes any type decision.
async function crawlSitemaps(domainEntries) {
  return Promise.all(domainEntries.map(async (entry) => {
    const result = await crawlDomain(entry.domain);
    return {
      ...entry,
      sitemapUrl: result.sitemapUrl,
      sitemapStatus: result.sitemapStatus,
      totalUrls: result.totalUrls,
      capped: result.capped,
      partial: !!result.partial,
      sitemapUrls: result.sitemapUrls || (result.sitemapUrl ? [result.sitemapUrl] : []),
      checks: result.checks || [],
      error: result.error,
      urls: result.urls, // in-memory only — never persisted (see orchestrator)
    };
  }));
}

module.exports = { crawlSitemaps };
