// ── Template-driven Location + Service pages — API helpers ──────────────────
// Talks to /api/location-page-builder/ls (see server/routes/lsPages.js). Kept
// separate from lpbApi's `lpb` object, which is already two engines' worth of
// endpoints; the shared reference-data reads (clients, services, locations)
// still come from `lpb`, since those are the module's, not this engine's.
const BASE = '/api/location-page-builder/ls';

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* non-JSON error body */ }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

const tupleQuery = ({ clientId, serviceId, locationId }) =>
  `clientId=${encodeURIComponent(clientId)}&serviceId=${encodeURIComponent(serviceId)}&locationId=${encodeURIComponent(locationId)}`;

export const lsPages = {
  seedClearBehavioralHealth: () => req('/seed/clear-behavioral-health', { method: 'POST' }),
  contentLimits: clientId => req(`/content-limits?clientId=${encodeURIComponent(clientId)}`),

  // Step 2 — billed. Takes the tuple, not the service/city strings: the server
  // resolves the seed and the client's own seed qualifier from the profile, so
  // the client cannot get that wrong.
  keywordCandidates: body => req('/keyword-candidates', { method: 'POST', body: JSON.stringify(body) }),

  // Step 3 — the approved list, saved on approval rather than only as a
  // byproduct of generating, so leaving the wizard never loses it and
  // re-opening a page never silently re-runs the billed research.
  saveKeywords: body => req('/keywords', { method: 'POST', body: JSON.stringify(body) }),
  getKeywords: tuple => req(`/keywords?${tupleQuery(tuple)}`),

  // Step 4 — plan, edit, approve.
  generateBrief: body => req('/brief', { method: 'POST', body: JSON.stringify(body) }),
  saveBrief: body => req('/brief', { method: 'PUT', body: JSON.stringify(body) }),

  // Step 5 — write from the approved brief, then regenerate one field at a time.
  generateCopy: tuple => req('/copy', { method: 'POST', body: JSON.stringify(tuple) }),
  regenerate: body => req('/regenerate', { method: 'POST', body: JSON.stringify(body) }),

  existing: tuple => req(`/existing?${tupleQuery(tuple)}`),
  pages: clientId => req(`/pages?clientId=${encodeURIComponent(clientId)}`),
  page: id => req(`/pages/${id}`),
  saveContent: (id, page) => req(`/pages/${id}`, { method: 'PUT', body: JSON.stringify({ page }) }),

  // QC runs against the page in the body, not one read back by id: the wizard
  // edits client-side and only persists on Save, so an id-based check would
  // grade content the reviewer can no longer see.
  qc: (page, pageId, clientId) => req('/qc', { method: 'POST', body: JSON.stringify({ page, pageId, clientId }) }),
  qcCheck: (page, pageId, clientId, id, checks) =>
    req('/qc/check', { method: 'POST', body: JSON.stringify({ page, pageId, clientId, id, checks }) }),

  // Exports come back as a binary or text body, which the shared `req` helper
  // would mangle, so these drive fetch directly. They POST the on-screen page
  // so unsaved edits are in the document.
  download: async (format, page) => {
    const res = await fetch(`${BASE}/export/${format}`, {
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
    return { blob: await res.blob(), filename: named ? named[1] : `location-service-page.${format}` };
  },
};

// Saves a blob the browser has already been handed. Here rather than in the
// component because all three export buttons need it identically.
export function saveBlob({ blob, filename }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
