// ── Overview competitor card vs the Competitor Analysis page's list ──────────
//
// Run: node --test modules/projects/__tests__/competitorDrift.test.js
//
// Beta Bionics: the Overview card said "2nd of 4" against the project's rivals
// while the Competitor Analysis page said "#4 of 4" against its own list. When
// the sets differ the card withholds its rank and says so. DB and the tool's
// store are stubbed.

const test = require('node:test');
const assert = require('node:assert');

const db = require('../../../services/db');
const caStore = require('../../competitorAnalysis/store');
const { competitorListDrift } = require('../overview');

const project = {
  primaryDomain: { host: 'www.betabionics.com' },
  competitors: [{ host: 't1dnutritionist.com' }, { host: 'ccsmed.com' }],
};

function stub(t, toolCompetitors, runRivals) {
  t.mock.method(caStore, 'getClients', async () => [
    { id: 'c1', domain: 'betabionics.com', competitors: toolCompetitors.map((domain) => ({ domain })) },
  ]);
  t.mock.method(db, 'maybeOne', async () => ({
    domains: [{ domain: 'betabionics.com', isClient: true }, ...runRivals.map((domain) => ({ domain, isClient: false }))],
  }));
}

test('a project run measured against a different set than the page is flagged', async (t) => {
  stub(t, ['tandemdiabetes.com', 'insulet.com'], ['t1dnutritionist.com', 'ccsmed.com']);
  const drift = await competitorListDrift(project, { source: 'project_run' }, 'run-1');
  assert.deepStrictEqual(drift.pageCompetitors, ['tandemdiabetes.com', 'insulet.com']);
  assert.match(drift.note, /different list \(tandemdiabetes\.com, insulet\.com\)/);
});

test('the same set (ignoring www and order) is not flagged', async (t) => {
  stub(t, ['www.ccsmed.com', 't1dnutritionist.com'], ['t1dnutritionist.com', 'ccsmed.com']);
  assert.strictEqual(await competitorListDrift(project, { source: 'project_run' }, 'run-1'), null);
});

test('a card read from the tool is flagged when the project lists other rivals', async (t) => {
  stub(t, ['tandemdiabetes.com'], []);
  const drift = await competitorListDrift(project, { source: 'competitor_analysis_tool' }, null);
  assert.match(drift.note, /not this project's competitors/);
});
