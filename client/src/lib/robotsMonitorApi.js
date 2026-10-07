const BASE = '/api/robots-monitor';

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

export const rm = {
  // Clients
  clients: () => req('/clients'),
  addClient: (body) => req('/clients', { method: 'POST', body: JSON.stringify(body) }),
  updateClient: (id, body) => req(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteClient: (id) => req(`/clients/${id}`, { method: 'DELETE' }),

  // Domains
  addDomain: (clientId, body) => req(`/clients/${clientId}/domains`, { method: 'POST', body: JSON.stringify(body) }),
  updateDomain: (clientId, domainId, body) => req(`/clients/${clientId}/domains/${domainId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteDomain: (clientId, domainId) => req(`/clients/${clientId}/domains/${domainId}`, { method: 'DELETE' }),

  // Slack config
  slackConfig: () => req('/slack-config'),
  saveSlackConfig: (body) => req('/slack-config', { method: 'PUT', body: JSON.stringify(body) }),
  testSlack: () => req('/slack-config/test', { method: 'POST' }),

  // Run
  triggerRun: () => req('/run', { method: 'POST' }),
  runStatus: () => req('/run/status'),

  // History
  history: (limit = 30) => req(`/history?limit=${limit}`),
  runDetail: (runId) => req(`/history/${runId}`),
};
