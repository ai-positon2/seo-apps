// ── Run store (tool_runs) ────────────────────────────────────────────────────
// One row per tracked run of any module: who ran it, in which workspace, what
// went in, what came out, how long it took, and whether it succeeded.
//
// Two hard rules, because this sits in the request path of every module:
//   1. NOTHING here throws into a caller. A tracking failure must never turn a
//      working tool into a 500 — every entry point catches and logs instead.
//   2. Payloads are sanitized and size-capped before they are stored (see
//      sanitize() below). Modules routinely pass around whole HTML documents,
//      CSV uploads and multi-megabyte audit results; storing those verbatim
//      would bloat the table and, worse, could persist API keys.
//
// Schema: supabase/migrations/0009_run_tracking.sql

const crypto = require('crypto');
const db = require('./db');

// Serialized jsonb budget per column. Generous enough for a real input payload
// or a summarized result, small enough that a runaway module can't bloat the row.
const MAX_JSON_BYTES = 16 * 1024;
const MAX_STRING_CHARS = 600;
const MAX_ARRAY_SAMPLE = 5;
const MAX_DEPTH = 4;

// Keys whose VALUE is never stored, at any depth.
const SECRET_KEY_RE = /(pass|secret|token|api[-_]?key|apikey|authorization|auth|cookie|credential|bearer)/i;
// Keys whose value is a content blob — replaced by a size marker, since the
// blob itself is either huge, already stored by the module, or both.
const BLOB_KEY_RE = /^(html|rawhtml|pastedhtml|content|manualcontent|markdown|body|text|csv|csvtext|positionfiles|refdomainfiles|reportdata|pagedata|sections)$/i;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Depth- and size-bounded projection of an arbitrary payload. Preserves the
// shape a human needs to recognize a run ("which URL, how many keywords,
// which models") without preserving the payload itself.
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return null;

  const type = typeof value;
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'string') {
    if (value.length <= MAX_STRING_CHARS) return value;
    return { _type: 'text', chars: value.length, preview: value.slice(0, MAX_STRING_CHARS) };
  }
  if (type !== 'object') return String(value).slice(0, MAX_STRING_CHARS);

  if (depth >= MAX_DEPTH) return { _type: Array.isArray(value) ? 'array' : 'object', _elided: true };

  if (Array.isArray(value)) {
    const sample = value.slice(0, MAX_ARRAY_SAMPLE).map(v => sanitize(v, depth + 1));
    return value.length > MAX_ARRAY_SAMPLE
      ? { _type: 'array', length: value.length, sample }
      : sample;
  }

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) { out[key] = '[redacted]'; continue; }
    if (BLOB_KEY_RE.test(key)) {
      if (typeof v === 'string') out[key] = { _type: 'text', chars: v.length };
      else if (Array.isArray(v)) out[key] = { _type: 'array', length: v.length };
      else if (isPlainObject(v)) out[key] = { _type: 'object', keys: Object.keys(v).slice(0, 20) };
      else out[key] = sanitize(v, depth + 1);
      continue;
    }
    out[key] = sanitize(v, depth + 1);
  }
  return out;
}

// Sanitize, then enforce the byte budget. Returns { value, truncated }.
function capped(raw) {
  if (raw === null || raw === undefined) return { value: null, truncated: false };
  let value;
  try {
    value = sanitize(raw);
  } catch (e) {
    return { value: { _error: 'could not serialize payload' }, truncated: true };
  }
  let json;
  try {
    json = JSON.stringify(value);
  } catch (e) {
    return { value: { _error: 'could not serialize payload' }, truncated: true };
  }
  if (json.length <= MAX_JSON_BYTES) return { value, truncated: false };

  // Over budget: keep top-level keys only, dropping their contents.
  if (isPlainObject(value)) {
    const shallow = {};
    for (const [k, v] of Object.entries(value)) {
      shallow[k] = isPlainObject(v) || Array.isArray(v)
        ? { _type: Array.isArray(v) ? 'array' : 'object', _elided: true }
        : v;
    }
    const shallowJson = JSON.stringify(shallow);
    if (shallowJson.length <= MAX_JSON_BYTES) return { value: shallow, truncated: true };
    return { value: { _keys: Object.keys(value).slice(0, 40), _bytes: json.length }, truncated: true };
  }
  return { value: { _bytes: json.length, _elided: true }, truncated: true };
}

function log(op, err) {
  console.error(`[runStore.${op}]`, err?.message || err);
}

// ── Write path ──────────────────────────────────────────────────────────────

// Inserts a 'running' row and resolves to its id (null when tracking is off or
// the insert failed — every caller must tolerate a null id). Awaited inside so
// that a later finishRun() can never race ahead of its own insert.
async function startRun({ userId, workspaceId, actorEmail, toolId, action, label, input, method, path }) {
  if (!db.isDatabaseConfigured() || !toolId) return null;
  const id = crypto.randomUUID();
  const { value, truncated } = capped(input);
  try {
    await db.insertOne('tool_runs', {
      id,
      user_id: userId || null,
      workspace_id: workspaceId || null,
      actor_email: actorEmail || null,
      tool_id: toolId,
      action: action || 'run',
      label: label ? String(label).slice(0, 300) : null,
      status: 'running',
      input: value,
      input_truncated: truncated,
      request_method: method || null,
      request_path: path ? String(path).slice(0, 300) : null,
    }, { returning: false });
    return id;
  } catch (e) {
    log('startRun', e);
    return null;
  }
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

// `label` is optional here: a module that only learns what the run was for
// once the work starts (a job id resolved to a brand, say) can enrich the row
// on the way out. Omit it and the label captured at start-time stands.
async function finishRun(runId, { status, output, error, durationMs, label } = {}) {
  if (!runId || !db.isDatabaseConfigured()) return;
  const finalStatus = TERMINAL.has(status) ? status : 'completed';
  const { value, truncated } = capped(output);
  const now = new Date().toISOString();
  try {
    await db.updateWhere('tool_runs', {
      status: finalStatus,
      output: value,
      output_truncated: truncated,
      ...(label ? { label: String(label).slice(0, 300) } : {}),
      error: error ? String(error).slice(0, 2000) : null,
      duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      completed_at: now,
      updated_at: now,
    }, { id: runId });
  } catch (e) {
    log('finishRun', e);
  }
}

// A run whose process died mid-flight (deploy, restart, crash) would sit at
// 'running' forever. Swept on an interval from server.js so the runs list only
// ever shows genuinely in-flight work as running.
async function sweepStaleRuns({ olderThanMinutes = 120 } = {}) {
  if (!db.isDatabaseConfigured()) return 0;
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  try {
    const swept = await db.rows(
      `update tool_runs
          set status = 'failed',
              error = 'Run never reported completion (server restart or timeout).',
              completed_at = $1,
              updated_at = $1
        where status = 'running' and created_at < $2
        returning id`,
      [now, cutoff]
    );
    return swept.length;
  } catch (e) {
    log('sweepStaleRuns', e);
    return 0;
  }
}

// ── Read path ───────────────────────────────────────────────────────────────

const LIST_COLUMNS =
  'id, user_id, workspace_id, actor_email, tool_id, action, label, status, error, ' +
  'duration_ms, created_at, completed_at, input_truncated, output_truncated';

// Always workspace-scoped — the caller (routes/runs.js) has already confirmed
// the requester is a member of that workspace.
async function listRuns({ workspaceId, userId, toolId, status, action, search, limit = 50, offset = 0 }) {
  if (!db.isDatabaseConfigured()) return { runs: [], total: 0 };
  try {
    const params = [workspaceId];
    const where = ['workspace_id = $1'];
    const narrow = (value, clause) => {
      if (!value) return;
      params.push(value);
      where.push(clause(params.length));
    };
    narrow(userId, (i) => `user_id = $${i}`);
    narrow(toolId, (i) => `tool_id = $${i}`);
    narrow(status, (i) => `status = $${i}`);
    narrow(action, (i) => `action = $${i}`);
    // The caller's text is bound as a parameter; % and _ inside it still act as
    // wildcards, exactly as they did through PostgREST's ilike.
    narrow(search ? `%${search}%` : null, (i) => `label ilike $${i}`);

    // count(*) over () carries the unpaged total back with the page itself,
    // which is what { count: 'exact' } plus a Range header did in one trip.
    params.push(limit, offset);
    const page = await db.rows(
      `select ${LIST_COLUMNS}, count(*) over () as _total
         from tool_runs
        where ${where.join(' and ')}
        order by created_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params
    );

    const total = page.length ? Number(page[0]._total) : 0;
    return { runs: page.map(({ _total, ...run }) => run), total };
  } catch (e) {
    log('listRuns', e);
    return { runs: [], total: 0 };
  }
}

// Full row including input/output. Returns null when the run doesn't exist or
// isn't in one of the workspaces the requester belongs to.
async function getRun(runId, allowedWorkspaceIds = []) {
  if (!db.isDatabaseConfigured()) return null;
  try {
    const data = await db.maybeOne(`select * from tool_runs where id = $1`, [runId]);
    if (!data) return null;
    if (!data.workspace_id || !allowedWorkspaceIds.includes(data.workspace_id)) return null;
    return data;
  } catch (e) {
    log('getRun', e);
    return null;
  }
}

// Per-tool rollup for the workspace over a trailing window. Aggregated in JS:
// the row set is (tool_id, status, duration) only, and the window keeps it small.
// `toolId` narrows it to one tool, which is what a module's own run panel needs.
async function runStats({ workspaceId, days = 30, toolId = null }) {
  if (!db.isDatabaseConfigured()) return { tools: [], totals: { total: 0, completed: 0, failed: 0, running: 0, cancelled: 0 } };
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const params = [workspaceId, since];
    let narrowTool = '';
    if (toolId) {
      params.push(toolId);
      narrowTool = ` and tool_id = $${params.length}`;
    }
    const data = await db.rows(
      `select tool_id, status, duration_ms, created_at
         from tool_runs
        where workspace_id = $1 and created_at >= $2${narrowTool}
        order by created_at desc
        limit 5000`,
      params
    );

    const totals = { total: 0, completed: 0, failed: 0, running: 0, cancelled: 0 };
    const byTool = new Map();
    for (const row of data || []) {
      totals.total += 1;
      if (totals[row.status] !== undefined) totals[row.status] += 1;
      let t = byTool.get(row.tool_id);
      if (!t) {
        t = { toolId: row.tool_id, total: 0, completed: 0, failed: 0, running: 0, cancelled: 0, durationSum: 0, durationCount: 0, lastRunAt: row.created_at };
        byTool.set(row.tool_id, t);
      }
      t.total += 1;
      if (t[row.status] !== undefined) t[row.status] += 1;
      if (Number.isFinite(row.duration_ms)) { t.durationSum += row.duration_ms; t.durationCount += 1; }
      if (row.created_at > t.lastRunAt) t.lastRunAt = row.created_at;
    }

    const tools = [...byTool.values()].map(t => ({
      toolId: t.toolId, total: t.total, completed: t.completed, failed: t.failed,
      running: t.running, cancelled: t.cancelled, lastRunAt: t.lastRunAt,
      avgDurationMs: t.durationCount ? Math.round(t.durationSum / t.durationCount) : null,
    })).sort((a, b) => b.total - a.total);

    return { tools, totals };
  } catch (e) {
    log('runStats', e);
    return { tools: [], totals: { total: 0, completed: 0, failed: 0, running: 0, cancelled: 0 } };
  }
}

module.exports = { startRun, finishRun, sweepStaleRuns, listRuns, getRun, runStats, sanitize, capped };
