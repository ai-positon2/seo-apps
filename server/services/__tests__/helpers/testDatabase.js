// ── Where the database-backed tests are allowed to run ──────────────────────
//
// A few suites here assert things only Postgres can answer — that two claimers
// produce one winner, that `heartbeat_at < x` is NULL rather than false for a
// NULL column, that a SUM does not truncate. Those have to run real SQL.
//
// They must NOT run against a database an application is using, and this guard
// is why. The queue tests insert QUEUED runs; a live module worker polling the
// same database claims them within seconds and executes them — which made the
// suite fail at random (a different assertion each run, because the race landed
// in a different place) and, worse, handed real work to a production worker.
// Measured against the deployed app: a bait run inserted here was claimed by
// worker `e9e5d18c533e:14` in under five seconds and taken to a terminal state.
// An ai_visibility run picked up that way spends real provider budget.
//
// So these suites require TEST_DATABASE_URL — a throwaway database with the
// schema applied and nothing else connected to it. DATABASE_URL is deliberately
// NOT accepted as a fallback: on any machine configured to run the app, that is
// precisely the database it would be unsafe to use.
//
//   TEST_DATABASE_URL=postgresql://... npm test
//
// Without it they skip, so `npm test` still passes on a fresh checkout.

/**
 * Point services/db at the throwaway database, or report why the suite is
 * skipping. Must be called BEFORE services/db builds its pool — the connection
 * string is read lazily, on first use, so requiring db earlier is fine but
 * querying it is not.
 *
 * @param {string} suite name, for the skip message
 * @returns {boolean} whether the caller should run
 */
function useTestDatabase(suite) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.log(
      `${suite}: SKIPPED — set TEST_DATABASE_URL to a throwaway Postgres database to run these.\n`
      + '  Not DATABASE_URL: these tests queue runs that a live worker sharing that '
      + 'database would claim and execute.'
    );
    return false;
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    console.log(
      `${suite}: SKIPPED — TEST_DATABASE_URL is the same database as DATABASE_URL.\n`
      + '  Point it at a throwaway one; a worker on the app database would claim '
      + 'the runs these tests queue.'
    );
    return false;
  }
  process.env.DATABASE_URL = url;
  return true;
}

module.exports = { useTestDatabase };
