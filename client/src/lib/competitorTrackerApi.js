const BASE = '/api/competitor-tracker';

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
  return res.json();
}

export const ct = {
  meta: () => req('/meta'),

  clients: () => req('/clients'),
  createClient: (body) => req('/clients', { method: 'POST', body: JSON.stringify(body) }),
  updateClient: (id, patch) => req(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteClient: (id) => req(`/clients/${id}`, { method: 'DELETE' }),

  addCompetitor: (clientId, body) => req(`/clients/${clientId}/competitors`, { method: 'POST', body: JSON.stringify(body) }),
  removeCompetitor: (clientId, competitorId) => req(`/clients/${clientId}/competitors/${competitorId}`, { method: 'DELETE' }),
  // Auto-discovers organic competitors (SEMrush + GPT) — returns candidates
  // for review, nothing is persisted until the caller confirms via
  // addCompetitor above, one call per kept candidate.
  discoverCompetitors: (clientId, body) => req(`/clients/${clientId}/discover-competitors`, { method: 'POST', body: JSON.stringify(body || {}) }),

  dashboard: (clientId) => req(`/clients/${clientId}/dashboard`),
  run: (clientId) => req(`/clients/${clientId}/run`, { method: 'POST' }),
  runStatus: (clientId) => req(`/clients/${clientId}/run/status`),

  // Page Speed-only refresh — spends no SEMrush units, runs independently
  // of the main analysis. force=true (default) bypasses the 7-day cache —
  // used by the manual "Refresh" button; the automatic post-run chain passes
  // force:false so it doesn't multiply PSI calls on every single run.
  runPageSpeed: (clientId, { force = true } = {}) => req(`/clients/${clientId}/run-pagespeed`, { method: 'POST', body: JSON.stringify({ force }) }),
  runPageSpeedStatus: (clientId) => req(`/clients/${clientId}/run-pagespeed/status`),

  // Content Analysis — top-pages content mix (Part 1) + sitemap structure
  // (Part 2), each with a GPT 5.4 mini summary. Independent of the main
  // analysis and Page Speed.
  contentAnalysis: (clientId) => req(`/clients/${clientId}/content-analysis`),
  runContentAnalysis: (clientId) => req(`/clients/${clientId}/content-analysis/run`, { method: 'POST' }),
  runContentAnalysisStatus: (clientId) => req(`/clients/${clientId}/content-analysis/run/status`),
  // Re-decides the top pages' TYPE column from the pages already stored — one
  // model call, no SEMrush units. A stored analysis keeps whatever types it was
  // given when it ran, so this is how an existing one picks up a better classifier
  // without paying to fetch its pages again.
  reclassifyTopPages: (clientId) => req(`/clients/${clientId}/content-analysis/reclassify`, { method: 'POST' }),
  regenerateTopPagesSummary: (clientId) => req(`/clients/${clientId}/content-analysis/summary/top-pages`, { method: 'POST' }),
  regenerateSitemapSummary: (clientId) => req(`/clients/${clientId}/content-analysis/summary/sitemap`, { method: 'POST' }),
  // Edit the folder → page-type mapping. edits: { "<template>": "<type>" }.
  updateContentAnalysisMapping: (clientId, edits) => req(`/clients/${clientId}/content-analysis/mapping`, { method: 'POST', body: JSON.stringify({ edits }) }),

  // Downloads a PDF report — returns a binary blob, so it can't go through
  // the shared JSON req() helper above.
  exportReport: async (clientId) => {
    const res = await fetch(`${BASE}/clients/${clientId}/export`, { method: 'POST', credentials: 'include' });
    if (!res.ok) {
      let msg = `Export failed (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const match = (res.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
    return { blob, filename: match ? match[1] : 'Competitor_Analysis.pdf' };
  },
};
