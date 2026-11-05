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

// A figure nobody measured: null/undefined, or a non-number.
export function isUnmeasured(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value));
}

// Wraps a value getter so a field whose Semrush call failed reads as unknown.
// Snapshots stored before failures were saved as null hold a 0 there, with
// the failed call named in fetchErrors ('backlinksOverview', 'domainRank', ...).
export function unlessFailed(errorKey, valueFn) {
  return (d) => ((d?.fetchErrors || []).includes(errorKey) ? null : valueFn(d));
}

// Client-centric stat used by the KPI scorecard strip: the client's rank
// among the MEASURED domains for this metric, plus how it compares to the
// leader and to the set's median. A competitor with no figure is left out of
// the ranking and counted in `unmeasured` — as a 0 it pushed the client up
// ("#1 of 4" over a rival whose numbers never loaded).
export function computeClientStat(domains, valueFn) {
  const client = domains.find((d) => d.isClient);
  if (!client) return null;
  const measured = domains.filter((d) => !isUnmeasured(valueFn(d)));
  const unmeasured = domains.length - measured.length;
  // No figure for the client (Semrush found nothing): unknown, not a 0 ranked last.
  if (isUnmeasured(valueFn(client))) {
    return { clientValue: null, rank: null, total: measured.length, unmeasured, leaderValue: 0, medianValue: 0, isLeader: false, unknown: true };
  }
  const values = measured.map((d) => ({ id: d.domain, value: Number(valueFn(d)) }));
  const sorted = [...values].sort((a, b) => b.value - a.value);
  const rank = sorted.findIndex((v) => v.id === client.domain) + 1;
  const clientValue = Number(valueFn(client));
  const leaderValue = sorted[0]?.value || 0;
  const mid = Math.floor(sorted.length / 2);
  const medianValue = sorted.length % 2
    ? sorted[mid].value
    : (sorted[mid - 1].value + sorted[mid].value) / 2;
  return { clientValue, rank, total: measured.length, unmeasured, leaderValue, medianValue, isLeader: rank === 1 };
}

// Rows for a ranked bar chart: measured rows by value (leader first), then
// the unmeasured ones, flagged, with no value to draw.
export function rankedRows(domains, valueFn, isUnknown = (d) => isUnmeasured(valueFn(d))) {
  const known = [];
  const unknown = [];
  for (const d of domains) {
    const row = { id: d.domain, label: d.label || d.domain, isClient: d.isClient };
    if (isUnknown(d)) unknown.push({ ...row, value: null, unknown: true });
    else known.push({ ...row, value: Number(valueFn(d)) || 0, unknown: false });
  }
  known.sort((a, b) => b.value - a.value);
  return { rows: [...known, ...unknown], leader: known[0]?.value || 0 };
}

// ── Sitemap rows (Content Analysis) ─────────────────────────────────────────
// A site whose bot protection refused the check ('blocked') or that has no
// readable sitemap ('not-found') was not measured: no bar, no "0 pages".
export function sitemapStatusText(d) {
  if (d?.sitemapStatus === 'blocked') return 'Couldn’t check: the site blocked our request';
  if (d?.sitemapStatus !== 'found') return 'No sitemap found';
  return null;
}

export function sitemapFootnote(d) {
  if (d?.sitemapStatus === 'blocked') {
    const status = /HTTP (\d{3})/.exec(d.error || '')?.[1];
    return `couldn’t check — the site blocked our request${status ? ` (HTTP ${status})` : ''}, so its sitemap is unknown, not missing.`;
  }
  return 'no accessible sitemap found.';
}

// A count that is a lower bound: the crawl budget ran out, or a declared
// sitemap could not be read.
export function isSitemapPartial(d) {
  return d?.sitemapStatus === 'found' && !!(d.capped || d.partial);
}

// The branded-keyword cell: a capped count is "at least N", so "40+".
export function brandedCountText(d) {
  if (isUnmeasured(d?.brandedKeywordCount)) return '—';
  const n = Number(d.brandedKeywordCount).toLocaleString();
  return d.brandedKeywordCountCapped ? `${n}+` : n;
}

// Can the branded / non-branded split be drawn as a share for this domain?
// Not when the branded count is capped (the rest is unknown) or missing.
export function hasBrandedShare(d) {
  return !d?.brandedKeywordCountCapped
    && !isUnmeasured(d?.brandedKeywordCount)
    && !isUnmeasured(d?.nonBrandedKeywordCount);
}
