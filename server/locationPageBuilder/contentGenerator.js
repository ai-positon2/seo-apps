// ── Content Generation, Stage 7 (Spec §7) — Layer-aware ─────────────────────
// Generates L3 ONLY (page_data copy), then compose.mergeL3 stitches it onto the
// L1+L2 scaffold. Scraped competitor copy is used for MODELING coverage/structure
// only — never to copy NAP, images, providers or reviews (Spec §7.1, §15.4).

const config = require('./config');
const text = require('./text');
const { chatParams } = require('./llmParams');
const { createLlmClient } = require('../services/llmProviders');

const L3_SCHEMA_HINT = `{
  "meta_title": "string — max 60 chars, includes service + location + brand",
  "meta_description": "string — 150-160 chars, includes service + location",
  "og_title": "string", "og_description": "string",
  "h1": "string — MAX 55 CHARS. Natural heading, includes service + location, not keyword-stuffed",
  "hero_intro": "string — MAX 160 CHARS. 1-2 sentences mentioning the specific location",
  "approach_intro": "string — MAX 1110 CHARS. Body copy for the 'Our approach to [service]' section. Write as 2-3 paragraphs separated by a blank line (\\n\\n). ONE H2 heading only, NO sub-headings, NO bullet points",
  "competitor_section": [
    {
      "h2": "string — H2 heading modelled on what top competitors cover for this service",
      "description": "string — MAX 450 CHARS. 1-2 sentence intro paragraph below the H2 heading",
      "h3s": [
        {
          "heading": "string — H3 subtopic title",
          "copy": "string — MAX 1500 CHARS. 3-5 sentences of unique, informative copy for this H3. No bullet points unless truly needed (bullets reduce limit to 1400 chars)"
        }
      ]
    }
  ],
  "faqs": [
    {
      "question": "string",
      "answer": "string — MAX 300 CHARS. Concise, helpful, direct answer",
      "faq_type": "location|service|insurance|virtual|provider|appointment"
    }
  ]
}`;

function buildPrompt({ pageObject, layers, keywords, modelCopy }) {
  const { service, location, client, tone } = layers;
  const pd = pageObject.page_data;
  const ld = pageObject.location_data;

  const prohibited = (client.brand_rules?.prohibited_claims || []).join(', ');
  const ymyl = client.brand_rules?.ymyl;
  const primaryKws = (keywords.primary || []).map(k => k.keyword).join(', ');
  const secondaryKws = (keywords.secondary || []).map(k => k.keyword).join(', ');
  const faqKws = (keywords.faq || []).join(', ');

  const toneBlock = tone ? `Brand voice: ${tone.voice}\nReading level: ${tone.reading_level}\nCTA phrasing: ${(tone.cta_phrasing || []).join(' / ')}\nFormatting: ${tone.formatting_habits}` : 'Brand voice: warm, professional, clear.';

  const competitorHeadings = [...new Set((modelCopy || []).flatMap(m => m.headings || []))].slice(0, 25);

  const structureRules = `REQUIRED PAGE STRUCTURE (produce content in this exact order):
1. meta_title, meta_description, h1 (MAX 55 chars), hero_intro (MAX 160 chars)
2. approach_intro (MAX 1110 chars): body copy for "Our approach to ${service.name}". Write as 2-3 paragraphs (blank line between each). ONE H2 heading only, NO sub-headings, NO bullet points.
3. competitor_section: modelled on top competitors. MINIMUM 1 H2 block with 3 H3s; RECOMMENDED 2 H2 blocks with 5 H3s total. Each block has: h2 heading, description (MAX 450 chars), and h3s each with heading + copy (MAX 1500 chars per H3).
4. faqs: 7 to 11 questions, each answer MAX 300 chars, tagged by faq_type.

CHARACTER LIMITS — THESE ARE ABSOLUTE HARD LIMITS. COUNT EVERY CHARACTER INCLUDING SPACES:
- h1: 55 chars max
- hero_intro: 160 chars max
- approach_intro: 1110 chars max
- competitor_section[].description: 450 chars max per block
- competitor_section[].h3s[].copy: 1500 chars max per H3
- faqs[].answer: 300 chars max per answer`;

  const localFacts = `LOCAL FACTS (use ONLY these — do not invent NAP/providers):
- City/State: ${ld.city}, ${ld.state}
- Nearby areas: ${(ld.nearby_areas || []).join(', ')}
- Parking/access: ${ld.parking_info || 'n/a'}
- Providers at this location: ${(ld.providers || []).map(p => `${p.name} (${p.credentials})`).join('; ') || 'none listed'}
- Available: ${pageObject.service_data.available_in_person ? 'in-person' : ''}${pageObject.service_data.available_virtual ? ', virtual/online' : ''}${pageObject.service_data.teen_available ? ', teens' : ''}`;

  const modelBlock = competitorHeadings.length
    ? `COMPETITOR HEADINGS (model the competitor_section's H2/H3 COVERAGE on these — DO NOT copy phrasing, NAP, names, or reviews):\n${competitorHeadings.map(h => `- ${h}`).join('\n')}`
    : 'No competitor headings available — base the competitor_section on standard, comprehensive coverage for this service.';

  const system = `You write ONE unique Location+Service web page (L3 content only) for a ${ymyl ? 'YMYL healthcare' : ''} brand. Respond ONLY with JSON matching the schema. No prose, no markdown.
Schema:
${L3_SCHEMA_HINT}
${toneBlock}
${structureRules}
HARD RULES:
- CHARACTER LIMITS ARE ABSOLUTE. Before finalising each field, count characters and trim if needed: h1 ≤55, hero_intro ≤160, approach_intro ≤1110, block description ≤450, H3 copy ≤1500, FAQ answer ≤300.
- Do NOT produce a "care_pillars" key — the approach section is approach_intro only (plain paragraphs, no sub-headings).
- Each competitor_section block MUST include a "description" key (the intro paragraph under the H2).
- Place primary/secondary keywords naturally — NO stuffing.
- Weave at least one concrete LOCAL detail (nearby areas, parking/access, local providers) into the hero and competitor_section, drawn from the LOCAL FACTS only.
- Minimum ${config.uniqueness.minBodyWordCount} words of unique body copy across the sections.
- competitor_section: at least 1 H2 + 3 H3s; aim for 2 H2 + 5 H3s.
- faqs: 7 to 11 questions, specific to THIS service + location (so sibling pages differ).
- NEVER use these prohibited claims: ${prohibited || '(none)'}.
${ymyl ? '- YMYL: do NOT overclaim medical outcomes. Defer specific clinical claims to provider-reviewed copy. Never invent credentials, licenses, or certifications.' : ''}`;

  const user = `PAGE: ${service.name} in ${location.location_name}, ${location.state}
Service category: ${service.category}
Primary keywords: ${primaryKws}
Secondary keywords: ${secondaryKws}
FAQ keyword seeds: ${faqKws}
Conditions/topics to weave in: ${(service.conditions_treated || []).join(', ')}

${localFacts}

${modelBlock}

Return JSON only, matching the schema. Remember: 2 care_pillars, competitor_section with H2/H3 blocks, and 7-11 faqs.`;

  return { system, user };
}

async function generateL3({ pageObject, layers, keywords, modelCopy }) {
  const llm = createLlmClient(config.llm.generationModel);
  const { system, user } = buildPrompt({ pageObject, layers, keywords, modelCopy });

  let l3 = null;
  for (let attempt = 0; attempt < 2 && !l3; attempt++) {
    const completion = await llm.chat.completions.create({
      model: llm.model,
      // This prompt's density (per-field char limits, structure rules, YMYL
      // guardrails) pushes reasoning-capable models like Claude into enough
      // internal reasoning that a low cap can exhaust the whole budget before
      // any visible output — leaving finish_reason "length" and empty content.
      ...chatParams(llm.model, { maxTokens: 8000 }),
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    try {
      const raw = JSON.parse(completion.choices[0].message.content);
      if (raw && (raw.h1 || raw.hero_intro)) l3 = raw;
    } catch { /* retry once */ }
  }
  if (!l3) throw new Error('Content generation returned invalid JSON after retry.');
  return l3;
}

// Cross-page similarity vs sibling pages for the same client (Spec §7.3).
async function crossPageSimilarity({ store, clientId, currentPageId, pageData }) {
  const body = text.pageBodyText(pageData);
  const pages = (await store.list('pages', { client_id: clientId }))
    .filter(p => p.id !== currentPageId && p.page_object?.page_data);
  let worst = { similarity: 0, page_id: null, same_location_service: false };
  for (const p of pages) {
    const sim = text.similarity(body, text.pageBodyText(p.page_object.page_data));
    if (sim > worst.similarity) {
      worst = {
        similarity: sim, page_id: p.id,
        same_location_service: p.location_id === pageData._location_id, // hint set by caller
      };
    }
  }
  return worst;
}

// Originality vs scraped competitor copy (Spec §7.3).
function competitorOverlap(pageData, modelCopy = []) {
  const body = text.pageBodyText(pageData);
  let worst = 0;
  for (const m of modelCopy) {
    if (!m.content) continue;
    const sim = text.similarity(body, m.content);
    if (sim > worst) worst = sim;
  }
  return worst;
}

// ── Single-field regeneration (per-field regen from the editor) ───────────────
const REGEN_FIELD_CONFIGS = {
  h1: {
    key: 'h1',
    promptFn: (svc, loc) => `Write the H1 page heading for a "${svc}" page in ${loc}. Natural phrasing, includes service + location, not keyword-stuffed.`,
  },
  hero_intro: {
    key: 'hero_intro',
    promptFn: (svc, loc) => `Write the hero intro paragraph for a "${svc}" page in ${loc}. 2-3 sentences mentioning the specific location and what makes this service accessible here.`,
  },
  'approach.intro': {
    key: 'approach_intro',
    promptFn: (svc, loc) => `Write the body copy for the "Our approach to ${svc}" section on a page in ${loc}. Write in 2-3 distinct paragraphs (separate with a blank line). Warm clinical authority, weave in local specifics.`,
  },
  'block.description': {
    key: 'description',
    promptFn: (svc, loc, ctx) => `Write a brief section intro paragraph for an H2 block titled "${ctx.h2 || 'this section'}" on a "${svc}" page in ${loc}. One short paragraph that introduces what this section covers.`,
  },
  'h3.copy': {
    key: 'copy',
    promptFn: (svc, loc, ctx) => `Write description copy for an H3 subsection titled "${ctx.heading || 'this subsection'}" under H2 "${ctx.h2 || ''}" on a "${svc}" page in ${loc}. Informative, unique, include local specifics where naturally relevant.`,
  },
  'faq.answer': {
    key: 'answer',
    promptFn: (svc, loc, ctx) => `Write a concise, helpful FAQ answer to: "${ctx.question || 'this question'}" on a "${svc}" page in ${loc}. Direct, conversational, accurate.`,
  },
};

async function regenField({ pageObject, layers, keywords, field, maxChars, context = {} }) {
  const cfg = REGEN_FIELD_CONFIGS[field];
  if (!cfg) throw new Error(`Unknown regen field: "${field}".`);

  const { service, location, client, tone } = layers;
  const ld = pageObject.location_data;
  const loc = `${location.location_name}, ${location.state}`;

  const prohibited = (client.brand_rules?.prohibited_claims || []).join(', ');
  const ymyl = client.brand_rules?.ymyl;
  const toneBlock = tone ? `Brand voice: ${tone.voice}. Reading level: ${tone.reading_level}.` : 'Brand voice: warm, professional, clear.';
  const primaryKws = (keywords?.primary || []).map(k => k.keyword).slice(0, 5).join(', ');
  const localFacts = `City/State: ${ld.city}, ${ld.state}. Nearby: ${(ld.nearby_areas || []).slice(0, 4).join(', ')}.`;
  const charRule = maxChars ? `HARD CHARACTER LIMIT: ${maxChars} characters maximum (every character including spaces). Do not exceed this limit.` : '';

  const system = `You are a healthcare content writer. Respond ONLY with a JSON object: { "${cfg.key}": "..." }. No prose, no markdown, no extra keys.
${toneBlock}
${charRule}
Weave in these primary keywords naturally (no stuffing): ${primaryKws || 'n/a'}.
NEVER use these prohibited claims: ${prohibited || '(none)'}.
${ymyl ? 'YMYL: do NOT overclaim medical outcomes. Never invent credentials or certifications.' : ''}`;

  const user = `${cfg.promptFn(service.name, loc, context)}

${localFacts}

Return JSON only: { "${cfg.key}": "..." }`;

  const llm = createLlmClient(config.llm.generationModel);
  const completion = await llm.chat.completions.create({
    model: llm.model,
    ...chatParams(llm.model, { maxTokens: 700 }),
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });

  const raw = JSON.parse(completion.choices[0].message.content);
  const value = raw[cfg.key] || '';
  return maxChars && value.length > maxChars ? value.slice(0, maxChars) : value;
}

/// ── Dental (Gentle Dental) content generation — Build Brief §4 (narrowed) ──
// ONE structured call producing: hero.intro (short description below the H1),
// meta.metaDescription, educationalBody blocks, faq items — the keyword-critical
// fields (title is deterministic, built in compose.buildDentalScaffold).
// servicesInCity.intro is NOT generated — it's an optional manual-entry field
// in the wizard. No OG tags at all (dropped from the contract). NAP/breadcrumb/
// menu/schema scaffolding are assembled in code — never by the model.
//
// This runs on config.llm.dentalWriterModel (the cheaper writer). It does NOT
// decide the H2 stack: dentalOutline.planDentalOutline already graded the
// scraped competitor headings against the curated fallback ladder on Sonnet
// and produced a fixed 6-7 block outline. The writer's job is to fill that
// outline in, readably, and hit the keyword and word budgets.

// Readability + word budget, all from config.dental so the writer
// prompt and qaEngine's gates cannot drift apart (see the note there). Each
// paragraph is capped at "three lines", expressed to the model in words and
// characters — units it can actually count.
const DENTAL_MAX_PARA_WORDS = config.dental.paragraphWords.hardMax;
const DENTAL_MAX_PARA_CHARS = config.dental.paragraphWords.hardMaxChars;
// Typical (not maximum) paragraph length. The budget is expressed PER
// PARAGRAPH, not per block: blocks carry 1-3 paragraphs, so a flat
// '70-95 words per block' contradicted the page total whenever the outline
// asked for three paragraphs.
const DENTAL_PARA_WORDS_MIN = config.dental.paragraphWords.min;
const DENTAL_PARA_WORDS_MAX = config.dental.paragraphWords.max;
const DENTAL_MAX_LIST_ITEM_WORDS = config.dental.listItemMaxWords;
const DENTAL_MAX_FAQ_ANSWER_WORDS = config.dental.faqAnswerMaxWords;
const DENTAL_MIN_LOCALIZED_FAQS = config.dental.faqs.minLocalized;
const DENTAL_META_DESC_MIN = config.dental.metaDescription.min;
const DENTAL_META_DESC_MAX = config.dental.metaDescription.max;
const DENTAL_MIN_FAQS = config.dental.faqs.min;
const DENTAL_MAX_FAQS = config.dental.faqs.max;
// ACCEPT is qaEngine's gate; TARGET is what the writer is asked for,
// deliberately inside the gate so normal variance still passes.
const DENTAL_WORDS_ACCEPT_MIN = config.dental.pageWords.acceptMin;
const DENTAL_WORDS_ACCEPT_MAX = config.dental.pageWords.acceptMax;
const DENTAL_WORDS_TARGET_MIN = config.dental.pageWords.targetMin;
const DENTAL_WORDS_TARGET_MAX = config.dental.pageWords.targetMax;

// ── What each section is FOR ───────────────────────────────────────────────
// Four sections of one page, read by the same person at four different moments,
// doing four different jobs. Generating them under one undifferentiated "write
// SEO copy" instruction is why they used to sound interchangeable — a hero that
// reads like a meta description, an FAQ answer that reads like body copy.
//
// One definition per section, used by BOTH the full generation call and the
// per-section regeneration calls, so a regenerated hero is written to the same
// brief as the original.
const DENTAL_SECTION_BRIEFS = {
  metaDescription: `SECTION: SEO meta description — the SERP snippet. COMMERCIAL.
Where it appears: Google's results page, NOT on the page itself.
Who is reading: someone scanning ten near-identical dental results, about to pick one practice to
call. They are shopping, not studying.
Its job: win the click against nine competitors. Three moves, in this order:
  1. the outcome or service, and the city — what they get and where;
  2. one concrete reason to choose HERE (an option this office offers, who it suits, a practical
     point about the visit) — something a rival snippet could not claim identically;
  3. a clear next step: book, schedule, call, ask about a consultation.
Every clause has to pay for its characters.
Do NOT: summarize the page ("learn about…", "everything you need to know"), restate the H1, reuse
the hero intro's sentences, or promise prices, availability or outcomes you were not given. No hype,
no "welcome to", no exclamation marks. Vary the closing step across pages — the same "Call today"
bolted onto every description is the tell of a template.`,

  heroIntro: `SECTION: hero intro — the short paragraph directly under the H1. COMMERCIAL.
Where it appears: the first thing read after the click, above the fold.
Who is reading: someone who just landed, has about three seconds, and is deciding whether this
practice is the one to book with. They are at the point of choosing a provider.
Its job: sell the visit, not the page. Three moves:
  1. open with the OUTCOME the patient actually wants, in plain language;
  2. make clear this office provides it, here — name the service and city naturally;
  3. point at the next step: a consultation, a visit, finding out whether it suits them.
Do NOT: describe the page ("learn about the process, costs and what to expect" belongs on a blog,
not on a page whose job is to fill a chair), open with the keyword, stack the service and city into
a label, list features, or repeat the H1. This is the sentence most often force-fitted — write it as
if the keyword did not exist, then check the topic and city read naturally.
GOOD: "Straighten your teeth discreetly with Invisalign clear aligners in Boston. Book a
consultation to find out whether clear aligners suit your smile and how long treatment would take."
BAD (informational — describes the page instead of moving the reader): "Straighten your teeth
discreetly with Invisalign clear aligners in Boston. Learn about the treatment process, costs, and
what to expect from start to finish."
BAD (force-fitted keyword): "Invisalign Boston patients trust offers a discreet way to straighten
teeth without metal brackets. At your visit, we'll explain clear aligner treatment, discuss
Invisalign cost Boston and help you understand what to expect from start to finish."`,

  educationalBody: `SECTION: educational body — the H2 stack that makes up the page.
Where it appears: the main body, under scannable headings.
Who is reading: someone researching the procedure and, at the same time, judging whether this
practice actually understands their problem.
Its job: answer the real question behind each heading, first sentence first. Each block must stand
on its own when lifted out of context, because that is how AI answer engines quote it.
Do NOT: sell, add a CTA to every block, restate the heading as the opening sentence, or repeat what
another block already covered. Explain like a good dentist explaining to a patient, not like a
brochure.`,

  faqs: `SECTION: FAQ — the questions patients ask before they book.
Where it appears: the bottom of the page, and inside Google's FAQ rich result.
Who is reading: someone with one specific blocker left: what it costs, whether it hurts, how long it
takes, whether insurance covers it, whether they are a candidate, what recovery is like.
Its job: ask the question in the patient's own words — the way they would say it out loud — and
answer it in the FIRST sentence. Cover different blockers; do not ask the same question twice.
Do NOT: write marketing questions ("Why choose us?"), bury the answer after a preamble, or repeat an
educational block verbatim.

LOCALIZING THE FAQ — at least ${DENTAL_MIN_LOCALIZED_FAQS} questions must name the location, and the city belongs ONLY in a
question whose answer actually depends on it. Ask yourself: would the answer be different in another
city? If not, the city is decoration and a reader notices.

Local by nature — what THIS office provides, which options it runs, booking here:
  GOOD "What types of sedation dentistry are available at your Methuen location?"
  GOOD "Is oral conscious sedation offered in Methuen?"
  GOOD "Do you offer IV sedation at your Methuen practice?"
  GOOD "Do you use sedation for dental implants at our Methuen office?"

Universal by nature — pain, duration, safety, candidacy, risks. The answer is identical everywhere,
so NEVER attach a city to one:
  BAD  "Does sedation dentistry hurt in Methuen?"
  BAD  "How long does sedation dentistry take in Methuen?"
  BAD  "Is sedation dentistry safe for me in Methuen?"
  BAD  "Who should consider sedation dentistry in Methuen?"

Note that "in Methuen" appears in both lists, so this is not about phrasing — it is about what the
question asks. Keep the universal questions (patients genuinely ask them) and simply leave the city
out of those; carry the location in the availability questions instead. Naming the office as
the practice name followed by the city (however this office is branded) is fine — that is what the
office is actually called, and patients say it that way.`,
};

const DENTAL_L3_SCHEMA_HINT = `{
  "heroIntro": "string — the short paragraph under the H1. 1-2 sentences, 30-40 words. Commercial intent: lead with the patient outcome, then point at the next step. Never the keyword first, never a description of the page.",
  "metaDescription": "string — MUST be ${DENTAL_META_DESC_MIN}-${DENTAL_META_DESC_MAX} characters TOTAL, counting every character including spaces. A two-sided range: too short wastes the snippet, too long is truncated by Google. Count it, and if it is short, add a genuinely specific clause about THIS practice or city rather than a generic CTA. Must end as a complete sentence.",
  "educationalBody": [
    { "h2": "string — the heading from the OUTLINE, in the same order", "html": "string — clean semantic HTML using ONLY <p>, <ul>, <li>. No inline styles/classes." }
  ],
  "faqs": [
    { "q": "string", "a": "string" }
  ]
}`;

// A FUNCTION of the practice name, not a constant. Most offices trade as
// Gentle Dental, but some carry their own local brand (Newbury Dental
// Associates), and a page that calls that office Gentle Dental is wrong in the
// one detail a local searcher checks first.
const dentalSystemPrompt = (brandName) => `You are an expert local-SEO + GEO/AEO content writer for ${brandName},
a dental practice in Massachusetts and New Hampshire.

THIS IS A COMMERCIAL-INTENT PAGE. It is not a guide and not a blog post. The person reading it has
already decided they may want this treatment and is now choosing WHERE to have it done — they are
comparing practices, not researching a topic for its own sake. That shapes the page top to bottom:

  - The title, meta description and hero intro have to win the appointment. They lead with the
    outcome the patient wants, make clear this office provides it here, and move toward the next
    step (booking, a consultation, a call).
  - The educational body and FAQ earn the trust that makes that step feel safe, by explaining
    plainly rather than selling. They are the evidence, not the pitch.

Commercial does NOT mean hype. No superlatives, no "state-of-the-art", no exclamation marks, no
invented credentials or prices. Concrete and specific converts; adjectives do not.

Write US English in AP style:
- Spell out one through nine; numerals for 10+. Always use numerals for data/metrics.
- Percentages as numerals + % (e.g. 14%).
- NO serial (Oxford) comma, ever: write "chewing, speaking and comfort", never "chewing, speaking,
  and comfort". Recast the sentence if that reads ambiguously. (qaEngine's ap_style gate has no
  ambiguity exception, so an "unless it avoids ambiguity" licence here just fails the page.)
- No em dashes as stylistic connectors. Title case for section headers.
Tone: conversational but polished, trustworthy, patient-friendly. Never clinical-cold, never hypey.

READABILITY IS THE TOP PRIORITY. A patient skimming on a phone must be able to read any block in
seconds. These are hard rules, not preferences:
- Each educational block gets the number of paragraphs its outline entry specifies (1-3). Never more.
- EVERY paragraph is at most three lines on a phone: ${DENTAL_MAX_PARA_WORDS} words / about ${DENTAL_MAX_PARA_CHARS} characters. Never longer.
  Aim for ${DENTAL_PARA_WORDS_MIN}-${DENTAL_PARA_WORDS_MAX} words per paragraph; ${DENTAL_MAX_PARA_WORDS} is the hard ceiling, not the target.
- One idea per paragraph. Short sentences, ideally under 18 words. Plain patient language over
  clinical vocabulary; when a clinical term is unavoidable, define it in the same sentence.
- No stacked clauses, no wall-of-text paragraphs, no paragraph that just restates the heading.
- A short <ul> of 3-5 items is allowed in AT MOST 2 blocks total, only where a list genuinely helps
  scanning (options, symptoms, steps). A list counts as one paragraph toward that block's count, and
  each <li> is a single line of at most ${DENTAL_MAX_LIST_ITEM_WORDS} words.
- Use ONLY <p>, <ul> and <li>. No headings inside the HTML (the h2 field carries the heading), no
  inline styles, no classes, no links.

Hard rules:
- Do NOT invent office addresses, phone numbers, hours, prices, dentist names, or patient reviews.
- THE PRACTICE IS CALLED "${brandName}". Use that name, or a plain "our team" / "our office". Never
  call it anything else, and never introduce another practice name — not every office in this group
  trades under the same brand.
- Localize meaningfully to the specific city so this page is not a near-duplicate of other cities'
  pages: reference the city (and neighborhood/region where natural) in the block the outline marks
  "localize" and in at least one FAQ.
- Write answer-first: each block and each FAQ answer must be self-contained and directly useful when
  lifted out of context (this is what AI answer engines cite).
- Medical accuracy: describe procedures factually; include candidacy, benefits, risks/safety where
  relevant. No guarantees of outcomes.
- metaDescription is a HARD two-sided range: ${DENTAL_META_DESC_MIN}-${DENTAL_META_DESC_MAX} characters, not "up to ${DENTAL_META_DESC_MAX}." Count it before
  answering; a description of 130-145 characters fails review just as badly as one over ${DENTAL_META_DESC_MAX}. If it
  comes up short, earn the extra characters with something true and specific to THIS practice or
  city — an insurance note, what makes the visit easier, who the office serves. Never pad with a
  generic "Call us today" clause, and never hand back a sentence that stops mid-thought: the whole
  string has to read as finished prose, because it is the only thing a searcher sees.

THE OUTLINE IS FIXED. The user message gives you the exact H2 blocks, in order, already decided by a
separate editorial pass that judged real competitor pages against a curated ladder. Return exactly
those blocks, in that order, copying each heading VERBATIM into the h2 field. Do NOT add, drop,
merge, reorder or rename blocks, and do not second-guess the selection. Returning a different number
of blocks than the outline lists is a failed response.

KEYWORDS — a keyword is a SEARCH QUERY, never a phrase to reproduce.

Keywords tell you what the page is ABOUT. They are typed into a search box, so they are usually not
grammatical English: "invisalign cost boston", "root canal dentist malden", "veneers quincy". NEVER
paste one into a sentence. Write the IDEA in natural English instead.

- THERE IS NO FREQUENCY TARGET. Do not count keyword uses, and never add a mention to hit a number.
  Write the page as a person would, then stop. A page that names the topic twice, naturally, is
  better than one that names it six times awkwardly.
- NEVER put the city directly after the service, and never use that pair as a label for people or
  things. Every one of these is wrong: "Invisalign Boston", "Invisalign Boston patients",
  "veneers Quincy residents", "root canal cost Malden", "teeth whitening Quincy options".
  Anything shaped like "{service} {city}" or "{service} {city} + noun" is wrong.
- Put a real preposition in, or drop the city from that sentence: "Invisalign in Boston",
  "the cost of Invisalign in Boston", "our Boston team", "clear aligners in Boston".
- Name the city where it carries real local meaning — a couple of times across the page and in one
  FAQ. Not in every paragraph, and never twice in one paragraph.

  WRONG (a keyword pasted in twice, and a phrase no person would say):
    "Invisalign Boston patients trust offers a discreet way to straighten teeth without metal
     brackets. At your visit, we'll explain clear aligner treatment, discuss Invisalign cost Boston
     and help you understand what to expect from start to finish."
  RIGHT (same topic, same city, same coverage — written as English):
    "Straighten your teeth discreetly with Invisalign clear aligners in Boston. Learn about the
     treatment process, costs, and what to expect from start to finish."

- SECONDARY keywords: use one only where it already fits the sentence you were going to write. If
  it cannot be placed naturally, LEAVE IT OUT. A forced keyword is worse than a missing one.
- If you find yourself rearranging a sentence to fit a keyword, you have gone wrong: write the
  sentence properly and let the keyword go.

Return ONLY JSON, no prose, no markdown fences, matching the schema provided in the user message.`;

function formatOutlineForPrompt(outline) {
  return (outline?.blocks || []).map((b, i) => {
    const bits = [`${i + 1}. H2: "${b.h2}" — ${b.paragraphs} paragraph${b.paragraphs === 1 ? '' : 's'}`];
    if (b.intent) bits.push(`   Cover: ${b.intent}`);
    if (b.localize) bits.push('   LOCALIZE: name the city (and its neighborhoods/region where natural) in this block.');
    return bits.join('\n');
  }).join('\n');
}

function buildDentalPrompt({ service, location, primaryKeyword, secondaryKeywords, outline, competitorFaqs, correction, brandName }) {
  const officeName = location.location_name;
  const brand = brandName || config.dental.brand.default;
  const cityState = `${location.city}, ${location.state_abbreviation}`;
  const blocks = outline?.blocks || [];
  const totalParagraphs = blocks.reduce((n, b) => n + b.paragraphs, 0);
  // The keyword title-cased is exactly the wrong form — the pasted search
  // string. Showing it back concretely beats describing the shape in the
  // abstract.
  const forcedExample = String(primaryKeyword || '').replace(/\b\w/g, c => c.toUpperCase());

  const bodyStack = `${DENTAL_SECTION_BRIEFS.educationalBody}

Write exactly these ${blocks.length} blocks, in this order:
${formatOutlineForPrompt(outline)}

That is ${totalParagraphs} paragraphs across ${blocks.length} blocks. Write ${DENTAL_PARA_WORDS_MIN}-${DENTAL_PARA_WORDS_MAX} words per paragraph
(${DENTAL_MAX_PARA_WORDS} is the hard ceiling), so the block bodies ALONE come to roughly
${totalParagraphs * DENTAL_PARA_WORDS_MIN}-${totalParagraphs * DENTAL_PARA_WORDS_MAX} words. The hero intro and FAQs are counted separately, in the WORD BUDGET below.`;

  const faqBlock = (competitorFaqs || []).length
    ? `COMPETITOR FAQ TOPICS (real questions competitor pages answer for this keyword — write your
own original answers, do not copy theirs):
${competitorFaqs.map(f => `- ${f}`).join('\n')}`
    : '';

  // Second pass only. Models cannot count their own output reliably, but they
  // correct well when handed the real numbers — so the retry names exactly
  // what missed and by how much, and covers the meta description as well as
  // the body. Length is the model's job precisely because it is the only party
  // that can shorten or extend copy and keep it readable; code can only trim.
  const notes = [];
  if (correction?.words != null && wordBandDistance(correction.words) > 0) {
    notes.push(`- The body came to ${correction.words} words across heroIntro + block bodies + FAQs, outside the required
  ${DENTAL_WORDS_ACCEPT_MIN}-${DENTAL_WORDS_ACCEPT_MAX} range. Land between ${DENTAL_WORDS_TARGET_MIN} and ${DENTAL_WORDS_TARGET_MAX} by ${correction.words > DENTAL_WORDS_ACCEPT_MAX ? 'tightening sentences and dropping the weakest paragraph from the longest blocks' : 'adding a genuinely useful sentence to the thinnest blocks'}.
  Keep the same blocks, headings and order.`);
  }
  if (correction?.metaChars != null) {
    notes.push(`- The meta description was ${correction.metaChars} characters, outside ${DENTAL_META_DESC_MIN}-${DENTAL_META_DESC_MAX}. Rewrite it to land in
  range and END AS A COMPLETE SENTENCE. ${correction.metaChars < DENTAL_META_DESC_MIN
    ? 'Earn the extra characters with something specific and true about this practice or city, not a generic CTA.'
    : 'Cut the least useful clause rather than trimming mid-thought.'}`);
  }
  const feedback = notes.length ? `\nCORRECTION — fix these and change nothing else:\n${notes.join('\n')}\n` : '';

  const user = `PAGE: ${service.name} in ${officeName}, ${cityState}
Service category: ${service.category}
Practice name (use this, never another): ${brand}
Office name: ${officeName}
Primary keyword: ${primaryKeyword}
Secondary keywords: ${(secondaryKeywords || []).join(', ') || '(none)'}

${DENTAL_SECTION_BRIEFS.heroIntro}
Length: 1-2 sentences, 30-40 words.

${DENTAL_SECTION_BRIEFS.metaDescription}

${bodyStack}

${DENTAL_SECTION_BRIEFS.faqs}
Write ${config.dental.faqs.min}-${config.dental.faqs.max} Q&As, each answer at most ${DENTAL_MAX_FAQ_ANSWER_WORDS} words. At least ${DENTAL_MIN_LOCALIZED_FAQS} must name ${location.city} —
and only in questions about what this office offers, never in a question about pain, duration,
safety or candidacy.
${faqBlock}

WORD BUDGET: heroIntro 30-40 words; ${DENTAL_PARA_WORDS_MIN}-${DENTAL_PARA_WORDS_MAX} words per body paragraph; each FAQ answer at most
${DENTAL_MAX_FAQ_ANSWER_WORDS} words. The TOTAL of heroIntro + all block bodies + all FAQ questions and answers (the meta
description does NOT count) must land between ${DENTAL_WORDS_TARGET_MIN} and ${DENTAL_WORDS_TARGET_MAX} words, and that total is the
binding constraint: if the per-part ranges would put you outside it, adjust paragraph length within
the ${DENTAL_PARA_WORDS_MIN}-${DENTAL_MAX_PARA_WORDS} word range rather than adding or dropping blocks. Count it before you answer.

KEYWORDS: this page is about "${primaryKeyword}". That is a search query, not a phrase to reuse —
write the idea in natural English, put a preposition between the service and the city, and never
write "${forcedExample}". No frequency target: name the topic where it belongs and stop. Use a
secondary keyword only where it already fits the sentence.
${feedback}
Return JSON only, matching this schema:
${DENTAL_L3_SCHEMA_HINT}`;

  return { system: dentalSystemPrompt(brand), user };
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// The same span qaEngine's body_word_count_500_900 measures: hero intro +
// educational block bodies + FAQ Q&As, meta description excluded.
function dentalGeneratedWordCount(l3) {
  const parts = [
    l3.heroIntro || '',
    ...(Array.isArray(l3.educationalBody) ? l3.educationalBody.map(b => stripTags(b.html)) : []),
    ...(Array.isArray(l3.faqs) ? l3.faqs.flatMap(f => [f.q || f.question || '', f.a || f.answer || '']) : []),
  ];
  return text.wordCount(parts.join(' '));
}

function wordBandDistance(wc) {
  if (wc < DENTAL_WORDS_ACCEPT_MIN) return DENTAL_WORDS_ACCEPT_MIN - wc;
  if (wc > DENTAL_WORDS_ACCEPT_MAX) return wc - DENTAL_WORDS_ACCEPT_MAX;
  return 0;
}

// "THE OUTLINE IS FIXED" has to be enforced, not just requested. A writer that
// merges two blocks or invents an eighth silently breaks three things at once:
// the 6-7 block QC gate, the paragraph budget the word count was derived from,
// and the index alignment between the page's blocks and outlineMeta.sources
// (which is what labels each heading competitor/fallback/blend in the wizard).
//
// So: a draft whose block count doesn't match the outline is rejected and
// retried, and the headings are restored from the outline by index — the
// planner already decided them, and letting the writer reword them is how the
// provenance labels drift out of sync with what's on the page.
function matchesOutline(l3, outline) {
  const planned = outline?.blocks || [];
  if (!planned.length) return true;
  return Array.isArray(l3?.educationalBody) && l3.educationalBody.length === planned.length;
}

function alignToOutline(l3, outline) {
  // Restoring headings by list position is only sound when the counts agree.
  // If the writer dropped a block, position 3 of the response is planned
  // block 4's copy, and stamping the plan's heading 3 onto it would put the
  // wrong heading over the wrong body — worse than a paraphrased heading. So
  // a mismatched response keeps its own headings and QC flags the count.
  if (!matchesOutline(l3, outline)) return l3;
  const planned = outline?.blocks || [];
  if (!planned.length || !Array.isArray(l3?.educationalBody)) return l3;
  l3.educationalBody = l3.educationalBody.map((b, i) => ({
    h2: planned[i].h2,
    html: b.html || '',
  }));
  return l3;
}

async function generateDentalL3({ service, location, primaryKeyword, secondaryKeywords, outline, competitorFaqs, brandName }) {
  const llm = createLlmClient(config.llm.dentalWriterModel);
  const base = { service, location, primaryKeyword, secondaryKeywords, outline, competitorFaqs, brandName };

  const draft = async (correction) => {
    const { system, user } = buildDentalPrompt({ ...base, correction });
    // Keeps the best of the attempts rather than throwing when the model won't
    // honour the block count: a page with the wrong number of blocks is still
    // reviewable (and QC flags it), whereas a hard failure loses the run.
    let best = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const completion = await llm.chat.completions.create({
        model: llm.model,
        // Same reasoning-overhead risk as generateL3 above (verified: this
        // prompt's instruction density made Claude exhaust a 3500-token budget
        // with zero visible output — finish_reason "length", empty content).
        // 6-7 blocks plus 6 FAQs needs more headroom than the old 3-5 stack.
        ...chatParams(llm.model, { maxTokens: 10000 }),
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      try {
        const raw = JSON.parse(completion.choices[0].message.content);
        if (raw && (raw.metaDescription || raw.educationalBody || raw.heroIntro)) {
          if (matchesOutline(raw, outline)) return alignToOutline(raw, outline);
          best = best || raw;
        }
      } catch { /* retry once */ }
    }
    return best ? alignToOutline(best, outline) : null;
  };

  let l3 = await draft(null);
  if (!l3) throw new Error('Dental content generation returned invalid JSON after retry.');

  // ONE bounded correction pass when the draft misses the word band or the
  // meta description length. A QC gate should not fail an otherwise-good page
  // over a length the model can fix once it is told the real number.
  //
  // Skipped for a draft that already broke the block contract — that page is
  // going back to a reviewer regardless, so buying it a better length is two
  // wasted calls. Keeps whichever draft is closer overall.
  const deviation = (candidate) => {
    const chars = String(candidate.metaDescription || '').trim().length;
    const metaOff = chars < DENTAL_META_DESC_MIN ? DENTAL_META_DESC_MIN - chars
      : chars > DENTAL_META_DESC_MAX ? chars - DENTAL_META_DESC_MAX : 0;
    return wordBandDistance(dentalGeneratedWordCount(candidate)) + metaOff;
  };

  if (deviation(l3) > 0 && matchesOutline(l3, outline)) {
    const metaChars = String(l3.metaDescription || '').trim().length;
    const corrected = await draft({
      words: dentalGeneratedWordCount(l3),
      metaChars: (metaChars < DENTAL_META_DESC_MIN || metaChars > DENTAL_META_DESC_MAX) ? metaChars : null,
    });
    if (corrected && deviation(corrected) < deviation(l3)) l3 = corrected;
  }

  l3.metaDescription = normalizeMetaDescriptionLength(l3.metaDescription);
  if (Array.isArray(l3.educationalBody)) {
    l3.educationalBody = l3.educationalBody.map(b => ({ ...b, html: text.normalizeBlockHtml(b.html) }));
  }
  return l3;
}

// A 150-160 char TWO-SIDED range is hard for an LLM to hit reliably (it's easy
// to cap a max, much harder to guarantee a min) — this is a deterministic
// safety net so QC's meta_description_length check doesn't fail on an
// otherwise-good page. Mirrors the existing Neuro pattern of clipping as a
// safety net after generation (compose.mergeL3).
// Trims an over-long description at a SENTENCE boundary so it never ends
// mid-thought. Falls back to a word boundary only if there is no sentence
// break late enough to keep a usable description, and then drops any trailing
// function word ("and", "our", "to") so the result cannot read as a fragment.
const DANGLING_WORDS = /\s+(?:a|an|and|about|after|as|at|before|but|by|during|each|every|for|from|his|her|if|in|into|its|of|on|or|our|over|so|than|that|the|their|then|these|this|those|to|under|when|while|with|your)$/i;

// Trims an over-long description so it can never end mid-thought.
//
// Prefers the last COMPLETE sentence that fits, but only if that still fills
// the snippet — cutting a 203-character description back to its 103-character
// first sentence trades one defect for another, so a sentence trim that lands
// under `min` is rejected in favour of a word-boundary trim. After a word cut
// the tail is stripped of any trailing function word, so the result cannot
// read as "...walk you through every."
function trimToSentence(s, max, min) {
  if (s.length <= max) return s;

  const window = s.slice(0, max + 1);
  const lastStop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  const trimmed = window.trim();
  const endsInWindow = /[.!?]$/.test(trimmed) ? trimmed.length : -1;
  const sentenceEnd = Math.max(lastStop >= 0 ? lastStop + 1 : -1, endsInWindow);
  if (sentenceEnd >= min) return s.slice(0, sentenceEnd).trim();

  let out = s.slice(0, max);
  const lastSpace = out.lastIndexOf(' ');
  if (lastSpace > 0) out = out.slice(0, lastSpace);
  out = out.replace(/[,;:\s]+$/, '');
  while (DANGLING_WORDS.test(out)) out = out.replace(DANGLING_WORDS, '').replace(/[,;:\s]+$/, '');
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

function normalizeMetaDescriptionLength(desc) {
  const s = String(desc || '').trim().replace(/\s+/g, ' ');
  return s.length > DENTAL_META_DESC_MAX ? trimToSentence(s, DENTAL_META_DESC_MAX, DENTAL_META_DESC_MIN) : s;
}

// ── Dental per-section regeneration ("regenerate every section") ──────────
// One small, targeted LLM call per section instead of regenerating the
// whole page. Shares the same hard rules (no fabricated NAP/reviews, AP
// style, readability caps) as the main generation call, and runs on the same
// writer model.
// The regenerated copy answers to the SAME ap_style gate as a full generation,
// so it has to carry the same rules — the serial-comma one especially, which
// was missing here and is the slip a full-body rewrite reliably made.
const dentalRegenGuardrails = (brandName) => `Write US English in AP style (spell out one-nine, numerals 10+, no em dashes,
title case headers, and NO serial/Oxford comma — write "x, y and z", never "x, y, and z").
Tone: conversational, trustworthy, patient-friendly. Do NOT invent office
addresses, phone numbers, hours, prices, dentist names, or patient reviews. The practice is called
"${brandName || config.dental.brand.default}" — use that name or a plain "our team"; never call it
anything else. No guarantees of medical
outcomes. When COMPETITOR context is provided, model coverage/subject matter only — never copy
phrasing, NAP, names, or reviews.

READABILITY IS THE TOP PRIORITY: every paragraph is at most three lines on a phone
(${DENTAL_MAX_PARA_WORDS} words / about ${DENTAL_MAX_PARA_CHARS} characters), one idea per paragraph, sentences ideally under 18
words, plain patient language. No wall-of-text paragraphs. Body HTML uses ONLY <p>, <ul> and <li> —
no inline styles, classes or links.

KEYWORDS: a keyword is a SEARCH QUERY, not a phrase to reproduce. Never paste it into a sentence and
never put the city directly after the service — "Invisalign Boston patients", "root canal cost
Malden" and "veneers Quincy options" are all wrong. Put a real preposition in ("Invisalign in
Boston", "the cost of a root canal in Malden") or leave the city out of that sentence. There is no
frequency target: name the topic where it belongs and stop. Use a secondary keyword only where it
already fits the sentence you were going to write; otherwise omit it.

Return ONLY JSON, no prose, no markdown fences.`;

function competitorContextBlock(competitorHeadings, competitorFaqs) {
  const parts = [];
  if ((competitorHeadings || []).length) {
    parts.push(`COMPETITOR HEADINGS (model subject-matter coverage, don't copy phrasing):\n${competitorHeadings.map(h => `- ${h}`).join('\n')}`);
  }
  if ((competitorFaqs || []).length) {
    parts.push(`COMPETITOR FAQ TOPICS (write your own original answers):\n${competitorFaqs.map(f => `- ${f}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

async function generateDentalRegen({ service, location, primaryKeyword, secondaryKeywords, competitorHeadings, competitorFaqs, section, context = {}, outline, brandName }) {
  const llm = createLlmClient(config.llm.dentalWriterModel);
  const cityState = `${location.city}, ${location.state_abbreviation}`;
  const competitorBlock = competitorContextBlock(competitorHeadings, competitorFaqs);
  const kwLine = `Primary keyword: ${primaryKeyword}\nSecondary keywords: ${(secondaryKeywords || []).join(', ') || '(none)'}`;

  let schemaHint, task;
  if (section === 'heroIntro') {
    schemaHint = `{ "heroIntro": "string — 1-2 sentences, 30-40 words, leading with the patient outcome and closing on the next step" }`;
    task = `${DENTAL_SECTION_BRIEFS.heroIntro}

Write ONLY a fresh hero intro for "${service.name}" in ${cityState}. 1-2 sentences, 30-40 words.`;
  } else if (section === 'metaDescription') {
    schemaHint = `{ "metaDescription": "string — MUST be ${DENTAL_META_DESC_MIN}-${DENTAL_META_DESC_MAX} characters total, names the service and city, gives one reason to choose this office, ends with a clear next step as a complete sentence" }`;
    task = `${DENTAL_SECTION_BRIEFS.metaDescription}

Write ONLY a fresh meta description for "${service.name}" in ${cityState}. ${DENTAL_META_DESC_MIN}-${DENTAL_META_DESC_MAX} characters, ending as a complete sentence.`;
  } else if (section === 'educationalBlock') {
    schemaHint = `{ "h2": "string — heading", "html": "string — 1-3 paragraphs, each at most ${DENTAL_MAX_PARA_WORDS} words, using ONLY <p>, <ul>, <li>" }`;
    const otherHeadings = (context.otherHeadings || []).filter(Boolean);
    task = `${DENTAL_SECTION_BRIEFS.educationalBody}

Write ONE fresh educational H2 block (heading + HTML body) for "${service.name}" in ${cityState}${
      context.currentH2 ? `, replacing the current heading "${context.currentH2}"` : ''
    }.${otherHeadings.length ? ` Do NOT duplicate these other headings already on the page: ${otherHeadings.join(' | ')}.` : ''}
The block is 1-3 short paragraphs of ${DENTAL_PARA_WORDS_MIN}-${DENTAL_PARA_WORDS_MAX} words each (${DENTAL_MAX_PARA_WORDS} is the hard ceiling per paragraph).`;
  } else if (section === 'educationalBody') {
    // Same fixed-outline contract as the full generation call — the stack was
    // already decided by dentalOutline.planDentalOutline.
    const blocks = outline?.blocks || [];
    schemaHint = `{ "educationalBody": [ { "h2": "string", "html": "string — paragraphs of at most ${DENTAL_MAX_PARA_WORDS} words, using ONLY <p>, <ul>, <li>" } ] }`;
    // dentalWizard always plans an outline for this section. The guard keeps a
    // direct caller from producing "return exactly these 0 blocks".
    const stackRule = blocks.length
      ? `THE OUTLINE IS FIXED — return exactly these ${blocks.length} blocks, in this order, copying each heading
VERBATIM. Do NOT add, drop, merge, reorder or rename blocks:
${formatOutlineForPrompt(outline)}`
      : `Write a 6-7 block H2 stack covering this service the way a patient learns it: what it is, why
or when it is needed, the process, candidacy and options, then cost, insurance and safety.`;
    task = `${DENTAL_SECTION_BRIEFS.educationalBody}

Write the educational H2 stack for "${service.name}" in ${cityState}.

${stackRule}

Write ${DENTAL_PARA_WORDS_MIN}-${DENTAL_PARA_WORDS_MAX} words per paragraph. Place the primary keyword or a close variant 4-5 times
across the whole stack, spread over different blocks.`;
  } else if (section === 'faqs') {
    schemaHint = `{ "faqs": [ { "q": "string", "a": "string" } ] }`;
    task = `${DENTAL_SECTION_BRIEFS.faqs}

Write a fresh set of ${DENTAL_MIN_FAQS}-${DENTAL_MAX_FAQS} FAQ Q&As for "${service.name}" in ${cityState}, phrased the way patients ask; each answer at most ${DENTAL_MAX_FAQ_ANSWER_WORDS} words. At least ${DENTAL_MIN_LOCALIZED_FAQS} must name ${location.city}, and only where the answer genuinely depends on it (what this office offers), never on a pain/duration/safety/candidacy question.`;
  } else if (section === 'faqItem') {
    schemaHint = `{ "q": "string", "a": "string" }`;
    const otherQuestions = (context.otherQuestions || []).filter(Boolean);
    task = `${DENTAL_SECTION_BRIEFS.faqs}

Write ONE fresh FAQ Q&A for "${service.name}" in ${cityState}${
      context.currentQ ? `, replacing the current question "${context.currentQ}"` : ''
    }, phrased the way a patient asks, answer at most ${DENTAL_MAX_FAQ_ANSWER_WORDS} words. Name ${location.city} only if this
question is about what the office offers; never attach it to a pain, duration, safety or candidacy question.${otherQuestions.length ? ` Do NOT duplicate these other questions already on the page: ${otherQuestions.join(' | ')}.` : ''}`;
  } else {
    throw new Error(`Unknown regen section "${section}".`);
  }

  const system = `${dentalRegenGuardrails(brandName)}\nSchema:\n${schemaHint}`;
  const user = `${task}\n\n${kwLine}\n\n${competitorBlock}\n\nReturn JSON only, matching the schema.`;

  // The full-stack rewrite produces 6-7 blocks, so it needs the same headroom
  // as generateDentalL3; single-field regens stay cheap.
  const maxTokens = section === 'educationalBody' ? 8000 : 1500;

  // Parsing as JSON is not the same as being usable. A `faqs` rewrite that
  // comes back with a single question is valid JSON and destroys a passing
  // page's whole FAQ block (faq_count_min_4 is CRITICAL), so the count is part
  // of what makes a response acceptable — same principle as matchesOutline
  // rejecting a body with the wrong number of blocks.
  const acceptable = (raw) => {
    if (!raw) return false;
    if (section === 'faqs') return Array.isArray(raw.faqs) && raw.faqs.length >= DENTAL_MIN_FAQS;
    return true;
  };

  let result = null;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    const completion = await llm.chat.completions.create({
      model: llm.model,
      ...chatParams(llm.model, { maxTokens }),
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    try {
      const raw = JSON.parse(completion.choices[0].message.content);
      if (acceptable(raw)) result = raw;
    } catch { /* retry once */ }
  }
  if (!result) throw new Error(`Dental regeneration ("${section}") returned invalid JSON after retry.`);
  if (section === 'metaDescription') result.metaDescription = normalizeMetaDescriptionLength(result.metaDescription);
  // Full-stack rewrites answer to the same fixed outline as generateDentalL3,
  // so the headings come back from the plan, not the writer's paraphrase.
  if (section === 'educationalBody') alignToOutline(result, outline);
  // Regenerated block copy answers to the same readability gate as a full
  // generation, so it gets the same deterministic HTML repair.
  if (Array.isArray(result.educationalBody)) {
    result.educationalBody = result.educationalBody.map(b => ({ ...b, html: text.normalizeBlockHtml(b.html) }));
  }
  if (section === 'educationalBlock' && typeof result.html === 'string') {
    result.html = text.normalizeBlockHtml(result.html);
  }
  return result;
}

module.exports = {
  buildPrompt, generateL3, crossPageSimilarity, competitorOverlap, regenField,
  buildDentalPrompt, generateDentalL3, generateDentalRegen, DENTAL_SECTION_BRIEFS,
  normalizeMetaDescriptionLength, trimToSentence,
  alignToOutline, matchesOutline, dentalGeneratedWordCount,
};
