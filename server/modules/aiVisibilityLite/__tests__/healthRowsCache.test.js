// ── A finished run's capture health is read once ────────────────────────────
//
// /runs and latestRun read capture rows to work out the health of runs saved
// before health was stored. Those runs are finished and never change, so the
// rows are kept in process rather than re-read on every poll.
//
// Run: node modules/aiVisibilityLite/__tests__/healthRowsCache.test.js

const assert = require('assert');
const store = require('../store');
const routes = require('../routes');

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

(async () => {
  const saved = store.captureHealthRows;
  const asked = [];
  store.captureHealthRows = async (_projectId, ids) => {
    asked.push([...ids]);
    return new Map(ids.map((id) => [String(id), [{ engine: 'openai', status: 'captured' }]]));
  };
  try {
    await test('old finished runs are queried once, then served from memory', async () => {
      const runs = [{ id: 'h1', status: 'completed', payload: {} }, { id: 'h2', status: 'failed', payload: null }];
      const a = await routes.healthRowsFor('proj-h', runs);
      const b = await routes.healthRowsFor('proj-h', runs);
      assert.deepStrictEqual(asked, [['h1', 'h2']]);
      assert.deepStrictEqual(a.get('h1'), b.get('h1'));
      assert.ok(b.get('h2'));
    });

    await test('only the runs not yet seen are queried', async () => {
      await routes.healthRowsFor('proj-h', [{ id: 'h1', status: 'completed' }, { id: 'h3', status: 'completed' }]);
      assert.deepStrictEqual(asked[asked.length - 1], ['h3']);
    });

    await test('a run in flight or with stored health is never queried', async () => {
      const n = asked.length;
      const out = await routes.healthRowsFor('proj-h', [
        { id: 'h4', status: 'running' }, { id: 'h5', status: 'completed', payload: { health: {} } },
      ]);
      assert.strictEqual(asked.length, n);
      assert.strictEqual(out.size, 0);
    });
  } finally {
    store.captureHealthRows = saved;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
