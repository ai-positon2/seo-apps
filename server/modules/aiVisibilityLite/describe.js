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
// ── One call per run, not per capture ──────────────────────────────────────
//
// v1's extractionPass runs a model over every capture individually, because it
// is scoring sentiment and ordinal position per mention and those are per-row
// facts. Descriptors are not: they are a property of the answer set taken
// together, and asking once over all of them is both cheaper and better — a
// model looking at twenty answers can see that "family-friendly" came up in
// nine of them, which twenty independent calls cannot.
//
// So this is ONE extra model call per run. At gpt-4o-mini rates that is
// fractions of a cent against a run costing around a dollar.
//
// ── The anti-hallucination guard is load-bearing ───────────────────────────
//
// A model asked "what do these answers say about X" will happily produce
// plausible marketing adjectives that appear nowhere in the text. A descriptor
// nobody wrote, presented to a client as what AI says about them, is worse than
// no panel at all — it is unfalsifiable and flattering, which is the exact
// combination that destroys trust when somebody checks.
//
// So every descriptor must arrive with a VERBATIM quote, and a quote that is
// not a literal substring of one of the answers is discarded along with its
// descriptor. This is the same rule llmExtract.js applies to proposed brands,
// for the same reason.

const { createLlmClient } = require('../../services/llmProviders');
const { chatParams } = require('../../locationPageBuilder/llmParams');

const MODEL = process.env.AIVL_DESCRIBE_MODEL || 'gpt-4o-mini';

// How many answers the model reads. Twenty covers a full run's worth of
// brand-naming answers; beyond that the marginal answer adds repetition rather
// than a new descriptor, and the input is billed.
const MAX_ANSWERS = 20;

// How much of each answer. A recommendation names several businesses, and the
// part about this one is rarely in the last paragraph.
const MAX_ANSWER_CHARS = 2_500;

const MAX_ATTRIBUTES = 8;

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
listings as positive is the single easiest way to make this number worthless.`;

const RESPONSE_FORMAT = `Return ONLY raw JSON, no markdown fences:

{"attributes": [
  {"label": "two or three words, in the answers' own vocabulary",
   "quotes": ["a short verbatim span, copied exactly from an answer"]}
 ],
 "sentiment": {
   "score": 0-100,
   "rationale": "one short sentence",
   "quotes": ["a verbatim span, copied exactly, that justifies the score"]
 }}

Order attributes by how often the quality appears. At most ${MAX_ATTRIBUTES} attributes.`;

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
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
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
  // Only answers that NAMED the brand can say anything about it. An answer that
  // never mentioned them describes somebody else.
  const answers = (rows || [])
    .filter((r) => r.status === 'captured' && r.mentioned === true && r.answerText)
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
      {
        role: 'user',
        content: JSON.stringify({ business: brand?.name, answers }),
      },
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
      const found = haystack.filter((a) => a.includes(needle));
      if (!found.length) { discarded += 1; continue; }
      quotes.push(String(quote).trim());
    }

    if (!quotes.length) { discarded += 1; continue; }
    attributes.push({
      label,
      // How many of the answers contain any of its surviving quotes — the
      // honest version of "how often this came up".
      answers: haystack.filter((a) => quotes.some((q) => a.includes(flatten(q)))).length,
      quotes: quotes.slice(0, 3),
    });
    if (attributes.length >= MAX_ATTRIBUTES) break;
  }

  // ── Sentiment, under the same guard ──────────────────────────────────────
  //
  // METRICS.md §3.6, with its warning encoded in the system prompt: a bare
  // directory-style listing is 50, and inflating those to 60 makes the metric
  // useless. The quote requirement applies here too — a score whose
  // justification is not in the text is a score about nothing, and it is
  // dropped rather than shown with a caveat.
  //
  // Null, never 50, when it cannot be justified. A neutral-looking default is
  // indistinguishable from a real neutral reading, which is exactly the
  // three-state confusion the rest of this module refuses to make.
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
        // The same denominator the attributes use, so a reader can see the
        // score is over twelve answers rather than one.
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
    // returned is a signal about the model, and hiding it would make the
    // surviving attributes look more solid than they are.
    discarded,
    modelVersion: MODEL,
  };
}

module.exports = {
  MODEL, MAX_ANSWERS, MAX_ATTRIBUTES, describe, flatten, parseReply,
};
