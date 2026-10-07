// ── Long-running runs: start one, follow it, pick it up again ───────────────
// The server side is server/services/jobs.js. A run is started with a POST that
// answers 202 { run }, then followed through GET /api/runs/:id/events — server-
// sent events that replay from the start, so a refreshed page (or a second tab)
// rebuilds the same view. The run id is kept in the page URL (?run=<id>) so a
// refresh finds it again.
//
// Events: whatever the tool emits (step, url_done, recommendations…), plus
//   result  — what the run produced
//   error   — { error, code } when it failed
//   status  — { status, code?, error? }; always last. completed | failed | cancelled
//
// EventSource reconnects on its own after a dropped connection and sends the
// last event id back, so nothing is replayed twice. A browser-level connection
// error is also delivered as an `error` event, but without data; those are
// reconnects, not failures, and are not passed to the page's handler.

import { requestJson } from './apiRequest.js';

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** POST the input; resolves the run summary ({ id, status, … }). */
export async function startRun(url, body) {
  const data = await requestJson(url, { method: 'POST', body: JSON.stringify(body ?? {}) });
  return data.run;
}

export async function cancelRun(runId) {
  return requestJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
}

export async function getRun(runId) {
  const data = await requestJson(`/api/runs/${encodeURIComponent(runId)}`);
  return data.run;
}

export async function getRunResult(runId) {
  const data = await requestJson(`/api/runs/${encodeURIComponent(runId)}/result`);
  return data.result;
}

function parse(event) {
  try { return JSON.parse(event.data); } catch { return null; }
}

/**
 * Follows a run's events. `handlers` maps event names to functions called with
 * the parsed data: { step(d){…}, result(d){…}, error(d){…}, status(d){…} }.
 * The stream closes itself after a terminal status. Returns stop().
 */
export function followRun(runId, handlers = {}, { EventSourceImpl = globalThis.EventSource } = {}) {
  const source = new EventSourceImpl(`/api/runs/${encodeURIComponent(runId)}/events`, { withCredentials: true });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    source.close();
  };

  for (const [name, handler] of Object.entries(handlers)) {
    if (name === 'status' || name === 'error' || typeof handler !== 'function') continue;
    source.addEventListener(name, (event) => {
      if (!stopped) handler(parse(event), event);
    });
  }

  source.addEventListener('error', (event) => {
    if (stopped || event?.data === undefined || event?.data === null) return;
    handlers.error?.(parse(event), event);
  });

  source.addEventListener('status', (event) => {
    if (stopped) return;
    const data = parse(event) || {};
    handlers.status?.(data, event);
    if (TERMINAL_STATUSES.has(data.status)) stop();
  });

  return stop;
}

/** The run id in the current page URL (?run=), or null. */
export function getRunIdFromUrl(location = globalThis.location) {
  try {
    return new URL(location.href).searchParams.get('run');
  } catch {
    return null;
  }
}

/** Puts the run id in the URL (or removes it with null) without a navigation. */
export function setRunIdInUrl(runId, { location = globalThis.location, history = globalThis.history } = {}) {
  try {
    const url = new URL(location.href);
    if (runId) url.searchParams.set('run', runId);
    else url.searchParams.delete('run');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* no URL to keep it in — the run still works, a refresh just won't find it */
  }
}
