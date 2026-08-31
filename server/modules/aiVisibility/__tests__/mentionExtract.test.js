// ── mentionExtract ────────────────────────────────────────────────────────
//
// This decides the headline number, so the cases that could silently corrupt
// it are pinned here: a brand named only inside a URL, a short brand name
// nested in a longer one, and a map answer where card order is the ranking.
//
// Run: node modules/aiVisibility/__tests__/mentionExtract.test.js

const assert = require('assert');
const m = require('../captureEngines/mentionExtract');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const BRANDS = [
  { id: 'b1', name: 'Gentle Dental', aliases: ['Gentle Dental', 'GentleDental'], isClient: true, domain: 'gentledental.com' },
  { id: 'b2', name: 'Aspen Dental', aliases: ['Aspen Dental', 'AspenDental'], isClient: false, domain: 'aspendental.com' },
];

section('normalisation preserves length, so offsets stay true');

test('curly quotes, dashes and case fold 1:1', () => {
  const src = 'Gentle’s — Dental';
  assert.strictEqual(m.normaliseKeepingLength(src).length, src.length);
});

section('extractMentions — the basics');

test('finds a brand and records a verbatim evidence substring', () => {
  const text = 'For implants, Gentle Dental is widely recommended in Boston.';
  const [row] = m.extractMentions({ answerText: text, brands: BRANDS });
  assert.strictEqual(row.brandId, 'b1');
  assert.strictEqual(row.isClient, true);
  assert.ok(text.includes(row.evidence), 'evidence must be a literal substring of the answer');
});

test('ordinal ranks by first appearance', () => {
  const text = 'Aspen Dental has many locations. Gentle Dental is smaller.';
  const rows = m.extractMentions({ answerText: text, brands: BRANDS });
  assert.deepStrictEqual(rows.map((r) => [r.name, r.ordinal]), [['Aspen Dental', 1], ['Gentle Dental', 2]]);
});

test('repeat mentions are counted, and the FIRST offset is kept', () => {
  const text = 'Gentle Dental is good. Later, Gentle Dental again.';
  const [row] = m.extractMentions({ answerText: text, brands: BRANDS });
  assert.strictEqual(row.mentionCount, 2);
  assert.strictEqual(row.charOffset, 0);
});

test('a brand that is absent produces no row at all', () => {
  const rows = m.extractMentions({ answerText: 'Some other practice entirely.', brands: BRANDS });
  assert.deepStrictEqual(rows, []);
});

test('word boundaries are respected — no matching inside a longer word', () => {
  const rows = m.extractMentions({ answerText: 'Ungentle Dentalworks is unrelated.', brands: BRANDS });
  assert.deepStrictEqual(rows, []);
});

section('a mention inside a URL is a citation, not a recommendation');

test('a bare URL containing the brand is not a mention', () => {
  const rows = m.extractMentions({ answerText: 'See https://gentledental.com/implants for details.', brands: BRANDS });
  assert.deepStrictEqual(rows, [], 'a linked domain is not the model naming the brand');
});

test('a markdown link target is not a mention', () => {
  const rows = m.extractMentions({ answerText: 'Read more [here](https://www.gentledental.com/x).', brands: BRANDS });
  assert.deepStrictEqual(rows, []);
});

test('but prose beside a URL still counts', () => {
  const text = 'Gentle Dental (https://gentledental.com) is well reviewed.';
  const rows = m.extractMentions({ answerText: text, brands: BRANDS });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].mentionCount, 1, 'the URL occurrence must not double-count');
});

section('overlapping names — the longer brand wins its span');

test('a brand nested in a longer brand name does not steal the mention', () => {
  const brands = [
    { id: 'x', name: 'Aspen', aliases: ['Aspen'], isClient: false },
    { id: 'y', name: 'Aspen Dental Care Group', aliases: ['Aspen Dental Care Group'], isClient: false },
  ];
  const rows = m.extractMentions({ answerText: 'Aspen Dental Care Group runs the clinic.', brands });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].brandId, 'y');
});

section('map answers — card order IS the ranking');

test('a brand appearing as a card is found even when prose never names it', () => {
  const rows = m.extractMentions({
    answerText: 'Here are some options near you.',
    brands: BRANDS,
    mapCards: [{ name: 'Aspen Dental', position: 1 }, { name: 'Gentle Dental', position: 2 }],
  });
  assert.strictEqual(rows.length, 2, 'a map-only mention must not read as an absence');
  assert.strictEqual(rows.find((r) => r.brandId === 'b2').source, 'map_card');
});

test('card position becomes the ordinal, overriding prose order', () => {
  const rows = m.extractMentions({
    // Prose names Gentle first, but the map ranks Aspen first.
    answerText: 'Gentle Dental is mentioned here in passing.',
    brands: BRANDS,
    mapCards: [{ name: 'Aspen Dental', position: 1 }, { name: 'Gentle Dental', position: 2 }],
  });
  assert.strictEqual(rows.find((r) => r.name === 'Aspen Dental').ordinal, 1);
  assert.strictEqual(rows.find((r) => r.name === 'Gentle Dental').ordinal, 2);
});

test('a card whose name merely contains the brand still matches', () => {
  const rows = m.extractMentions({
    answerText: 'Options below.',
    brands: BRANDS,
    mapCards: [{ name: 'Gentle Dental of Newbury Street', position: 1 }],
  });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ordinal, 1);
});

section('ordinals are contiguous and stable');

test('ordinals start at 1 and never collide', () => {
  const rows = m.extractMentions({
    answerText: 'Gentle Dental and Aspen Dental both operate here.',
    brands: BRANDS,
  });
  const ords = rows.map((r) => r.ordinal).sort();
  assert.deepStrictEqual(ords, [1, 2]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
