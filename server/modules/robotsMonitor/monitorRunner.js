const monitorStore = require('./monitorStore');
const sitemapCrawler = require('./sitemapCrawler');
const { classifyAndSample } = require('./pageTypeClassifier');
const { checkPage } = require('./indexChecker');
const { sendRunAlert } = require('./slackNotifier');

let isRunning = false;
let currentRunId = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatRunId(date, timezone) {
  // Format in the given timezone as run_YYYYMMDD_HHmm
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);

    const get = type => (parts.find(p => p.type === type) || {}).value || '00';
    const yyyy = get('year');
    const mm   = get('month');
    const dd   = get('day');
    const hh   = get('hour').padStart(2, '0');
    const min  = get('minute').padStart(2, '0');
    return `run_${yyyy}${mm}${dd}_${hh}${min}`;
  } catch {
    const d = date;
    return `run_${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
  }
}

async function runMonitorCheck({ triggeredBy = 'scheduler' } = {}) {
  if (isRunning) throw new Error('RUN_IN_PROGRESS');
  isRunning = true;

  const startedAt = new Date();
  const slackConfig = await monitorStore.getSlackConfig();
  const runId = formatRunId(startedAt, slackConfig.timezone);
  currentRunId = runId;

  try {
    const clients = await monitorStore.getClients();

    const clientResults = [];
    let totalDomains = 0;
    let totalPagesChecked = 0;
    let totalIssues = 0;

    for (const client of clients) {
      const domainResults = [];

      for (const domain of (client.domains || [])) {
        if (!domain.enabled) continue;
        totalDomains++;

        let domainResult = {
          domainId: domain.id,
          url: domain.url,
          env: domain.env,
          sitemapStatus: 'not-found',
          sitemapUrl: null,
          pageTypesFound: [],
          pagesChecked: [],
          issues: [],
          error: null,
        };

        try {
          // Step 1: crawl sitemap
          const crawl = await sitemapCrawler.crawlDomain(domain);
          domainResult.sitemapStatus = crawl.sitemapStatus;
          domainResult.sitemapUrl    = crawl.sitemapUrl;
          if (crawl.error) domainResult.error = crawl.error;

          // Step 2: classify & sample
          const sampled = classifyAndSample(crawl.urls, domain.url);
          domainResult.pageTypesFound = [...new Set(sampled.map(s => s.pageType))];

          // Step 3: check each page
          for (let i = 0; i < sampled.length; i++) {
            if (i > 0) await delay(500); // 500ms inter-page delay
            const { url, pageType } = sampled[i];
            const pageResult = await checkPage(url, domain.auth);
            domainResult.pagesChecked.push({ ...pageResult, pageType });
            totalPagesChecked++;
          }

          // Step 3.5: discard pages that redirected off-domain (e.g. staging → production).
          // If ALL pages redirected away, check just the homepage.
          const domainHostname = new URL(domain.url.replace(/\/$/, '')).hostname;
          const onDomain = domainResult.pagesChecked.filter(p => {
            if (p.error) return true;
            const effectiveUrl = p.finalUrl || p.url;
            try { return new URL(effectiveUrl).hostname === domainHostname; } catch { return false; }
          });

          if (onDomain.length === 0) {
            await delay(500);
            const homepageUrl = domain.url.replace(/\/$/, '') + '/';
            const homepageResult = await checkPage(homepageUrl, domain.auth);
            totalPagesChecked++;
            domainResult.pagesChecked = [{ ...homepageResult, pageType: 'homepage' }];
            domainResult.pageTypesFound = ['homepage'];
          } else if (onDomain.length < domainResult.pagesChecked.length) {
            domainResult.pagesChecked = onDomain;
            domainResult.pageTypesFound = [...new Set(onDomain.map(p => p.pageType))];
          }

          // Step 4: classify issues
          for (const page of domainResult.pagesChecked) {
            if (domain.env === 'production' && page.noindex) {
              domainResult.issues.push({
                url: page.url,
                finalUrl: page.finalUrl,
                issueType: 'noindex-on-production',
                signal: page.signal,
              });
              totalIssues++;
            } else if (domain.env === 'staging' && !page.noindex && !page.error) {
              domainResult.issues.push({
                url: page.url,
                finalUrl: page.finalUrl,
                issueType: 'noindex-missing-on-staging',
                signal: null,
              });
              totalIssues++;
            }
          }
        } catch (err) {
          domainResult.error = err.message;
        }

        domainResults.push(domainResult);
      }

      clientResults.push({
        clientId: client.id,
        clientName: client.name,
        domains: domainResults,
      });
    }

    const completedAt = new Date();
    const runResult = {
      runId,
      triggeredBy,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt - startedAt,
      summary: { totalDomains, totalPagesChecked, issuesFound: totalIssues },
      clients: clientResults,
    };

    await monitorStore.saveRunHistory(runResult);

    // Send Slack alerts per client
    for (const clientResult of clientResults) {
      await sendRunAlert({ ...runResult, clients: [clientResult] }, slackConfig);
    }

    await monitorStore.pruneHistory(90);
    return runResult;

  } finally {
    isRunning = false;
    currentRunId = null;
  }
}

function getStatus() {
  return { isRunning, currentRunId };
}

module.exports = { runMonitorCheck, getStatus };
