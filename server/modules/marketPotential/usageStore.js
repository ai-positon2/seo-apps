// ── SEMrush API-unit ledger + caps — backed by Postgres ──────────────────────
// Enforces two limits, both tracked in market_potential_semrush_usage
// (supabase/migrations/0036_market_potential_to_postgres.sql):
//   • per-run cap   (default 10,000 units) — a single run is refused if its
//                     estimate exceeds this, and the WHOLE run is blocked.
//   • daily cap     (default 200,000 units) — system-wide total across all users;
//                     resets at 00:00 UTC.
//
// Accounting is two-phase so caps hold under concurrency and stay accurate:
//   1. reserve(estimate)  — atomically adds the UPPER-BOUND estimate to today's
//                           total before fetching (or refuses). This is what
//                           prevents two concurrent runs from both slipping past.
//   2. reconcile(actual)  — after the run, replaces the reservation with the
//                           ACTUAL units (lines_returned × rate), refunding the
//                           difference. Actual ≤ estimate, so the day total only
//                           ever settles downward.
//
// Only genuine fetches consume units — cache hits cost 0 and never reach here.
//
// ── Why this is not a file any more ─────────────────────────────────────────
// It was semrushUsage.json, and that had two failures of very different sizes.
// The small one: on a container platform without a mounted volume the file went
// with every deploy, so the day's recorded spend silently reset to zero and the
// cap stopped capping. The large one was in its own header —
//
//   "All ledger mutations run through an in-process async mutex → atomic within
//    this Node process. (A multi-instance deployment would need an external
//    lock; noted.)"
//
// — and this app already ran a web process and a module worker against the same
// ledger, so that caveat was not hypothetical: two processes could each read the
// same remaining budget and each reserve against it. Both phases are single
// statements now, so the arithmetic is correct across every process sharing the
// database, which is what a spend limit has to be to mean anything.

const crypto = require('crypto');
const db = require('../../services/db');

const MAX_RUNS_PER_DAY_LOG = 500; // audit trail cap to keep the row bounded

function config() {
  return {
    rate: parseInt(process.env.SEMRUSH_UNIT_RATE) || 10,          // units per line
    perRunCap: parseInt(process.env.MP_PER_RUN_UNIT_CAP) || 10000,
    dailyCap: parseInt(process.env.MP_DAILY_UNIT_CAP) || 200000,
  };
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function genId() {
  return `run_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

async function usedOn(date) {
  const row = await db.maybeOne(
    `select used_units from market_potential_semrush_usage where day = $1`, [date]
  );
  return row ? Number(row.used_units) : 0;
}

// Current status (no mutation) — for the UI banner / cost preview.
async function getStatus() {
  const cfg = config();
  const date = today();
  const dailyUsed = await usedOn(date);
  return {
    date,
    rate: cfg.rate,
    perRunCap: cfg.perRunCap,
    dailyCap: cfg.dailyCap,
    dailyUsed,
    dailyRemaining: Math.max(0, cfg.dailyCap - dailyUsed),
  };
}

// Atomically check both caps and, if OK, reserve the estimate.
// Returns { ok:true, reservationId, date, estimate } or
//         { ok:false, reason:'per_run'|'daily', ...context }.
async function reserve({ userId, estimate, regions }) {
  const cfg = config();
  const date = today();

  if (estimate > cfg.perRunCap) {
    return { ok: false, reason: 'per_run', estimate, perRunCap: cfg.perRunCap };
  }
  // Checked before the statement as well as inside it. The WHERE on the
  // conflict path only runs when a row for today already exists; the very first
  // reservation of the day takes the INSERT path, where nothing would otherwise
  // stop a single estimate larger than the whole daily cap.
  if (estimate > cfg.dailyCap) {
    const dailyUsed = await usedOn(date);
    return {
      ok: false, reason: 'daily', estimate,
      dailyUsed, dailyCap: cfg.dailyCap,
      dailyRemaining: Math.max(0, cfg.dailyCap - dailyUsed),
    };
  }

  const reservationId = genId();
  const run = {
    id: reservationId,
    userId: userId || 'anon',
    estimate,
    actual: null,
    regions: regions || 0,
    at: new Date().toISOString(),
  };

  // The cap test and the addition are the same statement, so two callers cannot
  // both read the same remaining budget. `jsonb - 0` drops the oldest audit
  // entry once the log is at its bound, which is what slice(-500) did.
  const row = await db.maybeOne(
    `insert into market_potential_semrush_usage (day, used_units, runs, updated_at)
     values ($1, $2, jsonb_build_array($3::jsonb), now())
     on conflict (day) do update set
       used_units = market_potential_semrush_usage.used_units + $2,
       runs = case
                when jsonb_array_length(market_potential_semrush_usage.runs) >= $4
                then (market_potential_semrush_usage.runs - 0) || jsonb_build_array($3::jsonb)
                else market_potential_semrush_usage.runs || jsonb_build_array($3::jsonb)
              end,
       updated_at = now()
     where market_potential_semrush_usage.used_units + $2 <= $5
     returning used_units`,
    [date, estimate, db.json(run), MAX_RUNS_PER_DAY_LOG, cfg.dailyCap]
  );

  if (!row) {
    // The conflict path's WHERE rejected it: today's total plus this estimate
    // would pass the daily cap.
    const dailyUsed = await usedOn(date);
    return {
      ok: false, reason: 'daily', estimate,
      dailyUsed, dailyCap: cfg.dailyCap,
      dailyRemaining: Math.max(0, cfg.dailyCap - dailyUsed),
    };
  }

  return { ok: true, reservationId, date, estimate };
}

// Replace a reservation's estimate with the actual units consumed.
async function reconcile({ date, reservationId, actual }) {
  // One statement: the refund and the audit entry move together, and a
  // reservation that is not there (e.g. the day rolled over) matches nothing
  // and leaves the ledger alone — the same outcome the file version had.
  await db.query(
    `update market_potential_semrush_usage mp
        set used_units = greatest(0, mp.used_units + ($3::numeric - coalesce((
              select (entry->>'estimate')::numeric
                from jsonb_array_elements(mp.runs) entry
               where entry->>'id' = $2
               limit 1
            ), 0))),
            runs = coalesce((
              select jsonb_agg(
                       case when entry->>'id' = $2
                            then jsonb_set(entry, '{actual}', to_jsonb($3::numeric))
                            else entry end
                       order by ord)
                from jsonb_array_elements(mp.runs) with ordinality as t(entry, ord)
            ), '[]'::jsonb),
            updated_at = now()
      where mp.day = $1
        and exists (
          select 1 from jsonb_array_elements(mp.runs) entry where entry->>'id' = $2
        )`,
    [date, reservationId, actual]
  );
}

// Release a reservation entirely (run failed before consuming anything).
async function release({ date, reservationId }) {
  return reconcile({ date, reservationId, actual: 0 });
}

module.exports = { config, getStatus, reserve, reconcile, release, today };
