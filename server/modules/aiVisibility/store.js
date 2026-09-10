// ── Persistence for ai_visibility ────────────────────────────────────────────
//
// Tables from 0016, extended by 0017 with a review lifecycle and a topic axis.
// Every query carries its own project filter, which IS the tenancy check —
// there is no RLS behind it (same as 0012–0016).
//
// Two things here are deliberate rather than incidental:
//
//   Prompts are RETIRED or REJECTED, never deleted. A prompt removed from the
//   set still has captures behind it, and deleting it would rewrite the
//   history those numbers were computed from. Rejected and retired are kept
//   distinct: rejected means "this was never a good question", retired means
//   "this was measured and we stopped" — collapsing them loses the ability to
//   tell a reviewer "you already turned this phrasing down".
//
//   Captures store `prompt_text` as sent, not just `prompt_id`. Editing a
//   prompt later must not change what an old capture claims it asked.

const db = require('../../services/db');
const auditEvents = require('../../services/auditEvents');
const lifecycle = require('./promptLifecycle');

function fail(op, error) {
  throw new Error(`[aiVisibility.${op}] ${error.message || error}`);
}

function notConfigured() {
  return Object.assign(
    new Error('AI Visibility needs the database configured.'),
    { status: 503, code: 'not_configured' },
  );
}

function notFound() {
  return Object.assign(new Error('Prompt not found.'), { status: 404 });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

/**
 * The table is missing until 0016 is applied, or the review columns are
 * missing until 0017 is. Say so rather than 500ing.
 *
 * Postgres answers this directly now: 42P01 for a missing relation, 42703 for a
 * missing column. The schema-cache spellings this used to also match
 * ("Could not find the table 'public.x' in the schema cache", PGRST2xx) came
 * from PostgREST answering out of its own cache before the query ever reached
 * the database, and cannot occur over a direct connection.
 */
// Warn once per table, not per call: a report touches these readers dozens of
// times and an unapplied migration would otherwise bury the log. Silence here
// was the actual problem — every reader returns [] on a missing table, so a
// migration nobody ran reads identically to a client with no data.
const _warnedMissing = new Set();
function warnMissingOnce(message) {
  // Postgres names the object in double quotes ("relation "x" does not exist");
  // single quotes are kept for anything that still phrases it the other way.
  const text = String(message || '');
  const key = text.match(/"([\w.]+)"/)?.[1] || text.match(/'([\w.]+)'/)?.[1] || 'unknown';
  if (_warnedMissing.has(key)) return;
  _warnedMissing.add(key);
  console.warn(`[aiVisibility.store] missing schema object: ${key}. `
    + 'An AI Visibility migration (0016-0019) has not been applied — reads will '
    + 'return empty until it is.');
}

function isMissingTable(error) {
  if (!error) return false;
  const message = error.message || '';
  const missing = error.code === '42P01'
    // A column 0017 adds, asked for before the migration has run.
    || error.code === '42703'
    || /relation .* does not exist/i.test(message)
    || /column .* does not exist/i.test(message);

  if (missing) warnMissingOnce(message);
  return missing;
}

function migrationNeeded() {
  return Object.assign(
    new Error('AI Visibility needs migration 0017_ai_visibility_prompt_review.sql applied.'),
    { status: 503, code: 'migration_needed' },
  );
}

// ── Prompts ────────────────────────────────────────────────────────────────

// Explicit column list, not select('*') — `evidence` is a multi-KB jsonb
// snapshot per row and most readers (the runner, the coverage counters) never
// want it dragged along.
const LIST_COLUMNS = [
  'id', 'project_id', 'text', 'source', 'source_ref', 'intent', 'slot', 'rationale',
  'topic_kind', 'topic_label', 'target_url', 'demand_volume', 'demand_source',
  'status', 'proposed_at', 'approved_at', 'approved_by',
  'rejected_at', 'rejected_by', 'rejection_reason',
  'retired_at', 'retired_by', 'generation_run_id', 'created_at', 'updated_at',
].join(', ');
const FULL_COLUMNS = `${LIST_COLUMNS}, evidence`;

function promptView(row, { includeEvidence = false } = {}) {
  return {
    id: row.id,
    text: row.text,
    source: row.source,
    sourceRef: row.source_ref,
    intent: row.intent,
    slot: row.slot,
    rationale: row.rationale,
    topicKind: row.topic_kind,
    topicLabel: row.topic_label,
    targetUrl: row.target_url,
    demandVolume: row.demand_volume,
    demandSource: row.demand_source,
    status: row.status,
    // Derived, not stored — 0017 dropped the `active` column because two
    // flags for one fact is exactly the bug class this migration exists to
    // close. Kept here so a caller still holding the pre-0017 API contract
    // (report rendering, mainly) does not have to learn the new vocabulary.
    active: row.status === 'approved',
    proposedAt: row.proposed_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    rejectedAt: row.rejected_at,
    rejectedBy: row.rejected_by,
    rejectionReason: row.rejection_reason,
    retiredAt: row.retired_at,
    retiredBy: row.retired_by,
    generationRunId: row.generation_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(includeEvidence ? { evidence: row.evidence || {} } : {}),
  };
}

/**
 * The prompt set for a project, oldest first so the order is stable.
 *
 * No options: 'approved' only — exactly what a caller wants when measuring or
 * rendering the live set, and exactly 0016's old default behaviour. `status`
 * overrides that outright; `includeRetired` is the back-compat alias for the
 * old `?retired=true` meaning "everything", kept for routes still on the old
 * contract.
 */
async function listPrompts(projectId, {
  status = null, slot = null, topic = null, includeRetired = false, includeEvidence = false,
  limit = 500, offset = 0,
} = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const params = [projectId];
  const where = ['project_id = $1'];

  if (status) {
    params.push(Array.isArray(status) ? status : [status]);
    where.push(`status = any($${params.length})`);
  } else if (!includeRetired) {
    where.push(`status = 'approved'`);
  }
  if (slot) {
    params.push(slot);
    where.push(`slot = $${params.length}`);
  }
  if (topic) {
    params.push(topic);
    where.push(`topic_label = $${params.length}`);
  }

  const capped = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000);
  params.push(capped, offset);

  let data;
  try {
    data = await db.rows(
      `select ${includeEvidence ? FULL_COLUMNS : LIST_COLUMNS}
         from ai_visibility_prompts
        where ${where.join(' and ')}
        order by created_at asc
        limit $${params.length - 1} offset $${params.length}`,
      params
    );
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    fail('listPrompts', error);
  }
  return data.map((r) => promptView(r, { includeEvidence }));
}

/** Counts by status, for a review screen header that should not fetch everything. */
async function countPromptsByStatus(projectId) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  // Grouped by the database rather than by pulling every prompt row back and
  // tallying here — this backs a screen header, and the header should not be
  // the reason the whole prompt set is fetched.
  let data;
  try {
    data = await db.rows(
      `select status, count(*)::int as n from ai_visibility_prompts
        where project_id = $1
        group by status`,
      [projectId]
    );
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    fail('countPromptsByStatus', error);
  }
  const counts = Object.fromEntries(lifecycle.STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const row of data) {
    counts[row.status] = row.n;
    total += row.n;
  }
  return { ...counts, total };
}

/** Counts by intent slot, over one status set (default: the measured set). */
async function countPromptsBySlot(projectId, { status = 'approved' } = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const params = [projectId];
  let narrow = '';
  if (status) {
    params.push(Array.isArray(status) ? status : [status]);
    narrow = ` and status = any($${params.length})`;
  }

  let data;
  try {
    data = await db.rows(
      `select slot, count(*)::int as n from ai_visibility_prompts
        where project_id = $1${narrow}
        group by slot`,
      params
    );
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    fail('countPromptsBySlot', error);
  }
  const counts = {};
  let unslotted = 0;
  for (const row of data) {
    if (!row.slot) { unslotted += row.n; continue; }
    counts[row.slot] = row.n;
  }
  return { ...counts, unslotted };
}

/** One prompt's raw DB row, project-scoped. Internal — callers want promptView. */
async function fetchRaw(projectId, promptId) {
  try {
    return await db.maybeOne(
      `select ${FULL_COLUMNS} from ai_visibility_prompts
        where project_id = $1 and id = $2`,
      [projectId, promptId]
    );
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    fail('fetchRaw', error);
  }
}

async function getPrompt(projectId, promptId) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const row = await fetchRaw(projectId, promptId);
  return row ? promptView(row, { includeEvidence: true }) : null;
}

/**
 * Add prompts, validating and de-duplicating before anything touches the
 * database.
 *
 * Not an upsert. 0016's upsert declared `onConflict: 'project_id,text'`,
 * which can never match the expression index this table has always actually
 * used — it fell through to a read-then-write fallback on every single call,
 * silently. This is that fallback, promoted to the one path, with real
 * validation in front of it.
 */
async function addPrompts({
  access, prompts, status = 'draft', generationRunId = null,
}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  if (!prompts?.length) return { added: [], skipped: [] };
  if (!lifecycle.STATUSES.includes(status)) {
    throw Object.assign(new Error(`Unknown status: ${status}.`), { status: 400, code: 'bad_status' });
  }
  if (status === 'approved' && !access.userId) {
    throw Object.assign(
      new Error('An approved prompt needs an approver — pass status: "draft" instead.'),
      { status: 400, code: 'no_actor' },
    );
  }

  // Validate first: an invalid prompt is reported in `skipped`, not a raw DB
  // CHECK-constraint 500 that fails the whole batch for one bad row.
  const validated = [];
  const skipped = [];
  for (const raw of prompts) {
    try {
      validated.push(lifecycle.validatePrompt(raw));
    } catch (e) {
      skipped.push({
        text: String((raw && raw.text) || raw || ''),
        reason: e.code || 'invalid',
        detail: e.message,
      });
    }
  }
  if (!validated.length) return { added: [], skipped };

  // Dedupe WITHIN the batch — two generated prompts proposing the same
  // question must not both reach the database and race the unique index.
  const byKey = new Map();
  for (const p of validated) {
    const key = lifecycle.normalise(p.text);
    if (byKey.has(key)) {
      skipped.push({ text: p.text, reason: 'duplicate', detail: 'Duplicate within this batch.' });
      continue;
    }
    byKey.set(key, p);
  }

  // Only the LIVE set (draft/approved) can collide by design — see 0017's
  // partial unique index. A rejected prompt with the same text is not
  // refused, it is flagged: `evidence.priorRejection` lets a reviewer see the
  // generator keeps proposing something they already turned down, rather than
  // hiding that pattern behind a silent skip.
  const [live, rejected] = await Promise.all([
    listPrompts(access.project.id, { status: ['draft', 'approved'] }),
    listPrompts(access.project.id, { status: 'rejected' }),
  ]);
  const liveSeen = new Set(live.map((p) => lifecycle.normalise(p.text)));
  const rejectedByKey = new Map(rejected.map((p) => [lifecycle.normalise(p.text), p]));

  const now = new Date().toISOString();
  const rows = [];
  for (const [key, p] of byKey) {
    if (liveSeen.has(key)) {
      skipped.push({ text: p.text, reason: 'duplicate', detail: 'Already in the live prompt set.' });
      continue;
    }
    const priorRejection = rejectedByKey.get(key);
    rows.push({
      project_id: access.project.id,
      workspace_id: access.project.workspace_id || null,
      text: p.text,
      source: p.source,
      source_ref: p.sourceRef,
      intent: p.intent,
      slot: p.slot,
      rationale: p.rationale,
      topic_kind: p.topicKind,
      topic_label: p.topicLabel,
      target_url: p.targetUrl,
      demand_volume: p.demandVolume,
      demand_source: p.demandSource,
      status,
      proposed_at: status === 'draft' ? now : null,
      approved_at: status === 'approved' ? now : null,
      approved_by: status === 'approved' ? access.userId : null,
      generation_run_id: generationRunId,
      evidence: priorRejection
        ? {
          priorRejection: {
            promptId: priorRejection.id,
            reason: priorRejection.rejectionReason,
            rejectedAt: priorRejection.rejectedAt,
          },
        }
        : {},
      created_by: access.actorEmail || null,
    });
  }
  if (!rows.length) return { added: [], skipped };

  let data;
  try {
    data = await db.insertMany('ai_visibility_prompts', rows, { returning: FULL_COLUMNS });
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    // Two callers building a set at the same instant: re-read the live set
    // and insert only what is genuinely still new, rather than failing the
    // whole batch for a race neither caller could have avoided. 23505 is
    // Postgres's unique_violation.
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
      return insertRemainder(access, rows, skipped);
    }
    fail('addPrompts', error);
  }

  return { added: data.map((r) => promptView(r)), skipped };
}

async function insertRemainder(access, rows, skipped) {
  const live = await listPrompts(access.project.id, { status: ['draft', 'approved'] });
  const seen = new Set(live.map((p) => lifecycle.normalise(p.text)));
  const fresh = rows.filter((r) => {
    const key = lifecycle.normalise(r.text);
    if (seen.has(key)) {
      skipped.push({ text: r.text, reason: 'duplicate', detail: 'Someone else added this at the same time.' });
      return false;
    }
    return true;
  });
  if (!fresh.length) return { added: [], skipped };

  let data;
  try {
    data = await db.insertMany('ai_visibility_prompts', fresh, { returning: FULL_COLUMNS });
  } catch (error) {
    fail('insertRemainder', error);
  }
  return { added: data.map((r) => promptView(r)), skipped };
}

/** addPrompts(status: 'draft'), stamped with the run that generated them. */
async function saveGeneratedDraft({ access, runId, prompts }) {
  return addPrompts({
    access, prompts, status: 'draft', generationRunId: runId,
  });
}

/**
 * Edits a prompt's text or metadata.
 *
 * Editing an approved prompt KEEPS it approved, and re-stamps the approval.
 *
 * It used to demote the row back to 'draft' on any text change, on the
 * argument that an approval covers specific words. That is defensible for a
 * spend-control audit trail and wrong for a person fixing a typo: the row
 * silently vanished from the measured set, reappeared in the review list,
 * and the next run quietly skipped it — with no confirmation and no toast.
 * That behaviour was the single commonest cause of "why did my question not
 * run". The audit trail still records who last touched the text.
 *
 * A removed prompt is not editable; put it back first.
 */
async function updatePrompt({ access, promptId, patch }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const existing = await fetchRaw(access.project.id, promptId);
  if (!existing) throw notFound();
  if (existing.status === 'retired') {
    throw conflict('A removed question cannot be edited — put it back first.');
  }

  const validated = lifecycle.validatePrompt({
    text: patch.text !== undefined ? patch.text : existing.text,
    source: existing.source,
    sourceRef: existing.source_ref,
    intent: patch.intent !== undefined ? patch.intent : existing.intent,
    slot: patch.slot !== undefined ? patch.slot : existing.slot,
    rationale: patch.rationale !== undefined ? patch.rationale : existing.rationale,
    topicKind: existing.topic_kind,
    topicLabel: existing.topic_label,
    targetUrl: existing.target_url,
    demandVolume: existing.demand_volume,
    demandSource: existing.demand_source,
  });

  const update = {};
  if (patch.text !== undefined) update.text = validated.text;
  if (patch.intent !== undefined) update.intent = validated.intent;
  if (patch.slot !== undefined) update.slot = validated.slot;
  if (patch.rationale !== undefined) update.rationale = validated.rationale;
  if (!Object.keys(update).length) return { prompt: promptView(existing), approvalRevoked: false };

  const material = lifecycle.isMaterialChange(
    { text: existing.text },
    { text: update.text !== undefined ? update.text : existing.text },
  );
  // Re-stamped, not revoked: the set the next run measures does not change,
  // and the row records that the approved words were edited and by whom.
  const approvalRevoked = false;
  if (material && existing.status === 'approved') {
    update.approved_at = new Date().toISOString();
    if (access.userId) update.approved_by = access.userId;
  }

  let data;
  try {
    const params = [];
    const sets = Object.keys(update).map((c) => {
      params.push(update[c]);
      return `"${c}" = $${params.length}`;
    }).join(', ');
    params.push(promptId, access.project.id);
    data = await db.maybeOne(
      `update ai_visibility_prompts set ${sets}
        where id = $${params.length - 1} and project_id = $${params.length}
        returning ${FULL_COLUMNS}`,
      params
    );
  } catch (error) {
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
      throw conflict('Another prompt already asks this question.');
    }
    fail('updatePrompt', error);
  }
  if (!data) throw notFound();

  auditEvents.record({
    workspaceId: access.workspaceId || access.project?.workspace_id || null,
    projectId: access.project?.id || null,
    actorUserId: access.userId || null,
    actorEmail: access.actorEmail || null,
    actorRole: access.role || null,
    action: auditEvents.ACTIONS.AI_VISIBILITY_PROMPT_EDITED,
    entityType: 'ai_visibility_prompt',
    entityId: promptId,
    oldState: { text: existing.text, status: existing.status },
    newState: { ...update, approvalRevoked },
    // The words a person approved changed, and the prompt stayed approved.
    // That is the whole point of recording it: the approval is still live, so
    // the trail has to say what it now covers.
    reason: material && existing.status === 'approved'
      ? 'The text of an approved prompt was edited. It remains approved and will still be measured.'
      : null,
    source: 'aiVisibility.prompts',
  });

  return { prompt: promptView(data), approvalRevoked };
}

const ACTION_FOR_STATUS = {
  approved: 'AI_VISIBILITY_PROMPT_APPROVED',
  rejected: 'AI_VISIBILITY_PROMPT_REJECTED',
  retired: 'AI_VISIBILITY_PROMPT_RETIRED',
  draft: 'AI_VISIBILITY_PROMPT_EDITED',
};

/**
 * Moves a prompt through its lifecycle. The ONE write path for status —
 * mirrors modules/projects/recommendations.js's `transition` closely on
 * purpose, including the optimistic `.eq('status', existing.status)` guard so
 * two reviewers racing produce one winner and one 409 rather than a lost
 * decision.
 */
/**
 * Undo an approval that lost a budget race.
 *
 * Guarded on the status we wrote, so a concurrent change is not overwritten,
 * and the result is REPORTED rather than assumed — a caller that says "nothing
 * was changed" after a failed rollback is telling the reviewer something untrue
 * about a prompt that will now cost money on every run.
 *
 * @returns {Promise<boolean>} whether the row was actually restored
 */
async function rollBackApproval(access, promptId, existing) {
  try {
    const data = await db.maybeOne(
      `update ai_visibility_prompts
          set status = $1, approved_at = $2, approved_by = $3
        where id = $4 and project_id = $5 and status = 'approved'
        returning id`,
      [existing.status, existing.approved_at, existing.approved_by, promptId, access.project.id]
    );
    return Boolean(data);
  } catch (error) {
    console.error('[aiVisibility.store] budget rollback failed:', error.message);
    return false;
  }
}

async function transitionPrompt({
  access, promptId, to, reason = null, budget = null,
}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  if (!lifecycle.STATUSES.includes(to)) {
    throw Object.assign(new Error(`Unknown status: ${to}.`), { status: 400, code: 'bad_status' });
  }

  const existing = await fetchRaw(access.project.id, promptId);
  if (!existing) throw notFound();

  let overBudgetGuard = null;

  const verdict = lifecycle.transitionFor(existing.status, to);
  if (!verdict.ok) throw conflict(verdict.reason);

  const now = new Date().toISOString();
  const update = { status: to };

  // The budget is a ceiling on the APPROVED set, not just on what a run
  // measures. It previously gated only measurement — `approved.slice(0,
  // budget)` in run.js — so a client could accumulate 30 approved prompts
  // against a budget of 10 and quietly have 20 of them never measured, chosen
  // by insertion order, with nothing on screen saying which or why.
  //
  // Drafts stay unbounded on purpose: they are proposals, and reviewing 20 to
  // keep 10 is what a review queue is for. What is bounded is the set that
  // costs money every run.
  if (to === 'approved' && Number.isFinite(budget) && budget > 0 && existing.status !== 'approved') {
    const counts = await countPromptsByStatus(access.project.id);
    const approvedNow = counts?.approved || 0;
    if (approvedNow >= budget) {
      throw Object.assign(
        new Error(`This client's budget is ${budget} approved prompt(s), and ${approvedNow} `
          + 'are already approved. Retire one before approving another.'),
        { status: 409, code: 'over_budget', budget, approved: approvedNow },
      );
    }
    // Re-checked after the write, below. This read-then-write can be raced by
    // two reviewers approving different prompts at once — both see 9 against a
    // budget of 10, both pass, and the client ends with 11 approved questions
    // that all cost money every run.
    overBudgetGuard = { budget, wasAt: approvedNow };
  }

  if (to === 'approved') {
    if (!access.userId) {
      throw Object.assign(
        new Error('An approval needs a signed-in approver.'),
        { status: 400, code: 'no_actor' },
      );
    }
    update.approved_at = now;
    update.approved_by = access.userId;
    update.rejected_at = null;
    update.rejected_by = null;
    update.rejection_reason = null;
    update.retired_at = null;
    update.retired_by = null;
  } else if (to === 'rejected') {
    if (!reason || !String(reason).trim()) {
      throw Object.assign(
        new Error('A rejection needs a reason — it is what stops the generator proposing the same question again.'),
        { status: 400, code: 'reason_required' },
      );
    }
    update.rejected_at = now;
    update.rejected_by = access.userId || null;
    update.rejection_reason = String(reason).trim();
  } else if (to === 'retired') {
    update.retired_at = now;
    update.retired_by = access.userId || null;
  } else if (to === 'draft') {
    update.proposed_at = existing.proposed_at || now;
    update.approved_at = null;
    update.approved_by = null;
    update.rejected_at = null;
    update.rejected_by = null;
    update.rejection_reason = null;
    update.retired_at = null;
    update.retired_by = null;
  }

  // Restoring (retired -> approved) or re-proposing (rejected -> draft) can
  // collide with a prompt that filled the same text while this one was out
  // of the live set — the live partial unique index only sees the set as it
  // stands now, so check before the write rather than let the DB 500.
  if (to === 'approved' || to === 'draft') {
    const key = lifecycle.normalise(existing.text);
    const live = await listPrompts(access.project.id, { status: ['draft', 'approved'] });
    if (live.some((p) => p.id !== promptId && lifecycle.normalise(p.text) === key)) {
      throw conflict('Another prompt already asks this question — that one is live, this one is not.');
    }
  }

  // The guard on `status` is the optimistic lock: two reviewers racing produce
  // one winner and one 409, rather than a lost decision.
  let data;
  try {
    const params = [];
    const sets = Object.keys(update).map((c) => {
      params.push(update[c]);
      return `"${c}" = $${params.length}`;
    }).join(', ');
    params.push(promptId, access.project.id, existing.status);
    data = await db.maybeOne(
      `update ai_visibility_prompts set ${sets}
        where id = $${params.length - 2}
          and project_id = $${params.length - 1}
          and status = $${params.length}
        returning ${FULL_COLUMNS}`,
      params
    );
  } catch (error) {
    fail('transitionPrompt', error);
  }
  if (!data) {
    throw conflict('Someone else changed this prompt just now — reload and try again.');
  }

  // Re-check the ceiling AFTER the write, and undo if a concurrent approval
  // beat us past it.
  //
  // The check above is a read-then-write: two reviewers approving different
  // prompts at the same moment both see 9 against a budget of 10, both pass,
  // and the client ends up with 11 approved questions — each of which costs
  // money on every run from then on. The write itself is the only point where
  // the true count exists, so the count is taken again here and the approval
  // rolled back rather than left over the line.
  if (overBudgetGuard) {
    // Re-check the ceiling AFTER the write, and undo only if THIS approval is
    // one of the ones over the line.
    //
    // Three things had to be right here and only the first was:
    //
    //   • the check above is a read-then-write, so two reviewers approving
    //     different prompts both see 9 against a budget of 10 and both pass
    //   • a failed count must not read as "0 approved" and wave the approval
    //     through — a spend gate fails CLOSED
    //   • both racers must not roll back, or two valid approvals become none
    //
    // The ordering is the fix for the third: every racer sorts the approved set
    // the same way (oldest approval first, id as tiebreak) and rolls back only
    // if its own prompt sits beyond the budget. Exactly the overflow loses, and
    // every participant computes the same answer.
    const live = await listPrompts(access.project.id, { status: ['approved'] })
      .catch(() => null);

    if (!live) {
      await rollBackApproval(access, promptId, existing);
      throw Object.assign(
        new Error('Could not confirm this client\'s approved count, so the approval was '
          + 'undone rather than risk exceeding the budget. Try again.'),
        { status: 503, code: 'budget_check_failed' },
      );
    }

    const order = [...live].sort((a, b) => (
      String(a.approvedAt || '').localeCompare(String(b.approvedAt || ''))
      || String(a.id).localeCompare(String(b.id))
    ));
    const rank = order.findIndex((x) => x.id === promptId);

    if (rank >= overBudgetGuard.budget) {
      const undone = await rollBackApproval(access, promptId, existing);
      const lost = `This client's budget is ${overBudgetGuard.budget} approved prompt(s) `
        + 'and another approval landed first. ';
      throw Object.assign(
        new Error(undone
          ? `${lost}Nothing was changed — reload and try again.`
          : `${lost}The approval could NOT be undone: this prompt is over the budget and `
            + 'must be retired by hand.'),
        {
          status: 409,
          code: undone ? 'over_budget' : 'over_budget_not_undone',
          budget: overBudgetGuard.budget,
          approved: live.length,
        },
      );
    }
  }

  let actionKey = ACTION_FOR_STATUS[to] || 'AI_VISIBILITY_PROMPT_EDITED';
  if (existing.status === 'retired' && to === 'approved') actionKey = 'AI_VISIBILITY_PROMPT_RESTORED';

  // strict: approving or rejecting is the decision that releases (or refuses)
  // spend on measuring this question. If the trail cannot record it, the
  // caller must hear about it rather than the decision landing silently.
  await auditEvents.record({
    workspaceId: access.workspaceId || access.project?.workspace_id || null,
    projectId: access.project?.id || null,
    actorUserId: access.userId || null,
    actorEmail: access.actorEmail || null,
    actorRole: access.role || null,
    action: auditEvents.ACTIONS[actionKey],
    entityType: 'ai_visibility_prompt',
    entityId: promptId,
    reason: reason ? String(reason).trim() : null,
    oldState: { status: existing.status },
    newState: { status: to },
    source: 'aiVisibility.prompts',
  }, { strict: ['approved', 'rejected'].includes(to) });

  return promptView(data);
}

/** Bulk approve. Not one UPDATE statement: each approval is an individually
 *  audited decision that releases spend, and one stale id must not silently
 *  skip — or silently include — the rest. Capped so a bad request can't spin
 *  the event loop over an unbounded list. */
async function approvePrompts({ access, promptIds, budget = null }) {
  const ids = [...new Set((promptIds || []).filter(Boolean))].slice(0, 200);
  const approved = [];
  const failedList = [];
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      approved.push(await transitionPrompt({
        access, promptId: id, to: 'approved', budget,
      }));
    } catch (e) {
      failedList.push({ promptId: id, error: e.message, code: e.code || null });
    }
  }
  return { approved, failed: failedList };
}

/** Retire a prompt. Its captures stay and still count in past runs. Returns
 *  null for "not found" rather than throwing, preserving the DELETE route's
 *  existing 404 contract. */
async function retirePrompt({ access, promptId }) {
  try {
    return await transitionPrompt({ access, promptId, to: 'retired' });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** Un-retire — 0016 had no path back from retired at all. */
async function restorePrompt({ access, promptId }) {
  return transitionPrompt({ access, promptId, to: 'approved' });
}

// ── Captures ───────────────────────────────────────────────────────────────

/**
 * Store one run's captures.
 *
 * `raw` is kept for every row including failures and no-answers: "no AI Overview
 * exists" and "an AI Overview we could not read" are indistinguishable without
 * it, and that distinction decides whether a client is told they are invisible.
 */
async function saveCaptures({ access, runId, rows }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  if (!rows?.length) return 0;

  const records = rows.map((r) => ({
    // `access` is deliberately spread in below rather than listed here.
    run_id: runId,
    prompt_id: r.promptId || null,
    project_id: access.project.id,
    workspace_id: access.project.workspace_id || null,
    prompt_text: r.prompt,
    engine: r.engine || 'unknown',
    provider: r.provider || 'unknown',
    // The column's own default, written explicitly rather than omitted.
    //
    // `access` is `not null default 'scraped'`, and a default only fills a
    // column absent from the INSERT — an explicit null violates the constraint
    // instead. Sending null failed the whole batch, and run.js only logs a
    // saveCaptures failure, so an entire run's measurements were discarded
    // while the run reported completed.
    //
    // Omitting the key is no longer enough to avoid that: these rows go in as
    // ONE multi-row INSERT whose column list is the union of every row's keys,
    // so a row that leaves `access` out is bound as null the moment any other
    // row in the same batch sets it. Naming the default here means the value is
    // never null whichever surfaces a run happens to mix.
    access: r.access || 'scraped',
    surface_label: r.surfaceLabel || r.surfaceId || 'unknown',
    status: r.status,
    failure_reason: r.failureReason || null,
    answer_text: r.answerText || null,
    citations: r.citations || [],
    // Nullable on purpose — see 0016's header.
    mentioned: r.mentioned,
    cited: r.cited,
    prominence: r.prominence,
    competitors_mentioned: r.competitorsMentioned || [],
    web_queries: r.webQueries || [],
    // 0018 added this column and only markExtracted ever wrote it, which meant
    // the value the adapter measured at capture time was thrown away and the
    // report could only say it was never recorded.
    features: Array.isArray(r.features) ? r.features : [],
    model_version: r.modelVersion || null,
    task_cost: r.taskCost,
    raw: r.raw || null,
    captured_at: r.capturedAt || new Date().toISOString(),
  }));

  // Ids come back because the extraction pass hangs mentions, citations and
  // attributes off them. Without them the entity rows would have to be matched
  // back by (run_id, prompt_text, surface) — three columns that are not unique
  // together once a prompt is measured twice on the same surface.
  let data;
  try {
    data = await db.insertMany('ai_visibility_captures', records, { returning: 'id' });
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    fail('saveCaptures', error);
  }
  // A multi-row INSERT ... RETURNING gives the rows back in the order they were
  // supplied, which is what lets each id be paired with the capture it came from.
  return data.map((row, i) => ({ id: row.id, row: rows[i] }));
}


function captureView(row) {
  return {
    id: row.id,
    promptId: row.prompt_id,
    prompt: row.prompt_text,
    engine: row.engine,
    provider: row.provider,
    access: row.access,
    surfaceLabel: row.surface_label,
    status: row.status,
    failureReason: row.failure_reason,
    answerText: row.answer_text,
    citations: row.citations || [],
    mentioned: row.mentioned,
    cited: row.cited,
    prominence: row.prominence === null ? null : Number(row.prominence),
    competitorsMentioned: row.competitors_mentioned || [],
    webQueries: row.web_queries || [],
    modelVersion: row.model_version,
    taskCost: row.task_cost === null ? null : Number(row.task_cost),
    capturedAt: row.captured_at,
  };
}

// ── Brands and extracted entities (0018) ────────────────────────────────────
//
// `project_brands` is the §3.4 MEASURED SET made explicit. Everything else in
// this section hangs off it, and the reason it is a table rather than a derived
// list is that share of voice needs a stable denominator: a brand that appears
// halfway through a period must not silently change last month's percentages.
//
// Aliases are PROPOSED by derivation and only measured once approved.
// Competitor names in this codebase are domain stems ("aspendental"), which no
// model ever writes — measuring on those alone missed every competitor mention
// and inflated the client's share in the flattering direction.

function brandView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    domain: row.domain,
    isClient: Boolean(row.is_client),
    aliases: row.aliases || [],
    status: row.status,
    aliasSource: row.alias_source,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
  };
}

const BRAND_COLUMNS = 'id, project_id, name, domain, is_client, aliases, status, '
  + 'alias_source, approved_at, approved_by, created_at';

/** Brands for a project. Defaults to the whole set, whatever its status. */
async function listBrands(projectId, { status = null } = {}) {
  if (!db.isDatabaseConfigured()) return [];
  const params = [projectId];
  let narrow = '';
  if (status) {
    params.push(Array.isArray(status) ? status : [status]);
    narrow = ` and status = any($${params.length})`;
  }

  let data;
  try {
    data = await db.rows(
      `select ${BRAND_COLUMNS} from project_brands
        where project_id = $1${narrow}
        order by is_client desc, name asc`,
      params
    );
  } catch (error) {
    if (isMissingTable(error)) return [];
    fail('listBrands', error);
  }
  return data.map(brandView);
}

/**
 * The set mentions are actually measured against: APPROVED brands only.
 *
 * A proposed brand is deliberately invisible to extraction. Measuring on an
 * unreviewed alias set is how a generic industry word ("Dental") ends up
 * matching the whole category and every capture reads as a mention.
 */
async function measuredSet(projectId) {
  const brands = await listBrands(projectId, { status: 'approved' });
  return brands.map((b) => ({
    id: b.id, name: b.name, aliases: b.aliases, isClient: b.isClient, domain: b.domain,
  }));
}

/**
 * Propose brands, or refresh the ones already there.
 *
 * Never flips an approved brand back to proposed and never overwrites an
 * approved alias set — a person made that call, and a re-derivation must not
 * quietly undo it. New aliases for an approved brand are reported, not applied:
 * widening an approved matcher can only ever add mentions, which is the
 * direction that flatters.
 *
 * @returns {Promise<{added, updated, pending:[{brandId, name, aliases}]}>}
 */
async function upsertBrands({ access, brands = [] } = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  if (!brands.length) return { added: 0, updated: 0, pending: [] };

  const projectId = access.project.id;
  const existing = await listBrands(projectId);
  const byName = new Map(existing.map((b) => [String(b.name).trim().toLowerCase(), b]));

  const toInsert = [];
  const pending = [];
  let updated = 0;

  for (const b of brands) {
    const name = String(b?.name || '').trim();
    if (!name) continue;
    const hit = byName.get(name.toLowerCase());

    if (!hit) {
      toInsert.push({
        project_id: projectId,
        workspace_id: access.project.workspace_id || null,
        name,
        domain: b.domain || null,
        is_client: Boolean(b.isClient),
        aliases: b.aliases || [],
        status: 'proposed',
        alias_source: b.aliasSource || 'derived',
      });
      continue;
    }

    const held = new Set((hit.aliases || []).map((a) => String(a).toLowerCase()));
    const novel = (b.aliases || []).filter((a) => !held.has(String(a).toLowerCase()));
    if (!novel.length) continue;

    if (hit.status === 'approved') {
      pending.push({ brandId: hit.id, name: hit.name, aliases: novel });
      continue;
    }

    try {
      // `aliases` is jsonb, so the array is JSON-encoded rather than bound as a
      // Postgres array (see services/db.json).
      await db.query(
        `update project_brands set aliases = $1 where id = $2 and project_id = $3`,
        [db.json([...(hit.aliases || []), ...novel]), hit.id, projectId]
      );
    } catch (error) {
      fail('upsertBrands', error);
    }
    updated += 1;
  }

  if (toInsert.length) {
    try {
      await db.insertMany('project_brands', toInsert);
    } catch (error) {
      if (isMissingTable(error)) throw migrationNeeded();
      fail('upsertBrands', error);
    }
  }

  return { added: toInsert.length, updated, pending };
}

/** Approve or reject a proposed brand. Approval is what releases measurement. */
async function transitionBrand({ access, brandId, to } = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  if (!['approved', 'rejected', 'proposed'].includes(to)) {
    throw Object.assign(
      new Error(`Unknown brand status "${to}".`),
      { status: 400, code: 'bad_status' },
    );
  }
  if (to === 'approved' && !access.userId) {
    throw Object.assign(
      new Error('Approving a brand releases it into measurement and must be attributable.'),
      { status: 400, code: 'no_actor' },
    );
  }

  const patch = {
    status: to,
    approved_at: to === 'approved' ? new Date().toISOString() : null,
    approved_by: to === 'approved' ? access.userId : null,
  };

  let data;
  try {
    data = await db.maybeOne(
      `update project_brands set status = $1, approved_at = $2, approved_by = $3
        where id = $4 and project_id = $5
        returning ${BRAND_COLUMNS}`,
      [patch.status, patch.approved_at, patch.approved_by, brandId, access.project.id]
    );
  } catch (error) {
    fail('transitionBrand', error);
  }
  if (!data) throw notFound();
  return brandView(data);
}

// ── Extracted entities ─────────────────────────────────────────────────────
//
// All three writers replace a capture's rows rather than adding to them, so
// re-extracting corrects a capture instead of doubling it. That matters: a
// ruleset or rubric change means re-running extraction over stored answers, and
// a re-run that doubled every row would corrupt exactly the history the
// versioning exists to protect.

// The three entity tables this writes to are named by the callers below, never
// by a request, and are checked against that closed set before reaching SQL.
const ENTITY_TABLES = new Set(['capture_mention', 'capture_citation', 'capture_attribute']);

async function replaceRows(table, captureId, records, op) {
  if (!ENTITY_TABLES.has(table)) throw new Error(`[aiVisibility.${op}] unknown table: ${table}`);
  try {
    // Delete and re-insert in one transaction: a failure between the two used to
    // leave the capture with NO extracted rows at all, which reads downstream as
    // "this answer mentioned nobody" rather than as a failed extraction.
    await db.tx(async (t) => {
      await t.query(`delete from "${table}" where capture_id = $1`, [captureId]);
      if (!records.length) return;
      const cols = [...new Set(records.flatMap((r) => Object.keys(r)))];
      const params = [];
      const tuples = records.map((row) => {
        const slots = cols.map((c) => {
          params.push(row[c] === undefined ? null : row[c]);
          return `$${params.length}`;
        });
        return `(${slots.join(', ')})`;
      });
      await t.query(
        `insert into "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) values ${tuples.join(', ')}`,
        params
      );
    });
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    fail(op, error);
  }
  return records.length;
}

/**
 * §3.2's numerator, one row per brand NAMED.
 *
 * A brand that was not named has no row. Absence is the absence of a row, never
 * a row carrying zero — so a count of rows is directly the numerator, and no
 * query has to remember to filter the zeroes out.
 */
async function saveMentions({ projectId, captureId, mentions = [] } = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const records = mentions
    .filter((m) => m.brandId)
    .map((m) => ({
      capture_id: captureId,
      brand_id: m.brandId,
      project_id: projectId,
      ordinal: m.ordinal,
      char_offset: m.charOffset ?? null,
      mention_count: m.mentionCount || 1,
      // NULL means "not scored". Never 50 — see 0018's header.
      sentiment_score: m.sentiment ?? null,
      negated: Boolean(m.negated),
      is_client: Boolean(m.isClient),
      evidence: m.evidence ? String(m.evidence).slice(0, 1000) : null,
    }));
  return replaceRows('capture_mention', captureId, records, 'saveMentions');
}

/** §2.2's inline-vs-retrieved split, with classification stored as of ingest. */
async function saveCitations({ projectId, captureId, citations = [] } = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const records = citations
    .filter((c) => c.domain && c.host)
    .map((c) => ({
      capture_id: captureId,
      project_id: projectId,
      url: c.url || null,
      domain: c.domain,
      host: c.host,
      is_inline_cited: Boolean(c.isInlineCited),
      is_retrieved: Boolean(c.isRetrieved),
      position: c.position ?? null,
      occurrences: c.occurrences || 1,
      url_type: c.urlType || null,
      domain_type: c.domainType || null,
      ruleset_version: c.rulesetVersion || null,
      title: c.title ? String(c.title).slice(0, 500) : null,
    }));
  return replaceRows('capture_citation', captureId, records, 'saveCitations');
}

/** §7.1 perception terms, versioned so retuning never moves history. */
async function saveAttributes({ projectId, captureId, attributes = [] } = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const records = attributes
    .filter((a) => a.brandId && a.term)
    .map((a) => ({
      capture_id: captureId,
      brand_id: a.brandId,
      project_id: projectId,
      term: String(a.term).slice(0, 200),
      attribute_id: a.attributeId || null,
      occurrences: a.occurrences || 1,
      mapping_version: a.mappingVersion || null,
    }));
  return replaceRows('capture_attribute', captureId, records, 'saveAttributes');
}

/**
 * Close out extraction for one capture.
 *
 * `extracted_at` IS the queue: 0018 indexes captures where it is null, so a
 * capture is pending precisely until this runs. It is stamped only after the
 * entity rows land, so a crash mid-extraction leaves the capture pending rather
 * than marked done with nothing behind it.
 */
async function markExtracted({
  captureId, version, offGeo = false, features = null,
} = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const patch = {
    extraction_version: version,
    extracted_at: new Date().toISOString(),
    off_geo: Boolean(offGeo),
  };
  if (features) patch.features = features;

  try {
    // `features` is a real text[] column, so it stays a JS array rather than
    // being JSON-encoded (see services/db).
    await db.updateWhere('ai_visibility_captures', patch, { id: captureId });
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    fail('markExtracted', error);
  }
  return true;
}

/**
 * Captures still awaiting extraction, oldest first.
 *
 * `raw` IS selected here, unlike everywhere else, and the limit is small
 * because of it. Map cards live in `raw`, and every client on this module is a
 * local business whose prompts return map answers — reading only the prose
 * would record a practice sitting in a card on screen as absent. Paying for the
 * payload in batches of 25 is the cost of not reintroducing that bug on the
 * recovery path.
 */
/**
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string[]} [opts.excludeIds] captures already tried in this pass.
 *   A capture that throws is deliberately left unstamped so a later run picks
 *   it up — but within one pass that meant the same failing rows came back as
 *   the oldest ones every time, and every newer capture behind them was never
 *   reached. Excluding them lets the pass move past a poison batch.
 */
async function capturesPendingExtraction(projectId, { limit = 25, excludeIds = [] } = {}) {
  if (!db.isDatabaseConfigured()) return [];
  const params = [projectId];
  let exclude = '';
  if (excludeIds.length) {
    // No longer truncated to 300. That cap existed because the id list went into
    // a PostgREST query STRING and a long one overflowed the request line; bound
    // as one array parameter there is no such limit, so a long poison batch can
    // now be skipped in full rather than partially.
    params.push(excludeIds);
    exclude = ` and id <> all($${params.length})`;
  }
  params.push(limit);

  let data;
  try {
    data = await db.rows(
      `select id, prompt_id, prompt_text, engine, provider, access, surface_label,
              status, answer_text, citations, captured_at, raw
         from ai_visibility_captures
        where project_id = $1 and extracted_at is null${exclude}
        order by captured_at asc
        limit $${params.length}`,
      params
    );
  } catch (error) {
    if (isMissingTable(error)) return [];
    fail('capturesPendingExtraction', error);
  }
  return data.map((row) => ({ ...captureView(row), raw: row.raw || null }));
}

/**
 * Captures for several runs at once, grouped by run id.
 *
 * The report route walks up to ten runs looking for one that actually stored
 * evidence (a run can fail after capturing). Asking per run meant ten round
 * trips to answer one question.
 *
 * @returns {Promise<Map<string, Array>>}
 */
async function capturesForRuns(runIds = []) {
  const out = new Map();
  if (!db.isDatabaseConfigured() || !runIds.length) return out;

  let data;
  try {
    data = await db.rows(
      // The singular reader this replaced also returned web_queries and
      // model_version, and captureView maps both — omitting them left the
      // /report route serving captures with those fields silently undefined.
      `select ${CAPTURE_REPORT_COLUMNS}, run_id, citations, competitors_mentioned,
              web_queries, model_version
         from ai_visibility_captures
        where run_id = any($1)
        order by captured_at asc`,
      [runIds]
    );
  } catch (error) {
    if (isMissingTable(error)) return out;
    fail('capturesForRuns', error);
  }
  for (const row of data) {
    if (!out.has(row.run_id)) out.set(row.run_id, []);
    out.get(row.run_id).push(captureView(row));
  }
  return out;
}

// ── Reads for the report layer ─────────────────────────────────────────────
//
// A report reads TWO periods: the current one and the one before it, because
// every delta is a comparison against an equal-length window (§3.8). These
// readers therefore take an explicit `from` that the caller has already widened
// to cover both — no reader here guesses at a period boundary, so the window
// arithmetic lives in exactly one place (`metrics/period.js`).

const CAPTURE_REPORT_COLUMNS = 'id, prompt_id, prompt_text, engine, provider, access, '
  + 'surface_label, status, failure_reason, mentioned, cited, prominence, answer_text, '
  + 'features, off_geo, extraction_version, extracted_at, task_cost, captured_at';

/**
 * Captures for a date range, `to` inclusive.
 *
 * `raw` and `citations` are not selected: citations now live in their own table
 * with classification attached, and re-reading the jsonb copy would give the
 * report the UNCLASSIFIED version of the same rows.
 */
async function capturesForPeriod(projectId, { from, to, pageSize = 1000 } = {}) {
  if (!db.isDatabaseConfigured()) return [];

  // Paged, not capped.
  //
  // This took .limit(20000) ordered OLDEST first, which at the design volume of
  // ~2,800 captures a day is under nine days for a single client. Every metric
  // would then be computed on a truncated slice — and because the order was
  // ascending, the part dropped was the RECENT part, so a report could be built
  // entirely from stale captures while saying nothing. Coverage would not catch
  // it either: it divides two numbers from the same truncated set.
  const rows = [];
  // MAX_PAGES is a guard against a provider that never returns a short page,
  // not an expected limit: 200 x 1000 is far beyond any real period.
  const MAX_PAGES = 200;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      throw new Error(`[aiVisibility.store] capturesForPeriod exceeded ${MAX_PAGES} pages `
        + `for project ${projectId} — refusing to report on a partial read.`);
    }
    const offset = page * pageSize;
    const params = [projectId];
    const where = ['project_id = $1'];
    if (from) {
      params.push(`${String(from).slice(0, 10)}T00:00:00Z`);
      where.push(`captured_at >= $${params.length}`);
    }
    if (to) {
      params.push(`${String(to).slice(0, 10)}T23:59:59.999Z`);
      where.push(`captured_at <= $${params.length}`);
    }
    params.push(pageSize, offset);

    let data;
    try {
      // eslint-disable-next-line no-await-in-loop
      data = await db.rows(
        `select ${CAPTURE_REPORT_COLUMNS}
           from ai_visibility_captures
          where ${where.join(' and ')}
          -- id breaks ties. captured_at is NOT unique — a run writes dozens of
          -- rows within the same second — and Postgres gives no stable order
          -- among equal sort keys, so a page boundary landing inside a tie
          -- could drop or duplicate captures, silently moving every denominator.
          order by captured_at asc, id asc
          limit $${params.length - 1} offset $${params.length}`,
        params
      );
    } catch (error) {
      if (isMissingTable(error)) return [];
      fail('capturesForPeriod', error);
    }
    rows.push(...data);
    if (data.length < pageSize) break;
  }

  return rows.map((row) => ({
    ...captureView(row),
    features: row.features || [],
    offGeo: Boolean(row.off_geo),
    extractionVersion: row.extraction_version,
    extractedAt: row.extracted_at,
  }));
}

function mentionView(row) {
  return {
    id: row.id,
    captureId: row.capture_id,
    brandId: row.brand_id,
    ordinal: row.ordinal,
    charOffset: row.char_offset,
    mentionCount: row.mention_count,
    // Stays null when unscored — the metrics layer counts on being able to
    // tell "not scored" from "scored neutral".
    sentimentScore: row.sentiment_score === null ? null : Number(row.sentiment_score),
    negated: Boolean(row.negated),
    isClient: Boolean(row.is_client),
    evidence: row.evidence,
  };
}

function citationView(row) {
  return {
    id: row.id,
    captureId: row.capture_id,
    url: row.url,
    domain: row.domain,
    host: row.host,
    isInlineCited: Boolean(row.is_inline_cited),
    isRetrieved: Boolean(row.is_retrieved),
    position: row.position,
    occurrences: row.occurrences,
    urlType: row.url_type,
    domainType: row.domain_type,
    rulesetVersion: row.ruleset_version,
    title: row.title,
  };
}

/**
 * Mentions, citations and attributes for a set of captures.
 *
 * No longer chunked. The 500-id batches existed because PostgREST built
 * `in.(…)` into the URL and a 2,800-capture period overflowed the request line;
 * the ids are bound as one array parameter now, so each table is a single query
 * however long the period is.
 */
async function entitiesForCaptures(captureIds = []) {
  const empty = { mentions: [], citations: [], attributes: [] };
  if (!db.isDatabaseConfigured() || !captureIds.length) return empty;

  const attributeView = (row) => ({
    id: row.id,
    captureId: row.capture_id,
    brandId: row.brand_id,
    term: row.term,
    attributeId: row.attribute_id,
    occurrences: row.occurrences,
    mappingVersion: row.mapping_version,
  });

  const out = { mentions: [], citations: [], attributes: [] };
  const reads = [
    ['mentions', mentionView, `select id, capture_id, brand_id, ordinal, char_offset,
        mention_count, sentiment_score, negated, is_client, evidence
        from capture_mention where capture_id = any($1)`],
    ['citations', citationView, `select id, capture_id, url, domain, host, is_inline_cited,
        is_retrieved, position, occurrences, url_type, domain_type, ruleset_version, title
        from capture_citation where capture_id = any($1)`],
    ['attributes', attributeView, `select id, capture_id, brand_id, term, attribute_id,
        occurrences, mapping_version
        from capture_attribute where capture_id = any($1)`],
  ];

  for (const [key, view, sql] of reads) {
    let data;
    try {
      // eslint-disable-next-line no-await-in-loop
      data = await db.rows(sql, [captureIds]);
    } catch (error) {
      // A missing table means 0018 has not been applied. Returning empty
      // rather than throwing lets the report render its empty states, which
      // say "not extracted" — the honest answer — instead of a 500.
      //
      // `out`, not `empty`: tables already read are kept, so a failure on a
      // later one cannot turn into a silent, partial "nothing extracted".
      if (isMissingTable(error)) return out;
      fail('entitiesForCaptures', error);
    }
    out[key].push(...data.map(view));
  }
  return out;
}

/**
 * One capture with its whole answer.
 *
 * Every list read deliberately trims `answer_text` down or omits it — a
 * 50-prompt period holds megabytes of prose and no table needs it. This is the
 * one read that returns the answer as stored, for a reader who has clicked
 * into a single row and wants the evidence rather than a summary of it.
 *
 * `raw` is still excluded: it is the whole provider payload, it is kept for 12
 * months as the audit trail, and nothing in the UI reads it.
 */
async function captureDetail(projectId, captureId) {
  if (!db.isDatabaseConfigured()) return null;
  let data;
  try {
    data = await db.maybeOne(
      `select id, prompt_id, prompt_text, engine, provider, access, surface_label, status,
              failure_reason, answer_text, citations, mentioned, cited, prominence,
              competitors_mentioned, web_queries, model_version, task_cost, features,
              off_geo, extraction_version, extracted_at, captured_at
         from ai_visibility_captures
        where project_id = $1 and id = $2`,
      [projectId, captureId]
    );
  } catch (error) {
    if (isMissingTable(error)) return null;
    fail('captureDetail', error);
  }
  if (!data) return null;

  return {
    ...captureView(data),
    features: data.features || [],
    offGeo: Boolean(data.off_geo),
    extractedAt: data.extracted_at,
    extractionVersion: data.extraction_version,
  };
}

module.exports = {
  listPrompts,
  countPromptsByStatus,
  countPromptsBySlot,
  getPrompt,
  addPrompts,
  saveGeneratedDraft,
  updatePrompt,
  transitionPrompt,
  approvePrompts,
  retirePrompt,
  restorePrompt,
  saveCaptures,
  listBrands,
  measuredSet,
  upsertBrands,
  transitionBrand,
  brandView,
  saveMentions,
  saveCitations,
  saveAttributes,
  markExtracted,
  capturesPendingExtraction,
  capturesForPeriod,
  capturesForRuns,
  captureDetail,
  entitiesForCaptures,
  mentionView,
  citationView,
  promptView,
  captureView,
  isMissingTable,
  migrationNeeded,
};
