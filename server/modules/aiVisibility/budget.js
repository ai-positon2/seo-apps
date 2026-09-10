// ── Per-client spend ceiling ────────────────────────────────────────────────
//
// The decision was a per-client ceiling where the scheduler "stops and reports
// coverage honestly when it is hit". Both halves of that matter:
//
//   STOPS — the check runs BEFORE each capture, not after. A ceiling enforced
//   after the fact has already spent the money it was meant to prevent.
//
//   REPORTS COVERAGE HONESTLY — a truncated run must not present its result as
//   though the whole prompt set had been asked. METRICS.md §3.1 makes coverage
//   the denominator that everything else is judged against, so a run that
//   measured 30 of 56 prompts reports 30 of 56, and the reports carry the
//   sub-90% warning. Silently reporting a headline over the subset would be a
//   number the client cannot act on and cannot detect.
//
// Spend is summed from `task_cost` on the captures themselves — the REAL cost
// the provider returned, never an estimate. Self-hosted captures cost nothing
// per request, so their rows carry null and contribute nothing; the ceiling
// exists for the DataForSEO fallback and for the LLM extraction pass.

const db = require('../../services/db');

/** Start of the current UTC month. Budgets are monthly, and months are calendar. */
function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * What this project has spent on captures so far this month.
 *
 * Counts every capture row, including failed ones — a provider that charged for
 * a task that returned nothing still charged. Excluding failures would let a
 * project with a high failure rate quietly exceed its ceiling.
 */
async function spentThisMonth(projectId, { since = null } = {}) {
  if (!db.isDatabaseConfigured()) return 0;

  // Summed by the database, in one statement.
  //
  // This used to page through every capture row and add them up here, because a
  // single unbounded select through PostgREST was silently truncated at its
  // max-rows ceiling — so past that cap the sum omitted the rest and the
  // ceiling could never be reached. A budget guard that under-reports spend is
  // worse than none: it reports a number that reads as safety. Aggregating in
  // SQL removes both the paging and the hazard it was working around; there is
  // no row count at which this can come back short.
  try {
    const total = await db.value(
      `select coalesce(sum(task_cost), 0) as spent
         from ai_visibility_captures
        where project_id = $1 and captured_at >= $2 and task_cost is not null`,
      [projectId, since || monthStart()]
    );
    return Number(total || 0);
  } catch (error) {
    throw new Error(`[aiVisibility.budget] ${error.message}`);
  }
}

/**
 * The ceiling configured for a project, or null for none.
 *
 * Null is NOT zero. An unconfigured project has no ceiling and runs freely;
 * treating a missing value as zero would silently stop every run on a project
 * nobody had got round to configuring.
 */
async function ceilingFor(projectId) {
  if (!db.isDatabaseConfigured()) return null;
  let data;
  try {
    data = await db.maybeOne(
      `select monthly_budget_usd from project_module_schedules
        where project_id = $1 and module_key = 'ai_visibility'`,
      [projectId]
    );
  } catch {
    // A missing schedules table means 0019 has not been applied. No ceiling is
    // the safe reading: refusing every run because a migration is pending would
    // take the module down.
    return null;
  }
  const raw = data?.monthly_budget_usd;
  return raw === null || raw === undefined ? null : Number(raw);
}

/**
 * A `shouldStop` function for `captureScheduler.measureSet`.
 *
 * Caches the ceiling and the already-spent baseline once, then tracks in-run
 * spend in memory — a database round trip before every capture would add a
 * query to each of 2,800 captures a day to enforce a limit that moves slowly.
 *
 * @returns {Promise<Function>} async () => reason|null
 */
async function createGuard(projectId, { estimatePerCapture = 0.01 } = {}) {
  const ceiling = await ceilingFor(projectId);
  if (ceiling === null) return async () => null;

  const already = await spentThisMonth(projectId).catch(() => 0);
  let spentInRun = 0;

  const guard = async () => {
    // Compare against the NEXT capture's projected cost, not the current total.
    // Stopping only once already over means the capture that crossed the line
    // was still paid for.
    const projected = already + spentInRun + estimatePerCapture;
    if (projected > ceiling) {
      return `Monthly budget of $${ceiling.toFixed(2)} would be exceeded `
        + `($${(already + spentInRun).toFixed(4)} spent). Remaining prompts were not measured.`;
    }
    return null;
  };

  guard.record = (taskCost) => {
    const n = Number(taskCost);
    if (Number.isFinite(n)) spentInRun += n;
  };
  guard.ceiling = ceiling;
  guard.alreadySpent = already;
  guard.spentInRun = () => spentInRun;

  return guard;
}

module.exports = {
  monthStart,
  spentThisMonth,
  ceilingFor,
  createGuard,
};
