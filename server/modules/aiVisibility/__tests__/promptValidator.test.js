// ── promptValidator ───────────────────────────────────────────────────────
//
// Run: node modules/aiVisibility/__tests__/promptValidator.test.js

const assert = require('assert');
const v = require('../promptValidator');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const BRAND = { name: 'Gentle Dental', domain: 'gentledental.com', aliases: ['GentleDental'] };
const COMPETITORS = [{ name: 'Aspen Dental', domain: 'aspendental.com' }];

// ── Brand guard ──────────────────────────────────────────────────────────

section('brandTokens — the generic-industry-word case');

test('"Gentle Dental" reduces to the distinctive token {gentle} plus the full phrase', () => {
  const info = v.brandTokens(BRAND, COMPETITORS);
  assert.ok(info.tokens.has('gentle'));
  assert.ok(!info.tokens.has('dental'), '"dental" is a generic industry word and must not be a brand token');
  assert.deepStrictEqual(info.phrases, ['gentle dental']);
  assert.strictEqual(info.strength, 'strict');
});

test('"gentle dental of boston" is caught by the phrase match', () => {
  const info = v.brandTokens(BRAND, COMPETITORS);
  assert.strictEqual(v.matchesBrand('gentle dental of boston', info), true);
});

test('"best dental implants boston" is allowed — "dental" alone is not the brand', () => {
  const info = v.brandTokens(BRAND, COMPETITORS);
  assert.strictEqual(v.matchesBrand('best dental implants boston', info), false);
});

test('a brand with nothing distinctive left ("Dental") yields strength: weak', () => {
  const info = v.brandTokens({ name: 'Dental', domain: 'dental.com' }, []);
  assert.strictEqual(info.tokens.size, 0);
  assert.strictEqual(info.strength, 'weak');
});

test('a competitor sharing a token with the brand name does not get that token filtered as the brand\'s', () => {
  // "Gentle Dental" vs a competitor literally named "Gentle Smiles" — "gentle"
  // is shared, so it must NOT count as identifying just the brand.
  const info = v.brandTokens(BRAND, [{ name: 'Gentle Smiles', domain: 'gentlesmiles.com' }]);
  assert.ok(!info.tokens.has('gentle'));
  // The full phrase still catches an exact brand mention.
  assert.strictEqual(v.matchesBrand('gentle dental reviews', info), true);
});

test('allowBrand slots are exempt from the brand guard', () => {
  const info = v.brandTokens(BRAND, COMPETITORS);
  const result = v.validateOne(
    { text: 'gentle dental vs aspen dental which is better', slot: 'comparison' },
    { brandTokenInfo: info, allowBrand: true },
  );
  assert.strictEqual(result.ok, true);
});

test('the same text on a non-allowBrand slot is rejected as brand_leak', () => {
  const info = v.brandTokens(BRAND, COMPETITORS);
  const result = v.validateOne(
    { text: 'gentle dental reviews', slot: 'category_commercial' },
    { brandTokenInfo: info, allowBrand: false },
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'brand_leak');
});

// ── Near-duplicate detection — the plan's three worked pairs ────────────────

section('isNearDuplicate — worked cases');

test('stemmed-identical prompts score 1.0 and are rejected', () => {
  const index = v.makeIndex(['best dental implants boston']);
  const result = v.isNearDuplicate('best dental implant boston', index);
  assert.strictEqual(result.dup, true);
  assert.strictEqual(result.score, 1);
});

test('a genuinely different intent (cost) scores 0.60 and is KEPT', () => {
  const index = v.makeIndex(['best dental implants boston']);
  const result = v.isNearDuplicate('dental implants cost boston', index);
  assert.strictEqual(Math.round(result.score * 100) / 100, 0.6);
  assert.strictEqual(result.dup, false, 'different intent must survive — the score is below threshold');
});

test('a strict superset (same words plus one) is caught by containment regardless of score', () => {
  const index = v.makeIndex(['best dental implants boston']);
  const result = v.isNearDuplicate('best dental implants boston cost', index);
  assert.strictEqual(result.dup, true);
  assert.strictEqual(result.rule, 'containment');
});

test('exact match after normalisation is caught even with different casing/whitespace', () => {
  const index = v.makeIndex(['best dentist boston']);
  const result = v.isNearDuplicate('Best   Dentist   BOSTON', index);
  assert.strictEqual(result.dup, true);
  assert.strictEqual(result.rule, 'exact');
});

test('an unrelated prompt is not flagged', () => {
  const index = v.makeIndex(['best dental implants boston']);
  const result = v.isNearDuplicate('how much does invisalign cost', index);
  assert.strictEqual(result.dup, false);
});

// ── Shape ────────────────────────────────────────────────────────────────

section('shapeOk — permissive on purpose');

test('a noun-phrase prompt with no question mark is accepted', () => {
  assert.strictEqual(v.shapeOk('best invisalign provider boston'), true);
});

test('a URL is rejected', () => {
  assert.strictEqual(v.shapeOk('https://example.com/best-dentist'), false);
});

test('markdown and list numbering are rejected', () => {
  assert.strictEqual(v.shapeOk('1. best dentist boston'), false);
  assert.strictEqual(v.shapeOk('**best dentist boston**'), false);
});

test('a single word is rejected as too thin to be a real query', () => {
  assert.strictEqual(v.shapeOk('dentist'), false);
});

// ── validateBatch ────────────────────────────────────────────────────────

section('validateBatch');

test('accepts good candidates, rejects a brand leak and a near-duplicate, tallies filledBySlot', () => {
  const candidates = [
    { text: 'best dental implants boston', slot: 'category_commercial' },
    { text: 'dental implants cost boston', slot: 'cost_pricing' },
    { text: 'gentle dental reviews', slot: 'category_commercial' }, // brand leak
    { text: 'best dental implant boston', slot: 'category_commercial' }, // dup of #1
  ];
  const result = v.validateBatch(candidates, { brand: BRAND, competitors: COMPETITORS, existing: [] });
  assert.strictEqual(result.accepted.length, 2);
  assert.strictEqual(result.rejected.length, 2);
  assert.strictEqual(result.rejected.find((r) => r.text === 'gentle dental reviews').code, 'brand_leak');
  assert.strictEqual(result.rejected.find((r) => r.text === 'best dental implant boston').code, 'duplicate');
  assert.strictEqual(result.filledBySlot.get('category_commercial'), 1);
  assert.strictEqual(result.filledBySlot.get('cost_pricing'), 1);
});

test('a candidate matching a RETIRED prompt in `existing` is still rejected as duplicate', () => {
  const result = v.validateBatch(
    [{ text: 'best dental implants boston', slot: 'category_commercial' }],
    { brand: BRAND, competitors: COMPETITORS, existing: ['best dental implants boston'] },
  );
  assert.strictEqual(result.accepted.length, 0);
  assert.strictEqual(result.rejected[0].code, 'duplicate');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
