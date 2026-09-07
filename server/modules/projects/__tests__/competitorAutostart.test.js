// ── Tests for "Competitor Research starts itself" ───────────────────────────
//
// The decision is pure and lives in competitorAutostart.decide, so it can be
// pinned without a database. What is being pinned is mostly what it REFUSES to
// do: this module bills roughly 1,955 SEMrush units per domain, so a wrong
// answer here is not a wrong pixel, it is a bill.
//
// Run: node modules/projects/__tests__/competitorAutostart.test.js

const assert = require('assert');
const autostart = require('../competitorAutostart');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// A project that has everything the comparison needs. Each test below changes
// exactly one thing, so what the assertion is about is what the override says.
const READY = {
  enabled: true,
  canStartRun: true,
  hasPrimaryDomain: true,
  activeCompetitorCount: 2,
  proposedCompetitorCount: 0,
  autoFindCompetitors: false,
  hasSemrushKey: true,
  pending: {},
};

const decide = (overrides) => autostart.decide({ ...READY, ...overrides });

console.log('\nCompetitor autostart — when it starts');

test('a primary domain and a tracked competitor is all it takes', () => {
  const d = decide();
  assert.strictEqual(d.start, true);
  assert.strictEqual(d.reason, 'queued');
  assert.strictEqual(d.competitorCount, 2);
});

test('"find competitors for me" starts it with none tracked yet', () => {
  // The run discovers them itself (moduleRunners.runCompetitor), so waiting for
  // a competitor row to exist would mean waiting forever.
  const d = decide({ activeCompetitorCount: 0, autoFindCompetitors: true });
  assert.strictEqual(d.start, true);
});

console.log('\nCompetitor autostart — what it refuses, and why it says so');

test('the deployment switch turns it off outright', () => {
  const d = decide({ enabled: false });
  assert.strictEqual(d.start, false);
  assert.strictEqual(d.reason, 'autostart_disabled');
});

test('a role that cannot start runs does not start one', () => {
  assert.strictEqual(decide({ canStartRun: false }).reason, 'not_authorized');
});

test('no primary domain means there is nothing to compare', () => {
  assert.strictEqual(decide({ hasPrimaryDomain: false }).reason, 'no_primary_domain');
});

test('no competitors and no auto-discovery starts nothing', () => {
  const d = decide({ activeCompetitorCount: 0, autoFindCompetitors: false });
  assert.strictEqual(d.start, false);
  assert.strictEqual(d.reason, 'no_competitors_tracked');
});

test('a contributor\'s proposed competitors are named as pending, not as absent', () => {
  // §7.2: a contributor may propose but not apply. "Waiting for an approver" and
  // "you added nothing" are different states and must not read the same.
  const d = decide({ activeCompetitorCount: 0, proposedCompetitorCount: 2 });
  assert.strictEqual(d.start, false);
  assert.strictEqual(d.reason, 'competitors_pending_approval');
});

test('a missing SEMrush key is caught BEFORE a run is opened', () => {
  // The runner would record an honest insufficient_data row — but one per
  // competitor added, which turns a missing key into a wall of failed-looking
  // cards on the dashboard.
  const d = decide({ hasSemrushKey: false });
  assert.strictEqual(d.start, false);
  assert.strictEqual(d.reason, 'no_semrush_key');
});

test('every refusal carries a sentence the API can hand back', () => {
  for (const reason of [
    'autostart_disabled', 'not_authorized', 'no_primary_domain',
    'no_competitors_tracked', 'competitors_pending_approval', 'no_semrush_key',
  ]) {
    assert.ok(autostart.NOTES[reason], `${reason} has no note`);
  }
});

console.log('\nCompetitor autostart — one run per setup, not one per domain');

test('an already-queued run is coalesced into rather than duplicated', () => {
  // This is the whole reason for the delay window: typing in three competitors
  // one at a time must cost one comparison, not three.
  const d = decide({ pending: { queued: { id: 'run-1' } } });
  assert.strictEqual(d.start, true);
  assert.strictEqual(d.reason, 'coalesced');
  assert.strictEqual(d.coalesceRunId, 'run-1');
});

test('a run already executing gets a fresh one queued behind it', () => {
  // It was assembled before this domain existed and will not include it.
  // Coalescing into it would silently drop the competitor just added.
  const d = decide({ pending: { running: { id: 'run-1' } } });
  assert.strictEqual(d.start, true);
  assert.strictEqual(d.reason, 'queued_behind_running');
  assert.strictEqual(d.coalesceRunId, null);
});

test('a queued run wins over a running one — nothing new is enqueued', () => {
  const d = decide({ pending: { queued: { id: 'q' }, running: { id: 'r' } } });
  assert.strictEqual(d.coalesceRunId, 'q');
});

console.log('\nCompetitor autostart — the deployment switch');

test('unset means on; the off spellings mean off', () => {
  const original = process.env.COMPETITOR_RESEARCH_AUTOSTART;
  try {
    delete process.env.COMPETITOR_RESEARCH_AUTOSTART;
    assert.strictEqual(autostart.isEnabled(), true);
    for (const value of ['off', 'OFF', 'false', '0', 'no', 'disabled']) {
      process.env.COMPETITOR_RESEARCH_AUTOSTART = value;
      assert.strictEqual(autostart.isEnabled(), false, value);
    }
    for (const value of ['on', 'true', '1', 'yes']) {
      process.env.COMPETITOR_RESEARCH_AUTOSTART = value;
      assert.strictEqual(autostart.isEnabled(), true, value);
    }
  } finally {
    if (original === undefined) delete process.env.COMPETITOR_RESEARCH_AUTOSTART;
    else process.env.COMPETITOR_RESEARCH_AUTOSTART = original;
  }
});

test('an unparseable delay falls back to the default rather than to zero', () => {
  // `Number('')` is 0 and `Number.isFinite(0)` is true — the coercion that has
  // bitten this codebase before (moduleEvidence.sweepStaleRuns). A window of
  // zero would defeat coalescing entirely and bill per competitor.
  const original = process.env.COMPETITOR_AUTOSTART_DELAY_MS;
  try {
    process.env.COMPETITOR_AUTOSTART_DELAY_MS = 'soon';
    assert.strictEqual(autostart.delayMs(), autostart.DEFAULT_DELAY_MS);
    process.env.COMPETITOR_AUTOSTART_DELAY_MS = '';
    assert.strictEqual(autostart.delayMs(), autostart.DEFAULT_DELAY_MS);
    process.env.COMPETITOR_AUTOSTART_DELAY_MS = '-1';
    assert.strictEqual(autostart.delayMs(), autostart.DEFAULT_DELAY_MS);
    process.env.COMPETITOR_AUTOSTART_DELAY_MS = '30000';
    assert.strictEqual(autostart.delayMs(), 30000);
    // An explicit argument wins over the environment — that is how setup asks
    // for its shorter window.
    assert.strictEqual(autostart.delayMs(autostart.SETUP_DELAY_MS), autostart.SETUP_DELAY_MS);
  } finally {
    if (original === undefined) delete process.env.COMPETITOR_AUTOSTART_DELAY_MS;
    else process.env.COMPETITOR_AUTOSTART_DELAY_MS = original;
  }
});

test('setup does not wait out the coalescing window', () => {
  // Project setup submits every competitor in one request, so there is nothing
  // to coalesce and no reason to make the first run a minute late.
  assert.ok(autostart.SETUP_DELAY_MS < autostart.DEFAULT_DELAY_MS);
});

console.log('\nCompetitor autostart — deferring has a ceiling');

const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const at = (msFromNow) => new Date(NOW + msFromNow).toISOString();

test('a normal add pushes the queued run out by the full window', () => {
  const run = { created_at: at(-10_000), scheduled_for: at(-5_000) };
  const start = autostart.coalescedStart(run, 60_000, NOW);
  assert.strictEqual(start.getTime(), NOW + 60_000);
});

test('deferring stops at the ceiling instead of moving the run for ever', () => {
  // Somebody adding a competitor every fifty seconds must not be able to hold
  // the comparison at "starts in a minute" indefinitely.
  const run = { created_at: at(-autostart.MAX_DEFER_MS + 10_000), scheduled_for: at(5_000) };
  const start = autostart.coalescedStart(run, 60_000, NOW);
  assert.strictEqual(start.getTime(), NOW - autostart.MAX_DEFER_MS + 10_000 + autostart.MAX_DEFER_MS);
});

test('a run already past the ceiling keeps its own time, never an earlier one', () => {
  // Yanking it forward would race the claimer for no gain.
  const run = { created_at: at(-autostart.MAX_DEFER_MS - 60_000), scheduled_for: at(30_000) };
  const start = autostart.coalescedStart(run, 60_000, NOW);
  assert.strictEqual(start.getTime(), NOW + 30_000);
});

test('a run with no recorded enqueue time still gets the requested window', () => {
  const start = autostart.coalescedStart({}, 60_000, NOW);
  assert.strictEqual(start.getTime(), NOW + 60_000);
});

// -- Every route that can satisfy the preconditions must re-ask --------------
//
// decide() needs a primary domain AND something to compare against, and it is
// asked once per domain change. Miss one of those routes and a project can hold
// every precondition with nothing ever queued: setting the primary domain used
// to be exactly that gap, so a project created without a domain and given one
// afterwards was declined for 'no_primary_domain' at create and never re-asked,
// leaving the comparison to be started by hand for ever.
//
// Asserted against the source because the failure is an ABSENCE -- the route
// answers 200 and writes the domain either way, and nothing in its response
// says a run was never even considered.
test('every domain-mutating route re-asks whether the comparison can start', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes.js'), 'utf8');

  const routes = [
    "router.post('/:projectId/domains/primary'",
    "router.post('/:projectId/domains/competitors'",
  ];

  for (const marker of routes) {
    const start = src.indexOf(marker);
    assert.ok(start !== -1, `route not found: ${marker}`);
    // Read to the next route declaration, so this inspects one handler.
    const next = src.indexOf('\nrouter.', start + marker.length);
    const body = src.slice(start, next === -1 ? undefined : next);
    assert.ok(
      body.includes('autostartAfterDomainChange('),
      `${marker} writes a domain but never asks whether the comparison can start`,
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
