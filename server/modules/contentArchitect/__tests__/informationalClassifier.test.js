// ── The model half of informational page selection ───────────────────────────
//
// informationalClassifier.js is the only part of page selection that talks to a
// model. These tests drive it with a stub client shaped like the shared factory's
// (chat.completions.create), so what is asserted is the contract with the model:
// what is sent, how the reply is trusted, and how failure is reported.
//
// Run: node modules/contentArchitect/__tests__/informationalClassifier.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createInformationalClassifier, normalizeCategory, MODEL, TEMPLATE_SYSTEM_PROMPT, URL_SYSTEM_PROMPT,
} = require('../informationalClassifier');
const {
  SELECTION_AI_TIMEOUT_MS, SELECTION_AI_MAX_RETRIES, SELECTION_TEMPLATE_BATCH_SIZE,
  SELECTION_URL_BATCH_SIZE, SELECTION_AI_CONCURRENCY,
} = require('../config');

/**
 * A client whose reply is computed from the request. `reply(payload, listKey)`
 * returns the parsed JSON the "model" answers with; it can throw to simulate a
 * failed call.
 */
function stubClient(reply, { delayMs = 0 } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    calls,
    get maxInFlight() { return maxInFlight; },
    chat: {
      completions: {
        async create(params, options) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            const user = JSON.parse(params.messages.find((m) => m.role === 'user').content);
            const listKey = Object.keys(user)[0];
            calls.push({ params, options, listKey, payload: user[listKey] });
            return { choices: [{ message: { content: JSON.stringify(reply(user[listKey], listKey)) } }] };
          } finally {
            inFlight -= 1;
          }
        },
      },
    },
  };
  return client;
}

const everything = (category) => (items, listKey) => ({ [listKey]: items.map((it) => ({ i: it.i, category })) });
const templates = (n) => Array.from({ length: n }, (_, k) => ({
  key: `/section-${k}/{slug}`, pattern: `/section-${k}/{slug}`, examples: [`https://x.com/section-${k}/a`],
}));
const urls = (n) => Array.from({ length: n }, (_, k) => ({ key: `x.com/page-${k}`, url: `https://x.com/page-${k}` }));

test('every call carries its own timeout and retry limit', async () => {
  const client = stubClient(everything('informational'));
  await createInformationalClassifier({ client }).classifyTemplates(templates(3));
  assert.deepEqual(client.calls[0].options, { timeout: SELECTION_AI_TIMEOUT_MS, maxRetries: SELECTION_AI_MAX_RETRIES });
});

test('it asks Claude Sonnet 5 for a JSON reply', async () => {
  const client = stubClient(everything('informational'));
  await createInformationalClassifier({ client }).classifyUrls(urls(2));
  assert.equal(MODEL, 'claude-sonnet-5');
  assert.equal(client.calls[0].params.model, 'claude-sonnet-5');
  assert.deepEqual(client.calls[0].params.response_format, { type: 'json_object' });
});

test('templates go 40 to a call and URLs 100 to a call', async () => {
  const t = stubClient(everything('informational'));
  await createInformationalClassifier({ client: t }).classifyTemplates(templates(85));
  assert.deepEqual(t.calls.map((c) => c.payload.length).sort((a, b) => b - a), [SELECTION_TEMPLATE_BATCH_SIZE, SELECTION_TEMPLATE_BATCH_SIZE, 5]);

  const u = stubClient(everything('informational'));
  await createInformationalClassifier({ client: u }).classifyUrls(urls(250));
  assert.deepEqual(u.calls.map((c) => c.payload.length).sort((a, b) => b - a), [SELECTION_URL_BATCH_SIZE, SELECTION_URL_BATCH_SIZE, 50]);
});

test('no more calls are in flight than the concurrency limit', async () => {
  const client = stubClient(everything('informational'), { delayMs: 15 });
  await createInformationalClassifier({ client }).classifyUrls(urls(SELECTION_URL_BATCH_SIZE * 9));
  assert.ok(client.maxInFlight <= SELECTION_AI_CONCURRENCY, `saw ${client.maxInFlight} in flight`);
  assert.ok(client.maxInFlight > 1, 'batches do run concurrently');
});

test('the model sees URLs and nothing else', async () => {
  const client = stubClient(everything('informational'));
  const c = createInformationalClassifier({ client });
  await c.classifyTemplates(templates(2));
  await c.classifyUrls(urls(2));
  for (const item of client.calls[0].payload) assert.deepEqual(Object.keys(item).sort(), ['examples', 'i', 'pattern']);
  for (const item of client.calls[1].payload) assert.deepEqual(Object.keys(item).sort(), ['i', 'url']);
  // No rule-based guess for the model to defer to (see refineWithAI's history).
  assert.ok(!/guess/i.test(TEMPLATE_SYSTEM_PROMPT) && !/guess/i.test(URL_SYSTEM_PROMPT));
  assert.ok(!/title/i.test(JSON.stringify(client.calls.map((call) => call.payload))));
});

test('a well-formed reply is authoritative: omissions and invalid categories become unknown', async () => {
  const client = stubClient((items, listKey) => ({
    [listKey]: [
      { i: 0, category: 'informational' },
      { i: 1, category: 'article' },        // the model's word for it — accepted
      { i: 2, category: 'blog-post' },      // not a category — unknown
      { i: 99, category: 'informational' }, // an invented index — ignored
      // i: 3 omitted — unknown
    ],
  }));
  const res = await createInformationalClassifier({ client }).classifyUrls(urls(4));
  assert.equal(res.verdicts.get('x.com/page-0'), 'informational');
  assert.equal(res.verdicts.get('x.com/page-1'), 'informational');
  assert.equal(res.verdicts.get('x.com/page-2'), 'unknown');
  assert.equal(res.verdicts.get('x.com/page-3'), 'unknown');
  assert.equal(res.verdicts.size, 4);
  assert.equal(res.failedKeys.size, 0);
});

test('a category written under the wrong key is still read, and an empty reply is retried', async () => {
  // Seen live: {"i":0,"url":"other"} for a whole 100-URL batch.
  const misKeyed = stubClient((items, listKey) => ({ [listKey]: items.map((it) => ({ i: it.i, url: 'service' })) }));
  const res = await createInformationalClassifier({ client: misKeyed }).classifyUrls(urls(3));
  assert.deepEqual([...res.verdicts.values()], ['service', 'service', 'service']);

  // Nothing usable at all: a failure (asked twice), never a batch of "unknown".
  const useless = stubClient((items, listKey) => ({ [listKey]: items.map((it) => ({ i: it.i, url: it.url })) }));
  const bad = await createInformationalClassifier({ client: useless }).classifyUrls(urls(3));
  assert.equal(bad.failedKeys.size, 3);
  assert.equal(bad.verdicts.size, 0);
  assert.equal(useless.calls.length, 2);
  assert.match(bad.error, /no usable categories/);
});

test('"mixed" is a template answer only', async () => {
  const client = stubClient(everything('mixed'));
  const c = createInformationalClassifier({ client });
  const t = await c.classifyTemplates(templates(1));
  const u = await c.classifyUrls(urls(1));
  assert.equal([...t.verdicts.values()][0], 'mixed');
  // Not a valid answer for one URL, so the reply carries nothing usable and the
  // batch fails over to the rules rather than filing the page as "unknown".
  assert.equal(u.verdicts.size, 0);
  assert.equal(u.failedKeys.size, 1);
});

test('a batch that keeps failing is reported as failed, and the other batches still land', async () => {
  // The full batch fails every time it is asked; the small one never does.
  const client = stubClient((items, listKey) => {
    if (items.length === SELECTION_URL_BATCH_SIZE) throw new Error('529 overloaded');
    return everything('informational')(items, listKey);
  });
  const res = await createInformationalClassifier({ client }).classifyUrls(urls(SELECTION_URL_BATCH_SIZE + 10));
  assert.equal(res.failedKeys.size, SELECTION_URL_BATCH_SIZE);
  assert.equal(res.verdicts.size, 10);
  assert.match(res.error, /529/);
});

test('a batch that fails once is asked again before it falls back', async () => {
  // Seen live: one 100-URL reply that was not valid JSON.
  let n = 0;
  const client = stubClient((items, listKey) => {
    n += 1;
    if (n === 1) throw new Error('Expected double-quoted property name in JSON');
    return everything('informational')(items, listKey);
  });
  const res = await createInformationalClassifier({ client }).classifyUrls(urls(3));
  assert.equal(res.failedKeys.size, 0);
  assert.equal(res.verdicts.size, 3);
  assert.equal(client.calls.length, 2, 'asked twice: the second attempt answered');
});

test('a reply that narrates before its JSON is still read', async () => {
  // Seen live: "Looking at these URLs… {…}".
  const { parseJsonReply } = require('../informationalClassifier');
  assert.deepEqual(parseJsonReply('Looking at these URLs, here you go:\n{"urls":[{"i":0,"category":"service"}]}\nDone.'),
    { urls: [{ i: 0, category: 'service' }] });
  assert.throws(() => parseJsonReply('no json here'));
});

test('an unparseable reply counts as a failure, not as an answer', async () => {
  const client = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: 'Sure! Here you go.' } }] }) } },
  };
  const res = await createInformationalClassifier({ client }).classifyTemplates(templates(2));
  assert.equal(res.failedKeys.size, 2);
  assert.equal(res.verdicts.size, 0);
});

test('a reply cut off at its output limit is a failure, and Claude is asked not to think', async () => {
  const calls = [];
  const client = {
    provider: 'anthropic',
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          return { choices: [{ finish_reason: 'length', message: { content: '{"urls":[{"i":0,"category":"inform' } }] };
        },
      },
    },
  };
  const res = await createInformationalClassifier({ client }).classifyUrls(urls(2));
  assert.equal(res.failedKeys.size, 2);
  assert.match(res.error, /cut off/);
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
});

test('past the deadline no batch starts', async () => {
  const client = stubClient(everything('informational'));
  const res = await createInformationalClassifier({ client }).classifyUrls(urls(5), { deadline: Date.now() - 1 });
  assert.equal(client.calls.length, 0);
  assert.equal(res.skippedKeys.size, 5);
});

test('without an API key there is no classifier at all', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(createInformationalClassifier(), null);
    process.env.ANTHROPIC_API_KEY = 'your_anthropic_api_key_here';
    assert.equal(createInformationalClassifier(), null, 'the .env placeholder is not a key');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('category names are normalised, not guessed at', () => {
  const allowed = ['informational', 'service', 'unknown'];
  assert.equal(normalizeCategory(' Informational ', allowed), 'informational');
  assert.equal(normalizeCategory('articles', allowed), 'informational');
  assert.equal(normalizeCategory('location', allowed), null);
  assert.equal(normalizeCategory(undefined, allowed), null);
});
