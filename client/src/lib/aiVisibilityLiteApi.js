// ── AI Visibility Lite API client ────────────────────────────────────────────
// Mirrors server/modules/aiVisibilityLite/routes.js.
//
// The page branches on `error.code` (`migration_needed`, `run_cap_reached`,
// `no_surfaces`) and reads `error.body` — a cap refusal returns the budget,
// and the page shows it. The shared helper carries both (see apiRequest.js).

import { requestJson } from './apiRequest';

const BASE = '/api/ai-visibility-lite';

const req = (path, options) => requestJson(path, options);

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
