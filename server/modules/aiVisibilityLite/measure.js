// ── Measuring one prompt on one API surface ──────────────────────────────────
//
// THIS FILE IS THE ONE PLACE THIS MODULE DUPLICATES v1, AND THE DUPLICATION IS
// ORCHESTRATION ONLY. Every judgement — does this text name the brand, does
// this citation point at their domain, how prominent was the mention, which
// competitors were named — is v1's function, imported and called here. Nothing
// about what a number MEANS is reimplemented.
//
// Why it could not simply be reused: v1's capture.measure() resolves its
// surface through v1's own registry (`surfaceFor(surfaceId)` in capture.js), so
// reusing it would require registering API surfaces inside the module this work
// is not allowed to modify. The alternative was a three-line additive edit to
// v1's registry; a separate ~90-line orchestrator was chosen instead because it
// keeps the two modules genuinely independent, which is what the brief asked
// for going forward.
//
// ── The rule this file exists to enforce ───────────────────────────────────
//
//   A CAPTURE THAT FAILED IS NOT AN ABSENCE OF THE BRAND.
//
// Copied verbatim from v1's capture.js because it is the whole point. If a
// provider times out, runs out of credit, or returns a shape we cannot read,
// and that is stored as `mentioned: false`, the report tells a client "you are
// invisible in ChatGPT" when in fact the pipeline broke. It is silent, and
// providers fail regularly. So a failed capture is `mentioned: null`,
// `status: 'failed'`, the prompt counts as NOT MEASURED, and the run reports
// its coverage.
//
// ── One difference from v1, and it is deliberate ───────────────────────────
//
// v1 stores a NO_ANSWER row for SERP surfaces, where "no AI Overview for this
// query" is a real, measured absence. There is no such thing here: all three
// surfaces are chat models, and a chat model asked a question always replies.
// An empty answer means we failed to read one. Every surface therefore sets
// ALWAYS_ANSWERS and an empty answer is a FAILURE, never a measured zero.

const {
  STATUS, MIN_ANSWER_CHARS, namesBrand, citesDomain, prominenceOf, competitorsNamed, validate,
} = require('../aiVisibility/capture');
const { surfaceFor } = require('./surfaces');

/**
 * What the engine DID — 'web_search', 'prose'.
 *
 * Reads both positions for the same reason v1 does: top level is where the
 * surface contract says it belongs, `raw` is where older adapters put it. All
 * three surfaces here set it top level, so this is belt and braces against a
 * future adapter that forgets.
 */
function featuresOf(captured) {
  if (Array.isArray(captured?.features)) return captured.features;
  if (Array.isArray(captured?.raw?.features)) return captured.raw.features;
  return [];
}

/**
 * Measure one prompt on one surface.
 *
 * Never throws. Every outcome — success, provider failure, a refusal — comes
 * back as a row, because the run has to account for every prompt it was asked
 * to measure. A thrown error would lose the other prompts in the run.
 *
 * @param {object} input
 * @param {string} input.surfaceId   'openai:api' | 'anthropic:api' | 'google:api'
 * @param {string} input.prompt      the question, as a person would type it
 * @param {object} input.brand       {name, domain, aliases[]}
 * @param {object[]} input.competitors  [{name, aliases[]}]
 * @returns {Promise<object>} a row ready for store.recordCapture
 */
async function measure({ surfaceId, prompt, brand, competitors = [] }) {
  const surface = surfaceFor(surfaceId);

  const base = {
    surfaceId,
    prompt,
    engine: surface?.ENGINE || null,
    provider: surface?.PROVIDER || null,
    access: surface?.ACCESS || null,
    surfaceLabel: surface?.LABEL || surfaceId,
    capturedAt: new Date().toISOString(),
    // Null until proven otherwise. Every early return below leaves these null,
    // which is the entire safety property of this function.
    mentioned: null,
    cited: null,
    prominence: null,
    competitorsMentioned: null,
    citations: [],
    answerText: null,
    taskCost: null,
    features: [],
    webQueries: [],
    grounded: null,
  };

  if (!surface) {
    return { ...base, status: STATUS.FAILED, failureReason: `no surface registered for "${surfaceId}"` };
  }

  // One extra attempt, and only for an answer too short to read. Bounded the
  // same way v1 bounds it, and safe for the same reason: a short answer is
  // already classified as not-measured rather than absent, so a retry can never
  // turn a real absence into a mention. It can only recover a read failure.
  const MAX_ATTEMPTS = surface.ALWAYS_ANSWERS ? 2 : 1;
  let attempts = 0;
  let captured;

  try {
    /* eslint-disable no-await-in-loop */
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      attempts += 1;
      captured = await surface.capture(prompt);
      const got = typeof captured?.answerText === 'string' ? captured.answerText.trim() : '';
      if (got.length >= MIN_ANSWER_CHARS) break;
    }
    /* eslint-enable no-await-in-loop */
  } catch (e) {
    // A provider failure. The brand's presence is unknown, not absent.
    return {
      ...base,
      status: STATUS.FAILED,
      failureReason: e.message,
      raw: { attempts, failureCode: e.code || null },
    };
  }

  const finalText = typeof captured?.answerText === 'string' ? captured.answerText.trim() : '';
  const recoveredOnRetry = attempts > 1 && finalText.length >= MIN_ANSWER_CHARS;

  // v1's validator: catches a missing response and an answer short enough to be
  // a refusal or a truncated stream rather than something to scan for a brand.
  const invalid = validate(captured);
  if (invalid) {
    return {
      ...base,
      status: STATUS.FAILED,
      failureReason: invalid,
      taskCost: captured.taskCost ?? null,
      grounded: captured.grounded ?? null,
      raw: { ...(captured.raw || {}), attempts, recoveredOnRetry },
    };
  }

  if (!finalText) {
    // Every surface here is a chat model, so this is unreadable output, not an
    // absence. State what was seen and let someone read it — never a cause.
    const seen = [
      captured.raw?.finishReason ? `finish reason ${captured.raw.finishReason}` : null,
      captured.raw?.stopReason ? `stop reason ${captured.raw.stopReason}` : null,
      captured.raw?.incompleteReason ? `incomplete: ${captured.raw.incompleteReason}` : null,
      attempts > 1 ? `retried ${attempts - 1}x` : null,
    ].filter(Boolean).join('; ');

    return {
      ...base,
      status: STATUS.FAILED,
      failureReason: 'the model returned an empty answer, which a chat surface never '
        + 'legitimately does' + (seen ? ` — ${seen}` : ''),
      taskCost: captured.taskCost ?? null,
      grounded: captured.grounded ?? null,
      raw: { ...(captured.raw || {}), attempts, recoveredOnRetry },
    };
  }

  const names = [brand?.name, ...(brand?.aliases || [])].filter(Boolean);
  const citations = Array.isArray(captured.citations) ? captured.citations : [];

  return {
    ...base,
    status: STATUS.OK,
    answerText: finalText,
    citations,
    // Every one of these five is v1's function. This module decides nothing
    // about what counts as a mention.
    mentioned: namesBrand(finalText, names),
    cited: citesDomain(citations, brand?.domain),
    prominence: prominenceOf(finalText, names),
    competitorsMentioned: competitorsNamed(finalText, competitors),
    webQueries: captured.webQueries || [],
    features: featuresOf(captured),
    // Not a metric — a provenance fact. An answer the model produced without
    // searching describes its training data, and a report that averaged those
    // together with grounded answers would be reporting two different things
    // under one number.
    grounded: captured.grounded ?? null,
    modelVersion: captured.modelVersion || null,
    taskCost: captured.taskCost ?? null,
    failureReason: null,
    raw: { ...(captured.raw || {}), attempts, recoveredOnRetry },
  };
}

module.exports = { measure, featuresOf };
