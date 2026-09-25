#!/usr/bin/env node
// ── Move the file-backed module stores into Postgres ────────────────────────
//
//   node scripts/importFileStores.js --status        what is on disk, what is already imported
//   node scripts/importFileStores.js --dry-run       what WOULD be written
//   node scripts/importFileStores.js                 import everything pending
//   node scripts/importFileStores.js --only content-architect
//
// Run this ONCE per database, AFTER the migrations that create the tables
// (scripts/migrate.js). The module stores read Postgres from that point on, so
// without this step the rows exist but every screen starts empty.
//
// ── What it will not do ─────────────────────────────────────────────────────
// It never deletes or rewrites the JSON files. They stay on disk untouched, so
// a failed import is retried by running this again and a bad import is undone
// by truncating the tables and re-running — neither needs a backup that
// somebody has to have remembered to take.
//
// It is idempotent: every write is an upsert keyed by the record's own id, so
// running it twice imports nothing the second time. That matters because the
// realistic sequence is "import, notice one module was missed, run it again".
//
// ── Where the files are ─────────────────────────────────────────────────────
// Resolved through services/dataRoot.js, exactly as the stores did, so
// APP_DATA_ROOT and the per-module overrides point this at the same directories
// the app was writing. On a deployment that never set them, that is the
// in-tree path and this is the last thing to read it.

const fs = require('node:fs/promises');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const db = require('../services/db');
const { resolveDataRoot } = require('../services/dataRoot');

const args = process.argv.slice(2);
const STATUS = args.includes('--status');
// --status reports without touching the database, so it implies --dry-run.
// Without this it would have counted as a real import and written every row,
// which is the one thing somebody typing "status" is certain not to want.
const DRY_RUN = args.includes('--dry-run') || STATUS;
const only = (() => {
  const i = args.indexOf('--only');
  return i === -1 ? null : args[i + 1];
})();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (v) => (UUID_RE.test(String(v || '')) ? String(v) : null);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

// ── Content Architect ───────────────────────────────────────────────────────

const ARTIFACT_KINDS = [
  ['patterns', '_patterns.json'],
  ['urls', '_urls.json'],
  ['clusters', '_clusters.json'],
  ['full_analysis', '_full_analysis.json'],
];

async function importContentArchitect(report) {
  const root = resolveDataRoot(
    'content-architect',
    path.join(__dirname, '..', 'modules', 'contentArchitect', 'data'),
    'CONTENT_ARCHITECT_DATA_ROOT',
  );

  const projects = await readJson(path.join(root, 'projects.json'), []);
  report.push(`content-architect: ${projects.length} project(s) in ${root}`);
  if (!projects.length) return;

  // A platform project id that is not a uuid cannot go in the column, and the
  // foreign key would reject it even if it could. The record is imported with
  // the value still inside `data` and the LINK dropped, which is the same state
  // as a standalone analysis — visible in the module, just not attached to a
  // project. Reported rather than skipped silently, because an operator who
  // sees a count drop wants to know which ones and why.
  const unlinked = [];
  // The same platform project appearing twice is exactly the duplicate the new
  // unique index exists to prevent. Import the FIRST and report the rest rather
  // than letting the index abort the whole run at an arbitrary point.
  const seenPlatform = new Set();
  const duplicates = [];

  // Both mirrored columns are foreign keys now (0032), and a JSON store had no
  // way to enforce that: these files accumulated workspace and platform-project
  // ids from other databases and from test runs (the `race-…`/`probe-…` rows),
  // none of which exist here. An id that does not resolve is DROPPED rather than
  // failing the import — the analysis is still worth keeping, it just becomes a
  // standalone one. Resolved in two queries rather than one per row.
  const wanted = (key) => [...new Set(
    projects.map((p) => asUuid(p?.[key])).filter(Boolean)
  )];

  const resolved = async (table, ids) => {
    if (!ids.length) return new Set();
    const rows = await db.rows(`select id from ${table} where id = any($1::uuid[])`, [ids]);
    return new Set(rows.map((r) => r.id));
  };

  const knownPlatform = await resolved('crawl_projects', wanted('platformProjectId'));
  const knownWorkspace = await resolved('workspaces', wanted('workspaceId'));

  const droppedPlatform = [];
  const droppedWorkspace = new Set();

  let imported = 0;
  let artifacts = 0;

  for (const project of projects) {
    if (!project?.id) continue;

    let platformId = asUuid(project.platformProjectId);
    if (project.platformProjectId && !platformId) {
      unlinked.push(`${project.id} (${project.platformProjectId})`);
    }
    if (platformId && !knownPlatform.has(platformId)) {
      droppedPlatform.push(`${project.id} -> ${platformId}`);
      platformId = null;
    }
    if (platformId) {
      if (seenPlatform.has(platformId)) {
        duplicates.push(`${project.id} -> ${platformId}`);
        platformId = null;
      } else {
        seenPlatform.add(platformId);
      }
    }

    let workspaceId = asUuid(project.workspaceId);
    if (workspaceId && !knownWorkspace.has(workspaceId)) {
      droppedWorkspace.add(workspaceId);
      workspaceId = null;
    }

    if (!DRY_RUN) {
      await db.query(
        `insert into content_architect_projects
           (id, platform_project_id, workspace_id, data, created_at, updated_at)
         values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), now())
         on conflict (id) do nothing`,
        [
          project.id,
          platformId,
          workspaceId,
          db.json(project),
          project.createdAt || null,
        ]
      );
    }
    imported += 1;

    for (const [kind, suffix] of ARTIFACT_KINDS) {
      const file = path.join(root, `${project.id}${suffix}`);
      if (!(await exists(file))) continue;
      const payload = await readJson(file, null);
      if (payload === null) continue;
      if (!DRY_RUN) {
        await db.query(
          `insert into content_architect_artifacts (project_id, kind, data)
           values ($1, $2, $3)
           on conflict (project_id, kind) do nothing`,
          [project.id, kind, db.json(payload)]
        );
      }
      artifacts += 1;
    }
  }

  report.push(`content-architect: ${imported} project(s), ${artifacts} artifact(s) ${DRY_RUN ? 'would be imported' : 'imported'}`);
  if (unlinked.length) {
    report.push(`content-architect: ${unlinked.length} kept as standalone (platform id not a uuid): ${unlinked.join(', ')}`);
  }
  if (duplicates.length) {
    report.push(`content-architect: ${duplicates.length} duplicate platform link(s) unlinked, first one kept: ${duplicates.join(', ')}`);
  }
  if (droppedPlatform.length) {
    report.push(
      `content-architect: ${droppedPlatform.length} project(s) kept as standalone, their platform project `
      + `does not exist in this database: ${droppedPlatform.join(', ')}`
    );
  }
  if (droppedWorkspace.size) {
    report.push(
      `content-architect: workspace link dropped for ${droppedWorkspace.size} unknown workspace(s): `
      + `${[...droppedWorkspace].join(', ')}`
    );
  }
}

// ── Competitor Research ─────────────────────────────────────────────────────

async function importCompetitorAnalysis(report) {
  const root = resolveDataRoot(
    'competitor-analysis',
    path.join(__dirname, '..', 'modules', 'competitorAnalysis', 'data'),
    'COMPETITOR_ANALYSIS_DATA_ROOT',
  );

  const clients = await readJson(path.join(root, 'clients.json'), []);
  report.push(`competitor-analysis: ${clients.length} client(s) in ${root}`);
  if (!clients.length) return;

  let imported = 0;
  let artifacts = 0;

  for (const client of clients) {
    if (!client?.id) continue;

    if (!DRY_RUN) {
      await db.query(
        `insert into competitor_analysis_clients (id, data, created_at, updated_at)
         values ($1, $2, coalesce($3::timestamptz, now()), now())
         on conflict (id) do nothing`,
        [client.id, db.json(client), client.createdAt || null]
      );
    }
    imported += 1;

    for (const [kind, dir] of [['snapshot', 'snapshots'], ['content_analysis', 'content-analysis']]) {
      const file = path.join(root, dir, `${client.id}.json`);
      if (!(await exists(file))) continue;
      const payload = await readJson(file, null);
      if (payload === null) continue;
      if (!DRY_RUN) {
        await db.query(
          `insert into competitor_analysis_artifacts (client_id, kind, data)
           values ($1, $2, $3)
           on conflict (client_id, kind) do nothing`,
          [client.id, kind, db.json(payload)]
        );
      }
      artifacts += 1;
    }
  }

  report.push(`competitor-analysis: ${imported} client(s), ${artifacts} artifact(s) ${DRY_RUN ? 'would be imported' : 'imported'}`);
}

// ── On-Page Audit ───────────────────────────────────────────────────────────

async function importOnPageAudit(report) {
  const root = resolveDataRoot(
    'on-page-audit',
    path.join(__dirname, '..', 'modules', 'onPageAudit', 'data'),
    'ON_PAGE_AUDIT_DATA_ROOT',
  );

  let files = [];
  try {
    files = (await fs.readdir(root)).filter((f) => f.endsWith('.json'));
  } catch {
    report.push(`on-page-audit: no data directory at ${root}`);
    return;
  }

  let imported = 0;
  let skipped = 0;
  for (const file of files) {
    const audit = await readJson(path.join(root, file), null);
    // A corrupt file was skipped by listAudits() too — it is not new damage,
    // but it IS the last chance to notice, so it is counted rather than passed
    // over in silence.
    if (!audit?.id) { skipped += 1; continue; }
    if (!DRY_RUN) {
      await db.query(
        `insert into on_page_audits (id, data, audit_date)
         values ($1, $2, $3::timestamptz)
         on conflict (id) do nothing`,
        [audit.id, db.json(audit), audit.auditDate || null]
      );
    }
    imported += 1;
  }

  report.push(`on-page-audit: ${imported} audit(s) ${DRY_RUN ? 'would be imported' : 'imported'} from ${root}`);
  if (skipped) report.push(`on-page-audit: ${skipped} file(s) skipped (unreadable or no id)`);
}

// ── Robots Monitor ──────────────────────────────────────────────────────────

async function importRobotsMonitor(report) {
  const root = resolveDataRoot(
    'robots-monitor',
    path.join(__dirname, '..', 'modules', 'robotsMonitor', 'data'),
    'ROBOTS_MONITOR_DATA_ROOT',
  );

  const clients = await readJson(path.join(root, 'clients.json'), []);
  for (const client of clients) {
    if (!client?.id) continue;
    if (!DRY_RUN) {
      await db.query(
        `insert into robots_monitor_clients (id, data, created_at, updated_at)
         values ($1, $2, coalesce($3::timestamptz, now()), now())
         on conflict (id) do nothing`,
        [client.id, db.json(client), client.createdAt || null]
      );
    }
  }

  const slack = await readJson(path.join(root, 'slackConfig.json'), null);
  if (slack && Object.keys(slack).length && !DRY_RUN) {
    await db.query(
      `insert into settings (key, value, updated_at) values ($1, $2, now())
       on conflict (key) do nothing`,
      ['robots_monitor.slack', db.json(slack)]
    );
  }

  let runs = 0;
  let historyFiles = [];
  try {
    historyFiles = (await fs.readdir(path.join(root, 'history'))).filter((f) => f.endsWith('.json'));
  } catch { /* no history yet */ }
  for (const file of historyFiles) {
    const run = await readJson(path.join(root, 'history', file), null);
    if (!run?.runId) continue;
    if (!DRY_RUN) {
      await db.query(
        `insert into robots_monitor_runs (run_id, data, started_at)
         values ($1, $2, $3::timestamptz)
         on conflict (run_id) do nothing`,
        [run.runId, db.json(run), run.startedAt || null]
      );
    }
    runs += 1;
  }

  report.push(
    `robots-monitor: ${clients.length} client(s), ${runs} run(s)`
    + `${slack && Object.keys(slack).length ? ', slack config' : ''} `
    + `${DRY_RUN ? 'would be imported' : 'imported'} from ${root}`
  );
}

// ── Market Potential ────────────────────────────────────────────────────────

async function importMarketPotential(report) {
  const root = resolveDataRoot(
    'market-potential',
    path.join(__dirname, '..', 'modules', 'marketPotential', 'data'),
    'MARKET_POTENTIAL_DATA_ROOT',
  );

  const services = await readJson(path.join(root, 'services.json'), []);
  const baskets = await readJson(path.join(root, 'baskets.json'), []);
  const cache = await readJson(path.join(root, 'volumeCache.json'), {});
  const scenarios = await readJson(path.join(root, 'scenarios.json'), []);
  const summaries = await readJson(path.join(root, 'summaries.json'), {});
  const ledger = await readJson(path.join(root, 'semrushUsage.json'), {});

  const nameKey = (name) => (name || '').trim().toLowerCase();

  // Two services whose names normalize the same could coexist in the JSON file;
  // the new unique index says they cannot. The first wins and the rest are
  // reported, because merging them is a judgement call about somebody's data,
  // not something an importer should decide.
  const seenNames = new Set();
  const collisions = [];
  const keptServiceIds = new Set();

  for (const service of services) {
    if (!service?.id) continue;
    const key = nameKey(service.name);
    if (seenNames.has(key)) { collisions.push(`${service.id} (${service.name})`); continue; }
    seenNames.add(key);
    keptServiceIds.add(service.id);
    if (!DRY_RUN) {
      await db.query(
        `insert into market_potential_services (id, data, name_key, created_at, updated_at)
         values ($1, $2, $3, coalesce($4::timestamptz, now()), now())
         on conflict (id) do nothing`,
        [service.id, db.json(service), key, service.createdAt || null]
      );
    }
  }

  // A basket whose service was dropped above has nowhere to attach: the table
  // has a foreign key to the service. Reported rather than failing the run.
  const orphanBaskets = [];
  for (const basket of baskets) {
    if (!basket?.id) continue;
    if (!keptServiceIds.has(basket.serviceId)) {
      orphanBaskets.push(`${basket.id} -> ${basket.serviceId}`);
      continue;
    }
    if (!DRY_RUN) {
      await db.query(
        `insert into market_potential_baskets
           (id, service_id, status, version, data, created_at, updated_at)
         values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), now())
         on conflict (id) do nothing`,
        [
          basket.id, basket.serviceId,
          basket.status === 'active' ? 'active' : 'draft',
          basket.version ?? null,
          db.json(basket), basket.createdAt || null,
        ]
      );
    }
  }

  for (const [key, entry] of Object.entries(cache)) {
    if (!DRY_RUN) {
      await db.query(
        `insert into market_potential_volume_cache (id, data, fetched_at)
         values ($1, $2, coalesce($3::timestamptz, now()))
         on conflict (id) do nothing`,
        [key, db.json(entry), entry?.fetchedAt || null]
      );
    }
  }

  for (const scenario of scenarios) {
    if (!scenario?.id) continue;
    if (!DRY_RUN) {
      await db.query(
        `insert into market_potential_scenarios (id, user_id, data, created_at)
         values ($1, $2, $3, coalesce($4::timestamptz, now()))
         on conflict (id) do nothing`,
        [scenario.id, scenario.userId || 'anon', db.json(scenario), scenario.createdAt || null]
      );
    }
  }

  for (const [key, value] of Object.entries(summaries)) {
    if (!DRY_RUN) {
      await db.query(
        `insert into market_potential_summaries (key, data, created_at)
         values ($1, $2, coalesce($3::timestamptz, now()))
         on conflict (key) do nothing`,
        [key, db.json(value), value?.at || null]
      );
    }
  }

  // The ledger is keyed by UTC date, and only TODAY's row still constrains
  // anything — earlier days are an audit trail. All of it is imported, because
  // an audit trail that starts on migration day is not much of one.
  let ledgerDays = 0;
  for (const [day, entry] of Object.entries(ledger)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!DRY_RUN) {
      await db.query(
        `insert into market_potential_semrush_usage (day, used_units, runs, updated_at)
         values ($1::date, $2, $3, now())
         on conflict (day) do nothing`,
        [day, Number(entry?.units) || 0, db.json(entry?.runs || [])]
      );
    }
    ledgerDays += 1;
  }

  report.push(
    `market-potential: ${keptServiceIds.size} service(s), ${baskets.length - orphanBaskets.length} basket(s), `
    + `${Object.keys(cache).length} cache row(s), ${scenarios.length} scenario(s), `
    + `${Object.keys(summaries).length} summary(ies), ${ledgerDays} ledger day(s) `
    + `${DRY_RUN ? 'would be imported' : 'imported'} from ${root}`
  );
  if (collisions.length) {
    report.push(`market-potential: ${collisions.length} service(s) skipped, name collides with one already imported: ${collisions.join(', ')}`);
  }
  if (orphanBaskets.length) {
    report.push(`market-potential: ${orphanBaskets.length} basket(s) skipped, their service was not imported: ${orphanBaskets.join(', ')}`);
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────

const IMPORTERS = [
  ['content-architect', importContentArchitect],
  ['competitor-analysis', importCompetitorAnalysis],
  ['on-page-audit', importOnPageAudit],
  ['robots-monitor', importRobotsMonitor],
  ['market-potential', importMarketPotential],
];

// Which database this is actually about to write to, named without its
// credentials. A one-time bulk import is exactly the kind of script somebody
// runs from a laptop whose .env still points at production, so it says where it
// is pointed and refuses to write until that is acknowledged.
function describeTarget() {
  try {
    const url = new URL(process.env.DATABASE_URL);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return 'the configured database';
  }
}

async function main() {
  if (!db.isDatabaseConfigured()) {
    console.error('DATABASE_URL is not set — nothing to import into.');
    process.exit(1);
  }

  if (!DRY_RUN && !args.includes('--confirm')) {
    console.error(
      `This would import into: ${describeTarget()}\n`
      + 'Re-run with --confirm to write, or --dry-run/--status to see what it would do.\n'
      + 'The JSON files are never modified either way.'
    );
    await db.end();
    process.exit(1);
  }

  const report = [];
  for (const [name, run] of IMPORTERS) {
    if (only && only !== name) continue;
    try {
      await run(report);
    } catch (error) {
      report.push(`${name}: FAILED — ${error.message}`);
      console.log(report.join('\n'));
      await db.end();
      process.exit(1);
    }
  }

  if (STATUS || DRY_RUN) report.unshift('(no writes performed)');
  console.log(report.join('\n'));
  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end().catch(() => {});
  process.exit(1);
});
