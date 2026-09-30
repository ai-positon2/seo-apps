// ── brandNames: which of a profile's names count as the business ────────────
//
// No model call — interpretVetting and isShortCode are the rules applied to
// its reply, so they are tested on hand-written replies.
//
// Run: node modules/aiVisibilityLite/__tests__/brandNames.test.js

const assert = require('assert');
const { interpretVetting, isShortCode } = require('../brandNames');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('\nbrandNames.interpretVetting');

test('third-party brands and generic names are dropped; the business and its own brands kept', () => {
  const out = interpretVetting({
    names: [
      { name: 'Gentle Dental', kind: 'business' },
      { name: 'ShadowPlex', kind: 'own_product' },
      { name: 'Invisalign', kind: 'third_party' },
      { name: 'Voice Library', kind: 'generic' },
    ],
  }, ['Gentle Dental', 'ShadowPlex', 'Invisalign', 'Voice Library']);
  assert.deepStrictEqual(out.kept, ['Gentle Dental', 'ShadowPlex']);
  assert.deepStrictEqual(out.dropped, [
    { name: 'Invisalign', kind: 'third_party' },
    { name: 'Voice Library', kind: 'generic' },
  ]);
});

test('a name the model skipped or mislabelled is kept, not lost', () => {
  const out = interpretVetting({ names: [{ name: 'Acme Co', kind: 'mystery' }] }, ['Acme Co', 'Acme Labs']);
  assert.deepStrictEqual(out.kept, ['Acme Co', 'Acme Labs']);
  assert.strictEqual(out.dropped.length, 0);
});

test('matching is case-insensitive on the name the model echoes back', () => {
  const out = interpretVetting({ names: [{ name: 'carecredit', kind: 'third_party' }] }, ['CareCredit']);
  assert.deepStrictEqual(out.dropped, [{ name: 'CareCredit', kind: 'third_party' }]);
});

test('short codes with a digit are dropped whatever the model said', () => {
  const out = interpretVetting({ names: [{ name: 'S2', kind: 'own_product' }] }, ['S2', 'S2.1 Pro']);
  assert.deepStrictEqual(out.kept, ['S2.1 Pro']);
  assert.deepStrictEqual(out.dropped, [{ name: 'S2', kind: 'generic' }]);
});

console.log('\nbrandNames.isShortCode');

test('flags "S1"/"V3", not real names', () => {
  assert.strictEqual(isShortCode('S1'), true);
  assert.strictEqual(isShortCode('V3'), true);
  assert.strictEqual(isShortCode('IBM'), false, 'a short name with no digit may be a real brand');
  assert.strictEqual(isShortCode('Fish.Audio'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
