// ── Request validation helpers ───────────────────────────────────────────────
// zod is the standard (already used by Content Writer and Crawl Scope). Route
// schemas should be `.passthrough()` so a field the client sends that the
// schema forgot is kept rather than silently dropped.

const { z } = require('zod');
const { badRequest, notFound } = require('./errors');
const { assertPublicHost } = require('../../modules/contentArchitect/urlSafety');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function issuePath(issue) {
  return issue.path && issue.path.length ? issue.path.join('.') : 'body';
}

/** Parses `value` with `schema`; throws a 400 with readable issues on failure. */
function parseBody(schema, value) {
  const result = schema.safeParse(value === undefined || value === null ? {} : value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: issuePath(i), message: i.message }));
  const message = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  throw badRequest(message, { issues });
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * A router.param handler: an id that cannot be a UUID is a 404 ("<Label> not
 * found."), not a 500 from the database's uuid cast.
 */
function uuidParam(label = 'Resource') {
  return function checkUuidParam(req, res, next, value) {
    if (!isUuid(value)) return next(notFound(`${label} not found.`));
    return next();
  };
}

/**
 * Parses a user-supplied URL, allows only http(s), and checks that the host is
 * public (not loopback, link-local, private or unresolvable). Returns the URL.
 * Redirects are a separate concern: fetch with services/safeEgress.js.
 */
async function assertPublicHttpUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw badRequest('A URL is required.');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw badRequest('That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('Only http and https URLs are supported.');
  }
  try {
    await assertPublicHost(url.hostname.replace(/^\[|\]$/g, ''));
  } catch (e) {
    throw badRequest(e.message || 'That address cannot be fetched.');
  }
  return url;
}

module.exports = { z, parseBody, isUuid, uuidParam, assertPublicHttpUrl };
