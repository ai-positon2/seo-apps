// ── answerBrands + the "recommended instead" table ──────────────────────────
//
// No model call — interpretBrands is the guard over the model's reply, and
// othersNamedTable / gapTable are pure over rows.
//
// Run: node modules/aiVisibilityLite/__tests__/answerBrands.test.js

const assert = require('assert');
const { interpretBrands, BRANDS_VERSION } = require('../answerBrands');
const report = require('../report');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('\nanswerBrands.interpretBrands');

const TEXTS = ['Try **Myntra** or [Adidas India](https://adidas.co.in) for shoes; Acme Dental is not relevant.'];

test('keeps names that are in the answer, drops invented ones and the client', () => {
  const out = interpretBrands({ answers: [{ i: 0, names: ['Myntra', 'Adidas India', 'Zappos', 'Acme Dental'] }] }, TEXTS, ['Acme Dental']);
  assert.deepStrictEqual(out.get(0), ['Myntra', 'Adidas India']);
});

test('an answer naming nobody is kept as an empty list, so it is not re-read', () => {
  const out = interpretBrands({ answers: [{ i: 0, names: [] }] }, TEXTS);
  assert.deepStrictEqual(out.get(0), []);
});

console.log('\nreport — who the answers recommend');

const PROMPTS = [{ id: 'p1', text: 'best shoe store' }];
const CLIENT = { name: 'Nike', domain: 'nike.com', aliases: [] };
const cap = (over) => ({
  id: Math.random().toString(36).slice(2),
  runId: 'r1',
  promptId: 'p1',
  engine: 'openai',
  status: 'captured',
  mentioned: false,
  cited: false,
  competitorsMentioned: [],
  citations: [],
  grounded: true,
  capturedAt: new Date().toISOString(),
  ...over,
});
const brands = (engine, names) => ({ runId: 'r1', promptId: 'p1', engine, names, v: BRANDS_VERSION });

test('spellings merge ("Adidas", "Adidas India"), the site is found, and tracked ones are marked', () => {
  const out = report.build({
    captures: [
      cap({ engine: 'openai', answerText: 'Adidas and Myntra', citations: [{ domain: 'adidas.co.in', url: 'https://adidas.co.in' }] }),
      cap({ engine: 'anthropic', answerText: 'Adidas India and Myntra', citations: [{ domain: 'myntra.com', url: 'https://myntra.com' }] }),
    ],
    prompts: PROMPTS,
    brand: CLIENT,
    competitors: [{ name: 'Myntra', domain: 'myntra.com', aliases: [] }],
    answerBrands: [brands('openai', ['Adidas', 'Myntra']), brands('anthropic', ['Adidas India', 'Myntra'])],
  });
  const byName = Object.fromEntries(out.othersNamed.list.map((o) => [o.name, o]));
  assert.ok(byName.Adidas, 'one Adidas row, not two');
  assert.strictEqual(byName.Adidas.answers, 2);
  assert.strictEqual(byName.Adidas.domain, 'adidas.co.in');
  assert.strictEqual(byName.Myntra.tracked, true);
  assert.strictEqual(byName.Adidas.tracked, false);
});

test('an answer recommending others and not you is a gap, with no competitors configured', () => {
  const out = report.build({
    captures: [cap({ answerText: 'Use Walker Sands.', citations: [{ domain: 'clutch.co', url: 'https://clutch.co/x' }] })],
    prompts: PROMPTS,
    brand: CLIENT,
    competitors: [],
    answerBrands: [brands('openai', ['Walker Sands'])],
  });
  assert.strictEqual(out.gaps.total, 1, 'the source behind that answer is a gap');
  assert.strictEqual(out.gaps.rows[0].domain, 'clutch.co');
});

test('without any reading of who answers recommend, gaps still need a tracked competitor', () => {
  const out = report.build({
    captures: [cap({ answerText: 'Use Walker Sands.', citations: [{ domain: 'clutch.co', url: 'https://clutch.co/x' }] })],
    prompts: PROMPTS,
    brand: CLIENT,
    competitors: [],
  });
  assert.strictEqual(out.gaps.total, 0);
});

test('a stale reading (older version) is ignored', () => {
  const out = report.build({
    captures: [cap({ answerText: 'Use Walker Sands.' })],
    prompts: PROMPTS,
    brand: CLIENT,
    answerBrands: [{ ...brands('openai', ['Walker Sands']), v: BRANDS_VERSION - 1 }],
  });
  assert.strictEqual(out.othersNamed.analysed, 0);
});

test('a configured competitor picks up the name the answers use for it', () => {
  const [c] = report.enrichCompetitors(
    [{ name: 'footlocker', domain: 'footlocker.com', aliases: ['footlocker'] }],
    [cap({ answerText: 'Try Foot Locker.', citations: [{ domain: 'footlocker.com', url: 'https://footlocker.com' }] })],
    [brands('openai', ['Foot Locker'])],
  );
  assert.strictEqual(c.name, 'Foot Locker');
  assert.ok(c.aliases.includes('Foot Locker'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
