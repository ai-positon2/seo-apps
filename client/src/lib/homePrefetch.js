import { projectsApi } from './projectsApi';
import { readActiveProjectId } from './activeProject';

// ── Starting the dashboard's reads before React is ready for them ───────────
//
// The app renders nothing until /api/auth/verify answers — App.jsx returns a
// blank screen while `authState === 'loading'` — so the home dashboard could not
// send its first request until the session had been confirmed. Verify is not
// free (it reads the profile and the platform-admin grant), and on this
// deployment the database is ~250ms away, so the browser spent the better part
// of a second on a blank page with nothing in flight, and only THEN asked for
// the projects.
//
// Nothing about those reads depends on the answer. They are membership-checked
// server-side on their own — that is what makes them safe to start early rather
// than a way around the session check. A request from a browser with no valid
// cookie gets a 401 and is thrown away here; it cannot leak anything, because
// the server never looked at this file's opinion of who is asking.
//
// So they start now, next to verify instead of behind it.
//
// ── Why the stored project id is the trigger ────────────────────────────────
//
// Firing this for everyone would mean every visitor to the login page sends
// three doomed requests. `toolkit-active-project` is only in localStorage if
// somebody has used this browser to look at a client before, which makes it a
// decent proxy for "there is probably a session here" — and it is exactly the
// same speculative id the dashboard already uses to start its overview read
// before the project list confirms the choice. A first-time or signed-out
// visitor has none, prefetches nothing, and loses nothing: they were never
// going to see the dashboard on this load anyway.

// How long a prefetched answer may be handed out. This is a head start on one
// page load, not a cache: if React has not asked within this window something
// has gone wrong (a slow bundle, a login round trip), and the dashboard should
// read fresh data rather than open on numbers of unknown age.
const MAX_AGE_MS = 15_000;

let pending = null;   // { at, projectId, projects, overview, insights }

/**
 * Kicks off the home dashboard's reads. Safe to call more than once — the second
 * call is a no-op while the first is still usable.
 */
export function prefetchHome() {
  if (pending && Date.now() - pending.at < MAX_AGE_MS) return;

  // Only on the dashboard's own route.
  //
  // This is called before React mounts, which is the whole point — but that is
  // also before the router exists, so without this check it fired on every deep
  // link into the app. Landing on /seo-geo-audit sent three reads nobody would
  // ever take (1.7s of server work, and browser connections that page needed for
  // its own two requests), to prime a screen the visitor had not asked for.
  //
  // Read off `location` rather than the router for the same reason.
  const path = typeof window === 'undefined' ? '' : window.location.pathname;
  if (path !== '/' && path !== '') return;

  const projectId = readActiveProjectId();
  if (!projectId) return;

  // A rejection here must never become an unhandled rejection: nothing awaits
  // these until React does, and a 401 on a dead session is the expected case.
  // The error is kept on the promise so `takePrefetch` can rethrow it into the
  // caller's own error handling, which is where it belongs.
  const swallow = (p) => { p.catch(() => {}); return p; };

  pending = {
    at: Date.now(),
    projectId,
    projects: swallow(projectsApi.list()),
    overview: swallow(projectsApi.overview(projectId)),
    insights: swallow(projectsApi.insights(projectId)),
  };
}

/**
 * Hands over a prefetched read, or null if there isn't a usable one.
 *
 * Single use per kind. The dashboard reloads itself on a timer while a crawl
 * runs and after any action that changes stored evidence, and every one of those
 * has to be a real read — handing the same startup answer back a second time
 * would show a stale number with no way to tell.
 *
 * @param {'projects'|'overview'|'insights'} kind
 * @param {string?} projectId  the project the caller wants, so a prefetch for a
 *   client the user has since switched away from is declined rather than shown
 * @returns {Promise|null}
 */
export function takePrefetch(kind, projectId = null) {
  if (!pending) return null;
  if (Date.now() - pending.at > MAX_AGE_MS) { pending = null; return null; }
  if (projectId && projectId !== pending.projectId) return null;

  const promise = pending[kind];
  if (!promise) return null;
  pending[kind] = null;
  if (!pending.projects && !pending.overview && !pending.insights) pending = null;
  return promise;
}
