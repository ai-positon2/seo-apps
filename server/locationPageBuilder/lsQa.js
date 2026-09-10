// ── QC gates for template-driven pages (docs/ybh-ls-pages.md) ───────────────
// Every threshold here is one the template states, read from the page's own
// profile budgets so a brand can be retuned in config without a code change
// (config.lsPages.clients). Nothing is hardcoded in this file.
//
// Pure and synchronous by design — no LLM, no network, no store. Every write
// path re-runs it over what is actually being stored, so an edit can never
// leave a stale PASS on a page that no longer passes.
//
// The registry mirrors qaEngine's dental one (id / severity / field / label /
// fix / run) so the wizard's inline "failure shown next to the field it came
// from, with a Recheck button" UI works identically for both engines.

const text = require('./text');
const lsProfiles = require('./lsProfiles');

const { words, matchAnyKeyword, countAnyKeywordOccurrences } = text;

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const SCHEMA_KEYS = ['breadcrumbList', 'business', 'medicalWebPage', 'service', 'faqPage'];

// ── Readability ────────────────────────────────────────────────────────────
// Decomposes one section's HTML into paragraph-level nodes, and measures
// whatever text is LEFT OVER. That leftover matters: an unclosed <p>, a stray
// <div> or bare text would otherwise be invisible to a "find every <p>" scan,
// so a section whose whole body is one 90-word unclosed paragraph would pass
// with zero paragraphs found. Loose text is a defect in its own right — the
// contract is <p>/<ul>/<li> only.
function blockNodes(html) {
  let rest = String(html || '');
  const nodes = [];
  const consume = (re, measure) => {
    rest = rest.replace(re, (match) => { nodes.push(measure(match)); return ' '; });
  };
  // Lists first, so their <li> text is not double-counted as loose text.
  consume(/<(ul|ol)\b[^>]*>[\s\S]*?<\/(?:ul|ol)>/gi, (match) => {
    const items = (match.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || []).map(li => text.wordCount(stripHtml(li)));
    return { kind: 'list', items: items.length, worstWords: items.length ? Math.max(...items) : 0 };
  });
  consume(/<p\b[^>]*>[\s\S]*?<\/p>/gi, (match) => ({ kind: 'paragraph', worstWords: text.wordCount(stripHtml(match)) }));
  return { nodes, looseWords: text.wordCount(stripHtml(rest)) };
}

// Per-section findings, keyed by index so the wizard can put each one under
// the section it belongs to instead of naming headings in prose.
function readability(blocks, budgets) {
  const perBlock = {};
  const summary = [];
  blocks.forEach((b, i) => {
    const { nodes, looseWords } = blockNodes(b.html);
    const issues = [];

    const worstPara = nodes.filter(n => n.kind === 'paragraph').reduce((max, n) => Math.max(max, n.worstWords), 0);
    if (worstPara > budgets.paragraphWords.hardMax) {
      issues.push(`longest paragraph is ${worstPara} words (max ${budgets.paragraphWords.hardMax})`);
    }
    const worstItem = nodes.filter(n => n.kind === 'list').reduce((max, n) => Math.max(max, n.worstWords), 0);
    if (worstItem > budgets.listItemMaxWords) {
      issues.push(`longest list item is ${worstItem} words (max ${budgets.listItemMaxWords})`);
    }
    // A <ul> counts as one paragraph-level node, however many items it holds.
    if (nodes.length > budgets.paragraphsPerBlock.max) {
      issues.push(`${nodes.length} paragraphs (max ${budgets.paragraphsPerBlock.max})`);
    }
    if (looseWords > 0) issues.push(`${looseWords} words sit outside any <p>/<ul>`);
    else if (!nodes.length && stripHtml(b.html)) issues.push('no paragraph markup');

    if (issues.length) {
      perBlock[i] = `${issues.join('; ')}.`;
      summary.push(`"${b.h2}" (${issues.join('; ')})`);
    }
  });
  return { perBlock, summary, pass: !summary.length };
}

// ── Context ────────────────────────────────────────────────────────────────
// Everything the checks read, computed once. A single-check rerun builds the
// same context, so a check can never behave differently depending on whether
// it ran alone or alongside the others.
function lsContext(scaffold, budgetsArg) {
  const meta = scaffold.meta || {};
  const sec = scaffold.sections || {};
  const hero = sec.hero || {};
  const locationInfo = sec.locationInfo || {};
  const blocks = sec.body?.blocks || [];
  const faq = sec.faq || {};
  const faqItems = faq.items || [];
  const brief = scaffold.brief || null;
  const budgets = budgetsArg || lsProfiles.budgetsFor(meta.client_id);

  // The city is READ FROM THE LOCATION RECORD, not parsed out of the H1. The
  // dental engine has to parse it because its H1 is a fixed pattern; here the
  // H1 is written by the model (template §5 requires the primary keyword to
  // drive it), so parsing would fail on exactly the pages that are correct.
  const city = String(locationInfo.city || '').toLowerCase();
  const stateAbbr = String(locationInfo.stateAbbreviation || '').toLowerCase();

  // Matching is never a literal string compare: matchAnyKeyword /
  // countAnyKeywordOccurrences stem each word and ignore word order and
  // stopwords, so "anxiety treatment in Torrance" counts as a use of
  // "anxiety treatment torrance" (template §3/§4 explicitly allow close
  // variants and forbid forcing exact match).
  //
  // Two lists, because the checks ask two different questions:
  //   primaryPhrases  the chosen primary plus any second approved primary. The
  //                   title/meta/H1/hero identity gates (§13.3) need one of
  //                   THESE.
  //   keywordPhrases  those plus every approved secondary. The usage checks
  //                   accept any of them, since a page working a related
  //                   keyword in is using the topic, not missing it.
  const primary = String(scaffold.primaryKeyword || '').trim();
  const dedupe = list => [...new Map(list.filter(Boolean).map(k => [k.toLowerCase(), k])).values()];
  const primaryPhrases = dedupe([primary, ...(scaffold.primaryKeywords || [])]);
  const related = dedupe(scaffold.secondaryKeywords || []);
  const keywordPhrases = dedupe([...primaryPhrases, ...related]);

  // The span the word/frequency/localization checks measure: hero one-liner +
  // section bodies + FAQ intro + FAQ Q&As. The meta description is
  // deliberately OUT — it has its own gates and would otherwise pad the count.
  const bodyText = [
    hero.oneLiner,
    ...blocks.map(b => stripHtml(b.html)),
    faq.intro,
    ...faqItems.flatMap(f => [f.q, f.a]),
  ].join(' ');

  // State abbreviations are noise in body copy ("CA" rarely appears in a
  // sentence), so they never gate a keyword-usage match.
  const stateExclude = new Set([stateAbbr].filter(Boolean));
  const geoExclude = new Set([stateAbbr, ...words(city)].filter(Boolean));

  return {
    scaffold, meta, sections: sec, hero, locationInfo, blocks, faq, faqItems, brief, budgets,
    city, stateAbbr,
    brandName: meta.brandName || '',
    primary, primaryPhrases, related, keywordPhrases,
    stateExclude, geoExclude,
    bodyText,
    wordCount: text.wordCount(bodyText),
    usage: countAnyKeywordOccurrences(bodyText, keywordPhrases, { exclude: stateExclude }),
    // Density asks the OPPOSITE question to frequency, so it cannot read the
    // same number. Over-optimization is about hammering ONE term; a page that
    // works ten distinct related keywords in once each is well covered, not
    // stuffed. Density therefore counts the primary phrases only.
    primaryUsage: countAnyKeywordOccurrences(bodyText, primaryPhrases, { exclude: stateExclude }),
    readability: readability(blocks, budgets),
  };
}

// The title/meta/H1/hero identity gates (§13.3). These need the PRIMARY
// keyword or a close variant of it, or the other approved primary. A SECONDARY
// keyword is not a substitute here (carrying the primary is the whole point of
// the field), but naming the secondary that IS present tells the reviewer how
// close the field already is.
//
// The retry: a brand's pages carry some words implicitly (a behavioral-health
// site's "mental health", a dental site's "dental"), and a keyword mined from
// real demand often includes one while the natural heading does not. §3
// explicitly permits a close variant, so the gate retries with those words
// dropped — but only for a phrase that still names something specific
// afterwards, or a primary of "therapist torrance" would clear the gate on the
// city alone.
function keepsAServiceTerm(phrase, ctx, verticalWords) {
  return words(phrase).some(w => !text.STOPWORDS.has(w)
    && !verticalWords.has(w)
    && !ctx.geoExclude.has(w));
}

function primaryInField(ctx, haystack, where) {
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
  const verticalWords = new Set((ctx.verticalWords || []).map(w => text.stem(String(w).toLowerCase())));
  if (verticalWords.size) {
    const withoutVertical = matchAnyKeyword(
      haystack,
      ctx.primaryPhrases.filter(p => keepsAServiceTerm(p, ctx, verticalWords)),
      verticalWords,
    );
    if (withoutVertical) {
      return {
        pass: true,
        detail: `"${withoutVertical}" is present apart from wording this brand's pages carry implicitly.`,
      };
    }
  }
  const related = matchAnyKeyword(haystack, ctx.related);
  return {
    pass: false,
    detail: related
      ? `Only the related keyword "${related}" appears in the ${where} — "${ctx.primary}" and its close variants do not.`
      : `Neither "${ctx.primary}" nor a close variant of it appears in the ${where}.`,
  };
}

function cityCheck(ctx, hit, where) {
  if (!ctx.city) {
    return {
      pass: false,
      detail: `This location record carries no city, so the ${where} localization check cannot run. Fill in the location's city.`,
    };
  }
  return {
    pass: hit,
    detail: hit ? `"${ctx.city}" appears in the ${where}.` : `"${ctx.city}" is never named in the ${where}.`,
  };
}

function bandDetail(n, min, max, unit) {
  return `${n} ${unit} (target ${min}-${max}).`;
}

// ── Unverifiable claims (§6, §9's FAQ Answer Rules, §13.17-§13.22) ─────────
// The template's hardest rule is that the page must not assert a fact the
// brand has not verified: a price, an insurance acceptance, a duration, an
// outcome, a credential, a telehealth availability. The writer is told this in
// those words, but a gate is what makes it reviewable — and this is the one
// class of defect a reader cannot spot by reading the page, because invented
// facts read exactly like real ones.
//
// Detection is deliberately pattern-based and reported as a REVIEW prompt
// rather than a hard failure: "we accept most insurance plans" is a defect
// only if it is untrue, which code cannot know. The check names what it found
// and asks a human to confirm or cut it.
const CLAIM_PATTERNS = [
  [/\$\s?\d/, 'a price'],
  [/\b\d{3}[-.\s)]\s?\d{3}[-.\s]\d{4}\b/, 'a phone number'],
  [/\b(accepts?|accepted|take|takes|covered by|in-network with|bill)\b[^.?!]{0,40}\b(insurance|medicare|medicaid|aetna|cigna|blue cross|anthem|kaiser|united ?healthcare|tricare)\b/i, 'an insurance claim'],
  [/\b(insurance|medicare|medicaid)\b[^.?!]{0,30}\b(covers?|covered|accepted)\b/i, 'an insurance claim'],
  [/\b\d+\s?(%|percent)\b[^.?!]{0,30}\b(success|recover|improve|effective)/i, 'a success rate'],
  [/\b(guarantee[ds]?|guaranteeing|promise[ds]?)\b/i, 'a guarantee'],
  [/\b(board[- ]certified|licensed|phd|psyd|md|lcsw|lmft)\b[^.?!]{0,25}\b(staff|team|clinicians?|therapists?|doctors?)\b/i, 'a credential claim'],
  [/\b(telehealth|virtual|online) (sessions?|appointments?|therapy|care|treatment)\b[^.?!]{0,25}\b(available|offered|provide)/i, 'a telehealth availability claim'],
  [/\b(same[- ]day|next[- ]day|24\/7|walk[- ]ins?)\b/i, 'an availability claim'],
];

function findUnverifiedClaims(ctx) {
  const fields = [
    ['hero one-liner', ctx.hero.oneLiner, 'hero.oneLiner'],
    ['meta description', ctx.meta.metaDescription, 'meta.metaDescription'],
    ...ctx.blocks.map((b, i) => [`section ${i + 1} ("${b.h2}")`, stripHtml(b.html), 'body', i]),
    ['FAQ intro', ctx.faq.intro, 'faq'],
    // The ANSWER only, never the question: a question is not an assertion.
    // "Does Clear Behavioral Health accept insurance for anxiety treatment?"
    // is exactly the question §9 tells the writer to ask, and scanning it
    // reported the page for claiming an insurance acceptance it had not made.
    ...ctx.faqItems.map((f, i) => [`FAQ ${i + 1}`, f.a, 'faq']),
  ];
  const hits = [];
  const perBlock = {};
  let firstField = null;
  fields.forEach(([where, body, field, blockIndex]) => {
    const value = String(body || '');
    // Copy the writer already flagged for a human is doing exactly what it was
    // asked to do — it must not also be reported as an unflagged claim.
    if (/\[REQUIRES CLIENT CONFIRMATION\]/i.test(value)) return;
    const found = CLAIM_PATTERNS.filter(([re]) => re.test(value)).map(([, label]) => label);
    if (!found.length) return;
    const unique = [...new Set(found)];
    hits.push(`${where}: ${unique.join(', ')}`);
    firstField = firstField || field;
    if (blockIndex != null) perBlock[blockIndex] = `States ${unique.join(', ')} — confirm with the client or cut it.`;
  });
  return { hits, perBlock, firstField };
}

// ── The check registry ─────────────────────────────────────────────────────
// id       stable identity; what a recheck request names
// field    the editor control a failure is shown against
// label    human title for the inline notice
// fix      what the reviewer should do; the notice's second line
const LS_CHECKS = [
  {
    id: 'primary_keyword_in_seo_title', severity: 'Critical', field: 'meta.title',
    label: 'Primary keyword in SEO title',
    fix: 'Rewrite the title so it carries the primary keyword or a close natural variant (§3), or regenerate it.',
    run: ctx => primaryInField(ctx, ctx.meta.title, 'SEO title'),
  },
  {
    id: 'primary_keyword_in_h1', severity: 'Critical', field: 'hero.h1',
    label: 'Primary keyword in H1',
    fix: 'Rewrite the H1 so it carries the primary keyword or a close natural variant (§5), or regenerate it.',
    run: ctx => primaryInField(ctx, ctx.hero.h1, 'H1'),
  },
  {
    id: 'primary_keyword_in_meta_description', severity: 'Critical', field: 'meta.metaDescription',
    label: 'Primary keyword in meta description',
    fix: 'Work the primary keyword — or a close variant — into the meta description (§4), or regenerate it.',
    run: ctx => primaryInField(ctx, ctx.meta.metaDescription, 'meta description'),
  },
  {
    id: 'meta_description_length', severity: 'Critical', field: 'meta.metaDescription',
    label: 'Meta description length',
    fix: 'Trim or extend it to the target range (§4).',
    run: (ctx) => {
      const len = String(ctx.meta.metaDescription || '').length;
      const { min, max } = ctx.budgets.metaDescription;
      return { pass: len >= min && len <= max, detail: bandDetail(len, min, max, 'characters') };
    },
  },
  {
    id: 'faq_count', severity: 'Critical', field: 'faq',
    label: 'FAQ count',
    fix: 'Regenerate the FAQ, or edit the brief and re-approve it — §9 requires 5 to 7 questions with answers.',
    run: (ctx) => {
      const { min, max } = ctx.budgets.faqs;
      return {
        pass: ctx.faqItems.length >= min && ctx.faqItems.length <= max,
        detail: bandDetail(ctx.faqItems.length, min, max, 'FAQs'),
      };
    },
  },
  {
    id: 'faq_answers_present', severity: 'Critical', field: 'faq',
    label: 'Every FAQ has an answer',
    fix: 'Write or regenerate the missing answers — §9 requires each FAQ to include an actual answer.',
    run: (ctx) => {
      const empty = ctx.faqItems.filter(f => !String(f.a || '').trim()).length;
      return {
        pass: !empty,
        detail: empty ? `${empty} of ${ctx.faqItems.length} FAQs have no answer.` : `All ${ctx.faqItems.length} FAQs are answered.`,
      };
    },
  },
  {
    id: 'prohibited_claims', severity: 'Critical', field: 'body',
    label: 'Prohibited claims',
    fix: 'Delete the phrase. It is on this brand\'s prohibited-claims list and cannot be published.',
    run: (ctx) => {
      const claims = ctx.prohibitedClaims || [];
      if (!claims.length) return { pass: true, detail: 'This brand has no prohibited-claims list configured.' };
      const haystack = `${ctx.bodyText} ${ctx.meta.title} ${ctx.meta.metaDescription} ${ctx.hero.h1}`.toLowerCase();
      const found = claims.filter(c => haystack.includes(String(c).toLowerCase()));
      return {
        pass: !found.length,
        detail: found.length ? `Found: ${found.map(c => `"${c}"`).join(', ')}.` : `None of the ${claims.length} prohibited claims appear.`,
      };
    },
  },
  {
    id: 'schema_blocks_valid_json', severity: 'Critical', field: 'schema',
    label: 'JSON-LD blocks parse',
    fix: 'Regenerate the page — schema is built server-side and should never be hand-edited.',
    run: (ctx) => {
      const blocks = ctx.scaffold.schema || {};
      const broken = SCHEMA_KEYS.filter(k => {
        try { JSON.parse(blocks[k] || ''); return false; } catch { return true; }
      });
      return {
        pass: !broken.length,
        detail: broken.length ? `Invalid JSON: ${broken.join(', ')}.` : `All ${SCHEMA_KEYS.length} JSON-LD blocks parse.`,
      };
    },
  },
  {
    id: 'seo_title_length', severity: 'Major', field: 'meta.title',
    label: 'SEO title length',
    fix: 'Trim or extend the title to the target range (§3) — readability first, so drop the brand before mangling the keyword.',
    run: (ctx) => {
      const len = String(ctx.meta.title || '').length;
      const { min, max } = ctx.budgets.seoTitle;
      return { pass: len >= min && len <= max, detail: bandDetail(len, min, max, 'characters') };
    },
  },
  {
    id: 'primary_keyword_in_a_heading', severity: 'Major', field: 'body',
    label: 'Keyword in a section heading',
    fix: 'Reword one H2 so it carries the service terms, or edit the brief and regenerate that section.',
    run: (ctx) => {
      // Headings are short topic labels and will not naturally carry the city
      // or state (that is the localization check's job), so geo terms are
      // excluded here and only the service terms have to land.
      const matched = ctx.blocks.map(b => matchAnyKeyword(b.h2, ctx.keywordPhrases, ctx.geoExclude)).find(Boolean) || null;
      return {
        pass: !!(ctx.primary && matched),
        detail: matched
          ? `A section heading carries the service terms of "${matched}".`
          : `No section heading carries the service terms of "${ctx.primary}" or of a related keyword.`,
      };
    },
  },
  {
    id: 'hero_one_liner', severity: 'Major', field: 'hero.oneLiner',
    label: 'Hero one-liner',
    fix: 'Write one sentence in the target word range that carries the primary keyword naturally (§5).',
    run: (ctx) => {
      const value = String(ctx.hero.oneLiner || '').trim();
      const { minWords, maxWords } = ctx.budgets.heroOneLiner;
      const wc = text.wordCount(value);
      if (!value) return { pass: false, detail: 'The hero one-liner is empty.' };
      const inBand = wc >= minWords && wc <= maxWords;
      const carries = primaryInField(ctx, value, 'hero one-liner');
      return {
        pass: inBand && carries.pass,
        detail: [
          bandDetail(wc, minWords, maxWords, 'words'),
          carries.pass ? '' : carries.detail,
        ].filter(Boolean).join(' '),
      };
    },
  },
  {
    id: 'section_count', severity: 'Major', field: 'body',
    label: 'Section count',
    fix: 'Edit the brief and re-approve it — the planner always emits a section list inside the target band.',
    run: (ctx) => {
      const { min, max } = ctx.budgets.blocks;
      return {
        pass: ctx.blocks.length >= min && ctx.blocks.length <= max,
        detail: bandDetail(ctx.blocks.length, min, max, 'sections'),
      };
    },
  },
  {
    id: 'section_char_budget', severity: 'Major', field: 'body',
    label: 'Section length',
    fix: 'Add or cut copy in the flagged sections, or regenerate them — §7 budgets each section separately.',
    run: (ctx) => {
      const perBlock = {};
      const over = [];
      ctx.blocks.forEach((b, i) => {
        const limit = b.charLimit || ctx.budgets.sectionChars;
        const chars = stripHtml(b.html).length;
        if (chars < limit.min || chars > limit.max) {
          perBlock[i] = `${chars} characters (target ${limit.min}-${limit.max}).`;
          over.push(`"${b.h2}" ${chars}`);
        }
      });
      return {
        pass: !over.length,
        blocks: perBlock,
        detail: over.length
          ? `${over.length} section(s) outside their character budget: ${over.join('; ')}.`
          : 'Every section is inside its character budget.',
      };
    },
  },
  {
    id: 'copy_matches_brief', severity: 'Major', field: 'brief',
    label: 'Copy matches the approved brief',
    fix: 'Regenerate the page from the current brief, or revert the heading to what the brief approved.',
    run: (ctx) => {
      if (!ctx.brief) return { pass: false, detail: 'This page has no brief — generate one before writing copy.' };
      const planned = ctx.brief.sections || [];
      if (planned.length !== ctx.blocks.length) {
        return { pass: false, detail: `The brief approved ${planned.length} sections but the page has ${ctx.blocks.length}.` };
      }
      const drifted = planned
        .map((s, i) => (s.h2 !== ctx.blocks[i]?.h2 ? `"${s.h2}" → "${ctx.blocks[i]?.h2}"` : null))
        .filter(Boolean);
      const plannedFaqs = (ctx.brief.faqs || []).length;
      if (plannedFaqs && plannedFaqs !== ctx.faqItems.length) {
        return { pass: false, detail: `The brief approved ${plannedFaqs} questions but the page has ${ctx.faqItems.length}.` };
      }
      return {
        pass: !drifted.length,
        detail: drifted.length ? `Headings changed since approval: ${drifted.join('; ')}.` : 'Sections and questions match the approved brief.',
      };
    },
  },
  {
    id: 'brief_approved', severity: 'Major', field: 'brief',
    label: 'Brief approved',
    fix: 'Approve the brief before treating this page as finished — the copy is written from it.',
    run: ctx => ({
      pass: !!ctx.brief?.approved,
      detail: ctx.brief?.approved
        ? `Approved${ctx.brief.approvedAt ? ` on ${new Date(ctx.brief.approvedAt).toLocaleDateString()}` : ''}.`
        : 'The content brief has not been approved.',
    }),
  },
  {
    id: 'unverified_claims', severity: 'Major', field: 'body',
    label: 'Unverified claims',
    fix: 'Confirm each with the client and keep it, or cut it. If it must stay pending, mark it [REQUIRES CLIENT CONFIRMATION].',
    run: (ctx) => {
      const { hits, perBlock, firstField } = findUnverifiedClaims(ctx);
      return {
        pass: !hits.length,
        field: firstField || undefined,
        blocks: perBlock,
        detail: hits.length
          ? `The page states facts §13 forbids inventing — confirm or cut: ${hits.join('; ')}.`
          : 'No prices, phone numbers, insurance, availability or credential claims were generated.',
      };
    },
  },
  {
    id: 'keyword_reads_naturally', severity: 'Major', field: 'body',
    label: 'Keywords read as English',
    fix: 'Rewrite the flagged phrase as a person would say it — put a preposition in ("anxiety treatment in Torrance") or drop the city from that sentence.',
    run: (ctx) => {
      // Field by field, never the joined bodyText: one section ending "...in
      // Torrance" followed by another starting "Anxiety treatment is..." would
      // look like the very adjacency being detected.
      const fields = [
        ['hero one-liner', ctx.hero.oneLiner, 'hero.oneLiner'],
        ...ctx.blocks.map((b, i) => [`section ${i + 1} ("${b.h2}")`, stripHtml(b.html), 'body', i]),
        ['FAQ intro', ctx.faq.intro, 'faq'],
        ...ctx.faqItems.map((f, i) => [`FAQ ${i + 1}`, `${f.q} ${f.a}`, 'faq']),
      ];
      const hits = [];
      const perBlock = {};
      let firstField = null;
      fields.forEach(([where, body, field, blockIndex]) => {
        const forced = text.findForcedKeywordPhrases(body, {
          keywordPhrases: ctx.keywordPhrases, city: ctx.city, brandName: ctx.brandName,
        });
        if (!forced.length) return;
        hits.push(`${where}: ${forced.map(f => `"${f}"`).join(', ')}`);
        firstField = firstField || field;
        if (blockIndex != null) perBlock[blockIndex] = `Keyword pasted in as a search string: ${forced.map(f => `"${f}"`).join(', ')}.`;
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
    id: 'city_in_body', severity: 'Major', field: 'body',
    label: 'City named in the body',
    fix: 'Name the city in the section the brief marked "localize" — a page with no local specifics reads as a template.',
    run: ctx => cityCheck(ctx, ctx.blocks.some(b => stripHtml(b.html).toLowerCase().includes(ctx.city)), 'body copy'),
  },
  {
    id: 'city_in_faq', severity: 'Major', field: 'faq',
    label: 'City named in the FAQ',
    fix: 'Name the location in another question — one about what THIS location offers, not about the treatment itself (§9).',
    run: (ctx) => {
      if (!ctx.city) return cityCheck(ctx, false, 'FAQ');
      const localized = text.countLocalizedFaqs(ctx.faqItems, ctx.city);
      const min = ctx.budgets.faqs.minLocalized;
      return {
        pass: localized >= min,
        detail: `${localized} of ${ctx.faqItems.length} FAQs name "${ctx.city}" (minimum ${min}).`,
      };
    },
  },
  {
    // The counterweight to the check above. Requiring N localized FAQs without
    // this just buys city names bolted onto universal questions — which is
    // exactly what §9 spends a page warning against.
    id: 'faq_localization_is_meaningful', severity: 'Major', field: 'faq',
    label: 'Local FAQs are genuinely local',
    fix: 'Either drop the city from that question, or turn it into one the location actually changes: what this location offers, which options it runs, or booking here.',
    run: (ctx) => {
      const forced = text.findForcedFaqLocalization(
        ctx.faqItems.map(f => f.q),
        { city: ctx.city, brandName: ctx.brandName },
      );
      return {
        pass: !forced.length,
        detail: forced.length
          ? `The answer to these does not change by city, so naming it reads as filler — ${forced.map(q => `"${q}"`).join('; ')}.`
          : 'Every FAQ that names the location is one the location actually affects.',
      };
    },
  },
  {
    id: 'faq_intro', severity: 'Major', field: 'faq',
    label: 'FAQ introduction',
    fix: 'Write a 2-3 sentence intro in the target word range that says what these questions settle — without answering them (§9).',
    run: (ctx) => {
      const value = String(ctx.faq.intro || '').trim();
      const { minWords, maxWords, maxChars } = ctx.budgets.faqIntro;
      if (!value) return { pass: false, detail: 'The FAQ introduction is empty.' };
      const wc = text.wordCount(value);
      return {
        pass: wc >= minWords && wc <= maxWords && value.length <= maxChars,
        detail: `${bandDetail(wc, minWords, maxWords, 'words')} ${value.length} characters (max ${maxChars}).`,
      };
    },
  },
  {
    id: 'page_word_count', severity: 'Major', field: 'body',
    label: 'Page word count',
    fix: 'Bring the sections inside their character budgets — this total is derived from them, so it is usually a symptom rather than the cause.',
    run: (ctx) => {
      const { acceptMin, acceptMax } = ctx.budgets.pageWords;
      return {
        pass: ctx.wordCount >= acceptMin && ctx.wordCount <= acceptMax,
        detail: `${ctx.wordCount} words across hero, sections and FAQ (target ${acceptMin}-${acceptMax}).`,
      };
    },
  },
  {
    id: 'internal_links', severity: 'Major', field: 'internalLinks',
    label: 'Internal links',
    fix: 'Regenerate the page — sibling links are built from the other locations offering this service.',
    run: (ctx) => {
      const n = (ctx.sections.internalLinks || []).length;
      const min = ctx.budgets.internalLinksMin;
      return { pass: n >= min, detail: `${n} internal links (min ${min}).` };
    },
  },
  {
    id: 'keyword_genuinely_discussed', severity: 'Major', field: 'body',
    label: 'Keyword genuinely discussed',
    fix: 'Write about the topic in one more paragraph or FAQ answer — in your own words. Do NOT paste the keyword in to raise the count.',
    run: (ctx) => {
      const used = Object.entries(ctx.usage.byPhrase).map(([k, n]) => `"${k}" ×${n}`);
      const min = ctx.budgets.minKeywordUses;
      return {
        pass: !!ctx.primary && ctx.usage.total >= min,
        detail: `${ctx.usage.total} natural use${ctx.usage.total === 1 ? '' : 's'} of the keyword or an approved variant `
          + `(minimum ${min}; meta description excluded)${used.length ? ` — ${used.join(', ')}.` : '.'}`,
      };
    },
  },
  {
    id: 'readability', severity: 'Major', field: 'body',
    label: 'Readability',
    fix: 'Split anything over the paragraph limit, or regenerate the flagged section.',
    run: ctx => ({
      pass: ctx.readability.pass,
      blocks: ctx.readability.perBlock,
      detail: ctx.readability.pass
        ? `Every paragraph is within ${ctx.budgets.paragraphWords.hardMax} words.`
        : `${ctx.readability.summary.length} section(s) over the readability budget: ${ctx.readability.summary.join('; ')}.`,
    }),
  },
  {
    id: 'location_data_complete', severity: 'Minor', field: 'locationInfo',
    label: 'Location data',
    fix: 'Ask the client for the flagged fields and enter them on the location record — §6 forbids inventing them.',
    run: (ctx) => {
      const required = ctx.locationInfo.dataRequired || [];
      return {
        pass: !required.length,
        detail: required.length ? required.join('; ') + '.' : 'Every location field the template asks for is on record.',
      };
    },
  },
  {
    id: 'keyword_density', severity: 'Minor', field: 'body',
    label: 'Keyword density',
    fix: 'Replace a couple of PRIMARY keyword uses with a pronoun or a natural paraphrase.',
    run: (ctx) => {
      const density = ctx.wordCount ? ctx.primaryUsage.total / ctx.wordCount : 0;
      const max = ctx.budgets.maxKeywordDensity;
      return {
        pass: density <= max,
        detail: `${(density * 100).toFixed(1)}% from ${ctx.primaryUsage.total} primary-keyword uses in ${ctx.wordCount} words (max ${(max * 100).toFixed(1)}%). Related-keyword uses are not counted here.`,
      };
    },
  },
  {
    id: 'no_placeholder_text', severity: 'Minor', field: 'body',
    label: 'Placeholder text',
    fix: 'Replace the placeholder with real copy.',
    run: (ctx) => {
      const hit = /lorem ipsum|\{\{|\btodo\b|\bTBD\b/i.exec(ctx.bodyText);
      return { pass: !hit, detail: hit ? `Found "${hit[0]}" in the copy.` : 'No placeholder text detected.' };
    },
  },
  {
    id: 'secondary_keyword_used', severity: 'Minor', field: 'body',
    label: 'Related keyword used',
    // Minor by design: §11 says not to assign every keyword everywhere and the
    // writer is told to omit any it cannot place naturally, so a miss here is
    // a nudge to look, not a defect.
    fix: 'Optional — work one related keyword in if it reads naturally.',
    run: (ctx) => {
      if (!ctx.related.length) return { pass: true, detail: 'No related keywords were approved for this page.' };
      const used = ctx.related.filter(k => countAnyKeywordOccurrences(ctx.bodyText, [k]).total >= 1);
      return {
        pass: used.length >= 1,
        detail: `${used.length}/${ctx.related.length} related keywords appear in the body`
          + (used.length ? `: ${used.join(', ')}.` : ' (min 1 where natural).'),
      };
    },
  },
];

const LS_CHECKS_BY_ID = new Map(LS_CHECKS.map(def => [def.id, def]));

function runCheckDef(def, ctx) {
  const result = def.run(ctx);
  return {
    id: def.id,
    name: def.name || def.id,
    severity: def.severity,
    // `def.field` is the control a failure normally belongs to. A check that
    // spans sections can override it at run time with the section that
    // actually failed.
    field: result.field || def.field,
    label: def.label,
    fix: def.fix || '',
    pass: !!result.pass,
    detail: result.detail || '',
    ...(result.blocks && Object.keys(result.blocks).length ? { blocks: result.blocks } : {}),
  };
}

function lsVerdict(checks) {
  const failed = severity => checks.some(c => c.severity === severity && !c.pass);
  return failed('Critical') ? 'FAIL'
    : failed('Major') ? 'REVISIONS REQUIRED'
      : failed('Minor') ? 'CONDITIONAL PASS' : 'PASS';
}

// `extras` carries the two things the checks need that are not on the page:
// the brand's prohibited-claims list and the words its pages carry implicitly.
// Both live on the client row (see lsProfiles), and both are optional — a
// caller with no profile to hand still gets every other check.
function contextFor(scaffold, extras = {}) {
  const ctx = lsContext(scaffold, extras.budgets);
  ctx.prohibitedClaims = extras.prohibitedClaims || [];
  ctx.verticalWords = extras.verticalWords || [];
  return ctx;
}

function runLsQC(scaffold, extras = {}) {
  const ctx = contextFor(scaffold, extras);
  const checks = LS_CHECKS.map(def => runCheckDef(def, ctx));
  return { verdict: lsVerdict(checks), checks };
}

// Re-run ONE check against the current (edited) page — what the wizard's
// per-notice "Recheck" button calls once the reviewer has fixed that one
// thing, so confirming a fix costs a single check instead of the whole set.
function runLsCheck(scaffold, id, extras = {}) {
  const def = LS_CHECKS_BY_ID.get(id);
  if (!def) throw new Error(`Unknown QC check: ${id}`);
  return runCheckDef(def, contextFor(scaffold, extras));
}

// Splices a freshly-run check back into an earlier result and re-derives the
// verdict. Matches on id, falling back to name.
function mergeLsCheck(previousChecks, check) {
  const merged = (previousChecks || []).map(c => (c.id === check.id || c.name === check.name) ? check : c);
  if (!merged.some(c => c.id === check.id)) merged.push(check);
  return { verdict: lsVerdict(merged), checks: merged };
}

// One reviewer-facing recheck, whole. Returns a COMPLETE result because the
// caller stores what it gets back: with no prior checks to merge into there is
// no honest verdict to derive from a single check, so the full pass runs
// instead of writing a one-check PASS over a real result. runLsQC is pure and
// offline, so that costs nothing but a few milliseconds.
function recheckLs(scaffold, id, previousChecks, extras = {}) {
  if (!LS_CHECKS_BY_ID.has(id)) throw new Error(`Unknown QC check: ${id}`);
  const qc = Array.isArray(previousChecks) && previousChecks.length
    ? mergeLsCheck(previousChecks, runLsCheck(scaffold, id, extras))
    : runLsQC(scaffold, extras);
  return { check: qc.checks.find(c => c.id === id), verdict: qc.verdict, checks: qc.checks };
}

// The thresholds the checks enforce, for the wizard to show beside the fields.
// Served over the API rather than duplicated in the client: a target shown in
// the UI that differs from the one QC gates on is worse than showing none.
function lsLimits(clientId) {
  const b = lsProfiles.budgetsFor(clientId);
  return {
    seoTitle: b.seoTitle,
    metaDescription: b.metaDescription,
    heroOneLiner: b.heroOneLiner,
    sectionChars: b.sectionChars,
    paragraphWords: { max: b.paragraphWords.hardMax },
    paragraphsPerBlock: { max: b.paragraphsPerBlock.max },
    listItemMaxWords: b.listItemMaxWords,
    faqAnswerMaxWords: b.faqAnswerMaxWords,
    faqIntro: b.faqIntro,
    faqs: b.faqs,
    blocks: b.blocks,
    pageWords: { min: b.pageWords.acceptMin, max: b.pageWords.acceptMax },
  };
}

module.exports = {
  runLsQC, runLsCheck, recheckLs, mergeLsCheck, lsVerdict, lsLimits,
  LS_CHECKS, findUnverifiedClaims, blockNodes, readability, CLAIM_PATTERNS,
};
