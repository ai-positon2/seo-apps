// ── GPT, asked directly, with web search on ──────────────────────────────────
//
// Same `capture(prompt)` contract as v1's surfaces (see
// modules/aiVisibility/surfaces/index.js), so every downstream consumer —
// measure.js, scoring.js, the whole metrics layer — cannot tell an API row from
// a scraped one except by the `access` field that exists to tell them apart.
//
// The Responses API rather than Chat Completions, because `web_search` is a
// hosted tool and only Responses serves it. That is also why this file does not
// go through services/llmProviders.js: that helper hands back a client shaped
// like `chat.completions.create`, which has no way to express a hosted tool.
//
// ── Asking the way a person asks ───────────────────────────────────────────
//
// No system prompt, no instructions, no persona. The brief is explicit that
// this should mimic a real user search, and every word of framing we add is a
// word the buyer did not type. A system prompt saying "you are a helpful
// shopping assistant" measurably changes which brands get named — which would
// mean the report describes our prompt engineering rather than the model.
//
// Temperature is left at the provider default for the same reason. gpt-5-nano
// is a reasoning model and only accepts the default anyway, so setting it would
// be both wrong and rejected.

const OpenAI = require('openai');
const {
  OPENAI_MODEL, MAX_SEARCHES_PER_ANSWER, OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_REASONING_EFFORT, REQUEST_TIMEOUT_MS, costOf,
} = require('../models');

const ENGINE = 'openai';
const PROVIDER = 'api';
const LABEL = 'ChatGPT (API · web search)';
const ACCESS = 'api';

// A model asked a question always replies. An empty answer therefore means we
// failed to read one, not that the engine said nothing — the same rule v1's
// chat surfaces set, and the reason measure.js retries an empty answer once.
const ALWAYS_ANSWERS = true;

function hasKey() {
  const k = process.env.OPENAI_API_KEY;
  return Boolean(k) && k !== 'your_openai_api_key_here';
}

let _client = null;
function client() {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: REQUEST_TIMEOUT_MS,
      // measure.js owns retries, and it distinguishes an empty answer from a
      // transport failure. A second retry layer underneath would double the
      // spend on a failing call without telling the row it happened.
      maxRetries: 0,
    });
  }
  return _client;
}

/**
 * The text the model produced.
 *
 * `output_text` is the SDK's aggregate convenience field and is what we want,
 * but it is a getter over the output array — on a response whose only items are
 * tool calls it is an empty string rather than absent. Falling back to walking
 * the array covers the shape change if that getter ever goes away.
 */
function answerFrom(res) {
  const direct = typeof res?.output_text === 'string' ? res.output_text.trim() : '';
  if (direct) return direct;

  const parts = [];
  for (const item of res?.output || []) {
    if (item?.type !== 'message') continue;
    for (const block of item.content || []) {
      if (block?.type === 'output_text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Citations, in v1's shape: {url, title, domain, index}.
 *
 * These arrive as `url_citation` annotations hanging off the text blocks. They
 * are a SEPARATE signal from a text mention and the metrics treat them as such:
 * a brand the model names but does not link is visible without being credited,
 * and a brand it links without naming is credited without being visible.
 */
function citationsFrom(res) {
  const seen = new Set();
  const out = [];

  for (const item of res?.output || []) {
    if (item?.type !== 'message') continue;
    for (const block of item.content || []) {
      for (const note of block?.annotations || []) {
        if (note?.type !== 'url_citation' || !note.url) continue;
        if (seen.has(note.url)) continue;
        seen.add(note.url);
        let domain = null;
        try { domain = new URL(note.url).hostname.replace(/^www\./, ''); } catch { /* keep null */ }
        out.push({
          url: note.url,
          title: note.title || null,
          domain,
          // 1-based, matching v1's adapters and the order the model cited them.
          index: out.length + 1,
        });
      }
    }
  }
  return out;
}

/** What the search tool actually searched for. Empty when it never fired. */
function queriesFrom(res) {
  const out = [];
  for (const item of res?.output || []) {
    if (item?.type !== 'web_search_call') continue;
    const q = item?.action?.query;
    if (typeof q === 'string' && q.trim()) out.push(q.trim());
  }
  return out;
}

async function capture(prompt) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('An empty prompt cannot be measured.');
  if (!hasKey()) throw Object.assign(new Error('OPENAI_API_KEY is not configured.'), { code: 'not_configured' });

  const res = await client().responses.create({
    model: OPENAI_MODEL,
    // Bare string input: the closest this API gets to "what a person typed".
    input: text,
    tools: [{ type: 'web_search' }],
    max_tool_calls: MAX_SEARCHES_PER_ANSWER,
    // Covers reasoning tokens AND the visible answer on this API. See
    // OPENAI_MAX_OUTPUT_TOKENS in models.js for the run where getting this
    // wrong failed 8 captures in 10, silently, as "empty answer".
    max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    // Not a reasoning task: the point is what a buyer's question returns, not
    // how well the model can think about it. Low effort leaves the budget for
    // an actual answer and bills for fewer invisible tokens.
    reasoning: { effort: OPENAI_REASONING_EFFORT },
  });

  const queries = queriesFrom(res);
  const searchCalls = (res?.output || []).filter((i) => i?.type === 'web_search_call').length;

  return {
    engine: ENGINE,
    provider: PROVIDER,
    surfaceLabel: LABEL,
    access: ACCESS,
    answerText: answerFrom(res) || null,
    citations: citationsFrom(res),
    webQueries: queries,
    // OpenAI does not run entity extraction of its own; mention matching is
    // measure.js's job against the project's brand set.
    providerBrands: [],
    // Top level, which is where the surface contract says it belongs — v1's
    // older adapters tuck it in `raw` and capture.js reads both.
    features: [searchCalls > 0 ? 'web_search' : null, 'prose'].filter(Boolean),
    // Did retrieval actually happen? An ungrounded answer is a reading of the
    // training data, and storing it next to a grounded one without saying so
    // would merge two different measurements.
    grounded: searchCalls > 0,
    modelVersion: res?.model || OPENAI_MODEL,
    taskCost: costOf(OPENAI_MODEL, {
      inputTokens: res?.usage?.input_tokens || 0,
      outputTokens: res?.usage?.output_tokens || 0,
      searches: searchCalls,
    }),
    capturedAt: new Date().toISOString(),
    raw: {
      id: res?.id || null,
      status: res?.status || null,
      usage: res?.usage || null,
      searchCalls,
      // Truncation is invisible in the text but changes what the answer says.
      // `incomplete` here and a short answer downstream are the same event.
      incompleteReason: res?.incomplete_details?.reason || null,
    },
  };
}

module.exports = {
  capture, ENGINE, PROVIDER, LABEL, ACCESS, ALWAYS_ANSWERS, hasKey,
};
