// ── Gentle Dental educational-body outline planner ─────────────────────────
// Decides WHICH H2 blocks the educational body gets, before any copy is
// written. Runs on config.llm.dentalOutlineModel (Claude Sonnet 5) — a
// judgement call, kept away from the cheaper writer model.
//
// Why this exists: dentalWizard.researchCompetitors() scrapes up to 25 raw
// H2/H3s off the top-ranking SERP results, and those sets are noisy — nav,
// CTAs, brand boilerplate ("Meet Our Team", "Insurance We Accept") and topics
// belonging to a different procedure all come through. Previously the writer
// only fell back to a curated heading ladder when the scrape returned
// NOTHING, so a bad-but-non-empty scrape silently beat a good fallback.
// Now Sonnet grades the scraped set and decides, block by block, whether to
// take a competitor topic, use a fallback rung, or blend the two — always
// emitting 6-7 blocks.
//
// Everything here is fault-tolerant by design (same posture as
// researchCompetitors): a bad or missing LLM response degrades to a
// deterministic ladder outline rather than failing the wizard.

const config = require('./config');
const store = require('./store');
const text = require('./text');
const { chatParams } = require('./llmParams');
const { createLlmClient } = require('../services/llmProviders');

// Shape of the stack, from config.dental — the same source the writer prompt
// and the QC gates read, so the plan can never be structurally valid while
// the page it produces fails QC. The paragraph totals interlock with the word
// budget; the arithmetic is documented in config.js.
const MIN_BLOCKS = config.dental.blocks.min;
const MAX_BLOCKS = config.dental.blocks.max;
const MIN_PARAGRAPHS = config.dental.paragraphsPerBlock.min;
const MAX_PARAGRAPHS = config.dental.paragraphsPerBlock.max;
const MIN_TOTAL_PARAGRAPHS = config.dental.paragraphsPerPage.min;
const MAX_TOTAL_PARAGRAPHS = config.dental.paragraphsPerPage.max;

// ── Fallback heading ladders ───────────────────────────────────────────────
// Formerly inline prose inside contentGenerator.buildDentalPrompt. As data,
// the same rungs drive the outline prompt AND the code-side top-up/repair.
//
// Rungs take (name, plural) because half the Gentle Dental catalogue is named
// in the plural — Veneers, Root Canals, Implants, Extractions, Braces, Exams,
// Cleanings, Sealants, Crowns & Bridges, Partial & Full Dentures. A flat
// `What Is ${name}?` renders "What Is Root Canals?" and "Is Extractions
// Safe?": broken English in the page's first H2, and in the repair path that
// forces that rung into slot 1 when nothing else names the service.
const GENERAL_LADDER = [
  (s, plural) => `What ${plural ? 'Are' : 'Is'} ${s}?`,
  s => `Benefits of ${s}`,
  s => `What to Expect During ${s}`,
  s => `Who Is a Good Candidate for ${s}?`,
  s => `Types and Options for ${s}`,
  s => `${s} Cost and Effectiveness`,
  (s, plural) => `${plural ? 'Are' : 'Is'} ${s} Safe?`,
];
// Clinical/urgent services are asked about differently — patients arrive with
// a symptom, not a wish list — so the ladder leads with symptoms and process.
const CLINICAL_LADDER = [
  (s, plural) => `What ${plural ? 'Are' : 'Is'} ${s}?`,
  s => `Signs You May Need ${s}`,
  // "The Root Canals Procedure" is clumsy; the question form reads naturally
  // for plurals without needing to singularize the service name.
  (s, plural) => (plural ? `What Happens During ${s}` : `The ${s} Procedure`),
  () => 'What to Expect During Recovery',
  s => `Alternatives to ${s}`,
  s => `${s} Cost and Insurance`,
  (s, plural) => `${plural ? 'Are' : 'Is'} ${s} Safe?`,
];
const CLINICAL_RE = /root canal|extraction|extract|emergency|surgery|surgical|periodont|oral surgeon|wisdom (tooth|teeth)/i;

// Plural if the LAST word of the service name is a plural noun. Checking the
// last word is what makes "Diabetes & Oral Health" singular and "Crowns &
// Bridges" plural; the -ss/-us/-is guard keeps words like "Sinus" singular.
function isPluralName(name) {
  const last = String(name || '').trim().split(/\s+/).pop() || '';
  const word = last.toLowerCase().replace(/[^a-z-]/g, '');
  if (word.length < 4 || /(ss|us|is)$/.test(word)) return false;
  return word.endsWith('s');
}

function pickLadder(service = {}) {
  const hay = `${service.name || ''} ${service.category || ''}`;
  return CLINICAL_RE.test(hay) ? CLINICAL_LADDER : GENERAL_LADDER;
}

function ladderHeadings(service = {}) {
  const name = service.name || 'This Service';
  const plural = isPluralName(name);
  return pickLadder(service).map(fn => fn(name, plural));
}

// ── Scraped-heading pre-filter ─────────────────────────────────────────────
// Deliberately narrow: it targets nav/CTA/NAP/brand furniture only. Genuine
// content topics that happen to mention money or logistics ("How Much Do
// Veneers Cost?", "Does Insurance Cover Implants?", "Recovery Time") must
// survive, because those are exactly the sections worth modelling.
const BOILERPLATE_RE = /^(meet |our team|our (doctors|dentists|staff|office|offices)|about us|contact|book |book your|schedule an|schedule your|request |reviews?\b|testimonials|patient reviews|hours|directions|locations?\b|new patients|careers|blog|related (services|posts|articles)|why choose (us|our\b|gentle dental)|insurance we accept|special offers|follow us|sitemap|privacy|leave a review|get in touch|call )/i;

function filterCompetitorHeadings(headings = []) {
  const seen = new Set();
  return headings
    .map(h => String(h || '').replace(/\s+/g, ' ').trim())
    .filter(h => {
      if (!h || h.length > 90) return false;
      // Two words is the real floor. A 3-word minimum discarded genuine
      // sections competitors rank with — "Recovery Time", "Veneers Cost",
      // "Treatment Options", "Aftercare Tips" — which is the opposite of the
      // point of scraping them. Bare one-word labels ("Veneers", "FAQ") carry
      // no topic and still go.
      if (h.split(' ').length < 2) return false;
      if (BOILERPLATE_RE.test(h)) return false;
      const k = h.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// ── Deterministic normalization / repair ───────────────────────────────────
// The writer prompt treats the outline as fixed, so anything malformed here
// would propagate into the page. Every constraint the writer and QC rely on
// (6-7 blocks, 1-3 paragraphs each, a service-term H2, one localized block)
// is enforced in code rather than trusted to the model.
function clampParagraphs(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 2;
  return Math.min(MAX_PARAGRAPHS, Math.max(MIN_PARAGRAPHS, v));
}

const VALID_SOURCES = new Set(['competitor', 'fallback', 'blend']);

function normalizeOutline(raw, { service, location, primaryKeyword, keywordPhrases } = {}) {
  const rawBlocks = Array.isArray(raw?.blocks) ? raw.blocks : [];
  const seen = new Set();
  let blocks = [];

  for (const b of rawBlocks) {
    const h2 = String(b?.h2 || '').replace(/\s+/g, ' ').trim();
    if (!h2 || h2.length > 90 || BOILERPLATE_RE.test(h2)) continue;
    const key = h2.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({
      h2,
      source: VALID_SOURCES.has(b?.source) ? b.source : 'fallback',
      intent: String(b?.intent || '').replace(/\s+/g, ' ').trim(),
      paragraphs: clampParagraphs(b?.paragraphs),
      localize: !!b?.localize,
    });
  }

  // Too few blocks — top up from the ladder, skipping rungs already covered.
  for (const heading of ladderHeadings(service)) {
    if (blocks.length >= MIN_BLOCKS) break;
    if (seen.has(heading.toLowerCase())) continue;
    seen.add(heading.toLowerCase());
    blocks.push({ h2: heading, source: 'fallback', intent: '', paragraphs: 2, localize: false });
  }
  blocks = blocks.slice(0, MAX_BLOCKS);

  // qaEngine's primary_keyword_in_h2 gate (Major) needs one H2 to carry the
  // keyword's non-geo words. Mirror that gate exactly — same matcher, same
  // phrase list (primary plus approved related keywords), same geo exclusion —
  // and if no heading satisfies it, promote a ladder rung that DOES.
  //
  // The rung has to be verified, not assumed. This used to hardcode the
  // "What Is X?" rung on the reasoning that it names the service verbatim, but
  // that only holds when the keyword's words are a subset of the service name.
  // For "root canal DENTIST malden" or "EMERGENCY root canal malden" no ladder
  // rung contains the extra word, so the old code prepended a block that did
  // not satisfy the gate and displaced a real competitor topic to do it.
  if (primaryKeyword || keywordPhrases?.length) {
    const phrases = [...new Set([primaryKeyword, ...(keywordPhrases || [])].filter(Boolean))];
    const geoExclude = new Set([
      ...text.words(location?.city || ''),
      ...text.words(location?.state_abbreviation || ''),
    ]);
    const satisfied = (h2) => !!text.matchAnyKeyword(h2, phrases, geoExclude);

    if (!blocks.some(b => satisfied(b.h2))) {
      const anchor = ladderHeadings(service).find(satisfied);
      // No rung helps either — leave the outline alone rather than spending a
      // block slot on a heading that changes nothing. QC flags the gate and
      // tells the reviewer to reword an H2, which is the honest outcome.
      if (anchor) {
        blocks = [
          { h2: anchor, source: 'fallback', intent: `Define ${service?.name || 'the service'} in plain language.`, paragraphs: 2, localize: false },
          ...blocks.filter(b => b.h2.toLowerCase() !== anchor.toLowerCase()),
        ].slice(0, MAX_BLOCKS);
      }
    }
  }

  // qaEngine's city_in_educational_body gate needs the city inside at least
  // one block body — make sure the writer is told which block carries it.
  if (!blocks.some(b => b.localize) && blocks.length > 1) blocks[1].localize = true;

  // Keep the paragraph budget inside the band the word-count gate assumes.
  let total = blocks.reduce((n, b) => n + b.paragraphs, 0);
  for (let i = 0; total > MAX_TOTAL_PARAGRAPHS && i < blocks.length; i++) {
    if (blocks[i].paragraphs > 2) { blocks[i].paragraphs -= 1; total -= 1; }
  }
  for (let i = 0; total < MIN_TOTAL_PARAGRAPHS && i < blocks.length; i++) {
    if (blocks[i].paragraphs < 2) { blocks[i].paragraphs += 1; total += 1; }
  }

  const quality = ['good', 'partial', 'poor', 'unavailable'].includes(raw?.competitorQuality)
    ? raw.competitorQuality
    : 'poor';

  return {
    competitorQuality: quality,
    rationale: String(raw?.rationale || '').replace(/\s+/g, ' ').trim(),
    blocks,
  };
}

// The outline a page gets when the planner can't run at all (no API key, or
// both attempts returned unusable JSON). Pure code, no model.
function fallbackOutline({ service, location, primaryKeyword, keywordPhrases }) {
  const blocks = ladderHeadings(service).slice(0, MAX_BLOCKS).map(h2 => ({
    h2, source: 'fallback', intent: '', paragraphs: 2, localize: false,
  }));
  return normalizeOutline(
    {
      competitorQuality: 'unavailable',
      rationale: 'Outline planner unavailable, so this stack came from the curated fallback heading ladder for this service.',
      blocks,
    },
    { service, location, primaryKeyword, keywordPhrases },
  );
}

// ── The planning call ──────────────────────────────────────────────────────
const OUTLINE_SYSTEM_PROMPT = `You are a local-SEO content strategist for a dental practice in
Massachusetts or New Hampshire. You do NOT write page copy — you
decide the H2 outline for one location+service page's educational body, and you judge whether the
scraped competitor headings are actually worth modelling.

You are given real H2/H3 headings scraped from the pages currently ranking for this page's primary
keyword. They are unvetted. Judge each one:
- KEEP the topic if it is a genuine educational topic for THIS service that a patient would search
  for (what it is, symptoms, procedure, candidacy, options, recovery, cost, insurance, safety,
  aftercare, comparisons).
- REJECT it if it is navigation, a CTA, brand or office furniture (team, reviews, hours, address,
  booking), a topic for a DIFFERENT procedure, a location or landing-page label, or too vague to
  write a useful section from.

Then grade the scraped set as a whole:
- "good" — most headings are usable; lean on them for the outline.
- "partial" — a usable minority; blend the good ones with the fallback ladder.
- "poor" — mostly noise, off-service, or empty; ignore them and use the fallback ladder.

Then emit the final outline in reading order. Rules:
- EXACTLY 6 or 7 blocks. Never fewer, never more.
- Order them the way a patient learns: what it is, then why/when, then process, then
  candidacy/options, then practical concerns (cost, insurance, safety, recovery).
- Tag each block's "source": "competitor" (topic taken from the scraped set), "fallback" (a rung of
  the fallback ladder), or "blend" (a ladder rung sharpened by a competitor topic).
- Headings are short, title case, patient-facing, and specific to this service. Model competitor
  SUBJECT MATTER only — never reuse their phrasing, brand names, dentist names, or review copy.
- No two blocks may cover the same ground.
- "paragraphs" is how many short paragraphs (1-3) that block needs. The blocks must sum to between
  ${MIN_TOTAL_PARAGRAPHS} and ${MAX_TOTAL_PARAGRAPHS} paragraphs total — this page has a hard word
  budget, so reserve 3 only for genuinely meatier topics.
- Set "localize": true on exactly one block — the one where naming the city and its surroundings
  will read naturally (usually a practical/access topic, not the definition).
- Do NOT write body copy. "intent" is one sentence telling the writer what the block must cover.

Return ONLY JSON, no prose, no markdown fences.`;

function buildOutlinePrompt({ service, location, primaryKeyword, secondaryKeywords, competitorHeadings, competitorFaqs }) {
  const cityState = `${location.city}, ${location.state_abbreviation}`;
  const ladder = ladderHeadings(service);

  // The exact words qaEngine's keyword-in-an-H2 gate looks for: the primary
  // keyword's significant words minus the city/state (short topic headings
  // do not naturally carry geo, and the body copy is where localization is
  // checked). Spelling them out lets the planner satisfy the gate directly
  // instead of leaving it to a code repair that cannot always help.
  const geoWords = new Set([
    ...text.words(location.city || ''),
    ...text.words(location.state_abbreviation || ''),
  ]);
  const keywordTerms = text.words(primaryKeyword || '')
    .filter(w => !text.STOPWORDS.has(w) && !geoWords.has(w));

  const headingBlock = competitorHeadings.length
    ? `SCRAPED COMPETITOR HEADINGS (unvetted — judge each one):\n${competitorHeadings.map(h => `- ${h}`).join('\n')}`
    : 'SCRAPED COMPETITOR HEADINGS: none survived pre-filtering. Grade this "poor" and build the outline from the fallback ladder.';

  const faqBlock = (competitorFaqs || []).length
    ? `\n\nQUESTIONS COMPETITOR PAGES ANSWER (useful signal for which topics matter):\n${competitorFaqs.slice(0, 15).map(f => `- ${f}`).join('\n')}`
    : '';

  const user = `PAGE: ${service.name} in ${location.location_name}, ${cityState}
Service category: ${service.category}
Primary keyword: ${primaryKeyword}
Secondary keywords: ${(secondaryKeywords || []).join(', ') || '(none)'}

FALLBACK HEADING LADDER for this service (curated, always safe to use — take rungs whole or adapt them):
${ladder.map((h, i) => `${i + 1}. ${h}`).join('\n')}

${headingBlock}${faqBlock}

REQUIRED: at least one H2 must carry the non-geographic words of the primary keyword
"${primaryKeyword}" — that is ${JSON.stringify(keywordTerms)}. Naming the service alone is not always enough:
for a keyword like "root canal dentist malden" a heading such as "What Are Root Canals?" misses
"dentist". ALL of those words have to appear in the SAME heading, so write one that carries them
naturally ("Choosing a Root Canal Dentist"). Do not force the city or state into a heading — those are checked in the body copy.

Return JSON only, matching this schema:
{
  "competitorQuality": "good | partial | poor",
  "rationale": "1-2 sentences: why you leaned on the scraped headings, blended them, or discarded them",
  "blocks": [
    { "h2": "string", "source": "competitor | fallback | blend", "intent": "one sentence on what this block covers", "paragraphs": 2, "localize": false }
  ]
}`;

  return { system: OUTLINE_SYSTEM_PROMPT, user };
}

// Cached on the filtered heading set, not the raw one, so a re-scrape that
// only shuffles boilerplate still hits the cache. Keyed per page tuple
// because the outline is service- and city-specific.
function outlineCacheKey({ service, location, primaryKeyword, headings }) {
  const fingerprint = headings.join('|').toLowerCase();
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i++) hash = (hash * 31 + fingerprint.charCodeAt(i)) | 0;
  return store.cacheKey('dental-outline', service.id, location.id, primaryKeyword, String(hash));
}

async function planDentalOutline({ service, location, primaryKeyword, secondaryKeywords, competitorHeadings, competitorFaqs }) {
  const headings = filterCompetitorHeadings(competitorHeadings);
  // The repair inside normalizeOutline mirrors qaEngine's keyword-in-an-H2
  // gate, which accepts the primary OR any approved related keyword — so it
  // needs the same list, not just the primary.
  const ctx = { service, location, primaryKeyword, keywordPhrases: [primaryKeyword, ...(secondaryKeywords || [])] };

  const cacheK = outlineCacheKey({ service, location, primaryKeyword, headings });
  const cached = await store.cacheGetSafe(cacheK, config.cache.llmTtlMs);
  if (cached) return cached;

  let outline = null;
  try {
    const llm = createLlmClient(config.llm.dentalOutlineModel);
    const { system, user } = buildOutlinePrompt({
      service, location, primaryKeyword, secondaryKeywords,
      competitorHeadings: headings, competitorFaqs,
    });

    for (let attempt = 0; attempt < 2 && !outline; attempt++) {
      const completion = await llm.chat.completions.create({
        model: llm.model,
        ...chatParams(llm.model, { maxTokens: 2500 }),
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      try {
        const raw = JSON.parse(completion.choices[0].message.content);
        if (Array.isArray(raw?.blocks) && raw.blocks.length) outline = normalizeOutline(raw, ctx);
      } catch { /* retry once */ }
    }
  } catch {
    // No API key, transport failure, refusal — fall through to the ladder.
  }

  if (!outline) outline = fallbackOutline(ctx);
  await store.cacheSetSafe(cacheK, outline, { kind: 'llm', ttlMs: config.cache.llmTtlMs });
  return outline;
}

module.exports = {
  planDentalOutline, normalizeOutline, fallbackOutline,
  pickLadder, ladderHeadings, filterCompetitorHeadings, isPluralName,
  GENERAL_LADDER, CLINICAL_LADDER, BOILERPLATE_RE,
  MIN_BLOCKS, MAX_BLOCKS,
};
