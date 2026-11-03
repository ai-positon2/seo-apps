// ── Today's rulebook for every crawl ────────────────────────────────────────
//
// A finding's severity is stored when the crawl is analysed. When the catalog
// later re-grades a rule, older crawls kept the old grade, so two projects on
// one dashboard were scored under different rules: Nike's crawl read 29 under
// the rulebook it was analysed with and 66 under today's. Severity is looked
// up from the current catalog whenever findings are read; the stored value is
// only the fallback for a rule the catalog no longer lists.

const catalog = require('./issue-catalog.json');

const SEVERITY_BY_RULE = new Map(
  (Array.isArray(catalog) ? catalog : [])
    .filter((rule) => rule && rule.id && rule.severity)
    .map((rule) => [rule.id, rule.severity]),
);

/** The catalog's current severity for a rule, else the stored one. */
function currentSeverity(ruleId, stored = null) {
  return (ruleId && SEVERITY_BY_RULE.get(ruleId)) || stored || null;
}

/** A finding with its severity brought up to today's catalog (mutates and returns it). */
function regrade(finding) {
  if (finding && typeof finding === 'object') {
    finding.severity = currentSeverity(finding.ruleId, finding.severity);
  }
  return finding;
}

/** The rule → severity table as JSON, for SQL that reads stored findings. */
const SEVERITY_TABLE_JSON = JSON.stringify(Object.fromEntries(SEVERITY_BY_RULE));

module.exports = { currentSeverity, regrade, SEVERITY_TABLE_JSON };
