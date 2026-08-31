// ── brandAliases ──────────────────────────────────────────────────────────
//
// The real case this exists for: competitor "names" in this codebase are
// domain stems ("aspendental"), so matching against them as configured misses
// nearly every real mention and reports competitors as absent.
//
// Run: node modules/aiVisibility/__tests__/brandAliases.test.js

const assert = require('assert');
const b = require('../captureEngines/brandAliases');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

section('stemFromDomain / wordsFromStem');

test('strips scheme, www and TLD', () => {
  assert.strictEqual(b.stemFromDomain('https://www.aspendental.com/'), 'aspendental');
  assert.strictEqual(b.stemFromDomain('gentledental.com'), 'gentledental');
});

test('splits a concatenated stem on a known industry word', () => {
  assert.strictEqual(b.wordsFromStem('aspendental'), 'aspen dental');
  assert.strictEqual(b.wordsFromStem('gentledental'), 'gentle dental');
});

test('refuses to split when there is no confident reading', () => {
  assert.strictEqual(b.wordsFromStem('zocdoc'), null);
});

section('deriveAliases — the domain-stem problem');

test('turns the useless stem "aspendental" into "Aspen Dental"', () => {
  const r = b.deriveAliases({ name: 'aspendental', domain: 'aspendental.com' });
  assert.strictEqual(r.name, 'Aspen Dental');
  assert.strictEqual(r.strength, 'strong');
  assert.match(r.notes.join(' '), /split from the domain stem/);
});

test('keeps a properly configured name rather than overriding it', () => {
  const r = b.deriveAliases({ name: 'Gentle Dental', domain: 'gentledental.com' });
  assert.strictEqual(r.name, 'Gentle Dental');
});

test('includes the de-spaced form, because models write both', () => {
  const r = b.deriveAliases({ name: 'Gentle Dental', domain: 'gentledental.com' });
  assert.ok(r.aliases.includes('GentleDental'));
  assert.ok(r.aliases.includes('Gentle Dental'));
});

test('aliases are longest-first, so the specific form matches before the generic', () => {
  const r = b.deriveAliases({ name: 'Gentle Dental', domain: 'gentledental.com' });
  const lengths = r.aliases.map((a) => a.length);
  assert.deepStrictEqual(lengths, [...lengths].sort((x, y) => y - x));
});

section('observed names — what the models actually say');

test('prefers an observed real name over a useless stem', () => {
  const r = b.deriveAliases({
    name: 'foreondental', domain: 'foreondental.com',
    observed: ['Foreon Dental', 'Foreon Dental', 'Foreon Dental Group'],
  });
  assert.strictEqual(r.name, 'Foreon Dental', 'the most frequently observed spelling wins');
  assert.match(r.notes.join(' '), /what models actually call this brand/);
});

test('observed variants are all kept as match forms', () => {
  const r = b.deriveAliases({
    name: '', domain: 'foreondental.com', observed: ['Foreon Dental', 'Foreon Dental Group'],
  });
  assert.ok(r.aliases.includes('Foreon Dental Group'));
});

section('strength — refusing to match unsafely');

test('a name of only generic industry words is weak, not strong', () => {
  const r = b.deriveAliases({ name: 'Dental Care Group', domain: 'dentalcaregroup.com' });
  assert.strictEqual(r.strength, 'weak');
  assert.match(r.notes.join(' '), /generic industry term/);
});

test('nothing usable at all is reported as none, not guessed at', () => {
  const r = b.deriveAliases({ name: '', domain: '' });
  assert.strictEqual(r.strength, 'none');
  assert.strictEqual(r.name, null);
});

section('deriveMeasuredSet');

const PROJECT = {
  name: 'Gentle Dental',
  primaryDomain: { host: 'www.gentledental.com' },
  competitors: [{ name: 'aspendental', host: 'www.aspendental.com' }],
};

test('marks exactly one brand as the client', () => {
  const set = b.deriveMeasuredSet({ project: PROJECT });
  assert.strictEqual(set.filter((x) => x.isClient).length, 1);
  assert.strictEqual(set.find((x) => x.isClient).name, 'Gentle Dental');
});

test('repairs the competitor stem into a real name', () => {
  const set = b.deriveMeasuredSet({ project: PROJECT });
  const competitor = set.find((x) => !x.isClient);
  assert.strictEqual(competitor.name, 'Aspen Dental');
  assert.strictEqual(competitor.domain, 'aspendental.com');
});

test('domains are normalised so www. never splits one brand into two', () => {
  const set = b.deriveMeasuredSet({ project: PROJECT });
  assert.strictEqual(set.find((x) => x.isClient).domain, 'gentledental.com');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
