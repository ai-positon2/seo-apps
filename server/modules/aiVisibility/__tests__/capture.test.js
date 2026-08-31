// ── The honesty rule, and the reading that depends on it ─────────────────────
//
// The first section is the reason this module has a test at all: a failed
// capture must never read as "the brand is not mentioned". Everything else here
// is the brand/citation matching that decides what a client is told.
//
// Run: node modules/aiVisibility/__tests__/capture.test.js

const assert = require('assert');
const capture = require('../capture');
const { SURFACES } = require('../surfaces');

let passed = 0, failed = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const section = (name) => queue.push({ section: name });

const BRAND = { name: 'Gentle Dental', aliases: ['GentleDental'], domain: 'gentledental.com' };
const COMPETITORS = [
  { name: 'Aspen Dental' },
  { name: 'Western Dental', aliases: ['Western Dental & Orthodontics'] },
];

/** Install a fake surface so nothing here touches the network or spends money. */
function withSurface(id, impl) {
  SURFACES[id] = { ENGINE: 'fake', PROVIDER: 'test', LABEL: 'Fake surface', capture: impl };
  return () => { delete SURFACES[id]; };
}

// ── The rule ────────────────────────────────────────────────────────────────

section('a failed capture is never an absence');

test('a provider that throws leaves mentioned null, not false', async () => {
  const undo = withSurface('x:boom', async () => { throw new Error('DataForSEO task 40402: out of credit'); });
  const row = await capture.measure({ surfaceId: 'x:boom', prompt: 'best dentist', brand: BRAND });
  undo();

  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.mentioned, null, 'a broken pipeline must not read as an absent brand');
  assert.notStrictEqual(row.mentioned, false);
  assert.strictEqual(row.cited, null);
  assert.match(row.failureReason, /out of credit/, 'the reason has to survive, so coverage can explain itself');
});

test('an unknown surface id fails rather than silently measuring nothing', async () => {
  const row = await capture.measure({ surfaceId: 'nope:nope', prompt: 'x', brand: BRAND });
  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.mentioned, null);
});

test('a truncated answer is a failure, not a brand that went missing', async () => {
  // A few characters back from a stream that died. Scanning it for the brand
  // and recording false would be the exact silent lie this module guards.
  const undo = withSurface('x:trunc', async () => ({ answerText: 'Sorry,', citations: [], taskCost: 0.02 }));
  const row = await capture.measure({ surfaceId: 'x:trunc', prompt: 'best dentist', brand: BRAND });
  undo();

  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.mentioned, null);
  assert.match(row.failureReason, /characters/);
});

test('a surface that ran and found no AI answer IS measured', async () => {
  // Distinct from failure: plenty of queries have no AI Overview. The surface
  // worked, so the brand is genuinely not mentioned — there is nothing to be
  // mentioned in.
  const undo = withSurface('x:empty', async () => ({ answerText: null, citations: [], taskCost: 0.01 }));
  const row = await capture.measure({ surfaceId: 'x:empty', prompt: 'best dentist', brand: BRAND });
  undo();

  assert.strictEqual(row.status, 'no_answer');
  assert.strictEqual(row.mentioned, false, 'no answer means genuinely not mentioned');
  assert.notStrictEqual(row.mentioned, null);
});

// ── Coverage ────────────────────────────────────────────────────────────────

section('an empty answer: absence on a SERP, failure on a chat engine');

test('an empty answer from a CHAT surface is a failure, never an absence', async () => {
  const undo = withSurface('x:chat', async () => ({
    engine: 'fake', provider: 'test', surfaceLabel: 'Fake chat', access: 'scraped',
    answerText: '', citations: [], webQueries: [], capturedAt: new Date().toISOString(), raw: {},
  }));
  SURFACES['x:chat'].ALWAYS_ANSWERS = true;
  const row = await capture.measure({ surfaceId: 'x:chat', prompt: 'best dentist', brand: BRAND });
  undo();

  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.mentioned, null,
    'measured against real rate limiting: six consecutive empty Gemini captures, which as '
    + 'false would be six absences the engine never asserted');
  assert.match(row.failureReason, /empty answer/);
});

test('an empty answer from a SERP surface IS a measured absence', async () => {
  const undo = withSurface('x:serp', async () => ({
    engine: 'fake', provider: 'test', surfaceLabel: 'Fake SERP', access: 'scraped',
    answerText: '', citations: [], webQueries: [], capturedAt: new Date().toISOString(), raw: {},
  }));
  const row = await capture.measure({ surfaceId: 'x:serp', prompt: 'best dentist', brand: BRAND });
  undo();

  assert.strictEqual(row.status, 'no_answer');
  assert.strictEqual(row.mentioned, false,
    'plenty of queries genuinely have no AI Overview — there is nothing to be named in');
});

section('coverage counts what was measured, not what was attempted');

test('failures are excluded from the measured count and named', () => {
  const rows = [
    { status: 'captured', mentioned: true, failureReason: null },
    { status: 'captured', mentioned: false, failureReason: null },
    { status: 'failed', mentioned: null, failureReason: 'timeout' },
    { status: 'failed', mentioned: null, failureReason: 'timeout' },
    { status: 'no_answer', mentioned: false, failureReason: null },
  ];
  const c = capture.coverageOf(rows);
  assert.strictEqual(c.total, 5);
  assert.strictEqual(c.measured, 3, 'the two failures are not measurements');
  assert.strictEqual(c.failed, 2);
  assert.deepStrictEqual(c.failureReasons, [{ reason: 'timeout', count: 2 }]);
});

test('a run that measured nothing has a null rate, not zero', () => {
  const c = capture.coverageOf([]);
  assert.strictEqual(c.rate, null);
  assert.notStrictEqual(c.rate, 0);
});

// ── Brand matching ──────────────────────────────────────────────────────────

section('naming the brand');

test('a plain mention counts', () => {
  assert.ok(capture.namesBrand('I would recommend Gentle Dental in Boston.', ['Gentle Dental']));
});

test('matching is case-insensitive and survives punctuation', () => {
  assert.ok(capture.namesBrand('Try **gentle dental**, they are good.', ['Gentle Dental']));
  assert.ok(capture.namesBrand('Options: Gentle Dental, Aspen.', ['Gentle Dental']));
});

test('a brand name inside a longer word does not count', () => {
  // The failure this guards: a two- or three-letter brand matching everywhere.
  assert.strictEqual(capture.namesBrand('The dentalcare industry', ['Dental']), false);
  assert.strictEqual(capture.namesBrand('supergentle', ['gentle']), false);
});

test('aliases count', () => {
  assert.ok(capture.namesBrand('GentleDental has locations', ['Gentle Dental', 'GentleDental']));
});

test('an empty or missing name never matches everything', () => {
  assert.strictEqual(capture.namesBrand('any text at all', ['']), false);
  assert.strictEqual(capture.namesBrand('any text at all', [null, undefined]), false);
  assert.strictEqual(capture.namesBrand('', ['Gentle Dental']), false);
});

// ── Citation matching ───────────────────────────────────────────────────────

section('citing the domain');

test('the brand domain is found regardless of www', () => {
  assert.ok(capture.citesDomain([{ domain: 'gentledental.com' }], 'gentledental.com'));
  assert.ok(capture.citesDomain([{ domain: 'gentledental.com' }], 'www.gentledental.com'));
});

test('a subdomain of the brand still counts as the brand', () => {
  assert.ok(capture.citesDomain([{ domain: 'blog.gentledental.com' }], 'gentledental.com'));
});

test('a domain that merely ends with the brand does not', () => {
  // notgentledental.com is a different company.
  assert.strictEqual(capture.citesDomain([{ domain: 'notgentledental.com' }], 'gentledental.com'), false);
});

test('no citations is not a citation', () => {
  assert.strictEqual(capture.citesDomain([], 'gentledental.com'), false);
  assert.strictEqual(capture.citesDomain([{ domain: 'aspendental.com' }], 'gentledental.com'), false);
});


test('an unresolved citation makes cited unknown, not false', () => {
  // Google AI Overview citations are google.com/goto redirects resolved at
  // capture time, and resolution can partially fail. With one citation still
  // unresolved, "not cited" is not something we know — the brand could be that
  // one. Answering false would tell a client their domain is never cited on a
  // claim we have not earned.
  const partial = [{ domain: 'mayoclinic.org' }, { domain: null, redirect: true, resolved: false }];
  assert.strictEqual(capture.citesDomain(partial, 'gentledental.com'), null);
});

test('an unresolved citation does not mask a brand that IS cited', () => {
  const partial = [{ domain: 'gentledental.com' }, { domain: null, redirect: true, resolved: false }];
  assert.strictEqual(capture.citesDomain(partial, 'gentledental.com'), true);
});

test('fully resolved and absent is a real false', () => {
  const all = [{ domain: 'mayoclinic.org' }, { domain: 'colgate.com' }];
  assert.strictEqual(capture.citesDomain(all, 'gentledental.com'), false);
});
// ── Prominence ──────────────────────────────────────────────────────────────

section('where in the answer');

test('an opening mention scores near 0, a closing one near 1', () => {
  const opening = capture.prominenceOf(`Gentle Dental ${'x'.repeat(400)}`, ['Gentle Dental']);
  const closing = capture.prominenceOf(`${'x'.repeat(400)} Gentle Dental`, ['Gentle Dental']);
  assert.ok(opening < 0.1, `expected near 0, got ${opening}`);
  assert.ok(closing > 0.9, `expected near 1, got ${closing}`);
});

test('not mentioned is null, not 1', () => {
  // 1 would read as "mentioned, right at the end" — an absence quietly promoted
  // to a weak presence.
  assert.strictEqual(capture.prominenceOf('No relevant brands here.', ['Gentle Dental']), null);
});

// ── Competitors ─────────────────────────────────────────────────────────────

section('share of voice inputs');

test('only competitors actually named are returned', () => {
  const text = 'Consider Aspen Dental or a local practice.';
  assert.deepStrictEqual(capture.competitorsNamed(text, COMPETITORS), ['Aspen Dental']);
});

test('a competitor alias counts for that competitor', () => {
  const text = 'Western Dental & Orthodontics has many offices.';
  assert.deepStrictEqual(capture.competitorsNamed(text, COMPETITORS), ['Western Dental']);
});

test('no competitors configured is an empty list, never a throw', () => {
  assert.deepStrictEqual(capture.competitorsNamed('anything', undefined), []);
});

// ── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  for (const item of queue) {
    if (item.section) { console.log(`\n${item.section}`); continue; }
    try {
      await item.fn();
      passed += 1;
      console.log(`  ✓ ${item.name}`);
    } catch (e) {
      failed += 1;
      console.error(`  ✗ ${item.name}\n    ${e.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
