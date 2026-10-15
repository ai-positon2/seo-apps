// The Competitor Research screen's own "Competitive score" card shows the same
// 0-100 the dashboard card does. These tests hold the two to one formula: the
// snapshot the screen reads carries the score computed by moduleRunners'
// competitorTrafficScore — the same function the dashboard card uses — rather
// than a second copy of the arithmetic in the browser.
const assert = require('assert');
const { withTrafficScore } = require('../trafficScore');

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const domain = (name, traffic, isClient = false) => ({
  domain: name, isClient, domainRank: { organicTraffic: traffic },
});

console.log('\ncompetitor traffic score on the dashboard snapshot');

test('the snapshot carries the dashboard card’s score', () => {
  const out = withTrafficScore({ domains: [domain('me.com', 18400, true), domain('rival.com', 23900), domain('small.com', 900)] });
  assert.strictEqual(out.trafficScore.score, 77);
  assert.strictEqual(out.trafficScore.strongestDomain, 'rival.com');
  assert.strictEqual(out.trafficScore.clientTraffic, 18400);
  assert.strictEqual(out.trafficScore.strongestTraffic, 23900);
});

test('the rest of the snapshot is left as it was', () => {
  const snap = { capturedAt: '2026-10-15', domains: [domain('me.com', 10, true), domain('rival.com', 20)] };
  const out = withTrafficScore(snap);
  assert.strictEqual(out.capturedAt, '2026-10-15');
  assert.strictEqual(out.domains, snap.domains);
});

test('no competitors means no score — null, never 0', () => {
  const out = withTrafficScore({ domains: [domain('me.com', 18400, true)] });
  assert.strictEqual(out.trafficScore, null);
});

test('no snapshot stays no snapshot', () => {
  assert.strictEqual(withTrafficScore(null), null);
});

console.log(`\n  ${passed} passed`);
