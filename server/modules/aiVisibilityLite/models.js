// ── Which model answers, and what that costs ─────────────────────────────────
//
// One file, because a model name is a moving target and the cheapest tier moves
// fastest of all. llmExtract.js already learned this the hard way: a pinned
// model name that gets deprecated is a SILENT, TOTAL failure of the pass, and
// it should never need a code change to survive one. Every id here is therefore
// overridable by environment variable.
//
// ── Why these three ────────────────────────────────────────────────────────
//
// The brief was "cheapest model per provider that supports the web-search
// tool". That last clause does most of the work: without a search tool the
// model answers from training data, which measures what it memorised about a
// brand in 2024 rather than what it would tell a buyer today. Those are
// different questions and only one of them is this product.
//
// Verified against each provider's live pricing page on 2026-09-18:
//
//   openai     gpt-5-nano            $0.05 / $0.40 per MTok
//                                    web_search on the Responses API,
//                                    $10 per 1,000 calls (reasoning-model tier,
//                                    search content billed at model rates)
//
//   anthropic  claude-haiku-4-5      $1.00 / $5.00 per MTok
//                                    web_search_20250305, $10 per 1,000 searches
//
//   google     gemini-3.5-flash-lite $0.30 / $2.50 per MTok
//                                    google_search grounding, $14 per 1,000
//                                    searches after 5,000 free per month
//                                    (shared across all Gemini 3.x models)
//
// ── Two findings worth keeping, because both are counter-intuitive ─────────
//
// 1. The Anthropic model id carries NO date suffix. `claude-haiku-4-5-20251001`
//    is not a valid id — dated snapshots are a Vertex convention, not a Claude
//    API one, and the API rejects it.
//
// 2. gemini-2.5-flash-lite has cheaper TOKENS than 3.5-flash-lite and is the
//    wrong choice anyway. Grounding, not tokens, dominates this workload, and
//    2.5-era models are billed per grounded PROMPT at $35/1,000 against 3.x's
//    $14/1,000 per search plus a 5,000/month free allowance. Picking the model
//    with the cheaper token rate here costs roughly twice as much per run.
//    Tokens are the rounding error; the tool call is the bill.
//
// At the 20-run cap a project tops out near $22 across all three providers,
// with Anthropic the largest line — Haiku's tokens cost 20x nano's, and search
// results land in the context as input tokens on every call.

const OPENAI_MODEL = process.env.AIVL_OPENAI_MODEL || 'gpt-5-nano';
const ANTHROPIC_MODEL = process.env.AIVL_ANTHROPIC_MODEL || 'claude-haiku-4-5';
const GOOGLE_MODEL = process.env.AIVL_GOOGLE_MODEL || 'gemini-3.5-flash-lite';

// The web-search tool version for Anthropic.
//
// `web_search_20260209` — the dynamic-filtering variant — requires Opus 4.6+ or
// Sonnet 4.6+. Haiku 4.5 is not in that set and rejects it, so the basic
// variant is the correct one here, not a fallback. Overridable for the day a
// cheap model gains the newer tool.
const ANTHROPIC_WEB_SEARCH_TOOL = process.env.AIVL_ANTHROPIC_SEARCH_TOOL || 'web_search_20250305';

// How many searches one answer may run. A buyer asking a question gets one
// round of retrieval, not a research project, and each search is billed.
const MAX_SEARCHES_PER_ANSWER = 5;

// Ceiling on the answer itself. Long enough for a real recommendation with a
// list of options; short enough that a model which starts rambling does not
// bill for it. Measured against v1's stored answers: a genuine ChatGPT
// recommendation runs 200–600 words.
const MAX_OUTPUT_TOKENS = 1_500;

// ── The same ceiling means something different on a reasoning model ────────
//
// On OpenAI's Responses API `max_output_tokens` covers REASONING TOKENS AND THE
// VISIBLE ANSWER TOGETHER, and gpt-5-nano is a reasoning model. At 1,500 the
// first real run failed 8 of 10 OpenAI captures: the stored rows show
// output_tokens 1472 of which reasoning_tokens 1472 — the entire budget spent
// thinking, nothing left to say — with status `incomplete` and
// incomplete_reason `max_output_tokens`. The two that survived were 94
// characters of truncated fragment.
//
// Two changes, because either alone is a half fix:
//
//   • the budget is raised, so reasoning and an answer both fit
//   • reasoning effort is set LOW, because this is not a reasoning task. The
//     module is simulating a buyer typing a question into a chat box; thinking
//     harder about "what's a good dentist in Raleigh" produces the same answer
//     and bills for a thousand invisible tokens to reach it.
//
// Reasoning tokens are billed as output either way, so low effort is both the
// correct behaviour and the cheaper one.
const OPENAI_MAX_OUTPUT_TOKENS = Number(process.env.AIVL_OPENAI_MAX_OUTPUT_TOKENS) || 4_000;
const OPENAI_REASONING_EFFORT = process.env.AIVL_OPENAI_REASONING_EFFORT || 'low';

// One API call's wall clock. A grounded answer does a search round trip inside
// it, so this is longer than a plain completion would need.
const REQUEST_TIMEOUT_MS = 90_000;

// The prompt-set size limits from the brief. Here rather than in store.js so
// the route, the generator and the UI all read the same number.
const AUTO_PROMPT_COUNT = 10;
const MAX_PROMPTS = 20;

// The per-project measurement budget. Enforced server-side in run.js — a UI
// that hides the button is a courtesy, not a cap.
//
// 20, not 30: at roughly $1.10 a run this is the difference between a ~$22 and
// a ~$32 ceiling per project, and 20 runs is already a year of fortnightly
// measurement. Raising it later is a one-line change that costs nothing
// retroactively, because the cap is checked against a live count rather than
// written onto each project when it is created.
const MAX_RUNS_PER_PROJECT = 20;

// ── What one capture cost ──────────────────────────────────────────────────
//
// The captures table has a `task_cost` column and 0016's rule for it is that
// NULL means unknown, never free. v1 gets a real number because DataForSEO
// reports one; these three providers do not, so it is computed here from token
// counts the response DOES report, plus the metered tool call.
//
// Rates travel next to the model ids on purpose — when a price moves, both the
// id and the arithmetic that prices it are on the same screen. Per million
// tokens, verified 2026-09-18. `search` is per tool call, not per thousand.
const PRICING = {
  'gpt-5-nano': { input: 0.05, output: 0.40, search: 0.010 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00, search: 0.010 },
  'gemini-3.5-flash-lite': { input: 0.30, output: 2.50, search: 0.014 },
  // Kept so a project pinned to it by env var still prices correctly, even
  // though it is not the default for the reason in the header.
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40, search: 0.035 },
};

/**
 * What one call cost, in dollars, or null if we cannot say.
 *
 * Null rather than 0 for an unpriced model: a model nobody put a rate in for
 * has an UNKNOWN cost, and a zero would quietly understate a project's spend
 * in exactly the case where somebody has switched to something unfamiliar.
 */
function costOf(model, { inputTokens = 0, outputTokens = 0, searches = 0 } = {}) {
  const rate = PRICING[model];
  if (!rate) return null;
  const dollars = (inputTokens / 1e6) * rate.input
    + (outputTokens / 1e6) * rate.output
    + searches * rate.search;
  // The column is numeric(10,5). Rounding here rather than letting Postgres do
  // it keeps the stored number and the number a test asserts identical.
  return Math.round(dollars * 1e5) / 1e5;
}

module.exports = {
  OPENAI_MODEL,
  ANTHROPIC_MODEL,
  GOOGLE_MODEL,
  PRICING,
  costOf,
  ANTHROPIC_WEB_SEARCH_TOOL,
  MAX_SEARCHES_PER_ANSWER,
  MAX_OUTPUT_TOKENS,
  OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_REASONING_EFFORT,
  REQUEST_TIMEOUT_MS,
  AUTO_PROMPT_COUNT,
  MAX_PROMPTS,
  MAX_RUNS_PER_PROJECT,
};
