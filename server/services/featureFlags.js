// ── Feature flags (PRD §3.1.14, §24.3, AC-063) ──────────────────────────────
// "Rollout is feature-flagged for internal users and a small pilot group before
// general availability", and "the internal/pilot feature flag can enable the
// unified project workflow without enabling it globally" (§31.4).
//
// Resolution is most-specific-wins — user → project → workspace → global — and
// the default for an unknown flag is OFF. That direction matters: a flag that
// defaults on would make a failed lookup (database blip, typo in a key) look
// like a launch.
//
// An assignment can also explicitly disable at a narrower scope, which is how a
// single workspace is held back from an otherwise-global rollout.

const db = require('./db');
const auditEvents = require('./auditEvents');

// The flags this codebase reads. Declared so a typo at a call site fails a test
// rather than silently resolving to off forever.
const FLAGS = {
  UNIFIED_PROJECT_WORKSPACE: 'unified_project_workspace',
};

const SCOPES = ['global', 'workspace', 'project', 'user'];
// Highest number wins.
const SCOPE_RANK = { global: 0, workspace: 1, project: 2, user: 3 };

// Flags are read on nav-rendering paths, so assignments are cached per flag key
// for a short window. Writes invalidate immediately.
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // flagKey → { rows, expires }

function invalidate(flagKey) {
  if (flagKey) cache.delete(flagKey);
  else cache.clear();
}

function fail(op, error) {
  throw new Error(`[featureFlags.${op}] ${error.message || error}`);
}

async function assignmentsFor(flagKey) {
  const hit = cache.get(flagKey);
  if (hit && hit.expires > Date.now()) return hit.rows;

  let rows;
  try {
    rows = await db.rows(
      `select scope, scope_ref, enabled from feature_flag_assignments where flag_key = $1`,
      [flagKey]
    );
  } catch (error) {
    fail('assignmentsFor', error);
  }

  cache.set(flagKey, { rows, expires: Date.now() + CACHE_TTL_MS });
  return rows;
}

/**
 * Is a flag on for this context?
 *
 * @param {string} flagKey
 * @param {object} [context]
 * @param {string} [context.workspaceId]
 * @param {string} [context.projectId]
 * @param {string} [context.userId]
 * @returns {Promise<boolean>}
 */
async function isEnabled(flagKey, { workspaceId = null, projectId = null, userId = null } = {}) {
  if (!flagKey || !db.isDatabaseConfigured()) return false;

  try {
    const rows = await assignmentsFor(flagKey);
    if (!rows.length) return false;

    const refFor = { global: null, workspace: workspaceId, project: projectId, user: userId };

    let winner = null;
    for (const row of rows) {
      const expected = refFor[row.scope];
      // A workspace-scoped row for a different workspace is not about us.
      if (row.scope !== 'global' && (!expected || expected !== row.scope_ref)) continue;
      if (!winner || SCOPE_RANK[row.scope] > SCOPE_RANK[winner.scope]) winner = row;
    }

    return Boolean(winner?.enabled);
  } catch (e) {
    console.error('[featureFlags.isEnabled]', e.message);
    return false;
  }
}

/**
 * Resolves several flags at once for one context — what the client bootstrap
 * endpoint sends down, so the UI makes one call rather than one per flag.
 */
async function resolveAll(context) {
  const keys = Object.values(FLAGS);
  const values = await Promise.all(keys.map((key) => isEnabled(key, context)));
  return Object.fromEntries(keys.map((key, i) => [key, values[i]]));
}

async function listAssignments({ flagKey = null } = {}) {
  if (!db.isDatabaseConfigured()) return [];
  const params = [];
  let where = '';
  if (flagKey) {
    params.push(flagKey);
    where = `where flag_key = $${params.length}`;
  }
  try {
    return await db.rows(
      `select * from feature_flag_assignments ${where} order by flag_key asc, scope asc`,
      params
    );
  } catch (error) {
    fail('listAssignments', error);
  }
}

/**
 * Creates or updates one assignment. Platform-admin only (see routes/admin.js);
 * every change is audited, because "which workspaces had the new experience on,
 * and when" is exactly the question a pilot post-mortem asks.
 */
async function setAssignment({ flagKey, scope, scopeRef = null, enabled, note, actorUserId, actorEmail }) {
  if (!db.isDatabaseConfigured()) {
    throw Object.assign(new Error('Feature flags need the database configured.'), { status: 503 });
  }
  if (!flagKey) throw Object.assign(new Error('flagKey is required.'), { status: 400 });
  if (!SCOPES.includes(scope)) {
    throw Object.assign(new Error(`scope must be one of: ${SCOPES.join(', ')}.`), { status: 400 });
  }
  if (scope === 'global' && scopeRef) {
    throw Object.assign(new Error('global assignments do not take a scopeRef.'), { status: 400 });
  }
  if (scope !== 'global' && !scopeRef) {
    throw Object.assign(new Error(`${scope} assignments need a scopeRef.`), { status: 400 });
  }

  // "one assignment" is (flag_key, scope, scope_ref) with SQL NULL semantics on
  // scope_ref, so a global row matches on `is null` rather than `=`.
  let existing;
  try {
    existing = await db.maybeOne(
      `select * from feature_flag_assignments
        where flag_key = $1 and scope = $2
          and scope_ref is not distinct from $3`,
      [flagKey, scope, scopeRef]
    );
  } catch (error) {
    fail('setAssignment(find)', error);
  }

  let row;
  if (existing) {
    try {
      row = await db.one(
        `update feature_flag_assignments set enabled = $1, note = $2
          where id = $3 returning *`,
        [Boolean(enabled), note ?? existing.note, existing.id]
      );
    } catch (error) {
      fail('setAssignment(update)', error);
    }
  } else {
    try {
      row = await db.insertOne('feature_flag_assignments', {
        flag_key: flagKey,
        scope,
        scope_ref: scopeRef,
        enabled: Boolean(enabled),
        note: note || null,
        created_by: actorUserId || null,
      });
    } catch (error) {
      fail('setAssignment(insert)', error);
    }
  }

  invalidate(flagKey);
  await auditEvents.record({
    action: auditEvents.ACTIONS.FEATURE_FLAG_CHANGED,
    entityType: 'feature_flag_assignment',
    entityId: row.id,
    workspaceId: scope === 'workspace' ? scopeRef : null,
    projectId: scope === 'project' ? scopeRef : null,
    actorUserId,
    actorEmail,
    oldState: existing ? { enabled: existing.enabled } : null,
    newState: { flagKey, scope, scopeRef, enabled: Boolean(enabled) },
    source: 'admin.featureFlags',
  }, { strict: true });

  return row;
}

module.exports = { FLAGS, SCOPES, isEnabled, resolveAll, listAssignments, setAssignment, invalidate };
