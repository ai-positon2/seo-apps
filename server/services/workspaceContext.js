// ── Active-workspace resolution ─────────────────────────────────────────────
// Answers one question, on every tracked request: which workspace does this
// user's work belong to?
//
//   1. The workspace_id cookie, if the user is actually a member of it
//      (set by POST /api/workspaces/:id/activate — caller-supplied, so it is
//      membership-checked every time it's used, never trusted as-is).
//   2. Otherwise their own personal workspace, created on the spot if they
//      don't have one yet — so a run always has a workspace, without anyone
//      having to set one up first, and being added to somebody else's
//      workspace never silently starts recording your runs into it.
//
// Platform-embed sessions (shared iframe token, no individual user) resolve to
// one synthetic user + workspace instead — see ensurePlatformWorkspace.
//
// Resolution is cached per identity (short TTL) because it sits in front of
// every module: the steady state is zero extra queries per request.

const identityStore = require('./identityStore');
const { isSupabaseConfigured } = require('./supabase');

const CACHE_TTL_MS = 5 * 60 * 1000;
const PLATFORM_KEY = '__platform_embed__';

const cache = new Map();     // key → { identity, expires }
const inflight = new Map();  // key → Promise<identity>  (collapses concurrent resolves)

const EMPTY = { userId: null, workspaceId: null, actorEmail: null };

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { cache.delete(key); return undefined; }
  return hit.identity;
}

function cacheSet(key, identity) {
  cache.set(key, { identity, expires: Date.now() + CACHE_TTL_MS });
}

function invalidate(key) {
  cache.delete(key);
  inflight.delete(key);
}

// Called after an explicit switch so the next request doesn't have to re-verify.
function setActiveWorkspace(userId, workspaceId, actorEmail) {
  if (userId && workspaceId) cacheSet(userId, { userId, workspaceId, actorEmail: actorEmail || null });
}

// Cached value only — no queries, no promises. Lets synchronous paths (the
// activity-log line in requireAuth) attribute a validated workspace when one
// is already known, and skip it otherwise, rather than blocking the request.
function peekWorkspaceId(userId) {
  return (userId && cacheGet(userId)?.workspaceId) || null;
}

// Collapses concurrent first-time resolutions for the same identity into one.
function once(key, factory) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    try {
      return await factory();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

async function resolvePlatformIdentity() {
  const cached = cacheGet(PLATFORM_KEY);
  if (cached) return cached;
  return once(PLATFORM_KEY, async () => {
    try {
      const { userId, workspaceId } = await identityStore.ensurePlatformWorkspace();
      const identity = { userId, workspaceId, actorEmail: identityStore.PLATFORM_EMAIL };
      if (workspaceId) cacheSet(PLATFORM_KEY, identity);
      return identity;
    } catch (e) {
      console.error('[workspaceContext.platform]', e.message);
      return EMPTY;
    }
  });
}

async function resolveUserIdentity(userId, email, requestedWorkspaceId) {
  // An explicitly selected workspace wins, but only after a membership check.
  if (requestedWorkspaceId) {
    const cached = cacheGet(userId);
    if (cached?.workspaceId === requestedWorkspaceId) return cached;
    try {
      if (await identityStore.isWorkspaceMember(requestedWorkspaceId, userId)) {
        const identity = { userId, workspaceId: requestedWorkspaceId, actorEmail: email || null };
        cacheSet(userId, identity);
        return identity;
      }
    } catch (e) {
      console.error('[workspaceContext.resolve(requested)]', e.message);
    }
    // Not a member (stale cookie, or removed from the workspace) — fall
    // through to the user's own default rather than failing the request.
  }

  const cached = cacheGet(userId);
  if (cached) return cached;

  return once(userId, async () => {
    try {
      const workspace = await identityStore.ensurePersonalWorkspace(userId, email);
      const identity = { userId, workspaceId: workspace?.id || null, actorEmail: email || null };
      if (identity.workspaceId) cacheSet(userId, identity);
      return identity;
    } catch (e) {
      console.error('[workspaceContext.resolve]', e.message);
      return { userId, workspaceId: null, actorEmail: email || null };
    }
  });
}

// The single entry point used by the run-tracking middleware and the runs API:
// reads the identity requireAuth put on the request plus the workspace cookie,
// and resolves both to { userId, workspaceId, actorEmail }.
async function resolveIdentity(req) {
  if (!isSupabaseConfigured()) return EMPTY;
  const userId = req.user?.userId;
  const email = req.user?.username;
  if (userId) return resolveUserIdentity(userId, email, req.cookies?.workspace_id);
  if (req.user) return resolvePlatformIdentity();
  return EMPTY;
}

module.exports = { resolveIdentity, peekWorkspaceId, setActiveWorkspace, invalidate };
