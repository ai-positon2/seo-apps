// ── Scoring, over rows rather than over the network ─────────────────────────
//
// Every number a client sees comes from here, so the denominators are what this
// tests. The demo run made the failure mode concrete: 5 prompts attempted, 1
// provider 500, 2 mentions. Scoring out of 5 gives 40; out of 4 gives 50. The
// first folds a provider outage into the client's visibility.
//
// Run: node modules/aiVisibility/__tests__/scoring.test.js

const assert = require('assert');
const scoring = require('../scoring');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const BRAND = { name: 'Gentle Dental', domain: 'gentledental.com' };

/** A capture row, defaulting to the measured-and-absent case. */
const row = (over = {}) => ({
  prompt: 'p', surfaceLabel: 'ChatGPT (consumer UI · DataForSEO LLM Scraper)',
  status: 'captured', mentioned: false, cited: false, prominence: null,
  competitorsMentioned: [], citations: [], taskCost: 0.004, ...over,
});

// The demo run, exactly as it came back.
const DEMO = [
  row({ status: 'failed', mentioned: null, cited: null, competitorsMentioned: null,
        failureReason: 'DataForSEO HTTP 500 Internal Server Error', taskCost: null }),
  row({ competitorsMentioned: ['Dental Associates'],
        citations: [{ domain: 'dental.tufts.edu' }, { domain: 'bu.edu' }] }),
  row({ mentioned: true, competitorsMentioned: ['Aspen Dental'],
        citations: [{ domain: 'aspendental.com' }, { domain: 'consumeraffairs.com' }] }),
  row({ mentioned: true, cited: true, competitorsMentioned: ['Aspen Dental'],
        citations: [{ domain: 'gentledental.com' }, { domain: 'aspendental.com' }] }),
  row({ competitorsMentioned: ['Dental Associates'], citations: [{ domain: 'dentillo.com' }] }),
];

// ── The denominator ─────────────────────────────────────────────────────────

section('the denominator is measured prompts, not attempted ones');

test('the demo run scores 50, not 40', () => {
  // 2 named of 4 measured. Out of 5 attempted it would be 40, which would blame
  // the client for a provider outage.
  assert.strictEqual(scoring.score(DEMO), 50);
});

test('nothing measured is null, not zero', () => {
  const allFailed = [row({ status: 'failed', mentioned: null })];
  assert.strictEqual(scoring.score(allFailed), null);
  assert.notStrictEqual(scoring.score(allFailed), 0);
  assert.strictEqual(scoring.score([]), null);
});

test('measured everywhere and named nowhere really is 0', () => {
  assert.strictEqual(scoring.score([row(), row()]), 0);
});

// ── The basis ───────────────────────────────────────────────────────────────

section('the score carries its basis');

test('the basis names the denominator and the excluded prompts', () => {
  const basis = scoring.scoreBasis(DEMO);
  assert.match(basis, /2 of 4/, 'the reader must see the denominator');
  assert.match(basis, /1 prompt\(s\) could not be measured/, 'and what was left out');
});

test('the basis names the surface, so two surfaces are not conflated', () => {
  assert.match(scoring.scoreBasis(DEMO), /ChatGPT/);
});

test('no basis when there is no score', () => {
  assert.strictEqual(scoring.scoreBasis([]), null);
});

// ── Share of voice ──────────────────────────────────────────────────────────

section('share of voice');

test('the brand and its rivals are counted over measured prompts', () => {
  const sov = scoring.shareOfVoice(DEMO, BRAND.name);
  const brand = sov.find((s) => s.isBrand);
  assert.strictEqual(brand.prompts, 2);
  assert.strictEqual(brand.share, 50);
  assert.strictEqual(sov.find((s) => s.name === 'Aspen Dental').prompts, 2);
});

test('a name repeated inside one answer is still one prompt', () => {
  // Prompt count, not mention count: six repetitions in one answer is not six
  // times the visibility.
  const rows = [row({ mentioned: true, competitorsMentioned: ['Aspen Dental'] })];
  assert.strictEqual(scoring.shareOfVoice(rows, BRAND.name).find((s) => s.name === 'Aspen Dental').prompts, 1);
});

test('failed prompts do not dilute anyone', () => {
  const withFailure = [...DEMO, row({ status: 'failed', mentioned: null, competitorsMentioned: null })];
  assert.strictEqual(scoring.shareOfVoice(withFailure, BRAND.name).find((s) => s.isBrand).share, 50);
});

// ── Cited domains ───────────────────────────────────────────────────────────

section('who gets cited instead');

test('domains rank by how many prompts they appear on', () => {
  const cited = scoring.citedDomains(DEMO, BRAND.domain);
  assert.strictEqual(cited[0].domain, 'aspendental.com');
  assert.strictEqual(cited[0].prompts, 2);
});

test('the brand’s own domain is flagged rather than hidden', () => {
  const mine = scoring.citedDomains(DEMO, BRAND.domain).find((d) => d.domain === 'gentledental.com');
  assert.strictEqual(mine.isBrand, true);
});

test('an unresolved citation is not evidence about anybody', () => {
  // A google.com redirect that failed to resolve has domain null. Counting it
  // would invent a source.
  const rows = [row({ citations: [{ domain: null, redirect: true, resolved: false }] })];
  assert.deepStrictEqual(scoring.citedDomains(rows, BRAND.domain), []);
});

// ── Findings ────────────────────────────────────────────────────────────────

section('findings');

test('absence from measured prompts is an error-level finding', () => {
  const f = scoring.findings(DEMO, { brandName: BRAND.name, brandDomain: BRAND.domain });
  const absent = f.find((x) => x.ruleId === 'aiv-absent');
  assert.strictEqual(absent.severity, 'error');
  assert.strictEqual(absent.count, 2);
});

test('named-without-a-link is its own finding', () => {
  const f = scoring.findings(DEMO, { brandName: BRAND.name, brandDomain: BRAND.domain });
  assert.ok(f.find((x) => x.ruleId === 'aiv-mentioned-not-cited'));
});

test('a run with nothing measured produces no findings at all', () => {
  // Rather than a confident "absent from 0 prompts".
  assert.deepStrictEqual(scoring.findings([row({ status: 'failed', mentioned: null })], {}), []);
});

// ── The whole summary ───────────────────────────────────────────────────────

section('summary');

test('promptsCiting is unknown when any citation went unresolved', () => {
  const rows = [row({ mentioned: true, cited: null }), row({ mentioned: true, cited: true })];
  assert.strictEqual(scoring.summarise(rows, BRAND).promptsCiting, null);
});

test('the summary reports coverage and spend', () => {
  const s = scoring.summarise(DEMO, BRAND);
  assert.strictEqual(s.coverage.measured, 4);
  assert.strictEqual(s.coverage.failed, 1);
  assert.ok(s.spend > 0);
  assert.strictEqual(s.score, 50);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
