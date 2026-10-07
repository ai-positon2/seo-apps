const BASE = '/api/on-page-audit';

export async function startAudit(url, primaryKeywords) {
  const res = await fetch(`${BASE}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ url, primaryKeywords }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json(); // { jobId }
}

export async function pollStatus(jobId) {
  const res = await fetch(`${BASE}/status/${jobId}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // { status, auditId, progress, error }
}

export async function getResult(auditId) {
  const res = await fetch(`${BASE}/result/${auditId}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function listAudits() {
  const res = await fetch(`${BASE}/list`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteAudit(auditId) {
  const res = await fetch(`${BASE}/${auditId}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
