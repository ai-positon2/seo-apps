// ── Writing the ten questions ────────────────────────────────────────────────
//
// Step two of the one-click flow. Takes the profile businessProfile.js built
// and writes ten questions a buyer would actually type into ChatGPT.
//
// ── The rule that makes or breaks this module ──────────────────────────────
//
// THE QUESTIONS MUST NOT NAME THE CLIENT.
//
// "Is Brush and Floss a good dentist?" is not a visibility measurement. The
// model was handed the name, so of course it says it — the answer measures the
// question, not the brand's standing. Every question here has to be one a buyer
// would ask when they do NOT yet know who to go to, which is the only condition
// under which being named means anything.
//
// v1 learned the adjacent lesson the hard way and its generate.js records it: a
// question written from a topic LABEL turned a page titled "Find A Dentist"
// into the prompt "best find a dentist". Writing from a profile of what the
// business SELLS avoids that, and the validator below is v1's, so a prompt that
// slips through the model is still caught by the same rules v1 applies.
//
// One call, not ten. Unlike v1 — where one prompt per page means a bad prompt
// implicates exactly one page — these ten are written against one profile, and
// asking for them together is what lets the model make them DIFFERENT from each
// other. Ten independent calls reliably produce ten rewordings of the same
// question, which measures one thing ten times.

const { createLlmClient } = require('../../services/llmProviders');
const { chatParams } = require('../../locationPageBuilder/llmParams');
const promptValidator = require('../aiVisibility/promptValidator');
const { AUTO_PROMPT_COUNT } = require('./models');

const MODEL = process.env.AIVL_PROMPT_MODEL || 'gpt-4o-mini';

// Ask for more than are needed. Validation rejects some — a question that names
// the brand, a duplicate, one too vague to measure — and coming back with seven
// prompts when the product promises ten is a worse outcome than one wasted
// paragraph of output.
const OVERSHOOT = 6;

const INTENTS = ['commercial', 'informational', 'navigational', 'comparison'];

const SYSTEM = `You write the questions a market-research tool will type into ChatGPT,
Claude and Gemini to find out whether a business gets recommended.

The questions must read like a real person typing into a chat box: natural,
conversational, first person where that is natural. Not keyword strings, not
search queries, not headlines.

THE MOST IMPORTANT RULE: never name the business being measured, and never use
a phrase that only that business uses. The whole point is to find out whether
the model brings them up unprompted. A question that names them proves nothing.

Write questions a buyer asks BEFORE they know who to go to. Spread them across
what the business actually sells, and vary the shape: some asking for a
recommendation, some comparing options, some asking how to choose, some asking
what something costs or involves. Where the business serves specific places,
some questions should mention the place — a national question measures nothing
for a single-location business.`;

const RESPONSE_FORMAT = `Return ONLY raw JSON, no markdown fences, in exactly this shape:

{"prompts": [{"text": "the question, as a person would type it", "intent": "commercial"}]}

intent is one of: commercial, informational, navigational, comparison.`;

function parseReply(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?|```$/g, '').trim();
  return JSON.parse(text);
}

function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * The names the brand guard is allowed to match on.
 *
 * The alias list and the brand guard want opposite things, and feeding one list
 * to both is what broke the first real run.
 *
 * Mention matching at capture time wants to be GENEROUS: every extra alias is
 * another way to catch the model naming this client, and a miss reads as a
 * genuine zero. So `profile.brandAliases` keeps the full list.
 *
 * The prompt guard wants to be CONSERVATIVE: promptValidator tokenises whatever
 * it is given and treats every token as "this reads as the brand", so a single
 * alias like "ShadowPlex Identity Protection" puts `identity` and `protection`
 * into the brand set — and every question about identity protection, which is
 * precisely the category this client sells into, gets rejected as naming them.
 * On the first live run that rejected all 16 questions and wrote none, with
 * `brandGuard: 'strict'` and no error anywhere.
 *
 * The rule: a brand token is the BUSINESS NAME, or an alias that stands on its
 * own as one word. Multi-word aliases are read only to find those — never
 * decomposed into their parts.
 *
 * "ShadowPlex Advanced Threat Defense" identifies this client through
 * "ShadowPlex", which is also an alias by itself. "Advanced", "Threat" and
 * "Defense" identify nothing; they are how the product line is described.
 *
 * An earlier version of this tried to subtract category words using the
 * profile's own products and services as the vocabulary. It worked on the live
 * data and was fragile: it only removed a descriptor if the site happened to
 * use that exact word elsewhere, so "platform" survived and went on rejecting
 * every question containing it. Taking only whole one-word names needs no
 * vocabulary and cannot half-work.
 *
 * Its failure mode is also the right way round. If a product name only ever
 * appears inside a longer alias, the guard misses it and one question naming
 * that product might slip through — a bad question among good ones, which a
 * person can see and delete. The alternative failure, the one this replaces,
 * was rejecting all twenty and showing an empty screen with no error.
 */
function guardNamesFrom(profile) {
  const names = [];
  const seen = new Set();

  const add = (value) => {
    const s = String(value || '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(s);
  };

  // The business name as a PHRASE, whatever shape it is. v1's brandTokens
  // subtracts generic industry words from it and reports `weak` when nothing
  // distinctive is left, which setup.js surfaces as a warning — so a company
  // named after what it sells is handled honestly rather than silently.
  add(profile.businessName);

  for (const alias of profile.brandAliases || []) {
    const parts = tokens(alias);
    // Two characters or fewer would match inside ordinary words.
    if (parts.length === 1 && parts[0].length >= 3) add(parts[0]);
  }

  return names;
}

/**
 * Write the question set from a profile.
 *
 * @param {object} input
 * @param {object} input.profile   from businessProfile.build()
 * @param {number} [input.count]   how many to return
 * @param {string[]} [input.existing]  questions already on the project, so a
 *   regeneration does not propose ones that are already there
 * @returns {Promise<{prompts: Array<{text, intent}>, rejected: Array<{text, reason}>}>}
 */
async function generate({ profile, count = AUTO_PROMPT_COUNT, existing = [] }) {
  const payload = {
    business_summary: profile.summary,
    products: profile.products,
    services: profile.services,
    locations: profile.locations,
    // Given so the model can AVOID them, never to include them. Same framing
    // v1's pagePrompts.js uses for the same reason.
    never_mention: [...(profile.brandAliases || []), ...(profile.competitors || [])],
    how_many: count + OVERSHOOT,
    already_asked: existing.slice(0, 40),
  };

  const client = createLlmClient(MODEL);
  const res = await client.chat.completions.create({
    model: client.model,
    response_format: { type: 'json_object' },
    // Warmer than the profile pass. Ten questions that are genuinely different
    // from each other is the goal, and a cold model writes ten rewordings.
    ...chatParams(client.model, { maxTokens: 1600, temperature: 0.7 }),
    messages: [
      { role: 'system', content: `${SYSTEM}\n\n${RESPONSE_FORMAT}` },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  });

  let parsed;
  try {
    parsed = parseReply(res.choices?.[0]?.message?.content);
  } catch (e) {
    throw Object.assign(
      new Error(`The question-writing step returned unreadable JSON: ${e.message}`),
      { status: 502, code: 'prompts_unparseable' },
    );
  }

  const candidates = (parsed?.prompts || [])
    .map((item) => ({
      text: String(item?.text || '').trim(),
      intent: INTENTS.includes(item?.intent) ? item.intent : null,
    }))
    .filter((c) => c.text);

  // v1's validator, whole. It runs the brand-name guard (the rule this file
  // exists to enforce, checked against brand tokens with generic industry words
  // subtracted, so "dentist" does not read as "Gentle Dental"), the shape
  // check, and near-duplicate detection both within this batch and against
  // everything the project already has.
  //
  // Reused rather than restated so both modules reject exactly the same things.
  // An earlier draft of this file hand-rolled a substring check for the brand
  // name; it would have rejected every question containing the word "dental"
  // for a client called Gentle Dental, which is most of the useful ones.
  const guardNames = guardNamesFrom(profile);
  const verdict = promptValidator.validateBatch(candidates, {
    // The NARROWED name set, not profile.brandAliases — see guardNamesFrom for
    // why the guard and capture-time matching cannot share one list.
    brand: { name: profile.businessName, aliases: guardNames },
    competitors: (profile.competitors || []).map((name) => ({ name })),
    existing,
  });

  return {
    prompts: verdict.accepted.slice(0, count),
    rejected: verdict.rejected,
    // 'weak' means the brand name is entirely generic words, so the guard could
    // only match the full phrase and a prompt naming the client may have got
    // through. The caller surfaces this rather than swallowing it.
    brandGuard: verdict.brandGuard,
    modelVersion: MODEL,
  };
}

module.exports = {
  MODEL, OVERSHOOT, INTENTS, generate, parseReply, guardNamesFrom,
};
