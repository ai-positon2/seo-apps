// ── The content brief (template §7, §8, §10, §11, §15) ──────────────────────
// Decides WHAT the page covers before a word of copy is written: which H2
// sections exist, what each one must cover, which keywords belong to it, and
// how many characters it gets. That is the template's §15 deliverable, and it
// is also the thing the reviewer edits and approves — lsWriter writes from the
// APPROVED brief, never from this planner's raw output.
//
// Runs on the outline model (Claude Sonnet by default), because choosing
// sections is a judgement call: §7 makes competitor coverage the primary source
// for the decision and §17 draws the line explicitly — "competitors determine
// the TOPICS, not the final COPY". The scraped heading sets are noisy (nav,
// CTAs, brand furniture, other services), so the model grades them and decides
// block by block whether to take a competitor topic, use a fallback rung, or
// blend the two.
//
// Everything here is fault-tolerant by design: a missing API key, a refusal or
// two unusable responses degrade to a deterministic ladder brief rather than
// failing the wizard. The reviewer can always edit what they get.

const config = require('./config');
const store = require('./store');
const text = require('./text');
const lsLadder = require('./lsLadder');
const { chatParams } = require('./llmParams');
const { createLlmClient } = require('../services/llmProviders');
// The nav/CTA/NAP/brand-furniture pre-filter, reused rather than re-derived:
// it targets page furniture, not dentistry, and its exclusions ("Recovery
// Time", "Treatment Options" and other genuine topics must survive) took real
// tuning to get right.
const { filterCompetitorHeadings, BOILERPLATE_RE } = require('./dentalOutline');

const VALID_SOURCES = new Set(['competitor', 'fallback', 'blend']);
const VALID_QUALITY = ['good', 'partial', 'poor', 'unavailable'];

// ── Keyword mapping (§11) ──────────────────────────────────────────────────
// Mechanical, so it lives in code rather than in the prompt: §11's rules are
// "map keywords to the most relevant section, do not assign every keyword
// everywhere, do not create sections to hold keywords". A model asked to do
// this reliably assigns the whole list to every section, which is the exact
// keyword-stuffing §7 forbids.
//
// A keyword lands on a section when its significant words (stemmed, stopwords
// and geo dropped) overlap that section's heading or its instructions. A
// keyword that fits nowhere goes to the FAQ pool, where §9's questions can
// carry it — and one that fits nowhere at all is simply left unassigned,
// because §11.1 says not to assign every keyword everywhere.
function significantWords(phrase, geoExclude) {
  return text.words(phrase || '')
    .filter(w => !text.STOPWORDS.has(w) && !geoExclude.has(w))
    .map(text.stem);
}

function mapKeywordsToSections({ sections, primaryPhrases, secondaryPhrases, location, service }) {
  const geoExclude = new Set([
    ...text.words(location?.city || ''),
    ...text.words(location?.location_name || ''),
    ...text.words(location?.state || ''),
    ...text.words(location?.state_abbreviation || ''),
  ]);
  // Words every section shares (the service name itself) carry no signal about
  // WHICH section a keyword belongs to, so they are excluded from the overlap
  // test. Without this, every keyword matches every section.
  const serviceStems = new Set(significantWords(service?.name || '', geoExclude));

  const assigned = new Set();
  const sectionKeywords = sections.map((section) => {
    const haystack = new Set(significantWords(`${section.h2} ${section.instructions || ''}`, geoExclude));
    const picked = [];
    for (const phrase of secondaryPhrases) {
      if (assigned.has(phrase)) continue;
      const stems = significantWords(phrase, geoExclude).filter(w => !serviceStems.has(w));
      // A keyword whose only content is the service name is a page-level term,
      // not a section-level one — it belongs to the title and H1, which
      // already carry the primary.
      if (!stems.length) continue;
      if (stems.some(w => haystack.has(w))) {
        picked.push(phrase);
        assigned.add(phrase);
      }
      // Two per section: §7's "map keywords to the most relevant sections"
      // with §13.8's no-stuffing rule means a couple, not a list.
      if (picked.length >= 2) break;
    }
    return picked;
  });

  return {
    sectionKeywords,
    // Everything that found no home. §9 lets FAQs carry related keywords
    // naturally, and an explicit leftover list is more useful to a reviewer
    // than silently dropping them.
    faqKeywords: secondaryPhrases.filter(p => !assigned.has(p)).slice(0, 6),
    // §11's own mapping table: the fields that MUST carry the primary.
    map: {
      seoTitle: primaryPhrases.slice(0, 1),
      metaDescription: primaryPhrases.slice(0, 2),
      h1: primaryPhrases.slice(0, 1),
      hero: primaryPhrases.slice(0, 1),
    },
  };
}

// ── Normalization / repair ─────────────────────────────────────────────────
// The writer prompt treats the brief as fixed, so anything malformed here
// propagates into the page. Every constraint the writer and QC rely on — the
// block band, paragraphs per block, a section carrying the keyword, one
// localized section, 5-7 FAQs — is enforced in code rather than trusted to
// the model.
function clampParagraphs(n, budgets) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 2;
  return Math.min(budgets.paragraphsPerBlock.max, Math.max(budgets.paragraphsPerBlock.min, v));
}

function cleanHeading(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function normalizeBrief(raw, ctx) {
  const { service, location, budgets, primaryPhrases, keywordPhrases } = ctx;
  const seen = new Set();
  let sections = [];

  for (const s of (Array.isArray(raw?.sections) ? raw.sections : [])) {
    const h2 = cleanHeading(s?.h2);
    if (!h2 || h2.length > 90 || BOILERPLATE_RE.test(h2)) continue;
    const key = h2.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push({
      h2,
      source: VALID_SOURCES.has(s?.source) ? s.source : 'fallback',
      // §15's "Writing Instructions" — what the section must cover. This is
      // the half of the brief a writer actually works from, so an empty one
      // is filled from the section's own heading rather than left blank.
      instructions: cleanHeading(s?.instructions || s?.intent) || `Cover ${h2.replace(/\?$/, '')} for ${service.name}.`,
      paragraphs: clampParagraphs(s?.paragraphs, budgets),
      localize: !!s?.localize,
      charLimit: { min: budgets.sectionChars.min, max: budgets.sectionChars.max },
      keywords: [],
    });
  }

  // Too few sections — top up from the fallback ladder, skipping rungs the
  // model already covered (§7's Competitor Fallback Rule).
  for (const heading of lsLadder.ladderHeadings(service)) {
    if (sections.length >= budgets.blocks.min) break;
    if (seen.has(heading.toLowerCase())) continue;
    seen.add(heading.toLowerCase());
    sections.push({
      h2: heading, source: 'fallback',
      instructions: `Cover ${heading.replace(/\?$/, '')} for ${service.name}, in plain language.`,
      paragraphs: 2, localize: false,
      charLimit: { min: budgets.sectionChars.min, max: budgets.sectionChars.max },
      keywords: [],
    });
  }
  sections = sections.slice(0, budgets.blocks.max);

  // §13.3 requires the primary keyword (or a close variant) in the title,
  // meta, H1 and hero one-liner, and lsQa gates a section heading carrying its
  // service terms too — a page whose every H2 avoids the topic reads as
  // generic. Mirror that gate exactly: same matcher, same phrase list, same
  // geo exclusion, and if nothing satisfies it, promote a ladder rung that
  // does. The rung is VERIFIED rather than assumed: for a keyword like
  // "anxiety therapist torrance" no rung carries "therapist", and prepending
  // one that does not satisfy the gate would cost a section slot for nothing.
  if (keywordPhrases.length) {
    const geoExclude = new Set([
      ...text.words(location?.city || ''),
      ...text.words(location?.state_abbreviation || ''),
    ]);
    const satisfied = (h2) => !!text.matchAnyKeyword(h2, keywordPhrases, geoExclude);
    if (!sections.some(s => satisfied(s.h2))) {
      const anchor = lsLadder.ladderHeadings(service).find(satisfied);
      if (anchor) {
        sections = [
          {
            h2: anchor, source: 'fallback',
            instructions: `Define ${service.name} in plain language for someone unfamiliar with it.`,
            paragraphs: 2, localize: false,
            charLimit: { min: budgets.sectionChars.min, max: budgets.sectionChars.max },
            keywords: [],
          },
          ...sections.filter(s => s.h2.toLowerCase() !== anchor.toLowerCase()),
        ].slice(0, budgets.blocks.max);
      }
    }
  }

  // Exactly one section carries the city. §13.15/§13.16 want location
  // terminology where it adds relevance and NOT in every paragraph, and lsQa
  // gates that the city appears in the body at least once — so the brief has
  // to say which section is responsible for it.
  const localized = sections.filter(s => s.localize);
  if (!localized.length && sections.length > 1) {
    // Not the first section: §7's Possible Section 1 is the definition, which
    // is the same in every city and is where a forced city name reads worst.
    sections[1].localize = true;
  } else if (localized.length > 1) {
    let kept = false;
    sections.forEach((s) => {
      if (!s.localize) return;
      if (kept) s.localize = false;
      kept = true;
    });
  }

  // ── FAQs (§9) ────────────────────────────────────────────────────────────
  // 5-7 planned QUESTIONS; the answers are written later, from this plan.
  const faqSeen = new Set();
  let faqs = [];
  for (const f of (Array.isArray(raw?.faqs) ? raw.faqs : [])) {
    const question = cleanHeading(f?.question || f?.q);
    if (!question) continue;
    const key = question.toLowerCase();
    if (faqSeen.has(key)) continue;
    faqSeen.add(key);
    faqs.push({
      question,
      intent: cleanHeading(f?.intent) || '',
      localize: !!f?.localize,
      keywords: [],
    });
  }
  for (const question of fallbackFaqQuestions(ctx)) {
    if (faqs.length >= budgets.faqs.min) break;
    if (faqSeen.has(question.toLowerCase())) continue;
    faqSeen.add(question.toLowerCase());
    faqs.push({ question, intent: '', localize: /\b(available|offer|book|insurance)\b/i.test(question), keywords: [] });
  }
  faqs = faqs.slice(0, budgets.faqs.max);

  // §9's localization floor, with §9's own warning attached: the city belongs
  // only in questions whose answer it actually changes, so the flag is set on
  // availability-shaped questions and never on a universal clinical one.
  const localizable = faqs.filter(f => isLocalizableQuestion(f.question));
  if (localizable.filter(f => f.localize).length < budgets.faqs.minLocalized) {
    localizable.slice(0, budgets.faqs.minLocalized).forEach(f => { f.localize = true; });
  }
  faqs.forEach(f => { if (f.localize && !isLocalizableQuestion(f.question)) f.localize = false; });

  // §11 keyword mapping, applied after the section list is final.
  const mapping = mapKeywordsToSections({
    sections,
    primaryPhrases,
    secondaryPhrases: ctx.secondaryPhrases,
    location, service,
  });
  sections.forEach((s, i) => { s.keywords = mapping.sectionKeywords[i] || []; });
  faqs.forEach((f, i) => { f.keywords = mapping.faqKeywords.slice(i, i + 1); });

  return {
    competitorQuality: VALID_QUALITY.includes(raw?.competitorQuality) ? raw.competitorQuality : 'poor',
    rationale: cleanHeading(raw?.rationale),
    // §10's research output, as JUDGEMENTS the model made about the scraped
    // sets. The per-competitor facts are attached by the caller from the
    // scrape itself, so an edited brief cannot rewrite what was found.
    research: {
      commonTopics: cleanList(raw?.commonTopics),
      uniqueTopics: cleanList(raw?.uniqueTopics),
      faqTopics: cleanList(raw?.faqTopics),
      contentGaps: cleanList(raw?.contentGaps),
      competitors: [],
    },
    keywordMap: { ...mapping.map, faq: mapping.faqKeywords },
    sections,
    faqs,
    approved: false,
    approvedAt: null,
  };
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanHeading).filter(Boolean))].slice(0, 15);
}

// §9's own distinction, in code. A question is localizable when the answer
// genuinely differs by location — what this office offers, which options it
// runs, booking or insurance here. It is NOT localizable when it asks about
// the condition or the treatment itself (pain, duration, safety, candidacy),
// where the answer is identical everywhere and naming a city reads as filler.
const LOCALIZABLE_RE = /\b(available|availability|offer|offers|offered|provide|provides|book|booking|schedule|appointment|insurance|accept|accepted|cover|coverage|cost|near|visit|location|office|clinic|in-person|virtual|telehealth|wait|waitlist|hours|get started)\b/i;
const UNIVERSAL_RE = /\b(hurt|painful|pain|safe|safety|risk|risks|side effect|how long does .* (take|last)|work|effective|candidate|qualify|symptom|symptoms|cause|causes|difference between)\b/i;

function isLocalizableQuestion(question) {
  const q = String(question || '');
  if (UNIVERSAL_RE.test(q)) return false;
  return LOCALIZABLE_RE.test(q);
}

// §9's own "Good examples" list, parameterized. Questions, not answers, so
// nothing here asserts a fact — but they are still shaped so the writer can
// answer them from verified data or flag them (§9's FAQ Answer Rules).
function fallbackFaqQuestions({ service, location, brandName }) {
  const name = String(service.name || '').toLowerCase();
  const city = location.city || location.location_name || '';
  const condition = String(lsLadder.conditionNameOf(service) || name).toLowerCase();
  return [
    `What types of ${name} are available in ${city}?`,
    `How do I know if I need professional ${name}?`,
    `How long does ${name} usually take?`,
    `Does ${brandName || 'this practice'} accept insurance for ${name}?`,
    `What should I expect during my first ${name} appointment?`,
    `Can ${name} be provided virtually?`,
    `What support is available after ${condition} treatment ends?`,
  ];
}

// The brief a page gets when the planner cannot run at all (no API key, or two
// unusable responses). Pure code, no model — the ladder for this service shape
// plus §9's example questions.
function fallbackBrief(ctx) {
  const sections = lsLadder.ladderHeadings(ctx.service)
    .slice(0, ctx.budgets.blocks.max)
    .map(h2 => ({ h2, source: 'fallback', instructions: '', paragraphs: 2, localize: false }));
  return normalizeBrief(
    {
      competitorQuality: 'unavailable',
      rationale: 'The brief planner was unavailable, so these sections come from the curated fallback ladder for this service shape. Competitor research did not inform them.',
      sections,
      faqs: [],
    },
    ctx,
  );
}

// ── The planning call ──────────────────────────────────────────────────────
// The system prompt carries the template's rules, not a vertical's: §7's
// keep/reject test for scraped headings, §7's grading, §17's topics-not-copy
// line, and §13's prohibitions on inventing data.
function buildSystemPrompt({ profile, budgets }) {
  const ymyl = profile.ymyl
    ? `\nThis is a YMYL (your-money-your-life) brand. A section that cannot be written without inventing a\nclinical claim, an outcome, a price or an availability must not be planned at all — plan the section\nthe brand can actually support, and note what the client would need to confirm.`
    : '';
  return `You are a local-SEO content strategist planning ONE location + service page. You do NOT write page
copy. You decide the page's H2 sections, what each must cover, and which questions the FAQ answers.

You are given real H2/H3 headings scraped from the pages currently ranking for this page's primary
keyword. They are unvetted. Judge each one:
- KEEP the topic if it is a genuine informational topic for THIS service that a searcher would look
  for (what it is, symptoms, causes, types, options, benefits, process, what to expect, candidacy,
  recovery, when to seek help, cost, insurance).
- REJECT it if it is navigation, a CTA, brand or office furniture (team, reviews, hours, address,
  booking), a topic for a DIFFERENT service, a location or landing-page label, or too vague to write
  a useful section from.

Then grade the scraped set as a whole:
- "good" — most headings are usable; lean on them.
- "partial" — a usable minority; blend the good ones with the fallback ladder.
- "poor" — mostly noise, off-service or empty; ignore them and use the fallback ladder.

Then emit the final section list in reading order. Rules:
- Between ${budgets.blocks.min} and ${budgets.blocks.max} sections. Never fewer, never more.
- Order them the way a person learns: what it is, then why or when, then options and process, then
  practical concerns (candidacy, cost, insurance, what happens next).
- Tag each section's "source": "competitor" (topic taken from the scraped set), "fallback" (a rung of
  the fallback ladder you were given), or "blend" (a ladder rung sharpened by a competitor topic).
- Headings are short, title case, reader-facing and specific to this service. Model competitor
  SUBJECT MATTER only — never reuse their phrasing, brand names, clinician names or review copy.
- No two sections may cover the same ground, and none may duplicate the FAQ.
- "instructions" is the writing brief for that section: one or two sentences telling the writer what
  it must cover and in what order. It is the deliverable a human writer works from, so be concrete
  ("explain what the assessment covers and who runs it"), never generic ("write about the service").
- "paragraphs" is how many short paragraphs (${budgets.paragraphsPerBlock.min}-${budgets.paragraphsPerBlock.max}) the section needs. Each section has a hard budget of
  ${budgets.sectionChars.min}-${budgets.sectionChars.max} characters, so reserve ${budgets.paragraphsPerBlock.max} only for genuinely meatier topics.
- Set "localize": true on EXACTLY ONE section — the one where naming the city and its surrounding
  areas will read naturally (usually a practical or access topic, never the definition).

FAQ (${budgets.faqs.min}-${budgets.faqs.max} questions):
- Base the questions on what competitor pages actually answer, and on the real blockers a searcher
  has left: options, process, what to expect, duration, eligibility, insurance, cost, virtual
  availability, preparation, when to seek help.
- Ask each question in the searcher's own words. Do not copy competitor wording.
- Do NOT ask marketing questions ("Why choose us?"), and do not repeat a section's ground.
- "localize": true ONLY where the answer genuinely depends on the location — what this office
  offers, which options it runs, booking or insurance here. NEVER on a question about pain,
  duration, safety, symptoms or candidacy: the answer is identical in every city, so naming one
  reads as filler. Most questions should have localize false.

Competitors determine the TOPICS, not the copy. Do not invent a location fact, a price, an
insurance acceptance, a clinical claim or an availability anywhere in this brief.${ymyl}

Return ONLY JSON, no prose, no markdown fences.`;
}

function buildUserPrompt(ctx) {
  const { service, location, profile, primaryKeyword, secondaryPhrases, competitors, budgets } = ctx;
  const cityState = [location.city, location.state_abbreviation].filter(Boolean).join(', ');
  const ladder = lsLadder.ladderHeadings(service);

  // The exact words lsQa's keyword-in-a-heading gate looks for: the primary
  // keyword's significant words minus the city/state. Spelling them out lets
  // the planner satisfy the gate directly instead of leaving it to a code
  // repair that cannot always help.
  const geoWords = new Set([...text.words(location.city || ''), ...text.words(location.state_abbreviation || '')]);
  const keywordTerms = text.words(primaryKeyword || '').filter(w => !text.STOPWORDS.has(w) && !geoWords.has(w));

  const competitorBlock = competitors.length
    ? competitors.map((c, i) => {
      const headings = (c.headings || []).length ? (c.headings || []).map(h => `   - ${h}`).join('\n') : '   (no usable headings)';
      const faqs = (c.faqs || []).length ? `\n   Questions answered:\n${c.faqs.map(f => `   - ${f}`).join('\n')}` : '';
      return `COMPETITOR ${i + 1}: ${c.url}\n   Headings found:\n${headings}${faqs}`;
    }).join('\n\n')
    : 'COMPETITOR RESEARCH: no competitor pages could be read. Grade this "unavailable" and build the section list from the fallback ladder.';

  return `PAGE: ${service.name} in ${location.location_name || location.city}${cityState ? `, ${cityState}` : ''}
Brand: ${ctx.brandName}
Service category: ${service.category || '(none)'}
Condition or subject this service addresses: ${lsLadder.conditionNameOf(service)}
Primary keyword: ${primaryKeyword}
Secondary keywords: ${secondaryPhrases.join(', ') || '(none)'}
${(service.conditions_treated || []).length ? `Conditions treated (client reference data): ${service.conditions_treated.join(', ')}` : ''}

FALLBACK HEADING LADDER for this service shape (curated, always safe — take rungs whole or adapt them):
${ladder.map((h, i) => `${i + 1}. ${h}`).join('\n')}

ADDITIONAL TOPICS you MAY use when competitors cover them (do not add them all):
${lsLadder.SERVICE_SPECIFIC_TOPICS.join(', ')}

${competitorBlock}

REQUIRED: at least one section heading must carry the non-geographic words of the primary keyword
"${primaryKeyword}" — that is ${JSON.stringify(keywordTerms)}. ALL of those words have to appear in the
SAME heading, worked in naturally. Do not force the city or state into a heading; the city is
carried by the one section you mark "localize" and by the FAQ.

Return JSON only, matching this schema:
{
  "competitorQuality": "good | partial | poor | unavailable",
  "rationale": "1-2 sentences: why you leaned on the scraped headings, blended them, or discarded them",
  "commonTopics": ["topics covered across several competitors"],
  "uniqueTopics": ["relevant topics only one competitor covers"],
  "faqTopics": ["question topics competitor pages answer"],
  "contentGaps": ["topics searchers need that the competitors handle poorly or not at all"],
  "sections": [
    { "h2": "string", "source": "competitor | fallback | blend", "instructions": "what this section must cover", "paragraphs": 2, "localize": false }
  ],
  "faqs": [
    { "question": "string", "intent": "what the answer must establish", "localize": false }
  ]
}`;
}

// Cached on the FILTERED heading set, not the raw one, so a re-scrape that
// only shuffles boilerplate still hits the cache. Keyed per page tuple because
// a brief is service- and city-specific.
function briefCacheKey({ service, location, primaryKeyword, competitors }) {
  const fingerprint = competitors
    .map(c => `${c.url}:${(c.headings || []).join('|')}`)
    .join('||')
    .toLowerCase();
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i++) hash = (hash * 31 + fingerprint.charCodeAt(i)) | 0;
  return store.cacheKey('ls-brief-v1', service.id, location.id, primaryKeyword, String(hash));
}

// `competitors`: [{ url, headings: [], faqs: [] }] — per-URL, because §10's
// research output has to say which competitor covers what. The merged sets
// the dental wizard passes around cannot answer that.
async function planBrief({
  service, location, profile, brandName, primaryKeyword, primaryKeywords,
  secondaryKeywords, competitors,
}) {
  const budgets = profile.budgets;
  const dedupe = list => [...new Map((list || []).filter(Boolean).map(k => [String(k).toLowerCase(), String(k)])).values()];
  const primaryPhrases = dedupe([primaryKeyword, ...(primaryKeywords || [])]);
  const secondaryPhrases = dedupe(secondaryKeywords);

  const filtered = (competitors || []).map(c => ({
    url: c.url,
    headings: filterCompetitorHeadings(c.headings || []).slice(0, 15),
    faqs: [...new Set((c.faqs || []).map(f => cleanHeading(f)).filter(Boolean))].slice(0, 8),
  }));

  const ctx = {
    service, location, profile, budgets,
    brandName: brandName || profile.brandName,
    primaryKeyword, primaryPhrases, secondaryPhrases,
    keywordPhrases: dedupe([...primaryPhrases, ...secondaryPhrases]),
    competitors: filtered,
  };

  const cacheK = briefCacheKey({ service, location, primaryKeyword, competitors: filtered });
  const cached = await store.cacheGetSafe(cacheK, config.cache.llmTtlMs);
  if (cached) return withCompetitorFacts(cached, filtered);

  let brief = null;
  try {
    const llm = createLlmClient(config.llm.lsBriefModel);
    const system = buildSystemPrompt(ctx);
    const user = buildUserPrompt(ctx);
    for (let attempt = 0; attempt < 2 && !brief; attempt++) {
      const completion = await llm.chat.completions.create({
        model: llm.model,
        ...chatParams(llm.model, { maxTokens: 4000 }),
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      try {
        const raw = JSON.parse(completion.choices[0].message.content);
        if (Array.isArray(raw?.sections) && raw.sections.length) brief = normalizeBrief(raw, ctx);
      } catch { /* retry once */ }
    }
  } catch {
    // No API key, transport failure, refusal — fall through to the ladder.
  }

  if (!brief) brief = fallbackBrief(ctx);
  await store.cacheSetSafe(cacheK, brief, { kind: 'llm', ttlMs: config.cache.llmTtlMs });
  return withCompetitorFacts(brief, filtered);
}

// The per-competitor record is a FACT from the scrape, not a model judgement,
// so it is attached after planning (and after any cache hit) rather than being
// asked for in the response. §10 wants both halves; only one of them is the
// model's to produce.
function withCompetitorFacts(brief, competitors) {
  return {
    ...brief,
    research: {
      ...brief.research,
      competitors: competitors.map(c => ({ url: c.url, sections: c.headings, faqTopics: c.faqs })),
    },
  };
}

module.exports = {
  planBrief, normalizeBrief, fallbackBrief, mapKeywordsToSections,
  isLocalizableQuestion, fallbackFaqQuestions, buildSystemPrompt, buildUserPrompt,
};
