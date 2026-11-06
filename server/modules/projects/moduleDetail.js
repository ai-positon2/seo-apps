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
const hiddenChecks = require('./hiddenChecks');
const moduleEvidence = require('./moduleEvidence');
const moduleRunners = require('./moduleRunners');
const { isDatabaseConfigured } = require('../../services/db');
const crawlCatalog = require('../crawlScope/issue-catalog.json');
const { withAxisScores } = require('../../checks/seoGeoChecks');

const CRAWL_RULES = new Map(crawlCatalog.map((rule) => [rule.id, rule]));

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
async function evidenceBackedDetail({
  module, projectId, competitorCount, projectRow = null,
}) {
  const runs = await moduleEvidence.listRuns(projectId, module.key, { limit: 40 });

  const TERMINAL = ['completed', 'failed', 'cancelled', 'insufficient_data'];
  // Reconciled with its own page list, as the dashboard's card is (UX-138).
  let terminal = moduleEvidence.reconcilePageRun(runs.find((r) => TERMINAL.includes(r.status)) || null);
  // Its top findings too, when it was stored without them (UX-138).
  if (terminal && typeof moduleEvidence.withPageFindings === 'function') {
    terminal = (await moduleEvidence.withPageFindings([terminal])).get(terminal.id) || terminal;
  }
  // Hub and Spoke topics archived for this client are left out of the score,
  // findings and payload, as on the dashboard card (archivedClusters.js).
  if (module.key === 'hub_spoke' && terminal) {
    terminal = await require('./archivedClusters').applyToRun(projectId, terminal);
  }
  const inFlight = runs.find((r) => !TERMINAL.includes(r.status)) || null;

  // AI Visibility: the same live-report score the dashboard card shows
  // (overview.liveAiVisibilityTerminal), not the score stored when the run
  // closed — otherwise the card read '—' while this read 3/100. Also while a
  // run is in flight, exactly as the dashboard does, so the two agree mid-run:
  // both show the last finished figures (the live report leaves the unfinished
  // run's answers out).
  if (module.key === 'ai_visibility_lite' && terminal && projectRow
      && typeof overview.liveAiVisibilityTerminal === 'function') {
    terminal = await overview.liveAiVisibilityTerminal(projectRow, terminal, { inFlight }).catch((e) => {
      console.warn('[moduleDetail] live AI Visibility score unavailable:', e.message);
      return terminal;
    });
  }
  // The profile was built for the project's previous site (UX-108): its
  // findings, counts and stored report describe that site, so none of them is
  // shown here — the same rule the dashboard, the downloads and the executive
  // summary apply (overview.liveAiVisibilityTerminal sets profileStale).
  const profileStale = module.key === 'ai_visibility_lite' ? terminal?.profileStale || null : null;
  if (profileStale) {
    terminal = { ...terminal, score: null, findings: [], counts: {}, payload: null, payload_truncated: false };
  }

  const built = overview.evidenceCard(module, (terminal || inFlight) ? { terminal, inFlight } : null);
  // The dashboard's own out-of-date card, not "No error or warning findings"
  // for results that were left out.
  const card = profileStale ? overview.aivProfileStaleCard(built, terminal) : built;

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
      // 'user' for a page added with "Analyze another page", which can be removed.
      source: p.source || 'crawl',
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
    // A SEO & GEO report saved before it carried separate SEO/GEO scores gets them
    // derived from its own stored bars, so it does not need a re-run to show them.
    payload: module.key === 'seo_geo' && terminal?.payload?.native
      ? { ...terminal.payload, native: withAxisScores(terminal.payload.native) }
      : terminal?.payload || null,
    payloadTruncated: Boolean(terminal?.payload_truncated),
    history: historyView(runs),
    cost: moduleRunners.estimateCost(module.key, { competitorCount }),
  };
}

/**
 * One crawl_run_findings rollup row in the shared finding shape.
 *
 * The rollup stores a rule's title and nothing else, so "Detail" and "What to
 * do" came through as null and rendered "—" on every technical finding. The
 * text is the rule's own, from the catalog the crawl ran against — which also
 * describes every crawl stored before this, with no backfill.
 */
function technicalFindingRow(f) {
  const rule = CRAWL_RULES.get(f.rule_id);
  return {
    ruleId: f.rule_id,
    title: f.detail?.title || rule?.title || f.rule_id,
    severity: f.severity,
    category: f.category || null,
    count: Number(f.count) || 1,
    detail: f.detail?.description || f.detail?.summary || rule?.description || null,
    recommendation: f.detail?.recommendation || rule?.recommendation || null,
  };
}

/**
 * Asks CrawlScope's own tenancy check — the one its report page uses — whether
 * this viewer may open a crawl, so the dashboard never offers a link that page
 * will refuse. Never throws: a failed check must not cost the card its data.
 */
async function crawlReportAccess(crawlRunId, access) {
  try {
    const crawlRepo = require('../crawlScope/db/repo');
    const { serviceClient } = require('../crawlScope/db/client');
    const { accessibleWorkspaceIds } = require('../../services/projectAccess');
    const viewer = { userId: access?.userId || null, workspaceIds: await accessibleWorkspaceIds(access?.userId) };
    if (await crawlRepo.getRunForViewer(serviceClient(), crawlRunId, viewer)) return { ok: true };
    return {
      ok: false,
      reason: access?.isPlatformAdmin && !access?.role
        ? 'You can see this project as a platform admin, but you are not a member of its workspace, so its crawl report will not open for you. Join the workspace to open it.'
        : 'This crawl report is not shared with your workspace yet. Ask the person who created the project, or an administrator, to check its workspace.',
    };
  } catch (e) {
    console.warn('[moduleDetail] crawl report access check failed:', e.message);
    return null;
  }
}

/**
 * CrawlScope, whose evidence predates project_module_runs and is richer than it.
 *
 * Reuses the dashboard's own reads so the card matches exactly, including the
 * pages-crawled vs external-links-checked split that the run's own summary
 * cannot express (resultCount counts both).
 */
async function technicalDetail({ module, projectId, access }) {
  const crawlRuns = await overview.recentCrawlRuns(projectId);
  const terminal = crawlRuns.find((r) => ['completed', 'stopped'].includes(r.status)) || null;
  const inFlight = crawlRuns.find((r) => ['queued', 'running', 'paused'].includes(r.status)) || null;

  const [findings, crawlCounts, health] = await Promise.all([
    terminal ? overview.findingsForRun(terminal.id) : Promise.resolve([]),
    terminal ? overview.internalCounts(terminal.id) : Promise.resolve(null),
    // Without these the card fell back to run.summary.findings, which no run
    // has carried since migration 0023 — so any crawl with an error or warning
    // came back unscored here while the dashboard card beside it had a score.
    // The dashboard's own cached, time-bounded read (crawlHealthWithin), so the
    // page and the card share one computation and a huge crawl cannot hang it.
    terminal ? overview.crawlHealthWithin(terminal.id) : Promise.resolve(null),
  ]);
  const { htmlPages, affected: affectedPageCounts, pending } = overview.healthInputs(health);

  const internalPages = crawlCounts ? crawlCounts.pages : null;
  const probes = crawlCounts ? crawlCounts.probes : 0;
  const hidden = access?.project ? hiddenChecks.hiddenRuleIds(access.project) : [];
  const built = overview.withHiddenChecks(
    overview.technicalCard(crawlRuns, findings, internalPages, htmlPages, [], affectedPageCounts, probes),
    hidden,
  );
  const card = pending ? overview.healthPendingCard(built) : built;
  // The card's tallies, which leave the client's hidden checks out; the run's
  // own summary counts every rule.
  const counts = findings.hiddenRows?.length
    ? hiddenChecks.subtractHidden(terminal?.summary?.counts || {}, findings.hiddenRows)
    : terminal?.summary?.counts || {};
  // The same for every crawl in the history list; not read at all when the
  // project hides nothing.
  const hiddenByRun = hidden.length
    ? await hiddenChecks.hiddenCountsForRuns(crawlRuns.slice(0, HISTORY_LIMIT).map((r) => r.id)).catch((e) => {
      console.error('[moduleDetail] hidden check counts:', e.message);
      return new Map();
    })
    : new Map();
  const reportAccess = terminal ? await crawlReportAccess(terminal.id, access) : null;
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
    findings: findings.map(technicalFindingRow),
    payload: terminal ? {
      crawlRunId: terminal.id,
      pagesCrawled: internalPages,
      externalChecked: internalPages === null ? null : Math.max(0, resultCount - internalPages - probes),
      // Internal URLs past the page limit, status-checked for broken links only.
      probesChecked: probes,
      resultCount,
      robotsStatus: terminal.summary?.robotsStatus || null,
      elapsedMs: terminal.summary?.elapsed || null,
      // Whether THIS viewer can open the crawl's own report. The dashboard reads
      // crawl_runs by project; the report page authorizes the viewer. When they
      // disagree the panel says so instead of linking to "Run not found".
      reportAccess,
    } : null,
    payloadTruncated: false,
    history: crawlRuns.slice(0, HISTORY_LIMIT).map((r) => {
      const runCounts = hiddenByRun.has(String(r.id))
        ? hiddenChecks.subtractHidden(r.summary?.counts || {}, hiddenByRun.get(String(r.id)))
        : r.summary?.counts;
      return {
        id: r.id,
        status: overview.displayRunStatus(r),
        trigger: r.trigger,
        score: null,
        findingCount: Number(runCounts?.error || 0)
          + Number(runCounts?.warning || 0)
          + Number(runCounts?.notice || 0),
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      };
    }),
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

  // Auto-discovery runs INSIDE the competitor run itself whenever it starts
  // with none tracked and none awaiting approval — see
  // moduleRunners.runCompetitor. Such a run only searches for competitors (it
  // saves what it finds as suggestions), so its price is replaced below with
  // the discovery search's own estimate rather than quoted as zero.
  const pendingAutoDiscovery = module.key === 'competitor' && !competitorCount
    && !domains.some((d) => d.role === 'competitor' && d.status === 'proposed');
  const pricedCompetitorCount = pendingAutoDiscovery
    ? require('../competitorAnalysis/discovery').DEFAULT_DISCOVERY_LIMIT
    : competitorCount;

  const detail = module.key === 'technical'
    ? await technicalDetail({ module, projectId, access })
    : await evidenceBackedDetail({
      module, projectId, competitorCount: pricedCompetitorCount, projectRow: access.project,
    });

  // SEO & GEO: the run's SEO and GEO averages, computed by the same function the
  // dashboard card uses (overview.seoGeoSideScores), so the report's site average
  // and the card can never show two different sets of numbers for one run.
  if (module.key === 'seo_geo' && detail.run?.id && !detail.pagesFromInFlightRun) {
    detail.sideScores = await overview.seoGeoSideScores(detail.pagesRunId || detail.run.id).catch((e) => {
      console.warn('[moduleDetail] SEO/GEO averages unavailable:', e.message);
      return null;
    });
  }

  if (pendingAutoDiscovery && detail.cost) {
    // A run with no competitor only searches for some: what it finds is saved
    // as suggestions, and the paid comparison starts when one is accepted. So
    // the price is the discovery search alone (the same estimate the setup
    // autostart quotes), flagged "up to" because the search can return less.
    detail.cost = {
      ...detail.cost,
      ...require('./competitorAutostart').discoveryEstimate(),
      assumesAutoDiscovery: true,
    };
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
  technicalFindingRow,
};
