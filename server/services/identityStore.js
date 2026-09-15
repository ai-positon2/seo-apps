// ── Identity + workspaces store ──────────────────────────────────────────────
// Backs Google sign-in, the required post-login profile, workspaces shared
// across users, and a lightweight activity trail. See
// supabase/migrations/0008_identity_workspaces.sql for the schema.
//
// Typed tables queried with SQL (not the generic jsonb record adapter) since
// this is relational — foreign keys, membership joins, a unique constraint on
// email — rather than fetched-by-id blobs.

const db = require('./db');
// Only depends on db, so this adds no cycle. Membership changes write both the
// workspace's own history (workspace_member_events) and the cross-domain trail.
const auditEvents = require('./auditEvents');

const POSITION2_DOMAIN = 'position2.com';

function isPosition2Email(email) {
  return String(email || '').toLowerCase().endsWith('@' + POSITION2_DOMAIN);
}

// A failure that is about the database being unreachable, not about the user.
// Carries a flag so callers can tell "we could not check" from "we checked and
// the answer is no" — the login path in routes/auth.js turns the two into
// different messages, because telling someone to try again is only useful when
// trying again can work.
class UpstreamUnavailableError extends Error {
  constructor(op, cause) {
    super(`[identityStore.${op}] upstream unavailable: ${cause}`);
    this.name = "UpstreamUnavailableError";
    this.upstreamUnavailable = true;
  }
}

// What "the database is unreachable" looks like now that the transport is a
// Postgres connection rather than HTTP through Cloudflare. The old version
// sniffed for an HTML error page, because supabase-js surfaced a whole
// Cloudflare 5xx page as error.message; a driver reports the same class of
// problem as a socket error or a SQLSTATE in connection class 08.
//
// Neon adds one of its own: a suspended compute refuses connections for a
// moment while it wakes, which is transient and worth retrying.
function isTransientUpstream(error) {
  const msg = String(error?.message || error || "");
  const code = String(error?.code || "");

  // Postgres connection-exception class, plus shutdown/startup and overload.
  if (/^08/.test(code)) return true;
  if (["57P01", "57P02", "57P03", "53300", "53400"].includes(code)) return true;

  // Socket-level failures reaching the host at all.
  if (["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EPIPE", "ENETUNREACH"].includes(code)) {
    return true;
  }

  return (
    /Connection terminated|connection terminated unexpectedly|timeout expired|Client has encountered a connection error/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed/i.test(msg) ||
    // Neon control-plane / cold-start wording.
    /Console request failed|compute time quota|endpoint is disabled|could not connect to compute node/i.test(msg)
  );
}

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

// Retries only what is worth retrying. A unique-constraint violation or a
// permission error is not going to change on the second attempt, and retrying
// it just makes the user wait longer for the same answer.
async function withRetry(op, run) {
  let last;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (!isTransientUpstream(error)) fail(op, error);
      if (attempt < RETRY_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
      }
    }
  }
  throw new UpstreamUnavailableError(op, String(last?.message || last).slice(0, 120));
}

function fail(op, error) {
  if (isTransientUpstream(error)) {
    throw new UpstreamUnavailableError(op, String(error.message || error).slice(0, 120));
  }
  throw new Error(`[identityStore.${op}] ${error.message || error}`);
}

// ── Users ────────────────────────────────────────────────────────────────────

// Called on every successful Google login. Creates the user row on first
// login, bumps last_login_at on every subsequent one.
async function getOrCreateUser(email) {
  const existing = await withRetry('getOrCreateUser(find)', () =>
    db.maybeOne(`select * from app_users where email = $1`, [email]));

  if (existing) {
    return withRetry('getOrCreateUser(touch)', () =>
      db.one(`update app_users set last_login_at = $1 where id = $2 returning *`,
        [new Date().toISOString(), existing.id]));
  }

  return withRetry('getOrCreateUser(insert)', () =>
    db.one(`insert into app_users (email) values ($1) returning *`, [email]));
}

async function getUserById(userId) {
  if (!userId) return null;
  try {
    return await db.maybeOne(`select * from app_users where id = $1`, [userId]);
  } catch (error) {
    fail('getUserById', error);
  }
}

// ── Profile ──────────────────────────────────────────────────────────────────

async function getProfile(userId) {
  try {
    return await db.maybeOne(`select * from user_profiles where user_id = $1`, [userId]);
  } catch (error) {
    fail('getProfile', error);
  }
}

// @position2.com emails always get company forced to "Position2" and locked,
// regardless of what the client sends — enforced here, not just in the UI.
async function upsertProfile(userId, email, { fullName, company }) {
  const locked = isPosition2Email(email);
  try {
    return await db.one(
      `insert into user_profiles (user_id, full_name, company, company_locked, updated_at)
         values ($1, $2, $3, $4, $5)
       on conflict (user_id) do update set
         full_name = excluded.full_name,
         company = excluded.company,
         company_locked = excluded.company_locked,
         updated_at = excluded.updated_at
       returning *`,
      [userId, fullName, locked ? 'Position2' : company, locked, new Date().toISOString()]
    );
  } catch (error) {
    fail('upsertProfile', error);
  }
}

// ── Workspaces ───────────────────────────────────────────────────────────────

// Which workspaces a user belongs to, cached per user.
//
// Why it is worth caching at all: /api/runs and /api/runs/stats both call this,
// the runs panel polls both every 5 seconds, and the configured database
// round-trips a trivial query in ~260ms -- so rendering a workspace NAME cost
// about half a second of network on every tick. projects/routes.js and
// workspaces.js read it on every page load too.
//
// Membership changes are rare and every one of them invalidates here, so the
// TTL only bounds how long a row edited directly in the database takes to show.
const WORKSPACES_TTL_MS = 5 * 60 * 1000;
const WORKSPACES_CACHE_MAX = 5000;
const workspacesCache = new Map(); // userId -> { value, expires }

function invalidateWorkspacesFor(userId) {
  if (userId) workspacesCache.delete(userId);
  else workspacesCache.clear();
}

async function listWorkspacesForUser(userId) {
  const hit = workspacesCache.get(userId);
  if (hit && hit.expires >= Date.now()) return hit.value;
  if (hit) workspacesCache.delete(userId);
  return cacheWorkspaces(userId, await loadWorkspacesForUser(userId));
}

function cacheWorkspaces(userId, value) {
  if (workspacesCache.size >= WORKSPACES_CACHE_MAX) {
    let oldestKey = null; let oldest = Infinity;
    for (const [k, v] of workspacesCache) { if (v.expires < oldest) { oldest = v.expires; oldestKey = k; } }
    if (oldestKey) workspacesCache.delete(oldestKey);
  }
  workspacesCache.set(userId, { value, expires: Date.now() + WORKSPACES_TTL_MS });
  return value;
}

async function loadWorkspacesForUser(userId) {
  // One query where PostgREST needed two: the embedded workspaces(*) resource
  // is a join, and the creator's email — shown so the workspace list can say
  // whose workspace a run landed in — is a second join rather than a follow-up
  // round trip per distinct owner.
  //
  // Personal workspace first, then newest, which is the order the switcher
  // shows them in.
  let rows;
  try {
    rows = await db.rows(
      `select w.*, m.role as my_role, o.email as owner_email
         from workspace_members m
         join workspaces w on w.id = m.workspace_id
         left join app_users o on o.id = w.created_by
        where m.user_id = $1
        order by w.is_personal desc nulls last, w.created_at desc`,
      [userId]
    );
  } catch (error) {
    fail('listWorkspacesForUser', error);
  }

  return rows.map(({ my_role, owner_email, ...workspace }) => ({
    ...workspace,
    myRole: my_role,
    ownerEmail: owner_email || null,
  }));
}

// True when the user is a member of the workspace. Used to validate the
// workspace a request claims (the workspace_id cookie) before anything is
// written against it — a cookie is caller-supplied and never trusted.
async function isWorkspaceMember(workspaceId, userId) {
  if (!workspaceId || !userId) return false;
  try {
    const row = await db.maybeOne(
      `select user_id from workspace_members where workspace_id = $1 and user_id = $2`,
      [workspaceId, userId]
    );
    return Boolean(row);
  } catch (error) {
    fail('isWorkspaceMember', error);
  }
}

// The user's own workspace, or null if they don't have one yet.
async function getPersonalWorkspace(userId) {
  try {
    return await db.maybeOne(
      `select * from workspaces where created_by = $1 and is_personal = true`, [userId]);
  } catch (error) {
    fail('getPersonalWorkspace', error);
  }
}

// Creates the user's personal workspace — owned by that user (created_by plus
// an 'owner' membership row), one per user. Concurrent callers are safe: the
// partial unique index on workspaces(created_by) where is_personal makes the
// second insert fail, and we re-read the winner instead of erroring.
//
// This — not "whichever shared workspace they happen to belong to" — is where
// a user's runs land until they explicitly pick another one. Being added to
// someone else's workspace shouldn't silently start publishing your runs into
// it; switching is a deliberate act (POST /api/workspaces/:id/activate).
async function ensurePersonalWorkspace(userId, email, nameOverride) {
  const existing = await getPersonalWorkspace(userId);
  if (existing) return existing;

  const local = String(email || '').split('@')[0] || 'My';
  const name = nameOverride || `${local}'s workspace`;

  // The workspace and its owner membership go in together: a failure between
  // the two used to leave a workspace nobody was a member of, which no screen
  // could then show or delete.
  try {
    return await db.tx(async (t) => {
      const workspace = await t.one(
        `insert into workspaces (name, created_by, is_personal) values ($1, $2, true) returning *`,
        [name, userId]
      );
      await t.query(
        `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')
           on conflict (workspace_id, user_id) do update set role = excluded.role`,
        [workspace.id, userId]
      );
      invalidateWorkspacesFor(userId);
      return workspace;
    });
  } catch (error) {
    // Lost the race (or the index rejected a duplicate) — the other caller's
    // workspace is the one that counts.
    const winner = await getPersonalWorkspace(userId);
    if (winner) return winner;
    fail('ensurePersonalWorkspace', error);
  }
}

async function createWorkspace(userId, name, actorEmail = null) {
  let workspace;
  try {
    workspace = await db.tx(async (t) => {
      const created = await t.one(
        `insert into workspaces (name, created_by) values ($1, $2) returning *`, [name, userId]);
      await t.query(
        `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
        [created.id, userId]
      );
      // The creator's own 'owner' membership is the first entry in this
      // workspace's history, so the trail starts where the workspace does
      // rather than at whoever was added second.
      await writeMemberEvent(t, {
        workspaceId: created.id,
        access: { userId, actorEmail },
        subjectUserId: userId,
        subjectEmail: actorEmail,
        action: 'added',
        oldRole: null,
        newRole: 'owner',
        reason: 'Workspace created',
      });
      return created;
    });
  } catch (error) {
    fail('createWorkspace', error);
  }

  await auditEvents.record({
    action: auditEvents.ACTIONS.WORKSPACE_CREATED,
    workspaceId: workspace.id,
    actorUserId: userId,
    actorEmail,
    actorRole: 'owner',
    entityType: 'workspace',
    entityId: workspace.id,
    newState: { name: workspace.name },
    source: 'api.workspaces',
  });

  invalidateWorkspacesFor(userId);
  return { ...workspace, myRole: 'owner' };
}

// Returns the workspace with its members, or null if the requester isn't one.
async function getWorkspace(workspaceId, requesterId) {
  let membership;
  try {
    membership = await db.maybeOne(
      `select role from workspace_members where workspace_id = $1 and user_id = $2`,
      [workspaceId, requesterId]
    );
  } catch (error) {
    fail('getWorkspace(membership)', error);
  }
  if (!membership) return null;

  let workspace;
  try {
    workspace = await db.maybeOne(`select * from workspaces where id = $1`, [workspaceId]);
  } catch (error) {
    fail('getWorkspace(workspace)', error);
  }
  if (!workspace) return null;

  let members;
  try {
    members = await db.rows(
      `select m.role, m.added_at, u.id as user_id, u.email
         from workspace_members m
         join app_users u on u.id = m.user_id
        where m.workspace_id = $1`,
      [workspaceId]
    );
  } catch (error) {
    fail('getWorkspace(members)', error);
  }

  return {
    ...workspace,
    myRole: membership.role,
    members: members.map(m => ({
      userId: m.user_id, email: m.email, role: m.role, addedAt: m.added_at,
    })),
  };
}

// ── Membership changes ──────────────────────────────────────────────────────
//
// Authorization is NOT done in these three functions. Each takes an
// already-resolved access context from services/projectAccess.js, the same
// contract modules/projects/store.js works to — one implementation of the
// permission matrix, applied at the route, instead of a second copy here that
// can drift from it.
//
// It had drifted. These functions used to check `requester.role !== 'owner'`
// literally, while the matrix grants 'manageWorkspaceMembers' to admin AND
// owner. A workspace admin was told they could manage members and then got a
// 403 — and since the add route coerced every role to 'owner' or 'member',
// there was no way to make anyone an admin to discover it.
//
// Two rules below are NOT authorization and so do live here, because they are
// about the data staying coherent rather than about who is asking:
//
//   * a workspace must keep at least one owner (removal and demotion both)
//   * only an owner may grant or revoke the owner role — 'manageWorkspaceMembers'
//     is held by admins too, and letting an admin mint an owner is a privilege
//     escalation: it hands away powers, like transferOwnership, that the matrix
//     deliberately withholds from them.

/** Legal roles on the way IN. 'member' is accepted as the legacy spelling. */
const ASSIGNABLE_ROLES = ['contributor', 'approver', 'admin', 'owner'];

function invalidRole(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_role' });
}

/**
 * Validates a role from a request body.
 *
 * Deliberately NOT projectAccess.normalizeRole: that maps anything unrecognized
 * to 'contributor', which is right when READING a stored row (an unknown role
 * must not grant more than the least privilege) and wrong when WRITING one —
 * it would silently turn a typo'd "aprover" into a contributor and report
 * success.
 */
function parseAssignableRole(input, { fallback = null } = {}) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) {
    if (fallback) return fallback;
    throw invalidRole(`A role is required — one of ${ASSIGNABLE_ROLES.join(', ')}.`);
  }
  if (raw === 'member') return 'contributor';   // legacy spelling, still stored in old rows
  if (!ASSIGNABLE_ROLES.includes(raw)) {
    throw invalidRole(`"${input}" is not a role. Use one of ${ASSIGNABLE_ROLES.join(', ')}.`);
  }
  return raw;
}

// ── The membership trail ────────────────────────────────────────────────────
//
// Migration 0011 created workspace_member_events for PRD §17.1's immutable
// membership history and nothing ever wrote to it, so who was given access to a
// client's data, by whom, and when was recorded nowhere at all. The same was
// true of the audit_events action WORKSPACE_ROLE_CHANGED: declared, never
// recorded.
//
// The event row is written INSIDE the same transaction as the membership change
// rather than after it. Access grants are exactly the records you need when
// something has gone wrong, and "the change landed but the log did not" is the
// case where the trail is least trustworthy and most needed.
async function writeMemberEvent(t, { workspaceId, access, subjectUserId, subjectEmail, action, oldRole, newRole, reason }) {
  await t.query(
    `insert into workspace_member_events
       (workspace_id, subject_user, subject_email, actor_user_id, actor_email, action, old_role, new_role, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      workspaceId,
      subjectUserId || null,
      subjectEmail || null,
      access.userId || null,
      access.actorEmail || null,
      action,
      oldRole || null,
      newRole || null,
      reason || null,
    ]
  );
}

// The cross-domain trail gets the same fact. Separate from the table above on
// purpose: that one is the workspace's own membership history, this one is the
// single log an administrator reads across every workspace and project.
// Fire-and-forget — the membership change and its own history have already
// committed, and failing the request now would report the opposite of what
// happened.
function recordRoleAudit({ workspaceId, access, subjectUserId, subjectEmail, action, oldRole, newRole }) {
  return auditEvents.record({
    action: auditEvents.ACTIONS.WORKSPACE_ROLE_CHANGED,
    workspaceId,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    entityType: 'workspace_member',
    entityId: subjectUserId,
    oldState: oldRole ? { role: oldRole } : null,
    newState: newRole ? { role: newRole, subjectEmail } : { removed: true, subjectEmail },
    source: `api.workspaces.${action}`,
  });
}

/**
 * A workspace's membership history, newest first.
 *
 * subject_user is ON DELETE SET NULL, so an event outlives the account it is
 * about — which is the point of keeping subject_email on the row. The join is
 * LEFT so a removed account's history still reads, and the stored email is the
 * fallback when the user row is gone.
 */
async function listMemberEvents(workspaceId, { limit = 50 } = {}) {
  try {
    const rows = await db.rows(
      `select e.id, e.action, e.old_role, e.new_role, e.reason, e.created_at,
              e.subject_user, coalesce(su.email, e.subject_email) as subject_email,
              e.actor_user_id, coalesce(au.email, e.actor_email) as actor_email
         from workspace_member_events e
         left join app_users su on su.id = e.subject_user
         left join app_users au on au.id = e.actor_user_id
        where e.workspace_id = $1
        order by e.created_at desc, e.id desc
        limit $2`,
      [workspaceId, limit]
    );
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      oldRole: r.old_role,
      newRole: r.new_role,
      reason: r.reason,
      createdAt: r.created_at,
      subjectEmail: r.subject_email,
      actorEmail: r.actor_email,
    }));
  } catch (error) {
    fail('listMemberEvents', error);
  }
}

/**
 * Runs a membership change with every OTHER membership change to the same
 * workspace held off until it commits.
 *
 * The last-owner rule is a check followed by a write, and the two used to sit in
 * different transactions: the count was read on the pool, the delete ran in a
 * transaction of its own. Two owners removing each other at the same moment both
 * read "2 owners", both passed the guard, and both deleted — leaving a workspace
 * with ZERO owners, which nobody can then administer, invite to, or request
 * deletion of. Measured, not theorised: two concurrent DELETEs returned 200+200
 * and left 0 owners.
 *
 * `select … from workspaces where id = $1 for update` is the serialization
 * point. It locks the parent row rather than the member rows, so it also covers
 * the case where the row that would have to be locked does not exist yet (an
 * INSERT racing a DELETE). The same pattern workspaceLifecycle.purge() already
 * uses to stop a purge racing a restore.
 */
async function withWorkspaceLock(workspaceId, run) {
  return db.tx(async (t) => {
    await t.query(`select id from workspaces where id = $1 for update`, [workspaceId]);
    return run(t);
  });
}

/** How many owners a workspace has, read inside the caller's transaction. */
async function ownerCountIn(t, workspaceId) {
  const n = await t.value(
    `select count(*) from workspace_members where workspace_id = $1 and role = 'owner'`,
    [workspaceId]);
  return Number(n) || 0;
}

function lastOwnerError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'last_owner' });
}

// Lets a deliberate 400/403 out of a transaction untouched, while a genuine
// database failure still goes through fail() and gets its context.
function rethrow(op, error) {
  if (error && error.status) throw error;
  fail(op, error);
}

/**
 * Refuses an admin's attempt to grant or revoke ownership.
 *
 * Called with whichever role is in question — the one being granted, or the one
 * already held — so the granting case can be settled BEFORE any query runs.
 * Asking the database who someone is, only to refuse on a rule that did not
 * depend on the answer, is a round trip spent to reach a decision already made.
 */
function assertMayChangeOwnerRole({ access, role }) {
  if (role !== 'owner') return;
  if (access.role === 'owner' || access.isPlatformAdmin) return;
  throw Object.assign(
    new Error('Only a workspace owner can grant or revoke the owner role.'),
    { status: 403, code: 'forbidden' },
  );
}

/**
 * Adds someone to a workspace, or updates their role if they are already in it.
 * The invited user must have signed in at least once (no email-invite flow yet).
 *
 * @param {object} opts
 * @param {object} opts.access   resolved by projectAccess.requireWorkspace(…, 'manageWorkspaceMembers')
 * @param {string} opts.email
 * @param {string} [opts.role]   defaults to contributor — the least-privileged role
 */
async function addWorkspaceMember({ access, email, role }) {
  const workspaceId = access.workspaceId;
  const nextRole = parseAssignableRole(role, { fallback: 'contributor' });

  // Settled before any query: whether this caller may hand out ownership does
  // not depend on who the target is.
  assertMayChangeOwnerRole({ access, role: nextRole });

  let targetUser;
  try {
    targetUser = await db.maybeOne(`select id, email from app_users where email = $1`, [email]);
  } catch (error) {
    fail('addWorkspaceMember(lookupUser)', error);
  }
  if (!targetUser) {
    throw Object.assign(
      new Error('That person needs to sign in to the app at least once before they can be added.'),
      { status: 404 },
    );
  }

  // Under the same lock as the other two. Re-adding an existing member updates
  // their role, so this is a demotion path as well as an insert — and a
  // demotion racing a removal is how the last owner seat disappears.
  let outcome;
  try {
    outcome = await withWorkspaceLock(workspaceId, async (t) => {
      const existing = await t.maybeOne(
        `select role from workspace_members where workspace_id = $1 and user_id = $2`,
        [workspaceId, targetUser.id]);

      // The other half: demoting someone who currently holds owner is equally a
      // change to ownership, and needs the target's role to detect.
      assertMayChangeOwnerRole({ access, role: existing?.role || null });

      if (existing?.role === 'owner' && nextRole !== 'owner'
          && (await ownerCountIn(t, workspaceId)) <= 1) {
        throw lastOwnerError("That is the workspace's last owner — promote someone else first.");
      }

      const act = existing ? 'role_changed' : 'added';
      const row = await t.one(
        `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)
           on conflict (workspace_id, user_id) do update set role = excluded.role
         returning *`,
        [workspaceId, targetUser.id, nextRole]);
      await writeMemberEvent(t, {
        workspaceId, access,
        subjectUserId: targetUser.id,
        subjectEmail: targetUser.email,
        action: act,
        oldRole: existing?.role || null,
        newRole: nextRole,
      });
      return { member: row, action: act, oldRole: existing?.role || null };
    });
  } catch (error) {
    rethrow('addWorkspaceMember', error);
  }
  const { member, action } = outcome;
  const existing = outcome.oldRole ? { role: outcome.oldRole } : null;

  // projectAccess caches membership for 30s to keep a quarter-second round
  // trip off every project request. Dropping the entry here is what makes
  // that cache safe: the change takes effect on the very next request rather
  // than whenever the window happens to end. Required lazily -- projectAccess
  // pulls in the database layer, and this module is required during boot.
  require('./projectAccess').invalidateRole(workspaceId, targetUser.id);
  invalidateWorkspacesFor(targetUser.id);

  await recordRoleAudit({
    workspaceId, access,
    subjectUserId: targetUser.id, subjectEmail: targetUser.email,
    action, oldRole: existing?.role || null, newRole: nextRole,
  });

  return member;
}

/**
 * Changes an existing member's role.
 *
 * Its own operation rather than a remove-and-re-add, which is what the UI had to
 * do before: that path drops the workspace_members row and inserts a new one,
 * losing added_at — the record of how long someone has had access.
 */
async function setWorkspaceMemberRole({ access, targetUserId, role }) {
  const workspaceId = access.workspaceId;
  const nextRole = parseAssignableRole(role);

  // Granting ownership is refused before the lookup — the answer does not
  // depend on the target's current role.
  assertMayChangeOwnerRole({ access, role: nextRole });

  // Promoting someone to owner is the transfer the matrix names separately, so
  // the trail says so rather than flattening it into a generic role change.
  const action = nextRole === 'owner' ? 'ownership_transferred' : 'role_changed';

  // Same lock as removal: demoting the last owner reaches the ownerless state
  // by a different route, and the count-then-write split raced identically.
  let outcome;
  try {
    outcome = await withWorkspaceLock(workspaceId, async (t) => {
      const existing = await t.maybeOne(
        `select role, added_at from workspace_members where workspace_id = $1 and user_id = $2`,
        [workspaceId, targetUserId]);
      if (!existing) {
        throw Object.assign(new Error('That person is not a member of this workspace.'), { status: 404 });
      }

      // Revoking ownership needs the target's current role, so it is checked here.
      assertMayChangeOwnerRole({ access, role: existing.role });

      if (existing.role === nextRole) {
        return { member: { ...existing, user_id: targetUserId, workspace_id: workspaceId }, noop: true };
      }

      if (existing.role === 'owner' && (await ownerCountIn(t, workspaceId)) <= 1) {
        throw lastOwnerError(
          "That is the workspace's last owner — promote someone else before changing this role.");
      }

      const row = await t.one(
        `update workspace_members set role = $3
          where workspace_id = $1 and user_id = $2
          returning *`,
        [workspaceId, targetUserId, nextRole]);
      await writeMemberEvent(t, {
        workspaceId, access,
        subjectUserId: targetUserId,
        action,
        oldRole: existing.role,
        newRole: nextRole,
      });
      return { member: row, oldRole: existing.role };
    });
  } catch (error) {
    rethrow('setWorkspaceMemberRole', error);
  }

  if (outcome.noop) return outcome.member;

  require('./projectAccess').invalidateRole(workspaceId, targetUserId);
  invalidateWorkspacesFor(targetUserId);

  await recordRoleAudit({
    workspaceId, access, subjectUserId: targetUserId,
    action, oldRole: outcome.oldRole, newRole: nextRole,
  });

  return outcome.member;
}

async function removeWorkspaceMember({ access, targetUserId }) {
  const workspaceId = access.workspaceId;

  // Read, guard, delete and record all inside one lock. Splitting the count
  // from the delete is what let two concurrent removals empty a workspace of
  // owners — see withWorkspaceLock.
  let existing;
  try {
    existing = await withWorkspaceLock(workspaceId, async (t) => {
      const row = await t.maybeOne(
        `select role from workspace_members where workspace_id = $1 and user_id = $2`,
        [workspaceId, targetUserId]);
      if (!row) return null;   // already gone; removing twice is not an error

      // Removing an owner is revoking ownership, so it needs the same guard.
      assertMayChangeOwnerRole({ access, role: row.role });

      // Applies to anyone holding the last owner seat, not just to yourself.
      if (row.role === 'owner' && (await ownerCountIn(t, workspaceId)) <= 1) {
        throw lastOwnerError("That is the workspace's last owner — add another owner first.");
      }

      await t.query(
        `delete from workspace_members where workspace_id = $1 and user_id = $2`,
        [workspaceId, targetUserId]);
      // Written before the transaction closes, so losing access and the record
      // of losing it cannot come apart. The subject_user foreign key is
      // ON DELETE SET NULL, not CASCADE, so this row outlives the account too.
      await writeMemberEvent(t, {
        workspaceId, access,
        subjectUserId: targetUserId,
        action: 'removed',
        oldRole: row.role,
        newRole: null,
      });
      return row;
    });
  } catch (error) {
    rethrow('removeWorkspaceMember', error);
  }

  if (!existing) return true;

  require('./projectAccess').invalidateRole(workspaceId, targetUserId);
  invalidateWorkspacesFor(targetUserId);

  await recordRoleAudit({
    workspaceId, access, subjectUserId: targetUserId,
    action: 'removed', oldRole: existing.role, newRole: null,
  });

  return true;
}

// ── Platform-embed identity ─────────────────────────────────────────────────
// A session can still carry no individual user behind it — a Google sign-in on a
// deployment with the database unconfigured. (This was written for a shared-token
// iframe login that has since been removed.) Rather than dropping their runs,
// they are attributed to one synthetic user and its workspace, so the
// invariant every run has a workspace, and every workspace has a primary user
// still holds. Marked is_personal so the unique index guarantees exactly one.
const PLATFORM_EMAIL = 'platform-embed@position2.com';

async function ensurePlatformWorkspace() {
  const user = await getOrCreateUser(PLATFORM_EMAIL);
  const workspace = await ensurePersonalWorkspace(user.id, PLATFORM_EMAIL, 'Platform (embedded)');
  return { userId: user.id, workspaceId: workspace?.id || null };
}

// ── Activity trail ───────────────────────────────────────────────────────────
// Fire-and-forget — never throws, so a logging failure can't break a request.
async function recordActivity({ userId, workspaceId, method, path }) {
  if (!db.isDatabaseConfigured() || !userId) return;
  try {
    await db.query(
      `insert into activity_log (user_id, workspace_id, method, path) values ($1, $2, $3, $4)`,
      [userId, workspaceId || null, method, path]
    );
  } catch (e) {
    console.error('[identityStore.recordActivity]', e.message);
  }
}

module.exports = {
  UpstreamUnavailableError,
  isTransientUpstream,
  isPosition2Email,
  getOrCreateUser, getUserById,
  getProfile, upsertProfile,
  listWorkspacesForUser, createWorkspace, getWorkspace,
  addWorkspaceMember, setWorkspaceMemberRole, removeWorkspaceMember, listMemberEvents,
  ASSIGNABLE_ROLES, parseAssignableRole,
  isWorkspaceMember, getPersonalWorkspace, ensurePersonalWorkspace, ensurePlatformWorkspace,
  PLATFORM_EMAIL,
  recordActivity,
};
