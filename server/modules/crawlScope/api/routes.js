// CrawlScope REST API + SSE, as a router mounted inside this app.
//
// Ported from the standalone CrawlScope service, which owned its own Express app,
// its own Supabase-Auth middleware, and served its own static renderer. Here it is
// a router mounted at /api/crawl-scope by server.js, behind this app's requireAuth,
// and the UI is React under client/src/pages. The handler logic is unchanged.
//
// What changed, and why:
//   - `requireAuth` is applied once by server.js at the mount, not per route, so
//     the per-route copies are gone.
//   - `req.db` and `req.user.id` are set by crawlScopeContext below. The old auth
//     middleware handed each request an RLS-scoped Supabase client keyed to a
//     Supabase Auth JWT; this app has no such session, so every request gets the
//     shared Postgres handle and repo.js's explicit `owner` filter is the tenancy
//     boundary. See ../db/client.js and ../db/repo.js.
//   - /healthz, /api/version and /api/config are dropped: the app has its own
//     /api/health, and /api/config existed only to hand the browser a Supabase
//     anon key for client-side sign-in, which this app never does.
//   - The static-file and SPA-fallback handlers are dropped; server.js serves the
//     React build.
//
// Manual ("run now") crawls execute in THIS process via the shared RunManager, so
// pause/resume/stop and the live SSE stream are simple. Scheduled crawls run in the
// worker. Both persist to Supabase, so the SSE endpoint tails the DB and works either
// way. NOTE: pause/resume/stop only reach a run hosted in the receiving process; with
// a single web instance (the default) that is always true. To scale web horizontally,
// add a DB-mediated control channel or sticky routing.

// The statuses a run cannot move out of. Named here rather than imported: the
// client keeps its own copy in crawlHelpers and there is no shared module
// between them — a mismatch would only make this route refuse a control request
// it could have recorded, which is the safe direction.
const TERMINAL_STATUSES = ["completed", "failed", "stopped"];

const express = require("express");
const { streamRun } = require("./sse");
const { RunManager, CONTROL_POLL_MS } = require("../run/manager");
const { serviceClient, isDatabaseConfigured } = require("../db/client");
const { resolveIdentity } = require("../../../services/workspaceContext");
const projectAccess = require("../../../services/projectAccess");
// The single writer for the project aggregate. CrawlScope used to insert
// crawl_projects directly through repo.createProject, which wrote no
// project_domains row and no country — see the POST /projects handler.
const projectStore = require("../../projects/store");
const { parseCrawlRequest, ValidationError } = require("../shared/options");
const {
  isValidCron,
  isValidTimezone,
  nextRun,
  weeklyCron,
  DEFAULT_TIMEZONE,
} = require("../shared/cron");
const { staggerMinute } = require("../shared/schedule");
// Namespace import so tests can substitute the workbook build and storage signing, which
// a destructured binding would capture and make unpatchable.
const report = require("../run/report");
const repo = require("../db/repo");
const catalog = require("../issue-catalog.json");
const { getPageSpeedForAllDomains } = require("../../../services/pageSpeedCA");

const router = express.Router();

// One manager for the process, shared by every manual run. Exported so server.js
// can drain it on shutdown instead of killing crawls mid-flight.
const manager = new RunManager({ serviceClient });

// On-demand PageSpeed checks, tracked in-process the same way
// competitorAnalysis/routes.js tracks its own run-pagespeed job: the check
// itself can take 15-90s (PSI is slow, and a rate-limit retry alone waits
// ~100s — see services/pageSpeedCA.js), too long to hold an HTTP request
// open for. POST kicks the check off and returns immediately; the status map
// lets the UI poll rather than guess. Keyed by `${runId}:${url}` since a run
// can have several checks in flight for different pages at once. In-process
// only — a restart loses in-flight status, which is fine, the eventual PSI
// result still lands in crawl_run_results either way.
const pagespeedChecks = new Map();

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ── Request context ─────────────────────────────────────────────────────────
// Supplies the two things every CrawlScope handler expects and this app's
// requireAuth doesn't provide: a Supabase client on req.db, and an owner id on
// req.user.id.
//
// The owner comes from this app's identity resolver — the same one run tracking
// uses — so a CrawlScope project belongs to the same `app_users` row the rest of
// the app attributes work to, and platform-embed sessions resolve to the shared
// synthetic user rather than being dropped.
//
// Unlike the stateless modules here, CrawlScope is entirely DB-backed: with no
// database configured there is nothing it can do, so it says so plainly instead
// of failing later with a constraint error on owner.
async function crawlScopeContext(req, res, next) {
  try {
    if (!isDatabaseConfigured()) {
      return res.status(503).json({
        error:
          "CrawlScope needs the database. Set DATABASE_URL, " +
          "and apply supabase/migrations/0010_crawlscope.sql.",
      });
    }
    const identity = await resolveIdentity(req);
    if (!identity?.userId) {
      return res.status(503).json({
        error: "Could not resolve the signed-in user. Try signing in again.",
      });
    }
    req.db = serviceClient();
    req.user = { ...req.user, id: identity.userId };
    req.crawlWorkspaceId = identity.workspaceId || null;
    // Which workspaces this user may READ from, as opposed to the single active
    // one they WRITE to. A new run is recorded against crawlWorkspaceId; the set
    // of runs they may open is wider than that.
    req.crawlViewer = {
      userId: identity.userId,
      workspaceIds: await projectAccess.accessibleWorkspaceIds(identity.userId),
    };
    next();
  } catch (error) {
    next(error);
  }
}

// The issue catalog is static reference data (96 checks: names, categories,
// severities) the UI needs to render any result, so it is readable by any
// signed-in user without a DB round trip. The count is asserted against the
// file rather than trusted: issue-catalog.json holds 96 entries (27 error,
// 54 warning, 15 notice), matching audit-loop/rules/rule-classes.json's _meta.
router.get("/catalog", (_req, res) => res.json(catalog));

router.use(crawlScopeContext);

// ---- runs ----
router.post(
  "/runs",
  asyncRoute(async (req, res) => {
    const { url, options, listInfo, budgetClamped } = parseCrawlRequest(req.body || {});
    const run = await repo.createRun(req.db, {
      owner: req.user.id,
      workspace_id: req.crawlWorkspaceId,
      project_id: req.body.projectId || null,
      url,
      options,
      trigger: "manual",
    });
    // Execute detached in this process; the response returns immediately.
    //
    // This is a `deferred` tracked run (server/config/runTracking.js): the
    // response is already sent by the time the crawl settles, so the run row is
    // closed here rather than by the response. `req.run` is absent when run
    // tracking is off (no Supabase), hence the optional calls.
    const tracked = req.run;
    manager
      .execute(run)
      .then(() => {
        tracked?.finish({ output: { runId: run.id, url: run.url } });
      })
      .catch((error) => {
        console.error(`[crawlScope] run ${run.id} failed:`, error.message);
        tracked?.fail(error.message, { output: { runId: run.id, url: run.url } });
      });
    // budgetClamped rides along on the 201 so the caller can say that the crawl
    // it is about to watch is smaller than the one it asked for. Without it the
    // only figure on screen is the crawler's own ceiling, which is the reduced
    // number — indistinguishable from the crawl simply finding fewer pages.
    res.status(201).json({ run, listInfo: listInfo || null, budgetClamped });
  }),
);

router.get(
  "/runs",
  asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const projectId = req.query.projectId || null;
    res.json({
      runs: await repo.listRunsForViewer(req.db, req.crawlViewer, { limit, projectId }),
    });
  }),
);

router.get(
  "/runs/:id",
  asyncRoute(async (req, res) => {
    const run = await repo.getRunForViewer(req.db, req.params.id, req.crawlViewer);
    if (!run) return res.status(404).json({ error: "Run not found." });
    res.json({ run, active: manager.isActive(run.id) });
  }),
);

router.get(
  "/runs/:id/results",
  asyncRoute(async (req, res) => {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(Number(req.query.limit) || 500, 2_000);
    // Authorize the RUN, then read all of its results. Filtering the result rows
    // themselves by owner handed a teammate who could open the run an empty page
    // — the rows belong to the run, not to the reader.
    const run = await repo.getRunForViewer(req.db, req.params.id, req.crawlViewer);
    if (!run) return res.status(404).json({ error: "Run not found." });
    const rows = await repo.listResults(req.db, req.params.id, { offset, limit });
    res.json({ results: rows.map((r) => r.data), offset, limit });
  }),
);

// ---- PageSpeed Insights (on-demand, per page) ----
//
// Runs Lighthouse mobile+desktop for one crawled URL and merges the result
// into that page's stored `data.pagespeed` (repo.js#updateResultPagespeed).
// Deliberately NOT run automatically for every page of every crawl: PSI is
// slow (15-90s per URL per strategy) and quota-limited, so bulk-checking a
// whole site would either stall crawls or burn through the daily quota. The
// worker's post-crawl enrichment (run/manager.js) covers a small automatic
// sample (seed + top-linked pages); this endpoint covers everything else, one
// page at a time, on request.
router.post(
  "/runs/:id/results/pagespeed",
  asyncRoute(async (req, res) => {
    const run = await repo.getRunForViewer(req.db, req.params.id, req.crawlViewer);
    if (!run) return res.status(404).json({ error: "Run not found." });
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ error: "A url is required." });

    const key = `${run.id}:${url}`;
    const existing = pagespeedChecks.get(key);
    if (existing && existing.status === "running") {
      return res.status(409).json({ error: "A PageSpeed check for this URL is already running." });
    }

    const startedAt = Date.now();
    const setStatus = (patch) => {
      const entry = { startedAt, ...patch };
      pagespeedChecks.set(key, entry);
      // Evict once the UI has had a real chance to poll the terminal status —
      // otherwise this map only ever grows for the life of the process, one
      // entry per (run, url) ever checked. Guarded by identity: if a fresh
      // check for the same key has already started by the time this fires,
      // this timer's job is done (that's a different entry now) and it must
      // not delete it out from under the new check.
      if (patch.status === "done" || patch.status === "error") {
        setTimeout(() => {
          if (pagespeedChecks.get(key) === entry) pagespeedChecks.delete(key);
        }, 10 * 60_000).unref();
      }
      return entry;
    };

    setStatus({ status: "running", error: null, finishedAt: null });
    res.json({ status: "running" });

    const db = req.db; // capture before the request context is gone
    (async () => {
      try {
        const [result] = await getPageSpeedForAllDomains([url]);
        const data = await repo.updateResultPagespeed(db, run.id, url, {
          ...result,
          checkedAt: new Date().toISOString(),
        });
        if (!data) {
          setStatus({ status: "error", error: "No crawled result stored for that URL in this run.", finishedAt: Date.now() });
          return;
        }
        setStatus({ status: "done", error: null, finishedAt: Date.now(), pagespeed: data.pagespeed });
      } catch (err) {
        setStatus({ status: "error", error: err.message, finishedAt: Date.now() });
      }
    })();
  }),
);

router.get(
  "/runs/:id/results/pagespeed/status",
  asyncRoute(async (req, res) => {
    const run = await repo.getRunForViewer(req.db, req.params.id, req.crawlViewer);
    if (!run) return res.status(404).json({ error: "Run not found." });
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ error: "A url is required." });
    const status = pagespeedChecks.get(`${run.id}:${url}`);
    res.json(status || { status: "idle", error: null });
  }),
);

// ---- issue review ----
//
// The findings themselves live in crawl_run_finding_instances (migration
// 0023 — full per-occurrence detail, chunked-inserted when the crawl
// completes) and are immutable evidence. Review status and notes are mutable
// and live in crawl_finding_reviews, keyed on the analyzer's stable finding
// id. This endpoint joins the two so the UI gets one list, with every
// unreviewed finding defaulting to "Needs review" without a row having to exist.
const NEEDS_REVIEW = "Needs review";
const REVIEW_STATUSES = new Set([
  NEEDS_REVIEW,
  "Confirmed issue",
  "False positive",
  "Resolved",
]);

// A run finalized before migration 0023 shipped never got rows in
// crawl_run_finding_instances — its findings are still sitting in the old
// location, run.summary.findings. Falling back there (rather than showing
// zero findings for every run that predates the migration) costs nothing:
// `run` is already fetched, so this reads a field already in memory.
async function loadRunFindings(db, run) {
  const stored = await repo.listAllRunFindingInstances(db, run.id);
  if (stored.length) return stored;
  return Array.isArray(run.summary?.findings) ? run.summary.findings : [];
}

function mergeReviews(findings, reviewRows) {
  const byId = new Map(reviewRows.map((r) => [r.finding_id, r]));
  return findings.map((f) => {
    const review = byId.get(f.id);
    return {
      ...f,
      reviewStatus: review?.review_status || NEEDS_REVIEW,
      reviewerNotes: review?.reviewer_notes || "",
      reviewedAt: review?.updated_at || null,
    };
  });
}

// `?grain=rule` serves the per-rule rollup instead of every occurrence.
//
// The default stays `instance` because that is what the existing report and the
// review flow consume, and changing it under them would be a silent breaking
// change. But a caller that only needs "which rules fired and how many times" —
// the overview tiles, the tab counts, "N distinct causes" — was downloading
// 7,298 rows to compute 18, and the answer was already in crawl_run_findings.
//
// Both shapes now declare their own `grain`, so a reader can never again mistake
// 18 for 7,298: that conflation cost an entire audit report its accuracy once.
router.get(
  "/runs/:id/findings",
  asyncRoute(async (req, res) => {
    const run = await repo.getRunForViewer(req.db, req.params.id, req.crawlViewer);
    if (!run) return res.status(404).json({ error: "Run not found." });

    if (String(req.query.grain || "").toLowerCase() === "rule") {
      const rollup = await repo.listRunFindingRollup(req.db, run.id);
      return res.json({
        grain: "rule",
        findings: rollup.map((row) => ({
          ruleId: row.rule_id,
          severity: row.severity,
          category: row.category,
          count: row.count,
          title: row.detail?.title || "",
        })),
      });
    }

    // `?limit=` pages the instance grain, the same way /results already does.
    // Without it the whole set is materialised three times over in this process
    // (see repo.listRunFindingInstancesPage) and a 10,000-page crawl is an OOM
    // rather than a slow response. The unpaged path stays the default so the
    // existing report and review flow are untouched.
    if (req.query.limit !== undefined) {
      const page = await repo.listRunFindingInstancesPage(req.db, run.id, {
        offset: req.query.offset,
        limit: req.query.limit,
      });
      const reviews = await repo.listFindingReviews(req.db, run.id);
      return res.json({
        grain: "instance",
        offset: page.offset,
        // What was actually served, and where to ask next. Reporting the
        // REQUESTED limit here is what let a caller mistake a capped page for
        // the end of the data.
        limit: page.limit,
        returned: page.returned,
        nextOffset: page.returned ? page.offset + page.returned : null,
        findings: mergeReviews(page.rows, reviews),
      });
    }

    const findings = await loadRunFindings(req.db, run);
    const reviews = await repo.listFindingReviews(req.db, run.id);
    res.json({ grain: "instance", findings: mergeReviews(findings, reviews) });
  }),
);

// One endpoint for both a single edit and a bulk action — the UI's "mark all
// visible as Confirmed" is the same write as changing one dropdown, just with
// more rows, and splitting them would mean two code paths with one meaning.
router.patch(
  "/runs/:id/findings",
  asyncRoute(async (req, res) => {
    const run = await repo.getRunForViewer(req.db, req.params.id, req.crawlViewer);
    if (!run) return res.status(404).json({ error: "Run not found." });

    const incoming = Array.isArray(req.body?.reviews) ? req.body.reviews : [];
    if (!incoming.length) throw new ValidationError("No reviews to save.");
    if (incoming.length > 5_000) {
      throw new ValidationError("Too many findings in one request.");
    }

    // A review may only be attached to a finding this run actually produced:
    // the finding id is client-supplied, and without this an arbitrary id could
    // be written into the table.
    const findings = await loadRunFindings(req.db, run);
    const ruleById = new Map(findings.map((f) => [f.id, f.ruleId]));

    const reviews = [];
    for (const r of incoming) {
      const findingId = String(r.findingId || "");
      if (!ruleById.has(findingId)) {
        throw new ValidationError(`Unknown finding for this run: ${findingId}`);
      }
      const reviewStatus = String(r.reviewStatus || NEEDS_REVIEW);
      if (!REVIEW_STATUSES.has(reviewStatus)) {
        throw new ValidationError(`Not a review status: ${reviewStatus}`);
      }
      const notes = r.reviewerNotes === undefined || r.reviewerNotes === null
        ? null
        : String(r.reviewerNotes).slice(0, 4_000);
      reviews.push({
        findingId,
        ruleId: ruleById.get(findingId),
        reviewStatus,
        reviewerNotes: notes,
      });
    }

    // The row's `owner` stays the RUN's owner, so one shared review row keeps a
    // single consistent value; `reviewed_by` records who made this decision.
    await repo.saveFindingReviews(req.db, run.id, run.owner, reviews, req.user.id);
    const saved = await repo.listFindingReviews(req.db, run.id);
    res.json({ findings: mergeReviews(findings, saved) });
  }),
);

// SSE. In the standalone app this route also accepted ?access_token= because
// EventSource cannot set an Authorization header; here the session is a cookie,
// which EventSource sends automatically, so the query-param path is gone.
router.get(
  "/runs/:id/stream",
  asyncRoute(async (req, res) => {
    await streamRun(req, res, req.db, req.params.id, req.crawlViewer);
  }),
);

for (const action of ["pause", "resume", "stop"]) {
  router.post(
    `/runs/:id/${action}`,
    asyncRoute(async (req, res) => {
      // Workspace-scoped: this app never applies RLS, so the check inside
      // repo.getRunForViewer is the tenancy boundary. Pausing or stopping a
      // teammate's crawl is deliberately allowed — the run is against a client
      // site the whole workspace shares, and it is reversible by re-running.
      const run = await repo.getRunForViewer(req.db, req.params.id, req.crawlViewer);
      if (!run) return res.status(404).json({ error: "Run not found." });

      // Executed here: applied at once, as it always was.
      if (manager[action](run.id)) {
        return res.json({ ok: true, action, applied: "immediately" });
      }

      // Executed somewhere else — the NORMAL case, not an edge one. Every
      // project crawl and every scheduled crawl runs in the worker, so Stop on
      // the flagship "Run Full Audit" flow always landed here and answered 409
      // "This run is not being executed by this instance": a sentence about our
      // process topology that left the crawl running and the reader with
      // nothing to do about it.
      //
      // Recorded on the run instead. The worker reads it on its next heartbeat
      // and applies it through the same crawler methods — see run/manager.js
      // and migration 0025.
      //
      // A request on a finished run is refused rather than written: no worker
      // is beating for it, so nothing would ever clear the column.
      if (TERMINAL_STATUSES.includes(run.status)) {
        return res.status(409).json({
          error: `This crawl has already ${run.status === "completed" ? "finished" : run.status}.`,
        });
      }

      await repo.updateRun(req.db, run.id, {
        control_request: action,
        control_requested_at: new Date().toISOString(),
      });

      res.json({
        ok: true,
        action,
        applied: "requested",
        // Said by the server because the interval is an operator setting and
        // the client has no way to know it.
        // The poll interval, not the heartbeat's: the worker checks for this
        // on its own short timer. Quoted from the server because the interval
        // is an operator setting and the client cannot know it.
        note: `The crawl is running on a worker; it will ${action} within about `
          + `${Math.max(1, Math.round(CONTROL_POLL_MS / 1000))}s.`,
      });
    }),
  );
}

router.get(
  "/runs/:id/report.xlsx",
  asyncRoute(async (req, res) => {
    const run = await repo.getRunForViewer(req.db, req.params.id, req.crawlViewer);
    if (!run) return res.status(404).json({ error: "Run not found." });

    // The workbook embeds review status and reviewer notes per finding, and its
    // summary formulas count "Needs review" rows. A workbook the worker built
    // when the crawl finished therefore predates every review decision made
    // since. So the stored copy is only served while nothing has been reviewed;
    // once someone has triaged, the workbook is rebuilt so the download matches
    // what the Issue Review screen shows.
    const reviews = await repo.listFindingReviews(req.db, run.id);
    const reviewed = reviews.some((r) => r.review_status !== NEEDS_REVIEW || r.reviewer_notes);

    // Served straight from the stored copy. This used to redirect to a signed
    // Storage URL; the caller is already authenticated here, so there is nothing
    // for a redirect to buy — and a missing file (an unmounted data root after a
    // deploy) simply falls through to the rebuild below.
    if (run.report_path && !reviewed) {
      const stored = await report.readReport(run.report_path);
      if (stored) {
        res.setHeader("Content-Type", report.XLSX_MIME);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${report.reportFilename(run.url)}"`,
        );
        return res.send(stored);
      }
    }

    // Fallback for manual runs, runs predating stored reports, and any run whose
    // findings have since been reviewed.
    const findings = await loadRunFindings(req.db, run);
    const buffer = await report.buildReportBuffer({
      findings: mergeReviews(findings, reviews),
      siteUrl: run.url,
      crawlDate: run.finished_at || run.created_at,
    });
    res.setHeader("Content-Type", report.XLSX_MIME);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${report.reportFilename(run.url)}"`,
    );
    res.send(buffer);
  }),
);

// ---- projects ----
//
// A project is a saved crawl configuration plus recipients plus a recurrence. Every
// route scopes by req.user.id explicitly rather than trusting RLS, which this app
// does not use at all.

// Rejects rather than silently drops. Quietly discarding a malformed address would
// leave a project that reports success and then emails nobody, which is invisible until
// a client asks where their report is. Accepts the "Name <addr@host>" form browsers and
// mail clients paste, since that is the common case for a bad-looking entry.
const emailList = (value) => {
  if (value === undefined || value === null) return [];
  const entries = (Array.isArray(value) ? value : String(value).split(/[,;\n]/))
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const cleaned = [];
  const invalid = [];
  for (const entry of entries) {
    const address = /<([^>]+)>\s*$/.exec(entry)?.[1]?.trim() || entry;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) cleaned.push(address);
    else invalid.push(entry);
  }
  if (invalid.length) {
    throw new ValidationError(
      `These are not valid email addresses: ${invalid.join(", ")}`,
    );
  }
  return [...new Set(cleaned)];
};

// The UI sends dayOfWeek + hour; a raw `cron` is still accepted for anything the
// pickers can't express. The minute is assigned here, not chosen by the user, so
// projects spread across the hour instead of every one firing on :00.
const resolveCron = (body, seed) => {
  if (typeof body.cron === "string" && body.cron.trim()) return body.cron.trim();
  if (body.dayOfWeek === undefined && body.hour === undefined) return null;
  const cron = weeklyCron({
    dayOfWeek: body.dayOfWeek,
    hour: body.hour,
    minute: staggerMinute(seed),
  });
  if (!cron) throw new ValidationError("Choose a valid day of week and hour.");
  return cron;
};

const resolveTimezone = (value) => {
  if (value === undefined || value === null || value === "") return DEFAULT_TIMEZONE;
  if (!isValidTimezone(value)) throw new ValidationError("Unknown timezone.");
  return value;
};

// Queue a crawl for the worker rather than running it here. Worker-executed runs are
// the ones that get an emailed report, and keeping crawl + workbook memory out of the
// web process protects the health check.
const queueProjectRun = (db, project) =>
  repo.createRun(db, {
    owner: project.owner,
    workspace_id: project.workspace_id || null,
    project_id: project.id,
    url: project.url,
    options: project.options,
    trigger: "initial",
  });

router.get(
  "/projects",
  asyncRoute(async (req, res) => {
    res.json({ projects: await repo.listProjectsForViewer(req.db, req.crawlViewer) });
  }),
);

router.post(
  "/projects",
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const { url, options } = parseCrawlRequest(body);
    const timezone = resolveTimezone(body.timezone);
    const cron = resolveCron(body, `${req.user.id}:${url}`);
    if (!cron) throw new ValidationError("A schedule is required.");
    if (!isValidCron(cron, timezone)) {
      throw new ValidationError("That schedule never occurs. Check the day, hour, and timezone.");
    }
    // Built through the shared project store, not repo.createProject.
    //
    // This endpoint used to insert crawl_projects on its own and stop there: no
    // project_domains row, no country. Every project it created therefore read
    // back with primaryDomain: null and primaryDomainSource 'legacy_url_column',
    // which the projects screen renders as "Missing — the crawler is using
    // {url}". It crawled fine and was broken everywhere else.
    //
    // store.createProject writes the project and its primary domain in one
    // transaction, so there is no longer a way to create half a project. Three
    // details are preserved deliberately so existing callers see no change:
    //
    //   * the cron/timezone resolved above are passed through verbatim, rather
    //     than letting the store pick its weekly default — CrawlScope requires a
    //     schedule and has its own stagger seed.
    //   * `enabled` keeps CrawlScope's "on unless explicitly false" default,
    //     which is the opposite of /api/projects' "off unless asked". This
    //     endpoint queues an immediate run; that is its contract.
    //   * requireCountry: false — this endpoint has callers that send no
    //     country, and a 400 would break them. country_code stays NULL and
    //     surfaces as countryMissing for repair in project settings.
    // 'createProject' is held by every workspace member, so routing this
    // endpoint through the shared store did not quietly narrow who may use it:
    // before the move it applied no capability check at all, and matching it to
    // /api/projects is the point of having one writer.
    const access = await projectAccess.requireWorkspace(
      req, req.crawlWorkspaceId, "createProject",
    );
    const created = await projectStore.createProject({
      access,
      name: body.name,
      primaryDomain: url,
      country: body.country,
      requireCountry: false,
      crawlOptions: options,
      recipients: emailList(body.recipients),
      schedule: { cron, timezone, enabled: body.enabled !== false },
    });

    // The store returns the client-facing projectView (camelCase). Everything
    // below — queueProjectRun, and this endpoint's own response shape — is
    // written against the raw crawl_projects row, so read it back rather than
    // translating between the two shapes at every call site.
    const project = await repo.getProject(req.db, created.id);

    // The first crawl starts immediately; the cron governs every one after it.
    await require('../../projects/contentArchitect').ensureProject(project).catch((error) => {
      console.error(`[crawlScope] Content Architect setup for project ${project.id} failed:`, error.message);
    });
    const homepageAudits = await require('../../projects/homepageAutostart').scheduleForProject(req, project.id);
    let run = null;
    try {
      run = await queueProjectRun(req.db, project);
    } catch (error) {
      console.error(`[crawlScope] initial run for project ${project.id} failed to queue:`, error.message);
    }
    res.status(201).json({ project, run, homepageAudits });
  }),
);

router.patch(
  "/projects/:id",
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const existing = await repo.getProjectForViewer(req.db, req.params.id, req.crawlViewer);
    if (!existing) return res.status(404).json({ error: "Project not found." });

    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.next_run_at !== undefined) patch.next_run_at = body.next_run_at;
    if (body.recipients !== undefined) patch.recipients = emailList(body.recipients);
    if (body.timezone !== undefined) patch.timezone = resolveTimezone(body.timezone);

    const timezone = patch.timezone || existing.timezone || DEFAULT_TIMEZONE;
    const cron = resolveCron(body, `${req.user.id}:${existing.url}`);
    if (cron) {
      if (!isValidCron(cron, timezone)) {
        throw new ValidationError(
          "That schedule never occurs. Check the day, hour, and timezone.",
        );
      }
      patch.cron = cron;
    }

    // Fall back to the stored URL so options can be patched on their own; the previous
    // shape required re-sending the URL with every options change or it would 400.
    if (body.url || body.urls || body.options) {
      const { url, options } = parseCrawlRequest({
        url: body.url || existing.url,
        urls: body.urls,
        options: body.options,
      });
      patch.url = url;
      patch.options = options;
    }

    // Recompute the next fire time when the schedule changed OR the project is being
    // re-enabled. Without the enable case, a project disabled for a month keeps its
    // long-past next_run_at and fires instantly on the next tick.
    const scheduleChanged = patch.cron || patch.timezone;
    const beingEnabled = patch.enabled === true && existing.enabled === false;
    if ((scheduleChanged || beingEnabled) && patch.next_run_at === undefined) {
      const next = nextRun(patch.cron || existing.cron, new Date(), timezone);
      patch.next_run_at = next ? next.toISOString() : null;
    }

    const project = await repo.updateProject(req.db, req.params.id, patch, req.user.id);
    res.json({ project });
  }),
);

// Deliberately still creator-scoped, unlike the reads and the run above.
//
// Deletion is destructive and the app already has a capability-checked deletion
// path for these same rows (modules/projects + projectAccess.requireProject).
// Widening delete to every workspace member is a product decision about who may
// destroy a client's crawl history, not a scoping cleanup, so it is left alone
// until someone makes that decision on purpose.
router.delete(
  "/projects/:id",
  asyncRoute(async (req, res) => {
    // Deletion goes through the governed path for this exact row.
    //
    // This used to be `repo.deleteProject(req.db, req.params.id, req.user.id)`:
    // a raw, permanent DELETE on crawl_projects gated only by the `owner`
    // column — which projectAccess.js:14 documents as creator attribution and
    // explicitly NOT an access decision. Any authenticated user who had created
    // a project could therefore destroy it outright, skipping every guard the
    // product puts on that operation: the capability check, the audit event,
    // the "must already be soft-deleted" precondition, the confirm-the-name
    // step, and PROJECT_PURGE_ORDER's crawl_runs-first ordering. Skipping the
    // last one also orphaned the run history, because 0010 makes
    // crawl_runs.project_id ON DELETE SET NULL rather than cascading.
    //
    // It is now the same soft delete the projects UI performs on this row:
    // capability-checked, audited, and reversible via
    // POST /api/projects/:id/restore. Permanent destruction still goes through
    // POST /api/projects/:id/purge, which keeps both of its deliberate guards.
    //
    // Required lazily: projects/store pulls in crawlScope/shared/*, and keeping
    // this out of the module's load graph avoids adding a cycle to it.
    const projectsStore = require("../../projects/store");
    const access = await projectAccess.requireProject(
      req,
      req.params.id,
      "editProjectSettings",
    );
    const project = await projectsStore.deleteProject({
      access,
      reason: req.body?.reason,
    });
    res.json({ ok: true, project });
  }),
);

// Run a project now, out of band with its schedule.
//
// Workspace-scoped, which is what makes "Run Full Audit" work for anyone on the
// team. While this was creator-scoped the dashboard had to detect the case and
// silently skip queuing a crawl, then explain that the page audits were reading
// an older one — a workaround for an authorization bug, presented to the user as
// a product limitation.
router.post(
  "/projects/:id/run",
  asyncRoute(async (req, res) => {
    const project = await repo.getProjectForViewer(req.db, req.params.id, req.crawlViewer);
    if (!project) return res.status(404).json({ error: "Project not found." });
    const run = await queueProjectRun(req.db, project);
    res.status(201).json({ run });
  }),
);

// ---- error handler ----
// Router-scoped so a ValidationError from these handlers becomes a 400 here
// rather than falling through to the app's generic handling.
// A 4xx here was raised deliberately and its message is written for the caller
// (ValidationError carries status 400), so it is passed through unchanged.
//
// A 5xx is not. Nothing in db/repo.js catches: `createRun` and its neighbours
// call client.one(...) directly, so a driver error travels raw through
// asyncRoute's .catch(next) to here. That put the database's own words in the
// response body for any signed-in caller — `connect ECONNREFUSED <host>:<port>`
// when the database is unreachable, `password authentication failed for user
// "…"` on a bad credential, or a constraint name like
// `crawl_runs_project_id_fkey` on a violation, each naming internal
// infrastructure or schema. Logged in full, answered generically — the same
// rule server.js's final error handler, routes/admin.js and
// modules/projects/routes.js already follow.
router.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status < 500) {
    return res.status(status).json({ error: error.message || "Bad request.", code: error.code });
  }
  console.error("[crawlScope]", error);
  res.status(status).json({ error: "Something went wrong handling that crawl request." });
});

module.exports = router;
module.exports.manager = manager;
