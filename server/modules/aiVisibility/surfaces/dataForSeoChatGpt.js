// ── ChatGPT, as a consumer sees it ───────────────────────────────────────────
//
// DataForSEO's AI Optimization "LLM Scraper" drives the real chatgpt.com
// interface and reads the rendered answer back. That is the distinction this
// whole module rests on: the OpenAI API with a search tool answers the same
// question through a different retrieval stack and a different system prompt,
// so it is a *different measurement*, not a cheaper version of this one.
//
// Derived from Elmo (MIT) — see ../LICENSE-elmo.md.

const client = require('../dataForSeoClient');
const extract = require('../extract');

const PATH = '/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced';

const ENGINE = 'chatgpt';
const PROVIDER = 'dataforseo';

// What the report is allowed to call this. Not "ChatGPT" unqualified: the
// answer came from a driven consumer session at a point in time, and the label
// has to survive a client asking how it was obtained (PRD §6.2, §30).
const LABEL = 'ChatGPT (consumer UI · DataForSEO LLM Scraper)';

/**
 * Ask ChatGPT one prompt.
 *
 * @param {string} prompt
 * @returns {Promise<object>} the surface contract — see ./index.js
 */
async function capture(prompt) {
  client.assertPromptLength(prompt);

  // Retried, because this fails in the wild. One in roughly a dozen live calls
  // came back HTTP 500 after 112 seconds during validation, and over a 50-prompt
  // unattended run that is several prompts silently lost every time.
  //
  // Two attempts, not three: each one costs 25-110 seconds of wall clock, and a
  // failed task is not charged (the 500 returned no cost), so the trade is time
  // rather than money. A prompt that fails twice is reported as not measured,
  // which is the honest outcome.
  const { result, raw, taskCost } = await client.postTaskWithRetry(PATH, {
    keyword: prompt,
    location_code: client.LOCATION_CODE,
    language_code: client.LANGUAGE_CODE,
    // ChatGPT decides per prompt whether to search. Left to itself, the same
    // prompt browses on Monday and answers from weights on Tuesday, and a
    // month-over-month trend would be measuring that coin-flip rather than the
    // client's visibility. Forcing it makes every run the browsing experience.
    force_web_search: true,
  }, { attempts: 2, backoffMs: 4000 });

  const answerText = extract.textFromScraper(raw);
  const citations = extract.citationsFromScraper(raw);

  return {
    engine: ENGINE,
    provider: PROVIDER,
    surfaceLabel: LABEL,
    access: 'scraped',
    answerText,
    citations,
    webQueries: extract.fanOutQueries(raw),
    providerBrands: extract.brandEntities(raw),
    modelVersion: result.model || null,
    taskCost,
    capturedAt: new Date().toISOString(),
    raw,
  };
}

module.exports = { capture, ENGINE, PROVIDER, LABEL, PATH };
