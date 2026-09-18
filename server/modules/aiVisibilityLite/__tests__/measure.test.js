// ── measure(), over fake surfaces rather than over the network ──────────────
//
// The rule under test is the one the whole module is built on:
//
//   A CAPTURE THAT FAILED IS NOT AN ABSENCE OF THE BRAND.
//
// A provider that times out, refuses, or returns something unreadable must
// produce `mentioned: null` and `status: 'failed'` — never `mentioned: false`,
// which would tell a client they are invisible when the pipeline broke.
//
// Run: node modules/aiVisibilityLite/__tests__/measure.test.js

const assert = require('assert');

let passed = 0; let failed = 0;
async function atest(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

// ── A fake surface, swapped into the registry ──────────────────────────────
//
// The registry is required by measure.js, so it is patched in place rather
// than mocked at the module loader: the point is to test measure(), not the
// three adapters, which need real network calls to say anything.
const surfaces = require('../surfaces');

function fakeSurface(behaviour) {
  return {
    ENGINE: 'fake',
    PROVIDER: 'api',
    LABEL: 'Fake (API · test)',
    ACCESS: 'api',
    ALWAYS_ANSWERS: true,
    hasKey: () => true,
    capture: behaviour,
  };
}

function install(behaviour) {
  surfaces.SURFACES['fake:api'] = fakeSurface(behaviour);
  return 'fake:api';
}

const { measure } = require('../measure');

const BRAND = { name: 'Gentle Dental', domain: 'gentledental.com', aliases: ['GentleDental'] };
const COMPETITORS = [{ name: 'Aspen Dental', aliases: ['aspendental'] }];

const ANSWER = 'For implants in the area, Gentle Dental is well reviewed, '
  + 'and Aspen Dental is another option worth considering for cost.';

const ok = (over = {}) => async () => ({
  engine: 'fake',
  provider: 'api',
  surfaceLabel: 'Fake (API · test)',
  access: 'api',
  answerText: ANSWER,
  citations: [{ url: 'https://gentledental.com/implants', title: 'Implants', domain: 'gentledental.com', index: 1 }],
  webQueries: ['best dental implants'],
  providerBrands: [],
  features: ['web_search', 'prose'],
  grounded: true,
  modelVersion: 'fake-1',
  taskCost: 0.01,
  capturedAt: new Date().toISOString(),
  raw: {},
  ...over,
});

(async () => {
  section('A failure is never an absence');

  await atest('a thrown provider error gives mentioned: null, not false', async () => {
    const id = install(async () => { throw Object.assign(new Error('502 Bad Gateway'), { code: 'upstream' }); });
    const r = await measure({ surfaceId: id, prompt: 'p', brand: BRAND, competitors: COMPETITORS });
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.mentioned, null, 'mentioned must be null, not false');
    assert.strictEqual(r.cited, null);
    assert.strictEqual(r.prominence, null);
    assert.match(r.failureReason, /502/);
  });

  await atest('a timeout gives mentioned: null', async () => {
    const id = install(async () => { throw Object.assign(new Error('did not answer within 90s'), { code: 'timeout' }); });
    const r = await measure({ surfaceId: id, prompt: 'p', brand: BRAND });
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.mentioned, null);
    assert.strictEqual(r.raw.failureCode, 'timeout');
  });

  await atest('an empty answer is a failure, not a measured absence', async () => {
    const id = install(ok({ answerText: null }));
    const r = await measure({ surfaceId: id, prompt: 'p', brand: BRAND });
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.mentioned, null, 'a chat model never legitimately says nothing');
    assert.match(r.failureReason, /empty answer/);
  });

  await atest('a too-short answer is a failure (refusal or truncated stream)', async () => {
    const id = install(ok({ answerText: 'I cannot help.' }));
    const r = await measure({ surfaceId: id, prompt: 'p', brand: BRAND });
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.mentioned, null);
    assert.match(r.failureReason, /characters/);
  });

  await atest('an unregistered surface fails rather than throwing', async () => {
    const r = await measure({ surfaceId: 'nope:api', prompt: 'p', brand: BRAND });
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.mentioned, null);
    assert.match(r.failureReason, /no surface registered/);
  });

  section('A real answer is measured with v1\'s matchers');

  await atest('names the brand, cites the domain, finds the competitor', async () => {
    const id = install(ok());
    const r = await measure({ surfaceId: id, prompt: 'p', brand: BRAND, competitors: COMPETITORS });
    assert.strictEqual(r.status, 'captured');
    assert.strictEqual(r.mentioned, true);
    assert.strictEqual(r.cited, true);
    assert.deepStrictEqual(r.competitorsMentioned, ['Aspen Dental']);
    assert.ok(r.prominence > 0 && r.prominence < 1, 'prominence is a 0-1 fraction');
    assert.strictEqual(r.grounded, true);
    assert.deepStrictEqual(r.webQueries, ['best dental implants']);
  });

  await atest('a genuine absence is false, not null', async () => {
    const id = install(ok({
      answerText: 'Aspen Dental and several other practices offer implants in that area today.',
      citations: [],
    }));
    const r = await measure({ surfaceId: id, prompt: 'p', brand: BRAND, competitors: COMPETITORS });
    assert.strictEqual(r.status, 'captured');
    assert.strictEqual(r.mentioned, false, 'measured and not named IS false');
    assert.strictEqual(r.prominence, null, 'not mentioned has no position');
  });

  await atest('an alias counts as the brand', async () => {
    const id = install(ok({
      answerText: 'GentleDental has good reviews for implants and is worth a look for most patients.',
      citations: [],
    }));
    const r = await measure({ surfaceId: id, prompt: 'p', brand: BRAND });
    assert.strictEqual(r.mentioned, true);
  });

  section('Grounding is recorded, never inferred');

  await atest('an ungrounded answer is still measured, and says so', async () => {
    const id = install(ok({ grounded: false, features: ['prose'], webQueries: [] }));
    const r = await measure({ surfaceId: id, prompt: 'p', brand: BRAND });
    assert.strictEqual(r.status, 'captured');
    assert.strictEqual(r.mentioned, true, 'an ungrounded answer is still an answer');
    assert.strictEqual(r.grounded, false, 'but the row must say it did not search');
  });

  section('The retry only recovers unreadable answers');

  await atest('an empty first answer is retried once and can recover', async () => {
    let calls = 0;
    const id = install(async () => {
      calls += 1;
      return calls === 1 ? (await ok({ answerText: '' })()) : (await ok()());
    });
    const r = await measure({ surfaceId: id, prompt: 'p', brand: BRAND });
    assert.strictEqual(calls, 2, 'exactly one extra attempt');
    assert.strictEqual(r.status, 'captured');
    assert.strictEqual(r.raw.recoveredOnRetry, true);
  });

  await atest('a good first answer is never retried', async () => {
    let calls = 0;
    const id = install(async () => { calls += 1; return ok()(); });
    await measure({ surfaceId: id, prompt: 'p', brand: BRAND });
    assert.strictEqual(calls, 1, 'a usable answer must not be paid for twice');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
