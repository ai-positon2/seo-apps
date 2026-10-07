// ── Runs API ────────────────────────────────────────────────────────────────
// Reads the run history that server/middleware/runTracking.js writes. Always
// scoped to one workspace: the caller's home workspace (see
// services/workspaceContext.js) — for Position2 staff, the one team workspace
// everyone's runs land in — and a run's detail is only readable by someone who
// belongs to the workspace the run landed in.

const express = require('express');
const runStore = require('../services/runStore');
const identityStore = require('../services/identityStore');
const { resolveIdentity } = require('../services/workspaceContext');
const { isDatabaseConfigured } = require('../services/db');
const { TRACKED_TOOL_IDS } = require('../config/runTracking');
const jobs = require('../services/jobs');
const { ApiError, notFound, forbidden, uuidParam, openSse } = require('../utils/api');

const router = express.Router();

const MAX_LIMIT = 200;

function clampLimit(raw, fallback = 50) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIMIT);
}

// Resolves the workspace this request reads from, plus the workspace's own
// details (name + primary user) so the UI can say whose runs it is showing.
async function activeWorkspace(req) {
  const identity = await resolveIdentity(req);
  if (!identity.workspaceId) return { identity, workspace: null };
  let workspace = null;
  try {
    const all = await identityStore.listWorkspacesForUser(identity.userId);
    workspace = all.find(w => w.id === identity.workspaceId) || null;
  } catch (e) {
    console.error('[runs.activeWorkspace]', e.message);
  }
  return { identity, workspace };
}

function workspaceView(workspace, identity) {
  if (!workspace) return identity.workspaceId ? { id: identity.workspaceId } : null;
  return {
    id: workspace.id,
    name: workspace.name,
    isPersonal: Boolean(workspace.is_personal),
    myRole: workspace.myRole || null,
    ownerEmail: workspace.ownerEmail || null,
  };
}

// Every read here goes through runStore and identityStore, whose failures carry
// database detail: a dead upstream is reported as `upstream unavailable:
// connect ECONNREFUSED <host>:<port>` and a bad credential as `password
// authentication failed for user "…"`. Those messages were being returned
// verbatim to any signed-in caller. An error raised deliberately (one carrying
// a status) still speaks for itself; anything else is logged and generalised,
// matching routes/admin.js and server.js's final error handler.
function handleError(res, e, req) {
  if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error('[runs]', req?.method, req?.originalUrl, e?.stack || e?.message || e);
  res.status(500).json({ error: 'Something went wrong loading run history.' });
}

function notConfigured(res) {
  return res.status(503).json({
    error: 'Run history needs the database configured (DATABASE_URL).',
    runs: [], total: 0, workspace: null, trackedTools: TRACKED_TOOL_IDS,
  });
}

// GET /api/runs — the active workspace's run history, newest first.
// Filters: toolId, status, action, q (label search), mine=1, limit, offset.
router.get('/', async (req, res) => {
  if (!isDatabaseConfigured()) return notConfigured(res);
  try {
    const { identity, workspace } = await activeWorkspace(req);
    if (!identity.workspaceId) {
      return res.json({ runs: [], total: 0, workspace: null, trackedTools: TRACKED_TOOL_IDS });
    }

    const limit = clampLimit(req.query.limit);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { runs, total } = await runStore.listRuns({
      workspaceId: identity.workspaceId,
      userId: req.query.mine === '1' ? identity.userId : null,
      toolId: req.query.toolId || null,
      status: req.query.status || null,
      action: req.query.action || null,
      search: req.query.q ? String(req.query.q).slice(0, 120) : null,
      limit,
      offset,
    });

    res.json({
      runs,
      total,
      limit,
      offset,
      workspace: workspaceView(workspace, identity),
      trackedTools: TRACKED_TOOL_IDS,
      viewerUserId: identity.userId || null,
    });
  } catch (e) {
    handleError(res, e, req);
  }
});

// GET /api/runs/stats — per-tool rollup for the active workspace. `toolId`
// narrows it to one tool, for the run panel on that module's own page.
router.get('/stats', async (req, res) => {
  if (!isDatabaseConfigured()) return notConfigured(res);
  try {
    const { identity, workspace } = await activeWorkspace(req);
    if (!identity.workspaceId) {
      return res.json({ tools: [], totals: null, workspace: null, trackedTools: TRACKED_TOOL_IDS });
    }
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const stats = await runStore.runStats({
      workspaceId: identity.workspaceId,
      days,
      toolId: req.query.toolId || null,
    });
    res.json({ ...stats, days, workspace: workspaceView(workspace, identity), trackedTools: TRACKED_TOOL_IDS });
  } catch (e) {
    handleError(res, e, req);
  }
});

// A run id that cannot be a UUID is a 404 — before this, the uuid cast failed
// in runStore.getRun, which logged it and answered "Run not found." anyway.
router.param('id', uuidParam('Run'));

// The run a request names, if the caller belongs to its workspace (not just the
// active one, so a link to a run in another of your workspaces still opens).
async function visibleRun(req) {
  const identity = await resolveIdentity(req);
  if (!identity.userId) throw notFound('Run not found.');
  const workspaces = await identityStore.listWorkspacesForUser(identity.userId);
  const run = await runStore.getRun(req.params.id, workspaces.map(w => w.id));
  if (!run) throw notFound('Run not found.');
  return { identity, run };
}

// GET /api/runs/:id — one run with its full input/output (and, for a job, its
// latest progress). Readable only by a member of the run's workspace.
router.get('/:id', async (req, res) => {
  if (!isDatabaseConfigured()) return notConfigured(res);
  try {
    const { run } = await visibleRun(req);
    res.json({ run });
  } catch (e) {
    handleError(res, e, req);
  }
});

// GET /api/runs/:id/events — the run's events as server-sent events, oldest
// first, ending with a terminal `status` event. Resumable: the browser sends
// back the last event id it saw (Last-Event-ID) when it reconnects, and
// `?after=<id>` does the same by hand. A run recorded before jobs existed has
// no events; it gets a single `status` event once it has ended.
const EVENTS_POLL_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

router.get('/:id/events', async (req, res) => {
  if (!isDatabaseConfigured()) return notConfigured(res);
  let run;
  try {
    ({ run } = await visibleRun(req));
  } catch (e) {
    return handleError(res, e, req);
  }

  const after = Number(req.get('Last-Event-ID') || req.query.after || 0);
  let cursor = Number.isFinite(after) && after > 0 ? after : 0;
  const sse = openSse(res, { retryMs: 3000 });

  try {
    while (!sse.closed) {
      const rows = await jobs.eventsAfter(run.id, cursor);
      let ended = false;
      for (const row of rows) {
        sse.send(row.event, row.data, row.id);
        cursor = Number(row.id);
        if (row.event === 'status' && jobs.TERMINAL.has(row.data?.status)) ended = true;
      }
      if (ended) break;
      if (!rows.length) {
        const status = await jobs.runStatus(run.id);
        // The job writes its terminal event before it marks the row, so a row
        // that has ended with nothing left to send never had events at all.
        if (jobs.TERMINAL.has(status)) {
          sse.send('status', { status });
          break;
        }
        await sleep(EVENTS_POLL_MS);
      }
    }
  } catch (e) {
    console.error('[runs.events]', run.id, e.message);
    sse.send('error', { error: 'The live updates stopped. Reload to pick them up again.', code: 'stream_failed' });
  }
  sse.close();
});

// GET /api/runs/:id/result — what the run produced: the value a job returned,
// or the stored (size-capped) output of any other run.
router.get('/:id/result', async (req, res) => {
  if (!isDatabaseConfigured()) return notConfigured(res);
  try {
    const { run } = await visibleRun(req);
    const result = run.is_job ? await jobs.latestResult(run.id) : undefined;
    const value = result !== undefined ? result : run.output;
    if (value === undefined || value === null) {
      throw new ApiError(404, 'no_result', run.status === 'running'
        ? 'This run has not finished yet.'
        : 'This run did not produce a result.');
    }
    res.json({ result: value });
  } catch (e) {
    handleError(res, e, req);
  }
});

// POST /api/runs/:id/cancel — stops a running job. Only the person who started
// it may cancel it. 202 with the run as it stands; a run that had already
// ended is returned unchanged.
router.post('/:id/cancel', async (req, res) => {
  if (!isDatabaseConfigured()) return notConfigured(res);
  try {
    const { identity, run } = await visibleRun(req);
    if (run.user_id && run.user_id !== identity.userId) {
      throw forbidden('Only the person who started this run can cancel it.');
    }
    if (!run.is_job) {
      throw new ApiError(409, 'not_cancellable', 'This run cannot be cancelled.');
    }
    const outcome = await jobs.cancelJob(run.id);
    const workspaces = await identityStore.listWorkspacesForUser(identity.userId);
    const latest = await runStore.getRun(run.id, workspaces.map(w => w.id));
    res.status(outcome === 'finished' ? 200 : 202).json({ run: latest || run, cancel: outcome });
  } catch (e) {
    handleError(res, e, req);
  }
});

module.exports = router;
