// ── Database capacity watch ─────────────────────────────────────────────────
// Answers "how close is the database to full?", loudly and before the answer
// matters.
//
// Why this exists: the hosted database has a hard size cap, and when it was
// reached the only symptom was a write failing deep inside an unrelated
// feature — `[recordStore.insert lpb_services] could not extend file because
// project size limit (512 MB) has been exceeded`. That message names the
// insert that happened to be unlucky, not the table that filled the disk (in
// that instance a crawl module's link table held 308 MB of rows nothing reads,
// while the insert that failed needed a hundred kilobytes). Nothing warned,
// nothing was watching, and diagnosing it meant querying pg_class by hand.
//
// So: check the size on a timer, log once when it crosses a threshold, and
// expose the same numbers — plus the biggest tables — to the admin screen, so
// the next time this happens the answer is on a page rather than in a psql
// session.
//
// Read-only. This module never deletes anything: what is safe to drop is a
// judgement about the product, not about bytes.

const { getPool, isDatabaseConfigured } = require('./db');

// The cap the host enforces. Defaults to 512 MB — the tier this project runs
// on — because a default of "unlimited" would make the whole module silent on
// exactly the deployment that needs it. Set to 0 to disable the thresholds
// (usage is still reported, just never judged).
const LIMIT_BYTES = Math.round(Number(process.env.DATABASE_SIZE_LIMIT_MB ?? 512) * 1024 * 1024);

// Two thresholds, because they mean different things: `warning` is "plan the
// clean-up", `critical` is "the next big write may fail".
const WARN_RATIO = Number(process.env.DATABASE_SIZE_WARN_RATIO ?? 0.75);
const CRITICAL_RATIO = Number(process.env.DATABASE_SIZE_CRITICAL_RATIO ?? 0.9);

const CHECK_INTERVAL_MS = Math.max(60_000, Number(process.env.DATABASE_SIZE_CHECK_MS ?? 30 * 60_000));
// The admin screen can be refreshed as fast as someone can click, and
// pg_database_size walks the directory — so a reading is reused briefly.
const CACHE_TTL_MS = 60_000;

let cached = null;
let timer = null;
// Log once per level change, not once per check: a database sitting at 80% for
// a week should produce one warning line, not 336 of them.
let lastLoggedLevel = null;

function levelFor(ratio) {
  if (!LIMIT_BYTES || ratio == null) return 'unknown';
  if (ratio >= CRITICAL_RATIO) return 'critical';
  if (ratio >= WARN_RATIO) return 'warning';
  return 'ok';
}

function prettyBytes(bytes) {
  const n = Number(bytes) || 0;
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

// The biggest tables, so the report names the cause and not just the symptom.
// Only fetched when there is something to act on: it is a heavier query than
// the size itself, and at 20% full nobody needs the breakdown.
async function biggestTables(pool, limit = 5) {
  const { rows } = await pool.query(
    `select c.relname as table_name,
            pg_total_relation_size(c.oid) as bytes,
            coalesce(s.n_live_tup, 0) as rows
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_stat_user_tables s on s.relid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
      order by pg_total_relation_size(c.oid) desc
      limit $1`,
    [limit],
  );
  return rows.map(r => ({
    table: r.table_name,
    bytes: Number(r.bytes),
    pretty: prettyBytes(r.bytes),
    rows: Number(r.rows),
  }));
}

// Never throws: a capacity check that takes a request down with it is worse
// than no capacity check. A failed reading reports level 'unknown'.
async function measure({ withTables = false } = {}) {
  if (!isDatabaseConfigured()) {
    return { configured: false, level: 'unknown', bytes: null, limitBytes: LIMIT_BYTES };
  }
  try {
    const pool = getPool();
    const { rows } = await pool.query('select pg_database_size(current_database()) as bytes');
    const bytes = Number(rows[0].bytes);
    const ratio = LIMIT_BYTES ? bytes / LIMIT_BYTES : null;
    const level = levelFor(ratio);
    return {
      configured: true,
      level,
      bytes,
      pretty: prettyBytes(bytes),
      limitBytes: LIMIT_BYTES,
      limitPretty: LIMIT_BYTES ? prettyBytes(LIMIT_BYTES) : null,
      ratio,
      percent: ratio == null ? null : Math.round(ratio * 1000) / 10,
      freeBytes: LIMIT_BYTES ? Math.max(0, LIMIT_BYTES - bytes) : null,
      freePretty: LIMIT_BYTES ? prettyBytes(Math.max(0, LIMIT_BYTES - bytes)) : null,
      thresholds: { warn: WARN_RATIO, critical: CRITICAL_RATIO },
      tables: (withTables || level === 'warning' || level === 'critical')
        ? await biggestTables(pool).catch(() => [])
        : [],
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { configured: true, level: 'unknown', bytes: null, limitBytes: LIMIT_BYTES, error: e.message };
  }
}

async function getUsage({ force = false, withTables = false } = {}) {
  const fresh = cached && Date.now() - cached.at < CACHE_TTL_MS
    && (!withTables || (cached.value.tables || []).length);
  if (fresh && !force) return cached.value;
  const value = await measure({ withTables });
  cached = { at: Date.now(), value };
  return value;
}

function describe(usage) {
  const biggest = (usage.tables || [])[0];
  return `Database is at ${usage.pretty} of ${usage.limitPretty} (${usage.percent}%), ${usage.freePretty} free.`
    + (biggest ? ` Largest table: ${biggest.table} at ${biggest.pretty} (${biggest.rows.toLocaleString()} rows).` : '');
}

async function check() {
  const usage = await getUsage({ force: true });
  if (usage.level === 'critical' || usage.level === 'warning') {
    // Only when the level CHANGES, so a long stay at one level is one line.
    if (usage.level !== lastLoggedLevel) {
      const prefix = usage.level === 'critical' ? '[DbCapacity] CRITICAL' : '[DbCapacity] WARNING';
      console.warn(`${prefix} — ${describe(usage)} Writes will start failing when it is full.`);
    }
  } else if (lastLoggedLevel === 'critical' || lastLoggedLevel === 'warning') {
    console.log(`[DbCapacity] Recovered — ${describe(usage)}`);
  }
  lastLoggedLevel = usage.level;
  return usage;
}

function init() {
  if (timer) { clearInterval(timer); timer = null; }
  if (!isDatabaseConfigured()) {
    console.log('[DbCapacity] Database not configured — capacity watch not started.');
    return;
  }
  // Checked at startup too: a deployment that comes up already near the cap
  // should say so immediately, not in half an hour.
  check().catch(err => console.error('[DbCapacity] Check failed:', err.message));
  timer = setInterval(() => {
    check().catch(err => console.error('[DbCapacity] Check failed:', err.message));
  }, CHECK_INTERVAL_MS);
  // Never hold the process open for a monitoring timer.
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[DbCapacity] Watching — limit ${LIMIT_BYTES ? prettyBytes(LIMIT_BYTES) : 'none'}, warn at ${Math.round(WARN_RATIO * 100)}%, every ${Math.round(CHECK_INTERVAL_MS / 60000)} min.`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  init, stop, check, getUsage, describe, prettyBytes, levelFor,
  LIMIT_BYTES, WARN_RATIO, CRITICAL_RATIO,
};
