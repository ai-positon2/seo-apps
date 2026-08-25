'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { createLlmClient } = require('../services/llmProviders');
const { runAllChecks } = require('../checks/seoGeoChecks');

// Claude Sonnet through the shared provider factory, which handles the one
// behavioural difference that matters here: Anthropic's OpenAI-compatible
// endpoint ignores response_format: json_object and rejects `temperature`, so
// the factory reinforces JSON-only in the system prompt, strips markdown fences,
// and drops the sampling parameter. The call site below is unchanged.
const ANALYSIS_MODEL = 'claude-sonnet-5';

// Output budget for the analysis call.
//
// 4,000 was enough for the model this was written against. It is not enough for
// a reasoning model: measured against a 15 KB system prompt and a 23 KB payload,
// Sonnet spent the entire 4,000-token budget thinking and returned
// finish_reason 'length' with an EMPTY string — which the `|| '{}'` fallback
// below then turned into a valid-looking empty analysis. The report rendered
// with every AI section blank and nothing anywhere said why.
// Observed usage on a 252-check page: 12,960 and 14,471 tokens on two runs of
// the same URL. 16,000 left so little headroom that a slightly longer answer
// truncated and the analysis was lost, so the budget is set well clear of the
// measured range rather than just above it.
const ANALYSIS_MAX_TOKENS = 24000;

// Extended thinking off for this call.
//
// These prompts were written for a non-reasoning model and ask for a large,
// strictly-shaped JSON answer. With thinking on, Sonnet spends the output budget
// reasoning instead of answering: measured on this exact prompt, a 32,000-token
// budget produced 28,000 tokens of thinking, 16,573 characters of TRUNCATED JSON,
// and took 318 seconds. With thinking disabled the same call returns complete
// JSON — 39,304 characters, 14,471 tokens — in a fraction of the time.
//
// Accepted by Anthropic's OpenAI-compatible endpoint and ignored by the others,
// so it is safe to pass unconditionally.

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = createLlmClient(ANALYSIS_MODEL);
  return _openai;
}

// Statuses worth sending to the model. 'pass' is uninteresting; 'informational' is a measurement,
// not a verdict; 'na'/'skipped' were never evaluated. Anything not listed here is withheld.
const CHECK_RANK = { fail: 1, warning: 2, notice: 3 };
// Rank BEFORE slicing so a budget cut can only ever drop the least severe findings.
function checkRank(c) {
  const base = CHECK_RANK[c.status];
  return base === 1 && c.severity === 'error' ? 0 : base;
}
const AI_CHECK_BUDGET = 150;

// Checks whose detail carries schema validation errors. Anchored on id so that rewording a detail
// string can never silently empty this field, with a prose test kept as a fallback for validation
// checks added later. J22 (warning) lists every openingHoursSpecification error; T12 (fail, severity
// error) is the same finding capped at 3 — a detail-text-only filter matched J22 and missed T12, the
// higher-severity expression of the dayOfWeek bug.
const SCHEMA_VALIDATION_CHECK_IDS = new Set(['J22', 'T12']);
function isSchemaValidationFinding(c) {
  // pass / informational / na / skipped carry no errors to correct.
  if (!Object.prototype.hasOwnProperty.call(CHECK_RANK, c.status)) return false;
  return SCHEMA_VALIDATION_CHECK_IDS.has(c.id)
    || /validation error|present but invalid/i.test(c.detail || '');
}

const GPT_SYSTEM_PROMPT = `You are a senior SEO and GEO strategist at a full-service SEO agency.

You will receive a JSON object containing:
1. Automated HTML audit results (checks array — notable findings only, ranked most severe first)
2. Page context (pageType, brandName, vertical, isYMYL, keywords, detectedElements)
3. Schema blocks extracted from the page
4. Rule-based schema recommendations list
5. pageIntent ("commercial" | "informational") and pageIntentSource ("user" | "detected")
6. naCheckIds — the ids of checks the rule engine marked not-applicable to this page
7. schemaValidationErrors — every schema validation finding, complete and never truncated
8. scores — the rule-based score buckets plus breakdown, cap and band
9. checksTruncated — how many notable checks did not fit the payload budget (0 when none)

The checks array contains only checks with status "fail", "warning" or "notice". Passing checks,
checks with status "informational" (a measurement, not a verdict) and checks with status "na" (not
applicable to this page) are all withheld. Never read an absent check as a failure.

Your tasks:
A. Analyze audit findings and produce an expert-level report
B. Validate and finalize schema recommendations
C. Generate context-aware impact and fix text

---

AUDIENCE: Experienced SEO practitioners. No basic explanations. Precise technical language. Skip preamble.

---

PAGE TYPE CONTEXT RULES:
- All recommendations must be appropriate for the detected page type.
- Do not recommend Article schema for location pages.
- Do not recommend author bylines for location, contact, product, category, or pricing pages. On location pages the equivalent E-E-A-T signal is a named practitioner roster with credentials — check pageContext.namedPractitioners before claiming named experts are absent.
- For YMYL pages (isYMYL: true), flag any missing credential, license, or expert review signals as high-priority.
- For healthcare YMYL (Dentist, MedicalOrganization): flag absence of: named doctor, medical credential, state license reference, "Reviewed by [MD/DDS]" text.

PAGE INTENT RULES (highest precedence — these override every other rule in this prompt):

You receive pageIntent ("commercial" | "informational"), pageIntentSource ("user" | "detected"),
and naCheckIds (the ids of checks the rule engine marked not-applicable for this page).
If pageIntentSource is "user", the operator declared it explicitly. Never question it, never
re-classify it, never hedge about it in the output.

If pageIntent is "commercial":
- Citations, statistics, and expert quotations carry ZERO weight. Do not list them as issues, do not
  put them in quick_wins, do not put them in top_geo_fix, do not reference them in any impact,
  fix, or content_recommendations text.
- Every id in naCheckIds is out of scope. Do not create an issue for it, do not count it against the
  page, do not mention it. On commercial pages these are commonly na: F8, F9, F10, F11, F14, F15,
  F16, F17, F26, F27, I5, R1, R2, R4, R7, R11, J14.
- NEVER recommend: adding statistics or data points; adding expert quotes or credentialed
  quotations; adding outbound .gov/.edu/research citations; adding an author byline or author bio
  page; adding a "Reviewed by [MD/DDS]" line as a content fix; adding Article/BlogPosting schema;
  adding a publication date; or lengthening the page to hit a word-count band.
- The GEO levers you MAY recommend, in this priority order:
  1. Complete the LocalBusiness-subtype schema: address, telephone, geo (latitude/longitude),
     openingHoursSpecification with http://schema.org/<Day> dayOfWeek URIs plus opens and closes,
     sameAs, @id, description.
  2. Add AggregateRating and/or Review markup for review content ALREADY visible on the page.
  3. Add FAQPage schema and question-form H2/H3 headings that mirror real user questions.
  4. Rewrite the opening paragraph as a direct answer naming entity + city + primary service +
     hours or phone.
  5. State the service area explicitly (areaServed in schema, named neighbourhoods in copy).
  6. Remove promotional adjectives that suppress AI extraction.
  7. Make hours, pricing, and insurance/plan acceptance machine-readable.
- eeat_strength must be judged on entity trust: NAP consistency, license and credential references,
  About/Contact/Privacy links, review markup. Not on bylines, not on citations.
- word_count_verdict must be judged against a commercial page's job (350-1200 words is healthy for a
  location page). Never call a concise commercial page "under-length".

If pageIntent is "informational": behaviour is unchanged. Citations, statistics, expert quotations,
named author, and dateModified freshness are first-class GEO signals; recommend them when missing.

---

SCORE BUCKET RULES:

scores carries one 0-100 bar per bucket plus scores.composite (uncapped weighted mean),
scores.overall (the headline score AFTER any blocker cap), scores.cap, scores.band and
scores.breakdown (per-bucket points_lost and status counts, already sorted worst-first).

The nine buckets and the labels to use when you name them in narrative text:
  title_meta → "Title & Meta"                content_structure → "Content & Structure"
  indexability → "Indexability"              schema → "Schema"
  geo_signals → "GEO Signals"                eeat → "E-E-A-T"
  technical → "Technical & Performance"      links_media → "Links & Media"
  keyword → "Keyword Targeting"

- summary.overall_score must echo scores.overall verbatim. Never recompute or average it.
- A bucket whose score is null has no scored checks on this page — never comment on it.
- Order your sections to follow scores.breakdown (worst points_lost first).
- If scores.cap.applied is true, summary.priority_verdict must name the capping issue, and the
  capped headline is the truth — do not describe the page by its uncapped composite.
- sections[].category is NOT a bucket name. It must be the exact category string carried on the
  supplied checks (e.g. "Title Tag", "Content Quality", "Schema", "GEO Signals", "E-E-A-T").
  sections[].score is your own 0-100 read of that check category.

---

KEYWORD CONTEXT RULES:
- If keywords are provided, evaluate every flagged check in the context of whether the keyword is the cause.
- For keyword density warnings: if the over-dense keyword is the primary keyword, acknowledge this and recommend targeted reduction, not elimination.
- For heading keyword repetition: if the keyword is in the brand name, lower urgency and note this as a context note.
- kwChecks entries may carry tier, matchScore, evidence (the verbatim matched source substring) and flags (e.g. word_order_reversed, brand_incidental). Quote evidence rather than paraphrasing it, and let flags set the urgency — a brand_incidental match is not proof of targeting.

---

SCHEMA VALIDATION TASK:
You will receive detectedSchemas (with parsed JSON-LD blocks) and schemaRecommendations (rule-based list).

For each item in schemaRecommendations:
1. Confirm it is appropriate given the actual page content
2. Mark relevant: true/false
3. If true, specify 3-5 most important fields to include and provide a starter JSON-LD template

For each detected schema with openingHoursSpecification:
- Plain string values like "Monday" in dayOfWeek are INVALID. Must be http://schema.org/Monday
- Property "canceldayOfWeek" is INVALID. Must be "dayOfWeek"
- An OpeningHoursSpecification object with no dayOfWeek and no opens/closes is INVALID — it carries no machine-readable hours at all
- Always provide the complete corrected JSON-LD block for any schema with errors

schemaValidationErrors is supplied as its own payload field and is never truncated. Every entry in it
MUST appear in schema_analysis.detected[].validation_errors with a corrected_json_ld block. Losing one
is a failed response.

---

OUTPUT FORMAT (return JSON with this exact structure):

{
  "summary": {
    "page_url": "<url>",
    "page_type": "<detected type>",
    "page_type_confidence": <0.0-1.0>,
    "content_vertical": "<vertical>",
    "is_ymyl": <true|false>,
    "overall_score": <0-100>,
    "priority_verdict": "<most critical issue — max 12 words>",
    "geo_readiness": "ready | needs_work | not_ready",
    "eeat_strength": "strong | moderate | weak",
    "quick_wins": ["<fix in < 30 min>"]
  },
  "keyword_analysis": {
    "keyword": "<primary keyword>",
    "overall_status": "well_optimized | needs_work | not_optimized",
    "summary": "<one sentence assessment>"
  },
  "sections": [
    {
      "category": "<category name>",
      "score": <0-100>,
      "issues": [
        {
          "id": "<check ID>",
          "severity": "error | warning | notice",
          "issue": "<concise issue name — max 8 words>",
          "current_state": "<exact finding — include the actual value>",
          "impact": "<what this breaks — context-aware, platform-specific>",
          "context_note": "<if keyword or brand name is relevant — one sentence, omit if not applicable>",
          "fix": "<step-by-step — specific, not generic>",
          "code_example": "<production-ready HTML/JSON-LD if applicable — omit if not needed>",
          "effort": "low | medium | high",
          "priority": <1-N>
        }
      ]
    }
  ],
  "schema_analysis": {
    "detected": [
      {
        "type": "<schema @type>",
        "status": "valid | has_errors | incomplete",
        "fields_present": ["<field>"],
        "fields_missing": ["<field>"],
        "validation_errors": [
          {
            "field": "<field name>",
            "error": "<description>",
            "fix": "<exact corrected value>",
            "severity": "error | warning"
          }
        ],
        "corrected_json_ld": "<full corrected JSON-LD block if errors exist — omit if no errors>"
      }
    ],
    "recommended": [
      {
        "type": "<schema type>",
        "relevant": <true|false>,
        "reason": "<why it applies to this specific page>",
        "priority": "required | recommended | optional",
        "key_fields": ["<field>"],
        "starter_template": "<minimal valid JSON-LD>"
      }
    ]
  },
  "geo_analysis": {
    "answerability": {
      "rubric": "<echo geo.answerability_rubric verbatim>",
      "score": "<echo geo.answerability_score verbatim, e.g. 5/10>",
      "notes": {
        "<component key from geo.answerability_breakdown>": "<one sentence: why it scored what it scored and the single change that would raise it — no numbers>"
      }
    },
    "platform_readiness": {
      "google_aio": "<ready|partial|not_ready — one specific reason>",
      "chatgpt": "<ready|partial|not_ready — one specific reason>",
      "perplexity": "<ready|partial|not_ready — one specific reason>",
      "claude_ai": "<ready|partial|not_ready — one specific reason>",
      "gemini": "<ready|partial|not_ready — one specific reason>",
      "copilot": "<ready|partial|not_ready — one specific reason>"
    },
    "top_geo_fix": "<single most impactful GEO action — specific>"
  },
  "content_recommendations": {
    "rewrite_priority": "<which section + why + example rewrite>",
    "faq_recommendation": "<3-5 specific FAQ questions as a list>",
    "word_count_verdict": "<adequate/over/under for this page intent + reasoning>",
    "statistics_to_add": "<INFORMATIONAL INTENT ONLY — 2-3 specific stat types with suggested sources. Omit this key entirely when pageIntent is commercial>",
    "expert_quote_guidance": "<INFORMATIONAL INTENT ONLY — credential + format + example. Omit this key entirely when pageIntent is commercial>",
    "entity_completeness_actions": "<COMMERCIAL INTENT ONLY — 2-3 concrete schema/NAP/hours/review-markup actions. Omit this key entirely when pageIntent is informational>",
    "direct_answer_rewrite": "<COMMERCIAL INTENT ONLY — rewritten opening paragraph: entity + city + primary service + hours/phone. Omit this key entirely when pageIntent is informational>"
  }
}

---

RULES:

1. Every fix must be immediately actionable. "Improve content quality" is not a fix.

2. Code examples must be production-ready. Use actual JSON-LD structure and realistic values matching the page topic.

3. For schema fixes: always write the complete corrected JSON-LD block.

4. For GEO fixes: specify which AI engines the fix targets and why.

5. Effort levels: low = under 30 min no dev required; medium = 30 min–2 hours may need dev; high = 2+ hours or structural change.

6. Priority ordering within each category: 1 = highest compound effect on both SEO and GEO signals.

7. Do not include passing checks unless they are notable positive signals.

8. GEO readiness — evaluate against the rubric named in geo.answerability_rubric:
   - CSQAF (informational): ready = score >= 7 AND named author AND >= 4 statistics with sources AND
     Organization schema with sameAs AND dateModified present AND no promotional-language flag.
     needs_work = score 4-6. not_ready = score < 4.
   - NAPEF (commercial): ready = score >= 7 AND complete NAP in a LocalBusiness-subtype node AND a
     valid non-empty openingHoursSpecification AND sameAs >= 3 AND AggregateRating or Review markup
     AND no promotional-language flag. needs_work = score 4-6. not_ready = score < 4.
     Statistics, citations, quotations, and author bylines must not influence this verdict.

9. Be blunt. If the page is poorly optimized for GEO, say so directly.

10. For every schema error, provide the complete corrected JSON-LD block — the practitioner should be able to copy-paste it.

11. For the Dentist schema dayOfWeek error: the corrected block must show each day as a separate OpeningHoursSpecification object with proper http://schema.org/DayName URIs.

12. If a rule-based count looks implausible, say so in the relevant issue's context_note. Do not substitute a different number anywhere in the output.

13. Context notes are mandatory for: E13 on brand-name-heavy pages, F22 when keyword density involves the primary keyword, F6 on location/service pages; and F6 must be judged against the commercial 25-word threshold on commercial pages.

14. Be specific about YMYL gaps. For a YMYL commercial page (e.g. a dental location page) with no named DDS/DMD, no credential schema, and no state licence reference, call this out as a direct E-E-A-T risk. This is the ONLY author/credential recommendation permitted on a commercial page — phrase it as "name the treating dentist(s) with credentials", never as "add an author byline".

15. The answerability score and its per-component points are computed by the rule engine and supplied to you in geo.answerability_score, geo.answerability_earned, geo.answerability_max, and geo.answerability_breakdown. Echo them verbatim. Never compute, adjust, average, or re-derive them. Never emit a csqaf_breakdown object. Never emit component keys that are absent from geo.answerability_breakdown.

16. Do not recommend adding anything covered by an id in naCheckIds. If you believe an na decision is wrong for this specific page, say so in exactly one sentence inside summary.priority_verdict — do not manufacture an issue object for it.

17. Every issue you emit must reference a check id that appears in the supplied checks array.`;

async function fetchUrl(url) {
  const resp = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    validateStatus: () => true,
  });
  return {
    html: typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data),
    status: resp.status,
    headers: resp.headers,
    finalUrl: resp.request?.res?.responseUrl || url,
    fetchTimeMs: 0,
  };
}

// POST /api/seo-geo-audit/run  — SSE streaming
/**
 * The SEO & GEO audit, callable without an HTTP request.
 *
 * Extracted from the SSE route rather than reimplemented, so an ad-hoc audit and
 * a project-scoped one share one code path and can never report different scores
 * for the same page (PRD §32: prefer service extraction over parallel
 * replacement).
 *
 * Progress is pushed through `emit`, which the route wires to the SSE stream and
 * a project run leaves as a no-op. Failures throw instead of emitting an error
 * event, because a caller that isn't a stream needs to know the audit did not
 * happen — a resolved promise carrying an error event reads as success.
 *
 * @param {object}   input
 * @param {string}  [input.url]         one of url / html is required
 * @param {string}  [input.html]        pasted HTML, when there is no fetchable URL
 * @param {string[]}[input.keywords]
 * @param {string}  [input.pageIntent]  'commercial' | 'informational' | 'auto'
 * @param {boolean} [input.skipAi]      skip the LLM analysis and return checks only
 * @param {Function}[input.emit]        (event, data) progress sink
 * @returns {Promise<{findings: object, ai: object|null}>}
 * @throws  an Error with a `status` for bad input, or the underlying failure
 */
async function runSeoGeoAudit({
  url, html: pastedHtml, keywords, pageIntent: pageIntentInput, skipAi = false, emit = () => {},
} = {}) {
  const kwArray = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  // 'auto' lets the check engine infer intent from the detected page type. An explicit
  // 'commercial'/'informational' always wins; anything unrecognised degrades to 'auto'.
  const intentInput = ['commercial', 'informational'].includes(pageIntentInput) ? pageIntentInput : 'auto';

  if (!url && !pastedHtml) {
    throw Object.assign(new Error('Provide a URL or raw HTML.'), { status: 400 });
  }

  try {
    let rawHtml = '';
    let httpStatus = null;
    let httpHeaders = {};
    let finalUrl = url || null;
    let fetchTimeMs = 0;
    let inputType = 'html_paste';

    // ── Step 1: Fetch ────────────────────────────────────────────────────────
    if (url) {
      inputType = 'url';
      emit('step', { id: 'fetch', status: 'active', message: `Fetching ${url}…` });
      const t0 = Date.now();
      try {
        const fetched = await fetchUrl(url);
        rawHtml = fetched.html;
        httpStatus = fetched.status;
        httpHeaders = fetched.headers;
        finalUrl = fetched.finalUrl;
        fetchTimeMs = Date.now() - t0;
        emit('step', { id: 'fetch', status: 'done', message: `Fetched ${Math.round(rawHtml.length/1024)}KB in ${fetchTimeMs}ms (HTTP ${httpStatus})` });
      } catch (err) {
        emit('step', { id: 'fetch', status: 'error', message: `Fetch failed: ${err.message}` });
        throw Object.assign(
          new Error(`Could not fetch URL: ${err.message}`),
          { status: 502 },
        );
      }
    } else {
      rawHtml = pastedHtml;
      emit('step', { id: 'fetch', status: 'done', message: 'Using pasted HTML.' });
    }

    if (!rawHtml || rawHtml.trim().length < 50) {
      throw Object.assign(
        new Error('HTML is empty or too short to audit.'),
        { status: 422 },
      );
    }

    // ── Step 2: Run checks ───────────────────────────────────────────────────
    emit('step', { id: 'checks', status: 'active', message: 'Running all SEO & GEO checks…' });
    const { checks, scores, geo, pageContext, detectedElements, detectedSchemas, schemaRecommendations, kwChecks, pageIntent, pageIntentSource } = await runAllChecks(rawHtml, finalUrl, httpHeaders, kwArray, { pageIntent: intentInput });
    const kwSuffix = kwArray.length > 0 ? ` · ${kwChecks.length} keyword checks` : '';
    emit('step', { id: 'checks', status: 'done', message: `${checks.length} checks complete — ${scores.counts.errors} errors, ${scores.counts.warnings} warnings${kwSuffix} · ${pageIntent} intent` });

    // ── Step 3: Build findings payload ───────────────────────────────────────
    emit('step', { id: 'structure', status: 'active', message: 'Structuring findings…' });

    const findings = {
      meta: {
        url: finalUrl || '(pasted HTML)',
        fetch_timestamp: new Date().toISOString(),
        html_size_bytes: rawHtml.length,
        fetch_time_ms: fetchTimeMs,
        http_status: httpStatus,
        input_type: inputType,
        total_checks_run: checks.length,
        errors: scores.counts.errors,
        warnings: scores.counts.warnings,
        notices: scores.counts.notices,
        passed: scores.counts.passed,
        page_type: pageContext?.pageType || 'unknown',
        page_type_confidence: pageContext?.pageTypeConfidence || 0,
        is_ymyl: pageContext?.isYMYL || false,
        content_vertical: pageContext?.detectedVertical || 'other',
        page_intent: pageIntent,
        page_intent_source: pageIntentSource,
        keywords: kwArray,
      },
      checks,
      scores,
      geo,
      pageContext,
      detectedElements,
      detectedSchemas,
      schemaRecommendations,
      kwChecks,
    };

    emit('step', { id: 'structure', status: 'done', message: 'Findings structured.' });

    // ── Step 3.5: Page type AI classification ─────────────────────────────────────────
    // Only run if rule-based confidence < 0.8 and we have enough page signals. Skipped entirely when
    // the operator declared the intent — the classifier's only downstream use is intent inference,
    // and an explicit declaration always wins.
    let aiPageType = null;
    if (intentInput === 'auto' && pageContext && pageContext.pageTypeConfidence < 0.8) {
      try {
        const classInput = {
          url: finalUrl || '(pasted HTML)',
          title: findings.meta.title || '',
          h1: '',
          metaDescription: '',
          h2List: [],
          firstParagraph: '',
          schemaTypes: (detectedSchemas || []).flatMap(s => [].concat(s['@type'] || [])).filter(Boolean),
        };
        // We pass minimal info for classification — the checks already extracted these
        const classCompletion = await getOpenAI().chat.completions.create({
          model: ANALYSIS_MODEL,
          response_format: { type: 'json_object' },
          temperature: 0,
          thinking: { type: 'disabled' },
          // Small answer, but the budget has to cover a reasoning model's
          // internal tokens as well as the JSON — see ANALYSIS_MAX_TOKENS.
          max_tokens: 2000,
          messages: [
            {
              role: 'system',
              content: `Classify this page into exactly ONE type: homepage, location, service, article, blog, resource, guide, product, category, about, contact, faq, team, pricing, landing, other. Respond with JSON only: {"pageType":"<type>","confidence":<0.0-1.0>,"contentVertical":"<healthcare|legal|finance|ecommerce|saas|local_service|media|education|other>","isYMYL":<true|false>,"reasoning":"<one sentence>"}`
            },
            {
              role: 'user',
              content: JSON.stringify(classInput)
            }
          ],
        });
        const classRaw = classCompletion.choices[0]?.message?.content || '';
        // An empty reply is not a classification. Parsing '{}' here gave an
        // object whose confidence was undefined, which failed the >= 0.8 gate
        // below and quietly left the rule-based page type in place — the right
        // outcome, reached by accident. Made explicit so a future change to that
        // gate cannot turn "the model said nothing" into a confident answer.
        if (!classRaw.trim()) throw new Error('the classifier returned an empty response');
        aiPageType = JSON.parse(classRaw);
        if (aiPageType.confidence >= 0.8) {
          // Deliberately does NOT re-derive page_intent: scoring already ran against the rule-based
          // intent, so re-deriving here would make findings.scores disagree with findings.meta.
          // page_intent_source keeps the provenance visible.
          findings.meta.page_type = aiPageType.pageType;
          findings.meta.page_type_confidence = aiPageType.confidence;
          findings.meta.is_ymyl = aiPageType.isYMYL;
          findings.meta.content_vertical = aiPageType.contentVertical;
          if (findings.pageContext) {
            findings.pageContext.pageType = aiPageType.pageType;
            findings.pageContext.isYMYL = aiPageType.isYMYL;
            findings.pageContext.detectedVertical = aiPageType.contentVertical;
          }
        }
      } catch (err) {
        // Best-effort: the rule-based page type stands. Logged rather than
        // swallowed, because a classifier that never succeeds is worth knowing
        // about even though it costs the audit nothing.
        console.warn('[seo-geo] page classification skipped:', err.message);
      }
    }

    // ── Step 4: GPT-4o mini analysis ─────────────────────────────────────────
    emit('step', { id: 'ai', status: 'active', message: 'Sending to GPT-4o mini for expert analysis…' });

    // The old filter — `c.status !== 'pass' || c.severity === 'info'` — was a no-op: makeResult()
    // defaults severity:'info' and pass() never clears it, so all 261 checks satisfied it and
    // slice(0,120) then dropped 141 of them in DOM order. J22's schema validation errors sat at
    // filtered index 128 and never reached the model, which is why the report never mentioned the
    // dayOfWeek bug this prompt is written to fix. Filter on status, rank BEFORE slicing.
    const notableChecks = checks
      .filter(c => Object.prototype.hasOwnProperty.call(CHECK_RANK, c.status))
      .sort((a, b) => checkRank(a) - checkRank(b));   // stable — DOM order kept within a rank band
    const sentChecks = notableChecks.slice(0, AI_CHECK_BUDGET);
    findings.meta.checks_sent_to_ai = sentChecks.length;
    findings.meta.checks_truncated = notableChecks.length - sentChecks.length;

    // The AI layer explains the checks; it does not produce the score. A project
    // run that only needs the score and the findings can skip it, and a failure
    // here leaves aiAnalysis null rather than losing the audit.
    let aiAnalysis = null;
    if (!skipAi) try {
      const gptInput = {
        meta: findings.meta,
        scores: findings.scores,
        geo: findings.geo,
        pageIntent,
        pageIntentSource,
        pageContext: findings.pageContext,
        detectedElements: findings.detectedElements,
        detectedSchemas: (findings.detectedSchemas || []).slice(0, 10), // limit
        schemaRecommendations: findings.schemaRecommendations || [],
        kwChecks: findings.kwChecks || [],
        checks: sentChecks,
        // Validation findings get their own field so a content budget can never drop them.
        schemaValidationErrors: checks
          .filter(isSchemaValidationFinding)
          .map(c => ({ id: c.id, category: c.category, severity: c.severity, detail: c.detail })),
        // Page-specific exclusion list — replaces a hardcoded id list in the prompt.
        naCheckIds: checks.filter(c => c.status === 'na').map(c => c.id),
        checksTruncated: findings.meta.checks_truncated,
      };

      const completion = await getOpenAI().chat.completions.create({
        model: ANALYSIS_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: ANALYSIS_MAX_TOKENS,
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: GPT_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(gptInput) },
        ],
      });

      const choice = completion.choices?.[0];
      const raw = choice?.message?.content || '';

      // An empty answer is a failure, not an empty analysis. Defaulting it to
      // '{}' produced an object that parsed, rendered, and said nothing — the
      // report looked finished and had no findings in it. If the model ran out
      // of room, say so, because the fix is a bigger budget rather than a retry.
      if (!raw.trim()) {
        throw new Error(
          choice?.finish_reason === 'length'
            ? `the model used its entire ${ANALYSIS_MAX_TOKENS}-token output budget without answering`
            : 'the model returned an empty response',
        );
      }

      aiAnalysis = JSON.parse(raw);
      emit('step', { id: 'ai', status: 'done', message: 'AI analysis complete.' });
    } catch (err) {
      // Logged as well as emitted. `emit` is a no-op for a project run, so an
      // emit-only failure meant the analysis silently vanished and the stored
      // report came back with ai: null and nothing anywhere saying why.
      console.error('[seo-geo] AI analysis failed:', err.message);
      emit('step', { id: 'ai', status: 'error', message: `AI analysis failed: ${err.message}` });
    }

    // ── Step 5: Hand the result back ─────────────────────────────────────────
    return { findings, ai: aiAnalysis };
  } catch (err) {
    // Progress consumers still want to see the failure; the caller still needs
    // it to be a rejection.
    emit('step', { id: 'audit', status: 'error', message: err.message || 'Unexpected error during audit.' });
    throw err;
  }
}

// POST /api/seo-geo-audit/run — the SSE face of runSeoGeoAudit.
//
// Errors are emitted rather than thrown once the stream has started: the status
// line is long gone by then, so an 'error' event is the only way to tell the
// browser. Bad input, which is detected before any of that, still answers 400.
router.post('/run', async (req, res) => {
  const body = req.body || {};
  if (!body.url && !body.html) {
    return res.status(400).json({ error: 'Provide a URL or raw HTML.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  req.on('close', () => { closed = true; });

  const emit = (event, data) => {
    if (closed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { closed = true; }
  };

  try {
    const result = await runSeoGeoAudit({ ...body, emit });
    emit('result', result);
  } catch (err) {
    emit('error', { message: err.message || 'Unexpected error during audit.' });
  }
  res.end();
});

module.exports = router;
// Named export for the project-scoped runner (modules/projects/moduleRunners.js).
module.exports.runSeoGeoAudit = runSeoGeoAudit;
