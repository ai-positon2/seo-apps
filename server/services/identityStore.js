// ── Identity + workspaces store ──────────────────────────────────────────────
// Backs Google sign-in, the required post-login profile, workspaces shared
// across users, and a lightweight activity trail. See
// supabase/migrations/0008_identity_workspaces.sql for the schema.
//
// Typed tables queried with SQL (not the generic jsonb record adapter) since
// this is relational — foreign keys, membership joins, a unique constraint on
// email — rather than fetched-by-id blobs.

const db = require('./db');

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

async function listWorkspacesForUser(userId) {
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

async function createWorkspace(userId, name) {
  try {
    const workspace = await db.tx(async (t) => {
      const created = await t.one(
        `insert into workspaces (name, created_by) values ($1, $2) returning *`, [name, userId]);
      await t.query(
        `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
        [created.id, userId]
      );
      return created;
    });
    return { ...workspace, myRole: 'owner' };
  } catch (error) {
    fail('createWorkspace', error);
  }
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

// requesterId must already be an 'owner' of the workspace. The invited user
// must have signed in at least once already (no email-invite flow yet).
async function addWorkspaceMember(workspaceId, requesterId, email, role = 'member') {
  let requester;
  try {
    requester = await db.maybeOne(
      `select role from workspace_members where workspace_id = $1 and user_id = $2`,
      [workspaceId, requesterId]
    );
  } catch (error) {
    fail('addWorkspaceMember(requester)', error);
  }
  if (!requester || requester.role !== 'owner') {
    throw Object.assign(new Error('Only workspace owners can add members.'), { status: 403 });
  }

  let targetUser;
  try {
    targetUser = await db.maybeOne(`select id from app_users where email = $1`, [email]);
  } catch (error) {
    fail('addWorkspaceMember(lookupUser)', error);
  }
  if (!targetUser) {
    throw Object.assign(new Error('That person needs to sign in to the app at least once before they can be added.'), { status: 404 });
  }

  try {
    return await db.one(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)
         on conflict (workspace_id, user_id) do update set role = excluded.role
       returning *`,
      [workspaceId, targetUser.id, role]
    );
  } catch (error) {
    fail('addWorkspaceMember(insert)', error);
  }
}

async function removeWorkspaceMember(workspaceId, requesterId, targetUserId) {
  let requester;
  try {
    requester = await db.maybeOne(
      `select role from workspace_members where workspace_id = $1 and user_id = $2`,
      [workspaceId, requesterId]
    );
  } catch (error) {
    fail('removeWorkspaceMember(requester)', error);
  }
  if (!requester || requester.role !== 'owner') {
    throw Object.assign(new Error('Only workspace owners can remove members.'), { status: 403 });
  }

  if (targetUserId === requesterId) {
    let owners;
    try {
      owners = await db.count(
        `select count(*) from workspace_members where workspace_id = $1 and role = 'owner'`,
        [workspaceId]
      );
    } catch (error) {
      fail('removeWorkspaceMember(ownerCount)', error);
    }
    if (owners <= 1) {
      throw Object.assign(new Error("You're the last owner — add another owner before leaving."), { status: 400 });
    }
  }

  try {
    await db.query(
      `delete from workspace_members where workspace_id = $1 and user_id = $2`,
      [workspaceId, targetUserId]
    );
  } catch (error) {
    fail('removeWorkspaceMember(delete)', error);
  }
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
  listWorkspacesForUser, createWorkspace, getWorkspace, addWorkspaceMember, removeWorkspaceMember,
  isWorkspaceMember, getPersonalWorkspace, ensurePersonalWorkspace, ensurePlatformWorkspace,
  PLATFORM_EMAIL,
  recordActivity,
};
