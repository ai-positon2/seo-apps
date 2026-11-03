// Client is always the accent; every competitor shares one muted neutral so
// none of them competes with the client for attention (client highlighting
// spec — color follows the entity, not its rank or row position).
export const CLIENT_COLOR = 'var(--primary)';
export const COMPETITOR_COLOR = 'var(--text-3)';
export const AHEAD_COLOR = 'var(--success)';
export const BEHIND_COLOR = 'var(--warning)';

export function seriesColor(isClient) {
  return isClient ? CLIENT_COLOR : COMPETITOR_COLOR;
}

export function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString();
}

// Compact chart/label formatting — 1.4M / 359K / 13.9K. Exact values still
// live in tooltips and the underlying data table.
export function fmtCompact(n) {
  if (n === null || n === undefined) return '—';
  const num = Number(n);
  const abs = Math.abs(num);
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(num / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `${num}`;
}

export function domainLabel(d) {
  return d?.label || d?.domain || '—';
}

export function scoreColor(score) {
  if (score >= 70) return 'success';
  if (score >= 40) return 'warning';
  return 'danger';
}

// PSI always returns an object per domain, even on failure (dataUnavailable:
// true with null scores) — "usable" means more than just truthy. Shared by
// the Page Speed tab and the dashboard page's self-heal-on-load check.
export function isPageSpeedUsable(pageSpeed) {
  return !!pageSpeed && !pageSpeed.dataUnavailable;
}

export function hasUsablePageSpeed(domains) {
  return (domains || []).some((d) => isPageSpeedUsable(d.pageSpeed));
}

// Client-centric stat used by the KPI scorecard strip: the client's rank
// among all domains for this metric, plus how it compares to the leader and
// to the set's median.
export function computeClientStat(domains, valueFn) {
  const client = domains.find((d) => d.isClient);
  if (!client) return null;
  // No figure for the client (Semrush found nothing): unknown, not a 0 ranked last.
  const own = valueFn(client);
  if (own === null || own === undefined) {
    return { clientValue: null, rank: null, total: domains.length, leaderValue: 0, medianValue: 0, isLeader: false, unknown: true };
  }
  const values = domains.map((d) => ({ id: d.domain, value: valueFn(d) || 0 }));
  const sorted = [...values].sort((a, b) => b.value - a.value);
  const rank = sorted.findIndex((v) => v.id === client.domain) + 1;
  const clientValue = valueFn(client) || 0;
  const leaderValue = sorted[0]?.value || 0;
  const mid = Math.floor(sorted.length / 2);
  const medianValue = sorted.length % 2
    ? sorted[mid].value
    : (sorted[mid - 1].value + sorted[mid].value) / 2;
  return { clientValue, rank, total: domains.length, leaderValue, medianValue, isLeader: rank === 1 };
}
