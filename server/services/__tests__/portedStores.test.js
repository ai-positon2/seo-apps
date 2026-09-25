// ── The invariants the ported stores moved into the database ────────────────
//
// Migrations 0032-0036 moved six file-backed module stores into Postgres. Most
// of that is a like-for-like port and is covered by each module's existing
// suite. What is NOT like-for-like, and what this file is about, is the set of
// rules those stores only ever asserted in prose:
//
//   * the SEMrush daily spend cap holds when two runs reserve at once;
//   * a client cannot end up with five competitors when the cap is four;
//   * two freezes of the same basket cannot both become version n+1;
//   * deleting a parent takes its artifacts with it.
//
// Every one of those was a read, a decision in JavaScript, and a write — safe
// only against writers inside one process, which this app has never had (a web
// process and a module worker share the database). They are single statements
// and constraints now, and a fake cannot check them: asserting that Postgres
// rejects a duplicate against something that only pretends to would restate the
// assumption rather than test it. So this suite runs real SQL.
//
// Run: TEST_DATABASE_URL=postgres://... node services/__tests__/portedStores.test.js

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test, before, after } = require('node:test');

const { useTestDatabase } = require('./helpers/testDatabase');
const { createProjectFixture, dropProjectFixture } = require('./helpers/projectFixture');

if (!useTestDatabase('portedStores')) process.exit(0);

const db = require('../db');

// The suite applies its own migrations rather than requiring the operator to
// have run them first. All five are `create ... if not exists`, so this is a
// no-op on a database that already has them.
const MIGRATIONS = [
  '0032_content_architect_to_postgres.sql',
  '0033_competitor_analysis_to_postgres.sql',
  '0034_on_page_audit_to_postgres.sql',
  '0035_robots_monitor_to_postgres.sql',
  '0036_market_potential_to_postgres.sql',
];

const caStore = require('../../modules/contentArchitect/store');
const moduleEvidence = require('../../modules/projects/moduleEvidence');
const competitorStore = require('../../modules/competitorAnalysis/store');
const mpStore = require('../../modules/marketPotential/store');
const usage = require('../../modules/marketPotential/usageStore');

before(async () => {
  const root = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');
  for (const file of MIGRATIONS) {
    await db.query(fs.readFileSync(path.join(root, file), 'utf8'));
  }
  // Start from a known empty state, not from whatever a previous run left.
  await db.query('truncate content_architect_projects cascade');
  await db.query('truncate competitor_analysis_clients cascade');
  await db.query('truncate market_potential_services cascade');
  await db.query('truncate market_potential_semrush_usage');
});

after(async () => { await db.end(); });

// ── The SEMrush spend cap ───────────────────────────────────────────────────

test('concurrent reservations cannot together exceed the daily cap', async () => {
  process.env.MP_DAILY_UNIT_CAP = '1000';
  process.env.MP_PER_RUN_UNIT_CAP = '1000';
  await db.query('truncate market_potential_semrush_usage');

  // Ten runs of 200 against a cap of 1000: five fit, five must not.
  const results = await Promise.all(
    Array.from({ length: 10 }, () => usage.reserve({ userId: 'u', estimate: 200, regions: 1 }))
  );

  const granted = results.filter((r) => r.ok);
  assert.equal(granted.length, 5, 'exactly five reservations of 200 fit in a 1000 cap');
  assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === 'daily'));

  const status = await usage.getStatus();
  assert.equal(status.dailyUsed, 1000);
  assert.equal(status.dailyRemaining, 0);
});

test('reconcile refunds the unused part of a reservation', async () => {
  process.env.MP_DAILY_UNIT_CAP = '10000';
  await db.query('truncate market_potential_semrush_usage');

  const reservation = await usage.reserve({ userId: 'u', estimate: 500, regions: 2 });
  assert.ok(reservation.ok);
  assert.equal((await usage.getStatus()).dailyUsed, 500);

  await usage.reconcile({ ...reservation, actual: 120 });
  assert.equal((await usage.getStatus()).dailyUsed, 120, 'the 380 unused units come back');

  // A reservation that is not there leaves the ledger alone rather than
  // subtracting a phantom estimate.
  await usage.reconcile({ date: reservation.date, reservationId: 'run_missing', actual: 50 });
  assert.equal((await usage.getStatus()).dailyUsed, 120);
});

test('releasing a failed run returns its whole reservation', async () => {
  process.env.MP_DAILY_UNIT_CAP = '10000';
  await db.query('truncate market_potential_semrush_usage');

  const reservation = await usage.reserve({ userId: 'u', estimate: 750, regions: 1 });
  await usage.release(reservation);
  assert.equal((await usage.getStatus()).dailyUsed, 0);
});

test('a single estimate larger than the whole daily cap is refused', async () => {
  process.env.MP_DAILY_UNIT_CAP = '1000';
  process.env.MP_PER_RUN_UNIT_CAP = '100000';
  await db.query('truncate market_potential_semrush_usage');

  // The first reservation of the day takes the INSERT path, where the conflict
  // clause's WHERE never runs — this is the case that guard exists for.
  const result = await usage.reserve({ userId: 'u', estimate: 5000, regions: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'daily');
  assert.equal((await usage.getStatus()).dailyUsed, 0);
});

// ── The competitor cap ──────────────────────────────────────────────────────

test('concurrent adds cannot push a client past the competitor cap', async () => {
  const client = await competitorStore.createClient({ name: 'Cap test', domain: 'https://cap.example.com/' });
  assert.equal(client.domain, 'cap.example.com', 'scheme and trailing slash are still stripped');

  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => competitorStore.addCompetitor(client.id, { domain: `rival-${i}.example.com` }))
  );
  const added = attempts.filter((a) => a.status === 'fulfilled');
  assert.equal(added.length, competitorStore.MAX_COMPETITORS);

  const stored = await competitorStore.getClient(client.id);
  assert.equal(stored.competitors.length, competitorStore.MAX_COMPETITORS);

  for (const rejected of attempts.filter((a) => a.status === 'rejected')) {
    assert.match(rejected.reason.message, /Maximum of 4 competitors/);
  }
});

test('removing a competitor leaves the others, and the message distinguishes a missing client', async () => {
  const client = await competitorStore.createClient({ name: 'Remove test', domain: 'remove.example.com' });
  const a = await competitorStore.addCompetitor(client.id, { domain: 'a.example.com' });
  const b = await competitorStore.addCompetitor(client.id, { domain: 'b.example.com' });

  await competitorStore.removeCompetitor(client.id, a.id);
  const stored = await competitorStore.getClient(client.id);
  assert.deepEqual(stored.competitors.map((c) => c.id), [b.id]);

  await assert.rejects(
    () => competitorStore.removeCompetitor('client_nope', a.id),
    /Client not found/
  );
});

test('a patch cannot rewrite a client id or reach its competitor list', async () => {
  const client = await competitorStore.createClient({ name: 'Pin test', domain: 'pin.example.com' });
  await competitorStore.addCompetitor(client.id, { domain: 'rival.example.com' });

  const updated = await competitorStore.updateClient(client.id, {
    name: 'Renamed', id: 'client_hijack', competitors: [],
  });
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.id, client.id);
  assert.equal(updated.competitors.length, 1);
});

test('deleting a client takes its snapshot with it', async () => {
  const client = await competitorStore.createClient({ name: 'Cascade test', domain: 'cascade.example.com' });
  await competitorStore.saveSnapshot(client.id, { capturedAt: '2026-09-01T00:00:00.000Z', domains: [] });
  assert.ok(await competitorStore.getSnapshot(client.id));

  await competitorStore.deleteClient(client.id);
  assert.equal(await competitorStore.getClient(client.id), null);
  assert.equal(await competitorStore.getSnapshot(client.id), null);
});

// ── Basket versions ─────────────────────────────────────────────────────────

test('freezing twice yields consecutive versions, never the same one', async () => {
  const service = await mpStore.createService('Version test', 'own.example.com');

  await mpStore.saveDraftBasket(service.id, [{ term: 'one' }]);
  const first = await mpStore.freezeBasket(service.id);
  assert.equal(first.version, 1);
  assert.equal(first.status, 'active');
  assert.ok(first.frozenAt);

  await mpStore.saveDraftBasket(service.id, [{ term: 'two' }]);
  const second = await mpStore.freezeBasket(service.id);
  assert.equal(second.version, 2);

  assert.equal((await mpStore.getActiveBasket(service.id)).version, 2, 'the newest active basket wins');
  await assert.rejects(() => mpStore.freezeBasket(service.id), /No draft basket to freeze/);
});

test('a service name is claimed once, however many callers ask at the same time', async () => {
  const created = await Promise.all(
    Array.from({ length: 6 }, () => mpStore.createService('  Shared Name  '))
  );
  assert.equal(new Set(created.map((s) => s.id)).size, 1);
  assert.equal((await mpStore.findServiceByName('shared name')).id, created[0].id);
});

test('saving a draft twice replaces it rather than making a second one', async () => {
  const service = await mpStore.createService('Draft test');
  const first = await mpStore.saveDraftBasket(service.id, [{ term: 'a' }]);
  const second = await mpStore.saveDraftBasket(service.id, [{ term: 'b' }, { term: 'c' }]);

  assert.equal(second.id, first.id, 'the draft keeps its id');
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.terms.length, 2);
  assert.equal((await mpStore.getDraftBasket(service.id)).terms.length, 2);
});

// ── Content Architect ───────────────────────────────────────────────────────

test('ensureProject converges on one row and deleting it takes the analysis', async () => {
  const platformProjectId = '11111111-2222-4333-8444-555555555555';

  // No crawl_projects row exists for this id, so the foreign key would reject a
  // link. That is the integrity 0032 adds, and it is checked here rather than
  // worked around: the row is created through the platform table first.
  await db.query(
    `insert into crawl_projects (id, owner, url, cron)
     values ($1, (select id from app_users limit 1), 'https://converge.example.com', '0 0 * * *')
     on conflict (id) do nothing`,
    [platformProjectId]
  );

  const entries = await Promise.all(Array.from({ length: 8 }, () => caStore.ensureProject({
    platformProjectId,
    workspaceId: null,
    domain: 'https://converge.example.com',
    host: 'converge.example.com',
  })));
  assert.equal(new Set(entries.map((p) => p.id)).size, 1, 'eight concurrent callers, one project');

  const project = entries[0];
  await caStore.saveFullAnalysis(project.id, { clusters: [{ name: 'c' }] });
  assert.ok(await caStore.getFullAnalysis(project.id));

  await caStore.deleteProject(project.id);
  assert.equal(await caStore.getProject(project.id), null);
  assert.equal(await caStore.getFullAnalysis(project.id), null, 'the artifact went with the project');
});

test('updateProject merges a patch without dropping the rest of the record', async () => {
  const project = await caStore.createProject({
    domain: 'https://merge.example.com', host: 'merge.example.com',
  });

  await caStore.updateProject(project.id, { workflowState: 'analyzing' });
  const updated = await caStore.updateProject(project.id, { vertical: 'dental' });

  assert.equal(updated.workflowState, 'analyzing', 'the first patch survived the second');
  assert.equal(updated.vertical, 'dental');
  assert.equal(updated.domain, 'https://merge.example.com');
  assert.notEqual(updated.updatedAt, project.updatedAt);

  await assert.rejects(() => caStore.updateProject('proj_nope', { vertical: 'x' }), /Project not found/);
});

test('a Content Architect ref whose analysis is gone falls back to the project’s current one', async () => {
  // A run recorded on another machine before 0032 names an analysis that was
  // never imported. The card must not link to it.
  const fixture = await createProjectFixture({ prefix: 'caref', url: 'https://caref-selftest.invalid' });
  try {
    const analysis = await caStore.createProject({
      domain: 'https://caref-selftest.invalid', host: 'caref-selftest.invalid',
    });
    const record = (moduleKey, reportRef) => db.insertOne('project_module_runs', {
      project_id: fixture.projectId,
      module_key: moduleKey,
      status: 'completed',
      payload: { reportRef },
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    await record('hub_spoke', analysis.id);
    await record('competitor', 'client_never_existed');

    let latest = await moduleEvidence.latestByModule(fixture.projectId);
    assert.equal(latest.get('hub_spoke').terminal.reportRef, analysis.id, 'a live analysis keeps its ref');
    assert.equal(latest.get('competitor').terminal.reportRef, 'client_never_existed',
      'competitor refs are not checked; that page ignores one it cannot resolve');

    await caStore.deleteProject(analysis.id);
    latest = await moduleEvidence.latestByModule(fixture.projectId);
    assert.equal(latest.get('hub_spoke').terminal.reportRef, null,
      'with no analysis linked to the project either, the card opens the tool page');

    const current = await caStore.ensureProject({
      platformProjectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      domain: 'https://caref-selftest.invalid',
      host: 'caref-selftest.invalid',
    });
    latest = await moduleEvidence.latestByModule(fixture.projectId);
    assert.equal(latest.get('hub_spoke').terminal.reportRef, current.id,
      'the dead ref is replaced by the analysis linked to this project');
  } finally {
    await dropProjectFixture(fixture);
  }
});
