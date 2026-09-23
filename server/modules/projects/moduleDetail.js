// ── One module's project evidence, expanded ──────────────────────────────────
//
// What the homepage card shows, plus everything the card had to leave out: all
// the findings rather than the top four, the module's own stored detail, its run
// history, and what a run would cost.
//
// The shape is the same for all six modules so the client needs one panel rather
// than six. The one asymmetry is where the evidence lives: CrawlScope owns
// crawl_runs + crawl_run_findings, and the other five write project_module_runs.
//
// `card` is deliberately part of the response. The panel renders the SAME object
// the dashboard renders, so a headline cannot say 88/100 in one place and
// something else in the other — a class of drift that is invisible until a
// client points at two screens.

const overview = require('./overview');
const moduleEvidence = require('./moduleEvidence');
const moduleRunners = require('./moduleRunners');
const { isDatabaseConfigured } = require('../../services/db');

// Enough history to see a trend without turning the panel into a log.
const HISTORY_LIMIT = 10;

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function notConfigured() {
  return Object.assign(
    new Error('Module detail needs the database configured.'),
    { status: 503, code: 'not_configured' },
  );
}

/** The MODULES entry, or 404 — an unknown key must not read as "nothing yet". */
function moduleFor(moduleKey) {
  const module = overview.MODULES.find((m) => m.key === moduleKey);
  if (!module) {
    throw notFound(
      `Unknown module "${moduleKey}". Expected one of: ${overview.MODULES.map((m) => m.key).join(', ')}.`,
    );
  }
  return module;
}

/** A stored project_module_runs row, as the panel wants it. */
function runView(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    targetUrl: row.target_url || null,
    countryCode: row.country_code || null,
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    scoreMax: row.score_max === null || row.score_max === undefined ? null : Number(row.score_max),
    scoreBasis: row.score_basis || null,
    band: row.band || null,
    counts: row.counts || {},
    error: row.error || null,
    // The one sentence that says what is missing and what to do about it. Lifted
    // out of the payload because it is the most useful thing in the row.
    note: row.payload?.note || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

function historyView(rows) {
  return rows.slice(0, HISTORY_LIMIT).map((row) => ({
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    findingCount: Array.isArray(row.findings) ? row.findings.length : 0,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }));
}

/**
 * The five modules backed by project_module_runs.
 *
 * The card is built from the same { terminal, inFlight } pair the dashboard
 * builds it from, so an in-flight run reads as "running" here too rather than as
 * never-run.
 */
async function evidenceBackedDetail({ module, projectId, competitorCount }) {
  const runs = await moduleEvidence.listRuns(projectId, module.key, { limit: 40 });

  const TERMINAL = ['completed', 'failed', 'cancelled', 'insufficient_data'];
  const terminal = runs.find((r) => TERMINAL.includes(r.status)) || null;
  const inFlight = runs.find((r) => !TERMINAL.includes(r.status)) || null;

  const card = overview.evidenceCard(module, (terminal || inFlight) ? { terminal, inFlight } : null);

  // The pages this run covered, without their reports — the picker needs a list
  // of URLs and scores, not several megabytes of stored reports.
  //
  // Read from the run IN FLIGHT when there is one, so a report opened while the
  // audit is still going shows the pages already finished instead of the previous
  // run's. That is the point of auditing as the crawl discovers: every completed
  // page is readable immediately rather than after the whole pass.
  const pageSource = inFlight || terminal;
  const pages = pageSource && moduleEvidence.PAGE_MODULE_KEYS.includes(module.key)
    ? (await moduleEvidence.pageRunsForRun(pageSource.id)).map((p) => ({
      pageRunId: p.id,
      url: p.url,
      ordinal: p.ordinal,
      status: p.status,
      score: p.score === null || p.score === undefined ? null : Number(p.score),
      scoreMax: p.score_max === null || p.score_max === undefined ? null : Number(p.score_max),
      band: p.band || null,
      counts: p.counts || {},
      error: p.error || null,
      finishedAt: p.finished_at,
    }))
    : [];

  return {
    card,
    run: runView(terminal),
    inFlightRun: runView(inFlight),
    // Which run the page list above belongs to. Without this the client cannot
    // tell "these pages are from the run still going" from "these pages are the
    // finished result", and its once-per-run guard would key off the wrong id.
    pagesRunId: pageSource?.id || null,
    pagesFromInFlightRun: Boolean(inFlight && pageSource === inFlight),
    // Per-page reports, when this module audits pages rather than the site.
    pages,
    isPerPage: moduleEvidence.PAGE_MODULE_KEYS.includes(module.key),
    // Every finding, in the order the module reported severity-ranked. The card
    // shows four; this is the rest of them.
    findings: Array.isArray(terminal?.findings) ? terminal.findings : [],
    payload: terminal?.payload || null,
    payloadTruncated: Boolean(terminal?.payload_truncated),
    history: historyView(runs),
    cost: moduleRunners.estimateCost(module.key, { competitorCount }),
  };
}

/**
 * CrawlScope, whose evidence predates project_module_runs and is richer than it.
 *
 * Reuses the dashboard's own reads so the card matches exactly, including the
 * pages-crawled vs external-links-checked split that the run's own summary
 * cannot express (resultCount counts both).
 */
async function technicalDetail({ module, projectId }) {
  const crawlRuns = await overview.recentCrawlRuns(projectId);
  const terminal = crawlRuns.find((r) => ['completed', 'stopped'].includes(r.status)) || null;
  const inFlight = crawlRuns.find((r) => ['queued', 'running', 'paused'].includes(r.status)) || null;

  const [findings, internalPages, htmlPages, affectedPageCounts] = await Promise.all([
    terminal ? overview.findingsForRun(terminal.id) : Promise.resolve([]),
    terminal ? overview.internalPageCount(terminal.id) : Promise.resolve(null),
    terminal ? overview.internalHtmlPageCount(terminal.id) : Promise.resolve(null),
    // Without these the card fell back to run.summary.findings, which no run
    // has carried since migration 0023 — so any crawl with an error or warning
    // came back unscored here while the dashboard card beside it had a score.
    terminal ? overview.healthAffectedPages(terminal.id) : Promise.resolve(null),
  ]);

  const card = overview.technicalCard(crawlRuns, findings, internalPages, htmlPages, [], affectedPageCounts);
  const counts = terminal?.summary?.counts || {};
  const resultCount = Number(terminal?.summary?.resultCount) || 0;

  return {
    card,
    pages: [],
    isPerPage: false,
    run: terminal ? {
      id: terminal.id,
      status: overview.displayRunStatus(terminal),
      trigger: terminal.trigger,
      targetUrl: null,
      score: null,
      scoreMax: null,
      // CrawlScope has no rubric of its own; the card says so and this agrees.
      scoreBasis: null,
      band: null,
      counts,
      error: terminal.error || null,
      note: null,
      startedAt: terminal.started_at,
      finishedAt: terminal.finished_at,
      createdAt: terminal.created_at,
    } : null,
    inFlightRun: inFlight ? {
      id: inFlight.id,
      status: overview.displayRunStatus(inFlight),
      startedAt: inFlight.started_at,
      createdAt: inFlight.created_at,
    } : null,
    // Reshaped into the same finding shape the other five use, so one table
    // renders either source.
    findings: findings.map((f) => ({
      ruleId: f.rule_id,
      title: f.detail?.title || f.rule_id,
      severity: f.severity,
      category: f.category || null,
      count: Number(f.count) || 1,
      detail: f.detail?.description || f.detail?.summary || null,
      recommendation: f.detail?.recommendation || null,
    })),
    payload: terminal ? {
      crawlRunId: terminal.id,
      pagesCrawled: internalPages,
      externalChecked: internalPages === null ? null : Math.max(0, resultCount - internalPages),
      resultCount,
      robotsStatus: terminal.summary?.robotsStatus || null,
      elapsedMs: terminal.summary?.elapsed || null,
    } : null,
    payloadTruncated: false,
    history: crawlRuns.slice(0, HISTORY_LIMIT).map((r) => ({
      id: r.id,
      status: overview.displayRunStatus(r),
      trigger: r.trigger,
      score: null,
      findingCount: Number(r.summary?.counts?.error || 0)
        + Number(r.summary?.counts?.warning || 0)
        + Number(r.summary?.counts?.notice || 0),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    })),
    // A crawl is queued through CrawlScope's worker, not billed to a provider.
    cost: null,
  };
}

/**
 * @param {object} input
 * @param {object} input.access     from projectAccess.requireProject
 * @param {string} input.moduleKey
 * @param {Array}  [input.domains]  project_domains rows, for the cost estimate
 */
async function buildModuleDetail({ access, moduleKey, domains = [] }) {
  if (!isDatabaseConfigured()) throw notConfigured();

  const module = moduleFor(moduleKey);
  const projectId = access.project.id;
  const competitorCount = domains
    .filter((d) => d.role === 'competitor' && d.status === 'active').length;

  // Auto-discovery ("Find competitors for me" from Project Setup) runs INSIDE
  // the competitor run itself, the first time it starts with none tracked —
  // see moduleRunners.runCompetitor. The Run button's price is read straight
  // off this count, so pricing it at zero here would quote the cost of
  // comparing against nobody for a run that is about to go find some (§16.11:
  // no invented evidence, and understating a real cost is its own version of
  // that).
  const pendingAutoDiscovery = module.key === 'competitor' && !competitorCount
    && Boolean(access.project.settings?.autoFindCompetitors);
  const pricedCompetitorCount = pendingAutoDiscovery
    ? require('../competitorAnalysis/discovery').DEFAULT_DISCOVERY_LIMIT
    : competitorCount;

  const detail = module.key === 'technical'
    ? await technicalDetail({ module, projectId })
    : await evidenceBackedDetail({ module, projectId, competitorCount: pricedCompetitorCount });

  if (pendingAutoDiscovery && detail.cost) {
    // Flagged rather than silently repriced, so the client can say "up to" —
    // the ceiling is real (discovery finds at most this many), but so is the
    // chance discovery finds fewer, or none, and the run spends less.
    detail.cost = { ...detail.cost, assumesAutoDiscovery: true };
  }

  return {
    module: {
      key: module.key,
      label: module.label,
      family: module.family,
      toolPath: module.toolPath,
      evidenceSource: module.evidenceSource,
      dependsOn: module.dependsOn || null,
      live: Boolean(module.live),
      runnable: Boolean(module.runnable),
      pendingPhase: module.pendingPhase || null,
    },
    project: {
      id: access.project.id,
      name: access.project.name,
      countryCode: access.project.country_code || null,
      // So the panel can explain a creator-scoped crawl without a second fetch.
      createdBy: access.project.owner || null,
    },
    capabilities: access.capabilities,
    ...detail,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  HISTORY_LIMIT,
  moduleFor,
  runView,
  historyView,
  buildModuleDetail,
};
