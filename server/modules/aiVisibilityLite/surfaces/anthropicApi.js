// ── Claude, asked directly, with web search on ───────────────────────────────
//
// Same `capture(prompt)` contract as every other surface. The Messages API with
// the hosted web-search tool: Claude decides whether to search, runs it on
// Anthropic's side, and the results come back as content blocks in the same
// response — there is no client-side tool loop to run.
//
// This is the one surface that uses a provider's own SDK (@anthropic-ai/sdk,
// already a dependency for the competitor page classifier) rather than the
// `openai` client pointed at a compat endpoint. services/llmProviders.js can
// reach Claude through its OpenAI-compatible endpoint, but that endpoint does
// not carry hosted tools, so it cannot express the one thing this module needs.
//
// ── The tool version is not a style choice ─────────────────────────────────
//
// `web_search_20260209` is the current variant and Haiku 4.5 rejects it: the
// dynamic-filtering tool requires Opus 4.6+ or Sonnet 4.6+. The basic
// `web_search_20250305` is the correct tool for the cheapest model, not a
// downgrade. See models.js, which owns that decision and the env override.
//
// No system prompt, default temperature — the reasoning is in openaiApi.js and
// applies identically here.

const Anthropic = require('@anthropic-ai/sdk');
const {
  ANTHROPIC_MODEL, ANTHROPIC_WEB_SEARCH_TOOL, MAX_SEARCHES_PER_ANSWER,
  MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS, costOf,
} = require('../models');

const ENGINE = 'anthropic';
const PROVIDER = 'api';
const LABEL = 'Claude (API · web search)';
const ACCESS = 'api';

const ALWAYS_ANSWERS = true;

function hasKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return Boolean(k) && k !== 'your_anthropic_api_key_here';
}

let _client = null;
function client() {
  if (!_client) {
    // The package exports a constructor that has moved between the default and
    // named position across versions; pageClassifier.js resolves it the same
    // way rather than pinning to whichever one this install happens to have.
    const Ctor = Anthropic.default || Anthropic;
    _client = new Ctor({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: REQUEST_TIMEOUT_MS,
      // measure.js owns retries. See openaiApi.js.
      maxRetries: 0,
    });
  }
  return _client;
}

/** The prose, with the tool-result blocks left out. */
function answerFrom(res) {
  return (res?.content || [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Citations in v1's shape: {url, title, domain, index}.
 *
 * Read from the text blocks' `citations` — what Claude actually cited in the
 * answer — rather than from the `web_search_tool_result` blocks, which list
 * everything the search RETURNED. Those are different claims: a result the
 * model was shown and ignored is not a citation, and counting it as one would
 * credit a domain the answer never pointed at.
 */
function citationsFrom(res) {
  const seen = new Set();
  const out = [];

  for (const block of res?.content || []) {
    if (block?.type !== 'text') continue;
    for (const cite of block.citations || []) {
      const url = cite?.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      let domain = null;
      try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep null */ }
      out.push({
        url,
        title: cite.title || null,
        domain,
        index: out.length + 1,
      });
    }
  }
  return out;
}

/** What the tool searched for. `server_tool_use` blocks carry the query. */
function queriesFrom(res) {
  const out = [];
  for (const block of res?.content || []) {
    if (block?.type !== 'server_tool_use' || block.name !== 'web_search') continue;
    const q = block?.input?.query;
    if (typeof q === 'string' && q.trim()) out.push(q.trim());
  }
  return out;
}

async function capture(prompt) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('An empty prompt cannot be measured.');
  if (!hasKey()) throw Object.assign(new Error('ANTHROPIC_API_KEY is not configured.'), { code: 'not_configured' });

  const res = await client().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: text }],
    tools: [{
      type: ANTHROPIC_WEB_SEARCH_TOOL,
      name: 'web_search',
      max_uses: MAX_SEARCHES_PER_ANSWER,
    }],
  });

  // The count the API bills on, taken from `usage` rather than from counting
  // blocks: a search that errored still produced a block but is not billed, and
  // the usage figure is the one that matches the invoice.
  const searches = res?.usage?.server_tool_use?.web_search_requests ?? queriesFrom(res).length;

  return {
    engine: ENGINE,
    provider: PROVIDER,
    surfaceLabel: LABEL,
    access: ACCESS,
    answerText: answerFrom(res) || null,
    citations: citationsFrom(res),
    webQueries: queriesFrom(res),
    providerBrands: [],
    features: [searches > 0 ? 'web_search' : null, 'prose'].filter(Boolean),
    grounded: searches > 0,
    modelVersion: res?.model || ANTHROPIC_MODEL,
    taskCost: costOf(ANTHROPIC_MODEL, {
      inputTokens: res?.usage?.input_tokens || 0,
      outputTokens: res?.usage?.output_tokens || 0,
      searches,
    }),
    capturedAt: new Date().toISOString(),
    raw: {
      id: res?.id || null,
      usage: res?.usage || null,
      searches,
      // 'max_tokens' here means the answer was cut off mid-sentence, which
      // reads downstream as a short answer with no explanation unless the row
      // says so.
      stopReason: res?.stop_reason || null,
    },
  };
}

module.exports = {
  capture, ENGINE, PROVIDER, LABEL, ACCESS, ALWAYS_ANSWERS, hasKey,
};
