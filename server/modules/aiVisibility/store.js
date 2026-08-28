// ── Persistence for ai_visibility ────────────────────────────────────────────
//
// Tables from 0016. Every query carries its own project filter, which IS the
// tenancy check — there is no RLS behind it (same as 0012–0015).
//
// Two things here are deliberate rather than incidental:
//
//   Prompts are RETIRED, never deleted. A prompt removed from the set still has
//   captures behind it, and deleting it would rewrite the history those numbers
//   were computed from.
//
//   Captures store `prompt_text` as sent, not just `prompt_id`. Editing a prompt
//   later must not change what an old capture claims it asked.

const { getSupabase, isSupabaseConfigured } = require('../../services/supabase');

function fail(op, error) {
  throw new Error(`[aiVisibility.${op}] ${error.message || error}`);
}

function notConfigured() {
  return Object.assign(
    new Error('AI Visibility needs Supabase configured.'),
    { status: 503, code: 'not_configured' },
  );
}

/**
 * The table is missing until 0016 is applied. Say so rather than 500ing.
 *
 * Three spellings, because the answer arrives differently depending on who is
 * complaining. Postgres itself raises 42P01 "relation ... does not exist", but
 * PostgREST answers from its own schema cache first and says "Could not find
 * the table 'public.x' in the schema cache" with a PGRST2xx code — which the
 * first two patterns do not match at all.
 *
 * Verified against the live database before 0016 was applied: only the third
 * pattern fired, so without it the friendly message never appeared and an
 * operator saw a raw schema-cache error instead of "apply this migration".
 */
function isMissingTable(error) {
  if (!error) return false;
  const message = error.message || '';
  return error.code === '42P01'
    || /^PGRST2\d\d$/.test(error.code || '')
    || /relation .* does not exist/i.test(message)
    || /could not find the table/i.test(message);
}

function migrationNeeded() {
  return Object.assign(
    new Error('AI Visibility needs migration 0016_ai_visibility.sql applied.'),
    { status: 503, code: 'migration_needed' },
  );
}

// ── Prompts ────────────────────────────────────────────────────────────────

/** The active prompt set for a project, oldest first so the order is stable. */
async function listPrompts(projectId, { includeRetired = false } = {}) {
  if (!isSupabaseConfigured()) throw notConfigured();

  let query = getSupabase()
    .from('ai_visibility_prompts')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (!includeRetired) query = query.is('retired_at', null).eq('active', true);

  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    fail('listPrompts', error);
  }
  return (data || []).map(promptView);
}

function promptView(row) {
  return {
    id: row.id,
    text: row.text,
    source: row.source,
    sourceRef: row.source_ref,
    intent: row.intent,
    active: row.active,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
  };
}

/**
 * Add prompts, skipping any the project already has.
 *
 * Upsert on the unique index rather than read-then-write: two people building a
 * set at once would otherwise race and one would get a duplicate-key error for
 * doing nothing wrong.
 */
async function addPrompts({ access, prompts }) {
  if (!isSupabaseConfigured()) throw notConfigured();
  if (!prompts?.length) return [];

  const rows = prompts.map((p) => ({
    project_id: access.project.id,
    workspace_id: access.project.workspace_id || null,
    text: String(p.text).trim(),
    source: p.source || 'manual',
    source_ref: p.sourceRef || null,
    intent: p.intent || null,
    created_by: access.actorEmail || null,
  }));

  const { data, error } = await getSupabase()
    .from('ai_visibility_prompts')
    .upsert(rows, { onConflict: 'project_id,text', ignoreDuplicates: true })
    .select('*');
  if (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    // The unique index is on lower(btrim(text)), which PostgREST cannot name as
    // an onConflict target. Fall back to inserting what is genuinely new.
    if (/on conflict|constraint/i.test(error.message || '')) return insertNewOnly(access, rows);
    fail('addPrompts', error);
  }
  return (data || []).map(promptView);
}

/** Insert only the prompts this project does not already have. */
async function insertNewOnly(access, rows) {
  const existing = await listPrompts(access.project.id, { includeRetired: true });
  const seen = new Set(existing.map((p) => p.text.trim().replace(/\s+/g, ' ').toLowerCase()));
  const fresh = rows.filter((r) => !seen.has(r.text.replace(/\s+/g, ' ').toLowerCase()));
  if (!fresh.length) return [];

  const { data, error } = await getSupabase()
    .from('ai_visibility_prompts').insert(fresh).select('*');
  if (error) fail('insertNewOnly', error);
  return (data || []).map(promptView);
}

/** Retire a prompt. Its captures stay and still count in past runs. */
async function retirePrompt({ access, promptId }) {
  if (!isSupabaseConfigured()) throw notConfigured();
  const { data, error } = await getSupabase()
    .from('ai_visibility_prompts')
    .update({ active: false, retired_at: new Date().toISOString() })
    .eq('id', promptId)
    .eq('project_id', access.project.id)
    .select('*')
    .maybeSingle();
  if (error) fail('retirePrompt', error);
  return data ? promptView(data) : null;
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
  if (!isSupabaseConfigured()) throw notConfigured();
  if (!rows?.length) return 0;

  const records = rows.map((r) => ({
    run_id: runId,
    prompt_id: r.promptId || null,
    project_id: access.project.id,
    workspace_id: access.project.workspace_id || null,
    prompt_text: r.prompt,
    engine: r.engine || 'unknown',
    provider: r.provider || 'unknown',
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
    model_version: r.modelVersion || null,
    task_cost: r.taskCost,
    raw: r.raw || null,
    captured_at: r.capturedAt || new Date().toISOString(),
  }));

  const { error } = await getSupabase().from('ai_visibility_captures').insert(records);
  if (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    fail('saveCaptures', error);
  }
  return records.length;
}

/** Every capture for one run, for rebuilding its report from stored evidence. */
async function capturesForRun(runId) {
  if (!isSupabaseConfigured()) return [];
  const { data, error } = await getSupabase()
    .from('ai_visibility_captures')
    // `raw` is deliberately not selected: it is the whole provider payload and a
    // 50-prompt run holds megabytes of it. Read one row directly when debugging.
    .select('id, prompt_id, prompt_text, engine, provider, access, surface_label, status, '
      + 'failure_reason, answer_text, citations, mentioned, cited, prominence, '
      + 'competitors_mentioned, web_queries, model_version, task_cost, captured_at')
    .eq('run_id', runId)
    .order('captured_at', { ascending: true });
  if (error) {
    if (isMissingTable(error)) return [];
    fail('capturesForRun', error);
  }
  return (data || []).map(captureView);
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

module.exports = {
  listPrompts,
  addPrompts,
  retirePrompt,
  saveCaptures,
  capturesForRun,
  promptView,
  captureView,
  isMissingTable,
  migrationNeeded,
};
