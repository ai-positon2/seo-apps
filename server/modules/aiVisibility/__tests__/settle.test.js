// ── settle ────────────────────────────────────────────────────────────────
//
// These fixtures are the REAL pages from the incident of 30 Aug 2026, copied
// out of the `raw` column of the captures that failed. 10 of 92 scraped
// captures were recorded as "empty answer — most likely rate limited"; none of
// them was rate limited. The page had simply never received the question, and
// the old settle loop — which watched `document.body.innerText.length` — read
// a perfectly still page as a finished answer and reported success.
//
// The assertion that matters most in this file is that the landing page never
// settles. Everything else follows from it.
//
// Run: node modules/aiVisibility/__tests__/settle.test.js

const assert = require('assert');
const settle = require('../captureEngines/settle');
const chatgpt = require('../captureEngines/chatgptExtract');
const gemini = require('../captureEngines/geminiExtract');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

// Verbatim from a failed capture's raw.mainText.
const CHATGPT_LANDING = [
  'New chat', 'Search chats', 'Images', 'Plugins', 'Deep research',
  'See plans and pricing', 'Settings', 'Help', 'Get responses tailored to you',
  'Log in to get answers based on saved chats',
].join('\n');

const GEMINI_TRUNCATED = [
  'About Gemini', 'Get Gemini App', 'Subscriptions', 'For Business', 'Sign in',
  'Conversation with Gemini', 'You said dentist in boston newbury st',
  'dentist in boston newbury st', 'Gem',
].join('\n');

const CHATGPT_ANSWER = [
  'You said:', 'best dentist boston', 'ChatGPT said:',
  'Here are some well-reviewed dental practices in Boston.',
].join('\n');

/** A page whose answer never changes, however long you look at it. */
const staticAnswer = (text) => () => Promise.resolve(text);

(async () => {

section('the bug: a still page is not a finished answer');

await test('the real ChatGPT landing page NEVER settles', async () => {
  // This is the whole incident in one assertion. The page is motionless, so
  // the old loop called it done in 10s and harvested nothing.
  const r = await settle.settleOnAnswer({
    page: null,
    readAnswer: staticAnswer(chatgpt.answerFromMainText(CHATGPT_LANDING)),
    maxWaitMs: 120,
    pollMs: 20,
    stableTicks: 3,
  });
  assert.strictEqual(r.answerText, null, 'there is no answer on that page');
  assert.strictEqual(r.sawAnswer, false);
  assert.strictEqual(r.timedOut, true,
    'a page with no answer must run to the deadline and SAY it timed out — '
    + 'reporting success here is what recorded 10 captures as rate limited');
});

await test('the real truncated Gemini page NEVER settles', async () => {
  // Here the question WAS submitted — the echo is present — but the reply had
  // not rendered. Settling on it harvested an empty answer from a live capture.
  assert.strictEqual(gemini.answerFromMainText(GEMINI_TRUNCATED), null);
  const r = await settle.settleOnAnswer({
    page: null,
    readAnswer: staticAnswer(gemini.answerFromMainText(GEMINI_TRUNCATED)),
    maxWaitMs: 120,
    pollMs: 20,
    stableTicks: 3,
  });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.sawAnswer, false);
});

await test('an empty string is treated exactly like null', async () => {
  const r = await settle.settleOnAnswer({
    page: null, readAnswer: staticAnswer(''), maxWaitMs: 100, pollMs: 20, stableTicks: 3,
  });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.answerText, null);
});

section('the happy path still works');

await test('a real answer that stops growing settles, and is not timed out', async () => {
  const r = await settle.settleOnAnswer({
    page: null,
    readAnswer: staticAnswer(chatgpt.answerFromMainText(CHATGPT_ANSWER)),
    maxWaitMs: 5_000,
    pollMs: 10,
    stableTicks: 3,
  });
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(r.sawAnswer, true);
  assert.match(r.answerText, /well-reviewed dental practices/);
});

await test('a growing answer is waited out, and the LAST version is kept', async () => {
  // Settling early would truncate a streaming answer mid-sentence, which reads
  // as a shorter answer rather than as a failure — the quiet kind of wrong.
  const chunks = ['Bos', 'Boston has', 'Boston has many', 'Boston has many dentists'];
  let i = 0;
  const r = await settle.settleOnAnswer({
    page: null,
    readAnswer: () => Promise.resolve(chunks[Math.min(i++, chunks.length - 1)]),
    maxWaitMs: 5_000,
    pollMs: 5,
    stableTicks: 3,
  });
  assert.strictEqual(r.answerText, 'Boston has many dentists');
  assert.strictEqual(r.timedOut, false);
});

await test('an answer that appears late still settles', async () => {
  // The Gemini case: nothing for a while, then a reply. The old loop would
  // have declared victory during the silence.
  let calls = 0;
  const r = await settle.settleOnAnswer({
    page: null,
    readAnswer: () => { calls += 1; return Promise.resolve(calls > 4 ? 'a real answer' : null); },
    maxWaitMs: 5_000,
    pollMs: 5,
    stableTicks: 3,
  });
  assert.strictEqual(r.answerText, 'a real answer');
  assert.strictEqual(r.timedOut, false);
});

await test('a throwing reader does not settle and does not crash', async () => {
  const r = await settle.settleOnAnswer({
    page: null,
    readAnswer: () => Promise.reject(new Error('page closed')),
    maxWaitMs: 100, pollMs: 20, stableTicks: 3,
  });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.answerText, null);
});

section('waitForEcho — proof the question was actually asked');

await test('the landing page reports the question was never submitted', async () => {
  const ok = await settle.waitForEcho({
    readEcho: () => Promise.resolve(chatgpt.echoedPromptFromMainText(CHATGPT_LANDING)),
    timeoutMs: 80,
    pollMs: 20,
  });
  assert.strictEqual(ok, false);
});

await test('a page that echoed the question reports submitted', async () => {
  const ok = await settle.waitForEcho({
    readEcho: () => Promise.resolve(chatgpt.echoedPromptFromMainText(CHATGPT_ANSWER)),
    timeoutMs: 200,
    pollMs: 10,
  });
  assert.strictEqual(ok, true);
});

await test('Gemini echoes without a colon and is still detected', async () => {
  // "You said dentist in..." — ChatGPT writes "You said:". Matching only the
  // colon form would make every Gemini capture look unsubmitted.
  const ok = await settle.waitForEcho({
    readEcho: () => Promise.resolve(gemini.echoedPromptFromMainText(GEMINI_TRUNCATED)),
    timeoutMs: 200,
    pollMs: 10,
  });
  assert.strictEqual(ok, true);
});

await test('an echo that arrives late is still caught', async () => {
  let calls = 0;
  const ok = await settle.waitForEcho({
    readEcho: () => { calls += 1; return Promise.resolve(calls > 3 ? 'my question' : null); },
    timeoutMs: 1_000,
    pollMs: 5,
  });
  assert.strictEqual(ok, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
