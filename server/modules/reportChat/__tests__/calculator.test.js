// ── The assistant's calculator ──────────────────────────────────────────────
//
// Exact arithmetic for the chat model, which otherwise rounds 79.18 to 80.
// Covers the grammar, rounding, and that nothing outside it is evaluated.
//
// Run: node --test modules/reportChat/__tests__/calculator.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { evaluate, runCalculator } = require('../calculator');

test('the sums the assistant actually needs', () => {
  assert.equal(evaluate('100 - (4.92 + 22.11 + 7.52)'), 65.45);
  assert.equal(evaluate('round(65.46 + 9.38 + 4.34)'), 79);
  assert.equal(evaluate('10 × 1290 ÷ 1376'), 9.37500000000);
  assert.equal(evaluate('sum(100,200)'), 300, 'a comma separates arguments, never thousands');
  assert.throws(() => evaluate('1,290 + 1'));
  assert.equal(evaluate('round(10 * 1290 / 1376, 2)'), 9.38);
  assert.equal(evaluate('min(100, round(52000 / 61000 * 100))'), 85);
  assert.equal(evaluate('sum(9.38, 4.34, 2.59)'), 16.31);
});

test('precedence, unary minus, powers', () => {
  assert.equal(evaluate('2 + 3 * 4'), 14);
  assert.equal(evaluate('(2 + 3) * 4'), 20);
  assert.equal(evaluate('-3 + 5'), 2);
  assert.equal(evaluate('2 ** 3 ** 2'), 512);
  assert.equal(evaluate('0.1 + 0.2'), 0.3);
});

test('rounding is half away from zero', () => {
  assert.equal(evaluate('round(2.5)'), 3);
  assert.equal(evaluate('round(1.005, 2)'), 1.01);
  assert.equal(evaluate('round(-2.5)'), -3);
});

test('anything outside the grammar is refused, never run', () => {
  for (const bad of ['process.exit(1)', 'require("fs")', '1 +', '(1', 'constructor', '1 / 0', '', 'alert(1)']) {
    assert.throws(() => evaluate(bad), Error, bad);
  }
});

test('tool output reports each expression, errors included', () => {
  const out = JSON.parse(runCalculator(JSON.stringify({ expressions: ['1 + 1', 'bad('] })));
  assert.deepEqual(out[0], { expression: '1 + 1', result: 2 });
  assert.ok(out[1].error);
  assert.ok(JSON.parse(runCalculator('not json')).error);
});
