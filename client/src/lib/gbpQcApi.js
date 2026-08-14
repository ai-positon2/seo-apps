const BASE = '/api/gbp-qc';

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

async function blobReq(path, body, fallbackName) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Export failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const match = (res.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
  return { blob, filename: match ? match[1] : fallbackName };
}

export const gbpQc = {
  clients: () => req('/clients'),

  qcBase: (body) => req('/qc/base', { method: 'POST', body: JSON.stringify(body) }),
  qcExpanded: (body) => req('/qc/expanded', { method: 'POST', body: JSON.stringify(body) }),
  generate: (body) => req('/generate', { method: 'POST', body: JSON.stringify(body) }),
  generateAllInit: (body) => req('/generate/all/init', { method: 'POST', body: JSON.stringify(body) }),

  exportQc: (body) => blobReq('/export/qc', body, 'gbp-qc-report.xlsx'),
  exportGenerated: (body) => blobReq('/export/generated', body, 'gbp-generated-post.xlsx'),
  exportAll: (body) => blobReq('/export/all', body, 'gbp-all-locations.xlsx'),
};
