// ── Recommendations and approval (PRD phase 6) ────────────────────────────────
//
// A finding is an observation. A recommendation is advice somebody is
// accountable for. This service owns the transition between them and the
// lifecycle that follows:
//
//   draft ──▶ proposed ──▶ approved ──▶ shipped
//                   └────▶ rejected
//
// The transition table below is the whole authorization story, and it is data
// rather than a chain of ifs so it can be read and tested as one thing.
//
// Two rules that are easy to erode and expensive to lose:
//
//   1. Approval names a person. A machine may propose; only a role holding
//      'approveRecommendation' may approve, and the approver is recorded. The DB
//      backs this up with a NOT NULL check, so no code path can quietly become
//      the approver.
//
//   2. A material edit to an approved recommendation revokes the approval. The
//      alternative is an approval that silently covers text nobody approved,
//      which is worse than requiring a second click.

const { getSupabase, isSupabaseConfigured } = require('../../services/supabase');
const auditEvents = require('../../services/auditEvents');

const STATUSES = ['draft', 'proposed', 'approved', 'rejected', 'shipped'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// from -> { to: capability required }
//
// 'reopen' back to proposed is allowed from rejected, because a rejection is
// often "not now" rather than "never". Going back from shipped is not: the
// change is live, and pretending otherwise loses the only record that it shipped.
const TRANSITIONS = {
  draft:     { proposed: 'editRecommendation' },
  proposed:  { approved: 'approveRecommendation', rejected: 'approveRecommendation', draft: 'editRecommendation' },
  approved:  { shipped: 'recordShippedDate', proposed: 'approveRecommendation' },
  rejected:  { proposed: 'editRecommendation' },
  shipped:   {},
};

// Fields whose change invalidates an existing approval. Priority and effort are
// deliberately absent: re-ordering the queue is not a change to the advice.
const MATERIAL_FIELDS = ['title', 'body'];

function invalid(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function fail(where, error) {
  throw new Error(`[recommendations.${where}] ${error.message || error}`);
}

function notConfigured() {
  return Object.assign(
    new Error('Recommendations need Supabase configured.'),
    { status: 503, code: 'not_configured' },
  );
}

/**
 * Whether `next` is reachable from `current`, and what capability it needs.
 * Pure, so the rules are testable without a database or a session.
 */
function transitionFor(current, next) {
  const allowed = TRANSITIONS[current];
  if (!allowed) return { ok: false, reason: `Unknown status: ${current}.` };
  const capability = allowed[next];
  if (!capability) {
    const options = Object.keys(allowed);
    return {
      ok: false,
      reason: options.length
        ? `A ${current} recommendation can only move to: ${options.join(', ')}.`
        : `A ${current} recommendation is final and cannot change status.`,
    };
  }
  return { ok: true, capability };
}

/** Does this patch change the advice itself, as opposed to its ordering? */
function isMaterialChange(existing, patch) {
  return MATERIAL_FIELDS.some(
    (field) => patch[field] !== undefined && String(patch[field]) !== String(existing[field] ?? ''),
  );
}

function view(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    moduleKey: row.module_key,
    sourceRunId: row.source_run_id,
    ruleId: row.rule_id,
    title: row.title,
    body: row.body,
    priority: row.priority,
    effort: row.effort,
    status: row.status,
    proposedAt: row.proposed_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
    shippedAt: row.shipped_at,
    evidence: row.evidence || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function audit(access, action, extra) {
  auditEvents.record({
    workspaceId: access.workspaceId || access.project?.workspace_id || null,
    projectId: access.project?.id || null,
    actorUserId: access.userId || null,
    actorEmail: access.actorEmail || null,
    actorRole: access.role || null,
    action,
    source: 'projects.recommendations',
    ...extra,
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function list(projectId, { status = null, limit = 200 } = {}) {
  if (!isSupabaseConfigured()) return [];
  let query = getSupabase()
    .from('recommendations')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit) || 200, 500));
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) fail('list', error);
  return (data || []).map(view);
}

async function get(projectId, id) {
  if (!isSupabaseConfigured()) return null;
  const { data, error } = await getSupabase()
    .from('recommendations')
    .select('*')
    .eq('project_id', projectId)   // scoped, not just by id — no RLS behind this
    .eq('id', id)
    .maybeSingle();
  if (error) fail('get', error);
  return data || null;
}

/** Counts by status, for a board header that does not have to fetch everything. */
async function summary(projectId) {
  const rows = await list(projectId, { limit: 500 });
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  return { counts, total: rows.length };
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Creates a recommendation, in 'draft' unless proposed immediately.
 *
 * `evidence` is snapshotted here rather than joined later: the next crawl
 * changes the live findings, and advice has to stay interpretable against what
 * was true when it was given.
 */
async function create({ access, title, body, priority = 'medium', effort = null,
  moduleKey = null, sourceRunId = null, ruleId = null, evidence = {}, propose = false }) {
  if (!isSupabaseConfigured()) throw notConfigured();

  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw invalid('A recommendation needs a title.', 'title_required');
  if (!PRIORITIES.includes(priority)) {
    throw invalid(`priority must be one of: ${PRIORITIES.join(', ')}.`, 'bad_priority');
  }

  const now = new Date().toISOString();
  const { data, error } = await getSupabase()
    .from('recommendations')
    .insert({
      project_id: access.project.id,
      workspace_id: access.project.workspace_id || null,
      module_key: moduleKey,
      source_run_id: sourceRunId,
      rule_id: ruleId,
      title: cleanTitle,
      body: body ? String(body) : null,
      priority,
      effort,
      status: propose ? 'proposed' : 'draft',
      proposed_by: propose ? access.userId || null : null,
      proposed_at: propose ? now : null,
      evidence: evidence || {},
      created_by: access.userId || null,
    })
    .select('*')
    .single();
  if (error) fail('create', error);

  audit(access, auditEvents.ACTIONS.RECOMMENDATION_CREATED, {
    entityType: 'recommendation',
    entityId: data.id,
    newState: { title: cleanTitle, status: data.status, priority, moduleKey },
  });

  return view(data);
}

/**
 * Edits the text or ordering of a recommendation.
 *
 * A material change to an APPROVED recommendation sends it back to 'proposed'
 * and clears the approval. That is the whole point: an approval covers specific
 * words, and letting those words change underneath it would make the approval
 * meaningless. A shipped recommendation is not editable at all — the change is
 * already live.
 */
async function update({ access, id, patch }) {
  if (!isSupabaseConfigured()) throw notConfigured();

  const existing = await get(access.project.id, id);
  if (!existing) throw Object.assign(new Error('Recommendation not found.'), { status: 404 });
  if (existing.status === 'shipped') {
    throw conflict('A shipped recommendation cannot be edited — it describes something already live.');
  }

  const update = {};
  if (patch.title !== undefined) {
    const t = String(patch.title).trim();
    if (!t) throw invalid('A recommendation needs a title.', 'title_required');
    update.title = t;
  }
  if (patch.body !== undefined) update.body = patch.body ? String(patch.body) : null;
  if (patch.effort !== undefined) update.effort = patch.effort || null;
  if (patch.priority !== undefined) {
    if (!PRIORITIES.includes(patch.priority)) {
      throw invalid(`priority must be one of: ${PRIORITIES.join(', ')}.`, 'bad_priority');
    }
    update.priority = patch.priority;
  }
  if (!Object.keys(update).length) return view(existing);

  const material = isMaterialChange(existing, patch);
  let revoked = false;
  if (material && existing.status === 'approved') {
    update.status = 'proposed';
    update.approved_by = null;
    update.approved_at = null;
    revoked = true;
  }

  const { data, error } = await getSupabase()
    .from('recommendations')
    .update(update)
    .eq('id', id)
    .eq('project_id', access.project.id)
    .select('*')
    .single();
  if (error) fail('update', error);

  audit(access, auditEvents.ACTIONS.RECOMMENDATION_UPDATED, {
    entityType: 'recommendation',
    entityId: id,
    oldState: { title: existing.title, status: existing.status, priority: existing.priority },
    newState: { ...update, approvalRevoked: revoked },
    reason: revoked
      ? 'Approval revoked: the text of an approved recommendation changed materially.'
      : null,
  });

  return { recommendation: view(data), approvalRevoked: revoked };
}

/**
 * Moves a recommendation through its lifecycle.
 *
 * The capability needed comes from the transition table, and the CALLER checks
 * it — this service is handed an access context that already knows the role, and
 * asking it twice in two places is how the two answers drift apart.
 */
async function transition({ access, id, to, reason = null, shippedAt = null }) {
  if (!isSupabaseConfigured()) throw notConfigured();
  if (!STATUSES.includes(to)) throw invalid(`Unknown status: ${to}.`, 'bad_status');

  const existing = await get(access.project.id, id);
  if (!existing) throw Object.assign(new Error('Recommendation not found.'), { status: 404 });

  const verdict = transitionFor(existing.status, to);
  if (!verdict.ok) throw conflict(verdict.reason);

  const can = access.can ? access.can(verdict.capability) : false;
  if (can !== true) {
    throw Object.assign(
      new Error(
        can === 'propose'
          ? `Your role (${access.role || 'none'}) can propose but not ${to === 'approved' ? 'approve' : to} this.`
          : `Your role (${access.role || 'none'}) cannot move a recommendation to ${to}.`,
      ),
      { status: 403 },
    );
  }

  const now = new Date().toISOString();
  const update = { status: to };
  let action = auditEvents.ACTIONS.RECOMMENDATION_UPDATED;

  if (to === 'proposed') {
    update.proposed_by = access.userId || null;
    update.proposed_at = now;
    // Re-proposing after a rejection clears the rejection, or the row would
    // claim to be both proposed and rejected.
    update.rejected_by = null;
    update.rejected_at = null;
    update.rejection_reason = null;
    update.approved_by = null;
    update.approved_at = null;
  } else if (to === 'approved') {
    update.approved_by = access.userId || null;
    update.approved_at = now;
  } else if (to === 'rejected') {
    if (!reason || !String(reason).trim()) {
      throw invalid(
        'A rejection needs a reason — "why didn\'t we do this" is the question this record answers.',
        'reason_required',
      );
    }
    update.rejected_by = access.userId || null;
    update.rejected_at = now;
    update.rejection_reason = String(reason).trim();
    action = auditEvents.ACTIONS.RECOMMENDATION_REJECTED;
  } else if (to === 'shipped') {
    // A date supplied by the person who shipped it beats "now": work often goes
    // live before anybody records it, and back-dating is the honest option.
    const when = shippedAt ? new Date(shippedAt) : new Date();
    if (Number.isNaN(when.getTime())) throw invalid('shippedAt is not a date.', 'bad_date');
    if (when.getTime() > Date.now() + 86_400_000) {
      throw invalid('A ship date cannot be in the future.', 'future_date');
    }
    update.shipped_by = access.userId || null;
    update.shipped_at = when.toISOString();
    action = auditEvents.ACTIONS.RECOMMENDATION_SHIPPED;
  }

  if (to === 'approved') action = auditEvents.ACTIONS.RECOMMENDATION_APPROVED;

  const { data, error } = await getSupabase()
    .from('recommendations')
    .update(update)
    .eq('id', id)
    .eq('project_id', access.project.id)
    .eq('status', existing.status)   // optimistic: two approvers racing, one wins
    .select('*')
    .maybeSingle();
  if (error) fail('transition', error);
  if (!data) {
    throw conflict('Someone else changed this recommendation just now — reload and try again.');
  }

  // strict: an approval or a rejection is a decision somebody is accountable
  // for. If the trail cannot record it, the caller must hear about it.
  await auditEvents.record({
    workspaceId: access.workspaceId || access.project?.workspace_id || null,
    projectId: access.project?.id || null,
    actorUserId: access.userId || null,
    actorEmail: access.actorEmail || null,
    actorRole: access.role || null,
    action,
    entityType: 'recommendation',
    entityId: id,
    reason: reason ? String(reason).trim() : null,
    oldState: { status: existing.status },
    newState: { status: to, shippedAt: update.shipped_at || null },
    source: 'projects.recommendations',
  }, { strict: ['approved', 'rejected', 'shipped'].includes(to) });

  return view(data);
}

/**
 * Turns a stored module finding into a draft recommendation.
 *
 * The finding's own recommendation text is used when it has one. Nothing is
 * generated here: an LLM-written suggestion presented as the module's finding
 * would blur which part a person can rely on.
 */
function fromFinding(finding, { moduleKey, sourceRunId } = {}) {
  return {
    moduleKey: moduleKey || null,
    sourceRunId: sourceRunId || null,
    ruleId: finding.ruleId || null,
    title: finding.title,
    body: finding.recommendation || null,
    // Severity is the machine's read of how broken something is. Priority is the
    // team's read of what to do first, so it starts at the default and is theirs
    // to set — mapping one onto the other would dress up a guess as a decision.
    priority: 'medium',
    evidence: {
      severity: finding.severity,
      category: finding.category || null,
      count: finding.count,
      detail: finding.detail || null,
      capturedAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  STATUSES,
  PRIORITIES,
  TRANSITIONS,
  MATERIAL_FIELDS,
  transitionFor,
  isMaterialChange,
  fromFinding,
  view,
  list,
  get,
  summary,
  create,
  update,
  transition,
};
