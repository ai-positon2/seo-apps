// ── Runs API client + shared formatting ─────────────────────────────────────
// One place for reading the run history that server/middleware/runTracking.js
// writes, used by both surfaces that show runs:
//
//   • /runs               — the whole workspace (pages/RunsPage.jsx)
//   • each module's page  — that module's own runs (components/ModuleRuns.jsx)
//
// Both surfaces must label a tool, a status and a duration identically, so the
// formatting lives here rather than being written twice.

import { ALL_TOOLS } from '../toolsMeta';

// Tools that record runs but have no card in the tool grid, so no label there.
const EXTRA_TOOL_LABELS = {
  'content-enhancement': 'Content Enhancement',
  'robots-monitor': 'Robots.txt Monitor',
  'competitor-analysis-report': 'Competitor Analysis Report',
  'knowledge-base': 'Knowledge Base',
  'content-research': 'Content Research',
};

export const STATUS_VARIANT = {
  completed: 'success',
  failed: 'danger',
  running: 'info',
  cancelled: 'warning',
};

export function toolLabel(toolId) {
  const tool = ALL_TOOLS.find(t => t.id === toolId);
  if (tool) return tool.label;
  if (EXTRA_TOOL_LABELS[toolId]) return EXTRA_TOOL_LABELS[toolId];
  return String(toolId || '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// 'run' is the unremarkable default and adds nothing next to a tool name; the
// others ('export', 'discover', 'page-speed', …) are what distinguishes one row
// from another, so they read as words rather than slugs.
export function actionLabel(action) {
  if (!action || action === 'run') return '';
  return String(action).replace(/[-_]/g, ' ');
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatWhen(iso) {
  if (!iso) return '—';
  const then = new Date(iso);
  const diff = Date.now() - then.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return then.toLocaleDateString();
}

export function formatClock(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Heading for a day of runs: today and yesterday by name, then the date.
export function dayHeading(iso) {
  if (!iso) return 'Unknown date';
  const then = new Date(iso);
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(then)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return then.toLocaleDateString([], { weekday: 'long' });
  return then.toLocaleDateString([], { month: 'short', day: 'numeric', year: then.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

// Newest-first runs → [{ heading, runs }], preserving the incoming order.
export function groupRunsByDay(runs = []) {
  const groups = [];
  for (const run of runs) {
    const heading = dayHeading(run.created_at);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.runs.push(run);
    else groups.push({ heading, runs: [run] });
  }
  return groups;
}

// ── Requests ────────────────────────────────────────────────────────────────
// Every call carries the session cookie and surfaces the server's own error
// text. A 503 means the run history isn't configured at all (no Supabase) —
// flagged on the error so a caller can hide its UI instead of showing a fault.

async function request(path) {
  const res = await fetch(path, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed.');
    err.status = res.status;
    err.unavailable = res.status === 503;
    throw err;
  }
  return data;
}

export function fetchRuns({ toolId, status, action, search, mine, limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (toolId) params.set('toolId', toolId);
  if (status) params.set('status', status);
  if (action) params.set('action', action);
  if (search) params.set('q', search);
  if (mine) params.set('mine', '1');
  return request(`/api/runs?${params.toString()}`);
}

export function fetchRun(runId) {
  return request(`/api/runs/${runId}`);
}

export function fetchRunStats({ days = 30, toolId } = {}) {
  const params = new URLSearchParams({ days: String(days) });
  if (toolId) params.set('toolId', toolId);
  return request(`/api/runs/stats?${params.toString()}`);
}

// Deep link into the full run history, pre-filtered to what the caller is
// showing, so "View all" lands on the same set of runs the panel had.
export function runsPageHref({ toolId, search, mine } = {}) {
  const params = new URLSearchParams();
  if (toolId) params.set('tool', toolId);
  if (search) params.set('q', search);
  if (mine) params.set('mine', '1');
  const qs = params.toString();
  return qs ? `/runs?${qs}` : '/runs';
}
