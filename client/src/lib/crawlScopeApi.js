// CrawlScope API client. Mirrors server/modules/crawlScope/api/routes.js.
//
// The standalone CrawlScope browser client authenticated with a Supabase Auth
// bearer token, and had to pass it as ?access_token= on the SSE route because
// EventSource cannot set headers. Here the session is the app's httpOnly cookie,
// which EventSource sends on its own, so the stream URL carries no credentials.

const BASE = '/api/crawl-scope';

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

export const cs = {
  // Static reference data: the rule catalog (id, title, category, severity,
  // detection, recommendation) every screen needs to name a finding.
  catalog: () => req('/catalog'),

  // ── Runs ──────────────────────────────────────────────────────────────────
  // A manual crawl executes in the web process, so it starts immediately and is
  // followed live on the stream below.
  startRun: (body) => req('/runs', { method: 'POST', body: JSON.stringify(body) }),
  runs: ({ limit = 50, projectId = null } = {}) => {
    const q = new URLSearchParams();
    if (limit) q.set('limit', String(limit));
    if (projectId) q.set('projectId', projectId);
    return req(`/runs?${q}`);
  },
  run: (id) => req(`/runs/${id}`),
  results: (id, { offset = 0, limit = 500 } = {}) =>
    req(`/runs/${id}/results?offset=${offset}&limit=${limit}`),
  streamUrl: (id) => `${BASE}/runs/${id}/stream`,

  pause: (id) => req(`/runs/${id}/pause`, { method: 'POST' }),
  resume: (id) => req(`/runs/${id}/resume`, { method: 'POST' }),
  stop: (id) => req(`/runs/${id}/stop`, { method: 'POST' }),

  // ── PageSpeed Insights (on-demand, one page at a time) ───────────────────
  // POST kicks the check off and returns immediately (it can take 15-90s
  // server-side); poll the status endpoint until it reports "done" or
  // "error". See api/routes.js for why this isn't a single blocking call.
  checkPageSpeed: (id, url) =>
    req(`/runs/${id}/results/pagespeed`, { method: 'POST', body: JSON.stringify({ url }) }),
  pageSpeedStatus: (id, url) =>
    req(`/runs/${id}/results/pagespeed/status?url=${encodeURIComponent(url)}`),

  // ── Issue review ──────────────────────────────────────────────────────────
  // Findings come back with their persisted review status and notes merged in;
  // anything never touched reads as "Needs review".
  /**
   * Every finding for a run, with its review state merged in.
   *
   * Reads crawl_run_finding_instances (migration 0023), falling back to the
   * legacy crawl_runs.summary.findings for runs finalized before it shipped.
   *
   * The rollup endpoint that used to live here is gone. It existed because the
   * findings were embedded in one JSONB column that could not be written or
   * read at scale — the crawl-completion UPDATE was timing out on a ~2,600-page
   * site and the report received nothing. That is fixed at the source now:
   * instances are chunk-inserted into their own table, so this endpoint can
   * simply return them.
   */
  findings: (id) => req(`/runs/${id}/findings`),

  // ── Projects (scheduled crawls) ───────────────────────────────────────────
  projects: () => req('/projects'),
  createProject: (body) => req('/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id, patch) =>
    req(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id) => req(`/projects/${id}`, { method: 'DELETE' }),
  runProjectNow: (id) => req(`/projects/${id}/run`, { method: 'POST' }),

  // ── Report download ───────────────────────────────────────────────────────
  // The server either redirects to a signed Storage URL (workbook already built
  // and nothing reviewed since) or streams a freshly built one. `fetch` follows
  // the redirect either way, so both land here as a blob.
  reportUrl: (id) => `${BASE}/runs/${id}/report.xlsx`,
  downloadReport: async (id) => {
    const res = await fetch(`${BASE}/runs/${id}/report.xlsx`, { credentials: 'include' });
    if (!res.ok) {
      let msg = `Download failed (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const match = (res.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
    return { blob, filename: match ? match[1] : 'crawlscope-audit.xlsx' };
  },
};

// Shared by the report download and the CSV export.
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
