// ── Crawl / AI limits and budgets (PRD §10.2, §20.10, §30.5, AC-003) ────────
// Two rules, and the whole file exists to honour them:
//
//   1. "The effective limit is the most restrictive applicable platform,
//      workspace, project-tier and provider limit. Show the effective value and
//      source in the admin UI." (§10.2) — so resolution returns not just a
//      number but where the number came from.
//
//   2. "Admin changes create new versioned policies; do not rewrite historical
//      effective limits." (§20.10) — so a change is an INSERT of version N+1.
//      The table's append-only trigger enforces that even against direct SQL.
//
// Most restrictive is per-key, not global: for a ceiling like maxUrlsPerCrawl
// the smaller number restricts more, but for a floor like
// scheduleMinIntervalHours the *larger* number does. Getting that backwards
// would quietly let a workspace policy loosen a platform cap, so the direction
// is declared per key below rather than inferred.

const { getSupabase, isSupabaseConfigured } = require('./supabase');
const auditEvents = require('./auditEvents');

// Seeded defaults, mirroring migration 0011's platform version 1. Kept here as
// the fallback for a server running without Supabase, and as the schema of what
// a policy may contain — an unknown key in a submitted policy is rejected.
const DEFAULT_LIMITS = {
  maxUrlsPerCrawl:          5000,   // PRD §3.1.2 — the approved initial cap
  maxCrawlDepth:            10,
  scheduleMinIntervalHours: 24,     // weekly is the initial recurrence (§3.1.3)
  perProjectConcurrency:    1,
  globalCrawlConcurrency:   3,
  requestTimeoutMs:         30000,
  renderTimeoutMs:          45000,
  renderBudgetPerRun:       150,
  crawlRetryCount:          2,
  modelCallsPerRun:         500,
  modelSpendPerRunUsd:      5,
  providerCallsPerDay:      5000,
  gscFreshnessDays:         3,      // §16.4 default GSC freshness delay
  measurementRetryDays:     14,
  rawHtmlRetentionMonths:   12,     // §3.1.7 — 12 months of raw HTML
  exportRetentionMonths:    12,
  workspacePurgeGraceDays:  30,     // §3.3.4 — 30-day recoverable deletion
  // How many crawled pages one module audit may cover.
  //
  // SEO & GEO, On-Page and Agent Readiness audit a page at a time, so a project
  // audit is per-page work: measured at 130s, 32s and 20s per page respectively.
  // Auditing all 50 pages of a small site with all three would take about two
  // and a half hours and spend a model call per page.
  //
  // 10 keeps a full audit inside about half an hour. Raise it when a deeper pass
  // is worth the wait; the audit always reports how many of the crawled pages it
  // covered, so a budget can never be mistaken for the whole site.
  maxPagesPerModuleAudit:   10,
  // How many prompts one AI Visibility question set may hold. Each ChatGPT
  // capture is 25-110s and costs real money, so this is the knob that bounds a
  // single generation/measurement run's spend, not a content-quality setting.
  maxPromptsPerVisibilityRun: 20,
};

// How to combine two values for the same key.
//   'min'      — a ceiling; the lower value restricts more
//   'max'      — a floor or a required wait; the higher value restricts more
//   'specific' — not a resource limit, so "restrictive" is meaningless.
//                Most specific scope wins (tier → workspace → platform).
const DIRECTION = {
  maxUrlsPerCrawl:          'min',
  maxCrawlDepth:            'min',
  scheduleMinIntervalHours: 'max',
  perProjectConcurrency:    'min',
  globalCrawlConcurrency:   'min',
  requestTimeoutMs:         'min',
  renderTimeoutMs:          'min',
  renderBudgetPerRun:       'min',
  crawlRetryCount:          'min',
  modelCallsPerRun:         'min',
  modelSpendPerRunUsd:      'min',
  providerCallsPerDay:      'min',
  gscFreshnessDays:         'max',  // waiting longer for fresh data is the conservative choice
  measurementRetryDays:     'min',
  rawHtmlRetentionMonths:   'min',  // holding customer HTML for less time restricts more
  exportRetentionMonths:    'min',
  // The recovery window is a user protection, not a resource cap: shrinking it
  // is not "more restrictive", it is more destructive. Most specific wins.
  workspacePurgeGraceDays:  'specific',
  // A ceiling: the lower of two policies restricts more.
  maxPagesPerModuleAudit:   'min',
  maxPromptsPerVisibilityRun: 'min',
};

const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS);

// Scope precedence, least to most specific. Used only by 'specific' keys.
const SCOPE_RANK = { platform: 0, workspace: 1, tier: 2 };

function fail(op, error) {
  throw new Error(`[adminLimits.${op}] ${error.message || error}`);
}

/**
 * Validates a submitted limits object. Unknown keys are rejected rather than
 * silently dropped: a policy that looks saved but enforces nothing is worse
 * than a rejected one.
 */
function validateLimits(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw Object.assign(new Error('limits must be an object.'), { status: 400 });
  }
  const unknown = Object.keys(limits).filter((k) => !LIMIT_KEYS.includes(k));
  if (unknown.length) {
    throw Object.assign(
      new Error(`Unknown limit key(s): ${unknown.join(', ')}. Known keys: ${LIMIT_KEYS.join(', ')}.`),
      { status: 400 },
    );
  }
  const out = {};
  for (const [key, raw] of Object.entries(limits)) {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw Object.assign(new Error(`${key} must be a non-negative number.`), { status: 400 });
    }
    out[key] = value;
  }
  if (!Object.keys(out).length) {
    throw Object.assign(new Error('A policy must set at least one limit.'), { status: 400 });
  }
  return out;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** The newest version of one policy scope, or null. */
async function latestPolicy(scope, scopeRef = null) {
  if (!isSupabaseConfigured()) return null;
  let query = getSupabase()
    .from('admin_limit_policies')
    .select('*')
    .eq('scope', scope)
    .order('version', { ascending: false })
    .limit(1);
  query = scopeRef === null ? query.is('scope_ref', null) : query.eq('scope_ref', scopeRef);

  const { data, error } = await query;
  if (error) fail('latestPolicy', error);
  return (data && data[0]) || null;
}

/**
 * Combines policy layers into one effective limit set. Pure — no database — so
 * the precedence rules are unit-testable, which matters because getting a
 * direction backwards silently lets a narrower policy *loosen* a platform cap.
 *
 * @param {Array<{scope: string, limits: object}|null>} layers
 *   in ascending specificity: platform, then workspace, then tier
 * @returns {{limits: object, sources: object}}
 */
function combine(layers = []) {
  const limits = { ...DEFAULT_LIMITS };
  const sources = Object.fromEntries(LIMIT_KEYS.map((k) => [k, 'default']));

  for (const layer of layers) {
    if (!layer?.limits) continue;
    for (const [key, raw] of Object.entries(layer.limits)) {
      if (!LIMIT_KEYS.includes(key)) continue;      // stale key from an older schema
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;

      const current = limits[key];
      const currentSource = sources[key];
      const direction = DIRECTION[key] || 'min';

      let wins;
      if (currentSource === 'default') {
        wins = true;                                 // the first real policy always applies
      } else if (direction === 'specific') {
        wins = SCOPE_RANK[layer.scope] >= SCOPE_RANK[currentSource];
      } else if (direction === 'max') {
        wins = value > current;
      } else {
        wins = value < current;
      }

      if (wins) {
        limits[key] = value;
        sources[key] = layer.scope;
      }
    }
  }

  return { limits, sources };
}

/**
 * Resolves the limits that apply to a request.
 *
 * @param {object} [scopeInput]
 * @param {string} [scopeInput.workspaceId]
 * @param {string} [scopeInput.tier]        site-size tier (PRD §3.3.3, §10.2)
 * @returns {Promise<{limits: object, sources: object, policies: object}>}
 *   limits   — key → effective number
 *   sources  — key → 'platform' | 'workspace' | 'tier' | 'default'
 *   policies — the policy rows that took part, for the admin UI
 */
async function effectiveLimits({ workspaceId = null, tier = null } = {}) {
  const policies = { platform: null, workspace: null, tier: null };

  if (!isSupabaseConfigured()) return { ...combine([]), policies };

  const [platform, workspace, tierPolicy] = await Promise.all([
    latestPolicy('platform'),
    workspaceId ? latestPolicy('workspace', workspaceId) : null,
    tier ? latestPolicy('tier', tier) : null,
  ]);
  policies.platform = platform;
  policies.workspace = workspace;
  policies.tier = tierPolicy;

  return { ...combine([platform, workspace, tierPolicy]), policies };
}

/** One effective limit, for call sites that only need a single number. */
async function limit(key, scopeInput) {
  const { limits } = await effectiveLimits(scopeInput);
  return limits[key];
}

/**
 * Clamps a requested value to the effective limit and says whether it moved —
 * so a caller can tell the user "we capped this at 5,000" rather than silently
 * crawling less than they asked for (PRD §30, last paragraph: expose the gap).
 */
async function clamp(key, requested, scopeInput) {
  const { limits, sources } = await effectiveLimits(scopeInput);
  const max = limits[key];
  const value = Number(requested);
  if (!Number.isFinite(value)) return { value: max, clamped: true, limit: max, source: sources[key] };
  const direction = DIRECTION[key] || 'min';
  const effective = direction === 'max' ? Math.max(value, max) : Math.min(value, max);
  return { value: effective, clamped: effective !== value, limit: max, source: sources[key] };
}

async function listPolicies({ scope = null, scopeRef = null, limit: rowLimit = 50 } = {}) {
  if (!isSupabaseConfigured()) return [];
  let query = getSupabase()
    .from('admin_limit_policies')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(parseInt(rowLimit, 10) || 50, 1), 200));
  if (scope) query = query.eq('scope', scope);
  if (scopeRef) query = query.eq('scope_ref', scopeRef);

  const { data, error } = await query;
  if (error) fail('listPolicies', error);
  return data || [];
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Creates the next version of a policy scope. Never updates an existing row —
 * the table's trigger would reject it, and the point is that a historical
 * effective limit stays readable (§20.10).
 */
async function createVersion({ scope, scopeRef = null, limits, note, actorUserId, actorEmail }) {
  if (!isSupabaseConfigured()) {
    throw Object.assign(new Error('Limit policies need Supabase configured.'), { status: 503 });
  }
  if (!['platform', 'workspace', 'tier'].includes(scope)) {
    throw Object.assign(new Error("scope must be 'platform', 'workspace' or 'tier'."), { status: 400 });
  }
  if (scope === 'platform' && scopeRef) {
    throw Object.assign(new Error('platform policies do not take a scopeRef.'), { status: 400 });
  }
  if (scope !== 'platform' && !scopeRef) {
    throw Object.assign(new Error(`${scope} policies need a scopeRef.`), { status: 400 });
  }

  const validated = validateLimits(limits);
  const previous = await latestPolicy(scope, scopeRef);
  const version = (previous?.version || 0) + 1;

  const { data, error } = await getSupabase()
    .from('admin_limit_policies')
    .insert({
      scope,
      scope_ref: scopeRef,
      version,
      limits: validated,
      note: note || null,
      created_by: actorUserId || null,
    })
    .select('*')
    .single();
  // Two administrators saving at once: the unique index on
  // (scope, scope_ref, version) rejects the loser rather than overwriting.
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      throw Object.assign(
        new Error('Someone else just saved a new version — reload and reapply your change.'),
        { status: 409 },
      );
    }
    fail('createVersion', error);
  }

  await auditEvents.record({
    action: auditEvents.ACTIONS.LIMITS_VERSION_CREATED,
    entityType: 'admin_limit_policy',
    entityId: data.id,
    workspaceId: scope === 'workspace' ? scopeRef : null,
    actorUserId,
    actorEmail,
    oldState: previous ? { version: previous.version, limits: previous.limits } : null,
    newState: { version, scope, scopeRef, limits: validated },
    source: 'admin.limits',
  }, { strict: true });

  return data;
}

module.exports = {
  DEFAULT_LIMITS,
  LIMIT_KEYS,
  DIRECTION,
  validateLimits,
  combine,
  latestPolicy,
  effectiveLimits,
  limit,
  clamp,
  listPolicies,
  createVersion,
};
