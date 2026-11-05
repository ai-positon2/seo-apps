// ── AI-found competitors are suggestions, never tracked (UX-112) ────────────
//
// Run: node --test modules/projects/__tests__/competitorSuggestions.test.js
//
// Auto-discovery attached its picks as ACTIVE competitors for anyone who could
// manage competitors, and the paid comparison ran against them unconfirmed
// (Nike vs Foot Locker). They are now stored as 'proposed' for a person to
// accept, and the run that found them compares nothing. Semrush, discovery
// and the store are stubbed: no units, no DB writes.

const test = require('node:test');
const assert = require('node:assert');

const provider = require('../../competitorAnalysis/provider');
const discovery = require('../../competitorAnalysis/discovery');
const store = require('../store');
const moduleRunners = require('../moduleRunners');

const project = { id: 'p1', name: 'Nike', url: 'https://nike.com', country_code: 'US' };
const primary = { role: 'primary', status: 'active', host: 'nike.com', normalized_origin: 'https://nike.com' };

function stub(t, candidates) {
  t.mock.method(provider, 'hasSemrushKey', () => true);
  t.mock.method(discovery, 'discoverCompetitorsForClient', async () => ({ candidates }));
  const added = [];
  t.mock.method(store, 'addCompetitor', async (args) => {
    added.push(args);
    return { id: `d${added.length}`, host: args.domain, status: args.status, source: args.source };
  });
  return added;
}

for (const verdict of [true, 'propose']) {
  test(`discovered competitors are stored as proposals (manageCompetitors=${verdict})`, async (t) => {
    const added = stub(t, [
      { domain: 'adidas.com', reason: 'Rival sportswear brand.', competitorType: 'direct', verified: true },
      { domain: 'puma.com', reason: 'Rival.', competitorType: 'direct', verified: true },
    ]);
    const access = { can: () => verdict, project };
    const r = await moduleRunners.autoDiscoverCompetitors({ access, project, primary });
    assert.deepStrictEqual(added.map((a) => a.status), ['proposed', 'proposed']);
    assert.ok(added.every((a) => a.source === 'accepted'), 'still marked as AI picks');
    assert.strictEqual(r.competitors.length, 0, 'nothing for the run to compare (or bill) yet');
    assert.strictEqual(r.reason, 'competitors_pending_approval');
    assert.strictEqual(r.proposed.length, 2);
    assert.match(r.note, /2 suggested competitors/);
  });
}

test('unverified suggestions are stored and described as not verified', async (t) => {
  const added = stub(t, [{ domain: 'footlocker.com', reason: discovery.NOT_VERIFIED_REASON, competitorType: null, verified: false }]);
  const r = await moduleRunners.autoDiscoverCompetitors({ access: { can: () => true, project }, project, primary });
  assert.strictEqual(added[0].discovery.verified, false);
  assert.strictEqual(added[0].discovery.competitorType, null);
  assert.match(r.note, /1 not verified/);
});

test('runCompetitor with nothing tracked finds suggestions and stops before the paid comparison', async (t) => {
  stub(t, [{ domain: 'adidas.com', competitorType: 'direct', verified: true }]);
  // No competitor-tool client to adopt from (that path is manual picks, unchanged).
  t.mock.method(require('../../competitorAnalysis/store'), 'getClients', async () => []);
  t.mock.method(store, 'listDomains', async () => [primary]);
  const dataFetcher = require('../../competitorAnalysis/dataFetcher');
  const fetch = t.mock.method(dataFetcher, 'fetchClientDashboardData', async () => { throw new Error('must not run'); });
  const result = await moduleRunners.RUNNERS.competitor({
    access: { can: () => true, project }, run: { trigger: 'auto_setup' }, project, domains: [primary],
  });
  assert.strictEqual(result.status, 'insufficient_data');
  assert.strictEqual(result.payload.reason, 'competitors_pending_approval');
  assert.strictEqual(result.payload.proposedCount, 1);
  assert.strictEqual(fetch.mock.callCount(), 0);
});

// Every runModule caller passes store.listDomains()'s default (active rows
// only), so proposals waiting for review were invisible to the runner: each
// later run re-paid discovery, re-proposed the same domains, and every save
// failed as already_proposed. The runner reads them itself now.
test('runCompetitor with suggestions waiting does not re-run discovery (active-only domains passed)', async (t) => {
  t.mock.method(provider, 'hasSemrushKey', () => true);
  const discover = t.mock.method(discovery, 'discoverCompetitorsForClient', async () => ({ candidates: [] }));
  const add = t.mock.method(store, 'addCompetitor', async () => { throw new Error('must not add'); });
  t.mock.method(store, 'listDomains', async () => [
    { id: 'pr', ...primary },
    { id: 'a', role: 'competitor', status: 'proposed', host: 'adidas.com' },
    { id: 'b', role: 'competitor', status: 'proposed', host: 'puma.com' },
  ]);
  const result = await moduleRunners.RUNNERS.competitor({
    access: { can: () => true, project }, run: { trigger: 'manual' }, project, domains: [{ id: 'pr', ...primary }],
  });
  assert.strictEqual(discover.mock.callCount(), 0, 'no discovery units spent');
  assert.strictEqual(add.mock.callCount(), 0);
  assert.strictEqual(result.status, 'insufficient_data');
  assert.strictEqual(result.payload.reason, 'competitors_pending_approval');
  assert.strictEqual(result.payload.proposedCount, 2);
  assert.match(result.note, /review 2 suggested competitors/);
});

test('discovery is told about rejected suggestions so it does not offer them again', async (t) => {
  let seen = null;
  t.mock.method(provider, 'hasSemrushKey', () => true);
  t.mock.method(discovery, 'discoverCompetitorsForClient', async (client) => { seen = client.competitors.map((c) => c.domain); return { candidates: [] }; });
  t.mock.method(require('../../competitorAnalysis/store'), 'getClients', async () => []);
  t.mock.method(store, 'listDomains', async () => [
    { id: 'pr', ...primary },
    { id: 'r', role: 'competitor', status: 'removed', host: 'footlocker.com', provider_ids: { rejected: { at: 'x' } } },
    { id: 'm', role: 'competitor', status: 'removed', host: 'oldrival.com', provider_ids: {} },
  ]);
  await moduleRunners.RUNNERS.competitor({
    access: { can: () => true, project }, run: { trigger: 'manual' }, project, domains: [{ id: 'pr', ...primary }],
  });
  assert.deepStrictEqual(seen, ['footlocker.com']);
});

test('autostart holds back for pending suggestions even when callers pass active rows only', async (t) => {
  const db = require('../../../services/db');
  t.mock.method(db, 'isDatabaseConfigured', () => true);
  t.mock.method(db, 'rows', async () => []); // no runs in flight
  t.mock.method(provider, 'hasSemrushKey', () => true);
  t.mock.method(store, 'listDomains', async () => [
    { id: 'pr', ...primary },
    { id: 'a', role: 'competitor', status: 'proposed', host: 'adidas.com' },
  ]);
  const autostart = require('../competitorAutostart');
  const r = await autostart.scheduleCompetitorResearch({
    access: { can: () => true, project }, domains: [{ id: 'pr', ...primary }],
  });
  assert.strictEqual(r.scheduled, false);
  assert.strictEqual(r.reason, 'competitors_pending_approval');
});
