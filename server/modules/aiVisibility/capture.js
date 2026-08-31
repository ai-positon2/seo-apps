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

const { surfaceFor, needsProxy } = require('./surfaces');
const proxyPool = require('./captureEngines/proxyPool');

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
/**
 * The answer's shape, from wherever the surface recorded it.
 *
 * `features` is not in the surface contract, so adapters put it in `raw`. This
 * accepts both rather than silently returning nothing for every surface that
 * follows the existing convention.
 */
function featuresOf(captured) {
  if (Array.isArray(captured?.features)) return captured.features;
  if (Array.isArray(captured?.raw?.features)) return captured.raw.features;
  return [];
}

async function measure({
  surfaceId, prompt, brand, competitors = [], country = null, sessionKey = null,
}) {
  const surface = surfaceFor(surfaceId);

  const base = {
    surfaceId,
    prompt,
    engine: surface?.ENGINE || null,
    provider: surface?.PROVIDER || null,
    // HOW the answer was obtained, which is a different claim from WHO served
    // it. store.js defaulted this to 'scraped' for every row because nothing
    // ever set it, so a vendor-API capture would have described itself as
    // self-hosted — a provenance claim no reader could check.
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
  };

  if (!surface) {
    return { ...base, status: STATUS.FAILED, failureReason: `no surface registered for "${surfaceId}"` };
  }

  // ── Proxy ───────────────────────────────────────────────────────────────
  //
  // A surface on the NEEDS_PROXY list does not run without one. Phase 0
  // measured that Google's refusal was a LOCALE MISMATCH, not fingerprinting —
  // so an exit IP in the wrong country does not fail loudly, it succeeds and
  // returns a differently-localised answer that we would record as a US
  // measurement. Refusing is the only honest option: a missing capture is
  // recoverable, a wrong one that looks right is not.
  let lease = { proxy: null };
  if (needsProxy(surfaceId)) {
    lease = proxyPool.getPool().lease({
      engine: surface.ENGINE, country, sessionKey,
    });
    if (!lease.proxy) {
      return {
        ...base,
        status: STATUS.FAILED,
        failureReason: `no proxy available (${lease.reason})`
          + (lease.retryInMs ? `, retry in ${Math.ceil(lease.retryInMs / 1000)}s` : ''),
      };
    }
  }

  const proxyOpts = lease.proxy
    ? {
      proxyUrl: lease.proxy.url,
      proxyAuth: lease.proxy.username
        ? { username: lease.proxy.username, password: lease.proxy.password }
        : null,
    }
    : {};

  // How many times the surface was asked. A chat surface that answers with
  // nothing was not read, so one more attempt is warranted — and recording the
  // attempt count is what finally settles whether these failures are a
  // server-side limit (a retry fails too) or a read problem (a retry works).
  //
  // Bounded at one extra attempt, and only on the empty-answer path: this can
  // never turn a real absence into a mention, because an empty answer from a
  // chat surface is already classified as not-measured rather than absent.
  const MAX_ATTEMPTS = surface.ALWAYS_ANSWERS ? 2 : 1;
  let attempts = 0;
  let recoveredOnRetry = false;

  let captured;
  try {
    /* eslint-disable no-await-in-loop */
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      attempts += 1;
      captured = await surface.capture(prompt, proxyOpts);
      const got = typeof captured?.answerText === 'string' ? captured.answerText.trim() : '';
      // A stream that stopped after 12 characters was read no more successfully
      // than one that produced nothing; both are a read failure and both are
      // worth one more attempt. Only empty was retried before.
      if (got.length >= MIN_ANSWER_CHARS) break;
      if (!surface.ALWAYS_ANSWERS) break;
    }
    /* eslint-enable no-await-in-loop */

    const finalText = typeof captured?.answerText === 'string' ? captured.answerText.trim() : '';
    // "Recovered" has to mean the retry produced a USABLE answer. Any text at
    // all was enough before, so a retry that came back with the same 12
    // characters — still short enough to fail validation below — reported
    // itself as a recovery, corrupting the one signal that distinguishes a
    // read problem from a server-side limit.
    recoveredOnRetry = attempts > 1 && finalText.length >= MIN_ANSWER_CHARS;
    // A wall burns the address immediately rather than counting toward the
    // failure threshold — one more request confirms nothing and deepens it.
    if (lease.proxy) {
      proxyPool.getPool().release(lease.proxy, {
        ok: !captured?.blocked,
        blocked: Boolean(captured?.blocked),
      });
    }
  } catch (e) {
    if (lease.proxy) {
      proxyPool.getPool().release(lease.proxy, {
        ok: false,
        blocked: /sorry|captcha|blocked|429|forbidden/i.test(e.message || ''),
      });
    }
    // A provider failure. The brand's presence is unknown, not absent.
    return {
      ...base,
      status: STATUS.FAILED,
      failureReason: e.message,
      raw: { attempts, failureCode: e.code || null },
    };
  }

  const invalid = validate(captured);
  if (invalid) {
    return {
      ...base,
      status: STATUS.FAILED,
      failureReason: invalid,
      taskCost: captured.taskCost ?? null,
      // Carried, like every other failure path. This one dropped `raw`, so a
      // truncated answer — the failure most in need of diagnosis — arrived with
      // no record of whether the question was even submitted.
      raw: { ...(captured.raw || {}), attempts, recoveredOnRetry },
    };
  }

  const answerText = typeof captured.answerText === 'string' ? captured.answerText.trim() : '';

  // An empty answer means two completely different things depending on the
  // surface, and conflating them fabricates absences.
  //
  // On a SERP surface it is a real, common result: plenty of queries have no AI
  // Overview at all, and the brand is genuinely not mentioned because there is
  // nothing to be mentioned in. That is a MEASURED absence.
  //
  // On a chat surface it is not. A conversation always produces a reply, so an
  // empty one means we failed to read it. Measured against Gemini: six
  // consecutive empty captures under rate limiting, arriving in normal time
  // with no error — indistinguishable from a real answer except for being
  // blank. Recording those as `mentioned: false` would have stored six
  // absences the engine never asserted.
  if (!answerText && surface.ALWAYS_ANSWERS) {
    // State the observation and the evidence, never a cause.
    //
    // This message used to end "most likely rate limited". That was a guess
    // written before there was any data, and because it travelled on every
    // failed row it was read as a finding: it sent a real investigation after
    // proxies and IP rotation. The actual cause was that the question was
    // never submitted and a still page was mistaken for a finished answer.
    // Whatever the next cause turns out to be, the row should carry what was
    // seen and let someone read it.
    const seen = [
      captured.raw?.submitted === false ? 'the question was never submitted' : null,
      captured.raw?.submitted === true && captured.raw?.sawAnswer === false
        ? 'the question was submitted but no answer ever appeared' : null,
      captured.raw?.settleTimedOut === true ? 'gave up waiting' : null,
      attempts > 1 ? `retried ${attempts - 1}x` : null,
    ].filter(Boolean).join('; ');

    return {
      ...base,
      status: STATUS.FAILED,
      failureReason: 'the engine returned an empty answer, which a chat surface '
        + 'never legitimately does'
        + (seen ? ` — ${seen}` : ''),
      taskCost: captured.taskCost ?? null,
      raw: { ...(captured.raw || {}), attempts, recoveredOnRetry },
    };
  }

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
    // What the engine actually did to answer — web_search, map, prose.
    //
    // Read from BOTH places on purpose. Every current adapter tucks this inside
    // `raw` alongside its own debugging fields, because `features` was never in
    // the documented surface contract — so a first fix that only read
    // `captured.features` found nothing and the column stayed empty.
    // Top level is where it belongs and is preferred; `raw` is where it is.
    features: featuresOf(captured),
    modelVersion: captured.modelVersion || null,
    taskCost: captured.taskCost ?? null,
    failureReason: null,
    // attempts/recoveredOnRetry travel on SUCCESS as well as failure. A retry
    // that worked is the row that answers whether these failures were ever a
    // server-side limit — a limit would refuse the retry too.
    raw: { ...(captured.raw || {}), attempts, recoveredOnRetry },
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
