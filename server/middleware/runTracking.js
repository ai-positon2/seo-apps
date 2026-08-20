// ── Run-tracking middleware ─────────────────────────────────────────────────
// Records one tool_runs row per meaningful run of any module, generically, by
// observing the request/response instead of editing every route handler.
//
// Why a middleware: the modules here express a run in three different shapes,
// and all three are observable from the outside —
//
//   A. Plain JSON request/response      (seo-geo-audit /run, market-potential
//                                        /compare, …) → status + body.
//   B. POST /init → GET /stream/:token  (keyword-research, article-*,
//                                        image-alt-audit, location pages).
//      The input is on /init, the work and the outcome are on the SSE stream.
//      The two are bridged here by the token /init hands back, so the run row
//      carries the real input AND the real outcome.
//   C. Response returns first, work continues in the background
//      (on-page-audit, robots-monitor, competitor-tracker, competitor-analysis).
//      Marked `deferred` in the registry: the row opens as 'running' and the
//      module closes it via req.run.finish() when the work actually settles.
//
// Success/failure comes from the transport: HTTP status for JSON, and the
// terminal SSE event name for streams ('done'/'complete' vs 'fail'/'error').
// A stream that dies without a terminal event is recorded as 'cancelled' —
// which is what it is, not a success.
//
// The store is fire-and-forget and never throws (see runStore), and nothing
// here is awaited in the request path: resolving the workspace and inserting
// the row happen on a promise the response handler picks up at the end.

const runStore = require('../services/runStore');
const { resolveIdentity } = require('../services/workspaceContext');

// ── /init → /stream/:token bridge ───────────────────────────────────────────
// Shape B's input lives on the /init request; the stream that follows only
// carries an opaque token. Stashed here, briefly, so the run row gets both.
const PENDING_TTL_MS = 15 * 60 * 1000;
const PENDING_MAX = 500;
const pendingInputs = new Map(); // token → { input, action, label, at }

function stashPendingInput(token, entry) {
  if (!token) return;
  pendingInputs.set(token, { ...entry, at: Date.now() });
  if (pendingInputs.size > PENDING_MAX) {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [key, entry] of pendingInputs) {
      if (entry.at < cutoff) pendingInputs.delete(key);
    }
    // Still oversized (a burst of inits) — drop the oldest.
    while (pendingInputs.size > PENDING_MAX) {
      pendingInputs.delete(pendingInputs.keys().next().value);
    }
  }
}

function takePendingInput(token) {
  if (!token) return null;
  const entry = pendingInputs.get(token);
  if (!entry) return null;
  pendingInputs.delete(token);
  if (Date.now() - entry.at > PENDING_TTL_MS) return null;
  return entry;
}

// ── Input + label ───────────────────────────────────────────────────────────

function requestInput(req) {
  const input = {};
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    Object.assign(input, req.body);
  } else if (Array.isArray(req.body) && req.body.length) {
    input._body = req.body;
  }
  const query = req.query && Object.keys(req.query).length ? { ...req.query } : null;
  if (query) input._query = query;
  return Object.keys(input).length ? input : null;
}

// Keys worth showing in a runs list, most identifying first.
const LABEL_KEYS = [
  'url', 'targetUrl', 'keyword', 'brandName', 'domain', 'clientDomain',
  'name', 'clientId', 'client', 'serviceId', 'pageId', 'title', 'query',
];

function deriveLabel(input) {
  if (!input) return null;
  for (const key of LABEL_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
  }
  if (Array.isArray(input.urls) && input.urls.length) {
    const first = String(input.urls[0]);
    return input.urls.length > 1 ? `${first} +${input.urls.length - 1} more` : first;
  }
  if (Array.isArray(input.keywords) && input.keywords.length) {
    return input.keywords.slice(0, 3).join(', ');
  }
  return null;
}

// ── SSE outcome sniffing ────────────────────────────────────────────────────

const SSE_SUCCESS_EVENTS = new Set(['done', 'complete', 'completed']);
const SSE_FAILURE_EVENTS = new Set(['fail', 'failed', 'error']);
// Events whose payload is the run's result, worth keeping as the run output.
const SSE_PAYLOAD_EVENTS = new Set(['result', 'report', 'complete', 'summary', 'audit', 'findings']);

const MAX_SSE_BUFFER = 256 * 1024;  // residual buffer ceiling
const MAX_SSE_BLOCK = 512 * 1024;   // don't JSON.parse a block bigger than this

function createSseSniffer() {
  const state = { isSse: false, success: false, error: null, payload: null };
  let buffer = '';

  function parseBlock(block) {
    const eventMatch = /^event:\s*(\S+)/m.exec(block);
    if (!eventMatch) return;
    const event = eventMatch[1].toLowerCase();

    if (SSE_SUCCESS_EVENTS.has(event)) state.success = true;

    const wantsData = SSE_FAILURE_EVENTS.has(event) || SSE_PAYLOAD_EVENTS.has(event);
    if (!wantsData || block.length > MAX_SSE_BLOCK) {
      if (SSE_FAILURE_EVENTS.has(event) && !state.error) state.error = `Stream reported "${event}".`;
      return;
    }

    const dataMatch = /^data:\s*([\s\S]*)$/m.exec(block);
    let data = null;
    if (dataMatch) {
      try { data = JSON.parse(dataMatch[1]); } catch { data = null; }
    }

    if (SSE_FAILURE_EVENTS.has(event)) {
      state.error = (data && (data.message || data.error)) || `Stream reported "${event}".`;
      return;
    }
    // A payload event: keep the last one seen (later ones supersede earlier).
    if (data !== null) state.payload = data;
  }

  return {
    state,
    feed(chunk) {
      if (chunk === null || chunk === undefined) return;
      let text;
      if (typeof chunk === 'string') text = chunk;
      else if (Buffer.isBuffer(chunk)) text = chunk.toString('utf8');
      else return;
      if (!text.includes('event:') && !buffer) return;

      state.isSse = true;
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        parseBlock(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
      if (buffer.length > MAX_SSE_BUFFER) buffer = buffer.slice(-1024);
    },
  };
}

// ── Matching ────────────────────────────────────────────────────────────────

function matches(matcher, method, path) {
  if (matcher.method && matcher.method !== method) return null;
  if (matcher.path instanceof RegExp) return matcher.path.exec(path);
  if (typeof matcher.path === 'string') return matcher.path === path ? [path] : null;
  return null;
}

function findMatcher(matchers, method, path) {
  for (const matcher of matchers) {
    const match = matches(matcher, method, path);
    if (match) return { matcher, match };
  }
  return null;
}

function safeLabel(fn, ctx) {
  try {
    const value = fn(ctx);
    return value ? String(value).slice(0, 300) : null;
  } catch (e) {
    return null;
  }
}

// ── Middleware factory ──────────────────────────────────────────────────────

// config: { toolId, matchers: [{ method, path, action, bridge, deferred, label }] }
function trackRuns(config) {
  if (!config || !config.toolId || !Array.isArray(config.matchers)) {
    return function noRunTracking(req, res, next) { next(); };
  }
  const { toolId, matchers } = config;

  return function runTracking(req, res, next) {
    const found = findMatcher(matchers, req.method, req.path);
    if (!found) return next();
    const { matcher, match } = found;

    // Shape B, step 1: /init carries the input but does no work. Capture the
    // token it hands back and stash the input against it — no run row yet.
    if (matcher.bridge === 'init') {
      const initInput = requestInput(req);
      // The action and label are known here (which button was pressed, which
      // page id was in the path) but not on the shared /stream endpoint, so
      // they travel with the stashed input.
      const initEntry = {
        input: initInput,
        action: matcher.action || 'run',
        label: matcher.label ? safeLabel(matcher.label, { req, input: initInput, match }) : deriveLabel(initInput),
      };
      const originalInitJson = res.json.bind(res);
      res.json = function trackedInitJson(body) {
        try {
          if (res.statusCode < 400 && body && body.token) stashPendingInput(body.token, initEntry);
        } catch (e) {
          console.error('[runTracking.init]', e.message);
        }
        return originalInitJson(body);
      };
      return next();
    }

    // Shape B, step 2 — pair the stream back up with its /init input.
    const pending = matcher.bridge === 'stream'
      ? takePendingInput(req.path.split('/').filter(Boolean).pop())
      : null;
    const input = pending ? pending.input : requestInput(req);

    const action = pending?.action || matcher.action || 'run';
    const label = matcher.label
      ? safeLabel(matcher.label, { req, input, match })
      : (pending?.label || deriveLabel(input));

    const startedAt = Date.now();

    // Not awaited: the run row is inserted alongside the request, and the
    // response handler picks the id up off this promise when it settles.
    const runIdPromise = (async () => {
      try {
        const identity = await resolveIdentity(req);
        return await runStore.startRun({
          userId: identity.userId,
          workspaceId: identity.workspaceId,
          actorEmail: identity.actorEmail || req.user?.username || null,
          toolId,
          action,
          label,
          input,
          method: req.method,
          path: (req.baseUrl || '') + req.path,
        });
      } catch (e) {
        console.error('[runTracking.start]', e.message);
        return null;
      }
    })();

    let settled = false;

    async function settle({ status, output, error, label: finalLabel }) {
      if (settled) return;
      settled = true;
      try {
        const runId = await runIdPromise;
        if (!runId) return;
        await runStore.finishRun(runId, {
          status, output, error, label: finalLabel, durationMs: Date.now() - startedAt,
        });
      } catch (e) {
        console.error('[runTracking.settle]', e.message);
      }
    }

    // Modules whose work outlives the response close their own run.
    req.run = {
      toolId,
      get id() { return runIdPromise; },
      finish(patch = {}) { return settle({ status: 'completed', ...patch }); },
      fail(error, patch = {}) { return settle({ status: 'failed', error, ...patch }); },
    };

    // ── Observe the response ────────────────────────────────────────────────
    let jsonBody = null;
    const originalJson = res.json.bind(res);
    res.json = function trackedJson(body) {
      jsonBody = body;
      return originalJson(body);
    };

    const sniffer = createSseSniffer();

    // Sniffing means decoding every chunk, so it is limited to actual event
    // streams — decided once, off the content type the handler set before its
    // first write. Tracked endpoints that stream a .docx/.pdf/.xlsx download
    // therefore pay nothing for it.
    let sniffDecided = false;
    let sniffing = false;
    function shouldSniff() {
      if (!sniffDecided) {
        sniffing = String(res.getHeader('Content-Type') || '').includes('text/event-stream');
        sniffDecided = true;
      }
      return sniffing;
    }

    const originalWrite = res.write.bind(res);
    res.write = function trackedWrite(chunk, ...rest) {
      try { if (shouldSniff()) sniffer.feed(chunk); } catch (e) { /* never break the stream */ }
      return originalWrite(chunk, ...rest);
    };
    // A handler may deliver its last event through res.end(chunk) rather than
    // a final write, so that chunk has to be sniffed too or the run would look
    // cancelled when it actually completed.
    const originalEnd = res.end.bind(res);
    res.end = function trackedEnd(chunk, ...rest) {
      try {
        if ((typeof chunk === 'string' || Buffer.isBuffer(chunk)) && shouldSniff()) sniffer.feed(chunk);
      } catch (e) { /* never break the response */ }
      return originalEnd(chunk, ...rest);
    };

    function finalize(aborted) {
      if (settled) return;
      const sse = sniffer.state;

      if (sse.isSse) {
        if (sse.error) return settle({ status: 'failed', error: sse.error, output: sse.payload });
        if (sse.success) return settle({ status: 'completed', output: sse.payload });
        return settle({
          status: 'cancelled',
          error: aborted
            ? 'Client disconnected before the run finished.'
            : 'Stream ended before the run reported completion.',
          output: sse.payload,
        });
      }

      if (res.statusCode >= 400) {
        const message = (jsonBody && (jsonBody.error || jsonBody.message)) || `HTTP ${res.statusCode}`;
        return settle({ status: 'failed', error: message, output: null });
      }

      if (aborted) {
        return settle({ status: 'cancelled', error: 'Client disconnected before the response completed.' });
      }

      // Deferred runs stay 'running' here — the module reports the real
      // outcome via req.run.finish() once the background work settles. The
      // stale-run sweeper is the backstop if the process dies first.
      if (matcher.deferred) return undefined;

      return settle({ status: 'completed', output: jsonBody });
    }

    res.on('finish', () => finalize(false));
    res.on('close', () => { if (!res.writableFinished) finalize(true); });

    next();
  };
}

// findMatcher is exported for the registry test, which checks every matcher in
// server/config/runTracking.js against the routes its module actually declares
// — a typo there would otherwise silently track nothing.
module.exports = { trackRuns, deriveLabel, findMatcher };
