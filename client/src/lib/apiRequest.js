// ── One request helper for every /api call ──────────────────────────────────
// Each module's API file used to carry its own copy of this (thirteen of them),
// and they disagreed on what an error carried: some kept the status and code,
// most kept only the message. The server answers every failure as
//
//   { error: "<message>", code: "<snake_case>", details?: {...} }
//
// so this keeps all of it. Callers branch on `err.status` / `err.code`, show
// `err.message`, and read anything extra from `err.details` or `err.body`.
//
// The options are fetch's own (method, body, headers, signal…): an existing
// `req(path, { method: 'POST', body: JSON.stringify(x) })` call works unchanged.

export class ApiRequestError extends Error {
  constructor(message, { status, code, details, body } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.body = body;
    // runsApi.js used to set this; ModuleRuns.jsx reads it.
    this.unavailable = status === 503;
  }
}

function buildInit(options = {}) {
  const headers = { ...(options.headers || {}) };
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body !== undefined && !isForm && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  return { credentials: 'include', ...options, headers };
}

async function readBody(res) {
  let text = '';
  try { text = await res.text(); } catch { return null; }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function toError(res, fallbackMessage) {
  const body = await readBody(res);
  const message = (body && typeof body.error === 'string' && body.error)
    || (fallbackMessage ? `${fallbackMessage} (${res.status})` : `Request failed (${res.status})`);
  return new ApiRequestError(message, { status: res.status, code: body?.code, details: body?.details, body });
}

/** fetch + JSON. Resolves the parsed body (null when empty); throws ApiRequestError. */
export async function requestJson(url, options = {}) {
  const res = await fetch(url, buildInit(options));
  if (!res.ok) throw await toError(res);
  return readBody(res);
}

/**
 * fetch for downloads and streams: resolves the Response itself when it is ok.
 * `fallbackMessage` names the action ("Export failed") when the error body
 * carries no message of its own.
 */
export async function requestRaw(url, options = {}, fallbackMessage) {
  const res = await fetch(url, buildInit(options));
  if (!res.ok) throw await toError(res, fallbackMessage);
  return res;
}
