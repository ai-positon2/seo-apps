// ── Immutable audit log (PRD §17.1, §22.10) ─────────────────────────────────
// One append-only trail for sensitive mutations: role grants, robots overrides,
// score/finding overrides, shipped-date corrections, deletion requests, limit
// versions. The table has a trigger that rejects UPDATE and DELETE, so a
// recorded event is permanent by construction, not by convention.
//
// Writes are fire-and-forget by default: an audit failure must not fail the
// action the user asked for (the alternative — a request that half-succeeded
// and then 500'd — is strictly worse). Callers that genuinely need the write to
// land before they answer (a grant, a robots override) pass { strict: true }.

const { getSupabase, isSupabaseConfigured } = require('./supabase');

// Actions are a closed vocabulary so the log can be filtered and reported on.
// Add here rather than passing an ad-hoc string at the call site.
const ACTIONS = {
  PLATFORM_ADMIN_GRANTED:  'platform_admin.granted',
  PLATFORM_ADMIN_LINKED:   'platform_admin.linked',
  PLATFORM_ADMIN_REVOKED:  'platform_admin.revoked',
  PROJECT_CREATED:         'project.created',
  PROJECT_UPDATED:         'project.updated',
  PROJECT_DELETED:         'project.deleted',
  PROJECT_RESTORED:        'project.restored',
  // The one project action with nothing behind it: PROJECT_DELETED is a status
  // flip a restore undoes, PROJECT_PURGED is the row and its whole cascade gone.
  // Written with { strict: true } — see store.purgeProject.
  PROJECT_PURGED:          'project.purged',
  PROJECT_VERIFIED:        'project.verified',
  ROBOTS_OVERRIDE_SET:     'project.robots_override_set',
  DOMAIN_ADDED:            'project_domain.added',
  DOMAIN_REMOVED:          'project_domain.removed',
  DOMAIN_PRIMARY_CHANGED:  'project_domain.primary_changed',
  LIMITS_VERSION_CREATED:  'admin_limits.version_created',
  FEATURE_FLAG_CHANGED:    'feature_flag.changed',
  WORKSPACE_ROLE_CHANGED:  'workspace.role_changed',
  // Phase 3: a module executed against a project (migration 0012). Deliberately
  // not constrained in SQL — see that migration's section 3 for why a DB-side
  // list would turn a vocabulary drift into a silent audit gap.
  // Phase B1: the page inventory (migration 0015). Same reasoning as above —
  // no SQL CHECK, because a DB-side vocabulary drifting behind the code would
  // stop the trail recording while every action kept succeeding.
  PAGES_SYNCED:            'project_pages.synced',
  PAGE_EXCLUDED:           'project_page.excluded',
  PAGE_INCLUDED:           'project_page.included',
  MODULE_RUN_STARTED:      'project_module.run_started',
  MODULE_RUN_COMPLETED:    'project_module.run_completed',
  MODULE_RUN_FAILED:       'project_module.run_failed',
  // Phase 2: workspace lifecycle. These three are the record that a countdown to
  // permanent deletion started, was cancelled, or ran out — the one part of the
  // trail written with { strict: true }, because losing it means losing the only
  // evidence of why a team's data disappeared.
  WORKSPACE_DELETION_REQUESTED: 'workspace.deletion_requested',
  WORKSPACE_RESTORED:           'workspace.restored',
  WORKSPACE_PURGED:             'workspace.purged',
  // Phase 6: recommendations. Approval, rejection and shipping are written with
  // { strict: true } — they are decisions a person is accountable for, and a
  // silently dropped audit row would leave nobody answerable.
  RECOMMENDATION_CREATED:  'recommendation.created',
  RECOMMENDATION_UPDATED:  'recommendation.updated',
  RECOMMENDATION_APPROVED: 'recommendation.approved',
  RECOMMENDATION_REJECTED: 'recommendation.rejected',
  RECOMMENDATION_SHIPPED:  'recommendation.shipped',
  // AI Visibility prompt review. Generated is fire-and-forget like most of this
  // log; approved/rejected are written with { strict: true } — same reasoning
  // as recommendations above, applied to money: approving a prompt is what
  // releases spend on measuring it, and a silently dropped audit row would
  // leave nobody answerable for that spend.
  AI_VISIBILITY_PROMPT_GENERATED: 'ai_visibility_prompt.generated',
  AI_VISIBILITY_PROMPT_APPROVED:  'ai_visibility_prompt.approved',
  AI_VISIBILITY_PROMPT_REJECTED:  'ai_visibility_prompt.rejected',
  AI_VISIBILITY_PROMPT_EDITED:    'ai_visibility_prompt.edited',
  AI_VISIBILITY_PROMPT_RETIRED:   'ai_visibility_prompt.retired',
  AI_VISIBILITY_PROMPT_RESTORED:  'ai_visibility_prompt.restored',
};

// Keeps a stray page of HTML or a whole crawl summary out of the audit trail —
// this table is a record of decisions, not an evidence store.
const MAX_STATE_CHARS = 8000;

function trimState(value) {
  if (value === undefined || value === null) return null;
  try {
    const json = JSON.stringify(value);
    if (json.length <= MAX_STATE_CHARS) return value;
    return { _truncated: true, chars: json.length, preview: json.slice(0, 500) };
  } catch {
    return { _unserializable: true };
  }
}

/**
 * Records one audit event.
 *
 * @param {object}  event
 * @param {string} [event.workspaceId]
 * @param {string} [event.projectId]
 * @param {string} [event.actorUserId]
 * @param {string} [event.actorEmail]
 * @param {string} [event.actorRole]   role the actor held when they acted
 * @param {string}  event.action       one of ACTIONS
 * @param {string} [event.entityType]
 * @param {string} [event.entityId]
 * @param {string} [event.reason]      required by callers that mandate a reason
 * @param {*}      [event.oldState]
 * @param {*}      [event.newState]
 * @param {string} [event.source]      screen or subsystem that triggered it
 * @param {string} [event.requestId]
 * @param {object} [opts]
 * @param {boolean}[opts.strict]       throw instead of swallowing a write error
 * @returns {Promise<boolean>} whether the event was persisted
 */
async function record(event, { strict = false } = {}) {
  if (!event || !event.action) {
    if (strict) throw new Error('[auditEvents.record] action is required.');
    return false;
  }
  if (!isSupabaseConfigured()) {
    if (strict) throw new Error('[auditEvents.record] Supabase is not configured.');
    return false;
  }

  const row = {
    workspace_id:  event.workspaceId  || null,
    project_id:    event.projectId    || null,
    actor_user_id: event.actorUserId  || null,
    actor_email:   event.actorEmail   || null,
    actor_role:    event.actorRole    || null,
    action:        event.action,
    entity_type:   event.entityType   || null,
    entity_id:     event.entityId != null ? String(event.entityId) : null,
    reason:        event.reason       || null,
    old_state:     trimState(event.oldState),
    new_state:     trimState(event.newState),
    source:        event.source       || null,
    request_id:    event.requestId    || null,
  };

  try {
    const { error } = await getSupabase().from('audit_events').insert(row);
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    if (strict) throw new Error(`[auditEvents.record] ${e.message}`);
    console.error('[auditEvents.record]', e.message);
    return false;
  }
}

// Convenience wrapper for route handlers: pulls the actor off the request so
// call sites don't repeat it. `req.user` is set by requireAuth.
function recordFor(req, event, opts) {
  return record({
    actorUserId: req.user?.userId,
    actorEmail:  req.user?.username,
    ...event,
  }, opts);
}

/**
 * Reads the audit trail for one workspace, newest first. Platform-admin and
 * workspace-admin surfaces only — the caller is responsible for authorization.
 */
async function listForWorkspace(workspaceId, { limit = 100, action = null, projectId = null } = {}) {
  if (!isSupabaseConfigured() || !workspaceId) return [];
  let query = getSupabase()
    .from('audit_events')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));

  if (action) query = query.eq('action', action);
  if (projectId) query = query.eq('project_id', projectId);

  const { data, error } = await query;
  if (error) throw new Error(`[auditEvents.listForWorkspace] ${error.message}`);
  return data || [];
}

module.exports = { ACTIONS, record, recordFor, listForWorkspace };
