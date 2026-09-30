// ── describe: the quote guard over the model's replies ──────────────────────
//
// No model call here — interpret() and interpretTones() are the parts that
// decide what survives, so they are tested on hand-written replies.
//
// Run: node modules/aiVisibilityLite/__tests__/describe.test.js

const assert = require('assert');
const { interpret, interpretTones } = require('../describe');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const TEXTS = [
  'Acme Dental is the best choice in Raleigh for implants, with superb reviews.',
  'Options include Rival Dental and Acme Dental, which offers general care.',
  'Acme Dental has had complaints about long wait times, so be cautious.',
  'Acme Dental is a highly recommended practice with a friendly team.',
];

console.log('\ndescribe.interpretTones — one tone per answer');

test('each answer keeps its tone when the quote is from that answer', () => {
  const out = interpretTones({
    answers: [
      { i: 0, tone: 'positive', quote: 'the best choice in Raleigh for implants' },
      { i: 1, tone: 'neutral', quote: 'Acme Dental, which offers general care' },
      { i: 2, tone: 'negative', quote: 'complaints about long wait times' },
    ],
  }, TEXTS);
  assert.deepStrictEqual(out.map((t) => [t.i, t.tone]), [[0, 'positive'], [1, 'neutral'], [2, 'negative']]);
});

test('a quote from ANOTHER answer, or an invented one, drops that tone', () => {
  const out = interpretTones({
    answers: [
      { i: 2, tone: 'positive', quote: 'the best choice in Raleigh for implants' },
      { i: 3, tone: 'positive', quote: 'an invented glowing endorsement' },
    ],
  }, TEXTS);
  assert.strictEqual(out.length, 0);
});

test('an unknown tone, a bad index, or a repeated index is ignored', () => {
  const out = interpretTones({
    answers: [
      { i: 0, tone: 'glowing', quote: 'the best choice in Raleigh for implants' },
      { i: 9, tone: 'positive', quote: 'the best choice in Raleigh for implants' },
      { i: 1, tone: 'neutral', quote: 'Acme Dental, which offers general care' },
      { i: 1, tone: 'positive', quote: 'Acme Dental, which offers general care' },
    ],
  }, TEXTS);
  assert.deepStrictEqual(out.map((t) => [t.i, t.tone]), [[1, 'neutral']]);
});

test('a quote matches with or without the answer\'s markdown, but the words must still match', () => {
  const md = ['Shop at [**Nike India**](https://nike.com/in) for **flagship running** shoes and more.'];
  const ok = interpretTones({ answers: [{ i: 0, tone: 'neutral', quote: 'Nike India for flagship running shoes' }] }, md);
  assert.strictEqual(ok.length, 1, 'markup stripped from the answer and the quote alike');
  const bad = interpretTones({ answers: [{ i: 0, tone: 'neutral', quote: 'Nike India for flagship walking shoes' }] }, md);
  assert.strictEqual(bad.length, 0, 'a changed word is still rejected');
});

test('"absent" is kept without a quote, so the answer is not re-read', () => {
  const out = interpretTones({ answers: [{ i: 3, tone: 'absent' }] }, TEXTS);
  assert.deepStrictEqual(out, [{ i: 3, tone: 'absent', quote: null }]);
});

console.log('\ndescribe.interpret — descriptors and the overall reading');

test('attributes carry a tone, defaulting to neutral rather than warmer', () => {
  const out = interpret({
    attributes: [
      { label: 'highly recommended', tone: 'positive', quotes: ['a highly recommended practice'] },
      { label: 'general care', tone: 'sparkly', quotes: ['which offers general care'] },
    ],
  }, TEXTS);
  assert.deepStrictEqual(out.attributes.map((a) => a.tone).sort(), ['neutral', 'positive']);
});

test('the overall reading still needs a real quote', () => {
  const backed = interpret({ sentiment: { score: 71, rationale: 'r', quotes: ['a highly recommended practice'] } }, TEXTS);
  assert.strictEqual(backed.sentiment.score, 71);
  const unbacked = interpret({ sentiment: { score: 90, rationale: 'r', quotes: ['nothing like this is in the text'] } }, TEXTS);
  assert.strictEqual(unbacked.sentiment, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
