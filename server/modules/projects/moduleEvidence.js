// ── Project-scoped module evidence (PRD phase 3) ─────────────────────────────
//
// The one place a non-CrawlScope module's result becomes something a project
// dashboard can read. Backed by project_module_runs (migration 0012).
//
// Three rules this file exists to enforce, in one place rather than four:
//
//   1. A score is the MODULE'S OWN, or it is null. `scoreBasis` names the
//      methodology in words and is required whenever a score is present, so a
//      number on the dashboard can always be traced to something that computed
//      it. PRD §6.2 forbids inventing a new scoring methodology here, and a
//      module without a rubric (on-page, competitor) stores null — never zero,
//      which §16.11 also forbids.
//
//   2. A run is recorded BEFORE the work starts and closed out after, so a
//      module that crashes or a server that restarts leaves a 'running' row that
//      the sweeper can fail honestly. The alternative — write only on success —
//      makes a crash indistinguishable from never having run.
//
//   3. Findings are normalised to the same shape crawl_run_findings uses
//      ({ ruleId, title, severity, category, count, detail }), so one card
//      component renders CrawlScope and every other module without branching.

const db = require('../../services/db');
const auditEvents = require('../../services/auditEvents');

// 'ai_visibility_prompts' is not a module with a card and a score — it is the
// prompt-set GENERATION job (server/modules/aiVisibility/generate.js), which
// spends money over minutes just like a module run and reuses this table's
// start/complete/fail machinery for exactly that reason. It is deliberately
// absent from moduleRunners.RUNNABLE / DEFAULT_AUDIT_MODULES / overview.MODULES
// — the only door to it is the aiVisibility router, not the generic
// POST /api/projects/:id/modules/:key/run route (which only requires
// 'startRun', a capability contributors hold; generation needs
// 'editProjectSettings').
const MODULE_KEYS = ['seo_geo', 'agent_readiness', 'competitor', 'hub_spoke', 'ai_visibility', 'ai_visibility_prompts',
  // The API-based sibling of ai_visibility (modules/aiVisibilityLite). Separate
  // keys so its runs, its evidence and its 30-run budget stay independent of
  // the scraped module's — the two measure different things and a shared key
  // would merge them on the dashboard.
  'ai_visibility_lite', 'ai_visibility_lite_setup'];
const TERMINAL = ['completed', 'failed', 'cancelled', 'insufficient_data'];

// A stored payload holds the module's OWN report, so its page can render exactly
// what an individual run renders rather than a summary of it.
//
// Sized from measurement, not guesswork: a SEO & GEO result with 252 checks and
// its AI analysis is ~94 KB, an on-page audit ~33 KB, agent readiness ~11 KB.
// The cap sits well above the largest of those so a site with more checks than
// this one does not silently lose its report — trimPayload replaces the WHOLE
// payload with a stub, which would leave the page with nothing to show.
//
// Cheap to carry: the dashboard never reads this column (latestByModule projects
// only payload->>note), so the size is paid for once, by the one page that wants
// the full report.
const MAX_PAYLOAD_CHARS = 400_000;

// Severity vocabulary shared with CrawlScope, so counts mean the same thing on
// every card. Anything a module reports outside this set is mapped, not dropped.
const SEVERITIES = ['error', 'warning', 'notice', 'info'];

function fail(where, error) {
  throw new Error(`[moduleEvidence.${where}] ${error.message || error}`);
}

function notConfigured() {
  return Object.assign(
    new Error('Module evidence needs the database configured (DATABASE_URL).'),
    { status: 503, code: 'not_configured' },
  );
}

/** Maps a module's own severity word onto the shared vocabulary. */
function normalizeSeverity(value) {
  const v = String(value || '').toLowerCase();
  if (['error', 'fail', 'failed', 'critical', 'blocker'].includes(v)) return 'error';
  if (['warning', 'warn', 'medium', 'moderate'].includes(v)) return 'warning';
  if (['notice', 'low', 'minor', 'info_needed', 'manual'].includes(v)) return 'notice';
  if (['info', 'pass', 'passed', 'ok', 'good'].includes(v)) return 'info';
  return 'notice';
}

/**
 * Normalises one finding. `count` is how many things the finding applies to —
 * URLs, pages, checks — and defaults to 1 rather than 0, because a finding that
 * applies to nothing should not have been reported.
 */
function normalizeFinding(raw, index) {
  const severity = normalizeSeverity(raw.severity ?? raw.status);
  const count = Number(raw.count);
  return {
    ruleId: String(raw.ruleId || raw.id || raw.checkId || `finding-${index + 1}`),
    title: String(raw.title || raw.label || raw.name || raw.ruleId || 'Finding'),
    severity,
    category: raw.category ? String(raw.category) : null,
    count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 1,
    detail: raw.detail ?? raw.description ?? raw.evidence ?? null,
    recommendation: raw.recommendation ?? raw.fix ?? null,
  };
}

/** Severity counts derived from the findings, so the two can never disagree. */
function countsFor(findings) {
  const counts = { error: 0, warning: 0, notice: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return counts;
}

function trimPayload(payload) {
  if (payload === undefined || payload === null) return { payload: null, truncated: false };
  try {
    const json = JSON.stringify(payload);
    if (json.length <= MAX_PAYLOAD_CHARS) return { payload, truncated: false };
    // Keep something usable rather than nothing: the top-level keys tell a
    // reader what was dropped, and the run is still linked to the module that
    // can regenerate it.
    return {
      payload: {
        _truncated: true,
        chars: json.length,
        keys: payload && typeof payload === 'object' ? Object.keys(payload) : null,
      },
      truncated: true,
    };
  } catch {
    return { payload: { _unserializable: true }, truncated: true };
  }
}

/**
 * Audits a module-run event from an access context.
 *
 * Not auditEvents.recordFor(): that one takes an Express `req` and reads
 * req.user.*, so handing it an access context would silently record an event
 * with no actor at all — a trail entry that says something happened but not who
 * did it is worse than useless in a review.
 *
 * Fire-and-forget, like the rest of the trail: a failed audit write must not
 * fail the module run the user asked for.
 */
function auditRun(access, action, extra) {
  auditEvents.record({
    workspaceId:  access.workspaceId || access.project?.workspace_id || null,
    projectId:    access.project?.id || null,
    actorUserId:  access.userId || null,
    actorEmail:   access.actorEmail || null,
    actorRole:    access.role || null,
    action,
    source:       'projects.moduleEvidence',
    ...extra,
  });
}

function assertModuleKey(moduleKey) {
  if (!MODULE_KEYS.includes(moduleKey)) {
    throw Object.assign(
      new Error(`Unknown module: ${moduleKey}. Expected one of ${MODULE_KEYS.join(', ')}.`),
      { status: 400 },
    );
  }
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Opens a run row before the module does any work.
 *
 * @param {object}  input
 * @param {object}  input.access     from projectAccess.requireProject
 * @param {string}  input.moduleKey
 * @param {string} [input.targetUrl]
 * @param {string} [input.trigger]   'manual' | 'schedule' | 'audit_all'
 */
async function startRun({
  access, moduleKey, targetUrl = null, trigger = 'manual', pageBudget = null,
  followingCrawlRunId = null,
}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  assertModuleKey(moduleKey);

  const project = access.project;
  const allowance = allowanceMinutes(moduleKey, { pageBudget });

  let data;
  try {
    data = await db.insertOne('project_module_runs', {
      project_id: project.id,
      workspace_id: project.workspace_id || null,
      module_key: moduleKey,
      status: 'running',
      trigger,
      target_url: targetUrl,
      country_code: project.country_code || null,
      created_by: access.userId || null,
      // The run carries its own clock. Written here, at the only moment the page
      // budget is known for certain, so raising the budget later cannot make the
      // sweeper kill work that is legitimately still running. Replaced by the
      // real payload when the run completes, which is exactly when it stops
      // mattering.
      payload: {
        deadlineAt: new Date(Date.now() + allowance * 60_000).toISOString(),
        allowanceMinutes: allowance,
        pageBudget: pageBudget ?? null,
        // The crawl this run is following, recorded when it opens so the
        // dashboard can explain a run that has audited nothing YET. Without it a
        // card cannot tell "waiting ten minutes for a queued crawl" from
        // "started and stuck", and it said "Starting the first page" for both.
        followingCrawlRunId,
      },
    });
  } catch (error) {
    fail('startRun', error);
  }

  auditRun(access, auditEvents.ACTIONS.MODULE_RUN_STARTED, {
    entityType: 'project_module_run',
    entityId: data.id,
    newState: { moduleKey, targetUrl, trigger },
  });

  return data;
}

/**
 * Closes a run with its result.
 *
 * `score` must be accompanied by `scoreBasis`; passing a score without one is a
 * programming error here rather than a DB error later, because the check
 * constraint's message would not say why it matters.
 */
async function completeRun({
  access, runId, score = null, scoreMax = 100, scoreBasis = null, band = null,
  findings = [], payload = null, status = 'completed',
}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const hasScore = score !== null && score !== undefined && Number.isFinite(Number(score));
  if (hasScore && !scoreBasis) {
    throw new Error(
      '[moduleEvidence.completeRun] a score needs a scoreBasis naming the methodology that '
      + 'produced it — an unattributable number on a dashboard cannot be defended later (PRD §6.2).',
    );
  }

  const normalized = (Array.isArray(findings) ? findings : []).map(normalizeFinding);
  const { payload: trimmed, truncated } = trimPayload(payload);

  let data;
  try {
    const rows = await db.updateWhere('project_module_runs', {
      status,
      score: hasScore ? Number(score) : null,
      score_max: hasScore ? Number(scoreMax) : null,
      score_basis: hasScore ? scoreBasis : null,
      band,
      counts: countsFor(normalized),
      findings: normalized,
      payload: trimmed,
      payload_truncated: truncated,
      finished_at: new Date().toISOString(),
    }, { id: runId }, { returning: '*' });
    if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
    [data] = rows;
  } catch (error) {
    fail('completeRun', error);
  }

  auditRun(access, auditEvents.ACTIONS.MODULE_RUN_COMPLETED, {
    entityType: 'project_module_run',
    entityId: runId,
    newState: {
      status,
      score: data.score,
      scoreBasis: data.score_basis,
      findings: normalized.length,
    },
  });

  return data;
}

/**
 * Re-derives a per-page run's rollup from its page runs, in place.
 *
 * The displayed score for these three modules is the arithmetic mean of the
 * pages in the report. That was true at the moment the run closed and then
 * stopped being true the second anyone added a page to it: the child row was
 * written, the parent kept the old average, and the report showed a mean that
 * did not match the pages listed under it.
 *
 * So adding, re-running or removing a page calls this, and the parent is
 * recomputed from the children rather than adjusted. Recomputing is the only
 * version that cannot drift — an incremental update has to get the arithmetic
 * right every time, this one only has to read the rows.
 *
 * @param {string} runId
 * @param {string} basis  the methodology sentence for one page's score (§6.2)
 */
async function refreshRunAggregate(runId, { basis = null } = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const pageRuns = await pageRunsForRun(runId);
  const rollup = aggregatePages(pageRuns);
  const normalized = (rollup.findings || []).map(normalizeFinding);

  let current;
  try {
    current = await db.maybeOne(
      `select payload, score_basis from project_module_runs where id = $1`, [runId]);
  } catch (error) {
    fail('refreshRunAggregate(read)', error);
  }

  const hasScore = rollup.mean !== null;
  // Keep the run's own basis sentence when the caller has not supplied one, so a
  // recompute never strips the attribution off an existing score.
  const scoreBasis = hasScore
    ? (basis
      ? `Mean of ${rollup.scoredPages} page score(s) from ${basis}`
      : current?.score_basis
        || `Mean of ${rollup.scoredPages} page score(s)`)
    : null;

  const payload = {
    ...(current?.payload || {}),
    pagesAudited: rollup.totalPages,
    pagesScored: rollup.scoredPages,
    pagesFailed: rollup.failedPages,
    pages: pageRuns.map((p) => ({
      pageRunId: p.id,
      url: p.url,
      status: p.status,
      score: p.score === null || p.score === undefined ? null : Number(p.score),
      band: p.band || null,
      counts: p.counts || {},
    })),
  };

  const { payload: trimmed, truncated } = trimPayload(payload);

  let data;
  try {
    const rows = await db.updateWhere('project_module_runs', {
      score: hasScore ? rollup.mean : null,
      score_max: hasScore ? 100 : null,
      score_basis: scoreBasis,
      band: `${rollup.totalPages} page${rollup.totalPages === 1 ? '' : 's'} audited`,
      counts: countsFor(normalized),
      findings: normalized,
      payload: trimmed,
      payload_truncated: truncated,
    }, { id: runId }, { returning: '*' });
    if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
    [data] = rows;
  } catch (error) {
    fail('refreshRunAggregate', error);
  }
  return { run: data, rollup };
}

/** Closes a run that threw. The message is stored; the stack is not. */
async function failRun({ access, runId, error: runError }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const message = String(runError?.message || runError || 'The module run failed.').slice(0, 2000);
  let data;
  try {
    data = await db.one(
      `update project_module_runs
          set status = 'failed', error = $1, finished_at = $2
        where id = $3
        returning *`,
      [message, new Date().toISOString(), runId]
    );
  } catch (error) {
    fail('failRun', error);
  }

  auditRun(access, auditEvents.ACTIONS.MODULE_RUN_FAILED, {
    entityType: 'project_module_run',
    entityId: runId,
    newState: { error: message },
  });

  return data;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The newest run per module for one project — what the audit profile reads.
 *
 * Returns a Map keyed by module_key. Both the newest terminal run and any run
 * still in flight are returned, because "running" is a state the card must be
 * able to show rather than looking like "never run".
 */
async function latestByModule(projectId, { limit = 120 } = {}) {
  if (!db.isDatabaseConfigured()) return new Map();

  // `note` and `reportRef` are projected out of the payload rather than
  // selecting the payload itself: a payload now runs to hundreds of kilobytes
  // (it holds the module's own report), and six of them per dashboard load to
  // read one sentence and one id would be absurd.
  //
  // That sentence is the whole point of the state — "Content Architect has no
  // project for this domain yet" is actionable where "insufficient data" is not.
  //
  // A Content Architect ref is kept only if its analysis still exists. Before
  // 0032 the analysis was a file on whichever machine ran the job, while the run
  // row went to the shared database, so a run done elsewhere names an analysis
  // that was never imported, and "View report" went to a 404. In that case the
  // ref becomes the analysis linked to this project now, the one the tool page's
  // "Open analysis" opens, so the card still goes straight to a report. With
  // neither, it is null and the card opens the tool page. Both lookups are in
  // this query rather than a second one, since the dashboard runs it on every
  // poll: a primary-key probe and a unique-index probe per hub_spoke row.
  // Competitor refs are left alone: that page already ignores an id it cannot
  // resolve.
  let data;
  try {
    data = await db.rows(
      `select id, module_key, status, trigger, target_url, country_code,
              score, score_max, score_basis, band, counts, findings, error,
              started_at, finished_at, created_at,
              payload->>'note' as "note",
              payload->>'cardNote' as "cardNote",
              payload->>'interrupted' as "interrupted",
              case
                when module_key = 'hub_spoke' then coalesce(
                  (select ca.id from content_architect_projects ca
                    where ca.id = runs.payload->>'reportRef'),
                  (select ca.id from content_architect_projects ca
                    where ca.platform_project_id = runs.project_id)
                )
                else payload->>'reportRef'
              end as "reportRef"
         from project_module_runs runs
        where project_id = $1
        order by created_at desc
        limit $2`,
      [projectId, limit]
    );
  } catch (error) {
    fail('latestByModule', error);
  }

  const byModule = new Map();
  for (const row of data) {
    const entry = byModule.get(row.module_key) || { terminal: null, inFlight: null };
    if (TERMINAL.includes(row.status)) {
      if (!entry.terminal) entry.terminal = row;
    } else if (!entry.inFlight) {
      entry.inFlight = row;
    }
    byModule.set(row.module_key, entry);
  }
  return byModule;
}

/** Run history for one module of one project, newest first. */
async function listRuns(projectId, moduleKey, { limit = 25 } = {}) {
  if (!db.isDatabaseConfigured()) return [];
  assertModuleKey(moduleKey);

  try {
    return await db.rows(
      `select * from project_module_runs
        where project_id = $1 and module_key = $2
        order by created_at desc
        limit $3`,
      [projectId, moduleKey, Math.min(Number(limit) || 25, 100)]
    );
  } catch (error) {
    fail('listRuns', error);
  }
}

async function getRun(projectId, runId) {
  if (!db.isDatabaseConfigured()) return null;
  try {
    // Scoped by project, not just by id: there is no RLS to fall back on.
    return await db.maybeOne(
      `select * from project_module_runs where project_id = $1 and id = $2`,
      [projectId, runId]
    );
  } catch (error) {
    fail('getRun', error);
  }
}

// ── How long a run is allowed to take ───────────────────────────────────────
//
// One global cutoff used to be fine: every module audited a single page and
// finished in under a minute, so anything open after 30 minutes was certainly
// dead. Making SEO & GEO, On-Page and Agent Readiness run across the crawl broke
// that premise without anyone revisiting the sweeper — at a measured ~130s per
// page, a healthy 10-page SEO & GEO run takes about 22 minutes, leaving eight
// minutes of headroom before the sweeper would kill a run that was still working.
// Raise the page budget to 20 and the sweeper reliably murders healthy runs and
// lets a second one start on top of them.
//
// So the allowance is derived from the work, per module, and each run records its
// own deadline at the moment it opens. Minutes per page, measured:
//
//   seo_geo          ~130s/page (200+ checks plus two Sonnet calls)
//   agent_readiness  well-known probes per page plus one Sonnet brief
//
// Rounded up generously: the cost of being too lenient is a dead row sitting
// 'running' for an extra hour, and the cost of being too strict is destroying
// work in progress and lying about it. Those are not symmetric.
const MINUTES_PER_PAGE = { seo_geo: 3, agent_readiness: 2 };

// Site-level modules do a fixed amount of work regardless of page count.
//
// ai_visibility is the outlier at 45 minutes, and it is not padding. Measured
// live: a single ChatGPT capture through DataForSEO's LLM Scraper took between
// 24 and 112 seconds, and a default run is 20 prompts across two surfaces. At
// the slow end that is well over half an hour of legitimate work, and the
// sweeper killing it would destroy captures already paid for and then report
// the client as unmeasured — the exact failure this module is built to avoid.
const FLAT_MINUTES = {
  // hub_spoke was 5. It now reads the site's sitemaps and walks its
  // informational listings, spends up to three minutes choosing pages
  // (SELECTION_AI_BUDGET_MS in contentArchitect/config.js), and fetches up to
  // DISCOVERY_MAX_FETCH of them before naming and relevance even start.
  hub_spoke: 15, competitor: 15, ai_visibility: 45, ai_visibility_prompts: 10,
  // The API module is the fast one, and that is its whole reason for existing.
  // 20 prompts x 3 providers, three providers answering in parallel per prompt,
  // a few seconds each: a full run lands around 3-5 minutes. 12 leaves room for
  // a provider having a slow day without being so loose that a genuinely hung
  // run sits at 'running' for half an hour.
  ai_visibility_lite: 12,
  // Reading the site and writing ten questions: a handful of page fetches and
  // two model calls.
  ai_visibility_lite_setup: 5,
};

// Queueing, cold starts, and a slow origin having a bad day.
const GRACE_MINUTES = 10;

// Used only for legacy rows that recorded no deadline of their own.
const FALLBACK_PAGE_BUDGET = 10;

/**
 * How long this module may take, in minutes, for a given page budget.
 *
 * Exported because the number has to be the same in three places: written onto
 * the run at start, used by the sweeper for rows that predate that, and asserted
 * in tests.
 */
function allowanceMinutes(moduleKey, { pageBudget = FALLBACK_PAGE_BUDGET } = {}) {
  const perPage = MINUTES_PER_PAGE[moduleKey];
  if (perPage) {
    const pages = Number.isFinite(Number(pageBudget)) && Number(pageBudget) > 0
      ? Number(pageBudget)
      : FALLBACK_PAGE_BUDGET;
    return Math.ceil(perPage * pages) + GRACE_MINUTES;
  }
  return (FLAT_MINUTES[moduleKey] || 30) + GRACE_MINUTES;
}

/**
 * Fails rows left 'running' past their own deadline — a server restart mid-run,
 * or a module that died without closing its row. Without this a crashed run sits
 * at 'running' forever and the card never returns to a truthful state.
 *
 * Each row is judged against the deadline it recorded when it opened, so a
 * 10-page audit and a 5-second one are not held to the same clock. Rows written
 * before deadlines existed fall back to their module's derived allowance.
 *
 * Deliberately reads and then decides in JS rather than filtering in SQL: the
 * number of open rows is tiny, and a per-row judgement is far easier to get right
 * than a jsonb comparison in a bulk update.
 */
async function sweepStaleRuns({ olderThanMinutes = null } = {}) {
  if (!db.isDatabaseConfigured()) return 0;

  let open;
  try {
    open = await db.rows(
      `select id, module_key, started_at, created_at, payload
         from project_module_runs
        where status = 'running'`
    );
  } catch (error) {
    console.error('[moduleEvidence.sweepStaleRuns]', error.message);
    return 0;
  }

  const now = Date.now();
  const overdue = [];

  for (const row of open) {
    const startedAt = Date.parse(row.started_at || row.created_at);
    if (!Number.isFinite(startedAt)) continue;   // no start time is not evidence of death

    const recorded = Date.parse(row.payload?.deadlineAt || '');

    // `Number(null)` is 0 and `Number.isFinite(0)` is true, so an unset override
    // read as an allowance of ZERO minutes and every open run was swept the
    // instant this ran — which is why a card said "failed after 5 minutes, past
    // this module's 40-minute allowance", a sentence that contradicts itself.
    //
    // Third time this exact coercion has bitten in this codebase. Written out
    // longhand rather than as a ternary chain, because the clever version is what
    // hid it.
    const hasOverride = olderThanMinutes !== null
      && olderThanMinutes !== undefined
      && Number.isFinite(Number(olderThanMinutes));

    // The allowance this row was actually given, for the message below.
    const rowAllowance = Number(row.payload?.allowanceMinutes)
      || allowanceMinutes(row.module_key);

    let deadline;
    let allowanceUsed;
    if (hasOverride) {
      allowanceUsed = Number(olderThanMinutes);
      deadline = startedAt + allowanceUsed * 60_000;
    } else if (Number.isFinite(recorded)) {
      // The deadline the run recorded when it opened.
      allowanceUsed = rowAllowance;
      deadline = recorded;
    } else {
      // A row written before deadlines existed.
      allowanceUsed = allowanceMinutes(row.module_key);
      deadline = startedAt + allowanceUsed * 60_000;
    }

    if (now <= deadline) continue;

    const minutes = Math.round((now - startedAt) / 60_000);
    overdue.push({
      id: row.id,
      moduleKey: row.module_key,
      minutes,
      allowanceUsed,
      // A forced sweep must not report itself as "the allowance was 0 minutes".
      // The run was given a real allowance; an operator chose to close it early,
      // and the message has to say which of those happened.
      forced: hasOverride,
      rowAllowance,
    });
  }

  if (!overdue.length) return 0;

  let closed = 0;
  for (const row of overdue) {
    // ── Salvage before failing ──────────────────────────────────────────────
    //
    // A per-page run that audited seven pages and then had its process killed is
    // not a failed run. It is a partial one, and marking it failed throws away
    // seven completed page reports that cost several minutes each to produce and
    // are still perfectly valid.
    //
    // Measured on this project: a restart mid-audit stranded 2, 2 and 3 completed
    // page audits under three parent runs that were all about to be marked
    // failed. Nothing was wrong with any of those seven reports.
    //
    // So: close it with what it actually got, and say plainly that it was
    // interrupted and how much of the intended work it covered. A partial result
    // labelled partial is useful; the same result labelled failed is discarded.
    const salvaged = await salvageInterruptedRun(row);
    if (salvaged) { closed += 1; continue; }

    // Says what was expected as well as what happened, so the next person does
    // not have to guess whether the cutoff was the problem.
    const message = row.forced
      ? `Closed by hand after ${row.minutes} minutes, before its `
        + `${row.rowAllowance}-minute allowance expired. No result had been recorded.`
      : `No result recorded after ${row.minutes} minutes, past the `
        + `${row.allowanceUsed}-minute allowance this run was given — the process running `
        + 'it stopped. A deploy or server restart mid-run is the usual cause.';
    try {
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `update project_module_runs
            set status = 'failed', error = $1, finished_at = $2
          where id = $3 and status = 'running'`,   // do not stomp a run that finished just now
        [message, new Date().toISOString(), row.id]
      );
    } catch (error) {
      console.error('[moduleEvidence.sweepStaleRuns]', error.message);
      continue;
    }
    closed += 1;
  }
  return closed;
}

/**
 * Close an interrupted per-page run with the pages it completed.
 *
 * @returns {Promise<boolean>} true when the run was salvaged, false when there
 *   was nothing to salvage and it should be failed instead.
 */
async function salvageInterruptedRun(row) {
  if (!PAGE_MODULE_KEYS.includes(row.moduleKey)) return false;

  const pageRuns = await pageRunsForRun(row.id).catch(() => []);
  const usable = pageRuns.filter((p) => p.status === 'completed');
  if (!usable.length) return false;   // nothing was finished; this really failed

  // pageRunsForRun deliberately omits findings, and the rollup needs them.
  let withFindings;
  try {
    withFindings = await db.rows(
      `select id, url, status, score, band, counts, findings
         from project_module_page_runs
        where run_id = $1 and status = 'completed'`,
      [row.id]
    );
  } catch (error) {
    console.error('[moduleEvidence.salvageInterruptedRun]', error.message);
    return false;
  }

  const rollup = aggregatePages(withFindings);
  const abandoned = pageRuns.filter((p) => p.status === 'running').length;

  const salvage = {
    // Completed, not failed: the pages it has are real measurements.
    status: 'completed',
    score: rollup.mean,
    score_max: 100,
    score_basis: rollup.mean === null
      ? null
      : `Mean of ${rollup.scoredPages} page score(s) from the ${row.moduleKey} audit, `
        + 'from a run that was interrupted before it finished',
    band: `${rollup.totalPages} page${rollup.totalPages === 1 ? '' : 's'} audited`,
    counts: rollup.counts,
    findings: rollup.findings,
      payload: {
      pagesAudited: rollup.totalPages,
      pagesScored: rollup.scoredPages,
      interrupted: true,
      pagesAbandonedMidAudit: abandoned,
      // One line, for a dashboard card. The full explanation below is for the
      // module's own page, where there is room for it. A caveat that takes six
      // lines on a card pushes the actual findings off the bottom and shouts
      // louder than the result it is qualifying.
      cardNote: `${rollup.totalPages} page(s) audited before the run was interrupted. `
        + 'Re-run for full coverage.',
      note: `This run was interrupted after ${row.minutes} minutes`
        + (row.forced
          ? ' and closed by hand.'
          : ' — the process running it stopped, usually a deploy or server restart.')
        + ` The ${rollup.totalPages} page(s) it had `
        + 'already finished are kept and are shown here; the rest of the site was not audited'
        + (abandoned ? `, and ${abandoned} page(s) were mid-audit when it stopped` : '')
        + '. Re-run it for full coverage.',
    },
    finished_at: new Date().toISOString(),
  };

  try {
    const cols = Object.keys(salvage);
    const jsonCols = new Set(['counts', 'findings', 'payload']);
    const params = cols.map((c) => (jsonCols.has(c) ? db.json(salvage[c]) : salvage[c]));
    params.push(row.id);
    await db.query(
      `update project_module_runs
          set ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')}
        where id = $${params.length} and status = 'running'`,
      params
    );
  } catch (error) {
    console.error('[moduleEvidence.salvageInterruptedRun]', error.message);
    return false;
  }

  console.log(
    `[moduleEvidence] salvaged ${row.moduleKey} run ${row.id}: kept `
    + `${rollup.totalPages} completed page audit(s) instead of discarding them.`,
  );
  return true;
}

// ── Per-page runs (migration 0014) ──────────────────────────────────────────
//
// SEO & GEO, On-Page and Agent Readiness audit one page at a time, so a project
// run has a child row per page holding that page's own report. The parent's
// score is the mean of theirs.

const PAGE_MODULE_KEYS = ['seo_geo', 'agent_readiness'];

/** Opens a page row before that page is audited. */
async function startPageRun({
  access, runId, moduleKey, url, ordinal = null, source = 'crawl', pageId = null,
}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  if (!PAGE_MODULE_KEYS.includes(moduleKey)) {
    throw Object.assign(
      new Error(`${moduleKey} is site-level and has no per-page reports.`),
      { status: 400 },
    );
  }

  try {
    return await db.insertOne('project_module_page_runs', {
      run_id: runId,
      project_id: access.project.id,
      module_key: moduleKey,
      url,
      ordinal,
      source,
      // The project_pages row this audit is about, where the inventory knows it.
      // Nullable: before migration 0015, and for a URL the crawl has not seen,
      // there is nothing to point at — and matching on the URL string later is
      // exactly the fragility project_pages exists to remove, so it is not
      // guessed at here.
      page_id: pageId,
      status: 'running',
    }, { returning: 'id' });
  } catch (error) {
    fail('startPageRun', error);
  }
}

/** Closes a page row with that page's own result. */
async function completePageRun({
  pageRunId, status = 'completed', score = null, scoreMax = 100, band = null,
  findings = [], payload = null, error: pageError = null,
}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const normalized = (Array.isArray(findings) ? findings : []).map(normalizeFinding);
  const { payload: trimmed, truncated } = trimPayload(payload);
  const hasScore = score !== null && score !== undefined && Number.isFinite(Number(score));

  try {
    const rows = await db.updateWhere('project_module_page_runs', {
      status,
      score: hasScore ? Number(score) : null,
      score_max: hasScore ? Number(scoreMax) : null,
      band,
      counts: countsFor(normalized),
      findings: normalized,
      payload: trimmed,
      payload_truncated: truncated,
      error: pageError ? String(pageError).slice(0, 2000) : null,
      finished_at: new Date().toISOString(),
    }, { id: pageRunId }, { returning: 'id, url, status, score, score_max, band, counts, findings' });
    if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
    return rows[0];
  } catch (error) {
    fail('completePageRun', error);
  }
}

/** True when the error is "that table does not exist yet". */
function isMissingTable(error) {
  return error?.code === '42P01'
    || error?.code === '42703'
    || /does not exist/i.test(error?.message || '');
}

// Logged once rather than per request, so a missing migration is visible in the
// log without burying everything else in it.
let warnedMissingPageRuns = false;

/**
 * Every page of one run, without the reports.
 *
 * Deliberately excludes `payload`: fifty SEO & GEO reports is several megabytes,
 * and this feeds a list of pages to choose from.
 *
 * A missing table returns no pages rather than throwing. Between this code
 * shipping and migration 0014 being applied, throwing here would take down the
 * whole module-detail endpoint — so every module page would show an error
 * instead of the stored report it already has. No pages is also the truth: there
 * are none.
 */
async function pageRunsForRun(runId) {
  if (!db.isDatabaseConfigured()) return [];
  try {
    return await db.rows(
      `select id, url, ordinal, status, score, score_max, band, counts,
              error, finished_at, payload_truncated
         from project_module_page_runs
        where run_id = $1
        order by ordinal asc`,
      [runId]
    );
  } catch (error) {
    if (isMissingTable(error)) {
      if (!warnedMissingPageRuns) {
        warnedMissingPageRuns = true;
        console.warn(
          '[moduleEvidence] project_module_page_runs is missing — apply migration '
          + '0014_module_page_runs.sql. Per-page reports are unavailable until then.',
        );
      }
      return [];
    }
    fail('pageRunsForRun', error);
  }
}

/**
 * How far an in-flight per-page run has got.
 *
 * Counted from the child rows rather than guessed from elapsed time, so the card
 * reports work that actually completed. No total: while the crawl is still
 * discovering pages the denominator genuinely moves, and inventing one would be
 * the same mistake as inventing a score.
 */
async function pageRunProgress(runId) {
  const empty = { done: 0, failed: 0, running: 0, scored: 0, mean: null };
  if (!db.isDatabaseConfigured()) return empty;
  let rows;
  try {
    rows = await db.rows(
      `select status, score from project_module_page_runs where run_id = $1`, [runId]);
  } catch (error) {
    if (isMissingTable(error)) return empty;
    console.error('[moduleEvidence.pageRunProgress]', error.message);
    return empty;
  }
  const completed = rows.filter((r) => r.status === 'completed');

  // The same null rule the finished rollup uses. Number(null) is 0 and
  // Number.isFinite(0) is true, so a page with no score would be averaged in as a
  // zero and drag a live average down — On-Page has no rubric at all, so EVERY
  // one of its pages is null and the mean must come out null rather than 0.
  const isScored = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
  const scored = completed.filter((r) => isScored(r.score));

  return {
    done: completed.length,
    failed: rows.filter((r) => r.status === 'failed').length,
    running: rows.filter((r) => r.status === 'running').length,
    scored: scored.length,
    // A running average over the pages finished so far. It moves as the run goes,
    // which is the point: a score that only appears at the end tells you nothing
    // for the twenty-eight minutes before that.
    mean: scored.length
      ? Math.round(scored.reduce((sum, r) => sum + Number(r.score), 0) / scored.length)
      : null,
  };
}

/**
 * Which crawl an in-flight run is following, if any.
 *
 * Recorded in the payload by startRun. Read on its own because the dashboard's
 * main query deliberately does not pull payloads — six 400KB blobs to draw six
 * cards — and only a run that is actually in flight needs this.
 */
async function followedCrawlRunId(runId) {
  if (!db.isDatabaseConfigured()) return null;
  try {
    const data = await db.maybeOne(
      `select payload from project_module_runs where id = $1`, [runId]);
    return data?.payload?.followingCrawlRunId || null;
  } catch (error) {
    console.error('[moduleEvidence.followedCrawlRunId]', error.message);
    return null;
  }
}

/** One page's stored report. Scoped by project — there is no RLS behind this. */
async function getPageRun(projectId, pageRunId) {
  if (!db.isDatabaseConfigured()) return null;
  try {
    return await db.maybeOne(
      `select * from project_module_page_runs where project_id = $1 and id = $2`,
      [projectId, pageRunId]
    );
  } catch (error) {
    fail('getPageRun', error);
  }
}

/**
 * Rolls a run's pages up into the parent's numbers.
 *
 * The mean covers only the pages that actually scored. A page that failed, or
 * that belongs to a module with no rubric, is absent from the average rather
 * than counted as zero — one unreachable page must not drag a site's score down
 * as though it had scored badly (§16.11).
 *
 * Findings are merged by rule so the parent says "12 pages are missing a meta
 * description" instead of listing the same rule twelve times; `pages` on each
 * one records which URLs it applied to.
 */
function aggregatePages(pageRuns) {
  // Number(null) is 0 and Number.isFinite(0) is true, so a null score would be
  // counted as a zero and drag the mean down — 90 and 70 with one unscored page
  // averaged to 53 instead of 80. The null check has to come first.
  const isScored = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
  const scored = pageRuns.filter((p) => isScored(p.score));
  const mean = scored.length
    ? Math.round(scored.reduce((sum, p) => sum + Number(p.score), 0) / scored.length)
    : null;

  const counts = { error: 0, warning: 0, notice: 0, info: 0 };
  const byRule = new Map();

  for (const page of pageRuns) {
    for (const [severity, n] of Object.entries(page.counts || {})) {
      if (counts[severity] !== undefined) counts[severity] += Number(n) || 0;
    }
    for (const finding of (Array.isArray(page.findings) ? page.findings : [])) {
      const key = finding.ruleId;
      const existing = byRule.get(key);
      if (existing) {
        existing.count += Number(finding.count) || 1;
        existing.pages.push(page.url);
      } else {
        byRule.set(key, {
          ...finding,
          count: Number(finding.count) || 1,
          pages: [page.url],
        });
      }
    }
  }

  const findings = [...byRule.values()]
    .map((f) => ({
      ...f,
      // How many pages the rule applies to, which is the number a site-level
      // reader wants — the per-page detail is a click away.
      pageCount: f.pages.length,
      pages: f.pages.slice(0, 25),
    }))
    // Severity first, then how much of the site it affects. Without this the
    // list is in Map insertion order — whatever the first page audited happened
    // to report first — and the card, which shows the top four, would lead with
    // notices while errors sat further down.
    .sort((a, b) => {
      const ra = SEVERITIES.indexOf(normalizeSeverity(a.severity));
      const rb = SEVERITIES.indexOf(normalizeSeverity(b.severity));
      if (ra !== rb) return ra - rb;
      if (a.pageCount !== b.pageCount) return b.pageCount - a.pageCount;
      return (b.count || 0) - (a.count || 0);
    });

  return {
    mean,
    scoredPages: scored.length,
    totalPages: pageRuns.length,
    failedPages: pageRuns.filter((p) => p.status === 'failed').length,
    counts,
    findings,
  };
}

module.exports = {
  PAGE_MODULE_KEYS,
  // Exported so a test can assert that `queued` is NOT terminal: that single
  // fact is what makes a freshly enqueued run read as in-flight on the
  // dashboard rather than as one that has already finished.
  TERMINAL,
  refreshRunAggregate,
  followedCrawlRunId,
  salvageInterruptedRun,
  pageRunProgress,
  allowanceMinutes,
  MINUTES_PER_PAGE,
  FLAT_MINUTES,
  GRACE_MINUTES,
  isMissingTable,
  startPageRun,
  completePageRun,
  pageRunsForRun,
  getPageRun,
  aggregatePages,
  MODULE_KEYS,
  MAX_PAYLOAD_CHARS,
  SEVERITIES,
  normalizeSeverity,
  normalizeFinding,
  countsFor,
  trimPayload,
  startRun,
  completeRun,
  failRun,
  latestByModule,
  listRuns,
  getRun,
  sweepStaleRuns,
};
