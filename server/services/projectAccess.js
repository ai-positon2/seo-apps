// ── Workspace authorization (PRD §7.2, §7.4, §22.3, AC-001) ─────────────────
// The single place that answers "may this caller do this to this project?".
//
// Why it has to be one place: the server talks to Supabase with the
// service-role key, so no row policy stands between a query and the whole
// table. Every project-scoped read and write must therefore carry the
// workspace filter itself, and a route that forgets is not a failed request —
// it is a silent cross-tenant read. Centralizing it means there is exactly one
// implementation to review, and the tests in
// server/services/__tests__/projectAccess.test.js pin its decisions.
//
// Two boundaries, in order:
//   1. Workspace membership. `crawl_projects.workspace_id` is the boundary
//      (§7.4); `owner` is retained only as creator attribution and never
//      decides access. A project in a workspace you don't belong to reads as
//      "not found", not "forbidden" — knowing a project id must not confirm
//      that it exists (AC-001).
//   2. Capability. The role you hold in that workspace decides what you may do,
//      per the permission matrix in PRD §7.2.

const { getSupabase, isSupabaseConfigured } = require('./supabase');

// ── Roles ───────────────────────────────────────────────────────────────────
// 0008 shipped 'owner' | 'member'. The product needs four roles; 'member' rows
// still exist and are read as 'contributor' — the least-privileged role — so
// migrating the data is not a prerequisite for turning authorization on, and an
// unrecognized role never accidentally grants more than it should.
const ROLES = ['contributor', 'approver', 'admin', 'owner'];

function normalizeRole(role) {
  const r = String(role || '').trim().toLowerCase();
  if (r === 'member') return 'contributor';
  return ROLES.includes(r) ? r : 'contributor';
}

// PRD §7.2, transcribed. `true` = allowed, 'propose' = may create a proposal
// but not apply it, false/absent = denied. `platformAdmin` is listed separately
// because a platform administrator is not a workspace member: they get the
// operational capabilities and support-scope read, never ownership transfer.
const CAPABILITIES = {
  //                            contributor  approver  admin  owner  platformAdmin
  view:                        [true,        true,     true,  true,  true],
  startRun:                    [true,        true,     true,  true,  true],
  editProjectSettings:         [false,       true,     true,  true,  true],
  manageCompetitors:           ['propose',   true,     true,  true,  true],
  reviewFinding:               [true,        true,     true,  true,  true],
  overrideMachineOutcome:      [false,       true,     true,  true,  true],
  approveRecommendation:       [false,       true,     true,  true,  true],
  editRecommendation:          [true,        true,     true,  true,  true],
  recordShippedDate:           [false,       true,     true,  true,  true],
  configureGscIntegration:     [false,       false,    true,  true,  true],
  overrideRobotsPolicy:        [false,       false,    true,  true,  true],
  manageRecipients:            [false,       true,     true,  true,  true],
  manageWorkspaceMembers:      [false,       false,    true,  true,  true],
  configureLimits:             [false,       false,    false, false, true],
  // Permanently destroying one project, like requesting a workspace deletion,
  // stops at admin and owner and is withheld from a platform administrator: they
  // can see every workspace, and that is not the same as being entitled to
  // destroy a customer's crawl history. Deliberately narrower than
  // editProjectSettings, which an approver holds — an approver may delete a
  // project (recoverable) but not erase it.
  purgeProject:                [false,       false,    true,  true,  false],
  requestWorkspaceDeletion:    [false,       false,    true,  true,  false],
  restorePendingDeletion:      [false,       false,    true,  true,  false],
  transferOwnership:           [false,       false,    false, true,  true],
};

const ROLE_INDEX = { contributor: 0, approver: 1, admin: 2, owner: 3 };
const PLATFORM_INDEX = 4;

/**
 * What a role may do with a capability: true, false, or 'propose'.
 * Unknown capability names deny — a typo must not open a door.
 */
function capabilityFor(role, capability, { platformAdmin = false } = {}) {
  const row = CAPABILITIES[capability];
  if (!row) return false;
  if (platformAdmin && row[PLATFORM_INDEX]) return row[PLATFORM_INDEX];
  const index = ROLE_INDEX[normalizeRole(role)];
  return row[index] ?? false;
}

/** The full capability map for a role — sent to the client for nav gating only. */
function capabilityMap(role, { platformAdmin = false } = {}) {
  const out = {};
  for (const key of Object.keys(CAPABILITIES)) {
    out[key] = capabilityFor(role, key, { platformAdmin });
  }
  return out;
}

// ── Errors ──────────────────────────────────────────────────────────────────
// Carry an HTTP status so route handlers can stay one line: `catch (e) =>
// res.status(e.status || 500)`.

function notFound(message = 'Project not found.') {
  return Object.assign(new Error(message), { status: 404, code: 'not_found' });
}

function forbidden(message) {
  return Object.assign(new Error(message), { status: 403, code: 'forbidden' });
}

function notConfigured() {
  return Object.assign(
    new Error('Projects need Supabase configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).'),
    { status: 503, code: 'not_configured' },
  );
}

// ── Membership ──────────────────────────────────────────────────────────────

/** The caller's role in a workspace, or null if they are not a member. */
async function workspaceRole(workspaceId, userId) {
  if (!workspaceId || !userId) return null;
  const { data, error } = await getSupabase()
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`[projectAccess.workspaceRole] ${error.message}`);
  return data ? normalizeRole(data.role) : null;
}

/**
 * Every workspace id the caller belongs to. Used to scope list queries with an
 * `in (...)` filter instead of fetching and then filtering in JavaScript —
 * a filter applied after the fact is a filter that can be forgotten.
 */
async function accessibleWorkspaceIds(userId) {
  if (!userId) return [];
  const { data, error } = await getSupabase()
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId);
  if (error) throw new Error(`[projectAccess.accessibleWorkspaceIds] ${error.message}`);
  return (data || []).map((r) => r.workspace_id).filter(Boolean);
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Authorizes a workspace-scoped action.
 *
 * @param {object}  req            Express request (requireAuth has run)
 * @param {string}  workspaceId
 * @param {string} [capability]    capability to require; omit for membership only
 * @returns {Promise<{workspaceId, userId, actorEmail, role, isPlatformAdmin, capabilities, can}>}
 */
async function requireWorkspace(req, workspaceId, capability) {
  if (!isSupabaseConfigured()) throw notConfigured();

  const userId = req.user?.userId;
  const actorEmail = req.user?.username || null;
  if (!userId) throw forbidden('This session has no linked user account.');
  if (!workspaceId) throw notFound('Workspace not found.');

  // Required lazily: platformAdmin depends on auditEvents, which depends on
  // supabase — importing at module load would make this file's require graph
  // fan out into the audit trail for a plain membership check.
  const platformAdmin = require('./platformAdmin');
  const isAdmin = await platformAdmin.isPlatformAdmin({ email: actorEmail, userId });

  const role = await workspaceRole(workspaceId, userId);
  if (!role && !isAdmin) throw notFound('Workspace not found.');

  const context = {
    workspaceId,
    userId,
    actorEmail,
    role: role || null,
    isPlatformAdmin: isAdmin,
    capabilities: capabilityMap(role, { platformAdmin: isAdmin }),
  };
  context.can = (name) => capabilityFor(role, name, { platformAdmin: isAdmin });

  if (capability) assertCapability(context, capability);
  return context;
}

/**
 * Authorizes a project-scoped action and returns the project row alongside the
 * access context, so callers never have to re-read it (and never have to
 * re-apply the workspace filter).
 *
 * @param {object}  req
 * @param {string}  projectId
 * @param {string} [capability]
 * @param {object} [opts]
 * @param {boolean}[opts.includeDeleted] soft-deleted projects are hidden unless asked for
 */
async function requireProject(req, projectId, capability, { includeDeleted = false } = {}) {
  if (!isSupabaseConfigured()) throw notConfigured();

  const userId = req.user?.userId;
  if (!userId) throw forbidden('This session has no linked user account.');
  if (!projectId) throw notFound();

  const { data: project, error } = await getSupabase()
    .from('crawl_projects')
    .select('*')
    .eq('id', projectId)
    .maybeSingle();
  if (error) throw new Error(`[projectAccess.requireProject] ${error.message}`);

  // Same answer for "no such project", "project in another workspace" and
  // "soft-deleted": a 403 here would confirm the id exists (AC-001).
  if (!project) throw notFound();
  if (!includeDeleted && project.lifecycle_status === 'deleted') throw notFound();

  // A project that predates migration 0011's backfill has no workspace. It
  // cannot be authorized by the workspace boundary, so fall back to its
  // creator — the rule 0010 shipped — rather than either exposing it to a
  // whole workspace or hiding a user's own project from them.
  if (!project.workspace_id) {
    if (project.owner !== userId) throw notFound();
    const context = {
      workspaceId: null,
      userId,
      actorEmail: req.user?.username || null,
      role: 'owner',
      isPlatformAdmin: false,
      legacyOwnerScoped: true,
      capabilities: capabilityMap('owner'),
      project,
    };
    context.can = (name) => capabilityFor('owner', name);
    if (capability) assertCapability(context, capability);
    return context;
  }

  const context = await requireWorkspace(req, project.workspace_id);
  context.project = project;
  if (capability) assertCapability(context, capability);
  return context;
}

/**
 * Throws unless the context's role holds the capability outright. A 'propose'
 * grant is NOT enough here — callers that support proposals check
 * `context.can(name) === 'propose'` themselves and take the proposal path.
 */
function assertCapability(context, capability) {
  const verdict = context.can(capability);
  if (verdict === true) return context;
  if (verdict === 'propose') {
    throw forbidden(
      `Your role (${context.role || 'none'}) can only propose this change — an approver or administrator has to apply it.`,
    );
  }
  throw forbidden(
    `Your role (${context.role || 'none'}) is not allowed to ${describeCapability(capability)}.`,
  );
}

// Turns a capability key into something a user-facing error can say.
function describeCapability(capability) {
  return String(capability)
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .toLowerCase();
}

module.exports = {
  ROLES,
  CAPABILITIES,
  normalizeRole,
  capabilityFor,
  capabilityMap,
  workspaceRole,
  accessibleWorkspaceIds,
  requireWorkspace,
  requireProject,
  assertCapability,
  errors: { notFound, forbidden, notConfigured },
};
