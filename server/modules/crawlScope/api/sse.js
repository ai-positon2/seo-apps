// Server-Sent Events stream for a single run.
//
// Cross-process safe: it tails Supabase (run_results + runs.status/progress) rather
// than listening to an in-memory crawler, so it works whether the crawl runs in this
// web process (manual) or the worker (scheduled). Uses a 15s heartbeat comment to
// keep idle proxies from killing the connection, and Last-Event-ID (the last result
// row id) so a reconnecting client resumes without duplicating rows.

const repo = require("../db/repo");

const POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const PAGE = 200;
const TERMINAL = new Set(["completed", "failed", "stopped"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `owner` scopes the run lookup explicitly. In this app the route always gets the
// service-role client (there is no Supabase Auth session to scope one to), so RLS
// never applies — this filter IS the tenancy check, not a second line of defence.
// `viewer` is { userId, workspaceIds } — the same scope the REST routes use. It
// replaced a bare owner id: a live crawl was streamable only by whoever started
// it, so a teammate watching the same client's site got "Run not found" while the
// crawl was visibly running on the dashboard.
async function streamRun(req, res, client, runId, viewer = null) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering
  });
  res.write("retry: 3000\n\n");

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const send = (event, data, id) => {
    if (closed) return;
    if (id != null) res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, HEARTBEAT_MS);

  // Resume point: last result row id the client already has.
  let cursor = Number(req.headers["last-event-id"]) || 0;

  try {
    const first = await repo.getRunForViewer(client, runId, viewer);
    if (!first) {
      send("error", { message: "Run not found." });
      return;
    }
    send("state", { state: first.status });

    for (;;) {
      if (closed) break;

      let rowsQuery = client
        .from("crawl_run_results")
        .select("id,data")
        .eq("run_id", runId);
      // The run was authorized above and these rows are the run's, so run_id is
      // the tenancy check here. It used to also filter on owner, which meant a
      // teammate who could open the run streamed zero result rows into it.
      const rows = await rowsQuery
        .gt("id", cursor)
        .order("id", { ascending: true })
        .limit(PAGE);
      if (rows.error) throw new Error(rows.error.message);
      for (const row of rows.data) {
        send("result", row.data, row.id);
        cursor = row.id;
      }

      const run = await repo.getRunForViewer(client, runId, viewer);
      if (run) {
        // heartbeatAt and status ride along with progress.
        //
        // `state` is sent once, at connection, and never again — so a client
        // watching a crawl had no way to learn that it had been paused, or had
        // died, until the run reached a terminal state and `complete` arrived.
        // Two consequences, both real: a "stop requested" notice stayed on
        // screen forever because nothing told the page the stop had landed, and
        // a page that computed staleness from the run row it fetched on mount
        // declared a perfectly healthy crawl dead after four missed beats of a
        // heartbeat value that was frozen at page load.
        //
        // This loop already re-reads the run every POLL_MS to check for a
        // terminal status, so both fields are in hand and cost nothing to send.
        send("progress", {
          ...(run.progress || {}),
          heartbeatAt: run.heartbeat_at || null,
          status: run.status,
        });
        if (TERMINAL.has(run.status)) {
          // Drain any final rows written after the last page.
          if (rows.data.length === PAGE) continue;
          send("complete", {
            status: run.status,
            summary: run.summary || null,
            error: run.error || null,
            siteDiagnostics: run.site_diagnostics || null,
          });
          break;
        }
      }
      await sleep(POLL_MS);
    }
  } catch (error) {
    send("error", { message: String(error.message) });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

module.exports = { streamRun };
