// ── Platform administrators (PRD §7.3, AC-002) ──────────────────────────────
// Who can configure crawl/AI limits, provider availability, feature flags and
// platform operations. Two rules make this trustworthy, and both are enforced
// here rather than in the UI:
//
//   1. The grant lives in the database (platform_admin_grants), not in a
//      frontend constant and not in a JWT claim the browser could forge. The
//      client is *told* whether it is talking to an admin so it can show the
//      right nav; every mutating admin route re-checks the persisted grant
//      server-side (requirePlatformAdmin), so a patched frontend gains nothing.
//
//   2. The bootstrap identity is matched on the NORMALIZED authenticated email
//      — trim + lowercase — against an exact address. Not a domain, not a
//      prefix: "nikhil.ashok@position2.com.evil.com" and " Nikhil.Ashok@… "
//      resolve to different strings, and only the exact normalized match wins.
//
// The bootstrap grant may exist before that person has ever signed in (the
// migration seeds it with user_id NULL). It is linked to their app_users row at
// their first authenticated login, which is what makes this idempotent for an
// account that already exists.

const db = require('./db');
const auditEvents = require('./auditEvents');

// PRD §1 / §7.3: the initial platform administrator. Kept as a constant — not
// only an env var — so the documented behaviour holds on a fresh deploy with no
// configuration. PLATFORM_ADMIN_EMAILS adds further bootstrap addresses
// (comma-separated) without editing code; it never removes this one, and
// revoking is done through the grants table, not by changing config.
const INITIAL_PLATFORM_ADMIN = 'nikhil.ashok@position2.com';

/** Trim + lowercase. The single normalization used for storage and comparison. */
function normalizeEmail(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

/** The bootstrap addresses: the PRD's initial admin plus any env additions. */
function bootstrapEmails() {
  const extra = String(process.env.PLATFORM_ADMIN_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
  return [...new Set([normalizeEmail(INITIAL_PLATFORM_ADMIN), ...extra])];
}

/** True when this email is one of the configured bootstrap administrators. */
function isBootstrapAdminEmail(email) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized) && bootstrapEmails().includes(normalized);
}

// Admin status is read on the auth-verify path, so it is cached briefly. A
// revoke invalidates the entry immediately (revoke() calls invalidate), and the
// TTL bounds how long a grant made directly in the database takes to appear.
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // normalizedEmail → { value: boolean, expires: number }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { cache.delete(key); return undefined; }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

function invalidate(email) {
  if (email) cache.delete(normalizeEmail(email));
  else cache.clear();
}

function fail(op, error) {
  throw new Error(`[platformAdmin.${op}] ${error.message || error}`);
}

// ── Grant records ───────────────────────────────────────────────────────────

async function findActiveGrant(normalizedEmail) {
  try {
    return await db.maybeOne(
      `select * from platform_admin_grants
        where normalized_email = $1 and status = 'active'`,
      [normalizedEmail]
    );
  } catch (error) {
    fail('findActiveGrant', error);
  }
}

/**
 * Seeds the bootstrap grants. Idempotent — safe to call on every boot, and
 * safe alongside migration 0011, which seeds the same row. Never throws into
 * the boot path: a database that is briefly unreachable must not stop the
 * server from serving the modules that don't need it.
 *
 * @returns {Promise<{ seeded: string[], skipped: string[] }>}
 */
async function ensureBootstrapGrants() {
  const result = { seeded: [], skipped: [] };
  if (!db.isDatabaseConfigured()) return result;

  for (const email of bootstrapEmails()) {
    try {
      const existing = await findActiveGrant(email);
      if (existing) { result.skipped.push(email); continue; }

      try {
        await db.insertOne('platform_admin_grants', {
          normalized_email: email,
          grant_source: 'bootstrap',
          note: 'Bootstrap platform administrator (PRD §7.3).',
        }, { returning: false });
      } catch (error) {
        // A concurrent boot (two replicas) loses the unique index race; that is
        // the index doing its job, not an error worth reporting. 23505 is
        // Postgres's unique_violation.
        if (error.code !== '23505' && !/duplicate key|unique/i.test(error.message || '')) {
          fail('ensureBootstrapGrants', error);
        }
      }

      invalidate(email);
      result.seeded.push(email);
      await auditEvents.record({
        action: auditEvents.ACTIONS.PLATFORM_ADMIN_GRANTED,
        entityType: 'platform_admin_grant',
        entityId: email,
        actorEmail: 'system:bootstrap',
        newState: { normalizedEmail: email, grantSource: 'bootstrap' },
        source: 'server.boot',
      });
    } catch (e) {
      console.error('[platformAdmin.ensureBootstrapGrants]', e.message);
    }
  }
  return result;
}

/**
 * Links a signed-in user to their pending grant, if they have one. Called from
 * the Google callback: at that moment we know both the verified email and the
 * app_users row, which is the only point where the two can be tied together.
 *
 * Idempotent — an already-linked grant is left alone.
 */
async function linkGrantForUser({ userId, email }) {
  if (!db.isDatabaseConfigured() || !userId) return null;
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  try {
    const grant = await findActiveGrant(normalized);
    if (!grant) return null;
    if (grant.user_id === userId) return grant;

    const data = await db.one(
      `update platform_admin_grants set user_id = $1, linked_at = $2
        where id = $3 returning *`,
      [userId, new Date().toISOString(), grant.id]
    );

    invalidate(normalized);
    await auditEvents.record({
      action: auditEvents.ACTIONS.PLATFORM_ADMIN_LINKED,
      entityType: 'platform_admin_grant',
      entityId: data.id,
      actorUserId: userId,
      actorEmail: normalized,
      oldState: { userId: grant.user_id },
      newState: { userId },
      source: 'auth.google.callback',
    });
    return data;
  } catch (e) {
    console.error('[platformAdmin.linkGrantForUser]', e.message);
    return null;
  }
}

/**
 * The authorization question: is this identity a platform administrator?
 * Answered from the persisted grant, matched on the normalized email.
 */
async function isPlatformAdmin({ email, userId } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  if (!db.isDatabaseConfigured()) {
    // No database means no grants table to consult. Falling back to the
    // bootstrap constant here would be a frontend-style hardcode with extra
    // steps; refusing is the safe answer, and the admin UI says why.
    return false;
  }

  const cached = cacheGet(normalized);
  if (cached !== undefined) return cached;

  try {
    const grant = await findActiveGrant(normalized);
    // A grant linked to a different user id is not this caller's grant, even
    // with a matching email — that would mean two app_users rows share an
    // address, which the unique index on app_users.email prevents, so treat it
    // as a mismatch rather than trusting the email alone.
    const ok = Boolean(grant) && (!grant.user_id || !userId || grant.user_id === userId);
    cacheSet(normalized, ok);
    return ok;
  } catch (e) {
    console.error('[platformAdmin.isPlatformAdmin]', e.message);
    return false;
  }
}

/** Express guard for the platform-admin routes (PRD §7.2, last row). */
function requirePlatformAdmin(req, res, next) {
  isPlatformAdmin({ email: req.user?.username, userId: req.user?.userId })
    .then((ok) => {
      if (!ok) {
        return res.status(403).json({
          error: 'Platform administrator access is required for this action.',
        });
      }
      req.isPlatformAdmin = true;
      next();
    })
    .catch((e) => {
      console.error('[platformAdmin.requirePlatformAdmin]', e.message);
      res.status(500).json({ error: 'Could not verify platform administrator access.' });
    });
}

// ── Admin UI operations ─────────────────────────────────────────────────────

async function listGrants({ includeRevoked = false } = {}) {
  if (!db.isDatabaseConfigured()) return [];
  const where = includeRevoked ? '' : `where status = 'active'`;
  try {
    return await db.rows(
      `select id, normalized_email, user_id, status, grant_source,
              granted_at, linked_at, revoked_at, note
         from platform_admin_grants
         ${where}
        order by granted_at desc`
    );
  } catch (error) {
    fail('listGrants', error);
  }
}

/**
 * Grants platform-admin to an email. The grant is created whether or not that
 * person has signed in yet; linkGrantForUser fills in user_id when they do.
 */
async function grantAdmin({ email, actorUserId, actorEmail, note }) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) {
    throw Object.assign(new Error('A valid email address is required.'), { status: 400 });
  }

  const existing = await findActiveGrant(normalized);
  if (existing) return existing; // idempotent

  // If they already have an app_users row, link it immediately.
  let user = null;
  try {
    user = await db.maybeOne(`select id from app_users where email = $1`, [normalized]);
  } catch {
    // Matching the previous behaviour: a failed lookup here just means the
    // grant is created unlinked, and the next login links it.
  }

  let data;
  try {
    data = await db.insertOne('platform_admin_grants', {
      normalized_email: normalized,
      user_id: user?.id || null,
      linked_at: user?.id ? new Date().toISOString() : null,
      grant_source: 'admin_ui',
      granted_by: actorUserId || null,
      note: note || null,
    });
  } catch (error) {
    fail('grantAdmin', error);
  }

  invalidate(normalized);
  await auditEvents.record({
    action: auditEvents.ACTIONS.PLATFORM_ADMIN_GRANTED,
    entityType: 'platform_admin_grant',
    entityId: data.id,
    actorUserId, actorEmail,
    newState: { normalizedEmail: normalized, grantSource: 'admin_ui', note: note || null },
    source: 'admin.ui',
  }, { strict: true });

  return data;
}

/**
 * Revokes a grant. The row is kept and marked revoked — the record of who had
 * admin, and when, is part of the audit trail (PRD §22.10).
 *
 * The last active grant cannot be revoked: an installation with no platform
 * administrator can never configure limits again without direct database
 * access, which is a lockout, not a permission decision.
 */
async function revokeAdmin({ grantId, actorUserId, actorEmail, reason }) {
  // Read, count and write in one transaction, locking the active grants while
  // the count is taken. Over three independent requests — which is all
  // PostgREST could do — two concurrent revokes could each see two active
  // grants and each proceed, revoking both and locking the installation out of
  // its own limits configuration. That is the exact outcome the guard below
  // exists to prevent, so it has to be atomic.
  let grant;
  let data;
  try {
    ({ grant, data } = await db.tx(async (t) => {
      const found = await t.maybeOne(
        `select * from platform_admin_grants where id = $1`, [grantId]);
      if (!found) throw Object.assign(new Error('Grant not found.'), { status: 404 });
      if (found.status === 'revoked') return { grant: found, data: found };

      const active = await t.value(
        `select count(*) from platform_admin_grants where status = 'active' for update`);
      if (Number(active || 0) <= 1) {
        throw Object.assign(
          new Error('This is the last platform administrator — grant another one before revoking this.'),
          { status: 400 },
        );
      }

      const updated = await t.one(
        `update platform_admin_grants
            set status = 'revoked', revoked_at = $1, revoked_by = $2
          where id = $3 returning *`,
        [new Date().toISOString(), actorUserId || null, grantId]
      );
      return { grant: found, data: updated };
    }));
  } catch (error) {
    if (error.status) throw error;
    fail('revokeAdmin', error);
  }

  if (data.status === 'revoked' && grant.status === 'revoked') return grant;

  invalidate(grant.normalized_email);
  await auditEvents.record({
    action: auditEvents.ACTIONS.PLATFORM_ADMIN_REVOKED,
    entityType: 'platform_admin_grant',
    entityId: grantId,
    actorUserId, actorEmail,
    reason: reason || null,
    oldState: { status: 'active', normalizedEmail: grant.normalized_email },
    newState: { status: 'revoked' },
    source: 'admin.ui',
  }, { strict: true });

  return data;
}

module.exports = {
  INITIAL_PLATFORM_ADMIN,
  normalizeEmail,
  bootstrapEmails,
  isBootstrapAdminEmail,
  ensureBootstrapGrants,
  linkGrantForUser,
  isPlatformAdmin,
  requirePlatformAdmin,
  listGrants,
  grantAdmin,
  revokeAdmin,
  invalidate,
};
