// ── Projects API client ─────────────────────────────────────────────────────
// Mirrors server/modules/projects/routes.js and server/routes/admin.js.
//
// Two conventions worth knowing before reading the callers:
//
//   • The active workspace is never sent from here. The server resolves it from
//     the session (services/workspaceContext.js) and membership-checks anything
//     the client does name, so a project can't be created into a workspace by
//     asking nicely.
//
//   • A 409 from createProject is not a failure — it is the duplicate-domain
//     confirmation the PRD asks for (§18.2). It is surfaced as a typed result
//     rather than an exception so the caller can offer "use it anyway".

const BASE = '/api/projects';
const ADMIN = '/api/admin';

async function req(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });

  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }

  if (!res.ok) {
    const error = new Error(body?.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = body?.code;
    error.body = body;
    throw error;
  }
  return body;
}

export const projectsApi = {
  // ── Projects ──────────────────────────────────────────────────────────────
  list: ({ workspaceId = null, includeDeleted = false } = {}) => {
    const q = new URLSearchParams();
    if (workspaceId) q.set('workspaceId', workspaceId);
    if (includeDeleted) q.set('includeDeleted', '1');
    const qs = q.toString();
    return req(`${BASE}${qs ? `?${qs}` : ''}`);
  },

  get: (projectId) => req(`${BASE}/${projectId}`),

  overview: (projectId) => req(`${BASE}/${projectId}/overview`),

  // Just the live crawl. Cheap enough for the app shell to poll from any screen.
  crawlStatus: (projectId) => req(`${BASE}/${projectId}/crawl-status`),

  /**
   * Creates a project. `primaryDomain` and `country` are both required by the
   * server; a duplicate primary domain in the same workspace comes back as
   * { duplicate: true } instead of throwing, so the caller can confirm and
   * retry with confirmDuplicate.
   */
  create: async (body) => {
    try {
      return await req(BASE, { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      if (e.status === 409 && e.code === 'duplicate_domain') {
        return { duplicate: true, message: e.message, existingProjectId: e.body?.existingProjectId };
      }
      throw e;
    }
  },

  update: (projectId, patch) =>
    req(`${BASE}/${projectId}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  remove: (projectId, reason) =>
    req(`${BASE}/${projectId}`, { method: 'DELETE', body: JSON.stringify({ reason }) }),

  restore: (projectId) => req(`${BASE}/${projectId}/restore`, { method: 'POST' }),

  /**
   * Permanently destroys a project and everything that hangs off it. There is no
   * restore afterwards.
   *
   * Only valid on an already-deleted project, and `confirmName` must equal the
   * project's name exactly — the server rejects a mismatch rather than guessing
   * that the caller meant this one.
   */
  purge: (projectId, { confirmName, reason } = {}) =>
    req(`${BASE}/${projectId}/purge`, {
      method: 'POST', body: JSON.stringify({ confirmName, reason }),
    }),

  // ── Domains ───────────────────────────────────────────────────────────────
  domains: (projectId) => req(`${BASE}/${projectId}/domains`),

  addCompetitor: (projectId, domain) =>
    req(`${BASE}/${projectId}/domains/competitors`, {
      method: 'POST', body: JSON.stringify({ domain }),
    }),

  discoverCompetitors: (projectId) =>
    req(`${BASE}/${projectId}/domains/competitors/discover`, { method: 'POST' }),

  setPrimaryDomain: (projectId, domain, reason) =>
    req(`${BASE}/${projectId}/domains/primary`, {
      method: 'POST', body: JSON.stringify({ domain, reason }),
    }),

  removeDomain: (projectId, domainId, reason) =>
    req(`${BASE}/${projectId}/domains/${domainId}`, {
      method: 'DELETE', body: JSON.stringify({ reason }),
    }),

  // ── Verification + robots policy ──────────────────────────────────────────
  verifySite: (projectId, reason) =>
    req(`${BASE}/${projectId}/verify-site`, {
      method: 'POST', body: JSON.stringify({ method: 'administrator_assertion', reason }),
    }),

  setRobotsOverride: (projectId, enabled, reason) =>
    req(`${BASE}/${projectId}/robots-override`, {
      method: 'POST', body: JSON.stringify({ enabled, reason }),
    }),

  auditEvents: (projectId, { limit = 50 } = {}) =>
    req(`${BASE}/${projectId}/audit-events?limit=${limit}`),

  // ── Module runs (phase 3) ─────────────────────────────────────────────────
  // Most of these are synchronous on the server: the audits take seconds, so
  // the response carries the completed run. ai_visibility is detached instead
  // — a real measurement run can take many minutes — and comes back with the
  // run still `status: 'running'` plus a `poll` hint; the caller (see
  // HomePage's runModule) polls the overview until it finishes.

  /** Runs one module against the project's primary domain. */
  runModule: (projectId, moduleKey) =>
    req(`${BASE}/${projectId}/modules/${moduleKey}/run`, { method: 'POST' }),

  /**
   * Runs every connected module, one after another.
   * Resolves with a per-module result list even when some of them failed — a
   * partial audit is a real outcome, not an error.
   */
  /**
   * @param {string} projectId
   * @param {string[]} [modules]
   * @param {object} [opts]
   * @param {string} [opts.crawlRunId] a crawl to follow. With it, the three
   *   page-level modules audit pages as that crawl discovers them; without it
   *   they read the last completed crawl.
   */
  runAudit: (projectId, modules, { crawlRunId = null } = {}) =>
    req(`${BASE}/${projectId}/audit`, {
      method: 'POST',
      body: JSON.stringify({
        ...(modules?.length ? { modules } : {}),
        ...(crawlRunId ? { crawlRunId } : {}),
      }),
    }),

  moduleRuns: (projectId, moduleKey, { limit = 25 } = {}) =>
    req(`${BASE}/${projectId}/modules/${moduleKey}/runs?limit=${limit}`),

  moduleRun: (projectId, runId) =>
    req(`${BASE}/${projectId}/modules/runs/${runId}`),

  /**
   * The expanded view behind a dashboard card: the same card object, every
   * finding, the module's stored detail, its history, and the cost of a run.
   * One shape for all six modules.
   */
  moduleDetail: (projectId, moduleKey) =>
    req(`${BASE}/${projectId}/modules/${moduleKey}/detail`),

  /**
   * One audited page's stored report, in the module's own shape.
   *
   * Fetched a page at a time on purpose: SEO & GEO, On-Page and Agent Readiness
   * store a report per crawled page, a run over fifty pages holds several
   * megabytes of them, and the report view shows one URL at a time.
   */
  modulePageReport: (projectId, pageRunId) =>
    req(`${BASE}/${projectId}/modules/pages/${pageRunId}`),

  /** Every page the crawl found for this client — the list to choose from. */
  projectPages: (projectId) => req(`${BASE}/${projectId}/pages`),

  /**
   * Audit one more page into an existing report.
   *
   * The server validates the URL, refuses one that is not on this client's site,
   * returns what is stored rather than re-auditing a page already in the report,
   * and recomputes the run's average from its pages.
   */
  addModulePage: (projectId, moduleKey, url) =>
    req(`${BASE}/${projectId}/modules/${moduleKey}/pages`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  // ── Insights: the six modules read together ───────────────────────────────

  /**
   * The backlog's totals — how much there is to fix, how much of it is one
   * template change, and what it was measured over. Stored evidence only —
   * calling it runs no audits and spends nothing.
   */
  insights: (projectId) => req(`${BASE}/${projectId}/insights`),

  /** Turns one backlog item into a recommendation draft, with its evidence. */
  promoteInsight: (projectId, key) =>
    req(`${BASE}/${projectId}/insights/promote`, {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),

  // ── Recommendations (phase 6) ─────────────────────────────────────────────
  recommendations: (projectId, { status = null } = {}) =>
    req(`${BASE}/${projectId}/recommendations${status ? `?status=${status}` : ''}`),

  createRecommendation: (projectId, body) =>
    req(`${BASE}/${projectId}/recommendations`, { method: 'POST', body: JSON.stringify(body) }),

  /** Drafts one recommendation per non-passing finding of a stored module run. */
  recommendationsFromFindings: (projectId, moduleRunId, ruleIds) =>
    req(`${BASE}/${projectId}/recommendations/from-findings`, {
      method: 'POST', body: JSON.stringify({ moduleRunId, ruleIds }),
    }),

  updateRecommendation: (projectId, id, patch) =>
    req(`${BASE}/${projectId}/recommendations/${id}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),

  /**
   * Moves a recommendation through its lifecycle. `to` is the target status;
   * a rejection needs a reason and shipping accepts a back-dated shippedAt.
   */
  setRecommendationStatus: (projectId, id, to, { reason, shippedAt } = {}) =>
    req(`${BASE}/${projectId}/recommendations/${id}/status`, {
      method: 'POST', body: JSON.stringify({ to, reason, shippedAt }),
    }),

  // ── Report (phase 7) ──────────────────────────────────────────────────────
  // A plain URL rather than a fetch: the browser's own download handling gets
  // the filename from Content-Disposition, which a blob URL would lose.
  reportUrl: (projectId) => `${BASE}/${projectId}/report.xlsx`,
};

/** Status → how it should read on screen. */
export const RECOMMENDATION_STATUS_LABEL = {
  draft: 'Draft',
  proposed: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  shipped: 'Shipped',
};

export const RECOMMENDATION_STATUS_TONE = {
  draft: 'muted',
  proposed: 'warn',
  approved: 'accent',
  rejected: 'neg',
  shipped: 'accent',
};

export const adminApi = {
  limits: ({ workspaceId = null, tier = null } = {}) => {
    const q = new URLSearchParams();
    if (workspaceId) q.set('workspaceId', workspaceId);
    if (tier) q.set('tier', tier);
    const qs = q.toString();
    return req(`${ADMIN}/limits${qs ? `?${qs}` : ''}`);
  },
  limitPolicies: (params = {}) => {
    const q = new URLSearchParams(params);
    const qs = q.toString();
    return req(`${ADMIN}/limits/policies${qs ? `?${qs}` : ''}`);
  },
  createLimitVersion: (body) =>
    req(`${ADMIN}/limits/versions`, { method: 'POST', body: JSON.stringify(body) }),

  featureFlags: () => req(`${ADMIN}/feature-flags`),
  setFeatureFlag: (body) =>
    req(`${ADMIN}/feature-flags`, { method: 'PATCH', body: JSON.stringify(body) }),

  grants: ({ includeRevoked = false } = {}) =>
    req(`${ADMIN}/grants${includeRevoked ? '?includeRevoked=1' : ''}`),
  grantAdmin: (email, note) =>
    req(`${ADMIN}/grants`, { method: 'POST', body: JSON.stringify({ email, note }) }),
  revokeAdmin: (grantId, reason) =>
    req(`${ADMIN}/grants/${grantId}`, { method: 'DELETE', body: JSON.stringify({ reason }) }),
};

// ── Shared presentation ─────────────────────────────────────────────────────
// The dashboard, the project list and the activity table all label a module
// status the same way, so the mapping lives here rather than in each screen.

export const MODULE_STATUS_LABEL = {
  not_run: 'Not run',
  running: 'Running',
  queued: 'Queued',
  paused: 'Paused',
  completed: 'Healthy',
  completed_with_errors: 'Needs attention',
  cancelled: 'Cancelled',
  failed: 'Failed',
  insufficient_data: 'Insufficient data',
};

/**
 * Is this module status "work is under way"?
 *
 * 'queued' counts. Two modules put work on the run queue rather than doing it
 * in the request — AI Visibility because a full set is 10-35 minutes, and
 * Competitor Research because it starts itself when a project's domains are set
 * up — and both sit at 'queued' until a worker claims them. Treating that as
 * idle is what makes a screen offer a Run button for a run that already exists,
 * or stop polling before the work it started has begun.
 */
export function isModuleInFlight(status) {
  return status === 'queued' || status === 'running';
}

// 'accent' = affirmative, 'warn' = needs attention, 'neg' = failed/error,
// 'muted' = nothing to say yet. Resolved to tokens by the consuming component.
export const MODULE_STATUS_TONE = {
  not_run: 'muted',
  queued: 'muted',
  insufficient_data: 'muted',
  running: 'accent',
  paused: 'warn',
  completed: 'accent',
  completed_with_errors: 'warn',
  cancelled: 'warn',
  failed: 'neg',
};

/** "4 hours ago" / "in 2 days". Absolute date past a week, where "ago" stops helping. */
export function relativeTime(input) {
  if (!input) return '—';
  const then = new Date(input).getTime();
  if (!Number.isFinite(then)) return '—';

  const deltaSeconds = Math.round((then - Date.now()) / 1000);
  const past = deltaSeconds <= 0;
  const seconds = Math.abs(deltaSeconds);

  if (seconds < 45) return past ? 'just now' : 'in a moment';
  const units = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
  ];
  for (const [name, size] of units) {
    const next = size * (name === 'minute' ? 60 : name === 'hour' ? 24 : 7);
    if (seconds < next) {
      const value = Math.max(1, Math.round(seconds / size));
      const label = `${value} ${name}${value === 1 ? '' : 's'}`;
      return past ? `${label} ago` : `in ${label}`;
    }
  }
  return new Date(input).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function countryLabel(code) {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}
