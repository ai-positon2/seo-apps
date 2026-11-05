// ── The crawl report's data, beyond the scoring ─────────────────────────────
//
// Pure helpers for CrawlScopeRunPage that sit beside crawlHelpers rather than
// in it: how a capped finding list is counted, how the analyser's totals are
// checked against what the page holds, and how the crawl's date is said. None
// of them touches the health score.

const DISMISSED = ['False positive', 'Resolved'];
const SEVERITIES = ['error', 'warning', 'notice', 'info'];

/** Result rows with each URL once, the first copy kept (as the stream did). */
export function uniqueByUrl(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (row?.url) {
      if (seen.has(row.url)) continue;
      seen.add(row.url);
    }
    out.push(row);
  }
  return out;
}

/**
 * The issue groups of a CAPPED finding list, counted from every finding.
 *
 * The groups are built from the findings the report holds — at most 50,000,
 * filled most serious first. `rollup` (the findings route's `ruleRollup`) is
 * each rule's count and distinct pages over all of them. Each group takes its
 * counts from it, keeps the instances it has, and is marked `partial` with how
 * many are `loaded` when that is fewer than the rule's count. A rule with no
 * instance in the list still gets a group, so it is not missing from the tabs.
 *
 * Dismissals can only be made on loaded findings, so they are taken off the
 * rule's count here.
 *
 * @param {Array} groups   merged issue groups, each with urls / count / pages
 * @param {Array} rollup   [{ ruleId, severity, title, scope, count, pages }]
 * @param {Array} findings the loaded findings, with review state
 */
export function applyRuleRollup(groups, rollup, findings = []) {
  if (!Array.isArray(rollup) || !rollup.length) return groups;
  const dismissed = new Map();
  const loadedByRule = new Map();
  for (const f of findings) {
    loadedByRule.set(f.ruleId, (loadedByRule.get(f.ruleId) || 0) + 1);
    if (DISMISSED.includes(f.reviewStatus)) dismissed.set(f.ruleId, (dismissed.get(f.ruleId) || 0) + 1);
  }
  const byRule = new Map(rollup.map((row) => [row.ruleId, row]));
  const out = groups.map((g) => {
    const row = byRule.get(g.id);
    if (!row) return g;
    const loaded = g.urls.length;
    const count = Math.max(loaded, row.count - (dismissed.get(g.id) || 0));
    const pages = Math.max(g.pages || 0, row.pages - (count < row.count ? row.count - count : 0));
    return count > loaded ? { ...g, count, pages, loaded, partial: true } : { ...g, count, pages };
  });
  const present = new Set(groups.map((g) => g.id));
  for (const row of rollup) {
    if (present.has(row.ruleId)) continue;
    const count = row.count - (dismissed.get(row.ruleId) || 0);
    // Every finding of the rule is loaded and dismissed: nothing outstanding.
    if (count <= 0 || (loadedByRule.get(row.ruleId) || 0) >= row.count) continue;
    out.push({
      id: row.ruleId,
      label: row.title || row.ruleId,
      severity: row.severity,
      ...(row.scope && row.scope !== 'page' ? { scope: row.scope } : {}),
      urls: [],
      count,
      pages: row.pages,
      loaded: 0,
      partial: true,
    });
  }
  return out;
}

/**
 * The analyser's own finding totals against what this page holds, per severity
 * and at TODAY's severities. For an admin check only; clients never see it.
 *
 * The run's stored `summary.counts` were written under the severities of the
 * day it was analysed, so a rule re-graded since read as a mismatch ("warning
 * 1327/8189") while the totals agreed. The stored per-rule counts
 * (`summary.ruleOrder`) are regraded with the catalog instead; only a run with
 * no ruleOrder falls back to `summary.counts`.
 *
 * What the page holds is the findings it loaded, or — when the list is capped
 * — the full per-rule rollup, which is what the counts on screen use.
 */
export function reconcileFindings({ run, findings = [], rollup = null, capped = null, catalogById = new Map() }) {
  const ruleOrder = run?.summary?.ruleOrder;
  const counts = run?.summary?.counts;
  if (!Array.isArray(ruleOrder) && !counts) return null;
  const analyser = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  if (Array.isArray(ruleOrder) && ruleOrder.length) {
    for (const row of ruleOrder) {
      const sev = catalogById.get(row.ruleId)?.severity || row.severity;
      if (sev in analyser) analyser[sev] += Number(row.count) || 0;
    }
  } else if (counts) {
    for (const s of SEVERITIES) analyser[s] = Number(counts[s]) || 0;
  }
  const shown = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  if (capped && Array.isArray(rollup)) {
    for (const row of rollup) if (row.severity in shown) shown[row.severity] += row.count;
  } else {
    for (const f of findings) if (f.severity in shown) shown[f.severity] += 1;
  }
  const rows = SEVERITIES.map((sev) => ({ sev, analyser: analyser[sev], shown: shown[sev] }));
  const analyserTotal = rows.reduce((sum, r) => sum + r.analyser, 0);
  return {
    rows,
    analyser: analyserTotal,
    shown: rows.reduce((sum, r) => sum + r.shown, 0),
    agrees: rows.every((r) => r.analyser === r.shown),
    notStored: Boolean(analyserTotal) && findings.length === 0,
  };
}

// Spelled out rather than toLocaleDateString, whose month abbreviations differ
// between ICU versions ("Sep" / "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "9 Oct 2026". */
export function shortDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "today", "yesterday", "26 days ago", by calendar day in local time. */
export function ageInDays(value, now = Date.now()) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const day = (t) => { const x = new Date(t); return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()); };
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days.toLocaleString('en-US')} days ago`;
}

/**
 * The header line of a finished crawl: "Crawled 9 Oct 2026 · 26 days ago".
 * Null for a crawl that has not finished, which keeps its live wording.
 */
export function crawledLine(run, status, now = Date.now()) {
  const at = run?.finished_at;
  if (!at) return null;
  const verb = status === 'completed' ? 'Crawled'
    : status === 'stopped' ? 'Stopped'
      : status === 'failed' ? 'Failed'
        : null;
  if (!verb) return null;
  return `${verb} ${shortDate(at)} · ${ageInDays(at, now)}`;
}

/**
 * A location in this report with some address parameters changed: null or ''
 * removes one. For links ('View →') and for opening a view, so Back, reload
 * and a shared link all land in the same place.
 */
export function reportSearch(search, changes) {
  const params = new URLSearchParams(search || '');
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}
