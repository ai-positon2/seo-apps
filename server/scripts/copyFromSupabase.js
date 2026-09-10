#!/usr/bin/env node
// ── Copy every row from the old Supabase database into DATABASE_URL ─────────
//
// The app no longer talks to Supabase — it speaks SQL to whatever DATABASE_URL
// points at. This is the data half of that move, kept in the repo because the
// cutover needs it run ONCE MORE at the moment the deployed app is switched
// over: the first copy is a point-in-time snapshot, and anything the live app
// writes to Supabase afterwards is not in it.
//
//   node scripts/copyFromSupabase.js            # copy, then verify
//   node scripts/copyFromSupabase.js --verify   # verify only, change nothing
//
// Needs both connection strings:
//
//   DATABASE_URL      the target (Neon). Use the DIRECT endpoint — the host
//                     WITHOUT "-pooler" — because the whole load is one
//                     transaction and PgBouncer can move a session between
//                     backends.
//   SUPABASE_DB_URL   the source. Supabase's `db.<ref>.supabase.co` host is
//                     IPv6-only unless the IPv4 add-on is enabled, so from an
//                     IPv4-only network use the Supavisor pooler in SESSION
//                     mode instead:
//                       postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres
//
// ── Safety ─────────────────────────────────────────────────────────────────
// The whole load runs in ONE transaction on the target: every table is
// truncated and reloaded together, and any failure rolls the lot back, so the
// target is never left half-copied. That also makes the script idempotent —
// running it twice leaves the same result as running it once.
//
// It is still DESTRUCTIVE to the target: every table listed in the source is
// emptied first. Rows written only to the target — which after cutover means
// real production data — are destroyed. Run it while the app is pointed at
// Supabase, not after it has been serving traffic on the new database.
//
// No trigger juggling is needed: every trigger in this schema is BEFORE
// UPDATE/DELETE, so a pure-INSERT load never fires one. Foreign keys are
// satisfied by loading in topological order, parents first.

const { Client } = require('pg');
const { to: copyTo, from: copyFrom } = require('pg-copy-streams');
const { pipeline } = require('node:stream/promises');

require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });

const VERIFY_ONLY = process.argv.includes('--verify');

const SOURCE = process.env.SUPABASE_DB_URL;
const TARGET = process.env.DATABASE_URL;

function connect(connectionString, label) {
  if (!connectionString) {
    console.error(`[copyFromSupabase] ${label} is not set. See the header of this file.`);
    process.exit(1);
  }
  return new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 0,
  });
}

// Supabase sets a role-level statement_timeout that the connection option does
// not override, and it cancelled the 753k-row crawl_run_links COPY at ~2min.
async function clearTimeouts(client, label) {
  for (const stmt of [
    'set statement_timeout = 0',
    'set idle_in_transaction_session_timeout = 0',
    'set lock_timeout = 0',
  ]) {
    try {
      await client.query(stmt);
    } catch (e) {
      console.warn(`  (${label}: ${stmt} refused — ${e.message})`);
    }
  }
}

async function publicTables(client) {
  const { rows } = await client.query(`
    select c.relname as t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname`);
  return rows.map((r) => r.t);
}

/** Parent -> child FK edges, self-references excluded. */
async function fkEdges(client) {
  const { rows } = await client.query(`
    select src.relname as child, tgt.relname as parent
    from pg_constraint co
    join pg_class src on src.oid = co.conrelid
    join pg_class tgt on tgt.oid = co.confrelid
    join pg_namespace n on n.oid = co.connamespace
    where n.nspname = 'public' and co.contype = 'f' and src.relname <> tgt.relname`);
  return rows;
}

function topoSort(tables, edges) {
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of edges) {
    if (deps.has(child) && deps.has(parent)) deps.get(child).add(parent);
  }
  const order = [];
  const done = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of tables) {
      if (done.has(t)) continue;
      if ([...deps.get(t)].every((p) => done.has(p))) {
        order.push(t);
        done.add(t);
        progress = true;
      }
    }
  }
  // A cycle would need its FKs dropped for the load; this schema has none, and
  // saying so beats loading them in an order that cannot work.
  const cyclic = tables.filter((t) => !done.has(t));
  return { order, cyclic };
}

async function countRows(client, tables) {
  const out = {};
  for (const t of tables) {
    // eslint-disable-next-line no-await-in-loop
    const r = await client.query(`select count(*)::bigint n from public."${t}"`);
    out[t] = Number(r.rows[0].n);
  }
  return out;
}

(async () => {
  const src = connect(SOURCE, 'SUPABASE_DB_URL');
  const dst = connect(TARGET, 'DATABASE_URL');
  await src.connect();
  await dst.connect();
  await clearTimeouts(src, 'source');
  await clearTimeouts(dst, 'target');

  const tables = await publicTables(src);
  const { order, cyclic } = topoSort(tables, await fkEdges(src));
  if (cyclic.length) {
    console.error('[copyFromSupabase] circular foreign keys — load these by hand after dropping '
      + `their constraints: ${cyclic.join(', ')}`);
    process.exit(1);
  }

  const srcCounts = await countRows(src, order);
  const totalSrc = Object.values(srcCounts).reduce((a, b) => a + b, 0);
  console.log(`source: ${order.length} tables, ${totalSrc} rows`);

  if (!VERIFY_ONLY) {
    const t0 = Date.now();
    let loaded = 0;
    try {
      await dst.query('begin');
      await dst.query(`truncate ${order.map((t) => `public."${t}"`).join(', ')} cascade`);

      for (const t of order) {
        if (!srcCounts[t]) continue;
        const started = Date.now();
        // Binary COPY: exact type fidelity, no text escaping to get wrong.
        const reader = src.query(copyTo(`copy public."${t}" to stdout (format binary)`));
        const writer = dst.query(copyFrom(`copy public."${t}" from stdin (format binary)`));
        // eslint-disable-next-line no-await-in-loop
        await pipeline(reader, writer);
        loaded += srcCounts[t];
        console.log(`  ${t.padEnd(34)} ${String(srcCounts[t]).padEnd(8)} ${((Date.now() - started) / 1000).toFixed(1)}s`);
      }

      await dst.query('commit');
      console.log(`\ncommitted ${loaded} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      await dst.query('rollback').catch(() => {});
      console.error(`\nFAILED, rolled back — the target is unchanged:\n  ${e.message}`);
      await src.end();
      await dst.end();
      process.exit(1);
    }
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  const dstCounts = await countRows(dst, order);
  const mismatched = order.filter((t) => dstCounts[t] !== srcCounts[t]);

  console.log('\nverification');
  if (!mismatched.length) {
    console.log(`  all ${order.length} tables match (${totalSrc} rows)`);
  } else {
    for (const t of mismatched) {
      const delta = dstCounts[t] - srcCounts[t];
      console.log(`  ${t}: source=${srcCounts[t]} target=${dstCounts[t]} (${delta > 0 ? '+' : ''}${delta})`);
    }
    console.log('\n  A target AHEAD of the source means the app has been writing to the target');
    console.log('  since the copy — re-running this would DESTROY those rows. A target BEHIND');
    console.log('  it means the source is still taking live traffic, and the cutover needs');
    console.log('  this run repeated once the old app has stopped writing.');
  }

  await src.end();
  await dst.end();
  process.exit(mismatched.length ? 1 : 0);
})().catch((e) => {
  console.error(`[copyFromSupabase] ${e.message}`);
  process.exit(1);
});
