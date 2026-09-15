import { notifyProjectsChanged, readActiveProjectId, setActiveProjectId } from './activeProject';

// ── The active workspace, and keeping it honest with the active project ─────
//
// Two selections, stored in two different places, that were never reconciled:
//
//   the active WORKSPACE  — a server cookie (workspace_id), set by
//                           POST /api/workspaces/:id/activate, and the thing
//                           every new project and tool run is recorded against.
//   the active PROJECT    — localStorage, per browser, read by every screen.
//
// Nothing tied them together. You could switch to workspace B while the header
// still named a client in workspace A, and that is not cosmetic: a tool run
// started from that screen is attributed to the workspace in the COOKIE, while
// the project's own module runs are attributed to the PROJECT's workspace. The
// same afternoon's work then lands in two different workspaces' histories, and
// the run list for a client is missing the runs somebody did on it.
//
// So switching a workspace here does three things as one act — activate it,
// tell every list its contents may have changed, and move the project selection
// into the new workspace if it was pointing outside it. switchWorkspace() is
// the only supported way to change it, so those cannot come apart again.
//
// The workspace does NOT gate what you can see: /api/projects returns projects
// from every workspace you belong to, and that is deliberate. This is about
// where new work is RECORDED.

async function req(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/**
 * Switches the workspace new work is recorded against, and reconciles the
 * project selection with it.
 *
 * @param {string} workspaceId
 * @param {Array}  projects  the list from /api/projects — every project the
 *                           caller can see, each carrying its workspaceId
 * @returns {Promise<{workspaceId: string, activeProjectId: string|null, projectChanged: boolean}>}
 */
export async function switchWorkspace(workspaceId, projects = []) {
  // Server first. If this fails the cookie is unchanged, so failing here leaves
  // both selections as they were rather than desynchronised in a new way.
  await req(`/api/workspaces/${workspaceId}/activate`, { method: 'POST' });

  const previousProjectId = readActiveProjectId();
  const inWorkspace = projects.filter((p) => p.workspaceId === workspaceId);
  const stillValid = inWorkspace.some((p) => p.id === previousProjectId);

  let nextProjectId = previousProjectId;
  if (!stillValid) {
    // The first project in the workspace just switched to, or nothing if it is
    // empty. Clearing rather than keeping the old one is the point: a header
    // naming a client in another workspace is how the mismatch is invisible.
    nextProjectId = inWorkspace[0]?.id || null;
    setActiveProjectId(nextProjectId);
  }

  // Lists keyed on the active workspace (the projects screen's role line, the
  // setup card's workspace picker) are now stale.
  notifyProjectsChanged();

  return {
    workspaceId,
    activeProjectId: nextProjectId,
    projectChanged: nextProjectId !== previousProjectId,
  };
}

/**
 * The workspace a project belongs to, for labelling.
 * Null rather than a guess when the project or the workspace is unknown — the
 * switcher says "unknown workspace" rather than naming the wrong one.
 */
export function workspaceOf(project, workspaces = []) {
  if (!project?.workspaceId) return null;
  return workspaces.find((w) => w.id === project.workspaceId) || null;
}
