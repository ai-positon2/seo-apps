// ── QA / Validation Engine (Spec §9, §15) ──────────────────────────────────
// Runs after generation; gates SEO approval. Each check has severity
// 'block' | 'warn'. blocking_failures > 0 prevents advancing to SEO Approved.

const text = require('./text');
const config = require('./config');
const { slugify } = require('./urlBuilder');

function check(key, severity, passed, detail) {
  return { key, severity, passed: !!passed, detail: detail || '' };
}

// extras: { client, location, modelCopy, similarity }
function runQA(pageObject, extras = {}) {
  const pd = pageObject.page_data;
  const ld = pageObject.location_data;
  const sd = pageObject.service_data;
  const client = extras.client || pageObject._client || {};
  const location = extras.location || {};
  const checks = [];

  const svc = sd.service_name.toLowerCase();
  const loc = ld.location_name.toLowerCase();

  // Location image matches the selected location (heuristic: alt/url mention location)
  const imgHay = `${ld.hero_image_url} ${ld.hero_image_alt}`.toLowerCase();
  const imgOk = !ld.hero_image_url || imgHay.includes(loc) || imgHay.includes((ld.city || '').toLowerCase());
  checks.push(check('location_image_matches', 'block', imgOk,
    imgOk ? 'Hero image references the selected location.' : `Hero image may belong to another city (alt/url: "${ld.hero_image_alt}").`));

  // NAP matches the L2 record
  const napOk = location.street_address ? (ld.street_address === location.street_address && ld.phone_number === location.phone_number) : true;
  checks.push(check('nap_matches_l2', 'block', napOk,
    napOk ? 'Address & phone match the L2 location record.' : 'Address/phone differ from the L2 source of truth.'));

  // URL/canonical use correct slugs
  const wantUrl = `/locations/${slugify(ld.location_slug)}/${slugify(sd.service_slug)}/`;
  const urlOk = pd.page_url === wantUrl && (pd.canonical_url || '').endsWith(wantUrl);
  checks.push(check('url_slugs_correct', 'block', urlOk,
    urlOk ? 'Page URL & canonical use the correct location + service slugs.' : `Expected ${wantUrl}, got ${pd.page_url}.`));

  // meta_title includes service + location
  const mt = (pd.meta_title || '').toLowerCase();
  checks.push(check('meta_title_has_service_location', 'block', mt.includes(svc) && mt.includes(loc),
    `meta_title: "${pd.meta_title}"`));

  // h1 includes service + location
  const h1 = (pd.h1 || '').toLowerCase();
  checks.push(check('h1_has_service_location', 'block', h1.includes(svc) && h1.includes(loc),
    `h1: "${pd.h1}"`));

  // FAQ schema mirrors visible FAQs
  const visibleQ = (pd.faqs || []).map(f => (f.question || '').trim()).filter(Boolean);
  const schemaQ = (pd.schema?.faq_page?.mainEntity || []).map(e => (e.name || '').trim());
  const faqOk = visibleQ.length === schemaQ.length && visibleQ.every((q, i) => q === schemaQ[i]);
  checks.push(check('faq_schema_matches_visible', 'block', faqOk,
    faqOk ? `${visibleQ.length} FAQs mirrored in schema.` : 'FAQ schema does not match visible FAQs exactly.'));

  // Review/AggregateRating schema uses only approved real reviews
  const ratingInSchema = !!pageObject.page_data.schema?.local_business?.aggregateRating;
  const hasApprovedReviews = (ld.reviews || []).length > 0;
  const reviewOk = !ratingInSchema || hasApprovedReviews;
  checks.push(check('reviews_real_only', 'block', reviewOk,
    reviewOk ? 'Review schema only present when approved reviews exist.' : 'aggregateRating present without approved reviews.'));

  // Service actually available at the location
  const available = (location.services_available_ids || []).includes(pageObject.meta.service_id);
  checks.push(check('service_available_at_location', 'block', location.services_available_ids ? available : true,
    available ? 'Service is offered at this location.' : 'Service is NOT listed as available at this location.'));

  // Internal links resolve (have non-empty targets)
  const links = pd.internal_links || [];
  const linksOk = links.every(l => l.url && l.anchor_text);
  checks.push(check('internal_links_resolve', 'warn', linksOk,
    `${links.length} internal links.`));

  // Uniqueness: word count + similarity + local-specifics woven into the body
  const body = text.pageBodyText(pd);
  const wc = text.wordCount(body);
  const wcOk = wc >= config.uniqueness.minBodyWordCount;
  const bodyLc = body.toLowerCase();
  const localOk = !config.uniqueness.requireLocalSpecificsBlock
    || bodyLc.includes(loc) || (ld.nearby_areas || []).some(a => bodyLc.includes(a.toLowerCase()));
  const sim = extras.similarity?.similarity || 0;
  const simOk = sim < config.uniqueness.crossPageSimilarityThreshold;
  const uniqueOk = wcOk && localOk && simOk;
  checks.push(check('uniqueness_thresholds', 'block', uniqueOk,
    `word_count=${wc} (min ${config.uniqueness.minBodyWordCount}), local_specifics=${localOk ? 'present' : 'MISSING'}, max_sibling_similarity=${(sim * 100).toFixed(0)}% (max ${(config.uniqueness.crossPageSimilarityThreshold * 100)}%).`));

  // Required structure: approach has the 2 required H3s; competitor section ≥1 H2 + 3 H3s; 7-11 FAQs
  const pillarHeadings = (pd.approach?.care_pillars || []).map(p => (p.heading || '').toLowerCase());
  const approachOk = pillarHeadings.includes('our philosophy of compassionate care') && pillarHeadings.includes('clinical therapies offered')
    && (pd.approach.care_pillars || []).every(p => (p.copy || '').trim());
  checks.push(check('approach_section_present', 'block', approachOk,
    approachOk ? 'Approach has both required H3s with copy.' : 'Approach must include "Our philosophy of compassionate care" and "Clinical therapies offered" with copy.'));

  const blocks = pd.competitor_section?.blocks || [];
  const h3Count = blocks.reduce((n, b) => n + (b.h3s || []).length, 0);
  const compOk = blocks.length >= 1 && h3Count >= 3 && blocks.every(b => b.h2 && (b.h3s || []).every(h => h.heading && h.copy));
  checks.push(check('competitor_section_structure', 'block', compOk,
    `H2 blocks=${blocks.length}, H3s=${h3Count} (min 1 H2 + 3 H3s; recommended 2 H2 + 5 H3s).`));

  const faqCount = (pd.faqs || []).length;
  checks.push(check('faq_count_7_to_11', 'warn', faqCount >= 7 && faqCount <= 11,
    `${faqCount} FAQs (target 7-11).`));

  // Originality vs competitor copy
  const overlap = extras.competitorOverlap || 0;
  const origOk = overlap < config.uniqueness.competitorOverlapThreshold;
  checks.push(check('originality_vs_competitors', 'block', origOk,
    `max competitor overlap=${(overlap * 100).toFixed(0)}% (max ${(config.uniqueness.competitorOverlapThreshold * 100)}%).`));

  // Prohibited claims absent (brand rules / YMYL)
  const prohibited = (client.brand_rules?.prohibited_claims || []).filter(p => bodyLc.includes(p.toLowerCase()));
  checks.push(check('prohibited_claims_absent', 'block', prohibited.length === 0,
    prohibited.length ? `Found prohibited claims: ${prohibited.join(', ')}` : 'No prohibited claims detected.'));

  const blocking_failures = checks.filter(c => c.severity === 'block' && !c.passed).length;
  const warnings = checks.filter(c => c.severity === 'warn' && !c.passed).length;

  return { checks, blocking_failures, warnings, ran_at: new Date().toISOString() };
}

// ── Dental (Gentle Dental) QC — Build Brief §6 ──────────────────────────────
// Returns { verdict, checks: [{id, name, severity, field, label, pass, detail}] }
// per the brief's QcResult contract. NAP is populated manually (out of scope
// for this build), so it isn't checked here — it would never reflect a real
// generation defect.
//
// Every check carries a `field`: the editor control its failure belongs to
// ('hero.h1', 'meta.metaDescription', …). The wizard renders each failure as a
// notice NEXT TO that control instead of one list at the top of the page, and
// offers a per-check recheck once the reviewer has fixed it — which is why
// checks are a registry of independently-runnable definitions (runDentalCheck)
// rather than a straight-line function.

function dentalStripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const { words, matchAnyKeyword, countAnyKeywordOccurrences } = text;

// Readability + shape caps for the dental educational body, read from
// config.dental — the same source the writer prompt in contentGenerator.js
// uses, so a gate can never ask for something the prompt was not told.
const DENTAL_MAX_PARA_WORDS = config.dental.paragraphWords.hardMax;
const DENTAL_MAX_PARAS_PER_BLOCK = config.dental.paragraphsPerBlock.max;
// A list item is one scannable line, not a paragraph.
const DENTAL_MAX_LIST_ITEM_WORDS = config.dental.listItemMaxWords;
const DENTAL_BLOCKS_MIN = config.dental.blocks.min;
const DENTAL_BLOCKS_MAX = config.dental.blocks.max;
const DENTAL_WORDS_MIN = config.dental.pageWords.acceptMin;
const DENTAL_WORDS_MAX = config.dental.pageWords.acceptMax;
const DENTAL_META_DESC_MIN = config.dental.metaDescription.min;
const DENTAL_META_DESC_MAX = config.dental.metaDescription.max;
const DENTAL_MIN_FAQS = config.dental.faqs.min;
const DENTAL_MIN_INTERNAL_LINKS = 3;
// A MINIMUM presence, not a quota. This used to be 5, which is what produced
// copy like "Invisalign Boston patients trust offers a discreet way ... we'll
// discuss Invisalign cost Boston": no writer reaches five uses of a search
// string in 700 words of natural English, so the model padded. The page's
// subject is already pinned by four separate gates (H1, title, meta
// description, an H2), so prose only has to show the topic is genuinely
// discussed. keyword_reads_naturally is the counterweight in the other
// direction.
const DENTAL_MIN_KEYWORD_USES = config.dental.minKeywordUses;
const DENTAL_MAX_KEYWORD_DENSITY = 0.025;
const DENTAL_SCHEMA_KEYS = ['breadcrumbList', 'dentist', 'medicalWebPage', 'medicalProcedure', 'faqPage'];

// Decomposes one block's HTML into its paragraph-level nodes so the
// readability gate can measure them.
//
// It consumes the nodes it recognizes and measures whatever text is LEFT OVER.
// That leftover matters: an unclosed <p>, a stray <div>, or bare text would
// otherwise be invisible to a "find every <p>...</p>" scan, and a block whose
// whole body is one 90-word unclosed paragraph would pass the gate with zero
// paragraphs found. Loose text is a defect in its own right — the contract is
// <p>/<ul>/<li> only.
function dentalBlockNodes(html) {
  let rest = String(html || '');
  const nodes = [];

  const consume = (re, measure) => {
    rest = rest.replace(re, (match) => {
      nodes.push(measure(match));
      return ' ';
    });
  };

  // Lists first, so their <li> text isn't double-counted as loose text.
  consume(/<(ul|ol)\b[^>]*>[\s\S]*?<\/(?:ul|ol)>/gi, (match) => {
    const items = (match.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || []).map(li => text.wordCount(dentalStripHtml(li)));
    return { kind: 'list', items: items.length, worstWords: items.length ? Math.max(...items) : 0 };
  });
  consume(/<p\b[^>]*>[\s\S]*?<\/p>/gi, (match) => (
    { kind: 'paragraph', worstWords: text.wordCount(dentalStripHtml(match)) }
  ));

  return { nodes, looseWords: text.wordCount(dentalStripHtml(rest)) };
}

// Per-block readability findings, keyed by block index so the wizard can put
// each one under the block it belongs to instead of naming H2s in prose.
function dentalReadability(blocks) {
  const perBlock = {};
  const summary = [];
  blocks.forEach((b, i) => {
    const { nodes, looseWords } = dentalBlockNodes(b.html);
    const issues = [];

    const worstPara = nodes.filter(n => n.kind === 'paragraph').reduce((max, n) => Math.max(max, n.worstWords), 0);
    if (worstPara > DENTAL_MAX_PARA_WORDS) issues.push(`longest paragraph is ${worstPara} words (max ${DENTAL_MAX_PARA_WORDS})`);

    const worstItem = nodes.filter(n => n.kind === 'list').reduce((max, n) => Math.max(max, n.worstWords), 0);
    if (worstItem > DENTAL_MAX_LIST_ITEM_WORDS) issues.push(`longest list item is ${worstItem} words (max ${DENTAL_MAX_LIST_ITEM_WORDS})`);

    // A <ul> counts as one paragraph-level node, however many items it holds.
    if (nodes.length > DENTAL_MAX_PARAS_PER_BLOCK) issues.push(`${nodes.length} paragraphs (max ${DENTAL_MAX_PARAS_PER_BLOCK})`);

    // Text outside any <p>/<ul> — an unclosed tag, a stray <div>, or bare
    // copy. Unmeasurable, and off-contract either way.
    if (looseWords > 0) issues.push(`${looseWords} words sit outside any <p>/<ul>`);
    else if (!nodes.length && dentalStripHtml(b.html)) issues.push('no paragraph markup');

    if (issues.length) {
      perBlock[i] = `${issues.join('; ')}.`;
      summary.push(`"${b.h2}" (${issues.join('; ')})`);
    }
  });
  return { perBlock, summary, pass: !summary.length };
}

// Everything the checks read, computed once. A single-check rerun builds the
// same context, so a check can never behave differently depending on whether
// it ran alone or alongside the others.
function dentalContext(scaffold) {
  const m = scaffold.meta || {};
  const sec = scaffold.sections || {};
  const hero = sec.hero || {};
  const blocks = sec.educationalBody?.blocks || [];
  const faqItems = sec.faq?.items || [];

  const h1Raw = String(hero.h1 || '').trim();
  const h1Match = /^(.*) in (.+),\s*([A-Za-z]{2})$/.exec(h1Raw);
  const city = (h1Match?.[2] || '').toLowerCase();
  const stateAbbr = (h1Match?.[3] || '').toLowerCase();

  // The approved keyword set, most-preferred first. Matching is never a
  // literal string compare: matchAnyKeyword / countAnyKeywordOccurrences stem
  // each word and ignore word order and stopwords, so "whitening in Quincy"
  // counts as a use of "teeth whitening quincy".
  //
  // Two lists, because the checks ask two different questions:
  //   primaryPhrases  the chosen primary + the second approved primary. The
  //                   H1/title/meta identity gates need one of THESE.
  //   keywordPhrases  those plus every approved related (secondary) keyword.
  //                   The usage checks — keyword in an H2, usage frequency,
  //                   density — accept any of these, since a page that works a
  //                   related keyword in is using the topic, not missing it.
  const primary = String(scaffold.primaryKeyword || '').trim();
  const dedupe = (list) => [...new Map(list.filter(Boolean).map(k => [k.toLowerCase(), k])).values()];
  const primaryPhrases = dedupe([primary, ...(scaffold.primaryKeywords || [])]);
  const related = dedupe(scaffold.secondaryKeywords || []);
  const keywordPhrases = dedupe([...primaryPhrases, ...related]);

  // hero.intro is generated content too (the short description below the H1),
  // so it counts toward word count / keyword frequency / localization, same as
  // educationalBody + faq. servicesInCity.intro stays in the join (harmless —
  // usually empty, it's optional/manual). metaDescription is deliberately OUT:
  // it has its own gates, and would otherwise pad the frequency count.
  const bodyText = [
    hero.intro, sec.servicesInCity?.intro,
    ...blocks.map(b => dentalStripHtml(b.html)),
    ...faqItems.flatMap(f => [f.q, f.a]),
  ].join(' ');

  // State abbreviations are noise in body copy ("MA" rarely appears in a
  // sentence), so they never gate a keyword-usage match.
  const stateExclude = new Set([stateAbbr].filter(Boolean));
  const geoExclude = new Set([stateAbbr, ...words(city)].filter(Boolean));

  return {
    scaffold, meta: m, sections: sec, hero, blocks, faqItems,
    h1: h1Raw, city, stateAbbr,
    primary, primaryPhrases, related, keywordPhrases,
    stateExclude, geoExclude,
    bodyText,
    wordCount: text.wordCount(bodyText),
    usage: countAnyKeywordOccurrences(bodyText, keywordPhrases, { exclude: stateExclude }),
    // Density asks the OPPOSITE question to frequency, so it cannot read the
    // same number. `usage` deliberately counts the primary plus every approved
    // related keyword, because "did the page use the topic?" is satisfied by
    // any of them. Over-optimization is about hammering ONE term, and a page
    // that works eleven distinct related keywords in once or twice each is
    // well covered, not stuffed — scoring that union against a 2.5% cap fails
    // exactly the pages the module is trying to produce. Density therefore
    // counts the primary phrases only.
    primaryUsage: countAnyKeywordOccurrences(bodyText, primaryPhrases, { exclude: stateExclude }),
    readability: dentalReadability(blocks),
  };
}

// Both localization checks read the city out of the H1, which the builder
// writes as "{Service} in {City}, {ST}". If the H1 has been edited into some
// other shape there is no city to look for, and reporting `"" is never named`
// sends the reviewer to the body copy to fix something that is wrong with the
// H1. Say that instead.
function dentalCityCheck(ctx, hit, where) {
  if (!ctx.city) {
    return {
      pass: false,
      detail: `Could not read a city from the H1 ("${ctx.h1}") — it must read "{Service} in {City}, {ST}" for the ${where} localization check to run.`,
    };
  }
  return {
    pass: hit,
    detail: hit ? `"${ctx.city}" appears in the ${where}.` : `"${ctx.city}" is never named in the ${where}.`,
  };
}

// The H1 / title / meta identity gates. These need the PRIMARY keyword or a
// close variant of it — matchAnyKeyword already stems and ignores word order
// and stopwords, so "Teeth Whitening in Quincy, MA" satisfies "teeth whitening
// quincy" — or the other approved primary. A RELATED keyword is not a
// substitute here (the point of the field is to carry the primary), but naming
// the related keyword that IS present tells the reviewer how close the field
// already is.
// Every page on a dental site is implicitly "dental", and the brand template
// writes the H1 as "{Service} in {City}, {ST}" — which never carries the
// vertical word. A primary keyword mined from real search demand almost always
// does: "dental implants boston" against an H1 of "Implants in Boston, MA".
// Read literally that is a Critical failure on a page which is, in fact,
// correctly optimized, and the H1 cannot be edited to fix it (it is
// deterministic). So the identity gates retry once with the vertical words
// dropped.
const DENTAL_VERTICAL_WORDS = new Set(['dental', 'dentals', 'dentist', 'dentists', 'dentistry']);

// The retry is only offered to a phrase that still names something specific
// once the vertical AND geo words are removed. Without this, a primary that
// names no service at all ("dentist boston") would clear the gate on the city
// alone — which is exactly the failure mode this check exists to catch.
function keepsAServiceTerm(phrase, ctx) {
  return words(phrase).some(w => !text.STOPWORDS.has(w)
    && !DENTAL_VERTICAL_WORDS.has(w)
    && !ctx.geoExclude.has(w));
}

function dentalPrimaryInField(ctx, haystack, where) {
  if (!ctx.primary) return { pass: false, detail: 'No primary keyword is set for this page.' };
  const matched = matchAnyKeyword(haystack, ctx.primaryPhrases);
  if (matched) {
    return {
      pass: true,
      detail: matched.toLowerCase() === ctx.primary.toLowerCase()
        ? `"${matched}" (or a close variant of it) is present.`
        : `Approved primary keyword "${matched}" is present.`,
    };
  }
  const withoutVertical = matchAnyKeyword(
    haystack,
    ctx.primaryPhrases.filter(p => keepsAServiceTerm(p, ctx)),
    DENTAL_VERTICAL_WORDS,
  );
  if (withoutVertical) {
    return {
      pass: true,
      detail: `"${withoutVertical}" is present apart from the word "dental", which the ${where} carries implicitly on a dental site.`,
    };
  }
  const related = matchAnyKeyword(haystack, ctx.related);
  return {
    pass: false,
    detail: related
      ? `Only the related keyword "${related}" appears in the ${where} — "${ctx.primary}" and its close variants do not.`
      : `Neither "${ctx.primary}" nor a close variant of it appears in the ${where}.`,
  };
}

// ── The check registry ──────────────────────────────────────────────────────
// id       stable identity; what a recheck request names
// name     the reported name (two of them encode their thresholds, historically)
// field    the editor control a failure is shown against
// label    human title for the inline notice
// fix      what the reviewer should do; the notice's second line
const DENTAL_CHECKS = [
  {
    id: 'primary_keyword_in_h1', severity: 'Critical', field: 'hero.h1',
    label: 'Primary keyword in H1',
    fix: 'The H1 is deterministic — if it cannot carry the keyword, change the primary keyword in step 2.',
    run: (ctx) => dentalPrimaryInField(ctx, ctx.h1, 'H1'),
  },
  {
    id: 'primary_keyword_in_title', severity: 'Critical', field: 'meta.title',
    label: 'Primary keyword in title tag',
    fix: 'Edit the title tag so it carries the primary keyword or a close variant.',
    run: (ctx) => dentalPrimaryInField(ctx, ctx.meta.title, 'title tag'),
  },
  {
    id: 'primary_keyword_in_meta_description', severity: 'Critical', field: 'meta.metaDescription',
    label: 'Primary keyword in meta description',
    fix: 'Work the primary keyword — or a close variant of it — into the meta description, or regenerate it.',
    run: (ctx) => dentalPrimaryInField(ctx, ctx.meta.metaDescription, 'meta description'),
  },
  {
    id: 'meta_description_length', severity: 'Critical', field: 'meta.metaDescription',
    label: 'Meta description length',
    fix: `Trim or extend it to ${DENTAL_META_DESC_MIN}-${DENTAL_META_DESC_MAX} characters.`,
    run: (ctx) => {
      const len = (ctx.meta.metaDescription || '').length;
      return {
        pass: len >= DENTAL_META_DESC_MIN && len <= DENTAL_META_DESC_MAX,
        detail: `${len} characters (target ${DENTAL_META_DESC_MIN}-${DENTAL_META_DESC_MAX}).`,
      };
    },
  },
  {
    id: 'faq_count_min_4', severity: 'Critical', field: 'faq',
    label: 'FAQ count',
    fix: `Regenerate the FAQ block — FAQ schema needs at least ${DENTAL_MIN_FAQS} questions.`,
    run: (ctx) => ({
      pass: ctx.faqItems.length >= DENTAL_MIN_FAQS,
      detail: `${ctx.faqItems.length} FAQs (min ${DENTAL_MIN_FAQS}).`,
    }),
  },
  {
    id: 'schema_blocks_valid_json', severity: 'Critical', field: 'schema',
    label: 'JSON-LD blocks parse',
    fix: 'Regenerate the page — schema is built server-side and should never be hand-edited.',
    run: (ctx) => {
      const blocks = ctx.scaffold.schema || {};
      const broken = DENTAL_SCHEMA_KEYS.filter(k => {
        try { JSON.parse(blocks[k] || ''); return false; } catch { return true; }
      });
      return {
        pass: !broken.length,
        detail: broken.length ? `Invalid JSON: ${broken.join(', ')}.` : `All ${DENTAL_SCHEMA_KEYS.length} JSON-LD blocks parse.`,
      };
    },
  },
  {
    id: 'primary_keyword_in_h2', severity: 'Major', field: 'educationalBody',
    label: 'Keyword in an H2',
    fix: 'Reword one H2 to carry the service terms, or regenerate the educational body.',
    run: (ctx) => {
      // H2s are short topic labels — they won't naturally carry the city or
      // state (that is city_in_educational_body's job), so geo terms are
      // excluded here and only the service terms have to land.
      const matched = ctx.blocks.map(b => matchAnyKeyword(b.h2, ctx.keywordPhrases, ctx.geoExclude)).find(Boolean) || null;
      return {
        pass: !!(ctx.primary && matched),
        detail: matched
          ? `An H2 carries the service terms of "${matched}".`
          : `No H2 carries the service terms of "${ctx.primary}" or of a related keyword.`,
      };
    },
  },
  {
    id: 'body_word_count',
    name: `body_word_count_${DENTAL_WORDS_MIN}_${DENTAL_WORDS_MAX}`,
    severity: 'Major', field: 'educationalBody',
    label: 'Body word count',
    fix: `Add or trim copy so hero intro + body + FAQ lands in ${DENTAL_WORDS_MIN}-${DENTAL_WORDS_MAX} words.`,
    run: (ctx) => ({
      pass: ctx.wordCount >= DENTAL_WORDS_MIN && ctx.wordCount <= DENTAL_WORDS_MAX,
      detail: `${ctx.wordCount} words across hero intro, body and FAQ (target ${DENTAL_WORDS_MIN}-${DENTAL_WORDS_MAX}).`,
    }),
  },
  {
    id: `primary_keyword_present_${DENTAL_MIN_KEYWORD_USES}x`, severity: 'Major', field: 'educationalBody',
    label: 'Keyword genuinely discussed',
    fix: 'Write about the topic in one more paragraph or FAQ answer — in your own words. Do NOT paste the keyword in to raise the count.',
    run: (ctx) => {
      const used = Object.entries(ctx.usage.byPhrase).map(([k, n]) => `"${k}" ×${n}`);
      return {
        pass: !!ctx.primary && ctx.usage.total >= DENTAL_MIN_KEYWORD_USES,
        detail: `${ctx.usage.total} natural use${ctx.usage.total === 1 ? '' : 's'} of the keyword or an approved variant across hero, body and FAQ `
          + `(minimum ${DENTAL_MIN_KEYWORD_USES}; meta description excluded)`
          + (used.length ? ` — ${used.join(', ')}.` : '.'),
      };
    },
  },
  {
    // The counterweight to the check above, and the reason that one is a low
    // MINIMUM rather than a target: this fails a page that reached its keyword
    // count by pasting the search string into a sentence.
    id: 'keyword_reads_naturally', severity: 'Major', field: 'educationalBody',
    label: 'Keywords read as English',
    fix: 'Rewrite the flagged phrase as a person would say it — put a preposition in ("the cost of Invisalign in Boston") or drop the city from that sentence.',
    run: (ctx) => {
      // Field by field, never the joined bodyText: one block ending "...in
      // Boston" followed by another starting "Invisalign is..." would look
      // like the very adjacency being detected.
      const fields = [
        ['hero intro', ctx.hero.intro, 'hero.intro'],
        ...ctx.blocks.map((b, i) => [`block ${i + 1} ("${b.h2}")`, dentalStripHtml(b.html), 'educationalBody', i]),
        ...ctx.faqItems.map((f, i) => [`FAQ ${i + 1}`, `${f.q} ${f.a}`, 'faq']),
      ];
      const hits = [];
      const perBlock = {};
      let firstField = null;
      fields.forEach(([where, body, field, blockIndex]) => {
        const forced = text.findForcedKeywordPhrases(body, { keywordPhrases: ctx.keywordPhrases, city: ctx.city });
        if (!forced.length) return;
        hits.push(`${where}: ${forced.map(f => `"${f}"`).join(', ')}`);
        firstField = firstField || field;
        if (blockIndex != null) {
          perBlock[blockIndex] = `Keyword pasted in as a search string: ${forced.map(f => `"${f}"`).join(', ')}.`;
        }
      });
      return {
        pass: !hits.length,
        field: firstField || undefined,
        blocks: perBlock,
        detail: hits.length
          ? `Keyword pasted in as a search string rather than written as English — ${hits.join('; ')}.`
          : 'No keyword is jammed against the city name; every mention reads as a sentence.',
      };
    },
  },
  {
    id: 'city_in_educational_body', severity: 'Major', field: 'educationalBody',
    label: 'City named in the body',
    fix: 'Name the city in at least one body paragraph — a page with no local specifics reads as a template.',
    run: (ctx) => dentalCityCheck(ctx, ctx.blocks.some(b => dentalStripHtml(b.html).toLowerCase().includes(ctx.city)), 'body copy'),
  },
  {
    id: 'city_in_faq', severity: 'Major', field: 'faq',
    label: 'City named in the FAQ',
    fix: 'Name the city in at least one question or answer.',
    run: (ctx) => dentalCityCheck(ctx, ctx.faqItems.some(f => `${f.q} ${f.a}`.toLowerCase().includes(ctx.city)), 'FAQ'),
  },
  {
    id: 'internal_links_min_3', severity: 'Major', field: 'internalLinks',
    label: 'Internal links',
    fix: 'Regenerate the page — sibling links are built from the other locations offering this service.',
    run: (ctx) => {
      const n = (ctx.sections.servicesInCity?.internalLinks || []).length;
      return { pass: n >= DENTAL_MIN_INTERNAL_LINKS, detail: `${n} internal links (min ${DENTAL_MIN_INTERNAL_LINKS}).` };
    },
  },
  {
    id: 'educational_h2_count',
    name: `educational_h2_count_${DENTAL_BLOCKS_MIN}_${DENTAL_BLOCKS_MAX}`,
    severity: 'Major', field: 'educationalBody',
    label: 'H2 block count',
    fix: `Regenerate the educational body — the outline planner always emits ${DENTAL_BLOCKS_MIN}-${DENTAL_BLOCKS_MAX} blocks.`,
    run: (ctx) => ({
      pass: ctx.blocks.length >= DENTAL_BLOCKS_MIN && ctx.blocks.length <= DENTAL_BLOCKS_MAX,
      detail: `${ctx.blocks.length} H2 blocks (target ${DENTAL_BLOCKS_MIN}-${DENTAL_BLOCKS_MAX}).`,
    }),
  },
  {
    id: 'readability_paragraph_length', severity: 'Major', field: 'educationalBody',
    label: 'Readability',
    fix: `Split anything over ${DENTAL_MAX_PARA_WORDS} words, or regenerate the flagged block.`,
    run: (ctx) => ({
      pass: ctx.readability.pass,
      // Per-block, so each finding can be shown under the block it came from.
      blocks: ctx.readability.perBlock,
      detail: ctx.readability.pass
        ? `Every paragraph is within ${DENTAL_MAX_PARA_WORDS} words.`
        : `${ctx.readability.summary.length} block(s) over the readability budget: ${ctx.readability.summary.join('; ')}.`,
    }),
  },
  {
    id: 'ap_style', severity: 'Minor', field: 'educationalBody',
    label: 'AP style',
    fix: 'Drop the extra em dashes / Oxford commas, and use numerals for 10 and above.',
    run: (ctx) => {
      const emDashOveruse = (ctx.bodyText.match(/—/g) || []).length > 2;
      const oxfordComma = /,\s+and\s+\w+[.,]/i.test(ctx.bodyText) && /\w+,\s+\w+,\s+and\s+\w+/.test(ctx.bodyText);
      const spelledTenPlus = /\b(ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|forty|fifty)\b/i.test(ctx.bodyText);
      const found = [
        emDashOveruse && 'em dash overuse',
        oxfordComma && 'Oxford comma',
        spelledTenPlus && 'numbers 10 and above spelled out',
      ].filter(Boolean);
      return { pass: !found.length, detail: found.length ? `${found.join(', ')}.` : 'No AP style issues detected.' };
    },
  },
  {
    id: 'keyword_density', severity: 'Minor', field: 'educationalBody',
    label: 'Keyword density',
    fix: 'Replace a couple of PRIMARY keyword uses with a pronoun or a natural paraphrase.',
    run: (ctx) => {
      const density = ctx.wordCount ? ctx.primaryUsage.total / ctx.wordCount : 0;
      return {
        pass: density <= DENTAL_MAX_KEYWORD_DENSITY,
        detail: `${(density * 100).toFixed(1)}% from ${ctx.primaryUsage.total} primary-keyword uses in ${ctx.wordCount} words (max ${(DENTAL_MAX_KEYWORD_DENSITY * 100).toFixed(1)}%). Related-keyword uses are not counted here.`,
      };
    },
  },
  {
    id: 'no_placeholder_text', severity: 'Minor', field: 'educationalBody',
    label: 'Placeholder text',
    fix: 'Replace the placeholder with real copy.',
    run: (ctx) => {
      const hit = /lorem ipsum|\{\{|\btodo\b|\bTBD\b/i.exec(ctx.bodyText);
      return { pass: !hit, detail: hit ? `Found "${hit[0]}" in the copy.` : 'No placeholder text detected.' };
    },
  },
  {
    id: 'secondary_keyword_used', severity: 'Minor', field: 'educationalBody',
    label: 'Related keyword used',
    // Minor by design: the writer is told to OMIT any related keyword it can't
    // place naturally, so a miss here is a nudge to look, not a defect.
    fix: 'Optional — work one related keyword in if it reads naturally.',
    run: (ctx) => {
      if (!ctx.related.length) return { pass: true, detail: 'No related keywords were approved for this page.' };
      // Same close-variant window as the primary gate: the keyword's words
      // scattered across 700 words of copy are not "the keyword was used".
      const used = ctx.related.filter(k => countAnyKeywordOccurrences(ctx.bodyText, [k]).total >= 1);
      return {
        pass: used.length >= 1,
        detail: `${used.length}/${ctx.related.length} related keywords appear in the body`
          + (used.length ? `: ${used.join(', ')}.` : ' (min 1 where natural).'),
      };
    },
  },
];

const DENTAL_CHECKS_BY_ID = new Map(DENTAL_CHECKS.map(def => [def.id, def]));

function runDentalCheckDef(def, ctx) {
  const result = def.run(ctx);
  return {
    id: def.id,
    name: def.name || def.id,
    severity: def.severity,
    // `def.field` is the control a failure normally belongs to. A check that
    // spans sections (keyword_reads_naturally) can override it at run time
    // with the section that actually failed.
    field: result.field || def.field,
    label: def.label,
    fix: def.fix || '',
    pass: !!result.pass,
    detail: result.detail || '',
    ...(result.blocks && Object.keys(result.blocks).length ? { blocks: result.blocks } : {}),
  };
}

function dentalVerdict(checks) {
  const failed = (severity) => checks.some(c => c.severity === severity && !c.pass);
  return failed('Critical') ? 'FAIL'
    : failed('Major') ? 'REVISIONS REQUIRED'
      : failed('Minor') ? 'CONDITIONAL PASS' : 'PASS';
}

// The thresholds the dental checks enforce, for the wizard to display beside
// the fields. Served over /wizard/content-limits rather than duplicated in the
// client: a target shown in the UI that differs from the one QC gates on is
// worse than showing no target at all.
const DENTAL_LIMITS = {
  metaDescription: { min: DENTAL_META_DESC_MIN, max: DENTAL_META_DESC_MAX },
  paragraphWords: { max: DENTAL_MAX_PARA_WORDS },
  paragraphsPerBlock: { max: DENTAL_MAX_PARAS_PER_BLOCK },
  listItemMaxWords: DENTAL_MAX_LIST_ITEM_WORDS,
  faqAnswerMaxWords: config.dental.faqAnswerMaxWords,
  pageWords: { min: DENTAL_WORDS_MIN, max: DENTAL_WORDS_MAX },
  blocks: { min: DENTAL_BLOCKS_MIN, max: DENTAL_BLOCKS_MAX },
  faqs: { min: DENTAL_MIN_FAQS, max: config.dental.faqs.max },
};

function runDentalQC(scaffold) {
  const ctx = dentalContext(scaffold);
  const checks = DENTAL_CHECKS.map(def => runDentalCheckDef(def, ctx));
  return { verdict: dentalVerdict(checks), checks };
}

// Re-run ONE check against the current (edited) scaffold — what the wizard's
// per-notice "Recheck" button calls once the reviewer has fixed that one
// thing, so confirming a fix costs a single check instead of a full pass.
function runDentalCheck(scaffold, id) {
  const def = DENTAL_CHECKS_BY_ID.get(id);
  if (!def) throw new Error(`Unknown QC check: ${id}`);
  return runDentalCheckDef(def, dentalContext(scaffold));
}

// Splices a freshly-run check back into an earlier result and re-derives the
// verdict. Matches on id, falling back to name so results stored before checks
// carried ids still merge instead of duplicating.
function mergeDentalCheck(previousChecks, check) {
  const merged = (previousChecks || []).map(c => (c.id === check.id || c.name === check.name) ? check : c);
  if (!merged.some(c => c.id === check.id)) merged.push(check);
  return { verdict: dentalVerdict(merged), checks: merged };
}

// One reviewer-facing recheck, whole. Runs `id` against the current scaffold
// and returns a COMPLETE result, because the caller stores what it gets back:
// with no prior checks to merge into there is no honest verdict to derive from
// a single check, so the full pass runs instead of writing a one-check PASS
// over a real result. runDentalQC is pure and offline, so that costs nothing
// but a few milliseconds.
function recheckDental(scaffold, id, previousChecks) {
  if (!DENTAL_CHECKS_BY_ID.has(id)) throw new Error(`Unknown QC check: ${id}`);
  const qc = Array.isArray(previousChecks) && previousChecks.length
    ? mergeDentalCheck(previousChecks, runDentalCheck(scaffold, id))
    : runDentalQC(scaffold);
  return { check: qc.checks.find(c => c.id === id), verdict: qc.verdict, checks: qc.checks };
}

// The shape the QC engine can actually read. Callers hand us a client-supplied
// page, and a verdict computed from a payload that isn't a GeneratedPage would
// be meaningless — worse, it can be persisted. Same guard dentalWizard.
// saveContent applies before storing one.
function isDentalScaffold(page) {
  return !!page && typeof page === 'object' && !!page.meta && !!page.sections;
}

module.exports = {
  runQA, runDentalQC, runDentalCheck, recheckDental, mergeDentalCheck,
  dentalVerdict, isDentalScaffold, DENTAL_CHECKS, DENTAL_LIMITS,
};
