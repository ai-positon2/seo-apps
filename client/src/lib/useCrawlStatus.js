import { useCallback, useEffect, useRef, useState } from 'react';
import { projectsApi } from './projectsApi';
import { useActiveProjectId } from './activeProject';

// ── The live crawl, from anywhere in the app ─────────────────────────────────
//
// A crawl takes tens of minutes. Watching it used to mean staying on the
// dashboard, because that was the only screen that knew one was running — walk
// over to Content Architect and the crawl vanished, which reads as "it stopped"
// rather than "you changed screens".
//
// So the status lives in the shell instead of on one page, and this hook is how
// the shell gets it. State is server-derived on every tick, so navigating away
// and back cannot lose progress: there is no client-side crawl state to lose.
//
// Two cadences. While a crawl is live the bar has to visibly move, so it polls
// often; with nothing running the same poll is just a heartbeat waiting for a
// crawl somebody may start on another screen, and there is no reason to do that
// every four seconds. The endpoint behind it is two queries, not the full
// dashboard build — see overview.liveCrawlStatus.

const LIVE_MS = 4000;
const IDLE_MS = 15000;

/**
 * @param {object}  [options]
 * @param {boolean} [options.enabled]  false stops all polling. The embedded
 *   public view passes false: it renders no crawl bar, has no signed-in session,
 *   and would otherwise 401 against this endpoint every fifteen seconds forever
 *   — the catch below swallows the failure, so it would never even look broken.
 */
// Each poll parses fresh JSON, so every tick produced an object that was equal
// in value but new in identity -- and this hook lives in the app shell, so that
// re-rendered the shell (and its 37 sidebar buttons) every 4 seconds during a
// crawl and every 15 idle, for a status that had not changed.
//
// The comparison is over the union of both objects' keys rather than a chosen
// few, which is what makes it safe: it cannot report "same" for objects that
// differ, whatever fields this status grows later. The worst case is that it
// stops helping, never that the bar goes stale.
function sameStatus(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!Object.is(a[k], b[k])) return false;
  return true;
}

export function useCrawlStatus({ enabled = true } = {}) {
  const [activeProjectId] = useActiveProjectId();
  const [status, setStatus] = useState(null);
  const timer = useRef(null);
  // Read inside the scheduler without making it a dependency, or every tick
  // would tear down and rebuild the timeout.
  const statusRef = useRef(null);
  statusRef.current = status;

  const projectId = enabled ? (activeProjectId || null) : null;

  const poll = useCallback(async (id) => {
    if (!id) return null;
    try {
      const { crawlStatus } = await projectsApi.crawlStatus(id);
      return crawlStatus || null;
    } catch {
      // A dropped poll is not a finished crawl. Keep whatever was last known and
      // try again on the next tick — blanking the bar on one failed request
      // would look exactly like the crawl ending.
      return statusRef.current;
    }
  }, []);

  useEffect(() => {
    if (!projectId) { setStatus(null); return undefined; }

    let cancelled = false;

    const tick = async () => {
      const next = await poll(projectId);
      if (cancelled) return;
      setStatus((prev) => (sameStatus(prev, next) ? prev : next));
      timer.current = setTimeout(tick, next ? LIVE_MS : IDLE_MS);
    };

    // Clear immediately on a project switch: showing the previous client's crawl
    // under a new client's name is worse than showing nothing for one tick.
    setStatus(null);
    tick();

    return () => {
      cancelled = true;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    };
  }, [projectId, poll]);

  const refresh = useCallback(async () => {
    const next = await poll(projectId);
    setStatus((prev) => (sameStatus(prev, next) ? prev : next));
    return next;
  }, [poll, projectId]);

  return { status, refresh, projectId };
}

export default useCrawlStatus;
