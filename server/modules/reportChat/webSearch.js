// ── The assistant's web search ──────────────────────────────────────────────
//
// SEO and AI search change month to month, and the chat model's training does
// not. For anything time-sensitive — a Google update, how AI Overviews behave
// now, a statistic — the model calls `web_search`, and this runs one OpenAI
// Responses API call with the hosted web_search tool and hands back a short
// summary plus the pages it cited.
//
// A tool inside the chat-completions loop rather than moving the whole chat to
// the Responses API: the loop, the calculator and the provider-neutral client
// (services/llmProviders.js) all stay as they are, and search runs only when
// the model decides a question needs it. Same Responses call shape as
// aiVisibilityLite/surfaces/openaiApi.js, whose output readers it reuses.
//
// Never throws: a failed search goes back to the model as an error it must
// own up to, rather than failing the whole answer.

const OpenAI = require('openai');
const { answerFrom, citationsFrom } = require('../aiVisibilityLite/surfaces/openaiApi');

const SEARCH_MODEL = () => process.env.REPORT_CHAT_SEARCH_MODEL || 'gpt-5.4-mini';
const TIMEOUT_MS = 45_000;
const MAX_SOURCES = 8;
const MAX_SUMMARY_CHARS = 4000;

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current SEO / GEO / AI-search information: recent Google or AI-search updates, '
      + 'how features behave now, dates, statistics, benchmarks. Returns a summary and its sources. '
      + 'Use it only for time-sensitive or factual questions your own knowledge may have out of date; not for this project\'s data.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A focused search query, e.g. "Google March 2026 core update what changed".' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

const INSTRUCTION = 'Search the web and answer for an SEO professional. Be factual and concise (under 250 words). '
  + 'Include dates and figures only when the sources state them, and say when sources disagree or are uncertain.';

let client = null;
const openai = () => (client ||= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: TIMEOUT_MS, maxRetries: 1 }));

/** http(s) only, short titles, at most MAX_SOURCES, no duplicates. */
function cleanSources(list) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    let url;
    try { url = new URL(String(s?.url || '')); } catch { continue; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    // Tracking and session parameters the search adds (utm_source=openai…).
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|_bhlid$|authuser$|gclid$|fbclid$|mc_|tab$)/i.test(key)) url.searchParams.delete(key);
    }
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({
      title: String(s?.title || url.hostname.replace(/^www\./, '')).slice(0, 200),
      url: href,
    });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/**
 * @param {string} query
 * @param {object} [deps] { client } — a Responses-shaped client, for tests
 * @returns {Promise<{ summary?: string, sources: Array, error?: string }>}
 */
async function runWebSearch(query, { client: injected } = {}) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return { error: 'empty query', sources: [] };
  if (!injected && !process.env.OPENAI_API_KEY) return { error: 'web search is not configured', sources: [] };
  try {
    const res = await (injected || openai()).responses.create({
      model: SEARCH_MODEL(),
      input: `${INSTRUCTION}\n\nQuestion: ${q}`,
      tools: [{ type: 'web_search' }],
      max_tool_calls: 3,
      reasoning: { effort: 'low' },
      max_output_tokens: 3000,
    });
    const summary = answerFrom(res).slice(0, MAX_SUMMARY_CHARS);
    if (!summary) return { error: 'the search returned nothing usable', sources: [] };
    return { summary, sources: cleanSources(citationsFrom(res)) };
  } catch (e) {
    console.warn('[reportChat] web search failed:', e.message);
    return { error: 'the web search failed', sources: [] };
  }
}

module.exports = { WEB_SEARCH_TOOL, runWebSearch, cleanSources, MAX_SOURCES };
