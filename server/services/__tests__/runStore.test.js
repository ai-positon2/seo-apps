// ── Tests for run payload sanitization ───────────────────────────────────────
// The parts of runStore that don't touch the database: what actually gets
// written into tool_runs.input / tool_runs.output. These matter because every
// module's request body flows through here — including bodies carrying API
// keys and whole HTML documents.
// Run: node services/__tests__/runStore.test.js

const assert = require('assert');
const { sanitize, capped } = require('../runStore');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Run payload sanitization');

test('secrets are redacted at any depth', () => {
  const out = sanitize({
    url: 'https://x.com',
    apiKey: 'sk-live-123',
    nested: { semrushApiKey: 'abc', authorization: 'Bearer y', password: 'p' },
  });
  assert.strictEqual(out.url, 'https://x.com');
  assert.strictEqual(out.apiKey, '[redacted]');
  assert.strictEqual(out.nested.semrushApiKey, '[redacted]');
  assert.strictEqual(out.nested.authorization, '[redacted]');
  assert.strictEqual(out.nested.password, '[redacted]');
});

test('content blobs become size markers, not stored text', () => {
  const html = '<p>x</p>'.repeat(5000);
  const out = sanitize({ url: 'https://x.com', html, manualContent: html });
  assert.deepStrictEqual(out.html, { _type: 'text', chars: html.length });
  assert.deepStrictEqual(out.manualContent, { _type: 'text', chars: html.length });
});

test('long non-blob strings keep a preview plus their length', () => {
  const long = 'k'.repeat(2000);
  const out = sanitize({ keyword: long });
  assert.strictEqual(out.keyword._type, 'text');
  assert.strictEqual(out.keyword.chars, 2000);
  assert.ok(out.keyword.preview.length < 2000);
});

test('short arrays are kept, long ones are sampled with their length', () => {
  assert.deepStrictEqual(sanitize({ ks: ['a', 'b'] }).ks, ['a', 'b']);
  const many = sanitize({ ks: Array.from({ length: 40 }, (_, i) => `k${i}`) }).ks;
  assert.strictEqual(many._type, 'array');
  assert.strictEqual(many.length, 40);
  assert.strictEqual(many.sample.length, 5);
});

test('deep nesting is elided rather than walked forever', () => {
  let deep = { leaf: true };
  for (let i = 0; i < 12; i++) deep = { level: deep };
  const out = sanitize(deep);
  assert.ok(JSON.stringify(out).length < 500, 'deep object collapses');
});

test('circular references do not throw', () => {
  const a = { name: 'a' };
  a.self = a;
  const { value, truncated } = capped(a);
  assert.ok(value, 'returns something');
  assert.strictEqual(typeof truncated, 'boolean');
});

test('oversized payloads are truncated and flagged', () => {
  const big = {};
  for (let i = 0; i < 400; i++) big[`section${i}`] = { rows: Array.from({ length: 50 }, (_, j) => `row-${i}-${j}`) };
  const { value, truncated } = capped(big);
  assert.strictEqual(truncated, true, 'flagged as truncated');
  assert.ok(JSON.stringify(value).length <= 16 * 1024, 'inside the byte budget');
});

test('a normal payload is stored intact and not flagged', () => {
  const input = { url: 'https://x.com/page', keywords: ['a', 'b'], pageIntent: 'auto' };
  const { value, truncated } = capped(input);
  assert.strictEqual(truncated, false);
  assert.deepStrictEqual(value, input);
});

test('null and undefined round-trip as null', () => {
  assert.deepStrictEqual(capped(null), { value: null, truncated: false });
  assert.deepStrictEqual(capped(undefined), { value: null, truncated: false });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
