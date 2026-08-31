// ── Prompt lifecycle rules ───────────────────────────────────────────────────
//
// Run: node modules/aiVisibility/__tests__/promptLifecycle.test.js

const assert = require('assert');
const lifecycle = require('../promptLifecycle');
const dataForSeoClient = require('../dataForSeoClient');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

// ── normalise ────────────────────────────────────────────────────────────────

section('normalise');

test('trims, collapses interior whitespace, lowercases', () => {
  assert.strictEqual(lifecycle.normalise('  Best  DENTIST   Boston '), 'best dentist boston');
});

test('empty and whitespace-only collapse to empty string', () => {
  assert.strictEqual(lifecycle.normalise(''), '');
  assert.strictEqual(lifecycle.normalise('   '), '');
  assert.strictEqual(lifecycle.normalise(null), '');
});

// ── MAX_PROMPT_CHARS agrees with the provider cap ───────────────────────────

section('shared constants');

test('MAX_PROMPT_CHARS matches dataForSeoClient — the two must never drift', () => {
  assert.strictEqual(lifecycle.MAX_PROMPT_CHARS, dataForSeoClient.MAX_PROMPT_CHARS);
});

// ── transitionFor ────────────────────────────────────────────────────────────

section('transitionFor');

test('draft -> approved is legal', () => {
  const v = lifecycle.transitionFor('draft', 'approved');
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.capability, 'editProjectSettings');
});

test('draft -> retired is not legal', () => {
  const v = lifecycle.transitionFor('draft', 'retired');
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /draft prompt can only move to/);
});

test('retired -> approved (restore) is legal', () => {
  assert.strictEqual(lifecycle.transitionFor('retired', 'approved').ok, true);
});

test('rejected -> draft (re-propose) is legal, rejected -> approved is not', () => {
  assert.strictEqual(lifecycle.transitionFor('rejected', 'draft').ok, true);
  assert.strictEqual(lifecycle.transitionFor('rejected', 'approved').ok, false);
});

test('unknown current status is rejected by name', () => {
  const v = lifecycle.transitionFor('bogus', 'approved');
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /Unknown status/);
});

// ── isMaterialChange ─────────────────────────────────────────────────────────

section('isMaterialChange');

test('changing text is material', () => {
  assert.strictEqual(
    lifecycle.isMaterialChange({ text: 'best dentist' }, { text: 'best dentist boston' }),
    true,
  );
});

test('changing slot/intent/rationale alone is not material', () => {
  assert.strictEqual(
    lifecycle.isMaterialChange(
      { text: 'best dentist', slot: 'category_commercial' },
      { slot: 'cost_pricing', intent: 'commercial', rationale: 'because' },
    ),
    false,
  );
});

// ── validatePrompt ───────────────────────────────────────────────────────────

section('validatePrompt');

test('empty text is rejected with empty_prompt', () => {
  try {
    lifecycle.validatePrompt({ text: '   ' });
    assert.fail('expected a throw');
  } catch (e) {
    assert.strictEqual(e.code, 'empty_prompt');
  }
});

test('text over MAX_PROMPT_CHARS is rejected with prompt_too_long', () => {
  const text = 'a'.repeat(lifecycle.MAX_PROMPT_CHARS + 1);
  try {
    lifecycle.validatePrompt({ text });
    assert.fail('expected a throw');
  } catch (e) {
    assert.strictEqual(e.code, 'prompt_too_long');
    assert.strictEqual(e.status, 400);
  }
});

test('a bad intent is rejected before it ever reaches the database', () => {
  try {
    lifecycle.validatePrompt({ text: 'best dentist boston', intent: 'urgent' });
    assert.fail('expected a throw');
  } catch (e) {
    assert.strictEqual(e.code, 'bad_intent');
  }
});

test('a bad slot is rejected', () => {
  try {
    lifecycle.validatePrompt({ text: 'best dentist boston', slot: 'made_up' });
    assert.fail('expected a throw');
  } catch (e) {
    assert.strictEqual(e.code, 'bad_slot');
  }
});

test('a bad source is rejected', () => {
  try {
    lifecycle.validatePrompt({ text: 'best dentist boston', source: 'seo_geo' });
    assert.fail('expected a throw');
  } catch (e) {
    assert.strictEqual(e.code, 'bad_source');
  }
});

test('a negative demand volume is rejected', () => {
  try {
    lifecycle.validatePrompt({ text: 'best dentist boston', demandVolume: -5 });
    assert.fail('expected a throw');
  } catch (e) {
    assert.strictEqual(e.code, 'bad_demand_volume');
  }
});

test('a well-formed prompt normalises defaults and trims fields', () => {
  const out = lifecycle.validatePrompt({
    text: '  best dentist boston  ', intent: 'commercial', slot: 'category_commercial',
  });
  assert.strictEqual(out.text, 'best dentist boston');
  assert.strictEqual(out.source, 'manual');
  assert.strictEqual(out.intent, 'commercial');
  assert.strictEqual(out.slot, 'category_commercial');
  assert.strictEqual(out.demandVolume, null);
});

test('SOURCES.CATEGORY keeps its historical DB value of "competitor"', () => {
  // Not a typo: it is in a live CHECK constraint (0016) and existing rows.
  assert.strictEqual(lifecycle.SOURCES.CATEGORY, 'competitor');
  assert.ok(lifecycle.SOURCE_LABELS.competitor);
});

test('every slot table entry has a label reachable from SLOT_LABEL', () => {
  for (const id of lifecycle.SLOT_IDS) {
    assert.ok(lifecycle.SLOT_LABEL[id], `missing label for ${id}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
