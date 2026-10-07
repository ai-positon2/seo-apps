// ── AI Visibility Lite API client ────────────────────────────────────────────
// Mirrors server/modules/aiVisibilityLite/routes.js.
//
// The typed error shape is copied from aiVisibilityApi.js rather than shared,
// for the same reason that file copies it from projectsApi.js: the page
// branches on `error.code` (`migration_needed`, `run_cap_reached`,
// `no_surfaces`), and a helper that throws a bare Error loses it. `body` is
// carried too — a cap refusal returns the budget, and the page shows it.

const BASE = '/api/ai-visibility-lite';

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

export const aivLiteApi = {
  /** Everything the screen needs on load, in one request. */
  status: (projectId) => req(`${BASE}/${projectId}`),

  /** Identify the business and write the questions. 202 with a run id to poll. */
  runSetup: (projectId, { regenerate = false } = {}) => req(`${BASE}/${projectId}/setup`, {
    method: 'POST',
    body: JSON.stringify({ regenerate }),
  }),

  setupStatus: (projectId) => req(`${BASE}/${projectId}/setup`),

  prompts: (projectId, { includeRetired = false } = {}) => (
    req(`${BASE}/${projectId}/prompts${includeRetired ? '?includeRetired=true' : ''}`)
  ),

  addPrompt: (projectId, text, intent = null) => req(`${BASE}/${projectId}/prompts`, {
    method: 'POST',
    body: JSON.stringify({ text, intent }),
  }),

  updatePrompt: (projectId, promptId, text) => req(`${BASE}/${projectId}/prompts/${promptId}`, {
    method: 'PATCH',
    body: JSON.stringify({ text }),
  }),

  deletePrompt: (projectId, promptId) => req(`${BASE}/${projectId}/prompts/${promptId}`, {
    method: 'DELETE',
  }),

  /** Measure. Spends one of the project's runs; 409 `run_cap_reached` when none are left. */
  run: (projectId) => req(`${BASE}/${projectId}/run`, { method: 'POST' }),

  runs: (projectId, limit = 30) => req(`${BASE}/${projectId}/runs?limit=${limit}`),

  report: (projectId) => req(`${BASE}/${projectId}/report`),
};

export default aivLiteApi;
