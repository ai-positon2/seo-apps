// ── SEMrush API-unit ledger + caps ────────────────────────────────────────────
// Enforces two limits, both tracked locally (this tool's usage only):
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
// All ledger mutations run through an in-process async mutex → atomic within this
// Node process. (A multi-instance deployment would need an external lock; noted.)
//
// Only genuine fetches consume units — cache hits cost 0 and never reach here.

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const { resolveDataRoot } = require('../../services/dataRoot');

// Same directory as store.js on purpose — one module, one data root.
const DATA_DIR = resolveDataRoot(
  'market-potential', path.join(__dirname, 'data'), 'MARKET_POTENTIAL_DATA_ROOT',
);
const LEDGER_PATH = path.join(DATA_DIR, 'semrushUsage.json');
const MAX_RUNS_PER_DAY_LOG = 500; // audit trail cap to keep the file bounded

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

async function readLedger() {
  try {
    return JSON.parse(await fs.readFile(LEDGER_PATH, 'utf8'));
  } catch {
    return {};
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeLedger(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${LEDGER_PATH}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  // Windows EPERM/EBUSY on rename-over-existing — retry with backoff (see store.js).
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, LEDGER_PATH);
      return;
    } catch (err) {
      if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code) && attempt < 10) {
        await sleep(20 * (attempt + 1));
        continue;
      }
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }
}

// ── In-process mutex: serialize all read-modify-write cycles ───────────────────
let chain = Promise.resolve();
function withLock(fn) {
  const next = chain.then(fn, fn);
  chain = next.then(() => {}, () => {});
  return next;
}

function dayOf(ledger, date) {
  return ledger[date] || { units: 0, runs: [] };
}

// Current status (no mutation) — for the UI banner / cost preview.
async function getStatus() {
  const cfg = config();
  const ledger = await readLedger();
  const date = today();
  const day = dayOf(ledger, date);
  return {
    date,
    rate: cfg.rate,
    perRunCap: cfg.perRunCap,
    dailyCap: cfg.dailyCap,
    dailyUsed: day.units,
    dailyRemaining: Math.max(0, cfg.dailyCap - day.units),
  };
}

// Atomically check both caps and, if OK, reserve the estimate.
// Returns { ok:true, reservationId, date, estimate } or
//         { ok:false, reason:'per_run'|'daily', ...context }.
async function reserve({ userId, estimate, regions }) {
  return withLock(async () => {
    const cfg = config();
    const date = today();

    if (estimate > cfg.perRunCap) {
      return { ok: false, reason: 'per_run', estimate, perRunCap: cfg.perRunCap };
    }

    const ledger = await readLedger();
    const day = dayOf(ledger, date);

    if (day.units + estimate > cfg.dailyCap) {
      return {
        ok: false, reason: 'daily', estimate,
        dailyUsed: day.units, dailyCap: cfg.dailyCap,
        dailyRemaining: Math.max(0, cfg.dailyCap - day.units),
      };
    }

    const reservationId = genId();
    day.units += estimate;
    day.runs.push({ id: reservationId, userId: userId || 'anon', estimate, actual: null, regions: regions || 0, at: new Date().toISOString() });
    if (day.runs.length > MAX_RUNS_PER_DAY_LOG) day.runs = day.runs.slice(-MAX_RUNS_PER_DAY_LOG);
    ledger[date] = day;
    await writeLedger(ledger);

    return { ok: true, reservationId, date, estimate };
  });
}

// Replace a reservation's estimate with the actual units consumed.
async function reconcile({ date, reservationId, actual }) {
  return withLock(async () => {
    const ledger = await readLedger();
    const day = dayOf(ledger, date);
    const run = day.runs.find((r) => r.id === reservationId);
    if (!run) return; // reservation missing (e.g. day rolled over) — leave as-is
    const delta = actual - run.estimate; // ≤ 0 → refund the unused reservation
    day.units = Math.max(0, day.units + delta);
    run.actual = actual;
    ledger[date] = day;
    await writeLedger(ledger);
  });
}

// Release a reservation entirely (run failed before consuming anything).
async function release({ date, reservationId }) {
  return reconcile({ date, reservationId, actual: 0 });
}

module.exports = { config, getStatus, reserve, reconcile, release, today };
