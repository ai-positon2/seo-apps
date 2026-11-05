// ── The live report leaves a run that is still measuring out ────────────────
//
// run.js saves a run's answers before it reads their tone and who they name,
// and before the run is closed. A report built in between scored those
// half-read answers — and the dashboard cached that figure. buildLiveReport
// now reads only the answers of finished runs.
//
// Run: node modules/aiVisibilityLite/__tests__/liveReportInFlight.test.js

const assert = require('assert');
const store = require('../store');
const projectsStore = require('../../projects/store');
const moduleEvidence = require('../../projects/moduleEvidence');
const runner = require('../run');
const routes = require('../routes');

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const cap = (runId, i, over = {}) => ({
  id: `${runId}-${i}`, runId, promptId: `p${i}`, prompt: 'q', engine: 'openai',
  surfaceLabel: 'ChatGPT (API · web search)', status: 'captured',
  answerText: 'Acme Dental is a good choice.', citations: [], mentioned: true, cited: false,
  prominence: 0.1, competitorsMentioned: [], webQueries: [], grounded: true,
  capturedAt: ago(runId === 'r2' ? 0 : 1), offGeo: false, ...over,
});

(async () => {
  const saved = {
    capturesForProject: store.capturesForProject,
    listPrompts: store.listPrompts,
    getProfile: store.getProfile,
    listDomains: projectsStore.listDomains,
    projectView: projectsStore.projectView,
    listRuns: moduleEvidence.listRuns,
    identityFor: runner.identityFor,
  };
  const prompts = [1, 2, 3].map((i) => ({ id: `p${i}`, text: `q${i}` }));
  store.capturesForProject = async () => [
    cap('r1', 1), cap('r1', 2), cap('r1', 3),
    // r2 is still running: saved, not yet read for tone or closed.
    cap('r2', 1, { mentioned: false }), cap('r2', 2, { mentioned: false }),
  ];
  store.listPrompts = async () => prompts;
  store.getProfile = async () => null;
  projectsStore.listDomains = async () => [];
  projectsStore.projectView = () => ({ primaryDomain: null });
  moduleEvidence.listRuns = async () => [
    { id: 'r2', status: 'running', payload: null },
    { id: 'r1', status: 'completed', payload: {}, finished_at: ago(1) },
  ];
  runner.identityFor = async () => ({
    brand: { name: 'Acme Dental', domain: 'acmedental.com', aliases: [] }, competitors: [], nameCheck: null,
  });

  try {
    await test('answers of a run still measuring are not scored', async () => {
      const live = await routes.buildLiveReport({ id: 'proj-x' }, { budget: false });
      assert.ok(live.built, 'a report was built');
      assert.strictEqual(live.built.meta.answersMeasured, 3, 'only the finished run’s answers');
      assert.ok(live.captures.every((c) => c.runId !== 'r2'));
    });

    await test('a first run still measuring leaves nothing to report yet', async () => {
      moduleEvidence.listRuns = async () => [{ id: 'r2', status: 'running', payload: null }];
      store.capturesForProject = async () => [cap('r2', 1), cap('r2', 2)];
      const live = await routes.buildLiveReport({ id: 'proj-x' }, { budget: false });
      assert.strictEqual(live.built, null);
    });
  } finally {
    Object.assign(store, {
      capturesForProject: saved.capturesForProject, listPrompts: saved.listPrompts, getProfile: saved.getProfile,
    });
    Object.assign(projectsStore, { listDomains: saved.listDomains, projectView: saved.projectView });
    moduleEvidence.listRuns = saved.listRuns;
    runner.identityFor = saved.identityFor;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
