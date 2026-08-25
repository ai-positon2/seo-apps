// ── Workspace lifecycle (PRD phase 2, §3.3.4) ────────────────────────────────
//
// Deleting a workspace is a request, not an act. It moves to 'pending_deletion'
// with a purge date `workspacePurgeGraceDays` in the future, stays fully
// restorable until then, and only afterwards is its data destroyed.
//
// Why a grace period at all: a workspace holds every project, crawl and audit a
// team has produced. An accidental click, a departing employee, or a
// misunderstanding about which workspace was which are all recoverable for as
// long as the window lasts, and permanently not recoverable a moment later. The
// window length is an administrator limit, versioned like every other one, so
// "how long do we keep deleted data" has a dated answer.
//
// What purging does NOT do: delete anything outside the workspace. Rows that
// merely reference it (audit events, tool runs from members) keep their
// reference — the audit trail is append-only by design, and erasing the history
// of a workspace's deletion along with the workspace would defeat the point.

const { getSupabase, isSupabaseConfigured } = require('../services/supabase');
const auditEvents = require('./auditEvents');
const adminLimits = require('./adminLimits');

const STATUSES = ['active', 'pending_deletion', 'purged'];

function fail(where, error) {
  throw new Error(`[workspaceLifecycle.${where}] ${error.message || error}`);
}

function notConfigured() {
  return Object.assign(
    new Error('Workspace lifecycle needs Supabase configured.'),
    { status: 503, code: 'not_configured' },
  );
}

/**
 * Requests deletion of a workspace.
 *
 * Requires the 'requestWorkspaceDeletion' capability, which §7.2 grants to admin
 * and owner but NOT to a platform administrator — a platform admin can see
 * everything, and letting them also destroy a customer's workspace on a whim is
 * a different kind of power. They can restore, which is the safe direction.
 */
async function requestDeletion({ access, reason }) {
  if (!isSupabaseConfigured()) throw notConfigured();
  if (!reason || !String(reason).trim()) {
    throw Object.assign(
      new Error('A reason is required — this is recorded and starts a countdown to permanent deletion.'),
      { status: 400 },
    );
  }

  const { limits } = await adminLimits.effectiveLimits({ workspaceId: access.workspaceId });
  const graceDays = Number(limits.workspacePurgeGraceDays) || 30;
  const purgeAfter = new Date(Date.now() + graceDays * 86_400_000).toISOString();

  const { data, error } = await getSupabase()
    .from('workspaces')
    .update({
      lifecycle_status: 'pending_deletion',
      deletion_requested_at: new Date().toISOString(),
      deletion_requested_by: access.userId || null,
      purge_after: purgeAfter,
    })
    .eq('id', access.workspaceId)
    .eq('lifecycle_status', 'active')   // never re-arm an already-pending purge
    .select('*')
    .maybeSingle();
  if (error) fail('requestDeletion', error);
  if (!data) {
    throw Object.assign(
      new Error('That workspace is not active, so deletion cannot be requested for it.'),
      { status: 409 },
    );
  }

  // strict: this is the record that a countdown to permanent deletion started.
  // If it cannot be written, the caller needs to know before the clock runs.
  await auditEvents.record({
    workspaceId: access.workspaceId,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    action: auditEvents.ACTIONS.WORKSPACE_DELETION_REQUESTED,
    entityType: 'workspace',
    entityId: access.workspaceId,
    reason: String(reason).trim(),
    newState: { purgeAfter, graceDays },
  }, { strict: true });

  return { workspace: data, purgeAfter, graceDays };
}

/** Cancels a pending deletion. Safe direction, so platform admins may do it too. */
async function restore({ access }) {
  if (!isSupabaseConfigured()) throw notConfigured();

  const { data, error } = await getSupabase()
    .from('workspaces')
    .update({
      lifecycle_status: 'active',
      deletion_requested_at: null,
      deletion_requested_by: null,
      purge_after: null,
      restored_at: new Date().toISOString(),
      restored_by: access.userId || null,
    })
    .eq('id', access.workspaceId)
    .eq('lifecycle_status', 'pending_deletion')
    .select('*')
    .maybeSingle();
  if (error) fail('restore', error);
  if (!data) {
    throw Object.assign(
      new Error('That workspace is not pending deletion. A purged workspace cannot be restored.'),
      { status: 409 },
    );
  }

  await auditEvents.record({
    workspaceId: access.workspaceId,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    action: auditEvents.ACTIONS.WORKSPACE_RESTORED,
    entityType: 'workspace',
    entityId: access.workspaceId,
  }, { strict: true });

  return { workspace: data };
}

/** Workspaces whose grace period has expired. */
async function duePurge({ now = new Date() } = {}) {
  if (!isSupabaseConfigured()) return [];
  const { data, error } = await getSupabase()
    .from('workspaces')
    .select('id, name, purge_after, deletion_requested_at, deletion_requested_by')
    .eq('lifecycle_status', 'pending_deletion')
    .lt('purge_after', now.toISOString())
    .order('purge_after', { ascending: true });
  if (error) fail('duePurge', error);
  return data || [];
}

// Deleted in dependency order — children before the rows they reference — so a
// foreign key never blocks a purge halfway through and leaves a workspace in a
// state that is neither present nor gone.
//
// crawl_run_results / findings / links cascade from crawl_runs, and
// project_module_runs cascades from crawl_projects, so those are not listed:
// letting the database do it is both faster and impossible to get out of order.
const PURGE_ORDER = [
  { table: 'crawl_runs', column: 'workspace_id' },
  { table: 'crawl_projects', column: 'workspace_id' },
  { table: 'tool_runs', column: 'workspace_id' },
  { table: 'workspace_members', column: 'workspace_id' },
];

/**
 * Permanently destroys one workspace's data.
 *
 * The workspace ROW survives, marked 'purged'. A hard delete would break every
 * audit_events row referencing it and erase the fact that it ever existed —
 * which is precisely what a compliance question about deleted data needs to see.
 */
async function purge({ workspaceId, actorEmail = 'system:purge-cron' }) {
  if (!isSupabaseConfigured()) throw notConfigured();
  const db = getSupabase();

  // Re-check under the same condition the sweeper selected on. Between selection
  // and here, somebody may have restored it — purging then would destroy a
  // workspace an administrator just rescued.
  const { data: current, error: readError } = await db
    .from('workspaces')
    .select('id, name, lifecycle_status, purge_after')
    .eq('id', workspaceId)
    .maybeSingle();
  if (readError) fail('purge.read', readError);
  if (!current) return { purged: false, reason: 'not_found' };
  if (current.lifecycle_status !== 'pending_deletion') {
    return { purged: false, reason: `lifecycle_status is ${current.lifecycle_status}` };
  }
  if (!current.purge_after || new Date(current.purge_after) > new Date()) {
    return { purged: false, reason: 'grace period has not expired' };
  }

  const deleted = {};
  for (const { table, column } of PURGE_ORDER) {
    const { data, error } = await db.from(table).delete().eq(column, workspaceId).select('id');
    if (error) fail(`purge.${table}`, error);
    deleted[table] = (data || []).length;
  }

  const { error: markError } = await db
    .from('workspaces')
    .update({
      lifecycle_status: 'purged',
      purged_at: new Date().toISOString(),
      purge_after: null,
    })
    .eq('id', workspaceId);
  if (markError) fail('purge.mark', markError);

  await auditEvents.record({
    workspaceId,
    actorEmail,
    action: auditEvents.ACTIONS.WORKSPACE_PURGED,
    entityType: 'workspace',
    entityId: workspaceId,
    reason: 'Grace period expired',
    newState: { deleted },
  }, { strict: true });

  console.log(`[workspaceLifecycle] purged ${current.name} (${workspaceId}):`, JSON.stringify(deleted));
  return { purged: true, deleted };
}

/**
 * One sweep. Returns what it did, so the scheduler can log a real number rather
 * than "ran".
 *
 * One workspace failing does not stop the rest: a foreign key that blocks one
 * purge must not indefinitely postpone every other one.
 */
async function sweep() {
  const due = await duePurge();
  if (!due.length) return { due: 0, purged: 0, skipped: 0, failed: 0 };

  let purged = 0;
  let skipped = 0;
  let failedCount = 0;
  for (const workspace of due) {
    try {
      const result = await purge({ workspaceId: workspace.id });
      if (result.purged) purged += 1;
      else skipped += 1;
    } catch (e) {
      failedCount += 1;
      console.error(`[workspaceLifecycle] purge failed for ${workspace.id}:`, e.message);
    }
  }
  return { due: due.length, purged, skipped, failed: failedCount };
}

module.exports = {
  STATUSES,
  PURGE_ORDER,
  requestDeletion,
  restore,
  duePurge,
  purge,
  sweep,
};
