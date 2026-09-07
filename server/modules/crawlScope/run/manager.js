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
const { getPageSpeedForAllDomains } = require("../../../services/pageSpeedCA");
const { createGate } = require("../shared/gate");

// Default is "every eligible page" — PSI runs in the background and doesn't
// block the crawl, so the cost of checking more pages is time, not risk to
// the run itself. Still overridable for an operator who wants a hard ceiling
// on a very large site.
const AUTO_PAGESPEED_SAMPLE_SIZE =
  Number(process.env.CRAWLSCOPE_AUTO_PAGESPEED_SAMPLE_SIZE) || Infinity;

// Process-wide, not per-crawl: several crawls can finish within moments of
// each other, and each wants to PSI-check every one of its pages. Without
// this they'd all fire at once and multiply against the same shared PSI
// quota. Gated to 1 full-site sample running at a time; everything else
// queues — see shared/gate.js.
const pageSpeedGate = createGate(1);

// Picks pages to PSI-check, template first: one representative page per
// pageCategory (analyzer.js) before filling remaining budget by inlinks. A
// product page and a blog post have entirely different performance
// profiles, so ranking purely by inlinks can spend the whole sample on one
// template (usually whichever one the nav links to most) before a
// differently-shaped page is ever measured — and if the sample is capped or
// interrupted partway, template-first means every template still has at
// least one data point instead of zero. Excludes assets and non-200s: PSI
// needs a real, live HTML page to audit, not an image or a redirect stub.
function pickPageSpeedSample(summary, size) {
  const candidates = (summary.results || []).filter(
    (r) => !r.isAsset && r.scope !== "External" && r.status === 200 &&
      r.contentType?.includes("text/html"),
  );
  const seed = candidates.find((r) => r.depth === 0);

  const byCategory = new Map();
  for (const r of candidates) {
    const list = byCategory.get(r.pageCategory) || [];
    list.push(r);
    byCategory.set(r.pageCategory, list);
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => (b.inlinks || 0) - (a.inlinks || 0));
  }

  const picked = [];
  const pickedUrls = new Set();
  const take = (r) => {
    if (!r || pickedUrls.has(r.url)) return;
    picked.push(r.url);
    pickedUrls.add(r.url);
  };

  take(seed);
  for (const list of byCategory.values()) {
    if (picked.length >= size) break;
    take(list[0]);
  }
  const byInlinks = [...candidates].sort((a, b) => (b.inlinks || 0) - (a.inlinks || 0));
  for (const r of byInlinks) {
    if (picked.length >= size) break;
    take(r);
  }
  return picked;
}

async function samplePageSpeed(db, run, summary) {
  const urls = pickPageSpeedSample(summary, AUTO_PAGESPEED_SAMPLE_SIZE);
  if (!urls.length) return;
  await pageSpeedGate(async () => {
    const results = await getPageSpeedForAllDomains(urls);
    for (const result of results) {
      await repo.updateResultPagespeed(db, run.id, result.domain, {
        ...result,
        checkedAt: new Date().toISOString(),
        auto: true,
      });
    }
  });
}

// 25 rows per insert meant ~2,000 round trips for a 50,000-page crawl, and
// because the flush was never awaited several could be in flight against the
// same table at once. 250 is comfortably inside PostgREST's request limit for
// rows this size.
const RESULT_BATCH = Number(process.env.RUN_RESULT_BATCH) || 250;
const PROGRESS_INTERVAL_MS = 1_000;
const HEARTBEAT_MS = Number(process.env.RUN_HEARTBEAT_MS) || 30_000;
// How quickly a stop asked for in another process is noticed here. Short on
// purpose and separate from the heartbeat: the heartbeat proves liveness and
// checkpoints the frontier, which is worth doing rarely; this decides how many
// more pages a crawl fetches after being told to stop, which is worth doing
// often. One narrow row read — see the note at its interval below.
const CONTROL_POLL_MS = Number(process.env.RUN_CONTROL_POLL_MS) || 3_000;
// A failed result insert is page data that will never exist anywhere else, so it
// is retried before it is allowed to count as lost.
const RESULT_FLUSH_ATTEMPTS = 3;
// How long a run may sit paused before it stops being treated as alive.
const MAX_PAUSE_MS = Number(process.env.RUN_MAX_PAUSE_MS) || 30 * 60_000;

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
    // The in-flight execute() promises, so shutdown() can wait for them rather
    // than stopping the crawlers and hoping the cleanup lands before exit.
    this.executions = new Set();
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

  // Stops every crawler AND waits for the executions to unwind.
  //
  // This used to call stop() and return immediately, so startLoops' 8-second
  // exit timer raced runOne's cleanup: a container could exit part-way through
  // deleteRunResults/requeueRun, leaving the run stuck in 'running' with a
  // half-written result set until the reaper's ten-minute stale window found it.
  // Now the caller can actually await the drain.
  async shutdown({ timeoutMs = 20_000 } = {}) {
    for (const crawler of this.crawlers.values()) crawler.stop();
    const pending = [...this.executions];
    if (!pending.length) return;
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([
        Promise.allSettled(pending),
        deadline.then(() => {
          console.warn(
            `[crawlScope] ${pending.length} run(s) did not finish unwinding within ${timeoutMs}ms`,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Executes a `runs` row to completion, streaming progress/results to Supabase.
  // Returns the completion summary so the caller (worker) can send an email.
  //
  // The tracking wrapper is separate from the body so shutdown() has a handle on
  // every execution in flight, whatever it is doing when the signal arrives.
  execute(run) {
    const execution = this._execute(run);
    this.executions.add(execution);
    // Attached with catch so registering never turns a rejection the caller does
    // handle into an unhandled one; the caller still receives `execution`.
    execution
      .catch(() => {})
      .finally(() => this.executions.delete(execution));
    return execution;
  }

  async _execute(run) {
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

    // A reclaimed run carries the frontier its previous attempt reached, so it
    // continues from there instead of re-crawling the site from the seed. The
    // rows that attempt already stored are kept (the reaper no longer deletes
    // them), and `seen` covers them, so nothing is fetched or written twice.
    let resumed = false;
    if (run.checkpoint && !Array.isArray(run.options?.urls)) {
      try {
        resumed = crawler.restore(run.checkpoint);
        if (resumed) {
          console.log(
            `[crawlScope] run ${run.id} resuming from checkpoint ` +
              `(${run.checkpoint.completedCount || 0} pages already stored)`,
          );
        }
      } catch (error) {
        // A checkpoint that cannot be read is not worth failing a run over;
        // the crawl simply starts from the seed, which is the old behaviour.
        console.error(`[crawlScope] run ${run.id} checkpoint unusable:`, error.message);
        resumed = false;
      }
    }

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
    //
    // A pause is NOT indefinite, though. The heartbeat kept stamping while a run
    // sat paused, so staleRuns could never reclaim it: it held its crawler, its
    // undici dispatcher and its unflushed result buffer for as long as the
    // process lived, and nothing would ever move it to a terminal status. Past
    // MAX_PAUSE_MS the heartbeat stops, which lets the reaper treat it like any
    // other run whose owner stopped responding.
    let pausedSince = 0;
    const heartbeat = setInterval(() => {
      if (crawler.paused) {
        if (!pausedSince) pausedSince = Date.now();
        if (Date.now() - pausedSince > MAX_PAUSE_MS) {
          console.warn(
            `[crawlScope] run ${run.id} paused for over ${Math.round(MAX_PAUSE_MS / 60_000)}m; ` +
              "no longer heart-beating so the reaper can reclaim it",
          );
          return;
        }
      } else {
        pausedSince = 0;
      }
      // The frontier rides along with the heartbeat rather than on its own
      // timer: it is the same UPDATE, and a checkpoint is only useful at the
      // moments the run is proving it is still alive.
      const patch = { heartbeat_at: new Date().toISOString() };
      try {
        const checkpoint = crawler.snapshot();
        if (checkpoint) patch.checkpoint = checkpoint;
      } catch (error) {
        console.error(`[crawlScope] run ${run.id} checkpoint failed:`, error.message);
      }
      repo.updateRun(db, run.id, patch).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref();

    // ── Stopping a crawl that is executing HERE, asked for over THERE ──────
    //
    // Pause/resume/stop act on the RunManager in the process that receives the
    // request. Every project crawl and every scheduled crawl executes in the
    // worker, so the Stop button — pressed in the web process — could not reach
    // them: the route answered 409 and the crawl carried on. Migration 0025
    // records the request on the run; this collects it.
    //
    // Its own timer rather than the heartbeat's, for responsiveness AND for
    // cost. Riding the 30s heartbeat meant up to half a minute of a crawl that
    // had been told to stop still fetching pages — the expensive thing here is
    // the crawling, not the polling. This poll is one narrow read of one
    // primary-key row (`select control_request where id = ...`), so at 3s it is
    // ~0.3 reads/second per running crawl: far cheaper than the requests the
    // crawler makes in the same window, and it writes nothing at all unless a
    // request is actually waiting.
    //
    // crawler.stop() aborts the root controller and clears the queue, so once
    // noticed it takes effect on the next tick — and the run still finishes
    // through the normal completion path, storing the findings for the pages it
    // did reach. A stopped crawl is a partial audit, not a lost one.
    let controlPollWarned = false;
    const control = setInterval(() => {
      // Nothing left to control, and no reason to keep reading.
      if (crawler.stopped) {
        clearInterval(control);
        return;
      }
      repo
        .readControlRequest(db, run.id)
        .then((request) => {
          if (!request) return;
          // Through the same methods the in-process buttons use, so a remote
          // stop and a local one cannot diverge.
          if (request === "pause") crawler.pause();
          else if (request === "resume") crawler.resume();
          else if (request === "stop") crawler.stop();
          else console.warn(`[crawlScope] run ${run.id}: unknown control request "${request}"`);
          console.log(`[crawlScope] run ${run.id}: applied remote ${request} request`);
          // Cleared only if it is still the request that was read — see
          // repo.clearControlRequest. An unrecognised value is cleared too, or
          // it would be re-read every poll for the life of the run.
          return repo.clearControlRequest(db, run.id, request);
        })
        // A dropped poll is not a failed crawl: the next one is three seconds
        // away, and a control channel that could kill a run by failing to read
        // would be worse than the 409 it replaces.
        //
        // Warned ONCE, though. If migration 0025 has not been applied the
        // column does not exist and every poll fails — silently, forever, while
        // Stop appears to do nothing. One line naming the likely cause beats a
        // silent three-second error loop; repeating it every three seconds for
        // the length of a crawl would bury the log it belongs in.
        .catch((error) => {
          if (controlPollWarned) return;
          controlPollWarned = true;
          console.warn(
            `[crawlScope] run ${run.id}: control poll failed (${error.message}). `
            + "Remote pause/stop will not reach this run. If this says the column "
            + "does not exist, apply supabase/migrations/0025_crawl_run_control_channel.sql.",
          );
        });
    }, CONTROL_POLL_MS);
    control.unref();

    let buffer = [];
    let lastProgressAt = 0;
    // Flushes are chained rather than fired in parallel: two concurrent inserts
    // against the same run have no ordering, and an unawaited one could still be
    // running when execute() writes the terminal status.
    let flushChain = Promise.resolve();
    let lostRows = 0;

    const writeRows = async (rows) => {
      let lastError;
      for (let attempt = 0; attempt < RESULT_FLUSH_ATTEMPTS; attempt += 1) {
        try {
          await repo.insertResults(db, rows);
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
      // Previously `flush().catch(() => {})` swallowed this entirely: 25 crawled
      // pages vanished from crawl_run_results and the run still reported itself
      // completed, so the report was quietly missing pages nobody could name.
      lostRows += rows.length;
      console.error(
        `[crawlScope] run ${run.id}: ${rows.length} result rows could not be stored:`,
        lastError?.message || lastError,
      );
    };

    const flush = () => {
      if (!buffer.length) return flushChain;
      const rows = buffer;
      buffer = [];
      flushChain = flushChain.then(() => writeRows(rows));
      return flushChain;
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
      if (buffer.length >= RESULT_BATCH) flush();
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
      // Full per-occurrence detail (migration 0023) — chunked INSERTs, not the
      // single giant summary.findings UPDATE that used to carry this and was
      // timing out on large crawls (see the migration's own header). Ungated,
      // same as insertFindings above: findings are the crawl's core evidence,
      // so a failure here should fail the run rather than silently produce a
      // report with no findings in it.
      await repo.insertRunFindingInstances(db, run.id, run.owner, findings);

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
        // Generated and inserted in chunks rather than materialized whole. A
        // 50,000-page crawl produces millions of edges, and building the entire
        // row array with one .map() allocated a second complete copy of the link
        // graph at exactly the moment the crawler was still holding the first.
        const toRow = (edge) => ({
          run_id: run.id,
          project_id: run.project_id || null,
          from_url: edge.sourceUrl,
          to_url: edge.targetUrl,
          anchor: edge.anchorText ? String(edge.anchorText).slice(0, 500) : null,
          rel: edge.rel ? String(edge.rel).slice(0, 200) : null,
          nofollow: Boolean(edge.nofollow),
        });
        const written = await repo.insertRunLinksStreaming(db, edges, toRow, (edge) =>
          Boolean(edge.internal && edge.sourceUrl && edge.targetUrl),
        );
        if (written) console.log(`[crawlScope] stored ${written} internal link edges for run ${run.id}`);
      } catch (error) {
        console.error(`[crawlScope] link graph not stored for run ${run.id}:`, error.message);
      }

      // V10.0: categorizePage() (analyzer.js) already computed pageCategory
      // into summary.results — but summary.results is never persisted (see
      // migration 0022's own header for the full trace), so the Category
      // column has read "—" since it shipped. Patch it onto the rows the UI
      // actually reads (crawl_run_results), and — for a saved project —
      // upsert into page_category so a manual correction survives the NEXT
      // crawl instead of being wiped with everything else in
      // crawl_run_results. Same non-fatal treatment as the link graph above:
      // losing this costs one crawl's category display, not the run.
      try {
        const htmlPages = (Array.isArray(summary.results) ? summary.results : []).filter(
          (r) => r.contentType?.includes("text/html") && r.scope !== "External" && r.pageCategory,
        );
        const patches = htmlPages.map((r) => ({ url: r.url, category: r.pageCategory }));
        await repo.patchResultCategories(db, run.id, patches);
        if (run.project_id) {
          await repo.upsertPageCategories(db, run.project_id, patches);
        }
      } catch (error) {
        console.error(`[crawlScope] page categories not stored for run ${run.id}:`, error.message);
      }

      const counts = severityCounts(findings);
      const rolled = {
        // NOT the full findings array — that's what was timing out (see
        // migration 0023). Full detail now lives in
        // crawl_run_finding_instances; readers use
        // repo.listAllRunFindingInstances(runId) instead of summary.findings.
        findingsCount: findings.length,
        counts,
        mediaLibrary: summary.mediaLibrary || null,
        integrations: summary.integrations || null,
        robotsStatus: summary.robotsStatus,
        elapsed: summary.elapsed,
        resultCount: Array.isArray(summary.results) ? summary.results.length : 0,
        // Why a crawl was partial, carried through to the report instead of
        // being flattened into a single "truncated" bit nobody could act on.
        truncated: Boolean(summary.truncated),
        depthLimited: Boolean(summary.depthLimited),
        edgesTruncated: Boolean(summary.edgesTruncated),
        trapTemplates: summary.trapTemplates || [],
        lostResultRows: lostRows,
      };
      await repo.updateRun(db, run.id, {
        status: summary.stopped ? "stopped" : "completed",
        summary: rolled,
        site_diagnostics: summary.siteDiagnostics || null,
        progress: crawler._progress ? crawler._progress() : {},
        finished_at: new Date().toISOString(),
        // The frontier is spent. Leaving it behind would let a later reclaim of
        // this row resume a run that has already reported.
        checkpoint: null,
        // A crawl that finished but could not store some of its pages is not a
        // clean crawl, and the UI reads `error` to say so.
        ...(lostRows
          ? { error: `${lostRows} crawled pages could not be stored; the report is incomplete.` }
          : {}),
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

      // Auto-sample PageSpeed for a handful of key pages. Opt-in
      // (CRAWLSCOPE_AUTO_PAGESPEED=true): PSI is slow and quota-limited, so
      // this firing by default the moment the feature ships would silently
      // multiply every completed crawl's PSI spend without anyone deciding
      // that should happen. Fire-and-forget, not awaited — a 5-page sample
      // through services/pageSpeedCA.js's batching/backoff can take minutes,
      // and this run is already reported "completed"; nothing downstream of
      // completion should wait on it. Consequence worth knowing: the
      // worker's emailed report is built from this function's return value
      // immediately after, so an auto-sampled PSI result generally will NOT
      // be in that email — it lands in crawl_run_results (and so the UI)
      // whenever the sample finishes, independent of completion/email timing.
      if (process.env.CRAWLSCOPE_AUTO_PAGESPEED === "true" && !summary.stopped) {
        samplePageSpeed(db, run, summary).catch((e) => {
          console.error(`[crawl ${run.id}] PageSpeed sample failed:`, e.message);
        });
      }

      return { run, summary, counts };
    } catch (error) {
      finalized = true;
      await flush().catch(() => {});
      await repo.updateRun(db, run.id, {
        status: "failed",
        error: String(error?.message || error),
        finished_at: new Date().toISOString(),
        checkpoint: null,
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
      clearInterval(control);
      this.crawlers.delete(run.id);
      try {
        await fetchImpl.close();
      } catch {
        // dispatcher already closed
      }
    }
  }
}

// HEARTBEAT_MS is exported because it is the latency of the control channel
// (migration 0025): the API tells the user how long a remote pause or stop will
// take, and only this module knows the interval.
// CONTROL_POLL_MS is exported alongside it because that — not the heartbeat —
// is now the latency the API quotes for a remote pause or stop.
module.exports = {
  RunManager, aggregateFindings, severityCounts, pickPageSpeedSample,
  HEARTBEAT_MS, CONTROL_POLL_MS,
};
