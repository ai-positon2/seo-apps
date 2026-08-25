// Per-run crawler manager. Replaces the desktop app's single global `activeCrawler`
// with a Map<runId, SeoCrawler>, so any number of runs execute concurrently without
// clobbering each other. Used by both the web service (manual runs the user watches)
// and the worker (scheduled headless runs).
//
// Progress and per-URL results are streamed to Supabase as the crawl proceeds, so the
// SSE endpoint can tail them regardless of which process owns the crawler, and memory
// is bounded (rows are flushed, not accumulated forever in the web layer).

const { SeoCrawler } = require("../crawler");
const { createFetch } = require("../net/egress");
const { parseCrawlRequest } = require("../shared/options");
const repo = require("../db/repo");

const RESULT_BATCH = 25;
const PROGRESS_INTERVAL_MS = 1_000;
const HEARTBEAT_MS = Number(process.env.RUN_HEARTBEAT_MS) || 30_000;

function aggregateFindings(findings, owner, runId) {
  const map = new Map();
  for (const f of findings) {
    const cur =
      map.get(f.ruleId) ||
      {
        run_id: runId,
        owner,
        rule_id: f.ruleId,
        severity: f.severity,
        category: f.category,
        count: 0,
        detail: { title: f.title },
      };
    cur.count += 1;
    map.set(f.ruleId, cur);
  }
  return [...map.values()];
}

function severityCounts(findings) {
  const counts = { error: 0, warning: 0, notice: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }
  return counts;
}

class RunManager {
  // `serviceClient` is a factory (called lazily on first execute) so the server can
  // boot and serve health/config routes even before Supabase env is configured.
  //
  // `optionOverrides` tightens crawl politeness for this process's runs. The worker sets
  // it so unattended scheduled crawls are gentler than interactive ones; the web service
  // leaves it empty.
  constructor(deps = {}) {
    this.serviceClientFactory = deps.serviceClient;
    this.optionOverrides = deps.optionOverrides || {};
    this.crawlers = new Map();
  }

  isActive(runId) {
    return this.crawlers.has(runId);
  }

  pause(runId) {
    const crawler = this.crawlers.get(runId);
    if (!crawler) return false;
    crawler.pause();
    return true;
  }

  resume(runId) {
    const crawler = this.crawlers.get(runId);
    if (!crawler) return false;
    crawler.resume();
    return true;
  }

  stop(runId) {
    const crawler = this.crawlers.get(runId);
    if (!crawler) return false;
    crawler.stop();
    return true;
  }

  async shutdown() {
    for (const crawler of this.crawlers.values()) crawler.stop();
  }

  // Executes a `runs` row to completion, streaming progress/results to Supabase.
  // Returns the completion summary so the caller (worker) can send an email.
  async execute(run) {
    const db = this.serviceClientFactory();
    // List-mode runs store the real URLs in options.urls and a display label
    // ("List crawl (N URLs)") in run.url — re-derive the request body accordingly.
    const requestBody = Array.isArray(run.options?.urls)
      ? { urls: run.options.urls, options: run.options }
      : { url: run.url, options: run.options };
    const { url, options } = parseCrawlRequest(requestBody, this.optionOverrides);
    const fetchImpl = createFetch({
      mode: process.env.EGRESS_MODE || "direct",
      proxyUrl: process.env.PROXY_URL,
      // SSRF guard is on in production. CRAWL_ALLOW_PRIVATE_HOSTS=true is a local-dev
      // escape hatch (e.g. auditing a staging site on a private network) — never set
      // it on a public deployment.
      allowPrivateHosts: process.env.CRAWL_ALLOW_PRIVATE_HOSTS === "true",
    });

    const crawler = new SeoCrawler({ ...options, fetch: fetchImpl });
    this.crawlers.set(run.id, crawler);

    // Claim the run immediately so a worker polling the queue won't also pick it up.
    await repo.updateRun(db, run.id, {
      status: "running",
      started_at: run.started_at || new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
    });

    // Liveness on its own timer rather than piggybacking the progress writes above: a
    // legitimately paused run emits no progress events, and the reaper must not mistake
    // that for a dead worker. One small UPDATE per interval per active run.
    const heartbeat = setInterval(() => {
      repo
        .updateRun(db, run.id, { heartbeat_at: new Date().toISOString() })
        .catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref();

    let buffer = [];
    let lastProgressAt = 0;
    const flush = async () => {
      if (!buffer.length) return;
      const rows = buffer;
      buffer = [];
      await repo.insertResults(db, rows);
    };

    crawler.on("result", (result) => {
      buffer.push({
        run_id: run.id,
        owner: run.owner,
        url: result.url,
        status: result.status || null,
        content_type: result.contentType || null,
        indexability: result.indexability || null,
        depth: result.depth ?? null,
        data: result,
      });
      if (buffer.length >= RESULT_BATCH) flush().catch(() => {});
    });

    crawler.on("progress", (progress) => {
      const now = Date.now();
      if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
      lastProgressAt = now;
      repo.updateRun(db, run.id, { progress }).catch(() => {});
    });

    // The crawler emits "paused", "running", and "stopping". Only the first two are real
    // statuses; "stopping" is transient on the way to a terminal one, and mapping it back
    // to "running" as an un-awaited write could land AFTER the terminal write and
    // resurrect a finished run into a status that nothing will ever claim again.
    let finalized = false;
    crawler.on("state", (state) => {
      if (finalized) return;
      if (state.state !== "paused" && state.state !== "running") return;
      repo.updateRun(db, run.id, { status: state.state }).catch(() => {});
    });

    try {
      const summary = await crawler.start(options.urls || url);
      finalized = true; // no further status writes may race the terminal one below
      await flush();

      const findings = Array.isArray(summary.findings) ? summary.findings : [];
      await repo.insertFindings(db, aggregateFindings(findings, run.owner, run.id));

      // Internal link graph, for hub-and-spoke clustering (migration 0012).
      //
      // Internal edges only: external links are already status-checked per
      // result row and would multiply this table for no clustering value.
      //
      // A failure here does NOT fail the crawl. The crawl's own evidence —
      // results and findings — is already committed above, and losing the graph
      // costs one derived analysis rather than the whole run. It is logged so
      // the loss is visible instead of silent.
      try {
        const edges = Array.isArray(summary.linkEdges) ? summary.linkEdges : [];
        const rows = edges
          .filter((edge) => edge.internal && edge.sourceUrl && edge.targetUrl)
          .map((edge) => ({
            run_id: run.id,
            project_id: run.project_id || null,
            from_url: edge.sourceUrl,
            to_url: edge.targetUrl,
            anchor: edge.anchorText ? String(edge.anchorText).slice(0, 500) : null,
            rel: edge.rel ? String(edge.rel).slice(0, 200) : null,
            nofollow: Boolean(edge.nofollow),
          }));
        const written = await repo.insertRunLinks(db, rows);
        if (written) console.log(`[crawlScope] stored ${written} internal link edges for run ${run.id}`);
      } catch (error) {
        console.error(`[crawlScope] link graph not stored for run ${run.id}:`, error.message);
      }

      const counts = severityCounts(findings);
      const rolled = {
        findings,
        counts,
        robotsStatus: summary.robotsStatus,
        elapsed: summary.elapsed,
        resultCount: Array.isArray(summary.results) ? summary.results.length : 0,
      };
      await repo.updateRun(db, run.id, {
        status: summary.stopped ? "stopped" : "completed",
        summary: rolled,
        site_diagnostics: summary.siteDiagnostics || null,
        progress: crawler._progress ? crawler._progress() : {},
        finished_at: new Date().toISOString(),
      });

      // The project's page inventory follows its crawl. Done here, at the moment
      // the run becomes readable, so a page list is never stale relative to the
      // crawl that produced it.
      //
      // Deliberately non-fatal: a crawl that finished successfully must not be
      // reported as failed because a downstream sync did. The failure is logged
      // and the inventory catches up on the next crawl or a manual sync.
      if (run.project_id) {
        try {
          const projectPages = require("../../projects/pages");
          const result = await projectPages.syncFromCrawl({
            access: { project: { id: run.project_id, workspace_id: run.workspace_id || null } },
          });
          if (result.retirementWithheld) console.log(`[crawl ${run.id}] ${result.note}`);
        } catch (e) {
          console.error(`[crawl ${run.id}] page inventory sync failed:`, e.message);
        }
      }

      return { run, summary, counts };
    } catch (error) {
      finalized = true;
      await flush().catch(() => {});
      await repo.updateRun(db, run.id, {
        status: "failed",
        error: String(error?.message || error),
        finished_at: new Date().toISOString(),
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.crawlers.delete(run.id);
      try {
        await fetchImpl.close();
      } catch {
        // dispatcher already closed
      }
    }
  }
}

module.exports = { RunManager, aggregateFindings, severityCounts };
