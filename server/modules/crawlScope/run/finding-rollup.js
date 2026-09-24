"use strict";

// The per-rule rollup (crawl_run_findings, one row per rule with its count) and
// the run summary's severity counts, from a list of findings. Written when a
// crawl completes (run/manager.js) and again when findings are added to a
// stored run later (run/pagespeed-findings.js), so both write the same shape.

function aggregateFindings(findings, owner, runId) {
  const map = new Map();
  for (const f of findings) {
    const cur =
      map.get(f.ruleId) ||
      {
        run_id: runId,
        owner,
        rule_id: f.ruleId,
        severity: f.severity,
        category: f.category,
        count: 0,
        detail: { title: f.title },
      };
    cur.count += 1;
    map.set(f.ruleId, cur);
  }
  return [...map.values()];
}

function severityCounts(findings) {
  const counts = { error: 0, warning: 0, notice: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }
  return counts;
}

module.exports = { aggregateFindings, severityCounts };
