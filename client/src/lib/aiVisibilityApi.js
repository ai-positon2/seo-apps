// ── AI Visibility API client ─────────────────────────────────────────────────
// Mirrors server/modules/aiVisibility/routes.js.
//
// The page's old local `req()` was GET-only and threw a bare Error with no
// `.code`, but the `migration_needed` special-case in AiVisibilityPage.jsx
// depends on reading `error.code` — so this copies projectsApi.js's typed
// error shape verbatim rather than reusing the old helper.

const BASE = '/api/ai-visibility';

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

export const aiVisibilityApi = {
  report: (projectId) => req(`${BASE}/${projectId}/report`),

  prompts: (projectId, { status, topic, retired } = {}) => {
    const q = new URLSearchParams();
    if (status) q.set('status', Array.isArray(status) ? status.join(',') : status);
    if (topic) q.set('topic', topic);
    if (retired) q.set('retired', 'true');
    const qs = q.toString();
    return req(`${BASE}/${projectId}/prompts${qs ? `?${qs}` : ''}`);
  },

  /** @param {Array<string|object>} prompts @param {'draft'|'approved'} [status] */
  addPrompts: (projectId, prompts, status) => req(`${BASE}/${projectId}/prompts`, {
    method: 'POST',
    body: JSON.stringify({ prompts, ...(status ? { status } : {}) }),
  }),

  updatePrompt: (projectId, promptId, patch) => req(`${BASE}/${projectId}/prompts/${promptId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }),

  setStatus: (projectId, promptId, to, reason) => req(`${BASE}/${projectId}/prompts/${promptId}/status`, {
    method: 'POST',
    body: JSON.stringify({ to, ...(reason ? { reason } : {}) }),
  }),

  /** @param {{promptIds?: string[], all?: boolean}} scope */
  approveMany: (projectId, scope) => req(`${BASE}/${projectId}/prompts/approve`, {
    method: 'POST',
    body: JSON.stringify(scope),
  }),

  restore: (projectId, promptId) => req(`${BASE}/${projectId}/prompts/${promptId}/restore`, {
    method: 'POST',
  }),

  retire: (projectId, promptId) => req(`${BASE}/${projectId}/prompts/${promptId}`, {
    method: 'DELETE',
  }),

  /** @param {{urls: string[]}} opts  the pages to write a question about */
  generate: (projectId, opts = {}) => req(`${BASE}/${projectId}/prompts/generate`, {
    method: 'POST',
    body: JSON.stringify(opts),
  }),

  generation: (projectId) => req(`${BASE}/${projectId}/prompts/generation`),

  /** One captured answer in full — the whole text and its citations. */
  capture: (projectId, captureId) => req(`${BASE}/${projectId}/captures/${captureId}`),

  /** Every crawled page as one selectable topic. Read-only and free. */
  topics: (projectId) => req(`${BASE}/${projectId}/prompts/topics`),

  // ── Reports (METRICS.md §12) ─────────────────────────────────────────────
  // One shape for all nine, so the shell switches without bespoke plumbing.

  /** Rail catalogue: id, label, group. No data, so it is cheap to call. */
  reportCatalogue: (projectId) => req(`${BASE}/${projectId}/reports`),

  /**
   * One report.
   * @param {object} [opts] {days, from, to, engine}
   */
  report9: (projectId, reportId, opts = {}) => {
    const q = new URLSearchParams();
    if (opts.days) q.set('days', String(opts.days));
    if (opts.from) q.set('from', opts.from);
    if (opts.to) q.set('to', opts.to);
    if (opts.engine && opts.engine !== 'all') q.set('engine', opts.engine);
    const qs = q.toString();
    return req(`${BASE}/${projectId}/reports/${reportId}${qs ? `?${qs}` : ''}`);
  },

  // ── The measured set (§3.4) ──────────────────────────────────────────────

  brands: (projectId) => req(`${BASE}/${projectId}/brands`),

  /** Proposes; never approves. Derived aliases land as `proposed`. */
  deriveBrands: (projectId) => req(`${BASE}/${projectId}/brands/derive`, { method: 'POST' }),

  setBrandStatus: (projectId, brandId, status) => req(`${BASE}/${projectId}/brands/${brandId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  }),

  // ── Extraction ───────────────────────────────────────────────────────────

  extractPending: (projectId) => req(`${BASE}/${projectId}/extract/pending`),

  /** Costs money per capture — the caller must have said so before calling. */
  extract: (projectId, opts = {}) => req(`${BASE}/${projectId}/extract`, {
    method: 'POST',
    body: JSON.stringify(opts),
  }),
};

export const EVIDENCE_SOURCE_LABEL = {
  clusters: "The client's own topic clusters",
  competitorKeywords: 'Competitor keyword demand',
  pages: "The client's crawled pages",
  pageKeywords: 'Human-curated per-page keywords',
  knowledgeBase: 'Knowledge base',
};

export const PROMPT_STATUSES = ['draft', 'approved', 'rejected', 'retired'];

// The module's vocabulary lives here and nowhere else. Every screen reads
// these, so a concept cannot pick up a second name later. 'retired' is the
// stored value; "Removed" is what a person is told, because that is what it
// does — a removed question leaves the reports entirely.
export const PROMPT_STATUS_LABEL = {
  draft: 'Waiting for you',
  approved: 'Measured',
  rejected: 'Rejected',
  retired: 'Removed',
};

// Values must be Badge variants: success | warning | danger | info | neutral | brand
export const PROMPT_STATUS_TONE = {
  draft: 'warning',
  approved: 'success',
  rejected: 'neutral',
  retired: 'neutral',
};

export const SOURCE_LABEL = {
  manual: 'Added by hand',
  cluster: 'Topic cluster',
  keyword: 'Keyword demand',
  competitor: 'Category / competitive set',
};
