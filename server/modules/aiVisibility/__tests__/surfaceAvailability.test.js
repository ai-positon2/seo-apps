// ── surface availability ──────────────────────────────────────────────────
//
// Which surfaces a run may measure, and why one is skipped.
//
// The distinction this file protects: a disabled surface stays REGISTERED for
// ever. Stored captures reference it by id, and a report showing a row from
// last month must still be able to name what produced it. Only new runs are
// gated.
//
// It also pins the `.ENGINE` casing, because getting that wrong is invisible:
// `.engine` is undefined for every surface, which collapses them all into one
// concurrency lane and silently reverts a parallel run to serial. Nothing
// fails, it just quietly takes four times as long.
//
// Run: node modules/aiVisibility/__tests__/surfaceAvailability.test.js

const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

/** Reload both modules with a given env, since availability reads env lazily. */
function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
  for (const key of Object.keys(require.cache)) {
    if (/aiVisibility[\\/](surfaces|captureEngines[\\/]proxyPool|run)/.test(key)) {
      delete require.cache[key];
    }
  }
  try { return fn(require('../surfaces'), require('../run')); }
  finally {
    process.env = saved;
    for (const key of Object.keys(require.cache)) {
      if (/aiVisibility[\\/](surfaces|captureEngines[\\/]proxyPool|run)/.test(key)) {
        delete require.cache[key];
      }
    }
  }
}

section('the surface contract — uppercase ENGINE');

test('every registered surface exposes ENGINE, PROVIDER, LABEL and capture', () => {
  withEnv({}, (surfaces) => {
    for (const id of surfaces.surfaceIds()) {
      const s = surfaces.surfaceFor(id);
      assert.ok(s.ENGINE, `${id} has no ENGINE`);
      assert.ok(s.PROVIDER, `${id} has no PROVIDER`);
      assert.ok(s.LABEL, `${id} has no LABEL`);
      assert.strictEqual(typeof s.capture, 'function', `${id} has no capture()`);
    }
  });
});

test('lowercase `.engine` does NOT exist — the casing trap', () => {
  withEnv({}, (surfaces) => {
    const s = surfaces.surfaceFor('chatgpt:scraped');
    assert.strictEqual(s.engine, undefined,
      'if this ever becomes defined, the guard below stops protecting anything');
  });
});

test('the id a surface is registered under matches its own ENGINE:PROVIDER', () => {
  withEnv({}, (surfaces) => {
    for (const id of surfaces.surfaceIds()) {
      const s = surfaces.surfaceFor(id);
      assert.strictEqual(id, `${s.ENGINE}:${s.PROVIDER}`);
    }
  });
});

section('what runs today: ChatGPT + Gemini, self-hosted');

test('the default set is the two that need no proxy', () => {
  withEnv({ AIV_PROXIES: undefined }, (surfaces, run) => {
    assert.deepStrictEqual(run.DEFAULT_SURFACES, ['chatgpt:scraped', 'gemini:scraped']);
    assert.deepStrictEqual(surfaces.availableSurfaceIds(), ['chatgpt:scraped', 'gemini:scraped']);
  });
});

test('every default surface maps to a real engine name', () => {
  withEnv({}, (surfaces, run) => {
    const engines = run.DEFAULT_SURFACES.map((id) => surfaces.surfaceFor(id).ENGINE);
    assert.deepStrictEqual(engines, ['chatgpt', 'gemini']);
    assert.ok(engines.every(Boolean),
      'an undefined engine collapses every surface into one lane and un-parallelises the run');
    assert.strictEqual(new Set(engines).size, engines.length,
      'two surfaces sharing an engine would serialise against each other');
  });
});

section('DataForSEO is turned off, not deleted');

test('the DataForSEO surfaces are unavailable but still resolve', () => {
  withEnv({}, (surfaces) => {
    assert.strictEqual(surfaces.unavailableReason('chatgpt:dataforseo'), 'turned_off');
    assert.ok(surfaces.surfaceFor('chatgpt:dataforseo'),
      'a stored capture from last month must still be able to name what produced it');
    assert.ok(surfaces.surfaceFor('chatgpt:dataforseo').LABEL);
  });
});

test('they come back by naming a different disabled list', () => {
  withEnv({ AIV_DISABLED_SURFACES: '' }, (surfaces) => {
    assert.strictEqual(surfaces.unavailableReason('chatgpt:dataforseo'), null,
      'an explicitly empty list means nothing is turned off');
  });
});

section('Google returns by itself once a proxy exists');

test('with no proxy configured, the Google surfaces are held back', () => {
  withEnv({ AIV_PROXIES: undefined }, (surfaces) => {
    assert.strictEqual(surfaces.unavailableReason('google_ai_overview:scraped'), 'needs_proxy');
    assert.strictEqual(surfaces.unavailableReason('google_ai_mode:scraped'), 'needs_proxy');
  });
});

test('setting AIV_PROXIES brings them back with no other change', () => {
  withEnv({ AIV_PROXIES: 'gate.example.com:7000:user:pass#us' }, (surfaces) => {
    assert.strictEqual(surfaces.unavailableReason('google_ai_overview:scraped'), null);
    assert.strictEqual(surfaces.unavailableReason('google_ai_mode:scraped'), null);
    assert.deepStrictEqual(surfaces.availableSurfaceIds(), [
      'chatgpt:scraped', 'gemini:scraped', 'google_ai_overview:scraped', 'google_ai_mode:scraped',
    ], 'tying this to the actual precondition beats remembering a second switch');
  });
});

test('a proxy does NOT revive the surfaces that were turned off', () => {
  withEnv({ AIV_PROXIES: 'gate.example.com:7000:u:p#us' }, (surfaces) => {
    assert.strictEqual(surfaces.unavailableReason('chatgpt:dataforseo'), 'turned_off',
      'the two reasons are independent');
  });
});

section('an unknown id is unavailable, not a crash');

test('a typo reports not_registered rather than throwing', () => {
  withEnv({}, (surfaces) => {
    assert.strictEqual(surfaces.unavailableReason('perplexity:scraped'), 'not_registered');
    assert.strictEqual(surfaces.isAvailable('perplexity:scraped'), false);
  });
});

section('an empty answer means different things on different surfaces');

test('a chat surface declares it always answers; a SERP surface does not', () => {
  withEnv({}, (surfaces) => {
    assert.strictEqual(surfaces.surfaceFor('chatgpt:scraped').ALWAYS_ANSWERS, true);
    assert.strictEqual(surfaces.surfaceFor('gemini:scraped').ALWAYS_ANSWERS, true);
    assert.strictEqual(surfaces.surfaceFor('google_ai_overview:scraped').ALWAYS_ANSWERS, undefined,
      'plenty of queries genuinely have no AI Overview — that IS a measured absence');
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
