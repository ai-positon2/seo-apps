// ── Google AI Overview ───────────────────────────────────────────────────────
//
// The AI summary block on a normal Google results page. It comes from the
// ORGANIC SERP endpoint, not AI Mode's dedicated one, arriving as an `items[]`
// entry of type `ai_overview` — which is why this has its own runner rather
// than sharing the AI Mode path.
//
// Derived from Elmo (MIT) — see ../LICENSE-elmo.md.

const client = require('../dataForSeoClient');
const extract = require('../extract');
const { resolveCitations } = require('../resolveRedirects');

const PATH = '/v3/serp/google/organic/live/advanced';

const ENGINE = 'google_ai_overview';
const PROVIDER = 'dataforseo';
const LABEL = 'Google AI Overview (DataForSEO SERP)';

/**
 * Ask Google one prompt and read its AI Overview.
 *
 * Two things here are learned-the-hard-way rather than obvious, both carried
 * over from Elmo:
 *
 *   `load_async_ai_overview` — AI Overviews are generated on demand. Without
 *   this flag DataForSEO returns only what it happened to have cached, so most
 *   runs come back empty and the report reads as "no AI Overview for this
 *   query" when in fact none was ever requested.
 *
 *   the retry — this async path intermittently fails on DataForSEO's side with
 *   a task-level "Internal SE Server Error". A couple of attempts clear it, and
 *   without them a transient blip becomes a permanent gap in a client's report.
 *
 * A prompt genuinely having no AI Overview is a real and common answer, and is
 * returned as `answerText: null` — distinct from a failure, which throws.
 */
async function capture(prompt) {
  client.assertPromptLength(prompt);

  const { raw, taskCost } = await client.postTaskWithRetry(PATH, {
    keyword: prompt,
    location_code: client.LOCATION_CODE,
    language_code: client.LANGUAGE_CODE,
    depth: 10,
    load_async_ai_overview: true,
  });

  // Every reference here is a google.com/goto redirect, so the real source has
  // to be recovered before anything downstream reads a domain. Done at capture
  // time because these links are short-lived.
  const citations = await resolveCitations(extract.citationsFromGoogle(raw));

  return {
    engine: ENGINE,
    provider: PROVIDER,
    surfaceLabel: LABEL,
    access: 'scraped',
    answerText: extract.textFromGoogle(raw),
    citations,
    // Google never exposes the queries behind an AI Overview.
    webQueries: [],
    providerBrands: [],
    modelVersion: null,
    taskCost,
    capturedAt: new Date().toISOString(),
    raw,
  };
}

module.exports = { capture, ENGINE, PROVIDER, LABEL, PATH };
