// ── API errors: one shape for every /api response that fails ─────────────────
//
//   { "error": "<sentence a person can read>", "code": "<snake_case>", "details"?: {...} }
//
// `error` stays a plain string because every client request helper reads it as
// the message to show. `code` is what code branches on (duplicate_domain,
// migration_needed, run_in_progress…), and `details` carries anything extra
// (the existing project id, the run that is already going, the zod issues).
//
// Routes throw an ApiError (or call next(err)); the global handler in server.js
// turns any error into this body with errorBody(). A 5xx that is not an
// ApiError never shows its message: those carry connection strings, SQL and
// upstream credentials.

const DEFAULT_CODES = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  422: 'invalid_request',
  429: 'rate_limited',
  501: 'not_implemented',
  502: 'upstream_failed',
  503: 'not_configured',
};

const GENERIC_MESSAGES = {
  502: 'An outside service failed. Try again shortly.',
  503: 'Service unavailable.',
};

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || DEFAULT_CODES[status] || 'internal';
    if (details !== undefined) this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, 'invalid_request', message, details);
const notFound = (message = 'Not found.', details) => new ApiError(404, 'not_found', message, details);
const forbidden = (message = 'You do not have access to this.', details) => new ApiError(403, 'forbidden', message, details);
const conflict = (code, message, details) => new ApiError(409, code || 'conflict', message, details);
const tooMany = (code, message, details) => new ApiError(429, code || 'rate_limited', message, details);
const upstream = (message = GENERIC_MESSAGES[502], details) => new ApiError(502, 'upstream_failed', message, details);
const notConfigured = (message = GENERIC_MESSAGES[503], code = 'not_configured', details) => new ApiError(503, code, message, details);

function statusOf(err) {
  const status = Number(err?.status || err?.statusCode);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

/** Turns any thrown value into { status, body } for an /api response. */
function errorBody(err) {
  const status = statusOf(err);
  const trusted = err instanceof ApiError || err?.expose === true;
  const code = typeof err?.code === 'string' && err.code ? err.code : (DEFAULT_CODES[status] || 'internal');

  let body;
  if (status < 500) {
    body = { error: err?.message || 'Bad request.', code };
  } else if (GENERIC_MESSAGES[status]) {
    body = trusted
      ? { error: err.message || GENERIC_MESSAGES[status], code }
      : { error: GENERIC_MESSAGES[status], code: DEFAULT_CODES[status] };
  } else {
    body = { error: 'Internal server error.', code: 'internal' };
  }
  if ((status < 500 || trusted) && err?.details !== undefined) body.details = err.details;
  return { status, body };
}

/** Logs and answers an error. Safe to call after the headers went out (SSE). */
function sendError(res, err, context = '') {
  const { status, body } = errorBody(err);
  const where = context ? ` ${context}` : '';
  console.error(`[error]${where} -> ${status}`, err?.message || err);
  if (status >= 500 && !(err instanceof ApiError) && err?.stack) console.error(err.stack);
  if (res.headersSent) return;
  res.status(status).json(body);
}

module.exports = {
  ApiError,
  DEFAULT_CODES,
  badRequest,
  notFound,
  forbidden,
  conflict,
  tooMany,
  upstream,
  notConfigured,
  errorBody,
  sendError,
};
