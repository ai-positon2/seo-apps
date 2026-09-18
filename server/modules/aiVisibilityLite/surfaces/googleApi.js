// ── Gemini, asked directly, with Google Search grounding on ──────────────────
//
// Same `capture(prompt)` contract as every other surface.
//
// ── Why raw REST and not the shared client ─────────────────────────────────
//
// services/llmProviders.js reaches Gemini through Google's OpenAI-COMPATIBLE
// endpoint, and that endpoint does not carry the `google_search` tool. Without
// the tool the model answers from training data alone, which for this module is
// not a degraded measurement — it is a measurement of something else entirely.
// So this file talks to the native `generateContent` endpoint, where grounding
// exists, using the global fetch the rest of the codebase already uses for
// outbound HTTP (dataForSeoClient.js, pagePrompts.js).
//
// ── Grounding is the bill, and it is silent when it does not happen ────────
//
// Google returns `groundingMetadata` only when the search actually ran. A
// question the model felt confident answering from memory comes back looking
// exactly like a grounded answer except for that key being absent — same shape,
// same prose, no error. That is why `grounded` is a stored column rather than
// something inferred at read time: the distinction is unrecoverable later.
//
// No system instruction, default temperature. Reasoning in openaiApi.js.

const {
  GOOGLE_MODEL, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS, costOf,
} = require('../models');

const ENGINE = 'google';
const PROVIDER = 'api';
const LABEL = 'Gemini (API · Google Search grounding)';
const ACCESS = 'api';

const ALWAYS_ANSWERS = true;

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function hasKey() {
  const k = process.env.GEMINI_API_KEY;
  return Boolean(k) && k !== 'your_gemini_api_key_here';
}

/** The prose, joined across parts. */
function answerFrom(body) {
  const parts = body?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => typeof p?.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
}

/**
 * Citations in v1's shape: {url, title, domain, index}.
 *
 * `groundingChunks[].web.uri` is a Vertex redirect rather than the publisher's
 * own URL, and it does not resolve without a round trip. The publisher is still
 * identifiable because `web.title` carries the domain for search results, so
 * the domain is taken from there and the redirect is kept as the url — the same
 * trade v1's Gemini surface makes with its attribution chips.
 *
 * This matters for `cited`: metrics match a citation to the client by DOMAIN,
 * and a row full of vertexaisearch redirects would report every client as
 * never cited.
 */
function citationsFrom(body) {
  const chunks = body?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const out = [];

  for (const chunk of chunks) {
    const web = chunk?.web;
    if (!web?.uri) continue;
    if (seen.has(web.uri)) continue;
    seen.add(web.uri);

    // `title` is the publisher domain for a web result ("example.com"), which
    // is precisely what is wanted. Fall back to parsing the uri for the shape
    // where it is a real URL rather than a redirect.
    let domain = null;
    const title = typeof web.title === 'string' ? web.title.trim() : '';
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title)) {
      domain = title.replace(/^www\./, '').toLowerCase();
    } else {
      try {
        const host = new URL(web.uri).hostname.replace(/^www\./, '');
        // A redirect host is not evidence about a publisher; null is the honest
        // answer, and citesDomain treats it as no match rather than a wrong one.
        domain = /vertexaisearch|googleapis\.com$/i.test(host) ? null : host;
      } catch { /* keep null */ }
    }

    out.push({
      url: web.uri,
      title: title || null,
      domain,
      index: out.length + 1,
    });
  }
  return out;
}

async function capture(prompt) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('An empty prompt cannot be measured.');
  if (!hasKey()) throw Object.assign(new Error('GEMINI_API_KEY is not configured.'), { code: 'not_configured' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  let body;
  try {
    res = await fetch(`${BASE_URL}/models/${encodeURIComponent(GOOGLE_MODEL)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        // The whole reason this file exists. An empty object is the correct
        // shape — the tool takes no configuration.
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: controller.signal,
    });
    body = await res.json().catch(() => null);
  } catch (e) {
    // An abort is a timeout, and saying so beats "The operation was aborted".
    if (e?.name === 'AbortError') {
      throw Object.assign(
        new Error(`Gemini did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`),
        { code: 'timeout' },
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = body?.error?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Gemini refused the request (${detail})`), {
      code: body?.error?.status || `http_${res.status}`,
    });
  }

  const meta = body?.candidates?.[0]?.groundingMetadata || null;
  const queries = Array.isArray(meta?.webSearchQueries) ? meta.webSearchQueries : [];
  // Billing for 3.x models is per search query executed, not per grounded
  // prompt — so the count that prices this call is the number of queries, and
  // a grounded answer that ran three searches costs three.
  const searches = queries.length;

  return {
    engine: ENGINE,
    provider: PROVIDER,
    surfaceLabel: LABEL,
    access: ACCESS,
    answerText: answerFrom(body) || null,
    citations: citationsFrom(body),
    webQueries: queries,
    providerBrands: [],
    features: [meta ? 'web_search' : null, 'prose'].filter(Boolean),
    // Presence of groundingMetadata, not of queries: a grounded answer that
    // reused a cached search reports metadata with an empty query list, and
    // calling that ungrounded would be wrong.
    grounded: Boolean(meta),
    modelVersion: body?.modelVersion || GOOGLE_MODEL,
    taskCost: costOf(GOOGLE_MODEL, {
      inputTokens: body?.usageMetadata?.promptTokenCount || 0,
      outputTokens: body?.usageMetadata?.candidatesTokenCount || 0,
      searches,
    }),
    capturedAt: new Date().toISOString(),
    raw: {
      usage: body?.usageMetadata || null,
      searches,
      grounded: Boolean(meta),
      // 'MAX_TOKENS' means truncated; 'SAFETY' / 'RECITATION' mean the model
      // declined, which is a real finding about the question and not a bug.
      finishReason: body?.candidates?.[0]?.finishReason || null,
    },
  };
}

module.exports = {
  capture, ENGINE, PROVIDER, LABEL, ACCESS, ALWAYS_ANSWERS, hasKey,
};
