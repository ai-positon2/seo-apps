// ── Version provenance and the first-named grid ────────────────────────────
//
// Two things this file pins, both of which went wrong by being plausible.
//
// The envelope used to stamp the CURRENT `RULESET_VERSION` on every report, so
// a report built entirely from rows classified months ago announced today's
// ruleset and the header printed it. The stamp exists precisely so a past
// period stays interpretable; taking it from the code defeated that exactly
// when a rule had changed, which is the only time it matters.
//
// And the first-named grid showed a fixed 1-4 window. Prose ordinals are
// numbered after the last map card, so on a local answer with 30 cards every
// prose mention sits at 31+ and the grid was empty; real data is sparse anyway
// (this client's ordinals run 1, 4, 5, 6 — 2 and 3 never occur), so a
// contiguous range spends its columns on cells that cannot fill. An earlier
// attempt used Math.min(4, max(seen)), which can only narrow and fixed neither.
//
// Run: node modules/aiVisibility/__tests__/provenance.test.js

const assert = require('assert');
const reports = require('../metrics/reports');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const CLIENT = { id: 'b1', name: 'Gentle Dental', isClient: true, domain: 'gentledental.com' };
const COMP = { id: 'b2', name: 'Aspen Dental', isClient: false, domain: 'aspendental.com' };
const PROMPTS = [{ id: 'p1', text: 'dentist in boston' }, { id: 'p2', text: 'dentist in quincy' }];

const capture = (id, version, extra = {}) => ({
  id,
  promptId: 'p1',
  prompt: 'dentist in boston',
  engine: 'chatgpt',
  status: 'captured',
  offGeo: false,
  features: ['web_search'],
  answerText: 'An answer.',
  extractedAt: '2026-08-20T11:00:00Z',
  extractionVersion: version,
  capturedAt: '2026-08-20T10:00:00Z',
  ...extra,
});

const input = (captures, mentions = [], citations = []) => ({
  captures,
  mentions,
  citations,
  brands: [CLIENT, COMP],
  prompts: PROMPTS,
  options: { to: '2026-08-29', days: 30 },
});

section('the version stamp describes the DATA, not the build');

test('one ruleset in scope is reported as that ruleset', () => {
  const r = reports.buildReport('insights', input(
    [capture('c1', 'm1+c2026.08.1+l1')],
    [],
    [{ captureId: 'c1', domain: 'ada.org', host: 'ada.org', rulesetVersion: '2026.08.1', occurrences: 1 }],
  ));
  assert.strictEqual(r.meta.rulesetVersion, '2026.08.1',
    'the report must not claim the ruleset the code is running');
  assert.strictEqual(r.meta.extractionVersion, 'm1+c2026.08.1+l1');
  assert.strictEqual(r.meta.versionSplit, null);
  assert.ok(!r.warnings.includes('mixed_extraction_versions'));
});

test('two rulesets in scope are BOTH named, and warned about', () => {
  // A matcher change moves ordinals, so a mean position across two versions
  // compares two scales. Averaging them silently is the failure.
  const r = reports.buildReport('insights', input(
    [capture('c1', 'm1+c2026.08.1+l1'), capture('c2', 'm2+c2026.08.2+l1')],
    [],
    [
      { captureId: 'c1', domain: 'ada.org', host: 'ada.org', rulesetVersion: '2026.08.1', occurrences: 1 },
      { captureId: 'c2', domain: 'ada.org', host: 'ada.org', rulesetVersion: '2026.08.2', occurrences: 1 },
    ],
  ));
  assert.match(r.meta.rulesetVersion, /2026\.08\.1/);
  assert.match(r.meta.rulesetVersion, /2026\.08\.2/);
  assert.ok(r.warnings.includes('mixed_extraction_versions'));
  assert.strictEqual(r.meta.versionSplit.extraction['m1+c2026.08.1+l1'], 1);
  assert.strictEqual(r.meta.versionSplit.extraction['m2+c2026.08.2+l1'], 1);
});

test('an unextracted scope names no version rather than inventing one', () => {
  const r = reports.buildReport('insights', input(
    [capture('c1', null, { extractedAt: null })],
  ));
  assert.strictEqual(r.meta.extractionVersion, null);
  assert.ok(!r.warnings.includes('mixed_extraction_versions'));
});

section('the first-named grid follows the ordinals that occur');

const mention = (captureId, brandId, ordinal) => ({
  captureId, brandId, ordinal, mentionCount: 1, negated: false,
});

test('sparse ordinals become the columns — not 1,2,3,4', () => {
  // Enough observations at each to clear MIN_FIRST_NAMED.
  const caps = ['c1', 'c2', 'c3'].map((id) => capture(id, 'm2+c2026.08.2+l1'));
  const mentions = caps.flatMap((c) => [
    mention(c.id, 'b1', 1),
    mention(c.id, 'b2', 4),
  ]);
  const r = reports.buildReport('insights', input(caps, mentions));
  const ordinals = r.data.firstNamed[0].positions.map((p) => p.ordinal);
  assert.deepStrictEqual(ordinals, [1, 4], 'only the ordinals present should be columns');
});

test('high ordinals are shown, not silently dropped', () => {
  // The map-answer case: our brand only appears in prose, after 30 cards.
  const caps = ['c1', 'c2', 'c3'].map((id) => capture(id, 'm2+c2026.08.2+l1'));
  const mentions = caps.map((c) => mention(c.id, 'b1', 31));
  const r = reports.buildReport('insights', input(caps, mentions));
  const pos = r.data.firstNamed[0].positions;
  assert.deepStrictEqual(pos.map((p) => p.ordinal), [31]);
  assert.strictEqual(pos[0].name, 'Gentle Dental',
    'a 1-4 window showed nothing at all for a map-heavy client');
});

test('a cell below the minimum sample names nobody', () => {
  const caps = ['c1', 'c2'].map((id) => capture(id, 'm2+c2026.08.2+l1'));
  const r = reports.buildReport('insights', input(caps, caps.map((c) => mention(c.id, 'b1', 1))));
  const cell = r.data.firstNamed[0].positions[0];
  assert.strictEqual(cell.name, null, 'two observations is not "the model names them first"');
  assert.strictEqual(cell.basis, 2);
});

test('a tie names nobody and says so', () => {
  const caps = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => capture(id, 'm2+c2026.08.2+l1'));
  const mentions = [
    ...caps.slice(0, 3).map((c) => mention(c.id, 'b1', 1)),
    ...caps.slice(3).map((c) => mention(c.id, 'b2', 1)),
  ];
  const r = reports.buildReport('insights', input(caps, mentions));
  const cell = r.data.firstNamed[0].positions[0];
  assert.strictEqual(cell.name, null);
  assert.strictEqual(cell.tied, true, 'a coin flip must not be printed as a finding');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
