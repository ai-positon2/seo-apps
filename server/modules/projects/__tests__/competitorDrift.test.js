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
const { competitorListDrift, withCompetitorDrift } = require('../overview');
const executive = require('../insights/executive');

const runCard = {
  key: 'competitor', label: 'Competitor Research', source: 'project_run', score: 30,
  headline: '9,874 vs 32,432 estimated monthly visits',
  metric: { value: 30, display: '30%', unit: 'of ccsmed.com’s traffic', rank: '2nd of 4 tracked' },
};
const drift = { pageCompetitors: ['tandemdiabetes.com'], projectCompetitors: ['ccsmed.com'], note: 'The Competitor Analysis page compares a different list (tandemdiabetes.com)' };

test('a project-run card hides its % (not just its rank) while the lists differ', () => {
  const card = withCompetitorDrift(runCard, drift);
  assert.strictEqual(card.metric.value, null);
  assert.strictEqual(card.metric.display, '—');
  assert.strictEqual(card.metric.rank, null);
  assert.strictEqual(card.metric.withheld, true);
  assert.doesNotMatch(`${card.headline} ${card.detail}`, /30%|9,874/);
  assert.match(card.detail, /Use the project’s competitors/);
});

test('the executive Market chip shows no % for a withheld card, and the real % otherwise', () => {
  const market = (mods) => executive.buildExecutiveSummary({ overview: { modules: mods }, backlog: null }).market;
  const withheld = market([withCompetitorDrift(runCard, drift)]);
  assert.ok(withheld.every((m) => !/30%/.test(`${m.display} ${m.unit}`)));
  const chip = withheld.find((m) => m.key === 'competitor');
  assert.ok(chip && chip.display === '—' && /lists differ/.test(chip.unit));
  assert.strictEqual(market([runCard]).find((m) => m.key === 'competitor').display, '30%');
});

test('AI suggestions awaiting review turn an empty competitor card into a "Review N" prompt', () => {
  const { withCompetitorReview } = require('../overview');
  const proposed = [{ host: 'adidas.com', source: 'accepted' }, { host: 'puma.com', source: 'accepted' }];
  const card = withCompetitorReview({ key: 'competitor', status: 'insufficient_data', metric: null }, [], proposed);
  assert.strictEqual(card.status, 'needs_setup');
  assert.strictEqual(card.headline, 'Review 2 suggested competitors');
  assert.strictEqual(card.setupLink, '/projects#competitors');
  assert.match(card.detail, /adidas\.com, puma\.com/);
  // Already-accepted competitors keep the card's figures; the prompt is added.
  const kept = withCompetitorReview(runCard, [{ host: 'ccsmed.com' }], proposed.slice(0, 1));
  assert.strictEqual(kept.metric.display, '30%');
  assert.match(kept.detail, /Review 1 suggested competitor in project settings/);
  // Nothing waiting: unchanged.
  assert.strictEqual(withCompetitorReview(runCard, [{ host: 'x.com' }], []), runCard);
});

test('a card read from the tool keeps its % (it is the page\'s own figure), only the rank goes', () => {
  const card = withCompetitorDrift({ ...runCard, source: 'competitor_analysis_tool' }, drift);
  assert.strictEqual(card.metric.display, '30%');
  assert.strictEqual(card.metric.rank, null);
});

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
