// Who may read or act on a Content Architect project. Shared by this module's
// router and by the tools that write back into a project from outside it
// (Article Enhancement saving a result against a project's page).

const projectAccess = require('../../services/projectAccess');

// Access follows the record's link. Linked to a platform project: that
// project's workspace access. Unlinked but still in a workspace: that
// workspace's members — the importer leaves records like this when it can
// resolve a workspace but not the project inside it. Neither: a standalone
// analysis, open to anyone signed in, as the standalone tool always was.
async function authorize(req, project, capability) {
  if (project.platformProjectId) {
    await projectAccess.requireProject(req, project.platformProjectId, capability);
  } else if (project.workspaceId) {
    await projectAccess.requireWorkspace(req, project.workspaceId, capability);
  }
}

// The workspace a project created from the tool page belongs to. These used to
// be stored with neither link, which authorize() above reads as "open to anyone
// signed in" — so every new analysis was readable, editable and deletable by
// every user. A new one now lands in the creator's home workspace (the one team
// workspace, for Position2 staff), and creating it is authorized the way
// creating any project is. Records already stored without a workspace are left
// to the backfill; authorize() keeps reading them as before.
async function workspaceForNewProject(req, {
  resolveIdentity = require('../../services/workspaceContext').resolveIdentity,
  requireWorkspace = projectAccess.requireWorkspace,
} = {}) {
  const { workspaceId } = await resolveIdentity(req);
  if (!workspaceId) {
    throw Object.assign(new Error('No workspace is available for this session.'), { status: 403 });
  }
  await requireWorkspace(req, workspaceId, 'createProject');
  return workspaceId;
}

module.exports = { authorize, workspaceForNewProject };
