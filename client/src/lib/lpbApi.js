// ── Location Page Builder — API helpers ─────────────────────────────────────
const BASE = '/api/location-page-builder';

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

export const lpb = {
  // Not seeding-as-setup: each wizard's "Sync list" re-imports a changed
  // service/location taxonomy mid-session, so a change to seed.js reaches the
  // pickers without a deploy step. Re-runnable; hand-entered NAP is preserved.
  seedGentleDental: () => req('/seed-gentle-dental', { method: 'POST' }),
  seedClearBehavioral: () => req('/seed-clear-behavioral', { method: 'POST' }),

  // ── Clear Behavioral Health ───────────────────────────────────────────────
  // `cbhBriefBuild` and `cbhGenerate` are the billed calls; the rest are cheap.
  cbhLimits: () => req('/cbh/limits'),
  cbhBrief: ({ clientId, serviceId, locationId }) =>
    req(`/cbh/brief?clientId=${clientId}&serviceId=${serviceId}&locationId=${locationId}`),
  cbhBriefBuild: (body) => req('/cbh/brief/build', { method: 'POST', body: JSON.stringify(body) }),
  cbhBriefSave: (body) => req('/cbh/brief/save', { method: 'POST', body: JSON.stringify(body) }),
  cbhGenerate: (body) => req('/cbh/generate', { method: 'POST', body: JSON.stringify(body) }),
  cbhSavePage: (id, page) => req(`/cbh/pages/${id}`, { method: 'PUT', body: JSON.stringify({ page }) }),
  cbhQc: (page) => req('/cbh/qc', { method: 'POST', body: JSON.stringify({ page }) }),
  cbhRegenField: (body) => req('/cbh/regen-field', { method: 'POST', body: JSON.stringify(body) }),
  cbhPages: (clientId) => req(`/cbh/pages?clientId=${encodeURIComponent(clientId)}`),
  cbhPage: (id) => req(`/cbh/pages/${id}`),
  cbhDeletePage: (id) => req(`/cbh/pages/${id}`, { method: 'DELETE' }),
  // BILLED (one review call): re-checks a saved page against the client
  // feedback rules. Refused for a page generated before the rules existed.
  cbhFeedbackReview: (id) => req(`/cbh/pages/${id}/feedback-review`, { method: 'POST' }),

  // ── Client feedback rules ─────────────────────────────────────────────────
  // `feedbackDraftBatch` is the one billed call; nothing here touches a page.
  feedbackVocabulary: (clientId) => req(`/feedback/vocabulary?clientId=${encodeURIComponent(clientId)}`),
  feedbackRules: (clientId) => req(`/feedback/rules?clientId=${encodeURIComponent(clientId)}`),
  feedbackCreateRule: (clientId, rule) => req('/feedback/rules', { method: 'POST', body: JSON.stringify({ clientId, rule }) }),
  feedbackUpdateRule: (id, rule) => req(`/feedback/rules/${id}`, { method: 'PUT', body: JSON.stringify({ rule }) }),
  feedbackSetStatus: (id, status) => req(`/feedback/rules/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  feedbackTestRule: (body) => req('/feedback/rules/test', { method: 'POST', body: JSON.stringify(body) }),
  // Permanent. A deleted batch's rules are kept; neither touches a page.
  feedbackDeleteRule: (id) => req(`/feedback/rules/${id}`, { method: 'DELETE' }),
  feedbackDeleteBatch: (id) => req(`/feedback/batches/${id}`, { method: 'DELETE' }),
  feedbackBatches: (clientId) => req(`/feedback/batches?clientId=${encodeURIComponent(clientId)}`),
  feedbackCreateBatch: (body) => req('/feedback/batches', { method: 'POST', body: JSON.stringify(body) }),
  feedbackDraftBatch: (id) => req(`/feedback/batches/${id}/draft`, { method: 'POST' }),
  feedbackUpdateActionItem: (id, n, body) => req(`/feedback/batches/${id}/action-items/${n}`, { method: 'PUT', body: JSON.stringify(body) }),
  feedbackApplyRevision: (id, n) => req(`/feedback/batches/${id}/revisions/${n}/apply`, { method: 'POST' }),
  cbhExportJson: (page) => req('/cbh/export/json', { method: 'POST', body: JSON.stringify({ page }) }),
  cbhExportDocx: async (page) => {
    const res = await fetch(`${BASE}/cbh/export/docx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ page }),
    });
    if (!res.ok) {
      let msg = `Export failed (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* non-JSON error body */ }
      throw new Error(msg);
    }
    const named = /filename="?([^";]+)"?/i.exec(res.headers.get('content-disposition') || '');
    return { blob: await res.blob(), filename: named ? named[1] : 'cbh_page.docx' };
  },

  clients: () => req('/clients'),
  client: (id) => req(`/clients/${id}`),
  entities: (c, clientId) => req(`/entities/${c}${clientId ? `?client_id=${clientId}` : ''}`),
  createEntity: (c, body) => req(`/entities/${c}`, { method: 'POST', body: JSON.stringify(body) }),
  updateEntity: (c, id, body) => req(`/entities/${c}/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  pages: (clientId) => req(`/pages${clientId ? `?client_id=${clientId}` : ''}`),
  page: (id) => req(`/pages/${id}`),
  createPage: (body) => req('/pages', { method: 'POST', body: JSON.stringify(body) }),
  deletePage: (id) => req(`/pages/${id}`, { method: 'DELETE' }),

  runKeywords: (id) => req(`/pages/${id}/keywords/run`, { method: 'POST' }),
  runContent: (id) => req(`/pages/${id}/content/run`, { method: 'POST' }),
  saveKeywords: (id, body) => req(`/pages/${id}/keywords`, { method: 'PUT', body: JSON.stringify(body) }),
  finalizeKeywords: (id) => req(`/pages/${id}/keywords/finalize`, { method: 'POST' }),

  editSection: (id, body) => req(`/pages/${id}/section`, { method: 'PUT', body: JSON.stringify(body) }),
  saveContent: (id, body) => req(`/pages/${id}/content`, { method: 'PUT', body: JSON.stringify(body) }),
  rerunQA: (id) => req(`/pages/${id}/qa`, { method: 'POST' }),
  regenField: (id, body) => req(`/pages/${id}/content/regen-field`, { method: 'POST', body: JSON.stringify(body) }),
  gate: (id, body) => req(`/pages/${id}/gate`, { method: 'POST', body: JSON.stringify(body) }),
  comment: (id, body) => req(`/pages/${id}/comments`, { method: 'POST', body: JSON.stringify(body) }),

  exportUrl: (id, format) => `${BASE}/pages/${id}/export/${format}`,

  // ── Gentle Dental wizard ──────────────────────────────────────────────────
  keywordCandidates: (body) => req('/keyword-candidates', { method: 'POST', body: JSON.stringify(body) }),
  wizardGenerate: (body) => req('/wizard/generate', { method: 'POST', body: JSON.stringify(body) }),
  // pageId is optional: when given, the QC verdict is persisted onto the page
  // instead of being recomputed and lost on every reload.
  contentLimits: () => req('/wizard/content-limits'),
  wizardQc: (page, pageId) => req('/wizard/qc', { method: 'POST', body: JSON.stringify({ page, pageId }) }),
  // Re-run a SINGLE check after the reviewer has fixed that one field. Returns
  // { check, verdict, checks } — the fresh check spliced into `checks` with the
  // verdict re-derived, so the caller can replace its QC state wholesale.
  wizardQcCheck: (page, pageId, id, checks) =>
    req('/wizard/qc/check', { method: 'POST', body: JSON.stringify({ page, pageId, id, checks }) }),
  wizardExisting: ({ clientId, serviceId, locationId }) =>
    req(`/wizard/existing?clientId=${encodeURIComponent(clientId)}&serviceId=${encodeURIComponent(serviceId)}&locationId=${encodeURIComponent(locationId)}`),
  wizardRegenerate: (body) => req('/wizard/regenerate', { method: 'POST', body: JSON.stringify(body) }),
  wizardPages: (clientId) => req(`/wizard/pages?clientId=${encodeURIComponent(clientId)}`),
  wizardPage: (id) => req(`/wizard/pages/${id}`),

  // Approved keywords, saved on approval rather than only as a byproduct of
  // generating — so leaving before generating no longer loses the work, and
  // re-opening a page never silently re-runs the billed research call.
  wizardSaveKeywords: (body) => req('/wizard/keywords', { method: 'POST', body: JSON.stringify(body) }),
  wizardGetKeywords: ({ clientId, serviceId, locationId }) =>
    req(`/wizard/keywords?clientId=${encodeURIComponent(clientId)}&serviceId=${encodeURIComponent(serviceId)}&locationId=${encodeURIComponent(locationId)}`),
  // Persist manual step-4 edits (the Neuro content route expects a different
  // page shape and can't be reused here).
  wizardSaveContent: (id, page) => req(`/wizard/pages/${id}`, { method: 'PUT', body: JSON.stringify({ page }) }),

  // The docx comes back as a binary body, which the shared `req` helper would
  // stringify, so this one drives fetch directly. It POSTs the on-screen page
  // rather than a pageId so unsaved edits are in the document (see the route).
  wizardExportDocx: async (page) => {
    const res = await fetch(`${BASE}/wizard/export/docx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ page }),
    });
    if (!res.ok) {
      let msg = `Export failed (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* non-JSON error body */ }
      throw new Error(msg);
    }
    const disposition = res.headers.get('content-disposition') || '';
    const named = /filename="?([^";]+)"?/i.exec(disposition);
    // The server names the file after the page's own URL path; this fallback
    // is only reached when Content-Disposition is missing entirely.
    return { blob: await res.blob(), filename: named ? named[1] : 'location_service_page.docx' };
  },
};

// Open an SSE stream for a minted token; returns the EventSource.
export function openStream(token, handlers) {
  const es = new EventSource(`${BASE}/stream/${token}`);
  Object.entries(handlers).forEach(([event, fn]) => {
    es.addEventListener(event, (e) => fn(e.data ? JSON.parse(e.data) : {}));
  });
  return es;
}
