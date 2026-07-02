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
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

export const ct = {
  // Clients
  clients: () => req('/clients'),
  addClient: (body) => req('/clients', { method: 'POST', body: JSON.stringify(body) }),
  updateClient: (id, body) => req(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteClient: (id) => req(`/clients/${id}`, { method: 'DELETE' }),

  // Competitors
  addCompetitor: (clientId, body) => req(`/clients/${clientId}/competitors`, { method: 'POST', body: JSON.stringify(body) }),
  updateCompetitor: (clientId, competitorId, body) => req(`/clients/${clientId}/competitors/${competitorId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCompetitor: (clientId, competitorId) => req(`/clients/${clientId}/competitors/${competitorId}`, { method: 'DELETE' }),

  // Dashboard (cached — never triggers a live API call)
  dashboard: (clientId) => req(`/clients/${clientId}/dashboard`),
  saveAIVisibility: (clientId, domains) => req(`/clients/${clientId}/ai-visibility`, { method: 'PUT', body: JSON.stringify({ domains }) }),

  // Run control
  triggerRun: () => req('/run', { method: 'POST' }),
  runStatus: () => req('/run/status'),
  semrushUsage: () => req('/semrush-usage'),

  // Schedule
  schedule: () => req('/schedule'),
  saveSchedule: (body) => req('/schedule', { method: 'PUT', body: JSON.stringify(body) }),

  // Export (direct download links, not fetch)
  exportCsvUrl: (clientId) => `${BASE}/clients/${clientId}/export.csv`,
  exportPdfUrl: (clientId) => `${BASE}/clients/${clientId}/export.pdf`,
};
