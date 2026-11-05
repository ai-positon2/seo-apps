// ── The last Overview per project, kept for the length of the session ────────
//
// HomePage kept its overview in component state only, so opening a card and
// pressing Back remounted it with nothing: grey skeletons for 10 to 50 seconds
// while /overview, /insights and /executive-summary were all read again, for
// numbers that had been on screen a moment before.
//
// This holds the last answer per project, in memory (never storage — it is
// client data, and stale-on-disk numbers would outlive the session). HomePage
// shows an entry at once and refreshes quietly behind it. Keyed strictly by
// project id, so one client's numbers can never appear under another.

// Old enough that showing it first would mislead more than it helps.
export const OVERVIEW_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_PROJECTS = 12;

export function createOverviewCache({ maxAgeMs = OVERVIEW_CACHE_MAX_AGE_MS, now = () => Date.now() } = {}) {
  const entries = new Map();   // `${kind}:${projectId}` -> { at, data }

  const keyOf = (kind, projectId) => `${kind}:${projectId}`;

  return {
    /** The cached answer, or null when there is none or it is too old. */
    get(kind, projectId) {
      if (!projectId) return null;
      const hit = entries.get(keyOf(kind, projectId));
      if (!hit) return null;
      if (now() - hit.at > maxAgeMs) {
        entries.delete(keyOf(kind, projectId));
        return null;
      }
      return hit.data;
    },
    set(kind, projectId, data) {
      if (!projectId || !data) return;
      const key = keyOf(kind, projectId);
      entries.delete(key);
      if (entries.size >= MAX_PROJECTS * 3) entries.delete(entries.keys().next().value);
      entries.set(key, { at: now(), data });
    },
    /** Forget one project (every kind), e.g. after a run is started from it. */
    forget(projectId) {
      for (const key of [...entries.keys()]) {
        if (key.endsWith(`:${projectId}`)) entries.delete(key);
      }
    },
    size() { return entries.size; },
  };
}

// The one the dashboard uses: module-level, so it survives HomePage unmounting.
export const overviewCache = createOverviewCache();
