// ── Measuring one prompt on one surface ──────────────────────────────────────
//
// This file exists for one rule, and the rule is the whole point of the module:
//
//   A CAPTURE THAT FAILED IS NOT AN ABSENCE OF THE BRAND.
//
// If a provider times out, runs out of credit, or returns a shape we cannot
// read, and that gets stored as `mentioned: false`, the report tells a client
// **"you are invisible in ChatGPT"** when in fact the pipeline broke. That is
// the worst thing this product can do, it is completely silent, and given that
// providers fail regularly — Elmo publishes a status board precisely because
// they do — it is not a hypothetical.
//
// So a failed capture is `mentioned: null` and `status: 'failed'`, the prompt
// counts as NOT MEASURED, and the run reports its coverage. This is the same
// §16.11 discipline `siteHealth` and `aggregatePages` already follow.

const { surfaceFor } = require('./surfaces');

// An answer shorter than this is a refusal, an error page, or a truncated
// stream — not something to scan for a brand name. Measured against real
// answers: a genuine "I don't have information about that" runs well past this.
const MIN_ANSWER_CHARS = 40;

const STATUS = {
  OK: 'captured',
  FAILED: 'failed',
  NO_ANSWER: 'no_answer',
};

/** Escape a string for use inside a RegExp. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does this text name the brand?
 *
 * Word-boundary matched, so "Gentle Dental" does not match inside a longer word
 * and a two-letter brand does not match every occurrence of those letters. Case
 * and surrounding punctuation are ignored.
 *
 * @param {string} text
 * @param {string[]} names  brand name plus any aliases
 */
function namesBrand(text, names) {
  if (!text) return false;
  for (const name of names) {
    const trimmed = String(name || '').trim();
    if (!trimmed) continue;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}([^\\p{L}\\p{N}]|$)`, 'iu');
    if (pattern.test(text)) return true;
  }
  return false;
}

/** Normalise a host for comparison: lowercase, no leading www. */
function normalizeHost(host) {
  return String(host || '').replace(/^www\./i, '').toLowerCase();
}

/**
 * Is the brand's own domain among the cited sources? true / false / null.
 *
 * Subdomains count — blog.example.com cites example.com — because a client's
 * content on their own subdomain is still their visibility.
 *
 * Three-valued on purpose. Google AI Overview citations arrive as redirects and
 * are resolved at capture time; resolution can partially fail. If two of nine
 * citations never resolved, "the brand is not cited" is not something we know
 * — the brand could be one of the two. So:
 *
 *   found among resolved            -> true
 *   all resolved, not found         -> false
 *   some unresolved, not found      -> null  (cannot rule it out)
 *
 * The same §16.11 rule as `mentioned`, one level down. A false here would tell
 * a client their own domain is never cited, which is a claim we have not earned.
 */
function citesDomain(citations, domain) {
  const target = normalizeHost(domain);
  if (!target) return false;

  let unresolved = 0;
  for (const c of citations) {
    // A citation with a usable domain is resolved, whatever the flag says — that
    // keeps this working for surfaces that never had a redirect to begin with.
    if (!c.domain) { unresolved += 1; continue; }
    const host = normalizeHost(c.domain);
    if (host === target || host.endsWith(`.${target}`)) return true;
  }
  return unresolved > 0 ? null : false;
}

/**
 * Where in the answer the brand first appears, as a fraction from 0 to 1.
 *
 * 0 is the opening words, 1 is the end. Null when not mentioned — NOT 1, which
 * would read as "mentioned, right at the bottom" and quietly turn an absence
 * into a weak presence.
 */
function prominenceOf(text, names) {
  if (!text) return null;
  let earliest = -1;
  for (const name of names) {
    const trimmed = String(name || '').trim();
    if (!trimmed) continue;
    const at = text.toLowerCase().indexOf(trimmed.toLowerCase());
    if (at >= 0 && (earliest === -1 || at < earliest)) earliest = at;
  }
  if (earliest < 0) return null;
  return text.length ? Math.min(1, earliest / text.length) : null;
}

/**
 * Which competitors the answer names, so share-of-voice is measurable.
 *
 * @param {string} text
 * @param {Array<{name: string, aliases?: string[]}>} competitors
 */
function competitorsNamed(text, competitors) {
  const named = [];
  for (const competitor of competitors || []) {
    const names = [competitor.name, ...(competitor.aliases || [])].filter(Boolean);
    if (namesBrand(text, names)) named.push(competitor.name);
  }
  return named;
}

/**
 * Validate what a surface returned before it is allowed to count.
 *
 * Returns null when the capture is usable, or a reason string when it is not.
 * The reason travels into the stored row so a coverage report can say WHY a
 * prompt was not measured — "8 provider timeout, 4 quota" is actionable where
 * "12 failed" is not.
 */
function validate(capture) {
  if (!capture) return 'the surface returned nothing';
  if (typeof capture.answerText !== 'string' || !capture.answerText.trim()) return null; // handled as NO_ANSWER
  if (capture.answerText.trim().length < MIN_ANSWER_CHARS) {
    return `answer was only ${capture.answerText.trim().length} characters, which is a refusal or a truncated stream rather than an answer`;
  }
  return null;
}

/**
 * Measure one prompt on one surface.
 *
 * Never throws. Every outcome — success, provider failure, an answer that
 * genuinely has no AI result — comes back as a row, because the run needs to
 * account for every prompt it was asked to measure.
 *
 * @param {object} input
 * @param {string} input.surfaceId   e.g. 'chatgpt:dataforseo'
 * @param {string} input.prompt
 * @param {object} input.brand       { name, aliases?: string[], domain }
 * @param {Array}  [input.competitors]
 * @returns {Promise<object>} a capture row, always
 */
async function measure({ surfaceId, prompt, brand, competitors = [] }) {
  const surface = surfaceFor(surfaceId);

  const base = {
    surfaceId,
    prompt,
    engine: surface?.ENGINE || null,
    provider: surface?.PROVIDER || null,
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
  };

  if (!surface) {
    return { ...base, status: STATUS.FAILED, failureReason: `no surface registered for "${surfaceId}"` };
  }

  let captured;
  try {
    captured = await surface.capture(prompt);
  } catch (e) {
    // A provider failure. The brand's presence is unknown, not absent.
    return { ...base, status: STATUS.FAILED, failureReason: e.message };
  }

  const invalid = validate(captured);
  if (invalid) {
    return {
      ...base,
      status: STATUS.FAILED,
      failureReason: invalid,
      taskCost: captured.taskCost ?? null,
    };
  }

  const answerText = typeof captured.answerText === 'string' ? captured.answerText.trim() : '';

  // A surface that ran fine and produced no answer is a real, common result —
  // plenty of queries have no AI Overview. It is measured, and the brand is
  // genuinely not mentioned, because there is nothing to be mentioned in.
  if (!answerText) {
    return {
      ...base,
      status: STATUS.NO_ANSWER,
      answerText: null,
      mentioned: false,
      cited: false,
      prominence: null,
      competitorsMentioned: [],
      citations: [],
      taskCost: captured.taskCost ?? null,
      failureReason: null,
      // Kept even though there is no answer. "No AI Overview for this query" and
      // "an AI Overview we failed to read" look identical from the outside, and
      // without the payload there is no way to tell them apart after the fact.
      // Verified against a real response: for a query Google shows no overview
      // for, item_types comes back as local_pack/organic/people_also_ask with no
      // ai_overview entry at all — so this really is an absence, not a miss.
      raw: captured.raw,
    };
  }

  const names = [brand?.name, ...(brand?.aliases || [])].filter(Boolean);
  const citations = Array.isArray(captured.citations) ? captured.citations : [];

  return {
    ...base,
    status: STATUS.OK,
    answerText,
    citations,
    mentioned: namesBrand(answerText, names),
    cited: citesDomain(citations, brand?.domain),
    prominence: prominenceOf(answerText, names),
    competitorsMentioned: competitorsNamed(answerText, competitors),
    webQueries: captured.webQueries || [],
    modelVersion: captured.modelVersion || null,
    taskCost: captured.taskCost ?? null,
    failureReason: null,
    raw: captured.raw,
  };
}

/**
 * A run's coverage, in the words a report should use.
 *
 * "38 of 50 prompts captured" is the sentence that stops a score being read as
 * the whole picture.
 */
function coverageOf(rows) {
  const measured = rows.filter((r) => r.mentioned !== null);
  const failed = rows.filter((r) => r.status === STATUS.FAILED);

  const reasons = new Map();
  for (const row of failed) {
    const key = row.failureReason || 'unknown';
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }

  return {
    total: rows.length,
    measured: measured.length,
    failed: failed.length,
    noAnswer: rows.filter((r) => r.status === STATUS.NO_ANSWER).length,
    failureReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })),
    // Null, not 0, when nothing was measured: a run that captured nothing has no
    // spend-per-prompt and no coverage rate to report.
    rate: rows.length ? measured.length / rows.length : null,
  };
}

module.exports = {
  STATUS,
  MIN_ANSWER_CHARS,
  measure,
  coverageOf,
  namesBrand,
  citesDomain,
  prominenceOf,
  competitorsNamed,
  normalizeHost,
  validate,
};
