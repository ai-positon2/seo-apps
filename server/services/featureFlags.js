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

const { getSupabase, isSupabaseConfigured } = require('./supabase');
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

  const { data, error } = await getSupabase()
    .from('feature_flag_assignments')
    .select('scope, scope_ref, enabled')
    .eq('flag_key', flagKey);
  if (error) fail('assignmentsFor', error);

  const rows = data || [];
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
  if (!flagKey || !isSupabaseConfigured()) return false;

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
  if (!isSupabaseConfigured()) return [];
  let query = getSupabase()
    .from('feature_flag_assignments')
    .select('*')
    .order('flag_key', { ascending: true })
    .order('scope', { ascending: true });
  if (flagKey) query = query.eq('flag_key', flagKey);

  const { data, error } = await query;
  if (error) fail('listAssignments', error);
  return data || [];
}

/**
 * Creates or updates one assignment. Platform-admin only (see routes/admin.js);
 * every change is audited, because "which workspaces had the new experience on,
 * and when" is exactly the question a pilot post-mortem asks.
 */
async function setAssignment({ flagKey, scope, scopeRef = null, enabled, note, actorUserId, actorEmail }) {
  if (!isSupabaseConfigured()) {
    throw Object.assign(new Error('Feature flags need Supabase configured.'), { status: 503 });
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

  const sb = getSupabase();
  let query = sb.from('feature_flag_assignments').select('*').eq('flag_key', flagKey).eq('scope', scope);
  query = scopeRef === null ? query.is('scope_ref', null) : query.eq('scope_ref', scopeRef);
  const { data: existing, error: findErr } = await query.maybeSingle();
  if (findErr) fail('setAssignment(find)', findErr);

  const payload = {
    flag_key: flagKey,
    scope,
    scope_ref: scopeRef,
    enabled: Boolean(enabled),
    note: note || null,
    created_by: actorUserId || null,
  };

  let row;
  if (existing) {
    const { data, error } = await sb
      .from('feature_flag_assignments')
      .update({ enabled: Boolean(enabled), note: note ?? existing.note })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) fail('setAssignment(update)', error);
    row = data;
  } else {
    const { data, error } = await sb
      .from('feature_flag_assignments').insert(payload).select('*').single();
    if (error) fail('setAssignment(insert)', error);
    row = data;
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
