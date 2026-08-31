// ── chatgptExtract ────────────────────────────────────────────────────────
//
// Fixtures below are REAL strings captured from six live logged-out runs
// against chatgpt.com, not invented ones — including the map-answer shape
// that would otherwise be read as "brand absent".
//
// Run: node modules/aiVisibility/__tests__/chatgptExtract.test.js

const assert = require('assert');
const x = require('../captureEngines/chatgptExtract');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

// Verbatim from the live local-query run.
const MAP_ANSWER = `New chat
Search chats
Images
Plugins
Deep research
Log in
ChatGPT
You said:

best dentist in boston

ChatGPT said:
Devonshire Dental of Boston
★ 5.0
•
Dentist
Closed
Brito Family Dental
★ 4.9
•
Dental clinic
Closed
Boston Dental
★ 4.9
•
Dentist
Closed
1
3
7
8`;

const PROSE_ANSWER = `Search chats
You said:

what should i look for when choosing a dentist

ChatGPT said:

When choosing a dentist, I'd look at quality, communication, convenience, and transparency rather than just ratings.

Credentials & experience: Check that they're properly licensed.
ChatGPT is AI and can make mistakes.`;

// ── Answer extraction ────────────────────────────────────────────────────

section('answerFromMainText');

test('returns the reply after the last "ChatGPT said:" divider', () => {
  const a = x.answerFromMainText(PROSE_ANSWER);
  assert.match(a, /When choosing a dentist/);
});

test('strips sidebar chrome so it can never be scanned for a brand name', () => {
  const a = x.answerFromMainText(PROSE_ANSWER);
  assert.ok(!/Search chats/.test(a));
  assert.ok(!/ChatGPT is AI and can make mistakes/.test(a));
});

test('returns null (not empty string) when there is no reply — NO_ANSWER vs a real absence', () => {
  assert.strictEqual(x.answerFromMainText('New chat\nWhere should we begin?'), null);
  assert.strictEqual(x.answerFromMainText(''), null);
  assert.strictEqual(x.answerFromMainText(null), null);
});

test('takes the LAST reply, not the first, on a multi-turn page', () => {
  const two = 'You said:\nq1\nChatGPT said:\nfirst reply\nYou said:\nq2\nChatGPT said:\nsecond reply';
  assert.match(x.answerFromMainText(two), /second reply/);
  assert.ok(!/first reply/.test(x.answerFromMainText(two)));
});

section('echoedPromptFromMainText');

test('recovers what the page actually asked, for verification', () => {
  assert.strictEqual(x.echoedPromptFromMainText(MAP_ANSWER), 'best dentist in boston');
});

// ── Map cards — the false-absence guard ──────────────────────────────────

section('mapCardsFromText — local answers are cards, not prose');

test('parses every business card in listed order', () => {
  const cards = x.mapCardsFromText(x.answerFromMainText(MAP_ANSWER));
  assert.strictEqual(cards.length, 3);
  assert.deepStrictEqual(cards.map((c) => c.name), [
    'Devonshire Dental of Boston', 'Brito Family Dental', 'Boston Dental',
  ]);
});

test('card position is the ordinal — what METRICS.md §3.5 actually wants', () => {
  const cards = x.mapCardsFromText(x.answerFromMainText(MAP_ANSWER));
  assert.deepStrictEqual(cards.map((c) => c.position), [1, 2, 3]);
});

test('captures rating, category and status', () => {
  const [first] = x.mapCardsFromText(x.answerFromMainText(MAP_ANSWER));
  assert.strictEqual(first.rating, 5.0);
  assert.strictEqual(first.category, 'Dentist');
  assert.strictEqual(first.status, 'Closed');
});

test('map-marker number clusters are not mistaken for businesses', () => {
  const cards = x.mapCardsFromText(x.answerFromMainText(MAP_ANSWER));
  assert.ok(!cards.some((c) => /^\d+$/.test(c.name)), 'a bare number became a card');
});

test('prose answers yield no cards', () => {
  assert.deepStrictEqual(x.mapCardsFromText(x.answerFromMainText(PROSE_ANSWER)), []);
});

// ── Citations ────────────────────────────────────────────────────────────

section('citationsFromFaviconSrcs — sources are spans, not anchors');

const FAVICONS = [
  'https://www.google.com/s2/favicons?domain=https%3A%2F%2Fwww.ada.org&sz=128',
  'https://www.google.com/s2/favicons?domain=https%3A%2F%2Fprofessional.heart.org&sz=128',
  'https://www.google.com/s2/favicons?domain=https%3A%2F%2Fadanews.ada.org&sz=128',
  'https://www.google.com/s2/favicons?domain=https%3A%2F%2Fwww.ada.org&sz=128', // dupe
];

test('decodes the domain parameter into host and registrable domain', () => {
  const c = x.citationsFromFaviconSrcs(FAVICONS);
  assert.strictEqual(c[0].host, 'www.ada.org');
  assert.strictEqual(c[0].domain, 'ada.org');
});

test('keeps host and domain distinct — adanews.ada.org must not collapse into ada.org', () => {
  const c = x.citationsFromFaviconSrcs(FAVICONS);
  const hosts = c.map((e) => e.host);
  assert.ok(hosts.includes('adanews.ada.org'));
  assert.ok(hosts.includes('www.ada.org'));
});

test('deduplicates repeated sources, preserving first-seen order', () => {
  const c = x.citationsFromFaviconSrcs(FAVICONS);
  assert.strictEqual(c.length, 3);
  assert.deepStrictEqual(c.map((e) => e.index), [0, 1, 2]);
});

test('counts repeat appearances rather than discarding them — a real answer cited ada.org 7×', () => {
  const c = x.citationsFromFaviconSrcs(FAVICONS);
  const ada = c.find((e) => e.host === 'www.ada.org');
  assert.strictEqual(ada.occurrences, 2, 'www.ada.org appears twice in the fixture');
  assert.strictEqual(c.find((e) => e.host === 'adanews.ada.org').occurrences, 1);
});

test('url stays null — full paths are not exposed logged-out, and a guess would be worse', () => {
  assert.strictEqual(x.citationsFromFaviconSrcs(FAVICONS)[0].url, null);
});

test('non-favicon images are ignored', () => {
  assert.deepStrictEqual(x.citationsFromFaviconSrcs(['https://example.com/logo.png']), []);
});

// ── Block detection ──────────────────────────────────────────────────────

section('blockReason — a block is never an absent brand');

test('detects the Cloudflare interstitial', () => {
  assert.strictEqual(x.blockReason({ title: 'Just a moment...' }), 'cloudflare_interstitial');
  assert.strictEqual(x.blockReason({ mainText: 'Verify you are human' }), 'cloudflare_interstitial');
});

test('detects rate limiting', () => {
  assert.strictEqual(x.blockReason({ mainText: 'Too many requests' }), 'blocked_or_rate_limited');
});

test('a healthy answer page is not a block', () => {
  assert.strictEqual(x.blockReason({ mainText: PROSE_ANSWER, title: 'ChatGPT', url: 'https://chatgpt.com/' }), null);
});

// ── Features ─────────────────────────────────────────────────────────────

section('answerFeatures');

test('a map answer is flagged so it is never averaged with prose', () => {
  const f = x.answerFeatures({ answerText: 'x', mapCards: [{ name: 'a' }], citations: [] });
  assert.ok(f.includes('map'));
  assert.ok(!f.includes('prose'));
});

test('citations mean web_search fired', () => {
  const f = x.answerFeatures({ answerText: 'x', mapCards: [], citations: [{ domain: 'ada.org' }] });
  assert.ok(f.includes('web_search'));
  assert.ok(f.includes('prose'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
