const cron = require('node-cron');
const store = require('./store');
const { getDatabase } = require('../../utils/countryToDatabase');
const { fetchClientDashboardData, appendHistory } = require('./dataFetcher');
const gapAnalysis = require('./gapAnalysis');
const insightThresholds = require('./insightThresholds');
const { generateModuleInsight, categorizeReferringDomains } = require('./insightGenerator');
const semrushBudget = require('./semrushBudget');

let isRunning = false;
let currentRunId = null;
let scheduledJob = null;

function getStatus() {
  return { isRunning, currentRunId };
}

function buildAllDomainsKeywords(domains) {
  return domains.map(d => ({ domain: d.domain, keywords: d.keywords || [] }));
}

function buildAllDomainsRefDomains(domains) {
  return domains.filter(d => !d.isClient).map(d => ({ domain: d.domain, refDomains: d.refDomains || [] }));
}

async function maybeGenerateInsight(insights, moduleKey, moduleLabel, notable, dataSummaryFn) {
  if (!notable) return;
  try {
    insights[moduleKey] = { ...(await generateModuleInsight(moduleLabel, dataSummaryFn())), generatedAt: new Date().toISOString() };
  } catch (err) {
    console.error(`[CompetitorAnalysis] Insight generation failed for ${moduleKey}:`, err.message);
    insights[moduleKey] = { error: err.message };
  }
}

async function refreshClient(client) {
  const database = getDatabase(client.country);
  const previousSnapshot = await store.getDashboardSnapshot(client.id);

  const { domains, budgetExceeded, skipped, capturedAt } = await fetchClientDashboardData(client, database);

  const clientDomain = domains.find(d => d.isClient);
  const competitorDomains = domains.filter(d => !d.isClient);

  const keywordGap = clientDomain
    ? gapAnalysis.computeKeywordGap(clientDomain.keywords || [], buildAllDomainsKeywords(competitorDomains))
    : { strikingDistance: [], untapped: [], missing: [] };

  const keywordDetailTable = gapAnalysis.computeKeywordDetailTable(buildAllDomainsKeywords(domains));

  const backlinkGap = clientDomain
    ? gapAnalysis.computeBacklinkGap(clientDomain.refDomains || [], buildAllDomainsRefDomains(domains))
    : [];

  domains.forEach(d => {
    d.keywordBuckets = gapAnalysis.computeKeywordPositionBuckets(d.keywords || []);
    d.authorityBuckets = gapAnalysis.buildAuthorityBuckets(d.refDomains || []);
  });

  let referringDomainCategories = {};
  if (clientDomain?.refDomains?.length) {
    try {
      referringDomainCategories = await categorizeReferringDomains(clientDomain.refDomains);
    } catch (err) {
      console.error(`[CompetitorAnalysis] Referring-domain categorization failed for ${client.name}:`, err.message);
    }
  }

  const snapshot = {
    capturedAt,
    domains,
    keywordGap,
    keywordDetailTable,
    backlinkGap,
    referringDomainCategories,
    budgetExceeded,
    skipped,
  };
  snapshot.history = appendHistory(previousSnapshot, snapshot);

  await store.saveDashboardSnapshot(client.id, snapshot);

  // ── Cached insights — only where a rule-based threshold flags something ────
  const insights = {};
  const manual = await store.getAIVisibility(client.id);

  await maybeGenerateInsight(insights, 'overall', 'Overall Analysis',
    insightThresholds.overallNotable({ domains }),
    () => JSON.stringify(domains.map(d => ({ domain: d.domain, isClient: d.isClient, traffic: d.domainRank?.organicTraffic, keywords: d.domainRank?.organicKeywords, authority: d.authorityScore, referringDomains: d.backlinks?.referringDomains, aioKeywords: d.aioKeywordCount }))));

  await maybeGenerateInsight(insights, 'pageSpeed', 'Page Speed Score Comparison',
    insightThresholds.pageSpeedNotable({ domains }),
    () => JSON.stringify(domains.map(d => ({ domain: d.domain, isClient: d.isClient, mobile: d.pageSpeed?.mobile?.score, desktop: d.pageSpeed?.desktop?.score, coreWebVitalsPassed: d.pageSpeed?.coreWebVitalsPassed }))));

  await maybeGenerateInsight(insights, 'keywordRanking', 'Keyword Ranking Comparison',
    insightThresholds.keywordRankingNotable({ keywordGap }),
    () => `Striking distance: ${keywordGap.strikingDistance.length}, Untapped: ${keywordGap.untapped.length}, Missing: ${keywordGap.missing.length}\nTop opportunities: ${JSON.stringify(keywordGap.untapped.slice(0, 5))}`);

  await maybeGenerateInsight(insights, 'branded', 'Branded vs. Non-branded Keywords',
    insightThresholds.brandedNotable({ domains }),
    () => JSON.stringify(domains.map(d => ({
      domain: d.domain,
      isClient: d.isClient,
      branded: d.brandedKeywordCountCapped ? `${d.brandedKeywordCount}+ (hit the sampling cap — true count is higher, treat as a lower bound only)` : d.brandedKeywordCount,
      nonBranded: d.nonBrandedKeywordCount,
    }))));

  await maybeGenerateInsight(insights, 'backlink', 'Off-Page Metrics Comparison',
    insightThresholds.backlinkNotable({ domains, backlinkGap }),
    () => JSON.stringify({
      authority: domains.map(d => ({ domain: d.domain, isClient: d.isClient, authorityScore: d.authorityScore, referringDomains: d.backlinks?.referringDomains })),
      gapCount: backlinkGap.length,
      topGapDomains: backlinkGap.slice(0, 5).map(g => ({ domain: g.domain, ascore: g.ascore, sharedByCount: g.sharedByCount })),
    }));

  await maybeGenerateInsight(insights, 'aiVisibility', 'AI Visibility',
    insightThresholds.aiVisibilityNotable({ manual }),
    () => JSON.stringify(manual?.domains || {}));

  await store.saveInsights(client.id, insights);

  return { competitorsProcessed: competitorDomains.length, budgetExceeded, skipped };
}

async function runDashboardRefresh({ triggeredBy = 'scheduler' } = {}) {
  if (isRunning) throw new Error('RUN_IN_PROGRESS');
  isRunning = true;
  currentRunId = 'run_' + Date.now().toString(36);
  const startedAt = new Date();
  const summary = { clientsProcessed: 0, errors: [], budgetExceeded: false };

  try {
    const startUsage = await semrushBudget.getTodayUsage();
    if (startUsage.usedToday !== null && startUsage.usedToday >= startUsage.cap) {
      console.warn(`[CompetitorAnalysis] Daily SEMrush credit cap already reached (${startUsage.usedToday}/${startUsage.cap}) — skipping this run entirely.`);
      summary.budgetExceeded = true;
      return { runId: currentRunId, triggeredBy, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), summary };
    }

    const clients = await store.getClients();
    for (const client of clients) {
      try {
        const result = await refreshClient(client);
        summary.clientsProcessed++;
        if (result.budgetExceeded) summary.budgetExceeded = true;
      } catch (err) {
        console.error(`[CompetitorAnalysis] Failed refreshing ${client.name}:`, err.message);
        summary.errors.push({ clientName: client.name, message: err.message });
      }
    }

    return { runId: currentRunId, triggeredBy, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), summary };
  } finally {
    isRunning = false;
    currentRunId = null;
  }
}

function startScheduler(config) {
  if (scheduledJob) { scheduledJob.destroy(); scheduledJob = null; }
  if (!config.enabled || !config.scheduleTime || !config.timezone) return;
  const [hour, minute] = config.scheduleTime.split(':');
  if (!hour || !minute) return;
  const cronExpression = `${minute} ${hour} * * 1`; // weekly, Monday

  try {
    scheduledJob = cron.schedule(cronExpression, async () => {
      console.log(`[CompetitorAnalysis] Scheduled refresh starting at ${new Date().toISOString()}`);
      try { await runDashboardRefresh({ triggeredBy: 'scheduler' }); }
      catch (err) { console.error('[CompetitorAnalysis] Scheduled refresh failed:', err.message); }
    }, { timezone: config.timezone });
    console.log(`[CompetitorAnalysis] Scheduler initialised — ${cronExpression} (${config.timezone})`);
  } catch (err) {
    console.error('[CompetitorAnalysis] Failed to initialise scheduler:', err.message);
  }
}

async function init() {
  const config = await store.getRunConfig();
  startScheduler(config);
}

async function reinitScheduler() {
  startScheduler(await store.getRunConfig());
}

module.exports = { init, reinitScheduler, runDashboardRefresh, getStatus };
