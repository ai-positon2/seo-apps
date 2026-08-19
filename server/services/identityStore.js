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

function fail(op, error) {
  throw new Error(`[identityStore.${op}] ${error.message || error}`);
}

// ── Users ────────────────────────────────────────────────────────────────────

// Called on every successful Google login. Creates the user row on first
// login, bumps last_login_at on every subsequent one.
async function getOrCreateUser(email) {
  const sb = getSupabase();
  const { data: existing, error: findErr } = await sb
    .from('app_users').select('*').eq('email', email).maybeSingle();
  if (findErr) fail('getOrCreateUser(find)', findErr);

  if (existing) {
    const { data, error } = await sb
      .from('app_users').update({ last_login_at: new Date().toISOString() })
      .eq('id', existing.id).select('*').single();
    if (error) fail('getOrCreateUser(touch)', error);
    return data;
  }

  const { data, error } = await sb
    .from('app_users').insert({ email }).select('*').single();
  if (error) fail('getOrCreateUser(insert)', error);
  return data;
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
  return (memberships || []).map(m => ({ ...m.workspaces, myRole: m.role }));
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
  isPosition2Email,
  getOrCreateUser, getUserById,
  getProfile, upsertProfile,
  listWorkspacesForUser, createWorkspace, getWorkspace, addWorkspaceMember, removeWorkspaceMember,
  recordActivity,
};
