// â”€â”€ /api/report-chat, end to end over HTTP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The router on a real Express server with the database, project access, the
// context readers and the model all faked. Covers who may ask, the daily cap,
// the shape of the answer stream, and what gets saved.
//
// Run: node --test modules/reportChat/__tests__/routes.test.js

const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const express = require('express');

const { createRouter } = require('../routes');

// â”€â”€ Fakes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let saved, recentQuestions, llmCalls, llmChunks, llmError;

function fakeStore() {
  const thread = { id: 't-1', created_at: '2026-11-02T00:00:00Z' };
  let n = 0;
  return {
    activeThread: async () => (saved.length ? thread : null),
    ensureThread: async () => thread,
    archiveActive: async () => { saved.length = 0; },
    listMessages: async () => saved.slice(),
    addMessage: async (m) => {
      const row = { id: `m-${++n}`, created_at: 'now', ...m };
      saved.push(row);
      return row;
    },
    countRecentQuestions: async () => recentQuestions,
  };
}

async function* streamOf(chunks) {
  for (const c of chunks) yield c;
}

const deps = {
  store: fakeStore(),
  isDatabaseConfigured: () => true,
  requireProject: async (req, projectId) => {
    if (projectId !== 'p-ok') throw Object.assign(new Error('Project not found.'), { status: 404 });
    return { project: { id: 'p-ok', name: 'Acme' } };
  },
  buildChatContext: async ({ screen }) => ({
    screen, screenName: screen ? 'Tech Audit' : null, links: [{ label: 'Tech Audit', path: '/crawl-scope' }], missing: [], sections: [],
  }),
  createLlmClient: () => ({
    model: 'test-model',
    chat: {
      completions: {
        create: async (params) => {
          llmCalls.push(params);
          if (llmError) throw llmError;
          // A list of chunk lists is one per round (tool calls, then the answer).
          const rounds = Array.isArray(llmChunks[0]) ? llmChunks : [llmChunks];
          return streamOf(rounds[Math.min(llmCalls.length - 1, rounds.length - 1)]);
        },
      },
    },
  }),
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { userId: 'u-1', username: 'a@b.c' }; next(); });
app.use('/api/report-chat', createRouter(deps));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/report-chat`;
after(() => server.close());

beforeEach(() => {
  saved = [];
  recentQuestions = 0;
  llmCalls = [];
  llmError = null;
  llmChunks = [
    { choices: [{ delta: { content: 'Your score is ' } }] },
    { choices: [{ delta: { content: '77.' } }] },
    { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40 } },
  ];
});

const ask = (projectId, body) => fetch(`${base}/${projectId}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Parses an SSE body into [{ event, data }]. */
async function events(res) {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((block) => {
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1] || 'null');
    return { event, data };
  });
}

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('a project the caller cannot see is a 404', async () => {
  const res = await ask('p-other', { message: 'hi' });
  assert.equal(res.status, 404);
  assert.equal(saved.length, 0);
  const thread = await fetch(`${base}/p-other/thread`);
  assert.equal(thread.status, 404);
});

test('an empty or oversized question is refused before anything runs', async () => {
  assert.equal((await ask('p-ok', { message: '   ' })).status, 400);
  assert.equal((await ask('p-ok', { message: 'x'.repeat(2001) })).status, 400);
  assert.equal(llmCalls.length, 0);
});

test('the daily cap refuses with a JSON 429', async () => {
  recentQuestions = 200;
  const res = await ask('p-ok', { message: 'hi' });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, 'daily_limit');
  assert.equal(saved.length, 0);
});

test('an answer streams and both sides are saved with tokens', async () => {
  const res = await ask('p-ok', { message: 'How is the health score calculated?', screen: 'tech' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const evs = await events(res);
  // How the text is cut into deltas is the stream's business (short answers are
  // held, the marker filter keeps a tail back); what arrives must be the answer.
  assert.equal(evs[0].event, 'start');
  assert.equal(evs.at(-1).event, 'done');
  assert.equal(evs.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), 'Your score is 77.');
  assert.equal(evs[0].data.userMessage.content, 'How is the health score calculated?');
  assert.equal(evs.at(-1).data.message.content, 'Your score is 77.');

  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map((m) => m.role), ['user', 'assistant']);
  assert.equal(saved[0].screen, 'tech');
  assert.equal(saved[1].inputTokens, 1200);
  assert.equal(saved[1].outputTokens, 40);
  assert.equal(saved[1].model, 'test-model');

  assert.equal(llmCalls[0].stream, true);
  assert.equal(llmCalls[0].messages.at(-2).content, 'How is the health score calculated?');
});

test('an unknown screen is treated as project-level', async () => {
  await events(await ask('p-ok', { message: 'hi', screen: 'settings' }));
  assert.equal(saved[0].screen, null);
});

test('earlier turns are sent as history', async () => {
  await events(await ask('p-ok', { message: 'first' }));
  await events(await ask('p-ok', { message: 'and then?' }));
  const roles = llmCalls[1].messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'system', 'user', 'assistant', 'user', 'system']);
});

test('a model failure sends an error event and keeps the question', async () => {
  llmError = new Error('upstream 500');
  const evs = await events(await ask('p-ok', { message: 'hi' }));
  assert.deepEqual(evs.map((e) => e.event), ['start', 'error']);
  assert.deepEqual(saved.map((m) => m.role), ['user']);
});

test('an empty answer is an error, not a blank message', async () => {
  llmChunks = [{ choices: [{ delta: {} }] }];
  const evs = await events(await ask('p-ok', { message: 'hi' }));
  assert.equal(evs.at(-1).event, 'error');
  assert.equal(saved.length, 1);
});

test('a calculator round trip: the sum is done by the server, only the answer streams', async () => {
  llmChunks = [
    [
      { choices: [{ delta: { content: 'Let me work that out.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'calculate', arguments: '{"expressions":["round(65.46 + ' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '9.38 + 4.34)"]}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20 } },
    ],
    [
      { choices: [{ delta: { content: 'The score would become 79.' } }] },
      { choices: [], usage: { prompt_tokens: 1100, completion_tokens: 10 } },
    ],
  ];
  const evs = await events(await ask('p-ok', { message: 'what if?' }));
  assert.equal(evs.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), 'The score would become 79.', 'the preamble before the tool call is not streamed');
  assert.equal(evs.at(-1).data.message.content, 'The score would become 79.', 'the preamble before the tool call is not shown');

  assert.equal(llmCalls.length, 2);
  assert.equal(llmCalls[0].tools[0].function.name, 'calculate');
  const toolMsg = llmCalls[1].messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.deepEqual(JSON.parse(toolMsg.content), [{ expression: 'round(65.46 + 9.38 + 4.34)', result: 79 }]);
  assert.equal(llmCalls[1].messages.at(-2).tool_calls[0].function.arguments, '{"expressions":["round(65.46 + 9.38 + 4.34)"]}');

  assert.equal(saved.at(-1).inputTokens, 2100, 'tokens add up across rounds');
  assert.equal(saved.at(-1).outputTokens, 30);
});

test('the last round turns tools off so the model has to answer', async () => {
  const toolRound = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'calculate', arguments: '{"expressions":["1+1"]}' } }] } }] }];
  llmChunks = [toolRound, toolRound, toolRound, toolRound, [{ choices: [{ delta: { content: 'Two.' } }] }]];
  const evs = await events(await ask('p-ok', { message: 'loop' }));
  assert.equal(evs.at(-1).data.message.content, 'Two.');
  assert.equal(llmCalls.length, 5);
  assert.equal(llmCalls[4].tool_choice, 'none');
  assert.equal(llmCalls[0].tool_choice, 'auto');
});

test('an advice answer: the marker is never streamed, even split across chunks', async () => {
  llmChunks = [
    { choices: [{ delta: { content: 'Fix the redirect chains first; they waste crawl budget across the whole site, and most sites fix them in the CMS. [[P2' } }] },
    { choices: [{ delta: { content: '_EXP' } }] },
    { choices: [{ delta: { content: 'ERT]]' } }] },
  ];
  const evs = await events(await ask('p-ok', { message: 'what should we do?' }));
  const streamed = evs.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.ok(!streamed.includes('[['), streamed);
  assert.ok(!streamed.includes(']]'), streamed);
  const done = evs.at(-1).data.message;
  assert.equal(done.offerExpert, true);
  assert.ok(done.content.endsWith('in the CMS.'), done.content);
  assert.equal(saved.at(-1).offerExpert, true);
});

test('an "In general" advice section offers the specialist even without the marker', async () => {
  llmChunks = [{ choices: [{ delta: { content: '**For your site:** 404 on the card.\n\n**In general:** publish one if you build agent integrations.' } }] }];
  const evs = await events(await ask('p-ok', { message: 'do we need an MCP card?' }));
  assert.equal(evs.at(-1).data.message.offerExpert, true);
});

test('an explanation without the marker offers no specialist', async () => {
  const evs = await events(await ask('p-ok', { message: 'how is it calculated?' }));
  assert.equal(evs.at(-1).data.message.offerExpert, false);
});

test('web search: results go back to the model, sources to the reader, at most 2 per answer', async () => {
  const searches = [];
  deps.webSearch = async (q) => { searches.push(q); return { summary: `About ${q}`, sources: [{ title: 'Google', url: 'https://developers.google.com/search/updates' }] }; };
  const searchRound = (id) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'web_search', arguments: JSON.stringify({ query: `update ${id}` }) } }] } }] }];
  llmChunks = [searchRound('s1'), searchRound('s2'), searchRound('s3'), [{ choices: [{ delta: { content: 'Google confirmed a core update this month. [[P2_EXPERT]]' } }] }]];
  try {
    const evs = await events(await ask('p-ok', { message: 'what changed in the latest core update?' }));
    assert.deepEqual(searches, ['update s1', 'update s2'], 'the third search is refused');
    const third = llmCalls[3].messages.at(-1);
    assert.match(third.content, /search limit reached/);
    const done = evs.at(-1).data.message;
    assert.deepEqual(done.sources, [{ title: 'Google', url: 'https://developers.google.com/search/updates' }]);
    assert.equal(done.offerExpert, true);
    assert.equal(saved.at(-1).webSearches, 2);
    assert.equal(llmCalls[0].tools.map((t) => t.function.name).join(','), 'calculate,web_search');
  } finally {
    delete deps.webSearch;
  }
});

test('the thread reads back, and a new conversation clears it', async () => {
  await events(await ask('p-ok', { message: 'hi' }));
  const before = await (await fetch(`${base}/p-ok/thread`)).json();
  assert.equal(before.thread.id, 't-1');
  assert.deepEqual(before.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(before.dailyLimit, 200);

  await fetch(`${base}/p-ok/thread`, { method: 'POST' });
  const afterNew = await (await fetch(`${base}/p-ok/thread`)).json();
  assert.equal(afterNew.thread, null);
  assert.deepEqual(afterNew.messages, []);
});
