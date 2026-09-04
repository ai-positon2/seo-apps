// ── Project overview (backs the home dashboard, PRD §20.1) ──────────────────
// One read that answers: what does this project's audit profile look like right
// now, what has been running, and what needs attention?
//
// The rule this file is built around, and the reason it looks conservative:
// a module with no stored evidence for this project reports `not_run` — never a
// number. The PRD is explicit that missing data must not be coerced into a
// value (§16.11), that a new scoring methodology is out of scope (§6.2), and
// that a capability gap must be surfaced as structured state rather than
// silently substituted with something weaker (§30, closing paragraph). A
// dashboard that invents a 78 for a module that has never run is the exact
// failure those rules exist to prevent.
//
// What IS real today: the crawl (CrawlScope) writes durable, project-scoped
// evidence — runs, per-URL results and per-rule findings. That module reports
// live counts. The other five report `not_run` with the phase that connects
// them, which is honest and actionable rather than decorative.

const { getSupabase, isSupabaseConfigured } = require('../../services/supabase');
const moduleEvidence = require('./moduleEvidence');
const store = require('./store');

// The six modules the audit profile covers (PRD §11.1 families + the design's
// six-axis profile). `evidenceSource` documents where a real reading will come
// from, so the card can say why it is empty.
const MODULES = [
  {
    key: 'technical',
    label: 'Tech Audit',
    family: 'technical',
    toolPath: '/crawl-scope',
    evidenceSource: 'crawl_runs + crawl_run_findings',
    live: true,
  },
  {
    key: 'hub_spoke',
    label: 'Hub and Spoke',
    family: 'technical',
    toolPath: '/content-architect',
    // Content Architect's pipeline, run over the pages the crawl already stored.
    // Nothing is re-fetched and no separate discovery step is needed: the crawl
    // found the sitemaps and decided what is internal and reachable.
    evidenceSource: 'contentArchitect analysis of crawl_run_results + crawl_run_links, via project_module_runs',
    live: true,
    runnable: true,
    dependsOn: 'a completed site crawl'
  },
  {
    key: 'competitor',
    label: 'Competitor Research',
    family: 'seo',
    toolPath: '/competitor-analysis',
    evidenceSource: 'project_module_runs (module_key = competitor)',
    // Connected in phase 3: runnable against the project's primary domain, and
    // its result is stored so this card reads evidence rather than nothing.
    live: true,
    runnable: true,
  },
  {
    key: 'seo_geo',
    label: 'SEO & GEO',
    family: 'geo',
    toolPath: '/seo-geo-audit',
    evidenceSource: 'project_module_runs (module_key = seo_geo)',
    // Connected in phase 3: runnable against the project's primary domain, and
    // its result is stored so this card reads evidence rather than nothing.
    live: true,
    runnable: true,
  },
  {
    key: 'ai_visibility',
    label: 'AI Visibility',
    family: 'geo',
    toolPath: '/ai-visibility',
    evidenceSource: 'project_module_runs (module_key = ai_visibility) + ai_visibility_captures',
    // Measures the consumer answer surfaces — what ChatGPT and Google AI Overview
    // say about this client — rather than the client's own site. The only module
    // whose evidence is about somebody else's product.
    live: true,
    runnable: true,
  },
  {
    key: 'agent_readiness',
    label: 'Agent Readiness',
    family: 'agentic',
    toolPath: '/agent-readiness-audit',
    evidenceSource: 'project_module_runs (module_key = agent_readiness)',
    // Connected in phase 3: runnable against the project's primary domain, and
    // its result is stored so this card reads evidence rather than nothing.
    live: true,
    runnable: true,
  },
];

// PRD §10.5 maps CrawlScope's legacy `stopped` onto `cancelled` for display and
// adds `completed_with_errors`. The stored value is untouched (§30.7).
const RUN_STATUS_DISPLAY = {
  queued: 'queued',
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  stopped: 'cancelled',
};

const SEVERITY_RANK = { error: 0, warning: 1, notice: 2, info: 3 };

function displayRunStatus(run) {
  const base = RUN_STATUS_DISPLAY[run.status] || run.status;
  // A run that produced a usable inventory but had URL-level failures is
  // "completed with errors" (§10.5, AC-015). Derived from the stored summary
  // rather than re-labelling rows, so nothing historical is rewritten.
  if (base === 'completed' && Number(run.summary?.counts?.error) > 0) {
    return 'completed_with_errors';
  }
  return base;
}

/** The crawl runs for this project, newest first. */
async function recentCrawlRuns(projectId, limit = 12) {
  const { data, error } = await getSupabase()
    .from('crawl_runs')
    .select(
      'id, status, summary, error, trigger, created_at, started_at, finished_at, progress, '
      + 'heartbeat_at',
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`[projects.overview.recentCrawlRuns] ${error.message}`);
  return data || [];
}

/**
 * HTML pages in one crawl.
 *
 * The denominator the crawl report's health score divides by. Separate from
 * internalPageCount, which counts internal pages: on the live project those are
 * 85 and 50 respectively, and using the wrong one would put a different health
 * score on the card than on the report.
 */
async function internalHtmlPageCount(runId) {
  const { count, error } = await getSupabase()
    .from('crawl_run_results')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .ilike('content_type', '%text/html%')
    // Internal only. The crawler also fetches the external pages it links out to
    // — 35 of 85 HTML results on the live project — and those can never carry a
    // finding, because every check in analyzer.js runs over internalResults. So
    // leaving them in the denominator fed the score 35 free passes: Site Health
    // read 82 where the site the client actually owns scores 69.
    //
    // Not showing an error on somebody else's page and then counting that page
    // as clean are the same mistake pointing in two directions.
    .eq('data->>scope', 'Internal');
  if (error) {
    console.error('[projects.overview.internalHtmlPageCount]', error.message);
    return null;
  }
  return count;
}

/**
 * Full per-occurrence findings for one run — crawl_run_finding_instances
 * (migration 0023). Only siteHealth() consumes this (severity + url, to
 * count affected pages), but it's fetched as whole finding objects rather
 * than a narrower projection to match how every other reader of "a finding"
 * in this codebase already works.
 *
 * A run finalized before 0023 shipped has no rows here — its findings are
 * still sitting in the old location, crawl_runs.summary.findings — so this
 * falls back there rather than reporting a false "no errors" for every run
 * that predates the migration.
 */
async function findingInstancesForRun(runId) {
  const PAGE = 2_000;
  const CAP = 50_000;
  const all = [];
  for (let offset = 0; offset < CAP; offset += PAGE) {
    const { data, error } = await getSupabase()
      .from('crawl_run_finding_instances')
      .select('data')
      .eq('run_id', runId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`[projects.overview.findingInstancesForRun] ${error.message}`);
    for (const row of data) all.push(row.data);
    if (data.length < PAGE) break;
  }
  if (all.length) return all;

  const { data: run, error } = await getSupabase()
    .from('crawl_runs')
    .select('summary')
    .eq('id', runId)
    .maybeSingle();
  if (error) throw new Error(`[projects.overview.findingInstancesForRun] ${error.message}`);
  return Array.isArray(run?.summary?.findings) ? run.summary.findings : [];
}

/** Per-rule findings for one run — the rollup crawl_run_findings already holds. */
async function findingsForRun(runId) {
  const { data, error } = await getSupabase()
    .from('crawl_run_findings')
    .select('rule_id, severity, category, count, detail')
    .eq('run_id', runId)
    .order('count', { ascending: false })
    .limit(200);
  if (error) throw new Error(`[projects.overview.findingsForRun] ${error.message}`);
  return data || [];
}

/** Tool runs recorded against the workspace, for the activity table. */
async function recentToolRuns(workspaceId, limit = 20) {
  if (!workspaceId) return [];
  const { data, error } = await getSupabase()
    .from('tool_runs')
    .select('id, tool_id, status, label, action, actor_email, created_at, completed_at, duration_ms, error')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`[projects.overview.recentToolRuns] ${error.message}`);
  return data || [];
}

/**
 * How many of a run's stored results are pages of the site, as opposed to
 * external URLs the crawler only status-checked.
 *
 * `summary.resultCount` counts both, which made the card read "86 URLs crawled"
 * for a run capped at 50 pages — the 36 extra were outbound link checks, which
 * are governed by maxExternalUrls, not by maxUrlsPerCrawl. Reporting the total
 * against a cap that only applies to one part of it invites exactly the wrong
 * conclusion ("the cap isn't working"), so the two are counted separately.
 *
 * Returns null if the count can't be taken, and the caller falls back to the
 * summary total rather than showing a confident wrong number.
 */
async function internalPageCount(runId) {
  const { count, error } = await getSupabase()
    .from('crawl_run_results')
    .select('*', { count: 'exact', head: true })
    .eq('run_id', runId)
    .eq('data->>scope', 'Internal');
  if (error) {
    console.error('[projects.overview.internalPageCount]', error.message);
    return null;
  }
  return Number(count);
}

/**
 * The technical module card: real evidence, or a clear "never crawled" state.
 * Reports severity counts, not a score — CrawlScope has no 0–100 rubric, and
 * inventing one here would be the new scoring methodology §6.2 rules out.
 */
/**
 * Which crawl a set of numbers came from, in words.
 *
 * Short and absolute rather than relative ("2 hours ago" is not something two
 * screens can be compared on). The card already shows a relative timestamp
 * separately; this is the identifier.
 */
function crawlLabel(run) {
  const at = run?.finished_at || run?.created_at;
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return `from the crawl of ${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// Measured: a healthy crawl advances heartbeat_at every 30 seconds, on its own
// timer rather than per fetch — so a slow page cannot delay a beat, and four
// missed beats means the process is gone rather than busy.
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_HEARTBEAT_MS = HEARTBEAT_INTERVAL_MS * 4;

/**
 * Is this in-flight crawl actually alive?
 *
 * Three states worth telling apart, because they need different sentences and the
 * product used to say nothing at all for any of them:
 *
 *   pending  queued, not started. Nothing is wrong; the wait is queue time.
 *   stalled  running, but the heartbeat stopped. Its process is gone and the crawl
 *            is dead until the stale sweep reclaims it ten minutes later.
 *   alive    running and beating.
 */
function crawlHealth(run) {
  if (!run) return null;
  if (['queued', 'pending'].includes(run.status)) {
    return { state: 'pending', since: run.created_at };
  }
  const beat = Date.parse(run.heartbeat_at || run.started_at || '');
  // No parseable beat is not evidence of death: treat it as alive rather than
  // announcing a stall this cannot actually see.
  if (!Number.isFinite(beat)) return { state: 'alive', since: run.started_at };
  const silentFor = Date.now() - beat;
  if (silentFor > STALE_HEARTBEAT_MS) {
    return { state: 'stalled', since: run.started_at, silentMinutes: Math.round(silentFor / 60_000) };
  }
  return { state: 'alive', since: run.started_at };
}

/**
 * The live crawl, as a top-level fact rather than something to dig out of a card.
 *
 * The dashboard could already say a crawl was running, but only inside the Tech
 * Audit card — so the answer to "is anything happening right now" was three
 * cards down, in the same visual weight as five things that were not happening.
 * A crawl is the one event that changes what every other card will say next, so
 * it gets its own line at the top.
 *
 * Returns null when nothing is in flight, which is the common case and renders
 * nothing at all.
 *
 * On the progress bar's denominator — this is the part that is easy to get
 * dishonest. `discovered` grows as the crawl finds links, so a bar drawn as
 * crawled/discovered MOVES BACKWARDS whenever a page turns up new links, which
 * reads as the crawl losing ground. The ceiling (maxUrls + maxExternalUrls) is
 * fixed for the whole run, so crawled/ceiling only ever advances. It undershoots
 * on a site smaller than the cap — the bar stops at 60% and the crawl finishes —
 * which is why the label says "up to" and prints the discovered count beside it
 * rather than letting the bar imply a total it does not know.
 *
 * @param {Array}  runs       recent crawl runs, newest first
 * @param {number} followers  page-audit modules currently following this crawl
 */
function crawlStatus(runs, followers = 0) {
  const inFlight = (runs || []).find((r) => ['queued', 'running', 'paused'].includes(r.status));
  if (!inFlight) return null;

  const health = crawlHealth(inFlight);
  const p = inFlight.progress || {};
  const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);

  const crawled = num(p.crawled);
  const discovered = num(p.discovered);
  const queued = num(p.queued);
  const ceiling = num(p.maxUrls);

  // Null, not 0: a queued crawl has measured nothing, and a 0% bar claims it
  // started and got nowhere (§16.11).
  const percent = crawled !== null && ceiling
    ? Math.max(0, Math.min(100, Math.round((crawled / ceiling) * 100)))
    : null;

  const paused = inFlight.status === 'paused';
  const state = paused ? 'paused' : health.state;

  const headline = state === 'pending'
    ? 'Crawl queued'
    : state === 'stalled'
      ? 'Crawl stopped responding'
      : paused
        ? 'Crawl paused'
        : crawled
          ? `Crawling · ${crawled} page${crawled === 1 ? '' : 's'} so far`
          : 'Crawl starting';

  const detail = state === 'pending'
    ? 'Waiting for a worker to pick it up. This is queue time, not a fault.'
    : state === 'stalled'
      ? `No heartbeat for ${health.silentMinutes} minute(s). It is reclaimed automatically `
        + 'within ten minutes, or you can re-run it now.'
      : paused
        ? 'Paused. Nothing is being fetched until it is resumed.'
        : followers
          ? `${followers} page audit${followers === 1 ? '' : 's'} running behind it, `
            + 'scoring each page as the crawl finds it.'
          : 'Findings appear as soon as the crawl reaches a terminal state.';

  return {
    runId: inFlight.id,
    url: inFlight.url,
    state,                       // pending | alive | stalled | paused
    live: state === 'alive',
    headline,
    detail,
    crawled,
    discovered,
    queued,
    ceiling,
    percent,
    followers,
    startedAt: inFlight.started_at || null,
    queuedAt: inFlight.created_at || null,
    silentMinutes: health.silentMinutes ?? null,
  };
}

/**
 * The live crawl on its own, without building the whole dashboard.
 *
 * buildOverview is expensive — six module cards, findings, activity, two page
 * counts — and the shell polls this every few seconds from every screen in the
 * app so the crawl stays visible when you navigate away from the dashboard.
 * Polling the full overview for one progress bar would be several hundred
 * kilobytes and a dozen queries per tick.
 *
 * Two queries: the recent crawl runs, and a count of the page audits chasing
 * this crawl. Returns null when nothing is in flight, which is the usual answer
 * and renders nothing.
 */
async function liveCrawlStatus(projectId) {
  const runs = await recentCrawlRuns(projectId);
  if (!runs.some((r) => ['queued', 'running', 'paused'].includes(r.status))) return null;

  const { count, error } = await getSupabase()
    .from('project_module_runs')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'running')
    .in('module_key', moduleEvidence.PAGE_MODULE_KEYS);
  if (error) console.error('[projects.overview.liveCrawlStatus]', error.message);

  return crawlStatus(runs, Number(count) || 0);
}

/**
 * The Site Health percentage the crawl report publishes.
 *
 * Not invented here: this is the crawler's own figure, the same arithmetic the
 * report has always shown (client/src/components/crawlScope/crawlHelpers.js,
 * healthMetrics). §6.2 forbids inventing a scale, not reporting one that exists
 * — the same distinction that lets Hub and Spoke report Content Architect's mean
 * cluster health and On-Page its pass rate.
 *
 * Weighted by AFFECTED PAGES rather than by finding count, which is the part
 * worth understanding: one page with forty warnings is one page's worth of harm,
 * not forty. Errors cost 45 points of the site, warnings 22, notices 8, all
 * scaled by what share of the site they touch.
 *
 * The denominator has to be the crawler's own — HTML pages, falling back to all
 * rows — or this card and the report it links to would publish two different
 * numbers for one crawl, which is the single most damaging thing a dashboard can
 * do to its own credibility.
 *
 * `instances` is pre-fetched by the caller (crawl_run_finding_instances,
 * migration 0023 — full per-occurrence findings moved out of
 * crawl_runs.summary once that single-write embed started timing out on
 * large crawls) rather than read off `run` directly.
 *
 * @returns {{ score: number|null, affected: object, denominator: number }|null}
 */
function siteHealth(run, internalHtmlCount = null, instances = []) {
  // Falls back to run.summary.findings when the caller didn't pre-fetch
  // instances (or a run predates migration 0023 and has none stored under
  // its own id) — same fallback findingInstancesForRun/loadRunFindings
  // already use, kept here too so this function stays correct on its own
  // rather than depending on every caller remembering the fallback.
  const effectiveInstances = instances.length
    ? instances
    : Array.isArray(run?.summary?.findings) ? run.summary.findings : [];

  // The internal HTML page count, and nothing else.
  //
  // This used to be Math.max(htmlCount, resultCount), which quietly restored
  // every external page the previous line had just excluded — resultCount counts
  // all 86 fetched URLs, external ones included. Both terms are gone: the
  // denominator is now exactly the set of pages that could have produced a
  // finding, which is what makes the share meaningful.
  //
  // A caller that could not count (null) gets no score rather than a score over
  // a guessed denominator.
  const denominator = Number(internalHtmlCount) > 0 ? Number(internalHtmlCount) : 0;

  // No pages means nothing was measured. Null, never 0: a health score of zero
  // describes a catastrophic site, not an absent crawl (§16.11).
  if (!denominator) return null;

  const affectedPages = (severity) => new Set(
    effectiveInstances.filter((f) => f.severity === severity && f.url).map((f) => f.url),
  ).size;

  const error = affectedPages('error');
  const warning = affectedPages('warning');
  const notice = affectedPages('notice');

  // A crawl stored before per-instance findings existed has counts but no urls,
  // so the shares cannot be computed. Withheld rather than reported as 100%,
  // which is what an empty instance list would otherwise produce.
  if (!effectiveInstances.length && (Number(run?.summary?.counts?.error) || Number(run?.summary?.counts?.warning))) {
    return null;
  }

  return {
    score: Math.max(0, Math.round(
      100
      - (error / denominator) * 45
      - (warning / denominator) * 22
      - (notice / denominator) * 8,
    )),
    affected: { error, warning, notice },
    denominator,
  };
}

// Versioned, because the denominator changed. A stored score and the sentence
// explaining it have to stay readable together after the formula moves.
const SITE_HEALTH_BASIS = 'the site crawl\'s own health score (v2, internal pages only): 100 '
  + 'less 45 points scaled by the share of internal pages with an error, 22 by pages with a '
  + 'warning and 8 by pages with a notice. External pages the crawler followed are excluded '
  + 'from both the findings and the denominator, so the score describes the site you own';

function technicalCard(runs, findings, internalPages = null, internalHtmlPages = null, findingInstances = []) {
  const module = MODULES[0];
  const terminal = runs.find((r) => ['completed', 'stopped'].includes(r.status));
  const inFlight = runs.find((r) => ['queued', 'running', 'paused'].includes(r.status));

  // A crawl in progress is the most useful thing this card can say, and it was
  // only ever said when there was no earlier crawl to show instead — so a running
  // crawl was invisible on any project that had crawled before, which is every
  // project after its first day. The same shape of bug the module cards had.
  const health = crawlHealth(inFlight);
  if (health) {
    const crawled = Number(inFlight.progress?.crawled);
    const discovered = Number(inFlight.progress?.discovered);
    const hasProgress = Number.isFinite(crawled) && crawled > 0;

    return {
      ...module,
      // A stalled crawl is not "running" — saying so would be the same lie as a
      // card that reports a failed run as healthy.
      status: health.state === 'stalled' ? 'completed_with_errors' : 'running',
      scored: false,
      score: null,
      headline: health.state === 'pending'
        ? 'Crawl queued'
        : health.state === 'stalled'
          ? 'Crawl stopped responding'
          : hasProgress
            ? `Crawling · ${crawled} page${crawled === 1 ? '' : 's'} so far`
            : 'Crawl starting',
      detail: health.state === 'pending'
        ? 'Waiting for a crawl worker to pick it up. Nothing is wrong yet; this is queue time.'
        : health.state === 'stalled'
          // The one state the product hid completely. A dead crawl looked exactly
          // like a slow one, and the only way to tell was to read the heartbeat
          // column by hand.
          ? `No heartbeat for ${health.silentMinutes} minute(s), so the process running it has `
            + 'stopped. It is reclaimed automatically within ten minutes, or you can re-run it now.'
          : Number.isFinite(discovered)
            ? `${crawled || 0} of ${discovered} discovered page(s) crawled so far.`
            : 'Findings appear here as soon as the crawl reaches a terminal state.',
      crawlState: health.state,
      updatedAt: inFlight.started_at || inFlight.created_at,
      // The previous crawl's run id, so "View report" still reaches the last real
      // result rather than an empty in-progress one.
      runId: terminal?.id || inFlight.id,
      // No evidence block: this crawl has measured nothing yet, and the previous
      // crawl's counts presented on a card about this one would be misread.
      evidence: null,
      previousRunId: terminal?.id || null,
    };
  }

  if (!terminal) {
    return {
      ...module,
      status: 'not_run',
      scored: false,
      score: null,
      headline: 'No crawl yet',
      detail: 'Run a crawl to populate technical findings for this project.',
      updatedAt: null,
      runId: null,
      evidence: null,
    };
  }

  const counts = terminal.summary?.counts || {};
  const errors = Number(counts.error) || 0;
  const warnings = Number(counts.warning) || 0;
  const notices = Number(counts.notice) || 0;
  const results = Number(terminal.summary?.resultCount) || 0;
  const pages = Number.isFinite(internalPages) && internalPages !== null ? internalPages : null;
  const external = pages === null ? null : Math.max(0, results - pages);

  const top = [...findings]
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || b.count - a.count)
    .slice(0, 4)
    .map((f) => ({
      ruleId: f.rule_id,
      title: f.detail?.title || f.rule_id,
      severity: f.severity,
      category: f.category,
      count: f.count,
    }));

  // The crawler publishes a health score on its own report. The card said
  // "no rubric" and showed an em dash next to it for months.
  //
  // Named siteScore, not health: `health` is already taken in this function by
  // crawlHealth(), which answers a different question — is the crawl process
  // alive — and two things called health in one scope is how you get a card that
  // reports liveness as a quality score.
  const siteScore = siteHealth(terminal, internalHtmlPages, findingInstances);

  return {
    ...module,
    status: displayRunStatus(terminal),
    scored: siteScore !== null,
    score: siteScore === null ? null : siteScore.score,
    scoreBasis: siteScore === null ? null : SITE_HEALTH_BASIS,
    headline: errors
      ? `${errors} error-level ${errors === 1 ? 'finding' : 'findings'}`
      : warnings
        ? `${warnings} warning-level ${warnings === 1 ? 'finding' : 'findings'}`
        : 'No error or warning findings',
    // Anchored to a named crawl.
    //
    // A project accumulates crawls — the live one has six completed, with warning
    // counts of 310, 311, 309, 308, 253 and 314 — and this card reads the newest.
    // Without saying which, opening any other run from the activity list shows
    // different numbers for what looks like the same audit, and the product
    // appears to disagree with itself. It never did; it just never said.
    detail: [
      pages === null
        ? `${results.toLocaleString('en-US')} URL${results === 1 ? '' : 's'} checked`
        : `${pages.toLocaleString('en-US')} page${pages === 1 ? '' : 's'} crawled`
          + (external ? ` · ${external.toLocaleString('en-US')} external link${external === 1 ? '' : 's'} checked` : ''),
      `${errors} error`,
      `${warnings} warning`,
      `${notices} notice`,
      crawlLabel(terminal),
    ].filter(Boolean).join(' · '),
    updatedAt: terminal.finished_at || terminal.created_at,
    runId: terminal.id,
    evidence: {
      counts: { error: errors, warning: warnings, notice: notices, info: Number(counts.info) || 0 },
      // Kept distinct: pagesCrawled is what maxUrlsPerCrawl caps, resultCount is
      // every stored row including outbound link checks.
      pagesCrawled: pages,
      externalChecked: external,
      resultCount: results,
      robotsStatus: terminal.summary?.robotsStatus || null,
      topFindings: top,
    },
  };
}

/**
 * A card for a module that HAS stored evidence (project_module_runs).
 *
 * The score, if any, is the one the module itself computed and stored alongside
 * the methodology that produced it. Nothing is recomputed here and nothing is
 * averaged into existence: a module that does not score (on-page, competitor)
 * shows severity counts and an em dash, exactly as CrawlScope does.
 */
/**
 * One line, for a card.
 *
 * Cards are read at a glance, in a grid, next to five others. A note that runs to
 * six lines is not more informative there — it buries the findings underneath it
 * and makes every card a different height. The full text still travels as `note`
 * and is shown in full on the module's own page.
 */
function cardLine(text, max = 96) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (clean.length <= max) return clean;
  // Cut on a word, never mid-word, and mark that it was cut.
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function evidenceCard(module, entry) {
  const terminal = entry?.terminal || null;
  const inFlight = entry?.inFlight || null;
  const progress = entry?.progress || null;

  // A run in flight is the most useful thing this card can say, and it used to be
  // reported only when there was no earlier run to show instead. So a module that
  // had failed last week and was working right now displayed "Run failed" for the
  // twenty minutes it took to succeed — the card looked broken exactly while it
  // was working, and the only way to know otherwise was to query the database.
  //
  // The previous result is not thrown away: it is named underneath, because
  // "running, and last time it failed" is different from "running for the first
  // time" and a reader deserves both.
  if (inFlight) {
    const done = Number(progress?.done) || 0;
    const failedPages = Number(progress?.failed) || 0;
    const started = inFlight.started_at || inFlight.created_at;

    // The crawl this run is following, when it is following one. A run with zero
    // pages audited has two completely different explanations — the crawl has not
    // started yet, or it started and something is wrong — and the card used to
    // say "Starting the first page" for both, which is only true of one of them.
    const followed = entry?.followedCrawl || null;

    // The average of the pages finished so far, shown live rather than withheld
    // until the run ends. It said "this module reports findings, not a 0-100
    // score" for twenty-eight minutes while computing a score per page.
    //
    // Null for On-Page, which genuinely has no rubric: a running average of
    // nothing is not zero.
    const runningMean = Number.isFinite(Number(progress?.mean)) && progress?.mean !== null
      ? Number(progress.mean)
      : null;
    const scoredPages = Number(progress?.scored) || 0;

    return {
      ...module,
      status: 'running',
      scored: runningMean !== null,
      score: runningMean,
      // Every score on this dashboard carries the basis it was computed from, and
      // a moving one has to say that it is moving.
      scoreBasis: runningMean === null
        ? null
        : `Mean of the ${scoredPages} page${scoredPages === 1 ? '' : 's'} scored so far. `
          + 'This run is still going, so it will move.',
      headline: done
        ? (runningMean !== null
          // The number first, the way a finished card reads, so the two do not
          // look like different kinds of result.
          ? `${runningMean}/100 · ${done} page${done === 1 ? '' : 's'} so far`
          : `Running · ${done} page${done === 1 ? '' : 's'} audited`)
        : followed?.state === 'pending'
          ? 'Waiting for the crawl to start'
          : followed?.state === 'stalled'
            ? 'The crawl it is following has stopped'
            : `${module.label} running`,
      // No percentage. The denominator moves while the crawl is still finding
      // pages, and a percentage of an unknown total is a made-up number.
      detail: [
        done
          ? `${done} page${done === 1 ? '' : 's'} audited so far`
          // Each of these says what is actually happening, so nobody has to read
          // the database to find out why nothing has been audited yet.
          : followed?.state === 'pending'
            ? 'These audits run on the pages the crawl finds, and it is still queued. '
              + 'Nothing has been audited yet because there is nothing to audit yet.'
            : followed?.state === 'stalled'
              ? `The crawl stopped responding ${followed.silentMinutes} minute(s) ago, so no `
                + 'pages are arriving. It is reclaimed automatically within ten minutes.'
              : 'Auditing the first page',
        failedPages ? `${failedPages} page${failedPages === 1 ? '' : 's'} failed` : null,
        terminal
          ? (terminal.status === 'failed'
            ? 'The previous run failed; this one replaces it.'
            : 'Findings below are from the previous run until this one finishes.')
          : null,
      ].filter(Boolean).join(' · '),
      updatedAt: started,
      moduleRunId: inFlight.id,
      // Kept so the report can be opened mid-run and show the pages already done.
      inFlightRunId: inFlight.id,
      progress: { done, failed: failedPages, scored: scoredPages, mean: runningMean },
      // So the client can distinguish "waiting" from "working" without parsing
      // the headline it was given.
      waitingOnCrawl: followed?.state === 'pending' || followed?.state === 'stalled',
      note: null,
      reportRef: terminal?.reportRef || null,
      error: null,
      // The previous run's evidence, explicitly labelled as previous above. Null
      // when the last run failed, for the same reason a failed card carries none.
      evidence: terminal && terminal.status !== 'failed' && Array.isArray(terminal.findings)
        ? {
          counts: terminal.counts || {},
          topFindings: [],
          findingCount: terminal.findings.length,
          targetUrl: terminal.target_url,
          scoreBasis: terminal.score_basis || null,
          fromPreviousRun: true,
        }
        : null,
    };
  }

  if (!terminal) {
    return {
      ...module,
      status: inFlight ? 'running' : 'not_run',
      scored: false,
      score: null,
      headline: inFlight ? `${module.label} running` : 'Not run for this project yet',
      detail: inFlight
        ? 'Findings appear here as soon as the run finishes.'
        : `Run it to store ${module.label.toLowerCase()} evidence against this project.`,
      updatedAt: inFlight?.started_at || null,
      moduleRunId: inFlight?.id || null,
      evidence: null,
    };
  }

  const counts = terminal.counts || {};
  const errors = Number(counts.error) || 0;
  const warnings = Number(counts.warning) || 0;
  const notices = Number(counts.notice) || 0;
  const findings = Array.isArray(terminal.findings) ? terminal.findings : [];

  const score = terminal.score === null || terminal.score === undefined
    ? null
    : Number(terminal.score);
  const scored = Number.isFinite(score);

  // Guard against a non-string band reaching a headline as "[object Object]" or
  // as raw JSON — one module already stored a { label, blurb } object here.
  const band = typeof terminal.band === 'string' && terminal.band.trim()
    ? (terminal.band.trim().startsWith('{') ? null : terminal.band.trim())
    : null;

  const top = [...findings]
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || b.count - a.count)
    .slice(0, 4)
    .map((f) => ({
      ruleId: f.ruleId,
      title: f.title,
      severity: f.severity,
      category: f.category,
      count: f.count,
    }));

  // 'insufficient_data' is a real answer, not a failure: the module ran and
  // found it had nothing to measure. Saying "no competitors tracked" beats
  // showing a zero.
  const insufficient = terminal.status === 'insufficient_data';

  return {
    ...module,
    status: terminal.status === 'completed' && errors > 0 ? 'completed_with_errors' : terminal.status,
    scored,
    score: scored ? score : null,
    scoreBasis: terminal.score_basis || null,
    band,
    // A failed run gets its own headline. Without this it fell through to the
    // zero-counts branch and announced "No error or warning findings" — which
    // reads as a clean bill of health for a run that never produced one.
    headline: terminal.status === 'failed'
      ? 'Run failed'
      : insufficient
      ? 'Nothing to measure yet'
      : scored
        ? `${Math.round(score)}/${Number(terminal.score_max) || 100}${band ? ` · ${band}` : ''}`
        : errors
          ? `${errors} error-level ${errors === 1 ? 'finding' : 'findings'}`
          : warnings
            ? `${warnings} warning-level ${warnings === 1 ? 'finding' : 'findings'}`
            : 'No error or warning findings',
    // The module's own note first: it names what is missing and what to do about
    // it. The generic sentences below are the fallback for a run that recorded no
    // explanation, not the default.
    // A run that was interrupted says so in a chip, not in a paragraph.
    partial: Boolean(terminal.interrupted === 'true' || terminal.interrupted === true),
    detail: terminal.status === 'failed'
      ? cardLine(terminal.error) || 'The run failed without recording a reason.'
      : terminal.cardNote
      ? cardLine(terminal.cardNote)
      : terminal.note
      ? cardLine(terminal.note)
      : insufficient
        ? (terminal.findings?.length
          ? `${terminal.findings.length} recorded, but no comparison is possible yet.`
          : 'The module ran and found nothing it could measure for this project.')
        : [
          terminal.target_url ? `Audited ${terminal.target_url}` : null,
          `${errors} error`,
          `${warnings} warning`,
          `${notices} notice`,
        ].filter(Boolean).join(' · '),
    updatedAt: terminal.finished_at || terminal.created_at,
    moduleRunId: terminal.id,
    note: terminal.note || null,
    // The id this module's own report is keyed by, when it has one. The card's
    // Open button uses it to go straight to that report.
    reportRef: terminal.reportRef || null,
    error: terminal.status === 'failed' ? terminal.error : null,
    // A failed run measured nothing, so it has no evidence — and an evidence
    // block full of zeros is the exact mistake §16.11 forbids: the card rendered
    // "0 errors, 0 warnings" for a run that never produced a finding, which reads
    // as a clean bill of health for an audit that did not happen. It also made
    // `evidence` truthy, so the button promised "View report" for a report that
    // does not exist.
    evidence: terminal.status === 'failed' || (insufficient && !findings.length) ? null : {
      counts: {
        error: errors, warning: warnings, notice: notices, info: Number(counts.info) || 0,
      },
      topFindings: top,
      findingCount: findings.length,
      targetUrl: terminal.target_url,
      scoreBasis: terminal.score_basis || null,
    },
  };
}

/** A module with nothing project-scoped to read yet. Says so, and says why. */
function pendingCard(module) {
  return {
    ...module,
    status: 'not_run',
    scored: false,
    score: null,
    headline: 'Not connected to this project yet',
    detail: `This module runs standalone today. Project-scoped evidence lands in ${module.pendingPhase}.`,
    updatedAt: null,
    runId: null,
    evidence: null,
  };
}

/**
 * Alerts: derived from the latest terminal crawl's findings. Error severity
 * first, then warnings, ranked by how many URLs each affects — which is the
 * closest thing to "prevalence" available before phase 4's site_insights.
 */
function buildAlerts(runs, findings) {
  const alerts = [];

  const failed = runs.find((r) => r.status === 'failed');
  if (failed) {
    alerts.push({
      severity: 'error',
      title: 'Last crawl failed',
      detail: failed.error || 'The crawl ended without producing a usable inventory.',
      at: failed.finished_at || failed.created_at,
      source: 'crawl_runs',
      runId: failed.id,
    });
  }

  for (const finding of findings) {
    if (!['error', 'warning'].includes(finding.severity)) continue;
    alerts.push({
      severity: finding.severity,
      title: finding.detail?.title || finding.rule_id,
      detail: `${finding.count} affected URL${finding.count === 1 ? '' : 's'} · ${finding.category || 'uncategorised'}`,
      at: null,
      source: 'crawl_run_findings',
      ruleId: finding.rule_id,
      affectedUrls: finding.count,
    });
    if (alerts.length >= 8) break;
  }

  return alerts;
}

function buildActivity(crawlRuns, toolRuns) {
  const rows = [
    ...crawlRuns.map((r) => ({
      id: r.id,
      kind: 'crawl',
      module: 'Site crawl',
      status: displayRunStatus(r),
      at: r.finished_at || r.started_at || r.created_at,
      label: r.trigger === 'schedule' ? 'Scheduled crawl' : 'Manual crawl',
      href: `/crawl-scope/runs/${r.id}`,
    })),
    ...toolRuns.map((r) => ({
      id: r.id,
      kind: 'tool',
      module: r.tool_id,
      status: r.status,
      at: r.completed_at || r.created_at,
      label: r.label || r.action || null,
      actor: r.actor_email || null,
      href: '/runs',
    })),
  ];

  return rows
    .filter((r) => r.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 14);
}

/**
 * Composite: the mean of the modules that actually produced a score. With none
 * scored — which is today's state — it is null, not zero, and carries the count
 * so the UI can say "0 of 6 modules scored" instead of showing a 0/100 ring
 * that reads as a catastrophic site (PRD §5.2: no single master score, and
 * §16.11: never coerce missing into zero).
 */
function buildComposite(modules) {
  const scored = modules.filter((m) => m.scored && Number.isFinite(m.score));
  if (!scored.length) {
    return { value: null, scoredModules: 0, totalModules: modules.length, status: 'insufficient_data' };
  }
  const mean = scored.reduce((sum, m) => sum + m.score, 0) / scored.length;
  return {
    value: Math.round(mean),
    scoredModules: scored.length,
    totalModules: modules.length,
    status: scored.length === modules.length ? 'complete' : 'partial',
  };
}

/**
 * @param {object} params
 * @param {object} params.access resolved by services/projectAccess.requireProject
 */
async function buildOverview({ access }) {
  if (!isSupabaseConfigured()) {
    throw Object.assign(new Error('Project overview needs Supabase configured.'), { status: 503 });
  }

  const projectRow = access.project;
  const project = await store.getProject(projectRow);

  const crawlRuns = await recentCrawlRuns(projectRow.id);
  const latestTerminal = crawlRuns.find((r) => ['completed', 'stopped'].includes(r.status));
  const [findings, internalPages, internalHtmlPages, findingInstances, evidenceByModule, toolRuns] = await Promise.all([
    latestTerminal ? findingsForRun(latestTerminal.id) : Promise.resolve([]),
    latestTerminal ? internalPageCount(latestTerminal.id) : Promise.resolve(null),
    latestTerminal ? internalHtmlPageCount(latestTerminal.id) : Promise.resolve(null),
    latestTerminal ? findingInstancesForRun(latestTerminal.id) : Promise.resolve([]),
    moduleEvidence.latestByModule(projectRow.id).catch((e) => {
      // A card that can't read its evidence must fall back to "not run", never
      // to a made-up value.
      console.error('[projects.overview.moduleEvidence]', e.message);
      return new Map();
    }),
    recentToolRuns(projectRow.workspace_id).catch((e) => {
      // The activity table is a nicety; the audit profile is the point. A
      // failure here must not blank the whole dashboard.
      console.error('[projects.overview.toolRuns]', e.message);
      return [];
    }),
  ]);

  // Which card shape each module gets is decided by what is stored, not by a
  // hardcoded list: a module becomes "live" the moment it has evidence, and
  // falls back to naming its phase when it has none.
  // Progress for anything currently running. One small count query per in-flight
  // per-page module, and only when something is actually in flight — the common
  // case is none, and then this costs nothing.
  await Promise.all(
    [...evidenceByModule.entries()]
      .filter(([key, entry]) => entry?.inFlight && moduleEvidence.PAGE_MODULE_KEYS.includes(key))
      .map(async ([, entry]) => {
        entry.progress = await moduleEvidence.pageRunProgress(entry.inFlight.id)
          .catch(() => null);

        // The crawl this run is following, so a card with nothing audited yet can
        // say WHY. latestByModule projects only two payload fields, so the id is
        // read explicitly for the few runs that are actually in flight.
        const followedId = await moduleEvidence.followedCrawlRunId(entry.inFlight.id)
          .catch(() => null);
        if (!followedId) return;
        const followed = crawlRuns.find((r) => r.id === followedId);
        entry.followedCrawl = followed ? crawlHealth(followed) : null;
      }),
  );

  const modules = [
    technicalCard(crawlRuns, findings, internalPages, internalHtmlPages, findingInstances),
    ...MODULES.slice(1).map((module) => {
      const entry = evidenceByModule.get(module.key);
      if (entry && (entry.terminal || entry.inFlight)) return evidenceCard(module, entry);
      return module.runnable ? evidenceCard(module, null) : pendingCard(module);
    }),
  ];

  // Counted from the same evidence the cards were built from, so the bar and the
  // cards cannot disagree about how many audits are chasing this crawl.
  const followers = [...evidenceByModule.values()]
    .filter((e) => e?.inFlight && e.followedCrawl).length;

  return {
    project,
    role: access.role,
    capabilities: access.capabilities,
    crawlStatus: crawlStatus(crawlRuns, followers),
    modules,
    composite: buildComposite(modules),
    alerts: buildAlerts(crawlRuns, findings),
    activity: buildActivity(crawlRuns, toolRuns),
    generatedAt: new Date().toISOString(),
    // Named so the UI can render the honest empty state rather than guessing
    // why a card is blank.
    notes: {
      liveModules: modules.filter((m) => m.live).map((m) => m.key),
      pendingModules: modules.filter((m) => !m.live).map((m) => ({ key: m.key, phase: m.pendingPhase })),
    },
  };
}

module.exports = {
  MODULES,
  RUN_STATUS_DISPLAY,
  displayRunStatus,
  // Exported for moduleDetail.js, which builds the expanded per-module view from
  // the same reads the dashboard uses — so a card and its page cannot disagree.
  recentCrawlRuns,
  findingsForRun,
  findingInstancesForRun,
  internalPageCount,
  internalHtmlPageCount,
  technicalCard,
  siteHealth,
  SITE_HEALTH_BASIS,
  cardLine,
  crawlLabel,
  crawlHealth,
  crawlStatus,
  liveCrawlStatus,
  STALE_HEARTBEAT_MS,
  evidenceCard,
  pendingCard,
  buildAlerts,
  buildActivity,
  buildComposite,
  buildOverview,
};
