// ── Identity + workspaces store ──────────────────────────────────────────────
// Backs Google sign-in, the required post-login profile, workspaces shared
// across users, and a lightweight activity trail. See
// supabase/migrations/0008_identity_workspaces.sql for the schema.
//
// Typed tables queried directly via getSupabase() (not the generic jsonb
// store adapter) since this is relational — foreign keys, membership joins,
// a unique constraint on email — rather than fetched-by-id blobs.

const { getSupabase, isSupabaseConfigured } = require('./supabase');

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

// Supabase behind Cloudflare does not fail cleanly. A project that is down
// returns an HTML error page with a 5xx, and supabase-js surfaces the entire
// page as `error.message` — which is how a server log ends up containing
// "<!DOCTYPE html>" where a diagnosis should be.
function isTransientUpstream(error) {
  const msg = String(error?.message || error || "");
  return (
    /^s*<!DOCTYPE html/i.test(msg) ||
    /<html[s>]/i.test(msg) ||
    /gateway timeout|bad gateway|service unavailable|connection timed out/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(msg) ||
    ["502", "503", "504", "520", "521", "522", "523", "524"].includes(String(error?.status || ""))
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
    const { data, error } = await run();
    if (!error) return data;
    last = error;
    if (!isTransientUpstream(error)) fail(op, error);
    if (attempt < RETRY_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
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
  const sb = getSupabase();
  const existing = await withRetry('getOrCreateUser(find)', () =>
    sb.from('app_users').select('*').eq('email', email).maybeSingle());

  if (existing) {
    return withRetry('getOrCreateUser(touch)', () =>
      sb.from('app_users').update({ last_login_at: new Date().toISOString() })
        .eq('id', existing.id).select('*').single());
  }

  return withRetry('getOrCreateUser(insert)', () =>
    sb.from('app_users').insert({ email }).select('*').single());
}

async function getUserById(userId) {
  if (!userId) return null;
  const { data, error } = await getSupabase()
    .from('app_users').select('*').eq('id', userId).maybeSingle();
  if (error) fail('getUserById', error);
  return data;
}

// ── Profile ──────────────────────────────────────────────────────────────────

async function getProfile(userId) {
  const { data, error } = await getSupabase()
    .from('user_profiles').select('*').eq('user_id', userId).maybeSingle();
  if (error) fail('getProfile', error);
  return data;
}

// @position2.com emails always get company forced to "Position2" and locked,
// regardless of what the client sends — enforced here, not just in the UI.
async function upsertProfile(userId, email, { fullName, company }) {
  const locked = isPosition2Email(email);
  const record = {
    user_id: userId,
    full_name: fullName,
    company: locked ? 'Position2' : company,
    company_locked: locked,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await getSupabase()
    .from('user_profiles').upsert(record, { onConflict: 'user_id' }).select('*').single();
  if (error) fail('upsertProfile', error);
  return data;
}

// ── Workspaces ───────────────────────────────────────────────────────────────

async function listWorkspacesForUser(userId) {
  const sb = getSupabase();
  const { data: memberships, error } = await sb
    .from('workspace_members').select('role, workspace_id, workspaces(*)').eq('user_id', userId);
  if (error) fail('listWorkspacesForUser', error);

  const workspaces = (memberships || [])
    .filter(m => m.workspaces)
    .map(m => ({ ...m.workspaces, myRole: m.role }));

  // Every workspace has one primary user — its creator/owner. Resolved here so
  // the workspace list (and the runs list built on top of it) can show whose
  // workspace a run landed in without a second round trip per row.
  const ownerIds = [...new Set(workspaces.map(w => w.created_by).filter(Boolean))];
  if (ownerIds.length) {
    const { data: owners, error: ownerErr } = await sb
      .from('app_users').select('id, email').in('id', ownerIds);
    if (ownerErr) fail('listWorkspacesForUser(owners)', ownerErr);
    const byId = new Map((owners || []).map(o => [o.id, o.email]));
    for (const w of workspaces) w.ownerEmail = byId.get(w.created_by) || null;
  }

  // Personal workspace first, then newest — the order the switcher shows them in.
  return workspaces.sort((a, b) => {
    if (Boolean(a.is_personal) !== Boolean(b.is_personal)) return a.is_personal ? -1 : 1;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
}

// True when the user is a member of the workspace. Used to validate the
// workspace a request claims (the workspace_id cookie) before anything is
// written against it — a cookie is caller-supplied and never trusted.
async function isWorkspaceMember(workspaceId, userId) {
  if (!workspaceId || !userId) return false;
  const { data, error } = await getSupabase()
    .from('workspace_members').select('user_id')
    .eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  if (error) fail('isWorkspaceMember', error);
  return Boolean(data);
}

// The user's own workspace, or null if they don't have one yet.
async function getPersonalWorkspace(userId) {
  const { data, error } = await getSupabase()
    .from('workspaces').select('*').eq('created_by', userId).eq('is_personal', true).maybeSingle();
  if (error) fail('getPersonalWorkspace', error);
  return data;
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

  const sb = getSupabase();
  const local = String(email || '').split('@')[0] || 'My';
  const name = nameOverride || `${local}'s workspace`;

  const { data: workspace, error } = await sb
    .from('workspaces').insert({ name, created_by: userId, is_personal: true }).select('*').single();
  if (error) {
    // Lost the race (or the index rejected a duplicate) — the other caller's
    // workspace is the one that counts.
    const winner = await getPersonalWorkspace(userId);
    if (winner) return winner;
    fail('ensurePersonalWorkspace', error);
  }

  const { error: memberErr } = await sb
    .from('workspace_members').upsert(
      { workspace_id: workspace.id, user_id: userId, role: 'owner' },
      { onConflict: 'workspace_id,user_id' },
    );
  if (memberErr) fail('ensurePersonalWorkspace(addOwner)', memberErr);

  return workspace;
}

async function createWorkspace(userId, name) {
  const sb = getSupabase();
  const { data: workspace, error } = await sb
    .from('workspaces').insert({ name, created_by: userId }).select('*').single();
  if (error) fail('createWorkspace', error);

  const { error: memberErr } = await sb
    .from('workspace_members').insert({ workspace_id: workspace.id, user_id: userId, role: 'owner' });
  if (memberErr) fail('createWorkspace(addOwner)', memberErr);

  return { ...workspace, myRole: 'owner' };
}

// Returns the workspace with its members, or null if the requester isn't one.
async function getWorkspace(workspaceId, requesterId) {
  const sb = getSupabase();
  const { data: membership, error: memberErr } = await sb
    .from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', requesterId).maybeSingle();
  if (memberErr) fail('getWorkspace(membership)', memberErr);
  if (!membership) return null;

  const { data: workspace, error: wsErr } = await sb
    .from('workspaces').select('*').eq('id', workspaceId).maybeSingle();
  if (wsErr) fail('getWorkspace(workspace)', wsErr);
  if (!workspace) return null;

  const { data: members, error: membersErr } = await sb
    .from('workspace_members').select('role, added_at, app_users(id, email)').eq('workspace_id', workspaceId);
  if (membersErr) fail('getWorkspace(members)', membersErr);

  return {
    ...workspace,
    myRole: membership.role,
    members: (members || []).map(m => ({
      userId: m.app_users.id, email: m.app_users.email, role: m.role, addedAt: m.added_at,
    })),
  };
}

// requesterId must already be an 'owner' of the workspace. The invited user
// must have signed in at least once already (no email-invite flow yet).
async function addWorkspaceMember(workspaceId, requesterId, email, role = 'member') {
  const sb = getSupabase();
  const { data: requester, error: reqErr } = await sb
    .from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', requesterId).maybeSingle();
  if (reqErr) fail('addWorkspaceMember(requester)', reqErr);
  if (!requester || requester.role !== 'owner') {
    throw Object.assign(new Error('Only workspace owners can add members.'), { status: 403 });
  }

  const { data: targetUser, error: userErr } = await sb
    .from('app_users').select('id').eq('email', email).maybeSingle();
  if (userErr) fail('addWorkspaceMember(lookupUser)', userErr);
  if (!targetUser) {
    throw Object.assign(new Error('That person needs to sign in to the app at least once before they can be added.'), { status: 404 });
  }

  const { data, error } = await sb
    .from('workspace_members')
    .upsert({ workspace_id: workspaceId, user_id: targetUser.id, role }, { onConflict: 'workspace_id,user_id' })
    .select('*').single();
  if (error) fail('addWorkspaceMember(insert)', error);
  return data;
}

async function removeWorkspaceMember(workspaceId, requesterId, targetUserId) {
  const sb = getSupabase();
  const { data: requester, error: reqErr } = await sb
    .from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', requesterId).maybeSingle();
  if (reqErr) fail('removeWorkspaceMember(requester)', reqErr);
  if (!requester || requester.role !== 'owner') {
    throw Object.assign(new Error('Only workspace owners can remove members.'), { status: 403 });
  }

  if (targetUserId === requesterId) {
    const { count, error: countErr } = await sb
      .from('workspace_members').select('user_id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('role', 'owner');
    if (countErr) fail('removeWorkspaceMember(ownerCount)', countErr);
    if ((count || 0) <= 1) {
      throw Object.assign(new Error("You're the last owner — add another owner before leaving."), { status: 400 });
    }
  }

  const { error } = await sb
    .from('workspace_members').delete().eq('workspace_id', workspaceId).eq('user_id', targetUserId);
  if (error) fail('removeWorkspaceMember(delete)', error);
  return true;
}

// ── Platform-embed identity ─────────────────────────────────────────────────
// A session can still carry no individual user behind it — a Google sign-in on a
// deployment with Supabase unconfigured. (This was written for a shared-token
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
  if (!isSupabaseConfigured() || !userId) return;
  try {
    await getSupabase().from('activity_log').insert({
      user_id: userId, workspace_id: workspaceId || null, method, path,
    });
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
