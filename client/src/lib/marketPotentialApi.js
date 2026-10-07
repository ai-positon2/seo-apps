const BASE = '/api/market-potential';

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

export const mp = {
  meta: () => req('/meta'),
  usage: () => req('/usage'),

  // Geo
  searchGeo: (q) => req(`/geo/search?q=${encodeURIComponent(q)}`),
  allGeo: () => req('/geo/all'),

  // Service + basket
  resolveService: (service, ownDomain) => req('/service/resolve', { method: 'POST', body: JSON.stringify({ service, ownDomain }) }),
  proposeBasket: (serviceId) => req(`/service/${serviceId}/basket/propose`, { method: 'POST' }),
  saveDraft: (serviceId, terms) => req(`/service/${serviceId}/basket/draft`, { method: 'PUT', body: JSON.stringify({ terms }) }),
  freezeBasket: (serviceId) => req(`/service/${serviceId}/basket/freeze`, { method: 'POST' }),

  // Adjacency
  adjacency: (homeGeoIds, opts = {}) => req('/adjacency', { method: 'POST', body: JSON.stringify({ homeGeoIds, ...opts }) }),

  // Compare
  compare: (body) => req('/compare', { method: 'POST', body: JSON.stringify(body) }),

  // Executive summary (grounded, cached)
  summary: (body) => req('/summary', { method: 'POST', body: JSON.stringify(body) }),

  // Scenarios
  scenarios: () => req('/scenarios'),
  saveScenario: (body) => req('/scenarios', { method: 'POST', body: JSON.stringify(body) }),
  deleteScenario: (id) => req(`/scenarios/${id}`, { method: 'DELETE' }),
};
