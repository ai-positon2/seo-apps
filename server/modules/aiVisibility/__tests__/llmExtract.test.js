// ── llmExtract ────────────────────────────────────────────────────────────
//
// The anti-hallucination guard is the reason this file exists. A model asked
// about brands will invent plausible ones, and an invented competitor would
// corrupt share of voice permanently — so the discard path is pinned hardest.
//
// Every test injects a transport. Nothing here makes a network call.
//
// Run: node modules/aiVisibility/__tests__/llmExtract.test.js

const assert = require('assert');
const llm = require('../captureEngines/llmExtract');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const ANSWER = 'For implants, Gentle Dental is widely recommended in Boston. '
  + 'Aspen Dental also has locations nearby, though reviews are mixed.';

const MENTIONS = [
  {
    brandId: 'b1', name: 'Gentle Dental', isClient: true, ordinal: 1, mentionCount: 1, evidence: 'Gentle Dental is widely recommended',
  },
  {
    brandId: 'b2', name: 'Aspen Dental', isClient: false, ordinal: 2, mentionCount: 1, evidence: 'Aspen Dental also has locations',
  },
];

/** A transport that replies with whatever object the test hands it. */
const replies = (obj) => async () => ({ parsed: obj, attempts: 1 });

(async () => {
  section('evidenceIsReal — the guard');

  await test('a verbatim quote passes', () => {
    assert.strictEqual(llm.evidenceIsReal('Gentle Dental is widely recommended', ANSWER), true);
  });

  await test('an invented clause is rejected', () => {
    assert.strictEqual(llm.evidenceIsReal('Gentle Dental is the top-rated practice in Massachusetts', ANSWER), false);
  });

  await test('curly-vs-straight quotes and collapsed whitespace still pass', () => {
    const src = 'We recommend O’Malley Dental — the best in town.';
    assert.strictEqual(
      llm.evidenceIsReal("recommend O'Malley Dental - the best", src), true,
      'a faithful re-type with different punctuation must not be discarded',
    );
  });

  await test('a quote too short to prove anything is rejected', () => {
    assert.strictEqual(llm.evidenceIsReal('Boston', ANSWER), false);
    assert.strictEqual(llm.evidenceIsReal('', ANSWER), false);
    assert.strictEqual(llm.evidenceIsReal(null, ANSWER), false);
  });

  section('scoreMentions — merging scores onto deterministic mentions');

  await test('scores land on the matching mention', async () => {
    const r = await llm.scoreMentions({
      answerText: ANSWER,
      mentions: MENTIONS,
      transport: replies({
        brands: [
          {
            name: 'Gentle Dental', sentiment: 75, negated: false, recommended: true, evidence: 'Gentle Dental is widely recommended in Boston',
          },
          {
            name: 'Aspen Dental', sentiment: 45, negated: false, recommended: false, evidence: 'Aspen Dental also has locations nearby',
          },
        ],
        off_topic_geo: false,
        answer_is_refusal: false,
      }),
    });
    assert.strictEqual(r.mentions.length, 2);
    assert.strictEqual(r.mentions[0].sentiment, 75);
    assert.strictEqual(r.mentions[1].sentiment, 45);
    assert.strictEqual(r.error, null);
  });

  await test('a hallucinated brand is DISCARDED, not proposed', async () => {
    const r = await llm.scoreMentions({
      answerText: ANSWER,
      mentions: MENTIONS,
      transport: replies({
        brands: [
          { name: 'Gentle Dental', sentiment: 70, evidence: 'Gentle Dental is widely recommended' },
          { name: 'Cambridge Smile Studio', sentiment: 80, evidence: 'Cambridge Smile Studio is also excellent' },
        ],
      }),
    });
    assert.deepStrictEqual(r.proposed, [], 'an unquotable brand must never reach the review queue');
  });

  await test('a real brand the alias set missed IS proposed, but never auto-measured', async () => {
    const r = await llm.scoreMentions({
      answerText: ANSWER,
      mentions: [MENTIONS[0]],
      transport: replies({
        brands: [
          { name: 'Gentle Dental', sentiment: 70, evidence: 'Gentle Dental is widely recommended' },
          { name: 'Aspen Dental', sentiment: 45, evidence: 'Aspen Dental also has locations nearby' },
        ],
      }),
    });
    assert.strictEqual(r.mentions.length, 1, 'the measured set is unchanged — §3.4 keeps the denominator stable');
    assert.deepStrictEqual(r.proposed.map((p) => p.name), ['Aspen Dental']);
  });

  await test('a mention the model ignored keeps sentiment null, not 50', async () => {
    const r = await llm.scoreMentions({
      answerText: ANSWER,
      mentions: MENTIONS,
      transport: replies({ brands: [{ name: 'Gentle Dental', sentiment: 70, evidence: 'Gentle Dental is widely recommended' }] }),
    });
    const aspen = r.mentions.find((m) => m.brandId === 'b2');
    assert.strictEqual(aspen.sentiment, null, '"not scored" is not "neutral" — §3.6 would read 50 as a verdict');
  });

  await test('negation, off-geo and refusal flags come through', async () => {
    const r = await llm.scoreMentions({
      answerText: ANSWER,
      mentions: [MENTIONS[0]],
      transport: replies({
        brands: [{
          name: 'Gentle Dental', sentiment: 15, negated: true, evidence: 'Gentle Dental is widely recommended',
        }],
        off_topic_geo: true,
        answer_is_refusal: true,
      }),
    });
    assert.strictEqual(r.mentions[0].negated, true);
    assert.strictEqual(r.offGeo, true);
    assert.strictEqual(r.refusal, true);
  });

  section('scoreMentions — never throws, never drops a mention');

  await test('a transport failure returns every mention unscored rather than losing it', async () => {
    const r = await llm.scoreMentions({
      answerText: ANSWER,
      mentions: MENTIONS,
      transport: async () => { throw new Error('rate limited'); },
    });
    assert.strictEqual(r.error, 'rate limited');
    assert.strictEqual(r.mentions.length, 2, 'a failed score must not delete a measured mention');
    assert.ok(r.mentions.every((m) => m.sentiment === null));
  });

  await test('a malformed reply degrades instead of crashing', async () => {
    const r = await llm.scoreMentions({
      answerText: ANSWER,
      mentions: MENTIONS,
      transport: async () => ({ parsed: { brands: [null, { name: '' }, { sentiment: 9 }] }, attempts: 1 }),
    });
    assert.strictEqual(r.error, null);
    assert.ok(r.mentions.every((m) => m.sentiment === null));
  });

  await test('an empty answer is reported, not sent to the model', async () => {
    let called = false;
    const r = await llm.scoreMentions({
      answerText: '   ', mentions: MENTIONS, transport: async () => { called = true; },
    });
    assert.strictEqual(r.error, 'no_answer_text');
    assert.strictEqual(called, false, 'no spend on an answer that does not exist');
  });

  await test('with no API key and no transport, nothing is called and nothing throws', async () => {
    assert.strictEqual(llm.hasKey(), false, 'this test assumes no ANTHROPIC_API_KEY is configured');
    const r = await llm.scoreMentions({ answerText: ANSWER, mentions: MENTIONS });
    assert.strictEqual(r.error, 'no_api_key');
    assert.strictEqual(r.calls, 0);
    assert.strictEqual(r.mentions.length, 2);
  });

  section('clampSentiment — a score out of range is a bug, not a crash');

  await test('out-of-range values are clamped and non-numbers become null', () => {
    assert.strictEqual(llm.clampSentiment(120), 100);
    assert.strictEqual(llm.clampSentiment(-5), 0);
    assert.strictEqual(llm.clampSentiment(62.4), 62);
    assert.strictEqual(llm.clampSentiment('high'), null);
    assert.strictEqual(llm.clampSentiment(null), null);
  });

  section('the rubric the metric depends on is stated in the prompt');

  await test('the "a bare listing is 50, not 60" rule is in the system prompt', () => {
    assert.match(
      llm.SYSTEM_PROMPT, /is 50\. Not 60/,
      'without this the model scores every directory listing as positive',
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
