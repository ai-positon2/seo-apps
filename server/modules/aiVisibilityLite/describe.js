// ── How the models actually describe this business ──────────────────────────
//
// Reads the ANSWERS, not the website. Everything else in this module measures
// whether a brand gets named; this reads what was said about it once it was.
//
// The distinction matters and it is the reason this file exists separately from
// businessProfile.js. That file describes the business from its own marketing
// copy — it is our reading of what the company says about itself, and it exists
// only to write sensible questions and to know which names to match. It is an
// INPUT. This file is a FINDING: the words three models reached for when a
// buyer asked, which is the thing a client cannot see for themselves and the
// only one of the two worth putting in a report as an insight.
//
// ── Two passes ─────────────────────────────────────────────────────────────
//
// describe()       ONE call over up to twenty answers: the descriptors ("family-
//                  friendly" in nine of them) and a one-line reading of the
//                  overall tone. Descriptors are a property of the answer set
//                  taken together, which one call sees and twenty cannot.
//
// classifyTones()  EVERY answer that named the brand, in batches: each one
//                  tagged positive / neutral / negative on its own text. These
//                  per-answer tags are what the sentiment score is computed
//                  from (report.js), so they cannot stop at twenty — a score
//                  over a sample would move whenever the sample did.
//
// Both at gpt-4o-mini rates: fractions of a cent against a run costing around
// a dollar.
//
// ── The anti-hallucination guard is load-bearing ───────────────────────────
//
// A model asked "what do these answers say about X" will happily produce
// plausible marketing adjectives that appear nowhere in the text. A descriptor
// nobody wrote, presented to a client as what AI says about them, is worse than
// no panel at all — it is unfalsifiable and flattering, which is the exact
// combination that destroys trust when somebody checks.
//
// So every descriptor, and every per-answer tone, must arrive with a VERBATIM
// quote, and a quote that is not a literal substring of the answer it claims
// to come from is discarded along with what it was meant to back. This is the
// same rule llmExtract.js applies to proposed brands, for the same reason.

const { createLlmClient } = require('../../services/llmProviders');
const { chatParams } = require('../../locationPageBuilder/llmParams');

const MODEL = process.env.AIVL_DESCRIBE_MODEL || 'gpt-4o-mini';
// The per-answer tone is a judgement call on every answer, and the score is
// built from it, so it gets its own, overridable model.
const TONE_MODEL = process.env.AIVL_TONE_MODEL || 'gpt-4o-mini';

// How many answers the descriptor pass reads. Twenty covers a full run's worth
// of brand-naming answers; beyond that the marginal answer adds repetition
// rather than a new descriptor, and the input is billed.
const MAX_ANSWERS = 20;

// How much of each answer. A recommendation names several businesses, and the
// part about this one is rarely in the last paragraph.
const MAX_ANSWER_CHARS = 2_500;

const MAX_ATTRIBUTES = 8;

const TONES = ['positive', 'neutral', 'negative'];
const ABSENT = 'absent';

// Answers per tone-classification call, and how many calls run at once. Small
// batches keep each reply short enough never to be cut off mid-JSON.
const TONE_BATCH = 8;

// Stamped on every stored tone. Tones from an older version of the
// instructions below are ignored and re-read, so fixing the instructions
// fixes answers already tagged, not only new ones.
//   2  a branch or location of the business counts as the business
//   3  favourable qualities count as positive, not only outright
//      recommendations — "fair prices", "authentic", "latest releases"
const TONE_VERSION = 3;
const TONE_PARALLEL = 3;

const SYSTEM = `You are reading answers that AI assistants gave to buyers who asked for
recommendations. One business is named in them. Your job is to report two things: how those
answers DESCRIBE that business, and how WARMLY they speak about it.

Report only what the text says. Do not infer, do not summarise the industry, and do not
add qualities that would be plausible for this kind of business but are not written.

Every attribute you report MUST come with a short verbatim quote, copied exactly, from
one of the answers. If you cannot quote it, do not report it. An empty list is a correct
answer when the text is not descriptive.

THE SENTIMENT SCALE, 0-100, scored on the clauses that name the business:

   0-19   warned against
  20-39   negative
  40-59   neutral, or a purely factual listing
  60-79   positive
  80-100  named as the best choice

Most answers of this kind are NEUTRAL LISTS — a business named among several with its
address and services. That is 50, not 60. Reserve 60 and above for answers that actually
commend the business, and 80 and above for answers that single it out. Scoring routine
listings as positive is the single easiest way to make this number worthless.

Each attribute also carries its tone towards the business: positive (praise, or any
favourable quality such as fair prices, authenticity, range or style), neutral (a plain fact
with no judgement), or negative (a criticism, drawback or caveat).`;

const RESPONSE_FORMAT = `Return ONLY raw JSON, no markdown fences:

{"attributes": [
  {"label": "two or three words, in the answers' own vocabulary",
   "tone": "positive | neutral | negative",
   "quotes": ["a short verbatim span, copied exactly from an answer"]}
 ],
 "sentiment": {
   "score": 0-100,
   "rationale": "one short sentence",
   "quotes": ["a verbatim span, copied exactly, that justifies the score"]
 }}

Order attributes by how often the quality appears. At most ${MAX_ATTRIBUTES} attributes.`;

const TONE_SYSTEM = `You are reading answers that AI assistants gave to buyers who asked for
recommendations. One business is named in each. For EACH answer, decide the tone of what
that answer says about THAT business — not about the industry, and not about the other
businesses it names.

A branch, location or office of the business IS the business: "Acme Dental – Raleigh",
"Acme's Cary office" or a link to its website all count as it.

  positive   it recommends the business — including simply listing it as one of
             the places or options the buyer should consider — or says anything
             FAVOURABLE about it:
             quality, value or fair prices, authenticity, range or variety,
             innovation or technology, style, reputation, being trusted or
             well known, or being a reason to choose a store or an option.
             "Brands like X offer style, tech and fair prices", "X – official
             catalogue, latest releases, authentic products", "Pros: access to
             X's latest range", "a wide range of brands (X, Y, Z)" and "brand
             variety (X, Y, Z)" are all positive for X — being named as a
             brand that makes a store or option worth choosing is favourable.
  neutral    it mentions the business in passing, NOT as a recommendation and
             with no judgement — a plain fact such as a price band, a shipping
             rule, or that it also exists
  negative   it criticises the business, names a drawback (too expensive,
             poor service, sizing problems), raises a concern, or warns
             against it

  absent     the matched name is really something ELSE — a product or payment plan
             the business happens to offer, or a genuinely different business. If the
             answer names this business at all, even in passing or as one example
             among several, it is NOT absent: judge it as positive, neutral or
             negative.

Judge only the words that are about this business. When an answer has both praise and a
drawback for it, choose the one it leans towards. Words praising a DIFFERENT business in the
same answer are not about this one.

Every positive, neutral or negative tone MUST come with a short quote copied exactly from
THAT answer — the words about this business that decided the tone. An absent answer needs
no quote.

Return ONLY raw JSON, no markdown fences:

{"answers": [{"i": the answer's index,
              "reason": "at most 12 words: what this answer does with the business",
              "tone": "positive | neutral | negative | absent",
              "quote": "a verbatim span from that answer"}]}

Write the reason BEFORE deciding the tone, and make the tone follow from it.`;

function parseReply(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?|```$/g, '').trim();
  return JSON.parse(text);
}

/**
 * Normalise for substring checking.
 *
 * Models re-type quotes with smart quotes, collapsed whitespace and different
 * dashes, so a raw indexOf rejects quotes that really are in the text. This
 * flattens both sides to the same shape — it makes the guard forgiving about
 * punctuation and still strict about words, which is the right trade: the
 * failure this prevents is an invented CLAIM, not an invented comma.
 */
function flatten(text) {
  return String(text || '')
    // Answers are markdown and models quote them with or without the markup —
    // "**Nike India**" comes back as "Nike India", a link as its label. Both
    // sides lose it, so the words still have to match exactly.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Answers that named the brand and have text to read — the only ones with anything to say about it. */
function namedAnswers(rows) {
  return (rows || []).filter((r) => r.status === 'captured' && r.mentioned === true && r.answerText);
}

/**
 * What the models said about this business.
 *
 * @param {object} input
 * @param {object[]} input.rows   capture rows from measure(), any status
 * @param {object} input.brand    {name, aliases}
 * @returns {Promise<{attributes: Array, basis: number, discarded: number, modelVersion: string}|null>}
 *   null when there is nothing to read — which is not an error, and the report
 *   renders it as "not enough answers name this brand yet".
 */
async function describe({ rows, brand }) {
  const answers = namedAnswers(rows)
    .slice(0, MAX_ANSWERS)
    .map((r) => String(r.answerText).slice(0, MAX_ANSWER_CHARS));

  // Two answers is an anecdote. Below this the panel would be describing one
  // model's turn of phrase as though it were a pattern.
  if (answers.length < 3) return null;

  const client = createLlmClient(MODEL);
  const res = await client.chat.completions.create({
    model: client.model,
    response_format: { type: 'json_object' },
    ...chatParams(client.model, { maxTokens: 900, temperature: 0.2 }),
    messages: [
      { role: 'system', content: `${SYSTEM}\n\n${RESPONSE_FORMAT}` },
      { role: 'user', content: JSON.stringify({ business: brand?.name, answers }) },
    ],
  });

  let parsed;
  try {
    parsed = parseReply(res.choices?.[0]?.message?.content);
  } catch {
    // A descriptor panel is not worth failing a run over. The captures are
    // stored and every other number is unaffected.
    return null;
  }

  return { ...interpret(parsed, answers), modelVersion: MODEL };
}

/**
 * The descriptor pass's reply, kept only where the text backs it. Separate
 * from the call so the guard can be tested without one.
 *
 * @param {object} parsed     the model's JSON
 * @param {string[]} answers  the answer texts it read
 */
function interpret(parsed, answers) {
  const haystack = answers.map(flatten);
  const attributes = [];
  let discarded = 0;

  for (const item of parsed?.attributes || []) {
    const label = String(item?.label || '').trim();
    if (!label || label.length > 40) continue;

    // Keep only quotes that are really in the text, and only the attribute if
    // at least one survives. See the header — this is the whole guard.
    const quotes = [];
    for (const quote of item?.quotes || []) {
      const needle = flatten(quote);
      // Very short fragments match by accident and prove nothing.
      if (needle.length < 12) continue;
      if (!haystack.some((a) => a.includes(needle))) { discarded += 1; continue; }
      quotes.push(String(quote).trim());
    }

    if (!quotes.length) { discarded += 1; continue; }
    attributes.push({
      label,
      // Neutral when the model gave no usable tone — never guessed warmer.
      tone: TONES.includes(item?.tone) ? item.tone : 'neutral',
      // How many of the answers contain any of its surviving quotes — the
      // honest version of "how often this came up".
      answers: haystack.filter((a) => quotes.some((q) => a.includes(flatten(q)))).length,
      quotes: quotes.slice(0, 3),
    });
    if (attributes.length >= MAX_ATTRIBUTES) break;
  }

  // ── The one-line overall reading, under the same guard ───────────────────
  //
  // Kept for its rationale and quotes, and as the fallback score for runs
  // from before per-answer tones existed. Null, never 50, when it cannot be
  // justified: a neutral-looking default is indistinguishable from a real
  // neutral reading.
  let sentiment = null;
  const rawScore = Number(parsed?.sentiment?.score);
  if (Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= 100) {
    const backing = (parsed.sentiment.quotes || [])
      .map((q) => String(q).trim())
      .filter((q) => flatten(q).length >= 12 && haystack.some((a) => a.includes(flatten(q))));

    if (backing.length) {
      sentiment = {
        score: Math.round(rawScore),
        rationale: String(parsed.sentiment.rationale || '').trim() || null,
        quotes: backing.slice(0, 3),
        basis: answers.length,
      };
    } else {
      discarded += 1;
    }
  }

  return {
    attributes: attributes.sort((a, b) => b.answers - a.answers),
    sentiment,
    // The denominator for every count above, so the panel can say "in 7 of 12
    // answers" rather than a bare number.
    basis: answers.length,
    // Reported rather than swallowed: a pass that invented most of what it
    // returned is a signal about the model.
    discarded,
  };
}

/**
 * One batch's reply, kept only where the tone is backed by a quote from THAT
 * answer. A quote found only in another answer proves nothing about this one,
 * so it is dropped and the answer stays unclassified rather than assumed
 * neutral.
 *
 * @param {object} parsed    the model's JSON
 * @param {string[]} texts   the batch's answer texts, in the order it saw them
 * @returns {Array<{i: number, tone: string, quote: string}>}
 */
function interpretTones(parsed, texts) {
  const haystack = texts.map(flatten);
  const seen = new Set();
  const out = [];
  for (const item of parsed?.answers || []) {
    const i = Number(item?.i);
    if (!Number.isInteger(i) || i < 0 || i >= texts.length || seen.has(i)) continue;
    // Kept, so the answer is not re-read on every click, and left out of the
    // counts by report.js: mention matching counted it, but it says nothing
    // about the business (a product name, a similarly named practice).
    if (item?.tone === ABSENT) {
      seen.add(i);
      out.push({ i, tone: ABSENT, quote: null });
      continue;
    }
    if (!TONES.includes(item?.tone)) continue;
    const needle = flatten(item?.quote);
    if (needle.length < 12 || !haystack[i].includes(needle)) continue;
    seen.add(i);
    out.push({ i, tone: item.tone, quote: String(item.quote).trim().slice(0, 300) });
  }
  return out;
}

/**
 * Tag EVERY answer that named the brand as positive, neutral or negative.
 *
 * @param {object} input
 * @param {object[]} input.rows   capture rows, any status; only named, captured ones are read
 * @param {object} input.brand    {name}
 * @returns {Promise<Array<{runId, promptId, engine, tone, quote}>>}  one entry
 *   per answer whose tone could be backed; answers that could not are absent,
 *   not guessed. A failed batch costs its own answers, not the rest.
 */
async function classifyTones({ rows, brand }) {
  const answers = namedAnswers(rows);
  if (!answers.length) return [];

  const client = createLlmClient(TONE_MODEL);
  const batches = [];
  for (let i = 0; i < answers.length; i += TONE_BATCH) batches.push(answers.slice(i, i + TONE_BATCH));

  const classifyBatch = async (batch) => {
    const texts = batch.map((r) => String(r.answerText).slice(0, MAX_ANSWER_CHARS));
    try {
      const res = await client.chat.completions.create({
        model: client.model,
        response_format: { type: 'json_object' },
        // Newer models spend part of this budget reasoning before they answer.
        ...chatParams(client.model, { maxTokens: 6000, temperature: 0 }),
        messages: [
          { role: 'system', content: TONE_SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({
              business: brand?.name,
              website: brand?.domain || null,
              answers: texts.map((text, i) => ({ i, text })),
            }),
          },
        ],
      });
      return interpretTones(parseReply(res.choices?.[0]?.message?.content), texts).map((t) => ({
        runId: batch[t.i].runId || null,
        promptId: batch[t.i].promptId || null,
        engine: batch[t.i].engine || null,
        tone: t.tone,
        quote: t.quote,
        v: TONE_VERSION,
      }));
    } catch (e) {
      console.warn(`[aiVisibilityLite] tone batch skipped (${e.message})`);
      return [];
    }
  };

  const results = [];
  for (let i = 0; i < batches.length; i += TONE_PARALLEL) {
    // eslint-disable-next-line no-await-in-loop
    const done = await Promise.all(batches.slice(i, i + TONE_PARALLEL).map(classifyBatch));
    done.forEach((d) => results.push(...d));
  }
  return results;
}

module.exports = {
  MODEL, TONE_MODEL, MAX_ANSWERS, MAX_ATTRIBUTES, TONES, ABSENT, TONE_VERSION,
  describe, interpret, classifyTones, interpretTones, flatten, parseReply,
};
