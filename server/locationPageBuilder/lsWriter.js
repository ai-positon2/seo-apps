// ── The writer (template §3, §4, §5, §7-§9, §13) ────────────────────────────
// Writes the page from the APPROVED brief. The brief already decided which
// sections exist, what each covers, its keywords and its character budget
// (§15), so this module never chooses a section — it fills one in. That split
// is the template's own: §17, "competitors determine the TOPICS, not the final
// COPY", and §13.1, "use competitor research to determine the core sections".
//
// What it generates: the SEO title, the meta description, the H1, the hero
// one-liner, each section's body, the FAQ intro, and an answer for every
// approved FAQ question. What it must never generate is any location fact,
// price, insurance acceptance, availability, credential or clinical outcome
// (§6's Missing Data Rule, §9's FAQ Answer Rules, §13.17-§13.22) — those are
// pulled from client data or flagged, and the prompt says so in those words.

const config = require('./config');
const text = require('./text');
const lsLadder = require('./lsLadder');
const { chatParams } = require('./llmParams');
const { createLlmClient } = require('../services/llmProviders');
// The deterministic length safety net, reused: trimming an over-long string at
// a sentence boundary (and stripping a trailing function word so it cannot
// read as a fragment) is already solved and is fiddly to get right.
const { trimToSentence } = require('./contentGenerator');

// ── What each generated field is FOR ───────────────────────────────────────
// Seven fields of one page, read by the same person at different moments,
// doing different jobs. Generating them under one undifferentiated "write SEO
// copy" instruction is what produces a hero that reads like a meta description
// and an FAQ answer that reads like body copy.
//
// One definition per field, used by BOTH the full generation call and the
// per-field regeneration calls, so a regenerated hero is written to the same
// brief as the original.
function sectionBriefs(budgets) {
  return {
    seoTitle: `FIELD: SEO title — the clickable line in Google's results (template §3).
Its job: carry the primary keyword (or a close, natural variant of it), make the location obvious,
and read as a title a person would click.
Rules: ${budgets.seoTitle.min}-${budgets.seoTitle.max} characters INCLUDING spaces — count them. Include the brand where it fits. Never
force an exact-match keyword that reads badly: "anxiety treatment anaheim hills" becomes "Anxiety
Treatment in Anaheim Hills". Do not repeat two near-identical primary keywords, and do not stuff.`,

    metaDescription: `FIELD: meta description — the snippet under the title (template §4).
Who is reading: someone scanning ten near-identical results, deciding which one to open.
Its job: win the click. Name the outcome and the location, give one concrete reason to choose here,
and point at a clear next step.
Rules: ${budgets.metaDescription.min}-${budgets.metaDescription.max} characters INCLUDING spaces — a two-sided range, so count it. Work in the
primary keyword or a close variant; work in the second primary keyword ONLY if it is genuinely
different (if the two mean the same thing, use one natural variation instead of both). Must read as
finished prose, never stop mid-thought. No hype, no "learn about…", no "everything you need to know".`,

    h1: `FIELD: H1 — the page's one heading (template §5).
Its job: name what this page is, carrying the primary keyword or a close natural variant, and add
the value the reader gets. Shape: "{keyword, naturally phrased}: {what the reader gets}".
Rules: one H1 only. Readable over exact-match. Do not stack similar keywords into it. It does not
have to match the SEO title word for word.`,

    heroOneLiner: `FIELD: hero one-liner — the single sentence under the H1 (template §5).
Its job: say who this is for and what it does for them, naming the brand and the location naturally.
Rules: ONE concise sentence, ${budgets.heroOneLiner.minWords}-${budgets.heroOneLiner.maxWords} words. Include the primary keyword or a close variant, but
never open with it and never bolt the city onto the service as a label. Do not repeat the H1's
wording. Do not describe the page ("learn about what to expect" describes a blog post).`,

    sections: `FIELD: section bodies — the page's informational core (template §7, §8).
Who is reading: someone researching this service and, at the same time, judging whether this
provider understands their situation.
Its job: answer the real question behind the heading, first sentence first. Each section must stand
on its own when lifted out of context — that is how answer engines quote it.
Rules: write to the section's OWN instructions and character budget. Do not restate the heading as
the opening sentence, do not sell, and do not cover ground another section owns.`,

    faqIntro: `FIELD: FAQ introduction — the short paragraph above the questions (template §9).
Its job: tell the reader what these questions will settle for them.
Rules: ${budgets.faqIntro.minWords}-${budgets.faqIntro.maxWords} words, at most ${budgets.faqIntro.maxChars} characters, 2-3 sentences. Do NOT answer any of the
questions here, and do not list them.`,

    faqs: `FIELD: FAQ answers (template §9).
Who is reading: someone with one blocker left — what it involves, how long it takes, whether they
qualify, what it costs, whether insurance covers it, what happens first.
Its job: answer the question in the FIRST sentence, then add only what is genuinely useful.
Rules: answer the approved questions EXACTLY as written — the wording was signed off, so do not
reword, reorder, merge or drop a question. At most ${budgets.faqAnswerMaxWords} words per answer. Never invent an insurance
acceptance, a price, a duration, a clinical outcome, a telehealth availability or a credential: if
the answer needs a fact you were not given, say what the practice generally does and append
"[REQUIRES CLIENT CONFIRMATION]" so a human resolves it before publication.`,
  };
}

function schemaHint(budgets) {
  return `{
  "seoTitle": "string — ${budgets.seoTitle.min}-${budgets.seoTitle.max} characters, counted",
  "metaDescription": "string — ${budgets.metaDescription.min}-${budgets.metaDescription.max} characters, counted, ending as a complete sentence",
  "h1": "string",
  "heroOneLiner": "string — one sentence, ${budgets.heroOneLiner.minWords}-${budgets.heroOneLiner.maxWords} words",
  "sections": [
    { "h2": "string — the approved heading, copied VERBATIM, in the same order", "html": "string — ONLY <p>, <ul>, <li>. No headings, styles, classes or links." }
  ],
  "faqIntro": "string — ${budgets.faqIntro.minWords}-${budgets.faqIntro.maxWords} words",
  "faqs": [
    { "q": "string — the approved question, copied VERBATIM", "a": "string" }
  ]
}`;
}

// A FUNCTION of the brand and profile, not a constant: §0 requires the same
// framework to work across brands, and the YMYL rules and prohibited claims
// are per-client data (see lsProfiles).
function systemPrompt({ brandName, profile, budgets }) {
  const claims = (profile.prohibitedClaims || []).length
    ? `\nNEVER use any of these phrases or their equivalents, in any form: ${profile.prohibitedClaims.map(c => `"${c}"`).join(', ')}.`
    : '';
  const licensing = profile.licensingLanguage
    ? `\nWhen describing who provides care, this is the only wording that is approved: "${profile.licensingLanguage}"`
    : '';
  const ymyl = profile.ymyl
    ? `\nTHIS IS A YMYL PAGE (health). Accuracy outranks persuasion everywhere they conflict. Describe
services factually, include candidacy and what to expect where relevant, never promise or imply an
outcome, and never present a correlation as a cause.`
    : '';

  return `You are an expert local-SEO content writer for ${brandName}. You are writing ONE location + service
page from an APPROVED CONTENT BRIEF.

THE BRIEF IS FIXED. The user message gives you the exact sections, in order, each with its own
writing instructions, keywords and character budget, plus the exact FAQ questions. Return exactly
those sections in that order with their headings copied verbatim, and exactly those questions.
Do NOT add, drop, merge, reorder or rename anything, and do not second-guess the selection. A
response with a different number of sections or questions is a failed response.

WHAT YOU MAY NOT INVENT — this is the hard line, not a preference:
- No address, phone number, hours, directions or service area. Those are pulled from client records.
- No prices or costs. No insurance acceptance or coverage claims. No wait times or availability.
- No clinician names, credentials, licences or years of experience.
- No claim that a service is available in person, virtually or at a particular location.
- No clinical outcomes, success rates, recovery times or guarantees.
If a sentence needs one of these to work, write the sentence without it, or append
"[REQUIRES CLIENT CONFIRMATION]" and let a human resolve it. Inventing one of these is worse than
leaving the page thinner.${claims}${licensing}${ymyl}

READABILITY. A person skimming on a phone must be able to read any section in seconds:
- Each section gets the number of paragraphs its brief entry specifies (${budgets.paragraphsPerBlock.min}-${budgets.paragraphsPerBlock.max}). Never more.
- EVERY paragraph is at most ${budgets.paragraphWords.hardMax} words / about ${budgets.paragraphWords.hardMaxChars} characters. Aim for ${budgets.paragraphWords.min}-${budgets.paragraphWords.max}.
- One idea per paragraph. Short sentences. Plain language over clinical vocabulary; when a clinical
  term is unavoidable, define it in the same sentence.
- A short <ul> of 3-5 items is allowed in at most 2 sections, only where a list genuinely helps
  scanning (options, symptoms, steps). A list counts as one paragraph, each item one line of at
  most ${budgets.listItemMaxWords} words.
- Use ONLY <p>, <ul> and <li>. No headings inside the HTML (the h2 field carries the heading), no
  inline styles, no classes, no links.

KEYWORDS — a keyword is a SEARCH QUERY, never a phrase to reproduce.
Keywords tell you what the page is ABOUT. They are typed into a search box, so they are usually not
grammatical English: "anxiety treatment torrance", "iop program cost long beach". NEVER paste one
into a sentence — write the IDEA in natural English instead.
- There is NO frequency target. Do not count keyword uses and never add a mention to reach a number.
- NEVER put the city directly after the service, and never use that pair as a label for people or
  things. "Anxiety Treatment Torrance", "anxiety treatment Torrance patients" and "IOP Long Beach
  options" are all wrong. Put a real preposition in ("anxiety treatment in Torrance", "the cost of
  an IOP in Long Beach") or leave the city out of that sentence.
- Name the city where it carries real local meaning — a couple of times across the whole page and in
  the sections and questions the brief marks for it. Never twice in one paragraph.
- A SECONDARY keyword is used only where it already fits the sentence you were going to write. If it
  cannot be placed naturally, LEAVE IT OUT. A forced keyword is worse than a missing one.
- Every page must be original: do not write a paragraph that would be identical for another city.

Write US English in plain, warm, professional prose. No superlatives, no exclamation marks, no
"state-of-the-art", no "welcome to". Concrete and specific earns trust; adjectives do not.

Return ONLY JSON, no prose, no markdown fences, matching the schema in the user message.`;
}

function formatSectionsForPrompt(brief) {
  return (brief.sections || []).map((s, i) => {
    const bits = [`${i + 1}. H2: "${s.h2}" — ${s.paragraphs} paragraph${s.paragraphs === 1 ? '' : 's'}, ${s.charLimit.min}-${s.charLimit.max} characters`];
    if (s.instructions) bits.push(`   Must cover: ${s.instructions}`);
    if ((s.keywords || []).length) bits.push(`   Keywords for this section (use only where they fit naturally): ${s.keywords.join(', ')}`);
    if (s.localize) bits.push('   LOCALIZE: this is the ONE section that names the city and its surrounding areas.');
    return bits.join('\n');
  }).join('\n');
}

function formatFaqsForPrompt(brief) {
  return (brief.faqs || []).map((f, i) => {
    const bits = [`Q${i + 1}: ${f.question}`];
    if (f.intent) bits.push(`   The answer must establish: ${f.intent}`);
    if (f.localize) bits.push('   This answer may name the location — the answer genuinely depends on it.');
    if ((f.keywords || []).length) bits.push(`   Related keyword, if it fits naturally: ${f.keywords.join(', ')}`);
    return bits.join('\n');
  }).join('\n');
}

// The location facts the writer IS allowed to use — the ones actually on
// record. Anything the location row does not hold is listed as unavailable, so
// the model is told what it must not reach for rather than left to guess.
function locationFactsForPrompt(locationInfo) {
  const known = [];
  if (locationInfo.address) known.push(`Address (on record, may be referenced): ${locationInfo.address}`);
  if (locationInfo.phone) known.push(`Phone (on record): ${locationInfo.phone}`);
  if ((locationInfo.servingAreas || []).length) known.push(`Areas this location serves (on record): ${locationInfo.servingAreas.join(', ')}`);
  if (locationInfo.agesServed) known.push(`Ages served (on record): ${locationInfo.agesServed}`);
  const missing = (locationInfo.dataRequired || []).length
    ? `\nNOT ON RECORD — do not state or imply any of these anywhere on the page: ${locationInfo.dataRequired.join('; ')}.`
    : '';
  return `${known.length ? known.join('\n') : 'No location facts are on record for this office.'}${missing}`;
}

function buildUserPrompt({ service, location, locationInfo, brandName, brief, primaryKeyword, secondaryKeywords, budgets, correction }) {
  const briefs = sectionBriefs(budgets);
  const cityState = [location.city, location.state_abbreviation].filter(Boolean).join(', ');
  const totalParagraphs = (brief.sections || []).reduce((n, s) => n + s.paragraphs, 0);
  const secondPrimary = (brief.keywordMap?.metaDescription || [])[1] || '';
  // The keyword title-cased is exactly the wrong form — the pasted search
  // string. Showing it back concretely beats describing the shape abstractly.
  const forcedExample = String(primaryKeyword || '').replace(/\b\w/g, c => c.toUpperCase());

  const notes = [];
  if (correction?.titleChars) {
    notes.push(`- The SEO title was ${correction.titleChars} characters, outside ${budgets.seoTitle.min}-${budgets.seoTitle.max}. Rewrite it to land in range.`);
  }
  if (correction?.metaChars) {
    notes.push(`- The meta description was ${correction.metaChars} characters, outside ${budgets.metaDescription.min}-${budgets.metaDescription.max}. Rewrite it to land in range and END AS A COMPLETE SENTENCE. ${
      correction.metaChars < budgets.metaDescription.min
        ? 'Earn the extra characters with something specific and true about this service or city, not a generic call to action.'
        : 'Cut the least useful clause rather than trimming mid-thought.'}`);
  }
  if ((correction?.sections || []).length) {
    notes.push(`- These sections missed their character budget: ${correction.sections.map(s => `"${s.h2}" was ${s.chars} (needs ${s.min}-${s.max})`).join('; ')}. Fix only those, keeping every heading and the order.`);
  }
  const feedback = notes.length ? `\nCORRECTION — fix these and change nothing else:\n${notes.join('\n')}\n` : '';

  return `PAGE: ${service.name} in ${location.location_name || location.city}${cityState ? `, ${cityState}` : ''}
Brand: ${brandName}
Service category: ${service.category || '(none)'}
Subject this service addresses: ${lsLadder.conditionNameOf(service)}
Primary keyword: ${primaryKeyword}
${secondPrimary ? `Second primary keyword: ${secondPrimary}` : ''}
Secondary keywords: ${(secondaryKeywords || []).join(', ') || '(none)'}

LOCATION FACTS ON RECORD:
${locationFactsForPrompt(locationInfo)}

${briefs.seoTitle}

${briefs.metaDescription}
${secondPrimary ? `The second primary keyword for this page is "${secondPrimary}". Include it ONLY if it is genuinely different from the primary; if the two say the same thing, use one natural variation instead of both.` : ''}

${briefs.h1}

${briefs.heroOneLiner}

${briefs.sections}

Write exactly these ${(brief.sections || []).length} sections, in this order:
${formatSectionsForPrompt(brief)}

That is ${totalParagraphs} paragraphs in total across the sections. Each section's character budget is
binding — count it.

${briefs.faqIntro}

${briefs.faqs}

Answer exactly these ${(brief.faqs || []).length} questions, in this order, with the question text copied verbatim:
${formatFaqsForPrompt(brief)}

KEYWORDS: this page is about "${primaryKeyword}". That is a search query, not a phrase to reuse —
write the idea in natural English, put a preposition between the service and the city, and never
write "${forcedExample}". No frequency target: name the topic where it belongs and stop.
${feedback}
Return JSON only, matching this schema:
${schemaHint(budgets)}`;
}

// ── Length + shape checks on a draft ───────────────────────────────────────
function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sectionCharCount(html) {
  return stripTags(html).length;
}

// Every way a draft can miss its budgets, as one number. Used to decide
// whether a correction pass is worth making and whether it actually helped —
// a "corrected" draft that is worse overall must not replace the original.
function deviation(l3, brief, budgets) {
  const band = (n, min, max) => (n < min ? min - n : n > max ? n - max : 0);
  let total = band(String(l3.seoTitle || '').trim().length, budgets.seoTitle.min, budgets.seoTitle.max);
  total += band(String(l3.metaDescription || '').trim().length, budgets.metaDescription.min, budgets.metaDescription.max);
  (l3.sections || []).forEach((s, i) => {
    const limit = brief.sections?.[i]?.charLimit || budgets.sectionChars;
    total += band(sectionCharCount(s.html), limit.min, limit.max);
  });
  return total;
}

function correctionFor(l3, brief, budgets) {
  const titleChars = String(l3.seoTitle || '').trim().length;
  const metaChars = String(l3.metaDescription || '').trim().length;
  const sections = (l3.sections || []).map((s, i) => {
    const limit = brief.sections?.[i]?.charLimit || budgets.sectionChars;
    const chars = sectionCharCount(s.html);
    return (chars < limit.min || chars > limit.max)
      ? { h2: brief.sections?.[i]?.h2 || s.h2, chars, min: limit.min, max: limit.max }
      : null;
  }).filter(Boolean);
  return {
    titleChars: (titleChars < budgets.seoTitle.min || titleChars > budgets.seoTitle.max) ? titleChars : null,
    metaChars: (metaChars < budgets.metaDescription.min || metaChars > budgets.metaDescription.max) ? metaChars : null,
    sections,
  };
}

// The response has to match the brief it was written from, or the copy detaches
// from the instructions that produced it (and from the per-section budgets the
// word totals were derived from). A mismatched draft is kept — it is still
// reviewable, and QC flags the count — but it is retried first.
function matchesBrief(l3, brief) {
  const sections = brief.sections || [];
  const faqs = brief.faqs || [];
  return Array.isArray(l3?.sections) && l3.sections.length === sections.length
    && Array.isArray(l3?.faqs) && l3.faqs.length === faqs.length;
}

// Restores the approved headings and questions by position. The brief was
// signed off, so a reworded heading is a defect, not a variation — but the
// restore is only sound when the counts agree (otherwise position 3 of the
// response is section 4's copy, and stamping heading 3 onto it puts the wrong
// heading over the wrong body).
function alignToBrief(l3, brief) {
  if (!matchesBrief(l3, brief)) return l3;
  l3.sections = l3.sections.map((s, i) => ({ h2: brief.sections[i].h2, html: s.html || '' }));
  l3.faqs = l3.faqs.map((f, i) => ({ q: brief.faqs[i].question, a: f.a || f.answer || '' }));
  return l3;
}

// Deterministic safety net for the two hard two-sided ranges. An LLM caps a
// max reliably and hits a min far less so; code can only ever shorten, which
// is why the model is asked first and this runs last.
function normalizeLengths(l3, budgets) {
  const title = String(l3.seoTitle || '').trim().replace(/\s+/g, ' ');
  const meta = String(l3.metaDescription || '').trim().replace(/\s+/g, ' ');
  l3.seoTitle = title.length > budgets.seoTitle.max
    // A title has no sentence boundary to trim to, so `min` is passed as the
    // max: trimToSentence then always falls through to its word-boundary path
    // (which also strips a dangling function word) instead of cutting the
    // title back to a fragment that happens to contain a full stop.
    ? trimToSentence(title, budgets.seoTitle.max, budgets.seoTitle.max)
    : title;
  l3.metaDescription = meta.length > budgets.metaDescription.max
    ? trimToSentence(meta, budgets.metaDescription.max, budgets.metaDescription.min)
    : meta;
  return l3;
}

async function generateLsCopy({ service, location, locationInfo, brandName, profile, brief, primaryKeyword, secondaryKeywords }) {
  const budgets = profile.budgets;
  const llm = createLlmClient(config.llm.lsWriterModel);
  const system = systemPrompt({ brandName, profile, budgets });
  const base = { service, location, locationInfo, brandName, brief, primaryKeyword, secondaryKeywords, budgets };

  const draft = async (correction) => {
    const user = buildUserPrompt({ ...base, correction });
    // Keeps the best of the attempts rather than throwing when the model will
    // not honour the counts: a page with the wrong number of sections is still
    // reviewable (and QC flags it), whereas a hard failure loses the run.
    let best = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const completion = await llm.chat.completions.create({
        model: llm.model,
        // Generous: up to 8 sections plus 7 FAQ answers plus four SEO fields,
        // and an instruction-dense prompt on a reasoning model can spend a
        // small budget before emitting anything at all.
        ...chatParams(llm.model, { maxTokens: 12000 }),
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      try {
        const raw = JSON.parse(completion.choices[0].message.content);
        if (raw && (raw.sections || raw.metaDescription || raw.h1)) {
          if (matchesBrief(raw, brief)) return alignToBrief(raw, brief);
          best = best || raw;
        }
      } catch { /* retry once */ }
    }
    return best ? alignToBrief(best, brief) : null;
  };

  let l3 = await draft(null);
  if (!l3) throw new Error('Content generation returned invalid JSON after retry.');

  // ONE bounded correction pass when the draft misses a length band. A QC gate
  // should not fail an otherwise-good page over a length the model can fix
  // once it is told the real number. Skipped for a draft that already broke
  // the brief contract — that page is going back to a reviewer regardless, so
  // buying it a better length is two wasted calls.
  if (deviation(l3, brief, budgets) > 0 && matchesBrief(l3, brief)) {
    const corrected = await draft(correctionFor(l3, brief, budgets));
    if (corrected && deviation(corrected, brief, budgets) < deviation(l3, brief, budgets)) l3 = corrected;
  }

  normalizeLengths(l3, budgets);
  if (Array.isArray(l3.sections)) {
    l3.sections = l3.sections.map(s => ({ ...s, html: text.normalizeBlockHtml(s.html) }));
  }
  return l3;
}

// ── Per-field regeneration ─────────────────────────────────────────────────
// One small targeted call instead of rewriting the page. Shares the same
// system prompt — and therefore the same prohibitions, readability caps and
// keyword rules — as a full generation, so regenerated copy answers to the
// same gates.
const REGEN_FIELDS = {
  seoTitle: { key: 'seoTitle', schema: '{ "seoTitle": "string" }' },
  metaDescription: { key: 'metaDescription', schema: '{ "metaDescription": "string" }' },
  h1: { key: 'h1', schema: '{ "h1": "string" }' },
  heroOneLiner: { key: 'heroOneLiner', schema: '{ "heroOneLiner": "string" }' },
  faqIntro: { key: 'faqIntro', schema: '{ "faqIntro": "string" }' },
  section: { key: 'html', schema: '{ "html": "string — ONLY <p>, <ul>, <li>" }' },
  faqItem: { key: 'a', schema: '{ "a": "string" }' },
};

async function regenerateLsField({
  service, location, locationInfo, brandName, profile, brief, primaryKeyword, secondaryKeywords,
  field, index, current,
}) {
  const budgets = profile.budgets;
  const spec = REGEN_FIELDS[field];
  if (!spec) throw new Error(`Unknown field: ${field}`);
  const briefs = sectionBriefs(budgets);
  const cityState = [location.city, location.state_abbreviation].filter(Boolean).join(', ');

  // What this one field is for, plus only the context it needs. A section
  // regeneration is told the OTHER headings so it cannot drift into their
  // ground; an FAQ answer is told the other questions for the same reason.
  const parts = [
    `PAGE: ${service.name} in ${location.location_name || location.city}${cityState ? `, ${cityState}` : ''}`,
    `Brand: ${brandName}`,
    `Primary keyword: ${primaryKeyword}`,
    `Secondary keywords: ${(secondaryKeywords || []).join(', ') || '(none)'}`,
    '',
    'LOCATION FACTS ON RECORD:',
    locationFactsForPrompt(locationInfo),
    '',
  ];

  if (field === 'section') {
    const section = brief.sections?.[index];
    if (!section) throw new Error('index must reference a section of the approved brief.');
    parts.push(briefs.sections, '',
      `Rewrite ONLY this section. Its heading is fixed and is not yours to change.`,
      `H2: "${section.h2}"`,
      `Must cover: ${section.instructions}`,
      `Length: ${section.paragraphs} paragraph${section.paragraphs === 1 ? '' : 's'}, ${section.charLimit.min}-${section.charLimit.max} characters — count them.`,
      (section.keywords || []).length ? `Keywords, only where they fit naturally: ${section.keywords.join(', ')}` : '',
      section.localize ? 'LOCALIZE: this is the section that names the city and its surrounding areas.' : 'Do NOT name the city in this section — another section carries the location.',
      '',
      `The page's other sections cover these, so do not repeat them: ${(brief.sections || []).filter((_, i) => i !== index).map(s => `"${s.h2}"`).join(', ') || '(none)'}`,
    );
  } else if (field === 'faqItem') {
    const faq = brief.faqs?.[index];
    if (!faq) throw new Error('index must reference a question of the approved brief.');
    parts.push(briefs.faqs, '',
      `Answer ONLY this approved question. Do not reword it.`,
      `Q: ${faq.question}`,
      faq.intent ? `The answer must establish: ${faq.intent}` : '',
      faq.localize ? 'This answer may name the location.' : 'Do NOT name the location in this answer — the answer does not depend on it.',
      '',
      `The other questions on the page: ${(brief.faqs || []).filter((_, i) => i !== index).map(f => `"${f.question}"`).join(', ') || '(none)'}`,
    );
  } else {
    parts.push(briefs[field] || '', '',
      current ? `The current version, which you are replacing — write something genuinely different, not a paraphrase:\n"${current}"` : '',
    );
  }

  parts.push('', `Return JSON only: ${spec.schema}`);

  const llm = createLlmClient(config.llm.lsWriterModel);
  const completion = await llm.chat.completions.create({
    model: llm.model,
    ...chatParams(llm.model, { maxTokens: 2500 }),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt({ brandName, profile, budgets }) },
      { role: 'user', content: parts.filter(p => p !== '').join('\n') },
    ],
  });

  let value = '';
  try {
    const raw = JSON.parse(completion.choices[0].message.content);
    value = raw[spec.key] || raw.value || '';
  } catch {
    throw new Error('Regeneration returned invalid JSON.');
  }
  if (!String(value).trim()) throw new Error('Regeneration returned an empty result.');

  if (field === 'section') return text.normalizeBlockHtml(value);
  if (field === 'seoTitle') return normalizeLengths({ seoTitle: value }, budgets).seoTitle;
  if (field === 'metaDescription') return normalizeLengths({ metaDescription: value }, budgets).metaDescription;
  return String(value).trim().replace(/\s+/g, ' ');
}

module.exports = {
  generateLsCopy, regenerateLsField, systemPrompt, buildUserPrompt,
  sectionBriefs, sectionCharCount, deviation, matchesBrief, alignToBrief,
  normalizeLengths, REGEN_FIELDS,
};
