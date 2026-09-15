// ── Workspace authorization (PRD §7.2, §7.4, §22.3, AC-001) ─────────────────
// The single place that answers "may this caller do this to this project?".
//
// Why it has to be one place: the server connects to Postgres as the database
// owner, so no row policy stands between a query and the whole table. Every
// project-scoped read and write must therefore carry the workspace filter
// itself, and a route that forgets is not a failed request —
// it is a silent cross-tenant read. Centralizing it means there is exactly one
// implementation to review, and the "Workspace authorization — role
// capabilities" section of server/services/__tests__/platformFoundation.test.js
// pins its decisions.
//
// What that section covers is the capability TABLE — capabilityFor, role
// normalization, the propose verdict, platform-admin behaviour. What it does
// not yet cover is requireWorkspace/requireProject, which touch the database:
// membership resolution, the legacy owner fallback, and the rule that a project
// in another workspace answers 404 rather than 403 (AC-001). Those need the
// database-backed harness (services/__tests__/helpers/testDatabase.js).
//
// Two boundaries, in order:
//   1. Workspace membership. `crawl_projects.workspace_id` is the boundary
//      (§7.4); `owner` is retained only as creator attribution and never
//      decides access. A project in a workspace you don't belong to reads as
//      "not found", not "forbidden" — knowing a project id must not confirm
//      that it exists (AC-001).
//   2. Capability. The role you hold in that workspace decides what you may do,
//      per the permission matrix in PRD §7.2.

const db = require('./db');

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
  // Adding a NEW project is open to every member of a workspace, which is why
  // this is its own capability rather than a reuse of editProjectSettings.
  // The two are different acts: creating a project brings a site under the
  // team's view, and changing an existing project's settings alters something
  // colleagues already rely on. Gating creation behind the edit capability made
  // a contributor unable to bring in their own client's site at all — the one
  // thing everyone needs to do to start working.
  //
  // The workspace is still the boundary: this says what a MEMBER may do, and
  // requireWorkspace has already established membership before consulting it.
  createProject:               [true,        true,     true,  true,  true],
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
    new Error('Projects need the database configured (DATABASE_URL).'),
    { status: 503, code: 'not_configured' },
  );
}

// ── Membership ──────────────────────────────────────────────────────────────

/** The caller's role in a workspace, or null if they are not a member. */
// This lookup runs on EVERY project-scoped request -- which means every tick of
// the dashboard's 4-second crawl-status poll and its 8-second overview poll.
// Measured against the configured database, a trivial round trip costs ~260ms,
// so this single membership check was a quarter of a second added to every one
// of those, doing no work anybody was waiting to read.
//
// Cached the way platformAdmin.js caches the same kind of decision, and with the
// same discipline: a short TTL, plus an explicit invalidate() that every
// membership mutation calls, so a role change or a removal takes effect on the
// next request rather than at the end of a window.
//
// Only POSITIVE answers are cached. A null role means "not a member", and that
// is precisely the state that flips the moment someone is added to a workspace
// -- identityStore inserts a membership row when a workspace is created, so
// caching the negative would lock a person out of a workspace they had just
// made. A non-member arriving here is the error path and can pay the query.
const ROLE_TTL_MS = 30 * 1000;
const ROLE_CACHE_MAX = 5000;
const roleCache = new Map(); // `${workspaceId}|${userId}` -> { value, expires }

const roleKey = (workspaceId, userId) => `${workspaceId}|${userId}`;

function roleCacheGet(key) {
  const hit = roleCache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { roleCache.delete(key); return undefined; }
  return hit.value;
}

function roleCacheSet(key, value) {
  // Bounded, unlike the other in-process caches in this directory: evict the
  // entry closest to expiry rather than letting the map grow for the life of
  // the process. The cap is far above any real concurrent-user count, so this
  // branch is effectively unreachable in practice.
  if (roleCache.size >= ROLE_CACHE_MAX) {
    let oldestKey = null; let oldest = Infinity;
    for (const [k, v] of roleCache) { if (v.expires < oldest) { oldest = v.expires; oldestKey = k; } }
    if (oldestKey) roleCache.delete(oldestKey);
  }
  roleCache.set(key, { value, expires: Date.now() + ROLE_TTL_MS });
}

/**
 * Drops cached membership. Called by identityStore whenever a member is added,
 * has their role changed, or is removed. With no arguments, clears everything.
 */
function invalidateRole(workspaceId, userId) {
  if (workspaceId && userId) roleCache.delete(roleKey(workspaceId, userId));
  else if (workspaceId) {
    for (const k of roleCache.keys()) if (k.startsWith(`${workspaceId}|`)) roleCache.delete(k);
  } else roleCache.clear();
}

async function workspaceRole(workspaceId, userId) {
  if (!workspaceId || !userId) return null;
  const key = roleKey(workspaceId, userId);
  const cached = roleCacheGet(key);
  if (cached !== undefined) return cached;
  let data;
  try {
    data = await db.maybeOne(
      `select role from workspace_members where workspace_id = $1 and user_id = $2`,
      [workspaceId, userId]
    );
  } catch (error) {
    throw new Error(`[projectAccess.workspaceRole] ${error.message}`);
  }
  const role = data ? normalizeRole(data.role) : null;
  if (role) roleCacheSet(key, role);
  return role;
}

/**
 * Every workspace id the caller belongs to. Used to scope list queries with an
 * `in (...)` filter instead of fetching and then filtering in JavaScript —
 * a filter applied after the fact is a filter that can be forgotten.
 */
async function accessibleWorkspaceIds(userId) {
  if (!userId) return [];
  let data;
  try {
    data = await db.rows(
      `select workspace_id from workspace_members where user_id = $1`, [userId]);
  } catch (error) {
    throw new Error(`[projectAccess.accessibleWorkspaceIds] ${error.message}`);
  }
  return data.map((r) => r.workspace_id).filter(Boolean);
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
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const userId = req.user?.userId;
  const actorEmail = req.user?.username || null;
  if (!userId) throw forbidden('This session has no linked user account.');
  if (!workspaceId) throw notFound('Workspace not found.');

  // Required lazily: platformAdmin depends on auditEvents, which depends on
  // the database layer — importing at module load would make this file's
  // require graph fan out into the audit trail for a plain membership check.
  const platformAdmin = require('./platformAdmin');

  // Independent of each other: one asks whether this email holds a platform
  // grant, the other whether this user is a member of this workspace. They were
  // awaited in series, which at ~260ms per round trip made every project request
  // pay half a second before its handler began. Neither writes anything, so
  // running them together changes nothing except what they cost.
  const [isAdmin, role] = await Promise.all([
    platformAdmin.isPlatformAdmin({ email: actorEmail, userId }),
    workspaceRole(workspaceId, userId),
  ]);
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
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const userId = req.user?.userId;
  if (!userId) throw forbidden('This session has no linked user account.');
  if (!projectId) throw notFound();

  let project;
  try {
    project = await db.maybeOne(`select * from crawl_projects where id = $1`, [projectId]);
  } catch (error) {
    throw new Error(`[projectAccess.requireProject] ${error.message}`);
  }

  // Same answer for "no such project", "project in another workspace" and
  // "soft-deleted": a 403 here would confirm the id exists (AC-001).
  if (!project) throw notFound();
  if (!includeDeleted && project.lifecycle_status === 'deleted') throw notFound();

  // There used to be a fallback here for a project with no workspace: authorize
  // it by its creator instead, because the workspace boundary had nothing to
  // check. Migration 0027 made crawl_projects.workspace_id NOT NULL and
  // backfilled every row, so that branch became unreachable and is gone.
  //
  // It is worth knowing why it is not merely dead but unwanted: it was a SECOND
  // authorization rule, reachable only for rows in a state the schema now
  // forbids, granting full 'owner' capabilities off a column (`owner`) that
  // §7.4 says must never decide access. One boundary is reviewable; two, where
  // the second is rarely exercised, is how a gap survives.
  const context = await requireWorkspace(req, project.workspace_id);
  context.project = project;
  applyCreatorGrant(context, project);
  if (capability) assertCapability(context, capability);
  return context;
}

// ── The creator's grant on their own project ────────────────────────────────
// Every workspace member may create a project ('createProject'). Without this,
// a contributor who did so could not then rename it, correct its country, or
// set its primary domain — they would have to ask an approver to finish
// something they started, over a typo.
//
// So the person who created a project may edit that project, whatever their
// role. It is scoped to the single project they own: a contributor still cannot
// edit a colleague's project, which is what editProjectSettings is protecting.
//
// Deliberately just this one capability. 'manageCompetitors' is NOT included —
// a competitor costs metered SEMrush units per domain and the propose/approve
// path exists for that review, so a contributor's additions keep going through
// it. (They can still name competitors at setup, which is charged the same way;
// if that inconsistency matters, widen this list rather than the role table.)
//
// Nothing about approval, deletion or workspace administration is here:
// approveRecommendation, purgeProject and manageWorkspaceMembers stay with the
// roles that hold them, on your own project as much as anyone else's.
const CREATOR_CAPABILITIES = ['editProjectSettings'];

/**
 * Upgrades a context in place when the caller created the project.
 * A no-op for everyone else, so the role table is the rule and this is the
 * single, named exception to it.
 */
function applyCreatorGrant(context, project) {
  if (!project || !project.owner || project.owner !== context.userId) return context;

  context.isCreator = true;
  const roleVerdict = context.can;
  context.can = (name) => (CREATOR_CAPABILITIES.includes(name) ? true : roleVerdict(name));
  for (const name of CREATOR_CAPABILITIES) context.capabilities[name] = true;
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
  CREATOR_CAPABILITIES,
  applyCreatorGrant,
  normalizeRole,
  capabilityFor,
  capabilityMap,
  workspaceRole,
  invalidateRole,
  accessibleWorkspaceIds,
  requireWorkspace,
  requireProject,
  assertCapability,
  errors: { notFound, forbidden, notConfigured },
};
