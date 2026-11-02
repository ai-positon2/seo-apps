// ── The assistant's web search ──────────────────────────────────────────────
//
// One Responses API call with the hosted web_search tool, read the way the AI
// Visibility surface reads it. The client is faked.
//
// Run: node --test modules/reportChat/__tests__/webSearch.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { runWebSearch, cleanSources, WEB_SEARCH_TOOL } = require('../webSearch');

const responseWith = (text, urls = []) => ({
  output: [
    { type: 'web_search_call', action: { query: 'q' } },
    {
      type: 'message',
      content: [{
        type: 'output_text',
        text,
        annotations: urls.map((u) => ({ type: 'url_citation', url: u, title: `Title of ${u}` })),
      }],
    },
  ],
});

test('a search returns its summary and cited sources', async () => {
  const calls = [];
  const client = { responses: { create: async (p) => { calls.push(p); return responseWith('Google rolled out an update.', ['https://developers.google.com/search/updates', 'https://example.com/a']); } } };
  const r = await runWebSearch('latest core update', { client });
  assert.equal(r.summary, 'Google rolled out an update.');
  assert.deepEqual(r.sources.map((s) => s.url), ['https://developers.google.com/search/updates', 'https://example.com/a']);
  assert.deepEqual(calls[0].tools, [{ type: 'web_search' }]);
  assert.match(calls[0].input, /latest core update/);
});

test('failures come back as errors, never throws', async () => {
  const failing = { responses: { create: async () => { throw new Error('429'); } } };
  assert.deepEqual(await runWebSearch('x', { client: failing }), { error: 'the web search failed', sources: [] });
  const empty = { responses: { create: async () => ({ output: [] }) } };
  assert.equal((await runWebSearch('x', { client: empty })).error, 'the search returned nothing usable');
  assert.equal((await runWebSearch('  ', { client: empty })).error, 'empty query');
});

test('sources: http(s) only, deduplicated, bounded', () => {
  const list = cleanSources([
    { url: 'javascript:alert(1)', title: 'x' },
    { url: 'not a url' },
    { url: 'https://a.com/x', title: 'A' },
    { url: 'https://a.com/x', title: 'A again' },
    { url: 'http://b.com/', title: 'B'.repeat(500) },
    ...Array.from({ length: 20 }, (_, i) => ({ url: `https://c${i}.com/` })),
  ]);
  assert.equal(list[0].url, 'https://a.com/x');
  assert.equal(list[1].title.length, 200);
  assert.equal(list.length, 8);
  assert.equal(list[2].title, 'c0.com', 'a missing title falls back to the host');
});

test('sources lose tracking parameters, keep real ones', () => {
  const [a, b] = cleanSources([
    { url: 'https://sparktoro.com/blog/study/?tab=tab-crm&utm_source=openai', title: 'S' },
    { url: 'https://developers.google.com/search/docs?authuser=989892918&hl=en', title: 'G' },
  ]);
  assert.equal(a.url, 'https://sparktoro.com/blog/study/');
  assert.equal(b.url, 'https://developers.google.com/search/docs?hl=en');
});

test('the tool definition takes one query', () => {
  assert.equal(WEB_SEARCH_TOOL.function.name, 'web_search');
  assert.deepEqual(WEB_SEARCH_TOOL.function.parameters.required, ['query']);
});
