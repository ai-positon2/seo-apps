const BASE = '/api/content-architect';

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

export const ca = {
  projects: () => req('/projects'),
  createProject: (domain) => req('/projects', { method: 'POST', body: JSON.stringify({ domain }) }),
  getProject: (id) => req(`/projects/${id}`),
  deleteProject: (id) => req(`/projects/${id}`, { method: 'DELETE' }),

  // Stage 1 — init-token + SSE stream, same pattern as keywordResearch.js.
  discoverInit: (id) => req(`/projects/${id}/discover`, { method: 'POST' }),
  discoverStreamUrl: (id, token) => `${BASE}/projects/${id}/discover/stream/${token}`,

  // Stage 2
  getPatterns: (id) => req(`/projects/${id}/patterns`),
  savePatterns: (id, included, vertical) => req(`/projects/${id}/patterns`, { method: 'PUT', body: JSON.stringify({ included, vertical }) }),

  // Stage 3 — instant slug-only draft clustering. Provisional endpoint name;
  // folds into the real analyze SSE job once Stage 4 (crawl) exists too.
  computeDraftClusters: (id) => req(`/projects/${id}/draft-clusters`, { method: 'POST' }),
  getClusters: (id) => req(`/projects/${id}/clusters`),

  // Stages 4-7 — full analysis (crawl, cluster, name, hub, diagnose). Same
  // init-token + SSE pattern as discover.
  analyzeInit: (id) => req(`/projects/${id}/analyze`, { method: 'POST' }),
  analyzeStreamUrl: (id, token) => `${BASE}/projects/${id}/analyze/stream/${token}`,
  getFullAnalysis: (id) => req(`/projects/${id}/full-analysis`),

  setCompetitors: (id, competitors) => req(`/projects/${id}/competitors`, { method: 'PUT', body: JSON.stringify({ competitors }) }),

  // Content-gap spoke suggestions — on demand, per cluster (spends SEMrush
  // units + a search call, so it's its own explicit action, never automatic).
  suggestSpokes: (id, clusterId) => req(`/projects/${id}/clusters/${clusterId}/suggest-spokes`, { method: 'POST' }),

  // Stage 9 — file downloads return a binary blob, so they can't go through
  // the shared JSON req() helper above. Same blob + Content-Disposition
  // pattern as competitorTrackerApi.js's exportReport.
  exportFile: async (id, format) => {
    const res = await fetch(`${BASE}/projects/${id}/export?format=${format}`, { credentials: 'include' });
    if (!res.ok) {
      let msg = `Export failed (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const match = (res.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
    return { blob, filename: match ? match[1] : `content-architecture.${format === 'md' ? 'md' : 'xlsx'}` };
  },
};
