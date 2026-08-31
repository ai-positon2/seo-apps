// ── The surface contract ───────────────────────────────────────────────────
//
// surfaces/index.js documents a contract every adapter is meant to satisfy,
// and nothing enforced it. That is how ACCESS came to be declared by no surface
// at all while store.js quietly defaulted the whole column to 'scraped' — a
// provenance claim on every row that nobody could check, and one that would
// have described a vendor-API capture as self-hosted.
//
// The sharper failure was the one after it: when store.js stopped defaulting,
// the two Google surfaces still had no ACCESS, so their captures would have
// sent an explicit NULL into a `not null` column. A default does not apply to a
// column that is present-and-null, so the INSERT fails — and run.js only logs a
// saveCaptures failure, meaning a whole run's measurements would have vanished
// while the run reported success.
//
// A contract test is cheap and would have caught both. This is that test.
//
// Run: node modules/aiVisibility/__tests__/surfaceContract.test.js

const assert = require('assert');
const { SURFACES, surfaceIds } = require('../surfaces');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

// The values 0016's CHECK constraint permits on ai_visibility_captures.access.
const LEGAL_ACCESS = new Set(['scraped', 'api']);

section('every registered surface satisfies the contract');

test('there is at least one surface registered', () => {
  assert.ok(surfaceIds().length >= 2, 'a registry with nothing in it proves nothing');
});

for (const id of surfaceIds()) {
  const s = SURFACES[id];

  test(`${id} — declares ENGINE, PROVIDER and LABEL`, () => {
    assert.strictEqual(typeof s.ENGINE, 'string', 'ENGINE keys the scheduler lane');
    assert.ok(s.ENGINE.length, 'an empty ENGINE collapses every surface into one lane');
    assert.strictEqual(typeof s.PROVIDER, 'string');
    assert.strictEqual(typeof s.LABEL, 'string');
    assert.ok(s.LABEL.length, 'the label is what a client is shown as provenance');
  });

  test(`${id} — its id matches ENGINE:PROVIDER`, () => {
    assert.strictEqual(id, `${s.ENGINE}:${s.PROVIDER}`,
      'stored captures reference a surface by this id for ever');
  });

  test(`${id} — declares a legal ACCESS`, () => {
    assert.ok(s.ACCESS, `${id} has no ACCESS, so its captures would send NULL into a not-null column`);
    assert.ok(LEGAL_ACCESS.has(s.ACCESS),
      `ACCESS "${s.ACCESS}" is outside the 0016 CHECK constraint (scraped | api)`);
  });

  test(`${id} — ACCESS agrees with how it actually works`, () => {
    // Not cosmetic: this is the field that says whether we own the raw answer.
    const expected = s.PROVIDER === 'scraped' ? 'scraped' : 'api';
    assert.strictEqual(s.ACCESS, expected,
      `${id} is served by ${s.PROVIDER} but claims access "${s.ACCESS}"`);
  });

  test(`${id} — capture() is callable`, () => {
    assert.strictEqual(typeof s.capture, 'function');
    // Spreading a surface object to add ACCESS would break a method that
    // relied on `this`; none may.
    assert.ok(!/\bthis\./.test(s.capture.toString()),
      'a surface that uses `this` cannot be safely spread or re-exported');
  });
}

section('chat surfaces claim ALWAYS_ANSWERS, SERP surfaces do not');

test('a chat surface answering with nothing is a failure, not an absence', () => {
  // capture.js branches on this to decide whether an empty answer is a
  // MEASURED absence (a SERP with no AI Overview) or a read failure (a chat
  // engine, which always replies). Getting it backwards fabricates absences.
  for (const id of surfaceIds()) {
    const s = SURFACES[id];
    const isChat = s.ENGINE === 'chatgpt' || s.ENGINE === 'gemini';
    if (isChat) {
      assert.strictEqual(s.ALWAYS_ANSWERS, true, `${id} is a chat surface and must set ALWAYS_ANSWERS`);
    } else {
      assert.ok(!s.ALWAYS_ANSWERS,
        `${id} is a SERP surface; ALWAYS_ANSWERS would turn "no AI Overview" into a failure`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
