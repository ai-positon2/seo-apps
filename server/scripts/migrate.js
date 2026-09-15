#!/usr/bin/env node
// ── Migration runner ────────────────────────────────────────────────────────
//
//   node scripts/migrate.js --status                 what is applied, what is pending
//   node scripts/migrate.js --dry-run                what WOULD run, in order
//   node scripts/migrate.js --baseline-through 0026  record 0006-0026 as applied
//                                                    WITHOUT running them
//   node scripts/migrate.js                          apply everything pending
//   node scripts/migrate.js --accept-edit 0010       re-record one checksum after
//                                                    a provably schema-neutral edit
//
// Until now migrations were applied by hand and nothing recorded which had been
// applied, so "has this database seen 0023?" was answerable only by inspecting
// the schema and inferring. That is fine with three migrations and untenable
// with twenty-seven.
//
// ── How it behaves ──────────────────────────────────────────────────────────
//   * Files are applied in full-filename lexical order (see ORDERING below).
//   * Each migration and the row recording it commit in ONE transaction, so a
//     failed migration records nothing and a recorded one really ran.
//   * A checksum is stored. Editing a migration after it was applied is
//     reported — loudly, because it means the file no longer describes what the
//     database actually has.
//   * Applying stops at the first failure rather than carrying on, so the error
//     names the migration that broke rather than the next one that depended
//     on it.
//
// ── ORDERING, and the two prefixes shared by two files each ─────────────────
// 0009_lpb_keyword_selections_and_cache_retention.sql and 0009_run_tracking.sql
// share a number. That is untidy but harmless: they touch disjoint tables
// (lpb_keywordselections/cache vs workspaces/tool_runs), and full-filename sort
// is deterministic, so every database applies them in the same order.
//
// 0026 is the same story and was not mentioned here:
// 0026_keyset_pagination_indexes.sql and 0026_lpb_collections.sql. Also
// disjoint (crawl_run_* indexes vs lpb_* tables), and 'k' sorts before 'l', so
// the order is likewise fixed.
//
// Neither pair troubles the bookkeeping: schema_migrations is keyed by full
// FILENAME, not by number, so two files sharing a prefix are two independent
// rows. --baseline-through matches on both `<= cutoff` and `startsWith`, so a
// cutoff of 0009 or 0026 takes both halves of the pair. What a shared prefix
// DOES break is any command that resolves one file from a prefix: see
// --accept-edit, which now refuses an ambiguous prefix rather than guessing.
//
// Do NOT "fix" this by renumbering 0009_run_tracking.sql to a later number. It
// creates workspaces.is_personal, and 0011_platform_foundation.sql line 361
// reads `w.is_personal` in its workspace backfill — moving it after 0011 breaks
// every fresh install, while leaving already-migrated databases working, which
// is the worst possible failure shape.
//
// ── Baselining an existing database ─────────────────────────────────────────
// A database that predates this runner already has its schema. Running the
// migrations against it would mostly be a no-op (they are written to be
// re-runnable) but "mostly" is not a guarantee worth taking with someone's
// data. Use --baseline-through to record what is already applied, then let the
// runner handle everything after it:
//
//   node scripts/migrate.js --baseline-through 0026
//   node scripts/migrate.js --status

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../services/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');

const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const dryRun = args.includes('--dry-run');
const baselineIdx = args.indexOf('--baseline-through');
const baselineThrough = baselineIdx >= 0 ? args[baselineIdx + 1] : null;
const acceptIdx = args.indexOf('--accept-edit');
const acceptEdit = acceptIdx >= 0 ? args[acceptIdx + 1] : null;

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const checksum = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()                                   // full filename: deterministic
    .map((filename) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, sql, checksum: checksum(sql) };
    });
}

// Created on first use rather than by a migration of its own — a migrations
// table that is itself a migration has nowhere to record that it ran.
async function ensureTable() {
  await db.query(`
    create table if not exists schema_migrations (
      filename    text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now(),
      applied_by  text,
      baselined   boolean not null default false
    )`);
}

async function appliedMap() {
  const rows = await db.rows(`select * from schema_migrations`, []);
  return new Map(rows.map((r) => [r.filename, r]));
}

async function main() {
  if (!db.isDatabaseConfigured()) {
    console.error('DATABASE_URL is not set — nothing to migrate.');
    process.exit(2);
  }

  await ensureTable();
  const files = migrationFiles();
  const applied = await appliedMap();

  if (acceptEdit) return accept(files, applied);
  if (baselineThrough) return baseline(files, applied);
  if (statusOnly) return status(files, applied);
  return apply(files, applied);
}

/**
 * Re-records one migration's checksum after a SCHEMA-NEUTRAL edit.
 *
 * The normal answer to "this migration changed" is: don't edit applied
 * migrations, write a new one. This exists for the case where the edit provably
 * changed nothing about the resulting schema — removing a statement that was
 * already dead, correcting a comment — and where leaving the mismatch would
 * block the runner forever on a file nobody can legitimately revert.
 *
 * It updates bookkeeping ONLY. It runs no SQL from the migration, so if the edit
 * was not schema-neutral this quietly records a lie: use it when you can say
 * exactly why the database is unaffected, and write a new migration otherwise.
 */
async function accept(files, applied) {
  // Two prefixes are shared by two files each (0009 and 0026 — see ORDERING at
  // the top). `find()` silently returned whichever sorted first, and the failure
  // that produces is quiet and wrong: edit 0026_lpb_collections.sql, run
  // `--accept-edit 0026`, and the runner inspects 0026_keyset_pagination_indexes
  // instead, finds its checksum intact, prints a green "already matches" and
  // exits 0 — while the mismatch that is actually blocking the runner is
  // untouched. An ambiguous prefix has to be refused, not guessed.
  const matches = files.filter((f) => f.filename === acceptEdit || f.filename.startsWith(acceptEdit));
  if (!matches.length) {
    console.error(`No migration matching "${acceptEdit}".`);
    await db.end();
    process.exit(2);
  }
  if (matches.length > 1) {
    console.error(`\n"${acceptEdit}" matches ${matches.length} migrations:\n`);
    for (const m of matches) console.error(`  ${m.filename}`);
    console.error(`\nName the one you mean in full.\n`);
    await db.end();
    process.exit(2);
  }
  const file = matches[0];
  const row = applied.get(file.filename);
  if (!row) {
    console.error(`${file.filename} is not recorded as applied — nothing to reconcile.`);
    await db.end();
    process.exit(2);
  }
  if (row.checksum === file.checksum) {
    console.log(`\n${GREEN}${file.filename} already matches.${RESET}\n`);
    await db.end();
    process.exit(0);
  }

  await db.query(
    `update schema_migrations set checksum = $2, applied_by = $3 where filename = $1`,
    [file.filename, file.checksum, `accept-edit:${process.env.USER || process.env.USERNAME || 'migrate.js'}`]
  );

  console.log(`\n${YELLOW}Re-recorded${RESET} ${file.filename}`);
  console.log(`${DIM}${row.checksum} → ${file.checksum}`);
  console.log(`No SQL was run. This asserts the edit did not change the schema.${RESET}\n`);
  await db.end();
  process.exit(0);
}

function classify(file, applied) {
  const row = applied.get(file.filename);
  if (!row) return { state: 'pending' };
  if (row.checksum !== file.checksum) return { state: 'changed', row };
  return { state: row.baselined ? 'baselined' : 'applied', row };
}

async function status(files, applied) {
  console.log(`\n${BOLD}Migrations${RESET} ${DIM}(${MIGRATIONS_DIR})${RESET}\n`);
  let pending = 0;
  let changed = 0;

  for (const file of files) {
    const { state, row } = classify(file, applied);
    const mark = {
      applied:   `${GREEN}  ok  ${RESET}`,
      baselined: `${GREEN} base ${RESET}`,
      pending:   `${YELLOW} PEND ${RESET}`,
      changed:   `${RED} EDIT ${RESET}`,
    }[state];
    if (state === 'pending') pending += 1;
    if (state === 'changed') changed += 1;

    const when = row?.applied_at ? ` ${DIM}${String(row.applied_at).slice(0, 10)}${RESET}` : '';
    console.log(`${mark} ${file.filename}${when}`);
    if (state === 'changed') {
      console.log(`${DIM}       recorded ${row.checksum}, file is now ${file.checksum}${RESET}`);
    }
  }

  console.log('');
  if (changed) {
    console.log(`${RED}${BOLD}${changed} migration(s) changed after being applied.${RESET}`);
    console.log(`${DIM}The file no longer describes what this database has. Write a NEW migration`);
    console.log(`rather than editing an applied one.${RESET}\n`);
  }
  console.log(pending
    ? `${YELLOW}${pending} pending.${RESET} Run without --status to apply.\n`
    : `${GREEN}Nothing pending.${RESET}\n`);

  await db.end();
  process.exit(changed ? 1 : 0);
}

async function baseline(files, applied) {
  const cutoff = String(baselineThrough);
  const target = files.filter((f) => f.filename <= cutoff || f.filename.startsWith(cutoff));
  if (!target.length) {
    console.error(`No migrations at or before "${cutoff}".`);
    await db.end();
    process.exit(2);
  }

  const toRecord = target.filter((f) => !applied.has(f.filename));
  console.log(`\n${BOLD}Baselining through ${cutoff}${RESET}`);
  console.log(`${DIM}Recording as applied WITHOUT running. Use only on a database that`);
  console.log(`already has this schema.${RESET}\n`);

  for (const file of toRecord) {
    await db.query(
      `insert into schema_migrations (filename, checksum, applied_by, baselined)
       values ($1, $2, $3, true) on conflict (filename) do nothing`,
      [file.filename, file.checksum, 'baseline']
    );
    console.log(`${GREEN} base ${RESET} ${file.filename}`);
  }

  const skipped = target.length - toRecord.length;
  console.log(`\n${toRecord.length} recorded${skipped ? `, ${skipped} already known` : ''}.`);
  console.log(`${DIM}Run --status to see what is still pending.${RESET}\n`);
  await db.end();
  process.exit(0);
}

async function apply(files, applied) {
  const changed = files.filter((f) => classify(f, applied).state === 'changed');
  if (changed.length) {
    console.error(`\n${RED}${BOLD}Refusing to run.${RESET} These were edited after being applied:\n`);
    for (const f of changed) console.error(`  ${f.filename}`);
    console.error(`\n${DIM}The file no longer describes what this database has. Write a new`);
    console.error(`migration instead of editing an applied one.${RESET}\n`);
    await db.end();
    process.exit(1);
  }

  const pending = files.filter((f) => !applied.has(f.filename));
  if (!pending.length) {
    console.log(`\n${GREEN}Nothing pending.${RESET}\n`);
    await db.end();
    process.exit(0);
  }

  console.log(`\n${BOLD}${dryRun ? 'Would apply' : 'Applying'} ${pending.length} migration(s)${RESET}\n`);
  for (const file of pending) {
    if (dryRun) { console.log(`${YELLOW} PEND ${RESET} ${file.filename}`); continue; }

    const started = Date.now();
    try {
      // The migration and the row recording it, in one transaction: a failure
      // records nothing, and a recorded migration really ran.
      await db.tx(async (t) => {
        await t.query(file.sql);
        await t.query(
          `insert into schema_migrations (filename, checksum, applied_by) values ($1, $2, $3)`,
          [file.filename, file.checksum, process.env.USER || process.env.USERNAME || 'migrate.js']
        );
      });
      console.log(`${GREEN}  ok  ${RESET} ${file.filename} ${DIM}${Date.now() - started}ms${RESET}`);
    } catch (error) {
      console.error(`${RED} FAIL ${RESET} ${file.filename}`);
      console.error(`${DIM}${error.message}${RESET}\n`);
      console.error(`${BOLD}Stopped.${RESET} Nothing from this migration was committed, and the`);
      console.error(`ones after it were not attempted.\n`);
      await db.end();
      process.exit(1);
    }
  }

  console.log(`\n${GREEN}${BOLD}Done.${RESET}\n`);
  await db.end();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('[migrate]', error.stack || error.message);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(2);
});
