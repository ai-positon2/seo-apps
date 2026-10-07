import { requestJson } from './apiRequest';

const BASE = '/api/on-page-audit';

export function startAudit(url, primaryKeywords) {
  return requestJson(`${BASE}/run`, {
    method: 'POST',
    body: JSON.stringify({ url, primaryKeywords }),
  }); // { jobId }
}

export function pollStatus(jobId) {
  return requestJson(`${BASE}/status/${jobId}`); // { status, auditId, progress, error }
}

export function getResult(auditId) {
  return requestJson(`${BASE}/result/${auditId}`);
}

export function listAudits() {
  return requestJson(`${BASE}/list`);
}

export function deleteAudit(auditId) {
  return requestJson(`${BASE}/${auditId}`, { method: 'DELETE' });
}
