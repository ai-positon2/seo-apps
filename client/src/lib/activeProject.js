import { useEffect, useState } from 'react';

// ── The active client ───────────────────────────────────────────────────────
// Which project the dashboard is looking at. It lives here rather than in a
// context because two unrelated parts of the shell need it — the header's
// client switcher writes it, the home dashboard reads it — and a page reload
// should not lose it.
//
// This is a per-browser convenience, not a permission: the id is resolved
// against the projects the server actually returned before it is used, so a
// stale or hand-edited value falls back to the first accessible project instead
// of showing anything it shouldn't. Every request still names the project and is
// membership-checked server-side.

export const ACTIVE_PROJECT_KEY = 'toolkit-active-project';
const EVENT = 'toolkit:active-project';
// Fired when the SET of projects changes — one was created, deleted, restored,
// purged or renamed. Distinct from EVENT above, which is only about *which* of
// them is selected. Long-lived readers of /api/projects (the header's client
// switcher lives in the app shell and never unmounts) have no other way to
// learn their copy of the list went stale, and a switcher still offering a
// deleted project is how the header ends up naming a client the page below is
// not showing.
const PROJECTS_EVENT = 'toolkit:projects-changed';

// ── Per tab ──
// Each tab holds its own client. The selection used to live only in
// localStorage, with a `storage` listener so every tab followed the last switch
// made in any of them: switching to Position2 in tab B silently turned tab A's
// LogicGate report into Position2's, and the page then asked for LogicGate's
// page ids under Position2 (404s). Now sessionStorage (this tab's own) is read
// first; localStorage is only the starting point for a brand-new tab, so a new
// tab still opens on the client you last used. The URL's ?project= (see
// projectFromSearch) is the strongest signal of all and is adopted by the shell.
export function readActiveProjectId() {
  try {
    const own = sessionStorage.getItem(ACTIVE_PROJECT_KEY);
    if (own) return own;
  } catch { /* fall through to the browser-wide default */ }
  try { return localStorage.getItem(ACTIVE_PROJECT_KEY) || null; } catch { return null; }
}

/** Writes the selection and tells the rest of this tab about it. */
export function setActiveProjectId(projectId) {
  try {
    if (projectId) sessionStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
    else sessionStorage.removeItem(ACTIVE_PROJECT_KEY);
  } catch { /* private mode — the switch still applies to this view */ }
  // The default for the next new tab. Other open tabs do not listen for it.
  try {
    if (projectId) localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
    else localStorage.removeItem(ACTIVE_PROJECT_KEY);
  } catch { /* private mode */ }

  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: projectId || null }));
  } catch { /* very old browsers: the reader falls back to its initial value */ }
}

/** The ?project= a link carries, or null. Pure, for the tests. */
export function projectFromSearch(search) {
  try {
    const id = new URLSearchParams(search || '').get('project');
    return id && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
  } catch { return null; }
}

/** `path` with ?project=<id> set (or replaced), other parameters kept. */
export function withProjectParam(path, projectId) {
  if (!projectId || !path) return path;
  const [base, hash = ''] = String(path).split('#');
  const [pathname, query = ''] = base.split('?');
  const params = new URLSearchParams(query);
  params.set('project', projectId);
  return `${pathname}?${params.toString()}${hash ? `#${hash}` : ''}`;
}

// Routes that name one record of one client. Switching client there cannot keep
// the record, so the switch goes to that tool's landing for the new client.
const ID_ROUTES = [
  [/^\/crawl-scope\/runs\/[^/]+/, '/crawl-scope'],
  [/^\/content-architect\/[^/]+/, '/content-architect'],
];

/**
 * Where the header's client switch should go from `pathname`: the same page
 * for the new client (so Back undoes the switch), or the tool's landing for an
 * id-specific route. Other query parameters are dropped — they describe the
 * old client's view (a selected issue, a competitor-tool client id).
 */
export function switchTarget(pathname, projectId) {
  const hit = ID_ROUTES.find(([re]) => re.test(pathname || ''));
  return withProjectParam(hit ? hit[1] : (pathname || '/'), projectId);
}

// ── Adopting ?project= from the address ──
// Called by the shell during render, before any page below it reads the
// selection, so a page opened from a link starts on the link's client rather
// than loading the reader's last one first. Writes storage only; the shell
// broadcasts the change in an effect, once the listeners exist.
//
// Not a permission: the id is checked against the caller's /api/projects list
// by the header (ClientSwitcher). One that is not there is rejected — the tab
// goes back to its previous client and says so — and never adopted again from
// the same address, or the two would fight.
let lastAdoption = null;          // { id, previous }
const rejected = new Set();

export function adoptProjectFromUrl(search) {
  const id = projectFromSearch(search);
  if (!id || rejected.has(id)) return null;
  const current = readActiveProjectId();
  if (id === current) return id;
  lastAdoption = { id, previous: current };
  try { sessionStorage.setItem(ACTIVE_PROJECT_KEY, id); } catch { /* applies via the event below */ }
  return id;
}

/** The id adopted from a link and the client before it, if any. */
export function pendingAdoption() { return lastAdoption; }

/** The header found the linked client in the user's list: nothing pending. */
export function clearAdoption() { lastAdoption = null; }

/** The header found the linked client is not one the user can open. */
export function rejectAdoptedProject(id) {
  rejected.add(id);
  if (lastAdoption?.id === id) lastAdoption = null;
}

/**
 * Reads this tab's selection and re-renders when it changes in this tab. Other
 * tabs' switches are deliberately not followed (see "Per tab" above).
 */
export function useActiveProjectId() {
  const [projectId, setProjectId] = useState(readActiveProjectId);

  useEffect(() => {
    const onLocal = (e) => setProjectId(e.detail ?? readActiveProjectId());
    window.addEventListener(EVENT, onLocal);
    return () => window.removeEventListener(EVENT, onLocal);
  }, []);

  return [projectId, setActiveProjectId];
}

/**
 * Announces that the set of projects changed. Called by the projectsApi
 * mutations rather than by their callers, so a screen that deletes a project
 * cannot forget to tell the rest of the app.
 */
export function notifyProjectsChanged() {
  try {
    window.dispatchEvent(new CustomEvent(PROJECTS_EVENT));
  } catch { /* very old browsers: lists refresh on the next mount instead */ }
}

/**
 * Returns a counter that increments whenever notifyProjectsChanged() fires.
 * Use it as an effect dependency to re-read /api/projects:
 *
 *   const projectsVersion = useProjectsChanged();
 *   useEffect(() => { ...fetch... }, [projectsVersion]);
 */
export function useProjectsChanged() {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(PROJECTS_EVENT, bump);
    return () => window.removeEventListener(PROJECTS_EVENT, bump);
  }, []);

  return version;
}
