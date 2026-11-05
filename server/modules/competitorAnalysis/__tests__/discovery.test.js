// ── AI competitor discovery keeps only direct rivals ─────────────────────────
//
// Run: node --test modules/competitorAnalysis/__tests__/discovery.test.js
//
// Nike's AI-picked competitors were Foot Locker, Hibbett and Champs (shops that
// sell Nike); Beta Bionics got a nutritionist. Pure: no Semrush or model call.

const test = require('node:test');
const assert = require('node:assert');

const { pickDirectRivals, DIRECT_RIVAL_CRITERION } = require('../discovery');

const candidates = [
  { domain: 'footlocker.com', competitionLevel: 0.9 },
  { domain: 'adidas.com', competitionLevel: 0.5 },
  { domain: 'www.puma.com', competitionLevel: 0.7 },
  { domain: 'runnersworld.com', competitionLevel: 0.8 },
  { domain: 'unmentioned.com', competitionLevel: 0.95 },
];

test('retailers, publishers and indirect picks are dropped; direct rivals kept with their reason', () => {
  const verdicts = [
    { domain: 'footlocker.com', status: 'keep', competitorType: 'indirect', reason: 'Sells Nike shoes.' },
    { domain: 'adidas.com', status: 'keep', competitorType: 'direct', reason: 'Makes rival athletic shoes.' },
    { domain: 'puma.com', status: 'keep', competitorType: 'Direct', reason: 'Rival sportswear brand.' },
    { domain: 'runnersworld.com', status: 'keep', competitorType: 'informational', reason: 'Running magazine.' },
  ];
  const kept = pickDirectRivals(candidates, verdicts, 3);
  assert.deepStrictEqual(kept.map((c) => c.domain), ['www.puma.com', 'adidas.com']);
  assert.strictEqual(kept[1].reason, 'Makes rival athletic shoes.');
});

test('excluded verdicts and unmentioned candidates are never attached', () => {
  const kept = pickDirectRivals(candidates, [{ domain: 'adidas.com', status: 'exclude', competitorType: 'direct' }], 3);
  assert.deepStrictEqual(kept, []);
});

test('the prompt asks for companies selling the same kind of product', () => {
  assert.match(DIRECT_RIVAL_CRITERION, /same kind of product or service/);
  assert.match(DIRECT_RIVAL_CRITERION, /retailers, resellers/);
});
