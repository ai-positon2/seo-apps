// ── Hidden checks (Semrush's "Exclude check") ───────────────────────────────
//
// A client can hide a whole Tech Audit check — one crawl rule, such as
// 'page-4xx' — when it does not apply to them. A hidden check behaves as if it
// did not exist: it costs no points, is not counted as an error, warning or
// notice, is not on the fix list and is not in the downloads. It applies to
// every crawl of the project, past and future, so the change indicator still
// compares like with like.
//
// Stored in the project's settings (crawl_projects.settings.hiddenChecks) as
// [{ ruleId, hiddenBy, hiddenAt, reason }], written by store.hideCheck /
// store.unhideCheck. Everything that READS crawl findings for scoring applies
// the exclusion; this file holds the pieces they share, so "hidden" means one
// thing everywhere:
//
//   hiddenRuleIds()          the sorted rule ids, from settings or a project
//   HIDDEN_RULES_FOR_RUN()   the same list in SQL, from a crawl run's project
//   excludeHidden()          drop hidden rows from a JS list
//   subtractHidden()         take hidden rules' findings out of summary.counts
//
// A project with nothing hidden gets an empty list, and every exclusion below is
// then a no-op (`x <> all('{}')` is true for every x), so its scores are exactly
// what they were before this existed.

const db = require('../../services/db');

// How many checks one client may hide. The catalog has ~130 rules; this is a
// bound on a jsonb array that a request can grow, not a product limit.
const MAX_HIDDEN_CHECKS = 200;
// A crawl rule id: 'page-4xx', 'broken-internal-links', 'cwv-inp-poor'. Not
// checked against the catalog, which does not list every rule a crawl can store
// (PageSpeed's are added after the crawl), but nothing else gets in.
const RULE_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/i;
const MAX_REASON = 500;

function normalizeRuleId(value) {
  const id = String(value ?? '').trim();
  return RULE_ID_RE.test(id) ? id : null;
}

/** The stored entries, cleaned: well-formed, one per rule, oldest first. */
function hiddenChecksOf(settings) {
  const list = Array.isArray(settings?.hiddenChecks) ? settings.hiddenChecks : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const ruleId = normalizeRuleId(entry?.ruleId);
    if (!ruleId || seen.has(ruleId)) continue;
    seen.add(ruleId);
    out.push({
      ruleId,
      hiddenBy: entry.hiddenBy ? String(entry.hiddenBy) : null,
      hiddenAt: entry.hiddenAt ? String(entry.hiddenAt) : null,
      reason: entry.reason ? String(entry.reason).slice(0, MAX_REASON) : null,
    });
  }
  return out;
}

/**
 * The hidden rule ids, sorted and unique. Takes a settings object, a project
 * row ({ settings }), a project view ({ hiddenChecks }) or a list of ids.
 */
function hiddenRuleIds(source) {
  let ids;
  if (Array.isArray(source)) ids = source.map((x) => (typeof x === 'string' ? x : x?.ruleId));
  else if (Array.isArray(source?.hiddenChecks)) ids = source.hiddenChecks.map((x) => (typeof x === 'string' ? x : x?.ruleId));
  else if (source?.settings) ids = hiddenChecksOf(source.settings).map((x) => x.ruleId);
  else ids = [];
  return [...new Set(ids.map(normalizeRuleId).filter(Boolean))].sort();
}

/** Rows whose rule is not hidden. `key` names the rule id field. */
function excludeHidden(rows, hidden, key = 'ruleId') {
  const set = hidden instanceof Set ? hidden : new Set(hidden || []);
  if (!set.size) return rows || [];
  return (rows || []).filter((row) => !set.has(row?.[key]));
}

/**
 * A run's summary.counts with the hidden rules' findings taken out. `hiddenRows`
 * are those rules' crawl_run_findings rows: { stored_severity|severity, count }.
 * The counts were tallied at crawl time from each finding's stored severity, so
 * that is the severity subtracted from. Never below zero.
 */
function subtractHidden(counts, hiddenRows) {
  const out = { ...(counts || {}) };
  for (const row of hiddenRows || []) {
    const severity = row.stored_severity || row.severity;
    if (!(severity in out)) continue;
    out[severity] = Math.max(0, (Number(out[severity]) || 0) - (Number(row.count) || 0));
  }
  return out;
}

/**
 * SQL: the hidden rule ids (text[]) of the project a crawl run belongs to —
 * empty for a run with no project or a project with nothing hidden. `runParam`
 * is the placeholder holding the run id, e.g. '$1'.
 */
function HIDDEN_RULES_FOR_RUN(runParam) {
  return `coalesce((select array_agg(distinct h->>'ruleId' order by h->>'ruleId')
                      from crawl_runs hr
                      join crawl_projects hp on hp.id = hr.project_id
                     cross join lateral jsonb_array_elements(
                             case when jsonb_typeof(hp.settings->'hiddenChecks') = 'array'
                                  then hp.settings->'hiddenChecks' else '[]'::jsonb end) h
                     where hr.id = ${runParam}
                       and coalesce(h->>'ruleId', '') <> ''), '{}'::text[])`;
}

/** The hidden rule ids for a crawl run's project; [] for a standalone run. */
async function hiddenRulesForRun(runId, client = db) {
  if (!runId) return [];
  const row = await client.maybeOne(`select ${HIDDEN_RULES_FOR_RUN('$1')} as hidden`, [runId]);
  return hiddenRuleIds(Array.isArray(row?.hidden) ? row.hidden : []);
}

/** A project's hidden check entries, read by id; [] without a project. */
async function hiddenChecksForProject(projectId, client = db) {
  if (!projectId) return [];
  const row = await client.maybeOne(
    `select settings->'hiddenChecks' as hidden from crawl_projects where id = $1`,
    [projectId],
  );
  return hiddenChecksOf({ hiddenChecks: row?.hidden });
}

/**
 * Per run, the finding counts by stored severity that hidden rules contributed
 * — what to take out of each run's summary.counts. Runs with nothing hidden are
 * absent from the map.
 */
async function hiddenCountsForRuns(runIds) {
  const ids = [...new Set((runIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const rows = await db.rows(
    `select f.run_id, f.severity as stored_severity, sum(f.count)::int as count
       from crawl_run_findings f
       join crawl_runs r on r.id = f.run_id
       join crawl_projects p on p.id = r.project_id
      where f.run_id = any($1::uuid[])
        and f.rule_id in (select h->>'ruleId'
                            from jsonb_array_elements(
                                   case when jsonb_typeof(p.settings->'hiddenChecks') = 'array'
                                        then p.settings->'hiddenChecks' else '[]'::jsonb end) h)
      group by 1, 2`,
    [ids],
  );
  const out = new Map();
  for (const row of rows || []) {
    const key = String(row.run_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

module.exports = {
  MAX_HIDDEN_CHECKS,
  MAX_REASON,
  normalizeRuleId,
  hiddenChecksOf,
  hiddenRuleIds,
  excludeHidden,
  subtractHidden,
  HIDDEN_RULES_FOR_RUN,
  hiddenRulesForRun,
  hiddenChecksForProject,
  hiddenCountsForRuns,
};
