// ── Home-workspace resolution ───────────────────────────────────────────────
// Answers one question, on every tracked request: where does work that belongs
// to no project get recorded, and where does a new project go by default?
//
// Always the user's home workspace (identityStore.ensureHomeWorkspace): their
// team's workspace when their email domain has one — for Position2 staff, the
// one Position2 workspace — and otherwise their personal workspace.
//
// There is no switch any more. It used to be a workspace_id cookie set by
// POST /api/workspaces/:id/activate, and that is how one afternoon's work on a
// client landed in two workspaces: tool runs followed the cookie while the
// project's own runs followed the project. Work on a project follows the
// project; this only decides what has nothing else to follow. A stale cookie
// from before the change is ignored and cleared at sign-out.
//
// Platform-embed sessions (shared iframe token, no individual user) resolve to
// one synthetic user + workspace instead — see ensurePlatformWorkspace.
//
// Resolution is cached per identity (short TTL) because it sits in front of
// every module: the steady state is zero extra queries per request.

const identityStore = require('./identityStore');
const { isDatabaseConfigured } = require('./db');

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

// Reached only by a session that carries no user id — a Google sign-in on a
// deployment with the database unconfigured. The shared-token embed that this
// was originally written for no longer exists.
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

async function resolveUserIdentity(userId, email) {
  const cached = cacheGet(userId);
  if (cached) return cached;

  return once(userId, async () => {
    try {
      const workspace = await identityStore.ensureHomeWorkspace(userId, email);
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
// resolves the identity requireAuth put on the request to
// { userId, workspaceId, actorEmail }.
async function resolveIdentity(req) {
  if (!isDatabaseConfigured()) return EMPTY;
  const userId = req.user?.userId;
  const email = req.user?.username;
  if (userId) return resolveUserIdentity(userId, email);
  if (req.user) return resolvePlatformIdentity();
  return EMPTY;
}

module.exports = { resolveIdentity, peekWorkspaceId, invalidate };
