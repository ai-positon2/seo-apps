/**
 * Turns an error into a sentence a non-technical reader can act on.
 *
 * Server-written sentences pass through untouched — they already say what
 * happened. What gets rewritten is the text nobody outside engineering can use:
 * the browser's "Failed to fetch", bare status codes ("Request failed (500)",
 * "HTTP 404"), the rate limiter's reply, and setup instructions meant for a
 * developer ("Apply supabase/migrations/…sql", "Set DATABASE_URL").
 *
 * The original text is still available through errorDetail(), so a screen can
 * keep it behind a "Show details" toggle for whoever has to debug it.
 *
 * Kept dependency-free so the node test runner can load it.
 */

const NETWORK = /failed to fetch|networkerror|load failed|network request failed/i;
const DEV_SETUP = /migrations?\/|\.sql\b|DATABASE_URL|supabase\/|not configured.*reload|then reload/i;
const RATE_LIMIT = /too many requests/i;

function statusOf(err, msg) {
  const direct = Number(err?.status ?? err?.statusCode);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const m = msg.match(/^(?:request failed|http)\s*\(?\s*(\d{3})\)?\s*$/i)
    || msg.match(/^(?:request failed|http)\s*\(?\s*(\d{3})\)?\b/i)
    || msg.match(/ failed \((\d{3})\)\.?$/i);
  return m ? Number(m[1]) : null;
}

// True when the message is nothing but a status code, i.e. no server sentence.
// apiRequest.js falls back to "<what> failed (NNN)" (e.g. "Download failed (500)")
// when the server sent no message, so that shape counts as bare too.
function isBareStatus(msg) {
  const m = msg.trim();
  return /^(?:request failed|http(?: error)?)\s*\(?\s*\d{3}\)?\.?$/i.test(m)
    || /^[\w\s-]{1,40} failed \(\d{3}\)\.?$/i.test(m)
    || /^\d{3}$/.test(m);
}

export function friendlyError(err) {
  const msg = String(err?.message ?? err ?? '').trim();
  const status = statusOf(err, msg);

  if (!msg || NETWORK.test(msg)) {
    return "Couldn't reach the server. Check your connection, then try again.";
  }
  if (DEV_SETUP.test(msg)) {
    return "This feature isn't set up on this server yet. Ask an admin to finish the setup.";
  }
  if (status === 429 || RATE_LIMIT.test(msg)) {
    return 'The server is busy right now. Wait a few seconds, then try again.';
  }
  if (!isBareStatus(msg)) return msg;

  if (status === 401) return 'Your session has ended. Reload the page to sign in again.';
  if (status === 403) return "You don't have access to this. Ask a workspace owner for access.";
  if (status === 404) return "We couldn't find that. It may have been deleted or moved.";
  if (status && status >= 500) {
    return 'Something failed on the server. Try again in a minute; if it keeps happening, tell the SEO tools team.';
  }
  return "That didn't work. Try again.";
}

/** The original text when friendlyError() replaced it, otherwise null. */
export function errorDetail(err) {
  const msg = String(err?.message ?? err ?? '').trim();
  if (!msg) return null;
  return friendlyError(err) === msg ? null : msg;
}
