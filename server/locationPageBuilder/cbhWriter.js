// ── Clear Behavioral Health writer ──────────────────────────────────────────
// Produces every generated string on a CBH page in one structured call.
//
// Its own module rather than a branch inside contentGenerator: that writer's
// entire prompt is built around a flat stack of H2 blocks with a fixed outline
// contract, and this contract is ten named sections with hard character
// caps, one of which nests 4-5 H3s budgeted in LINES. Bending one prompt to
// serve both would make each harder to reason about and put Gentle Dental at
// risk on every CBH change.
//
// The correction pass is driven by the QC gates themselves (cbhQc), not by a
// second copy of the limits. A model cannot count its own characters reliably,
// but it corrects well when handed the real numbers -- and taking those
// numbers from the gates means the instruction can never drift from what the
// page is actually judged against.

const config = require('./config');
const contract = require('./cbhContract');
const cbhCompose = require('./cbhCompose');
const cbhQc = require('./cbhQc');
const cbhFeedback = require('./cbhFeedback');
const cbhFeedbackReview = require('./cbhFeedbackReview');
const { createLlmClient } = require('../services/llmProviders');
const { chatParams } = require('./llmParams');

const { LIMITS: L } = contract;

const SCHEMA_HINT = `{
  "metaTitle": "string",
  "metaDescription": "string",
  "hero": { "h1": "string", "description": "string" },
  "approach": {
    "paragraphs": ["string"],
    "philosophy": ["string"],
    "therapies": ["string"]
  },
  "insurance": "string",
  "educational": {
    "paragraphs": ["string"],
    "h3s": [{ "heading": "string", "lines": ["string"] }]
  },
  "uvp": "string",
  "service": "string",
  "treatment": { "heading": "string", "paragraph": "string" },
  "faqs": [{ "q": "string", "a": "string", "type": "location | brand | intent" }]
}`;

function systemPrompt() {
  return `You are an expert local-SEO content writer for ${contract.BRAND}, a behavioral health provider in California.

THIS IS A COMMERCIAL-INTENT PAGE. The reader has decided they may want this care and is choosing WHERE
to get it. They are comparing providers, not researching a topic.

EVERY LIMIT BELOW IS A CHARACTER COUNT, AND EVERY ONE IS HARD.
Count before you answer. These are not targets to approach: a value over the limit fails review, and
several of them are short enough that one extra clause breaks them. Where a limit is a range, landing
under it fails exactly as badly as landing over it.

PUNCTUATION: NEVER USE AN EM DASH (—).
Not in a heading, not in a paragraph, not in a bullet, not in a meta title or description, not in an
FAQ question or answer. Not anywhere in your output. This is house style and it is absolute.
Use a comma, a colon, a full stop or a pair of brackets instead, and rewrite the sentence where none
of those fits. A bullet starts with "- ", never with a dash of any other kind.

KEYWORDS: a keyword is a SEARCH QUERY, never a phrase to reproduce.
- Keywords are typed into a search box, so they are usually not grammatical English: "anxiety treatment
  cost anaheim hills", "iop pasadena". NEVER paste one into a sentence. Write the IDEA in English.
- NEVER put the city directly after the service, and never use that pair as a label for people or
  things. "Anxiety Treatment Anaheim Hills patients" is wrong. Put a real preposition in: "anxiety
  treatment in Anaheim Hills", "our Anaheim Hills team".
- There is no frequency target. Name the topic where it belongs and stop.

HARD RULES
- Do NOT invent addresses, phone numbers, hours, prices, clinician or therapist names, patient numbers,
  review counts, credentials, awards or years in practice.
- This is health content. No guarantees of outcomes, no success rates, no claim that anyone will
  recover. Describe care factually.
- Do NOT claim insurance coverage beyond "accepts most major insurance providers". Never name a plan
  as covered, and never promise a cost. A client feedback rule in the user message may say more about
  how this particular care is paid for; where it does, follow the rule.
- Headings are NOT yours to write. Every H2 and H3 on this page is fixed and is given to you below.
  Write the body that sits under each one. Do not restate a heading as the opening sentence.
- Write answer-first: each section must be useful when read on its own.

DO NOT WRITE TO A TEMPLATE.
These pages sit on one domain, in one city, and differ only by the care they describe. When four of
them were compared side by side, thirty-eight phrases of four to seven words appeared on three or
more of them. Sentence-level duplication is what makes a set of location pages read as generated.
- Never build a sentence around these shapes. They are the ones that actually repeated:
    "... most major insurance providers, helping make {service} in {city} accessible ..."
    "... our {city} team ..."
    "... {service} in {city} with individualized care plans ..."
    "... scheduling options, including evening appointments ..."
    "Clear Behavioral Health offers/provides ..." as the opening of the Why Choose paragraph
- The insurance sentence MUST still say "most major insurance providers". That wording is required.
  Build a different sentence around it: lead with what it means for this person, or with the care
  itself, rather than with the company name and the same trailing clause every time.
- Vary how each section opens. If the Why Choose paragraph starts with the practice name, the
  insurance and service paragraphs must not.
- Say something only true of THIS care. "Individualized treatment planning, a dedicated clinical
  team, flexible scheduling" is true of every service here and therefore tells the reader nothing.

Return ONLY JSON, no prose, no markdown fences, matching the schema in the user message.`;
}

// The per-section instructions, each stating its own cap. Built from the
// contract so a retuned limit reaches the model and the gate together.
function sectionBrief({ scaffold, h3Plan, faqPlan, primaryKeyword }) {
  const s = scaffold.sections;
  const h3LineChars = L.educational.lineMaxChars;
  const h3Count = h3Plan.length || L.educational.h3Count.max;
  const h3Cap = contract.linesPerBody(h3Count);
  // What the model is actually asked for: the writing that fits once the
  // mandatory breaks are paid for out of the same allowance.
  const h3Lines = contract.contentAllowance(h3Cap);

  // A section marked fallback is cited to a named clinical authority, so it has
  // to be written FROM that source rather than from recall. Handing the model
  // only the heading and then publishing a citation asserts provenance the copy
  // does not have -- which the guidelines forbid ("do not invent information or
  // add unsupported claims") and which is worse than no citation, because it
  // looks verified.
  const h3Line = (h, i) => {
    const bits = [`${i + 1}. ${h.heading}`];
    if (h.intent) bits.push(`   Cover: ${h.intent}`);
    if (h.source === 'fallback' && h.sourceExcerpt) {
      bits.push('   WRITE THIS ONE FROM THE SOURCE BELOW. Use only what it states; add no facts of');
      bits.push('   your own. Rewrite in plain language, and never copy its wording.');
      bits.push(`   SOURCE (${h.sourceUrl}): ${h.sourceExcerpt}`);
    } else if (h.source === 'fallback') {
      bits.push('   No source text was retrieved for this one. Keep it general and factual, and state');
      bits.push('   nothing specific enough to need a citation.');
    }
    return bits.join('\n');
  };

  const h3Block = h3Plan.length
    ? `THE H3 HEADINGS ARE FIXED. Write a body for each of these ${h3Plan.length}, in this order, copying each
heading VERBATIM into "heading". Do not add, drop, reorder or reword them:
${h3Plan.map(h3Line).join('\n')}`
    : `Write ${L.educational.h3Count.min}-${L.educational.h3Count.max} H3s, each heading at most ${L.educational.h3HeadingMaxChars} characters.`;

  const faqBlock = faqPlan.length
    ? `THE FAQ QUESTIONS ARE FIXED. Answer these ${faqPlan.length}, in this order, copying each question VERBATIM
into "q". Do not add, drop, reorder or reword them. Set "type" to the label given:
${faqPlan.map((f, i) => `${i + 1}. [${f.type || 'intent'}] ${f.q}`).join('\n')}`
    : `Write ${L.faqs.count.min}-${L.faqs.count.max} FAQs with a mix of location-specific, brand-specific and
user-intent questions, tagging each with its "type".`;

  return `META TITLE: ${L.metaTitle.min}-${L.metaTitle.max} characters. Do NOT include "${contract.TITLE_SUFFIX.trim()}"; it is appended
automatically and is NOT counted. Include the primary keyword or a close variant. Natural and readable,
never keyword-stuffed.

META DESCRIPTION: ${L.metaDescription.min}-${L.metaDescription.max} characters. Every word of the primary keyword must appear, in any
order. End on a mental-health call to action ("Get support", "Explore treatment options", "Schedule a
consultation"). Natural, not stuffed.

HERO H1: at most ${L.hero.h1MaxChars} characters. Must contain the primary keyword and "${scaffold.locationName}". Engaging and
service-focused, not a bare label.

HERO DESCRIPTION: at most ${L.hero.descriptionMaxChars} characters. Use the primary keyword or a close variation naturally.
State the benefit of the service. Add a call to action where it fits.

APPROACH: heading "${s.approach.heading}" is fixed.
The WHOLE approach section, all three bodies together, is at most ${L.approach.sectionMaxChars} characters.
  - Under the H2: ${L.approach.paragraphsPerBlock.min}-${L.approach.paragraphsPerBlock.max} paragraphs.
  - Under "${s.approach.philosophy.heading}": ${L.approach.paragraphsPerBlock.min}-${L.approach.paragraphsPerBlock.max} paragraphs.
  - Under "${s.approach.therapies.heading}": ${L.approach.paragraphsPerBlock.min}-${L.approach.paragraphsPerBlock.max} paragraphs.
Every paragraph is at most ${L.approach.paragraphMaxChars} characters, and every one must be specific to this service, not
generic copy that would fit any page.

INSURANCE: heading "${s.insurance.heading}" is fixed. ONE paragraph, at most ${L.insurance.maxChars} characters.
Mention accessibility naturally. Say "most major insurance providers"; claim nothing more, unless a client rule below says otherwise.

EDUCATIONAL: heading "${s.educational.heading}" is fixed.
Intro: ${L.educational.introParagraphs.min}-${L.educational.introParagraphs.max} paragraphs, ${L.educational.introMaxChars} characters TOTAL across them.
${h3Block}
EVERY H3 BODY MAY TAKE UP TO ${h3Lines} LINES OF WRITING. That allowance belongs to EACH body separately:
they do not share it, and one body using fewer does not give another more.
Each entry in the "lines" array is EITHER a paragraph OR a bullet:
  • A PARAGRAPH is 2-4 sentences in ONE entry. It costs one line per ${h3LineChars} characters, so a
    220-character paragraph costs three. Do NOT break a paragraph up into one sentence per entry.
  • A BULLET starts with "- " and costs ${1 + L.educational.bulletExtraLines} line${L.educational.bulletExtraLines ? 's' : ''} whatever its length. Use it where the
    content really is a list (options, steps, signs, what to bring), never for a point that needs
    explaining. A run of bullets still pays the paragraph break after every ${L.educational.linesBeforeBreak} lines.
Either form may open with a BOLD SUB-LABEL, written "**Like this**". Use it where a body covers two or
three named things ("**Biological factors** ...", "**Psychological factors** ..."). The asterisks are the
only markup allowed anywhere, and they do not count toward the character limit.
MIX THE TWO. A body of nothing but short standalone sentences reads like a slide, and a body of nothing
but prose buries the list a reader is scanning for. Lead a body with a paragraph, then bullet the part
that enumerates. Both forms must appear across the ${h3Count} subsections.
Every body needs at least one entry.
${h3Lines} is a CEILING, not a target. Use the lines the content genuinely earns and stop. A padded
subsection is worse than a short one that says something, and repeating the heading back as a sentence
counts against you.

WHY CHOOSE: heading "${s.uvp.heading}" is fixed. ONE paragraph, at most ${L.uvp.maxChars} characters.
Name real differentiators and what the patient gets. It must mention this service and ${scaffold.locationName}, because
the heading itself says neither. No superlatives, no "best", no invented credentials.

SERVICE: heading "${s.service.heading}" is fixed. ONE paragraph, at most ${L.service.maxChars} characters. Natural,
specific to the service and the location.

${treatmentHeadingBrief(scaffold)}
PARAGRAPH: ONE paragraph directly under it, at most ${L.treatment.maxChars} characters, about the CLINICIANS: their
experience and how they treat people. "We boast a team of experienced, compassionate clinicians with
many years of experience, dedicated to treating you with the utmost care" is the register. Do not name
a qualification, a licence, a school, a headcount or a number of years, and promise no outcome.

FREQUENTLY ASKED QUESTIONS: each answer at most ${L.faqs.answerMaxChars} characters.
${faqBlock}
Questions must be genuinely useful. Never force a keyword into a question or an answer.`;
}

// Every page generated now has the treatment H2 built by code; the composed
// form is kept for a scaffold without the marker so the two never disagree.
function treatmentHeadingBrief(scaffold) {
  if (scaffold?.meta?.fixedExpertsHeading) {
    return `TREATMENT: heading "${scaffold.sections.treatment.heading}" is fixed. It sits between the section above
and the FAQs. Return "treatment.heading" as that exact string.`;
  }
  return `TREATMENT: this is the ONE section where you write the H2 as well as the body. It sits between the
section above and the FAQs.
H2: name the service, the team and the city, in this shape:
"<service> treatment experts at ${contract.BRAND}, ${scaffold.locationName}".
So "Anger management treatment experts at ${contract.BRAND}, ${scaffold.locationName}" and
"Family therapy treatment experts at ${contract.BRAND}, ${scaffold.locationName}" are both right.
No comma between the service and "treatment experts", and do not open with "Our". Where the service
name already ends in "treatment", do not write the word twice. At most
${L.treatment.headingMaxChars} characters. Not a slogan, not a sentence, not a question.`;
}

// The program this page belongs to at this location: the service's program
// groups that the location actually runs (cbhCompose sets meta.programGroups).
// The writer was only ever told the city, so a Psychosis page at a residential
// house and an Anxiety page at an outpatient office read the same way.
function programLine(scaffold) {
  const groups = scaffold?.meta?.programGroups || [];
  if (!groups.length) return '';
  return `PROGRAM AT THIS LOCATION: ${groups.map(g => cbhFeedback.PROGRAM_LABELS[g] || g).join(' and ')}\n`;
}

// `feedbackRules` are the client's active rules (cbhFeedback.loadActiveRules).
// Only those scoped to this service and program, at the writer stage, are sent.
function feedbackBlock(scaffold, feedbackRules) {
  if (!feedbackRules || !feedbackRules.length) return '';
  const ctx = cbhFeedback.pageContext(scaffold);
  return cbhFeedback.promptBlock(feedbackRules, { ...ctx, stage: 'writer' });
}

function userPrompt({ scaffold, h3Plan, faqPlan, primaryKeyword, secondaryKeywords, correction, feedbackRules }) {
  const rules = feedbackBlock(scaffold, feedbackRules);
  return `PAGE: ${scaffold.serviceName} in ${scaffold.locationName}, California
Provider: ${contract.BRAND}
${programLine(scaffold)}Primary keyword: ${primaryKeyword}
Secondary keywords: ${(secondaryKeywords || []).join(', ') || '(none)'}

${sectionBrief({ scaffold, h3Plan, faqPlan, primaryKeyword })}
${rules ? `\n${rules}` : ''}${correction || ''}
Return JSON only, matching this schema:
${SCHEMA_HINT}`;
}

// Turns failing QC checks into instructions. Only length and count failures
// are worth a retry — a model told "your meta description is 138 characters,
// it must be 150-160" fixes it; one told "your UVP is not specific enough"
// mostly rewrites at random.
const CORRECTABLE = new Set([
  'meta_title_length', 'meta_description_length',
  'hero_h1_length', 'hero_description_length',
  'approach_section_length', 'approach_paragraph_limits',
  'insurance_length', 'educational_intro_length',
  'educational_h3_heading_length', 'educational_h3_line_budget',
  // A one-sided section is exactly the kind of thing a second pass fixes: the
  // content is right, the shape is not.
  'educational_body_mix',
  'uvp_length', 'service_length', 'faq_answer_length',
  'treatment_heading_present', 'treatment_length',
  'meta_description_has_cta', 'meta_description_has_keyword_words',
]);

// A failed CLIENT FEEDBACK check is always worth a retry, unlike most content
// gates: it names the exact words to remove or the fact to state, which is the
// kind of instruction a model follows. The review bookkeeping checks (no
// review, review out of date) and findings the reviewer could not quote are
// not instructions, so they stay out.
function isCorrectableFeedback(c) {
  return c.group === 'feedback' && !c.unverified && c.id !== 'fb_review_missing' && c.id !== 'fb_review_stale';
}

function correctionFrom(qc) {
  const notes = qc.checks
    .filter(c => !c.pass && (CORRECTABLE.has(c.id) || isCorrectableFeedback(c)))
    .map(c => `- ${c.name}. ${c.detail}`);
  if (!notes.length) return '';
  return `
CORRECTION: the previous draft broke these. Fix exactly these and change nothing else. Keep every
heading, every section and the order they are in:
${notes.join('\n')}
`;
}

// `h3Plan`  : [{ heading, intent, source, sourceUrl }] from the approved brief.
// `faqPlan` : [{ q, type }] from the approved brief.
// See cbhBrief for why these timings exist.
function phase(label) {
  const started = Date.now();
  return (note) => {
    const ms = Date.now() - started;
    console.log(`[lpb-timing] ${label} ${(ms / 1000).toFixed(1)}s${note ? ' — ' + note : ''}`);
    return ms;
  };
}

// Returns { l3, feedbackReview }. With `feedbackRules`, each draft is checked
// against the client's rules as well as the contract: the text checks inside
// QC, and one AI review call for the rules no regex can judge. Failures of
// either feed the single correction pass, and the review of whichever draft
// wins travels with it so the page is stored with the review it actually got.
async function generateCbhL3({ scaffold, primaryKeyword, secondaryKeywords, h3Plan = [], faqPlan = [], feedbackRules = null }) {
  const llm = createLlmClient(config.llm.cbhWriterModel);
  const base = { scaffold, h3Plan, faqPlan, primaryKeyword, secondaryKeywords, feedbackRules };
  const rules = feedbackRules && feedbackRules.length ? feedbackRules : null;

  // Scores one draft against the real gates (and the client's rules).
  const assess = async (raw) => {
    const p = cbhCompose.mergeCbhL3(structuredClone(scaffold), raw);
    p.primaryKeyword = primaryKeyword;
    let review = null;
    if (rules) {
      // The marker is what tells QC to run the feedback checks at all.
      p.feedback = { rulesVersion: cbhFeedback.rulesVersion(rules) };
      const doneReview = phase('  write: feedback review');
      review = await cbhFeedbackReview.safeReviewPage(p, rules);
      doneReview();
      p.feedbackReview = review;
    }
    return { qc: cbhQc.runCbhQc(p, rules ? { feedbackRules: rules } : {}), review };
  };

  let lastFinishReason = null;

  const draft = async (correction) => {
    const user = userPrompt({ ...base, correction });
    for (let attempt = 0; attempt < 2; attempt++) {
      const completion = await llm.chat.completions.create({
        model: llm.model,
        // Budget generously. The PAGE is small -- roughly 5,700 characters at
        // every maximum, under 1,500 tokens -- so nearly all of this is
        // reasoning headroom, and this prompt is unusually dense: nine
        // sections, ten character caps, fixed headings, and up to five source
        // excerpts the fallback sections must be written from.
        //
        // At 10,000 the model spent the lot reasoning and was cut off
        // mid-JSON, returning finish_reason "length" with 1,438 characters of
        // a half-finished object. A truncated draft costs the whole call and
        // buys nothing, so the cap is set well clear of that.
        ...chatParams(llm.model, { maxTokens: 20000 }),
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: user }],
      });
      lastFinishReason = completion.choices?.[0]?.finish_reason || null;
      const body = completion.choices?.[0]?.message?.content || '';
      // A silent retry doubles the wall-clock of a call that already takes a
      // minute and a half, and there was nothing in the log saying it had
      // happened -- which is why a correction pass could take three times the
      // draft it was correcting with no visible reason.
      let why = '';
      try {
        const raw = JSON.parse(body);
        if (raw && (raw.metaTitle || raw.hero || raw.educational)) {
          if (attempt > 0) console.log(`[lpb-timing]     attempt ${attempt + 1} ok`);
          return raw;
        }
        why = 'parsed but had none of metaTitle/hero/educational';
      } catch (e) { why = 'invalid JSON: ' + e.message.slice(0, 80); }
      console.log(`[lpb-timing]     attempt ${attempt + 1} REJECTED — ${why}`
        + ` (finish_reason ${lastFinishReason}, ${body.length} chars)`);
    }
    return null;
  };

  let done = phase('  write: draft 1');
  const first = await draft(null);
  done();
  if (!first) {
    // Name the actual cause. "Invalid JSON" sent whoever reads it looking for a
    // schema problem, when the response was simply cut off part-way.
    throw new Error(lastFinishReason === 'length'
      ? 'CBH content generation ran out of output budget before finishing its JSON '
        + '(finish_reason "length"). Raise maxTokens in cbhWriter, or shorten the source excerpts.'
      : 'CBH content generation returned invalid JSON after retry.');
  }

  // Score the first draft against the REAL gates, then give the model its own
  // numbers back. One bounded correction pass: a page still failing after that
  // goes to a reviewer, which is the right place for it.
  const one = await assess(first);
  const correction = correctionFrom(one.qc);
  // Worth logging: this is what a whole extra writer call is being spent on.
  if (correction) {
    console.log('[lpb-timing]   correction triggered by: '
      + one.qc.checks.filter(c => !c.pass && (CORRECTABLE.has(c.id) || isCorrectableFeedback(c)))
        .map(c => c.id).join(', '));
  }
  if (!correction) return { l3: first, feedbackReview: one.review };

  done = phase('  write: correction pass');
  const second = await draft(correction);
  done();
  if (!second) return { l3: first, feedbackReview: one.review };

  // Keep whichever draft QC likes better. A correction pass that made things
  // worse must not be allowed to ship over the draft it was correcting.
  const two = await assess(second);
  return failureWeight(two.qc) <= failureWeight(one.qc)
    ? { l3: second, feedbackReview: two.review }
    : { l3: first, feedbackReview: one.review };
}

// Critical failures dominate, then Major, then Minor -- so a correction that
// trades one Critical for three Minors is still an improvement.
function failureWeight(qc) {
  const w = { Critical: 100, Major: 10, Minor: 1 };
  return qc.checks.filter(c => !c.pass).reduce((n, c) => n + (w[c.severity] || 1), 0);
}

module.exports = {
  generateCbhL3, systemPrompt, userPrompt, sectionBrief, correctionFrom, failureWeight, CORRECTABLE, programLine,
};
