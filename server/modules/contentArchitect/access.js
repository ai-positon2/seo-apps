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

module.exports = { authorize };
