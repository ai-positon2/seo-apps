// ── runAiVisibility ────────────────────────────────────────────────────────
//
// The orchestrator had no test at all, which is how it came to be the largest
// untested path in the module. What is pinned here is the set of branches that
// decide whether a client is BILLED and whether a number reaches a report:
//
//   • nothing approved            → refuse, spend nothing, say which of the two
//                                   reasons it is
//   • more approved than budget   → measure the budget, and DISCLOSE the rest
//   • extraction fell over        → the run still closes, and says so
//   • no capture succeeded        → insufficient_data, never a zero score
//
// The capture function is stubbed throughout: no browser, no network, no spend.
//
// Run: node modules/aiVisibility/__tests__/run.test.js

const assert = require('assert');
const path = require('path');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const MOD = path.join(__dirname, '..');
const P = (f) => require.resolve(path.join(MOD, f));

/**
 * Load run.js with its collaborators replaced.
 *
 * require.cache injection rather than a DI framework: run.js takes its
 * dependencies by require, and rewriting it to take them as arguments purely
 * for a test would change production code to suit the test.
 */
function loadRun({
  prompts = [], counts = null, captureRows = null, extraction = null, saveError = null,
}) {
  for (const f of ['../run', '../store', '../capture', '../budget', '../extractionPass',
    '../captureScheduler', '../../../services/adminLimits']) {
    delete require.cache[require.resolve(path.join(__dirname, f))];
  }

  require.cache[P('store.js')] = {
    id: P('store.js'),
    loaded: true,
    exports: {
      listPrompts: async () => prompts,
      countPromptsByStatus: async () => counts,
      saveCaptures: async () => {
        if (saveError) throw saveError;
        return [];
      },
    },
  };
  // Only measure() is replaced. scoring.js requires this same module for
  // coverageOf and the matchers, so a bare stub would break the report half of
  // the run rather than isolating the capture half.
  const realCapture = require(P('capture.js'));
  require.cache[P('capture.js')] = {
    id: P('capture.js'),
    loaded: true,
    exports: {
      ...realCapture,
      measure: async () => ({ status: 'captured', mentioned: true }),
    },
  };
  require.cache[P('budget.js')] = {
    id: P('budget.js'),
    loaded: true,
    exports: { createGuard: async () => null },
  };
  require.cache[P('extractionPass.js')] = {
    id: P('extractionPass.js'),
    loaded: true,
    exports: {
      extractPending: async () => {
        if (extraction instanceof Error) throw extraction;
        return extraction || { extracted: 0, skipped: 0, failed: 0, errors: [] };
      },
    },
  };
  require.cache[P('captureScheduler.js')] = {
    id: P('captureScheduler.js'),
    loaded: true,
    exports: {
      measureSet: async ({ prompts: ps, surfaces }) => ({
        rows: captureRows || ps.flatMap((p) => surfaces.map((s) => ({
          promptId: p.id,
          prompt: p.text,
          surfaceId: s.id,
          engine: s.engine,
          surfaceLabel: s.id,
          status: 'captured',
          mentioned: true,
          cited: false,
          prominence: 0.1,
          citations: [],
          taskCost: 0,
        }))),
        stopped: null,
      }),
    },
  };

  delete require.cache[P('run.js')];
  // eslint-disable-next-line global-require
  return require(P('run.js'));
}

const PROJECT = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Gentle Dental',
  primaryDomain: { host: 'www.gentledental.com' },
  competitors: [{ host: 'aspendental.com', name: 'Aspen Dental' }],
};
const ACCESS = { project: { id: 'proj-1', workspace_id: 'ws-1' } };
const RUN = { id: 'run-1' };
const prompt = (i) => ({ id: `p${i}`, text: `question ${i}` });

(async () => {
  section('nothing approved — refuse, and say which kind of nothing it is');

  await test('drafts awaiting review are named as such, and nothing is measured', async () => {
    const run = loadRun({ prompts: [], counts: { draft: 9, approved: 0 } });
    const r = await run.runAiVisibility({ access: ACCESS, project: PROJECT, run: RUN });
    assert.strictEqual(r.status, 'insufficient_data');
    assert.strictEqual(r.score, null, 'a score here would be a measured zero');
    assert.strictEqual(r.payload.reason, 'awaiting_review');
    assert.match(r.note, /9 generated prompt/);
    assert.match(r.note, /nothing was spent/);
  });

  await test('a client with no prompts at all is a different message', async () => {
    const run = loadRun({ prompts: [], counts: { draft: 0, approved: 0 } });
    const r = await run.runAiVisibility({ access: ACCESS, project: PROJECT, run: RUN });
    assert.strictEqual(r.payload.reason, 'no_prompts');
    assert.match(r.note, /no prompts/i);
  });

  section('over budget — measured is capped, and the remainder is disclosed');

  await test('only the budget is measured, and the rest raises a finding', async () => {
    // 25 approved against the default budget of 20. Silently measuring 20 would
    // change every denominator the moment someone approves a 21st question.
    const prompts = Array.from({ length: 25 }, (_, i) => prompt(i));
    const run = loadRun({ prompts, counts: { approved: 25 } });
    const r = await run.runAiVisibility({ access: ACCESS, project: PROJECT, run: RUN });

    assert.strictEqual(r.payload.promptCount, 20);
    assert.strictEqual(r.payload.overBudget, 5);
    assert.strictEqual(r.payload.approvedCount, 25);
    assert.strictEqual(r.payload.measuredPromptIds.length, 20,
      'the measured set has to be recorded for a trend to be verifiable later');

    const over = r.findings.find((f) => f.ruleId === 'aiv-approved-over-budget');
    assert.ok(over, 'the 5 unmeasured prompts must be stated, not dropped silently');
    assert.strictEqual(over.count, 5);
  });

  section('extraction is not allowed to fail the run');

  await test('a thrown extraction still closes the run, with a finding', async () => {
    const run = loadRun({
      prompts: [prompt(1)],
      counts: { approved: 1 },
      extraction: new Error('no approved brands for this project'),
    });
    const r = await run.runAiVisibility({ access: ACCESS, project: PROJECT, run: RUN });

    assert.strictEqual(r.status, 'completed', 'the captures were paid for and stored');
    const blocked = r.findings.find((f) => f.id === 'aiv-extraction-blocked');
    assert.ok(blocked, 'captures counted by nothing must be visible');
    assert.match(blocked.detail, /no approved brands/);
    assert.ok(r.payload.extraction.error);
  });

  section('no capture succeeded — not measured, not a zero');

  await test('an all-failed run is insufficient_data and says the brand was not absent', async () => {
    const failedRows = [{
      promptId: 'p1',
      prompt: 'question 1',
      surfaceId: 'chatgpt:scraped',
      engine: 'chatgpt',
      status: 'failed',
      failureReason: 'the engine returned an empty answer',
      mentioned: null,
      cited: null,
      prominence: null,
      citations: [],
      taskCost: 0,
    }];
    const run = loadRun({ prompts: [prompt(1)], counts: { approved: 1 }, captureRows: failedRows });
    const r = await run.runAiVisibility({ access: ACCESS, project: PROJECT, run: RUN });

    assert.strictEqual(r.status, 'insufficient_data');
    assert.match(r.note, /this is not an absence of the brand/);
  });

  section('captures that did not persist are not a completed run');

  await test('a saveCaptures failure refuses to score, and says the number is unreportable', async () => {
    // This used to be caught and logged, so a failed insert produced a
    // completed run with a headline score and no stored captures behind it —
    // a number no report could reproduce and nobody could tell was hollow.
    const run = loadRun({
      prompts: [prompt(1)],
      counts: { approved: 1 },
      saveError: new Error('null value in column "access" violates not-null constraint'),
    });
    const r = await run.runAiVisibility({ access: ACCESS, project: PROJECT, run: RUN });

    assert.strictEqual(r.status, 'insufficient_data');
    assert.strictEqual(r.score, null, 'scoring rows that were never stored invents a number');
    const f = r.findings.find((x) => x.id === 'aiv-captures-not-stored');
    assert.ok(f, 'the failure has to be visible on the run');
    assert.strictEqual(f.severity, 'error');
    assert.match(r.payload.storeError, /not-null/);
    assert.match(r.note, /could not be written/);
  });

  section('brandFrom / competitorsFrom — what actually gets matched');

  await test('the domain loses www and the de-spaced name becomes an alias', async () => {
    const run = loadRun({ prompts: [] });
    const b = run.brandFrom(PROJECT);
    assert.strictEqual(b.domain, 'gentledental.com');
    assert.ok(b.aliases.includes('GentleDental'),
      'models write the name both ways and missing one undercounts every mention');
  });

  await test('a competitor with no configured name falls back to its domain stem', async () => {
    const run = loadRun({ prompts: [] });
    const [c] = run.competitorsFrom({ competitors: [{ host: 'www.aspendental.com' }] });
    assert.strictEqual(c.name, 'aspendental');
    assert.ok(c.aliases.includes('aspendental'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
