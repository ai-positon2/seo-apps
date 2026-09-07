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

export function readActiveProjectId() {
  try { return localStorage.getItem(ACTIVE_PROJECT_KEY) || null; } catch { return null; }
}

/** Writes the selection and tells the rest of this tab about it. */
export function setActiveProjectId(projectId) {
  try {
    if (projectId) localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
    else localStorage.removeItem(ACTIVE_PROJECT_KEY);
  } catch { /* private mode — the switch still applies to this view */ }

  // `storage` only fires in *other* tabs, so this tab gets its own event.
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: projectId || null }));
  } catch { /* very old browsers: the reader falls back to its initial value */ }
}

/**
 * Reads the selection and re-renders when it changes — including from another
 * tab, so two windows open on the same workspace don't disagree about which
 * client they are showing.
 */
export function useActiveProjectId() {
  const [projectId, setProjectId] = useState(readActiveProjectId);

  useEffect(() => {
    const onLocal = (e) => setProjectId(e.detail ?? readActiveProjectId());
    const onStorage = (e) => {
      if (e.key === ACTIVE_PROJECT_KEY || e.key === null) setProjectId(readActiveProjectId());
    };
    window.addEventListener(EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
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
