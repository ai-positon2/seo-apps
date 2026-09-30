// ── Seed keyword from an article topic ───────────────────────────────────────
//
// Content Architect sends Keyword Research a title, not a keyword; the stream
// turns it into a head keyword first. A fake OpenAI client stands in for the
// model so the accept/reject rules and the fallback can be checked offline.
//
// Run: node services/__tests__/topicSeed.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { seedFromTopic, seedFromTopicFallback, cleanSeed } = require('../topicSeed');

function fakeOpenAI(reply) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (req) => {
          calls.push(req);
          if (reply instanceof Error) throw reply;
          return { choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] };
        },
      },
    },
  };
}

const quiet = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

test('the fallback drops the subtitle, title words and numbers', () => {
  assert.equal(seedFromTopicFallback('How to Choose a Managed IT Provider: A Complete Guide'), 'choose managed it provider');
  assert.equal(seedFromTopicFallback('10 Best Forklifts for the Chemical Industry in 2026'), 'forklifts chemical industry');
  assert.equal(seedFromTopicFallback('Dental Implants – What to Expect'), 'dental implants');
  assert.equal(seedFromTopicFallback('A Guide'), 'a guide', 'all stop words: the head is kept rather than emptied');
  assert.equal(seedFromTopicFallback(''), '');
  assert.ok(seedFromTopicFallback('one two three four five six seven eight').split(' ').length <= 5);
});

test('model answers are accepted only when they look like a search query', () => {
  assert.equal(cleanSeed('  "Managed IT Provider" '), 'managed it provider');
  assert.equal(cleanSeed(''), '');
  assert.equal(cleanSeed('this is far too long to be a head keyword anyone types'), '');
  assert.equal(cleanSeed(42), '');
});

test('uses the model keyword, and sends the topic and intent', async () => {
  const openai = fakeOpenAI({ keyword: 'Managed IT Provider' });
  const out = await seedFromTopic(openai, 'How to Choose a Managed IT Provider', 'informational');
  assert.deepEqual(out, { keyword: 'managed it provider', source: 'model' });
  const prompt = openai.calls[0].messages[1].content;
  assert.match(prompt, /How to Choose a Managed IT Provider/);
  assert.match(prompt, /informational/);
});

test('falls back when the model errors, returns junk, or returns nothing usable', async () => {
  const topic = 'Dental Implants: Costs and Recovery';
  for (const reply of [new Error('rate limited'), 'not json', { keyword: '' }, { other: 'x' }]) {
    const out = await quiet(() => seedFromTopic(fakeOpenAI(reply), topic, 'commercial'));
    assert.deepEqual(out, { keyword: 'dental implants', source: 'fallback' }, `reply: ${String(reply?.message || JSON.stringify(reply))}`);
  }
});
