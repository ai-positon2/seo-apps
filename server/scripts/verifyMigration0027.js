#!/usr/bin/env node
// ── Dry-run migration 0027 and roll it back ─────────────────────────────────
//
//   node scripts/verifyMigration0027.js
//
// Applies supabase/migrations/0027_project_aggregate_integrity.sql inside a
// transaction, runs every check the migration's own verification block
// describes, then ROLLS BACK. Postgres DDL is transactional, so this exercises
// the real schema against the real data and leaves nothing behind.
//
// It is how 0027 gets tested on a machine with no throwaway database: applying
// it for real would be hard to undo (NOT NULL constraints, swapped foreign
// keys, a new constraint trigger), and shipping an unverified migration that
// rewrites foreign keys is worse.
//
// What it proves:
//   * the file parses and applies against the live schema
//   * it is re-runnable (applied twice in the same transaction)
//   * the backfills leave no violating row
//   * both foreign keys end up RESTRICT and both columns NOT NULL
//   * the deferred trigger actually rejects a project with no primary domain
//
// What it cannot prove: behaviour across two SEPARATE transactions, and how
// long the ACCESS EXCLUSIVE locks are held on a large table. Both are worth a
// look on a real staging database before this ships to production.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('node:fs');
const path = require('node:path');
const db = require('../services/db');

const MIGRATION = path.join(
  __dirname, '..', '..', 'supabase', 'migrations', '0027_project_aggregate_integrity.sql',
);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// Thrown at the end of the transaction body so db.tx rolls back. Carries the
// results out, because a rollback is the success path here.
class Rollback extends Error {
  constructor(checks) { super('planned rollback'); this.checks = checks; }
}

async function main() {
  if (!db.isDatabaseConfigured()) {
    console.error('DATABASE_URL is not set — nothing to verify against.');
    process.exit(2);
  }

  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const checks = [];
  const record = (name, pass, detail) => checks.push({ name, pass, detail });

  try {
    await db.tx(async (t) => {
      // ── apply, twice ─────────────────────────────────────────────────────
      await t.query(sql);
      record('migration applies', true, null);

      await t.query(sql);
      record('migration is re-runnable (applied twice)', true, null);

      // ── the migration's own verification block ───────────────────────────
      const nullWorkspace = await t.rows(
        `select id, name from crawl_projects where workspace_id is null`);
      record('every project has a workspace', nullWorkspace.length === 0,
        `${nullWorkspace.length} without one`);

      const noPrimary = await t.rows(`
        select p.id, p.name, p.url from crawl_projects p
          left join project_domains d
            on d.project_id = p.id and d.role = 'primary' and d.status = 'active'
         group by p.id, p.name, p.url having count(d.id) <> 1`);
      record('every project has exactly one active primary domain', noPrimary.length === 0,
        noPrimary.length
          ? `${noPrimary.length} without one (unparseable url — reported, not guessed): `
            + noPrimary.slice(0, 5).map((r) => r.url).join(', ')
          : null);

      const mismatched = await t.rows(`
        select d.id from project_domains d
          join crawl_projects p on p.id = d.project_id
         where d.workspace_id is distinct from p.workspace_id`);
      record('every domain agrees with its project about the workspace',
        mismatched.length === 0, `${mismatched.length} mismatched`);

      // ── schema shape ─────────────────────────────────────────────────────
      const fks = await t.rows(`
        select t.relname as tbl, c.conname, c.confdeltype from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
         where c.contype = 'f' and a.attname = 'workspace_id'
           and t.relname in ('crawl_projects', 'project_domains')
         order by t.relname`);
      const allRestrict = fks.length === 2 && fks.every((f) => f.confdeltype === 'r');
      record('both workspace_id foreign keys are ON DELETE RESTRICT', allRestrict,
        fks.map((f) => `${f.tbl}=${f.confdeltype}`).join(' '));

      const nullable = await t.rows(`
        select table_name, is_nullable from information_schema.columns
         where column_name = 'workspace_id'
           and table_name in ('crawl_projects', 'project_domains')
         order by table_name`);
      const allNotNull = nullable.length === 2 && nullable.every((c) => c.is_nullable === 'NO');
      record('both workspace_id columns are NOT NULL', allNotNull,
        nullable.map((c) => `${c.table_name}=${c.is_nullable}`).join(' '));

      const trigger = await t.rows(`
        select tgname, tgdeferrable, tginitdeferred from pg_trigger
         where tgname = 'crawl_projects_require_primary_domain' and not tgisinternal`);
      record('the primary-domain constraint trigger exists and is deferred',
        trigger.length === 1 && trigger[0].tgdeferrable && trigger[0].tginitdeferred,
        trigger.length ? null : 'not found');

      // ── the invariant actually bites ─────────────────────────────────────
      // The trigger is DEFERRED, so it normally fires at COMMIT — which this
      // script never reaches. SET CONSTRAINTS ALL IMMEDIATE forces it to fire
      // now instead, inside a savepoint so the expected failure does not abort
      // the outer transaction.
      let rejected = false;
      let message = null;
      await t.query('savepoint probe');
      try {
        await t.query(`
          insert into crawl_projects (owner, workspace_id, url, cron)
          select owner, workspace_id, 'https://invariant-probe.invalid', '0 3 * * *'
            from crawl_projects limit 1`);
        await t.query('set constraints all immediate');
      } catch (error) {
        rejected = true;
        message = error.message.split('\n')[0];
      }
      await t.query('rollback to savepoint probe');
      await t.query('set constraints all deferred');

      record('a project inserted with no primary domain is rejected', rejected,
        rejected ? `${DIM}${message}${RESET}` : 'the bare insert was ACCEPTED');

      // Prove the check is not simply refusing everything: a project written
      // WITH its domain in the same transaction must be accepted.
      let accepted = false;
      await t.query('savepoint valid');
      try {
        const seed = await t.one(
          `select owner, workspace_id from crawl_projects limit 1`);
        const created = await t.one(`
          insert into crawl_projects (owner, workspace_id, url, cron)
          values ($1, $2, 'https://valid-probe.invalid', '0 3 * * *') returning id`,
          [seed.owner, seed.workspace_id]);
        await t.query(`
          insert into project_domains
            (workspace_id, project_id, role, normalized_origin, host, scheme, raw_input, source, status, created_by)
          values ($1, $2, 'primary', 'https://valid-probe.invalid', 'valid-probe.invalid',
                  'https', 'https://valid-probe.invalid', 'user_entered', 'active', $3)`,
          [seed.workspace_id, created.id, seed.owner]);
        await t.query('set constraints all immediate');
        accepted = true;
      } catch (error) {
        message = error.message.split('\n')[0];
      }
      await t.query('rollback to savepoint valid');
      await t.query('set constraints all deferred');

      record('a project written WITH its primary domain is accepted', accepted,
        accepted ? null : message);

      throw new Rollback(checks);
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      console.error(`\n${RED}${BOLD}Migration failed to apply.${RESET}`);
      console.error(error.message);
      report(checks);
      await db.end();
      process.exit(1);
    }
  }

  report(checks);
  await db.end();
  process.exit(checks.every((c) => c.pass) ? 0 : 1);
}

function report(checks) {
  console.log(`\n${BOLD}Migration 0027 — dry run (applied, checked, rolled back)${RESET}\n`);
  for (const c of checks) {
    const mark = c.pass ? `${GREEN}  ok${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`${mark}  ${c.name}`);
    if (c.detail) console.log(`      ${DIM}${c.detail}${RESET}`);
  }
  const failed = checks.filter((c) => !c.pass).length;
  console.log(failed
    ? `\n${RED}${BOLD}${failed} check(s) failed — do not apply this migration.${RESET}\n`
    : `\n${GREEN}${BOLD}All checks passed. The database is unchanged (rolled back).${RESET}\n`);
}

main().catch(async (error) => {
  console.error('[verifyMigration0027]', error.stack || error.message);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(2);
});
