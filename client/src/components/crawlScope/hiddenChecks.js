// ── Hidden checks on the Tech Audit report ──────────────────────────────────
//
// A client can hide a whole check (Semrush's "Exclude check"); it is stored on
// the project (server/modules/projects/hiddenChecks.js) and applies to every
// crawl of it. The report treats a hidden check as if it did not exist: its
// findings are taken out BEFORE anything is scored or grouped, so the score,
// the bars, the counts, the tabs and the fix order all come from the rest.
// crawlHelpers' scoring functions are not touched — they simply never see the
// hidden findings.
//
// Pure functions, so the page's behaviour is testable without rendering it.

/** The hidden rule ids as a Set, from the stored entries ({ ruleId }) or ids. */
export function hiddenRuleSet(hidden) {
  return new Set((hidden || []).map((h) => (typeof h === 'string' ? h : h?.ruleId)).filter(Boolean));
}

/**
 * Rows whose rule is not hidden. `key` names the rule id field ('ruleId' on a
 * finding and a rollup row). The same array back when nothing is hidden, so a
 * report with no hidden checks computes exactly what it did before.
 */
export function withoutHidden(rows, hiddenSet, key = 'ruleId') {
  if (!Array.isArray(rows)) return rows;
  if (!hiddenSet || !hiddenSet.size) return rows;
  return rows.filter((row) => !hiddenSet.has(row?.[key]));
}

/**
 * The run with its stored "since the last crawl" comparison (summary.comparison:
 * { totals, byRule }) recounted without the hidden rules, so "N new issues, M
 * fixed" compares the same checks on both crawls. The same run back when
 * nothing hidden is in it.
 */
export function runWithoutHiddenComparison(run, hiddenSet) {
  const comparison = run?.summary?.comparison;
  if (!comparison?.totals || !comparison.byRule || !hiddenSet || !hiddenSet.size) return run;
  const hiddenHere = Object.keys(comparison.byRule).filter((id) => hiddenSet.has(id));
  if (!hiddenHere.length) return run;
  const totals = { ...comparison.totals };
  const byRule = { ...comparison.byRule };
  for (const id of hiddenHere) {
    for (const kind of ['new', 'fixed', 'persisting']) {
      totals[kind] = Math.max(0, (Number(totals[kind]) || 0) - (Number(byRule[id]?.[kind]) || 0));
    }
    delete byRule[id];
  }
  return { ...run, summary: { ...run.summary, comparison: { ...comparison, totals, byRule } } };
}

/**
 * The "Hidden checks" list: one row per hidden check, with how often it fired
 * in this crawl. `rollup` (a capped run's per-rule counts over every finding)
 * is preferred to the loaded findings, which may be a part of them.
 */
export function hiddenCheckRows(hidden, { catalogById = new Map(), findings = [], rollup = null } = {}) {
  const byRule = new Map();
  for (const f of findings || []) {
    if (!f?.ruleId) continue;
    const row = byRule.get(f.ruleId) || { count: 0, urls: new Set(), severity: f.severity };
    row.count += 1;
    if (f.url) row.urls.add(f.url);
    byRule.set(f.ruleId, row);
  }
  const rolled = new Map((rollup || []).map((r) => [r.ruleId, r]));
  return (hidden || [])
    .map((h) => (typeof h === 'string' ? { ruleId: h } : h))
    .filter((h) => h?.ruleId)
    .map((h) => {
      const loaded = byRule.get(h.ruleId);
      const full = rolled.get(h.ruleId);
      const entry = catalogById.get?.(h.ruleId);
      return {
        ruleId: h.ruleId,
        title: entry?.title || full?.title || h.ruleId,
        severity: loaded?.severity || full?.severity || entry?.severity || null,
        count: full ? Number(full.count) || 0 : loaded?.count || 0,
        pages: full ? Number(full.pages) || 0 : loaded?.urls.size || 0,
        hiddenBy: h.hiddenBy || null,
        hiddenAt: h.hiddenAt || null,
        reason: h.reason || null,
      };
    });
}

/** The site-health card's note, or null when nothing is hidden. */
export function hiddenChecksNote(count) {
  const n = Number(count) || 0;
  if (!n) return null;
  return `${n} check${n === 1 ? '' : 's'} hidden — excluded from this score`;
}

/** The list with one check added (optimistically), keeping the order. */
export function addHidden(hidden, entry) {
  const list = Array.isArray(hidden) ? hidden : [];
  if (!entry?.ruleId || list.some((h) => h.ruleId === entry.ruleId)) return list;
  return [...list, entry];
}

/** The list with one check taken out. */
export function removeHidden(hidden, ruleId) {
  const list = Array.isArray(hidden) ? hidden : [];
  return list.filter((h) => h.ruleId !== ruleId);
}

/** What the confirm says: removed from the score, for this client, on every crawl. */
export function hideConfirmText(title) {
  return `“${title}” will be removed from the site health score for this client on every crawl — `
    + 'past and future. It will not count as an error, warning or notice, and it leaves the issue list, '
    + 'the fix list and the downloads. You can restore it at any time from Hidden checks.';
}

export const HIDE_DENIED_TOOLTIP = 'Only approvers, admins and owners can hide checks for this client.';
