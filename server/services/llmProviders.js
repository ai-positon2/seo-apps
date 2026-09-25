// ── llmProviders ──────────────────────────────────────────────────────────────
// Lets Article Enhancer / Enhance Existing Article run their workhorse LLM calls
// against OpenAI, Claude, or Gemini, selected per-run by the user.
//
// Anthropic and Google both expose OpenAI-compatible chat-completions endpoints,
// so a single `openai` client (pointed at a different baseURL/key) covers all
// three providers — no extra SDKs, and every existing call site's
// `client.chat.completions.create({...})` / `res.choices[0].message.content`
// shape keeps working unchanged.
//
// Neither compat endpoint honors `response_format: json_object` (Anthropic
// ignores it; Gemini's support is unconfirmed), so for non-OpenAI providers we
// reinforce JSON-only output via the system prompt and strip markdown code
// fences from the response before the caller's JSON.parse.
const OpenAI = require('openai');

const MODEL_OPTIONS = [
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini (OpenAI)', provider: 'openai' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'google' },
];
const DEFAULT_MODEL_ID = 'gpt-5.4-mini';
const VALID_MODEL_IDS = new Set(MODEL_OPTIONS.map(m => m.id));

function resolveModelId(id) {
  return VALID_MODEL_IDS.has(id) ? id : DEFAULT_MODEL_ID;
}

// Analysis/recommendation stages may fan out across several user-selected
// models, but content creation (the actual article rewrite, structural
// additions, coverage verification) always runs on this one model — merging
// multiple models' verbatim-preserving chunk edits isn't reliable, so a single
// writer keeps that stage correct and cost bounded.
const WRITER_MODEL_ID = DEFAULT_MODEL_ID;

function resolveModelIds(ids) {
  const arr = Array.isArray(ids) ? ids : [ids];
  const resolved = [...new Set(arr.map(resolveModelId))];
  return resolved.length ? resolved : [DEFAULT_MODEL_ID];
}

function providerForModel(modelId) {
  return MODEL_OPTIONS.find(m => m.id === modelId)?.provider || 'openai';
}

function stripJsonFence(text) {
  const trimmed = (text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// Returns a client shaped like the `openai` package's client (`.chat.completions
// .create`), backed by whichever provider `modelId` belongs to. `client.model`
// carries the resolved model id so call sites can do `model: client.model`
// instead of a hardcoded string.
function createLlmClient(modelId) {
  const resolved = resolveModelId(modelId);
  const provider = providerForModel(resolved);

  let client;
  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured on the server.');
    client = new OpenAI({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: 'https://api.anthropic.com/v1/' });
  } else if (provider === 'google') {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured on the server.');
    client = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' });
  } else {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  client.model = resolved;
  client.provider = provider;

  if (provider !== 'openai') {
    const rawCreate = client.chat.completions.create.bind(client.chat.completions);
    // `options` is the SDK's per-request second argument ({ timeout, maxRetries,
    // signal }). The wrapper used to take `params` alone, so a caller's timeout
    // was dropped without a word and every Claude call ran on the SDK default of
    // ten minutes with two retries.
    client.chat.completions.create = async (params, options) => {
      const {
        max_completion_tokens, max_tokens, response_format, messages, temperature, ...rest
      } = params;

      // Anthropic's current models reject `temperature` outright ("temperature
      // is deprecated for this model", HTTP 400), and every call site here was
      // written against OpenAI where passing it is normal. Dropping it for that
      // provider keeps those call sites unchanged instead of making each one
      // learn which parameters its model tolerates.
      //
      // Google is left alone: it accepts temperature, and silently discarding a
      // caller's sampling choice where it would have worked is its own bug.
      const sampling = provider === 'anthropic' ? {} : { temperature };
      const wantsJson = response_format?.type === 'json_object';
      const finalMessages = wantsJson
        ? messages.map((m, i) => (i === 0 && m.role === 'system'
            ? { ...m, content: `${m.content}\n\nRespond with ONLY raw valid JSON — no markdown code fences, no commentary before or after.` }
            : m))
        : messages;
      const res = await rawCreate({
        ...rest,
        ...sampling,
        max_completion_tokens: max_completion_tokens || max_tokens || DEFAULT_MAX_OUTPUT_TOKENS,
        messages: finalMessages,
      }, options);
      if (wantsJson && res.choices?.[0]?.message) {
        res.choices[0].message.content = stripJsonFence(res.choices[0].message.content);
      }
      return res;
    };
  }

  return client;
}

/**
 * Extra request params for a short, structured JSON task (classify, name,
 * judge) on a client from createLlmClient.
 *
 * Claude Sonnet 5 thinks adaptively unless told not to, and those thinking
 * tokens are drawn from the same max_tokens as the visible reply. On a
 * 2,048-token cluster-naming call the thinking grew until the JSON was cut off
 * mid-string — measured: the same 3,700-character answer cost 1,389 tokens one
 * time and 3,146 the next — so whole batches fell back to stemmed mechanical
 * names ("Keyword Analysi & Keyword Research Strategi"). These tasks gain
 * nothing from thinking; turning it off makes the output budget the reply's
 * alone, and the call about twice as fast.
 *
 * Only Anthropic accepts the parameter; the other providers get nothing extra.
 */
function structuredTaskParams(client) {
  return client && client.provider === 'anthropic' ? { thinking: { type: 'disabled' } } : {};
}

/**
 * Throws when a reply stopped at its output limit, so a caller reports "cut
 * off" rather than a baffling JSON parse error on half an answer.
 */
function assertNotTruncated(completion) {
  if (completion?.choices?.[0]?.finish_reason === 'length') {
    throw new Error('the reply was cut off at its output limit');
  }
}

module.exports = { structuredTaskParams, assertNotTruncated, MODEL_OPTIONS, DEFAULT_MODEL_ID, WRITER_MODEL_ID, resolveModelId, resolveModelIds, providerForModel, createLlmClient };
