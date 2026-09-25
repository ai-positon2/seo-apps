// ── The provider factory passes per-request options through ──────────────────
//
// createLlmClient wraps chat.completions.create for Claude and Gemini, to adapt
// parameters those endpoints reject. The wrapper used to take the request body
// alone, so a caller's { timeout, maxRetries } never reached the SDK and every
// Claude call ran on its ten-minute default with two retries — long enough for
// one hung call to outlast a whole module run.
//
// Run: node services/__tests__/llmProviders.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');
const OpenAI = require('openai');

const { createLlmClient } = require('../llmProviders');

// The wrapper binds the SDK's own create when the client is built, so the stub
// goes on the prototype first. Found through a throwaway client rather than an
// import path, which moves between SDK versions.
function stubSdkCreate(reply) {
  const Ctor = OpenAI.default || OpenAI;
  const proto = Object.getPrototypeOf(new Ctor({ apiKey: 'test' }).chat.completions);
  const original = proto.create;
  const calls = [];
  proto.create = async function create(body, options) {
    calls.push({ body, options });
    return reply;
  };
  return { calls, restore: () => { proto.create = original; } };
}

test('a Claude call forwards its timeout and retry options to the SDK', async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const sdk = stubSdkCreate({ choices: [{ message: { content: '{"ok":true}' } }] });
  try {
    const client = createLlmClient('claude-sonnet-5');
    await client.chat.completions.create({
      model: client.model,
      max_tokens: 100,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'Reply in JSON.' }, { role: 'user', content: 'hi' }],
    }, { timeout: 1234, maxRetries: 0 });

    assert.equal(sdk.calls.length, 1);
    assert.deepEqual(sdk.calls[0].options, { timeout: 1234, maxRetries: 0 });
    // The adaptations the wrapper exists for still happen.
    assert.equal(sdk.calls[0].body.temperature, undefined, 'temperature is dropped for Anthropic');
    assert.equal(sdk.calls[0].body.max_completion_tokens, 100);
  } finally {
    sdk.restore();
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('structured tasks switch thinking off for Claude only, and a cut-off reply says so', () => {
  const { structuredTaskParams, assertNotTruncated } = require('../llmProviders');
  assert.deepEqual(structuredTaskParams({ provider: 'anthropic' }), { thinking: { type: 'disabled' } });
  assert.deepEqual(structuredTaskParams({ provider: 'openai' }), {});
  assert.deepEqual(structuredTaskParams({ provider: 'google' }), {});
  assert.deepEqual(structuredTaskParams(undefined), {});
  assert.throws(() => assertNotTruncated({ choices: [{ finish_reason: 'length' }] }), /cut off/);
  assert.doesNotThrow(() => assertNotTruncated({ choices: [{ finish_reason: 'stop' }] }));
});

test('the Content Architect JSON calls all use it', () => {
  // Sonnet 5's adaptive thinking drew on max_tokens until cluster-naming JSON
  // was cut off mid-string and whole batches fell back to stemmed names.
  const fs = require('fs');
  const path = require('path');
  for (const file of ['llmNaming.js', 'contentRelevance.js', 'patternClassifier.js', 'informationalClassifier.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../../modules/contentArchitect', file), 'utf8');
    assert.match(source, /structuredTaskParams\(/, `${file} should switch thinking off`);
    assert.match(source, /assertNotTruncated\(completion\)/, `${file} should report a cut-off reply`);
  }
});

test('a call with no options still works', async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const sdk = stubSdkCreate({ choices: [{ message: { content: 'plain' } }] });
  try {
    const client = createLlmClient('claude-sonnet-5');
    const res = await client.chat.completions.create({ model: client.model, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.choices[0].message.content, 'plain');
    assert.equal(sdk.calls[0].options, undefined);
  } finally {
    sdk.restore();
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});
