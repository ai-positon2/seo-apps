// ── The dashboard card's live AI Visibility figures ─────────────────────────
//
// overview.liveAiVisibilityTerminal: what the card says about the engines it
// rests on, and that a build made while a run is measuring is never cached
// under the finished run's key.
//
// Run: node modules/aiVisibilityLite/__tests__/liveCard.test.js

const assert = require('assert');
const path = require('path');

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// A stand-in for routes.buildLiveReport, so no database is touched.
const routesPath = require.resolve(path.join(__dirname, '..', 'routes'));
let builds = 0;
let meta = {};
let score = 40;
require.cache[routesPath] = {
  id: routesPath, filename: routesPath, loaded: true,
  exports: {
    buildLiveReport: async () => {
      builds += 1;
      return { built: { headline: { score: { value: score }, namedRate: { value: 0.2 } }, meta } };
    },
  },
};

const overview = require('../../projects/overview');

(async () => {
  console.log('\nthe card names engines once, in the right sense');

  await test('measured in the period but failed on the latest run is not "3 of 3 · Claude failed"', async () => {
    meta = {
      answersMeasured: 30, enginesMeasured: 3, enginesAsked: 3, enginesUnavailable: [],
      latestRunFailed: ['Claude'], latestRun: { at: '2026-11-04T10:00:00Z' },
    };
    const out = await overview.liveAiVisibilityTerminal({ id: 'pc-1' }, { id: 'r1', status: 'completed', finished_at: 'x' });
    assert.match(out.coverage, /30 answers from 3 of 3 AI engines answered in this period/);
    assert.match(out.coverage, /Claude failed on the latest run \(Nov 4\)$/);
    assert.doesNotMatch(out.coverage, /· Claude failed/);
  });

  await test('an engine silent all period is named as such, not as a latest-run failure', async () => {
    meta = {
      answersMeasured: 20, enginesMeasured: 2, enginesAsked: 3,
      enginesUnavailable: ['Gemini (API · Google Search grounding)'], latestRunFailed: [], latestRun: { at: '2026-11-04T10:00:00Z' },
    };
    const out = await overview.liveAiVisibilityTerminal({ id: 'pc-2' }, { id: 'r1', status: 'completed', finished_at: 'x' });
    assert.match(out.coverage, /from 2 of 3 AI engines answered in this period; Gemini \(API · Google Search grounding\) answered nothing/);
    assert.doesNotMatch(out.coverage, /latest run/);
  });

  console.log('\nmid-run');

  await test('a build made while a run is in flight is not cached under the finished run’s key', async () => {
    meta = {};
    const project = { id: 'pc-3' };
    const run1 = { id: 'r1', status: 'completed', finished_at: '2026-11-04T10:00:00Z' };
    const before = builds;
    score = 40;
    const mid = await overview.liveAiVisibilityTerminal(project, run1, { inFlight: { id: 'r2', status: 'running' } });
    score = 41;
    const after = await overview.liveAiVisibilityTerminal(project, run1);
    assert.strictEqual(mid.score, 40);
    assert.strictEqual(after.score, 41, 'the finished-run read builds afresh');
    assert.strictEqual(builds, before + 2);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
