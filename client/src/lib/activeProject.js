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
//
// Not a permission, and never adopted unchecked: the id is checked against the
// caller's /api/projects list first. Adopting first and checking afterwards let
// a link naming a client the reader cannot open fire the page's first requests
// under that client (a handful of 403/404s) before the header put it back.
//
//   • The header's last list read (knownProjectIds) has it → adopted at once.
//   • No list yet, or not in it → PENDING: the tab keeps its current client and
//     the shell holds the page until the header has read the list and either
//     adopts it (resolveAdoption) or rejects it — the tab stays on its client
//     and says so. A rejected id is never adopted again from an address, or the
//     two would fight.
let lastAdoption = null;          // { id, previous } — pending validation
const rejected = new Set();
let knownIds = null;              // Set of ids from the header's last list read
// A pending link given up on without a verdict (the list read failed or took
// too long). Re-judged once a list does load, if the address still names it.
let unresolvedId = null;
const ADOPTION_EVENT = 'toolkit:adoption-settled';
const KNOWN_EVENT = 'toolkit:known-projects';

/** The header read the user's projects: later links can be checked at once. */
export function setKnownProjectIds(ids) {
  knownIds = new Set((ids || []).filter(Boolean));
  try { window.dispatchEvent(new CustomEvent(KNOWN_EVENT)); } catch { /* no window in tests */ }
}

/** Whether the header's last list read has this client. */
export function isKnownProjectId(id) {
  return Boolean(id && knownIds && knownIds.has(id));
}

/** A counter that changes whenever the header's list of the user's ids does. */
export function useKnownProjectsVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const on = () => setVersion((v) => v + 1);
    window.addEventListener(KNOWN_EVENT, on);
    return () => window.removeEventListener(KNOWN_EVENT, on);
  }, []);
  return version;
}

/**
 * Where a record page about `recordProjectId` should correct its address to so
 * it names the record's client, or null to leave it. Only once the header's
 * list is known and has that client: then the shell adopts it at once, rather
 * than holding (unmounting) the page that is already showing the record while
 * it checks. Pure apart from the known list, for the tests.
 */
export function recordClientAddress(pathname, search, recordProjectId) {
  if (!recordProjectId || projectFromSearch(search) === recordProjectId) return null;
  if (!isKnownProjectId(recordProjectId)) return null;
  return withProjectParam((pathname || '/') + (search || ''), recordProjectId);
}

/** Forgets the known list and any pending link, e.g. on sign-out. */
export function resetKnownProjectIds() {
  knownIds = null;
  lastAdoption = null;
  unresolvedId = null;
  rejected.clear();
}

/**
 * Reads ?project= from `search`. Returns the id when this tab is now on it
 * (already, or adopted because the known list has it), else null — including
 * while it waits for validation (see pendingAdoption()).
 */
export function adoptProjectFromUrl(search) {
  const id = projectFromSearch(search);
  // Each address replaces whatever an earlier one left pending.
  lastAdoption = null;
  unresolvedId = null;
  if (!id || rejected.has(id)) return null;
  const current = readActiveProjectId();
  if (id === current) return id;
  if (knownIds && knownIds.has(id)) {
    try { sessionStorage.setItem(ACTIVE_PROJECT_KEY, id); } catch { /* the shell broadcasts it too */ }
    return id;
  }
  lastAdoption = { id, previous: current };
  return null;
}

/** The linked client still waiting to be checked, and the client before it. */
export function pendingAdoption() { return lastAdoption; }

function settled() {
  try { window.dispatchEvent(new CustomEvent(ADOPTION_EVENT)); } catch { /* no window in tests */ }
}

/** Nothing to adopt after all (the list could not be read): stay put. */
export function clearAdoption() {
  if (!lastAdoption) return;
  unresolvedId = lastAdoption.id;
  lastAdoption = null;
  settled();
}

/**
 * A list has now loaded after a pending link was given up on (clearAdoption).
 * If the address still names that client, judge it again, so the tab does not
 * show one client while its address (copied, or reloaded) names another:
 *   'adopted'  the known list has it: the tab is on it now
 *   'pending'  held again, for the header to accept or reject (and correct
 *              the address)
 *   null       nothing was waiting, or the address moved on
 * Once per given-up link.
 */
export function retryClearedAdoption(search) {
  const id = unresolvedId;
  unresolvedId = null;
  if (!id || projectFromSearch(search) !== id) return null;
  const adopted = adoptProjectFromUrl(search);
  if (adopted) {
    setActiveProjectId(adopted);
    return 'adopted';
  }
  if (lastAdoption) { settled(); return 'pending'; }
  return null;
}

/** The header found the linked client is not one the user can open. */
export function rejectAdoptedProject(id) {
  rejected.add(id);
  if (lastAdoption?.id === id) { lastAdoption = null; settled(); }
}

/**
 * What to do with a pending link once a list of the user's project ids is in
 * hand. Pure, for the tests.
 *   'adopt'   it is theirs
 *   'recheck' not in this list, which may predate it: read the list once more
 *   'reject'  still not there after the re-read
 */
export function judgeAdoption(pendingId, projectIds, { rechecked = false } = {}) {
  if (!pendingId) return null;
  if ((projectIds || []).includes(pendingId)) return 'adopt';
  return rechecked ? 'reject' : 'recheck';
}

/** Adopts the pending link's client (it was found in the user's list). */
export function acceptAdoption(id) {
  if (lastAdoption?.id !== id) return;
  lastAdoption = null;
  setActiveProjectId(id);
  settled();
}

/** True while a link's client is waiting to be checked; re-renders when settled. */
export function useAdoptionPending() {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener(ADOPTION_EVENT, on);
    return () => window.removeEventListener(ADOPTION_EVENT, on);
  }, []);
  return Boolean(lastAdoption);
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
