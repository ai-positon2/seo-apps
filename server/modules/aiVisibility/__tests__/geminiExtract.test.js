// ── geminiExtract ─────────────────────────────────────────────────────────
//
// Fixtures are real strings from live guest-session recon runs.
//
// Run: node modules/aiVisibility/__tests__/geminiExtract.test.js

const assert = require('assert');
const g = require('../captureEngines/geminiExtract');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const LIVE = `About Gemini
Get Gemini App
Subscriptions
For Business
Sign in
Conversation with Gemini
You said best dental implant providers in boston

best dental implant providers in boston

Gemini said

When looking for top-tier dental implant providers in the Boston area, consider
practices that combine multi-specialty expertise.
American Dental Association + 1
Report legal issue
View sources
See response details
Flash-Lite
Gemini is AI and can make mistakes.
Searching the web`;

section('answerFromMainText');

test('returns the reply after "Gemini said"', () => {
  assert.match(g.answerFromMainText(LIVE), /top-tier dental implant providers/);
});

test('strips Gemini chrome and the model chip', () => {
  const a = g.answerFromMainText(LIVE);
  assert.ok(!/About Gemini/.test(a));
  assert.ok(!/View sources/.test(a));
  assert.ok(!/Flash-Lite/.test(a), 'the model chip is metadata, not answer text');
  assert.ok(!/Gemini is AI and can make mistakes/.test(a));
});

test('no reply yields null, not an empty string', () => {
  assert.strictEqual(g.answerFromMainText('About Gemini\nSign in'), null);
  assert.strictEqual(g.answerFromMainText(''), null);
});

section('modelFromText — guests get a reduced tier, and the row must say so');

test('reads the served model off the UI chip', () => {
  assert.strictEqual(g.modelFromText(LIVE), 'Flash-Lite');
});

test('null when no model is shown, rather than a guess', () => {
  assert.strictEqual(g.modelFromText('Gemini said\nhello'), null);
});

section('didSearchWeb');

test('detects the browsing disclosure', () => {
  assert.strictEqual(g.didSearchWeb(LIVE), true);
  assert.strictEqual(g.didSearchWeb('Gemini said\njust an answer'), false);
});

section('citationsFromChips — publisher names, not favicon domains');

test('parses "<Publisher> + N" and counts the collapsed extras', () => {
  const c = g.citationsFromChips(['American Dental Association + 1'], []);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].title, 'American Dental Association');
  assert.strictEqual(c[0].occurrences, 2, '"+ 1" means one more source behind the chip');
});

test('an unresolvable publisher name leaves domain null rather than inventing one', () => {
  const [c] = g.citationsFromChips(['American Dental Association + 1'], []);
  assert.strictEqual(c.domain, null);
  assert.strictEqual(c.host, null);
});

test('a chip that IS a host resolves itself', () => {
  const [c] = g.citationsFromChips(['www.heart.org + 2'], []);
  assert.strictEqual(c.host, 'www.heart.org');
  assert.strictEqual(c.domain, 'heart.org');
  assert.strictEqual(c.occurrences, 3);
});

test('real anchors no chip claimed are still recorded, flagged not-inline', () => {
  const c = g.citationsFromChips([], ['https://bostonimplantcenter.com/services']);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].domain, 'bostonimplantcenter.com');
  assert.strictEqual(c[0].isInlineCited, false);
});

test('Gemini\'s own links are not treated as sources', () => {
  const c = g.citationsFromChips([], ['https://gemini.google.com/app', 'https://www.google.com/intl/en/about']);
  assert.deepStrictEqual(c, []);
});

section('blockReason');

test('detects the Google captcha wall and the /sorry redirect', () => {
  assert.strictEqual(g.blockReason({ mainText: 'Our systems have detected unusual traffic' }), 'google_captcha');
  assert.strictEqual(g.blockReason({ url: 'https://www.google.com/sorry/index?continue=x' }), 'google_captcha');
});

test('detects a sign-in wall', () => {
  assert.strictEqual(g.blockReason({ mainText: 'Sign in to continue' }), 'signin_required');
});

test('a healthy answer is not a block', () => {
  assert.strictEqual(g.blockReason({ mainText: LIVE, url: 'https://gemini.google.com/app/abc' }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
