// ── Persistence for ai_visibility_lite ───────────────────────────────────────
//
// Tables from 0030. Every query carries its own project filter, which IS the
// tenancy check — the same arrangement as 0012–0016, with no RLS behind it.
//
// Three things here are deliberate rather than incidental:
//
//   "Delete" is a RETIRE. The product offers a delete button and this file sets
//   active = false. Both halves matter: the slot is freed against the 20-prompt
//   cap, so the button does what it promises, while the row survives so the
//   captures pointing at it still know what they asked. A hard delete would
//   null prompt_id on historical captures and rewrite the evidence the numbers
//   were computed from.
//
//   Captures store `prompt_text` as sent, not just `prompt_id`. Editing a
//   prompt later must not change what an old capture claims it asked.
//
//   The run cap is counted HERE, from stored rows, not tracked in a counter
//   column. A counter can drift; `select count(*)` cannot.

const db = require('../../services/db');
const auditEvents = require('../../services/auditEvents');
const { MAX_PROMPTS, MAX_RUNS_PER_PROJECT } = require('./models');

// Audit actions for this module. Defined here rather than added to
// services/auditEvents.js ACTIONS: `record` takes the action as a free string
// and validates nothing, so a local constant keeps this module's footprint on
// shared infrastructure at zero without losing the trail.
const ACTIONS = {
  PROMPT_ADDED: 'ai_visibility_lite_prompt.added',
  PROMPT_EDITED: 'ai_visibility_lite_prompt.edited',
  PROMPT_DELETED: 'ai_visibility_lite_prompt.deleted',
  PROFILE_BUILT: 'ai_visibility_lite_profile.built',
};

function fail(op, error) {
  throw new Error(`[aiVisibilityLite.${op}] ${error.message || error}`);
}

function notConfigured() {
  return Object.assign(
    new Error('AI Visibility Lite needs the database configured.'),
    { status: 503, code: 'not_configured' },
  );
}

function notFound() {
  return Object.assign(new Error('Prompt not found.'), { status: 404 });
}

function conflict(message, code = null) {
  return Object.assign(new Error(message), { status: 409, ...(code ? { code } : {}) });
}

// Warn once per missing object rather than per call. Silence was the real
// problem in v1: every reader returns [] on a missing table, so a migration
// nobody applied reads exactly like a client with no data.
const _warnedMissing = new Set();
function warnMissingOnce(message) {
  const text = String(message || '');
  const key = text.match(/"([\w.]+)"/)?.[1] || text.match(/'([\w.]+)'/)?.[1] || 'unknown';
  if (_warnedMissing.has(key)) return;
  _warnedMissing.add(key);
  console.warn(`[aiVisibilityLite.store] missing schema object: ${key}. `
    + 'Migration 0030_ai_visibility_lite.sql has not been applied — reads will '
    + 'return empty until it is.');
}

function isMissingTable(error) {
  if (!error) return false;
  const message = error.message || '';
  const missing = error.code === '42P01'
    || error.code === '42703'
    || /relation .* does not exist/i.test(message)
    || /column .* does not exist/i.test(message);
  if (missing) warnMissingOnce(message);
  return missing;
}

function migrationNeeded() {
  return Object.assign(
    new Error('AI Visibility Lite needs migration 0030_ai_visibility_lite.sql applied.'),
    { status: 503, code: 'migration_needed' },
  );
}

function requireDb() {
  if (!db.isDatabaseConfigured()) throw notConfigured();
}

// ── The business profile ───────────────────────────────────────────────────

function profileView(row) {
  if (!row) return null;
  return {
    id: row.id,
    businessName: row.business_name,
    summary: row.summary,
    products: row.products || [],
    services: row.services || [],
    brandAliases: row.brand_aliases || [],
    competitors: row.competitors || [],
    locations: row.locations || [],
    sourceUrls: row.source_urls || [],
    modelVersion: row.model_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getProfile(projectId) {
  requireDb();
  try {
    const row = await db.maybeOne(
      `select * from aiv_lite_profiles where project_id = $1`,
      [projectId],
    );
    return profileView(row);
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    return fail('getProfile', error);
  }
}

/**
 * Write the profile, replacing any previous one.
 *
 * Upsert rather than insert: regenerating must overwrite, because a second row
 * would leave "which profile wrote these prompts" unanswerable.
 */
async function saveProfile({ access, profile }) {
  requireDb();
  const row = {
    project_id: access.project.id,
    workspace_id: access.project.workspace_id || null,
    business_name: profile.businessName,
    summary: profile.summary || null,
    products: db.json(profile.products || []),
    services: db.json(profile.services || []),
    brand_aliases: db.json(profile.brandAliases || []),
    competitors: db.json(profile.competitors || []),
    locations: db.json(profile.locations || []),
    source_urls: db.json(profile.sourceUrls || []),
    model_version: profile.modelVersion || null,
  };

  let saved;
  try {
    saved = await db.one(
      `insert into aiv_lite_profiles
         (project_id, workspace_id, business_name, summary, products, services,
          brand_aliases, competitors, locations, source_urls, model_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (project_id) do update set
         business_name = excluded.business_name,
         summary       = excluded.summary,
         products      = excluded.products,
         services      = excluded.services,
         brand_aliases = excluded.brand_aliases,
         competitors   = excluded.competitors,
         locations     = excluded.locations,
         source_urls   = excluded.source_urls,
         model_version = excluded.model_version,
         updated_at    = now()
       returning *`,
      Object.values(row),
    );
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    return fail('saveProfile', error);
  }

  auditEvents.record({
    workspaceId: access.workspaceId || access.project?.workspace_id || null,
    projectId: access.project.id,
    actorUserId: access.userId || null,
    actorEmail: access.actorEmail || null,
    actorRole: access.role || null,
    action: ACTIONS.PROFILE_BUILT,
    entityType: 'ai_visibility_lite_profile',
    entityId: saved.id,
    newState: { businessName: saved.business_name, sources: (profile.sourceUrls || []).length },
  });

  return profileView(saved);
}

// ── Prompts ────────────────────────────────────────────────────────────────

const PROMPT_COLUMNS = [
  'id', 'project_id', 'text', 'source', 'intent', 'active', 'retired_at',
  'created_by', 'created_at', 'updated_at',
].join(', ');

function promptView(row) {
  return {
    id: row.id,
    text: row.text,
    // Display only. Nothing downstream branches on it — an auto-written prompt
    // and a typed one are measured, edited and deleted identically, which is a
    // product requirement rather than an implementation detail.
    source: row.source,
    intent: row.intent,
    active: row.active,
    retiredAt: row.retired_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The project's prompts, oldest first.
 *
 * Retired ones are excluded by default — they are "deleted" as far as the
 * product is concerned, and a caller that wants them has to say so.
 */
async function listPrompts(projectId, { includeRetired = false } = {}) {
  requireDb();
  try {
    const rows = await db.rows(
      `select ${PROMPT_COLUMNS} from aiv_lite_prompts
        where project_id = $1${includeRetired ? '' : ' and active'}
        order by created_at asc`,
      [projectId],
    );
    return rows.map(promptView);
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    return fail('listPrompts', error);
  }
}

/** How many live prompts the project has. The number the 20-cap is checked against. */
async function countActivePrompts(projectId) {
  requireDb();
  try {
    return await db.count(
      `select count(*) from aiv_lite_prompts where project_id = $1 and active`,
      [projectId],
    );
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    return fail('countActivePrompts', error);
  }
}

/**
 * Add prompts, refusing to exceed the cap.
 *
 * The cap is checked against a fresh count inside this call rather than trusted
 * from the caller, so two requests racing cannot both be told there is room.
 * The unique index on (project_id, lower(btrim(text))) where active is the
 * backstop for the same race on duplicates.
 *
 * @returns {Promise<{added: object[], skipped: Array<{text, reason}>}>}
 */
async function addPrompts({ access, prompts, source = 'custom' }) {
  requireDb();
  const projectId = access.project.id;
  const wanted = (prompts || [])
    .map((p) => (typeof p === 'string' ? { text: p } : p))
    .map((p) => ({ ...p, text: String(p.text || '').trim() }))
    .filter((p) => p.text);

  if (!wanted.length) return { added: [], skipped: [] };

  const used = await countActivePrompts(projectId);
  const room = MAX_PROMPTS - used;
  if (room <= 0) {
    throw conflict(
      `This project already has its ${MAX_PROMPTS} prompts. Delete one to make room.`,
      'prompt_cap_reached',
    );
  }

  const added = [];
  const skipped = [];

  for (const p of wanted) {
    if (added.length >= room) {
      skipped.push({ text: p.text, reason: `would exceed the ${MAX_PROMPTS}-prompt limit` });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const row = await db.one(
        `insert into aiv_lite_prompts
           (project_id, workspace_id, text, source, intent, created_by)
         values ($1, $2, $3, $4, $5, $6)
         returning ${PROMPT_COLUMNS}`,
        [
          projectId,
          access.project.workspace_id || null,
          p.text,
          source,
          p.intent || null,
          access.actorEmail || null,
        ],
      );
      added.push(promptView(row));
    } catch (error) {
      if (isMissingTable(error)) throw migrationNeeded();
      if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
        skipped.push({ text: p.text, reason: 'this project already asks that question' });
        continue;
      }
      return fail('addPrompts', error);
    }
  }

  if (added.length) {
    auditEvents.record({
      workspaceId: access.workspaceId || access.project?.workspace_id || null,
      projectId,
      actorUserId: access.userId || null,
      actorEmail: access.actorEmail || null,
      actorRole: access.role || null,
      action: ACTIONS.PROMPT_ADDED,
      entityType: 'ai_visibility_lite_prompt',
      entityId: added[0].id,
      newState: { count: added.length, source },
    });
  }

  return { added, skipped };
}

/** Change a prompt's wording. */
async function updatePrompt({ access, promptId, text, intent }) {
  requireDb();
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw Object.assign(new Error('A prompt needs some text.'), { status: 400 });
  }

  let row;
  try {
    row = await db.maybeOne(
      `update aiv_lite_prompts
          set text = $1, intent = coalesce($2, intent)
        where id = $3 and project_id = $4 and active
        returning ${PROMPT_COLUMNS}`,
      [trimmed, intent || null, promptId, access.project.id],
    );
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
      throw conflict('Another prompt already asks this question.');
    }
    return fail('updatePrompt', error);
  }
  if (!row) throw notFound();

  auditEvents.record({
    workspaceId: access.workspaceId || access.project?.workspace_id || null,
    projectId: access.project.id,
    actorUserId: access.userId || null,
    actorEmail: access.actorEmail || null,
    actorRole: access.role || null,
    action: ACTIONS.PROMPT_EDITED,
    entityType: 'ai_visibility_lite_prompt',
    entityId: promptId,
    newState: { text: trimmed },
  });

  return promptView(row);
}

/**
 * Delete a prompt — which is a retire. See the file header for why.
 *
 * Idempotent: deleting an already-deleted prompt is not an error, because the
 * only way a caller gets here twice is a double-click.
 */
async function deletePrompt({ access, promptId }) {
  requireDb();
  let row;
  try {
    row = await db.maybeOne(
      `update aiv_lite_prompts
          set active = false, retired_at = now()
        where id = $1 and project_id = $2 and active
        returning ${PROMPT_COLUMNS}`,
      [promptId, access.project.id],
    );
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    return fail('deletePrompt', error);
  }
  if (!row) {
    // Either it never existed or it is already gone. Distinguish, so a genuine
    // wrong id is still reported.
    const exists = await db.maybeOne(
      `select id from aiv_lite_prompts where id = $1 and project_id = $2`,
      [promptId, access.project.id],
    );
    if (!exists) throw notFound();
    return null;
  }

  auditEvents.record({
    workspaceId: access.workspaceId || access.project?.workspace_id || null,
    projectId: access.project.id,
    actorUserId: access.userId || null,
    actorEmail: access.actorEmail || null,
    actorRole: access.role || null,
    action: ACTIONS.PROMPT_DELETED,
    entityType: 'ai_visibility_lite_prompt',
    entityId: promptId,
    oldState: { text: row.text, source: row.source },
  });

  return promptView(row);
}

// ── Captures ───────────────────────────────────────────────────────────────

const CAPTURE_COLUMNS = [
  'id', 'run_id', 'prompt_id', 'project_id', 'prompt_text', 'engine', 'provider',
  'access', 'surface_label', 'status', 'failure_reason', 'answer_text', 'citations',
  'mentioned', 'cited', 'prominence', 'competitors_mentioned', 'web_queries',
  'grounded', 'model_version', 'task_cost', 'captured_at',
].join(', ');

/**
 * A stored capture, in the shape v1's reusable metric functions read.
 *
 * camelCase, and that is not cosmetic — it is the contract. scoring.js,
 * metrics/core.js `coverage`/`scopeCaptures` and metrics/period.js `split` all
 * read `promptId`, `capturedAt`, `answerText`, `surfaceLabel`, `taskCost` and
 * `status` off a capture. Returning the raw snake_case row here would make
 * every one of them silently see `undefined`: `scopeCaptures` would drop every
 * row, `split` would bucket everything as undated, and the reports would come
 * back empty rather than wrong — which is harder to notice, not easier.
 *
 * `offGeo` is hard-coded false. v1 sets it when a scraped answer came back
 * localised to the wrong market, which is a property of driving a consumer UI
 * through a proxy. An API call has no geography to get wrong, so the flag is
 * constant here — but `scopeCaptures` reads it on every row, and leaving it
 * undefined would work by accident rather than by intent.
 */
function captureRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
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
    competitorsMentioned: row.competitors_mentioned || [],
    webQueries: row.web_queries || [],
    grounded: row.grounded,
    modelVersion: row.model_version,
    capturedAt: row.captured_at,
    offGeo: false,
    // numeric comes back from pg as a string; every metric that touches these
    // divides or compares them, and '0.5' > 0.4 is false.
    prominence: row.prominence === null ? null : Number(row.prominence),
    taskCost: row.task_cost === null ? null : Number(row.task_cost),
  };
}

/** Write one run's captures in a single statement. */
async function saveCaptures({ access, runId, rows }) {
  requireDb();
  if (!rows?.length) return [];

  const records = rows.map((r) => ({
    run_id: runId,
    prompt_id: r.promptId || null,
    project_id: access.project.id,
    workspace_id: access.project.workspace_id || null,
    prompt_text: r.prompt,
    engine: r.engine,
    provider: r.provider,
    access: r.access || 'api',
    surface_label: r.surfaceLabel,
    status: r.status,
    failure_reason: r.failureReason || null,
    answer_text: r.answerText || null,
    citations: db.json(r.citations || []),
    mentioned: r.mentioned,
    cited: r.cited,
    prominence: r.prominence,
    competitors_mentioned: db.json(r.competitorsMentioned || []),
    web_queries: db.json(r.webQueries || []),
    grounded: r.grounded ?? null,
    model_version: r.modelVersion || null,
    task_cost: r.taskCost ?? null,
    raw: db.json(r.raw || null),
    captured_at: r.capturedAt || new Date().toISOString(),
  }));

  try {
    return await db.insertMany('aiv_lite_captures', records, { returning: 'id' });
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    return fail('saveCaptures', error);
  }
}

/** Every capture for one run. */
async function capturesForRun(projectId, runId) {
  requireDb();
  try {
    const rows = await db.rows(
      `select ${CAPTURE_COLUMNS} from aiv_lite_captures
        where project_id = $1 and run_id = $2
        order by captured_at asc`,
      [projectId, runId],
    );
    return rows.map(captureRow);
  } catch (error) {
    if (isMissingTable(error)) return [];
    return fail('capturesForRun', error);
  }
}

/**
 * Every capture for a project, for the metric layer to scope.
 *
 * Deliberately unfiltered by date: metrics/period.js does the period split and
 * the prompt-set intersection itself, and pre-filtering here would hide the
 * comparison period it needs to compute a delta.
 */
async function capturesForProject(projectId, { limit = 20_000 } = {}) {
  requireDb();
  try {
    const rows = await db.rows(
      `select ${CAPTURE_COLUMNS} from aiv_lite_captures
        where project_id = $1
        order by captured_at asc
        limit $2`,
      [projectId, limit],
    );
    return rows.map(captureRow);
  } catch (error) {
    if (isMissingTable(error)) return [];
    return fail('capturesForProject', error);
  }
}

// ── The run budget ─────────────────────────────────────────────────────────

/**
 * How many measurement runs this project has spent, and what is left.
 *
 * Counted from project_module_runs rather than a counter column, so it cannot
 * drift. Setup runs are excluded by the module key — identifying the business
 * is not a measurement, and charging a run for it would mean a project that
 * regenerated its prompts got fewer measurements than one that did not.
 *
 * Cancelled and failed runs COUNT. They cost real API calls; a cap that only
 * counted successes would let a project with a broken key retry forever.
 *
 * QUEUED runs do not. A row waiting to be claimed has spent nothing, and one
 * that is never claimed — which is what happens when no module worker is
 * running — would otherwise burn a run from the budget for a measurement that
 * never happened. It starts counting the moment it reaches 'running', which is
 * also the moment it starts costing money.
 */
async function runBudget(projectId) {
  requireDb();
  let used = 0;
  try {
    used = await db.count(
      `select count(*) from project_module_runs
        where project_id = $1 and module_key = 'ai_visibility_lite'
          and status <> 'queued'`,
      [projectId],
    );
  } catch (error) {
    if (isMissingTable(error)) throw migrationNeeded();
    return fail('runBudget', error);
  }
  return {
    used,
    cap: MAX_RUNS_PER_PROJECT,
    remaining: Math.max(0, MAX_RUNS_PER_PROJECT - used),
  };
}

module.exports = {
  ACTIONS,
  isMissingTable,
  migrationNeeded,
  notConfigured,
  getProfile,
  saveProfile,
  listPrompts,
  countActivePrompts,
  addPrompts,
  updatePrompt,
  deletePrompt,
  saveCaptures,
  capturesForRun,
  capturesForProject,
  runBudget,
  promptView,
  captureRow,
};
