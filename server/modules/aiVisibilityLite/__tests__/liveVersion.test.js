// ── The dashboard card's live score follows the report ──────────────────────
//
// overview.liveAiVisibilityTerminal caches the live report's score for a few
// minutes. A finished run, or a question/setup change (liveVersion.bump),
// must make the next read build afresh rather than show the old figure.
//
// Run: node modules/aiVisibilityLite/__tests__/liveVersion.test.js

const assert = require('assert');
const path = require('path');
const liveVersion = require('../liveVersion');

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// A stand-in for routes.buildLiveReport, so no database is touched.
const routesPath = require.resolve(path.join(__dirname, '..', 'routes'));
let builds = 0;
let score = 40;
require.cache[routesPath] = {
  id: routesPath, filename: routesPath, loaded: true,
  exports: {
    buildLiveReport: async () => {
      builds += 1;
      return { built: { headline: { score: { value: score }, namedRate: { value: 0.2 } }, meta: {} } };
    },
  },
};

const overview = require('../../projects/overview');

(async () => {
  console.log('\nliveVersion');

  await test('bump moves the number per project only', () => {
    const before = liveVersion.current('p-a');
    liveVersion.bump('p-a');
    assert.strictEqual(liveVersion.current('p-a'), before + 1);
    assert.strictEqual(liveVersion.current('p-b'), 0);
    liveVersion.bump(null); // ignored
  });

  console.log('\nthe card cache');

  const project = { id: 'proj-1' };
  const run1 = { id: 'run-1', status: 'completed', finished_at: '2026-11-04T10:00:00Z', score: 10 };

  await test('a second read inside five minutes reuses the build', async () => {
    const a = await overview.liveAiVisibilityTerminal(project, run1);
    const b = await overview.liveAiVisibilityTerminal(project, run1);
    assert.strictEqual(builds, 1);
    assert.strictEqual(a.score, 40);
    assert.strictEqual(b.score, 40);
  });

  await test('a question or setup change (bump) rebuilds on the next read', async () => {
    score = 55;
    liveVersion.bump(project.id);
    const out = await overview.liveAiVisibilityTerminal(project, run1);
    assert.strictEqual(builds, 2);
    assert.strictEqual(out.score, 55);
  });

  await test('a newer finished run rebuilds on the next read', async () => {
    score = 61;
    const out = await overview.liveAiVisibilityTerminal(project, { ...run1, id: 'run-2', finished_at: '2026-11-05T10:00:00Z' });
    assert.strictEqual(builds, 3);
    assert.strictEqual(out.score, 61);
  });

  await test('a run that did not complete keeps its stored row', async () => {
    const failedRun = { id: 'run-3', status: 'failed', score: null };
    assert.strictEqual(await overview.liveAiVisibilityTerminal(project, failedRun), failedRun);
    assert.strictEqual(builds, 3);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
