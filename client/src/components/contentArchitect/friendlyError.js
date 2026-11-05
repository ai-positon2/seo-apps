// ── Errors a person can act on ──────────────────────────────────────────────
//
// "Failed to fetch" is the browser's wording for "no response", and it told the
// reader nothing about what to do (UX-229). Shared by the Content Architect
// landing and report pages, so every toast there says it the same way.
//
// Pure; tested in __tests__/friendlyError.test.js.

const NO_RESPONSE = /failed to fetch|networkerror|load failed|network request failed/i;

/**
 * @param {unknown} e  what was thrown
 * @param {string} [action]  what to do next, e.g. "reload the page"
 */
export function friendlyError(e, action = 'try again') {
  const msg = String(e?.message || '');
  if (!msg || NO_RESPONSE.test(msg)) {
    return `Could not reach the server. Check your connection and ${action}.`;
  }
  return msg;
}
