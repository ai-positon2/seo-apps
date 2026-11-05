// ── The Content Architect status card's actions ─────────────────────────────
//
// Pure; tested in __tests__/connection.test.js.

/**
 * Whether the status card offers Retry (UX-228): only when pressing it could
 * change the answer. A failed or cancelled run, or one never started, can; a
 * "not enough pages" verdict can only when the server says a second run might
 * (our page checker was down, our page limit was hit). A site that serves
 * crawlers its homepage, or refuses them, gives the same answer every time.
 *
 * @param {object|null} connection  GET /api/projects/:id/content-architect
 */
export function canRetry(connection) {
  if (!connection?.canStartRun) return false;
  if (['failed', 'cancelled', 'not_started'].includes(connection.state)) return true;
  return connection.state === 'insufficient_data' && connection.retryHelps !== false;
}
