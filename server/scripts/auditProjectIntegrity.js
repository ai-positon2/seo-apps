#!/usr/bin/env node
// ── Project aggregate integrity report ──────────────────────────────────────
//
//   node scripts/auditProjectIntegrity.js
//   node scripts/auditProjectIntegrity.js --verbose   list the offending rows
//   node scripts/auditProjectIntegrity.js --json      machine-readable
//
// READ ONLY. Writes nothing, fixes nothing.
//
// The product's Project is spread across two tables — crawl_projects holds the
// row, project_domains holds the authoritative primary and competitor domains
// (PRD §8.1, §30.6) — and for a long time two different endpoints created
// projects, only one of which wrote both. This counts what that left behind.
//
// Run it BEFORE migration 0027 to size the backfill, and AFTER to prove it
// landed: every count below must be zero once 0027 has run. It is also the
// regression check for the invariant 0027 enforces, which is:
//
//   no crawl_projects row exists without an active primary project_domains row
//
// Exit code is 1 when any count is non-zero, so CI can fail on a regression.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const db = require('../services/db');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const asJson = args.includes('--json');

// Each check names what is wrong, why it matters, and which phase repairs it.
// `sql` selects the offending rows; the count is the row count.
const CHECKS = [
  {
    key: 'missingPrimaryDomain',
    title: 'Projects with no active primary domain',
    why: 'projectView reports primaryDomain: null and the UI shows "Missing". '
       + 'Created by the CrawlScope write path, which never wrote project_domains.',
    fix: '0027 step 3 backfills from crawl_projects.url',
    sql: `
      select p.id, p.name, p.url, p.workspace_id
        from crawl_projects p
        left join project_domains d
          on d.project_id = p.id and d.role = 'primary' and d.status = 'active'
       where d.id is null
       order by p.created_at desc`,
  },
  {
    key: 'nullWorkspace',
    title: 'Projects with no workspace',
    why: 'Invisible to GET /api/projects, which filters workspace_id = any($1). '
       + 'Also the null-comparison trap that makes setPrimaryDomain throw.',
    fix: "0027 steps 1-2 adopt them into the owner's personal workspace",
    sql: `
      select id, name, url, owner
        from crawl_projects
       where workspace_id is null
       order by created_at desc`,
  },
  {
    key: 'ownerWithoutPersonalWorkspace',
    title: 'Orphan projects whose owner has no personal workspace',
    why: 'A plain UPDATE cannot adopt these — there is nothing to adopt them into. '
       + 'The migration has to create the workspace first.',
    fix: '0027 step 1 creates the workspace + owner membership',
    sql: `
      select p.id, p.name, p.owner, u.email as owner_email
        from crawl_projects p
        join app_users u on u.id = p.owner
       where p.workspace_id is null
         and not exists (
           select 1 from workspaces w
            where w.created_by = p.owner and w.is_personal
         )
       order by p.created_at desc`,
  },
  {
    key: 'nullCountry',
    title: 'Projects with no country',
    why: 'The market every rank and GSC comparison is measured in (AC-004). '
       + 'Repairable by hand in project settings — reported, not fatal.',
    fix: 'user action: set it in project settings',
    sql: `
      select id, name, url
        from crawl_projects
       where country_code is null
         and lifecycle_status <> 'deleted'
       order by created_at desc`,
  },
  {
    key: 'strandedProposals',
    title: 'Competitor domains stranded at status=proposed',
    why: "Every read filters status = 'active', so these are invisible to the "
       + 'whole app. No route approves them and no role can be assigned to try.',
    fix: 'phase 3 adds the approve/reject routes and surfaces them',
    sql: `
      select d.id, d.host, d.project_id, p.name as project_name, d.created_at
        from project_domains d
        join crawl_projects p on p.id = d.project_id
       where d.status = 'proposed'
       order by d.created_at desc`,
  },
  {
    key: 'ownerlessWorkspaces',
    title: 'Workspaces with no owner membership',
    why: 'Nobody can manage members or request deletion. Reachable if a row was '
       + 'inserted outside createWorkspace, which writes both in one transaction.',
    fix: 'manual: grant an owner, or delete the workspace if unused',
    sql: `
      select w.id, w.name, w.created_by, w.created_at
        from workspaces w
       where w.lifecycle_status <> 'purged'
         and not exists (
           select 1 from workspace_members m
            where m.workspace_id = w.id and m.role = 'owner'
         )
       order by w.created_at desc`,
  },
];

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

async function main() {
  if (!db.isDatabaseConfigured()) {
    console.error('DATABASE_URL is not set — nothing to check.');
    process.exit(2);
  }

  const results = [];
  for (const check of CHECKS) {
    try {
      const found = await db.rows(check.sql, []);
      results.push({ ...check, count: found.length, rows: found });
    } catch (error) {
      results.push({ ...check, count: null, error: error.message, rows: [] });
    }
  }

  if (asJson) {
    console.log(JSON.stringify(
      results.map(({ key, title, count, error, rows }) => (
        { key, title, count, error: error || null, rows: verbose ? rows : undefined }
      )),
      null, 2,
    ));
  } else {
    print(results);
  }

  await db.end();

  const failed = results.some((r) => r.count === null || r.count > 0);
  process.exit(failed ? 1 : 0);
}

function print(results) {
  console.log(`\n${BOLD}Project aggregate integrity${RESET}`);
  console.log(`${DIM}${new Date().toISOString()}${RESET}\n`);

  for (const r of results) {
    if (r.count === null) {
      console.log(`${RED}  ?  ${r.title}${RESET}`);
      console.log(`${DIM}     query failed: ${r.error}${RESET}\n`);
      continue;
    }

    const clean = r.count === 0;
    const mark = clean ? `${GREEN}  ok${RESET}` : `${RED}${String(r.count).padStart(4)}${RESET}`;
    console.log(`${mark}  ${clean ? DIM : BOLD}${r.title}${RESET}`);

    if (!clean) {
      console.log(`${DIM}      ${r.why}${RESET}`);
      console.log(`${DIM}      → ${r.fix}${RESET}`);
      if (verbose) {
        for (const row of r.rows.slice(0, 25)) {
          console.log(`${DIM}        ${JSON.stringify(row)}${RESET}`);
        }
        if (r.rows.length > 25) {
          console.log(`${DIM}        … and ${r.rows.length - 25} more${RESET}`);
        }
      }
    }
    console.log('');
  }

  const total = results.reduce((sum, r) => sum + (r.count || 0), 0);
  if (total === 0) {
    console.log(`${GREEN}${BOLD}Every check is clean — the invariant holds.${RESET}\n`);
  } else {
    console.log(`${BOLD}${total} row(s) need attention.${RESET}`);
    if (!verbose) console.log(`${DIM}Re-run with --verbose to list them.${RESET}`);
    console.log('');
  }
}

main().catch(async (error) => {
  console.error('[auditProjectIntegrity]', error.stack || error.message);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(2);
});
