// ── Clear Behavioral Health QC ──────────────────────────────────────────────
// Gates the CBH page contract (cbhContract.js). Deliberately separate from the
// dental checks in qaEngine.js: the two contracts share no section, and the
// dental gates would fail every CBH page on sight -- they demand 7-8 H2 blocks
// and 600+ words, where this contract has ten sections and can
// legitimately land near 450.
//
// Same result shape as runDentalQC ({ verdict, checks: [{ id, name, severity,
// field, pass, detail }] }) so the wizard's QC panel and the exports render
// both flows without branching.
//
// Severity, consistently applied:
//   Critical  the page is wrong and cannot ship (a fixed heading altered, a
//             required section missing, the primary keyword absent from H1)
//   Major     a stated limit in the guidelines is breached
//   Minor     a "balanced mix" style preference, not a hard rule

const c = require('./cbhContract');

const { LIMITS: L, FIXED_HEADINGS, PROVENANCE } = c;

// ── Context ─────────────────────────────────────────────────────────────────
// Everything the checks read, derived once. `page` is the CBH page object;
// see cbhCompose for its shape.
function context(page = {}) {
  const s = page.sections || {};
  const paragraphsOf = (block) => (block?.paragraphs || []).filter(p => String(p || '').trim());
  const approachBlocks = [
    { key: 'h2', heading: s.approach?.heading, paragraphs: s.approach?.paragraphs },
    { key: 'philosophy', heading: s.approach?.philosophy?.heading, paragraphs: s.approach?.philosophy?.paragraphs },
    { key: 'therapies', heading: s.approach?.therapies?.heading, paragraphs: s.approach?.therapies?.paragraphs },
  ];
  const approachChars = approachBlocks
    .flatMap(b => paragraphsOf(b))
    .reduce((n, p) => n + c.textLength(p), 0);

  return {
    page, sections: s,
    meta: page.meta || {},
    hero: s.hero || {},
    approach: s.approach || {},
    approachBlocks,
    approachChars,
    insurance: s.insurance || {},
    educational: s.educational || {},
    h3s: s.educational?.h3s || [],
    uvp: s.uvp || {},
    service: s.service || {},
    treatment: s.treatment || {},
    faqs: s.faq?.items || [],
    paragraphsOf,
    // The keyword the page targets, and its significant words. Matching is
    // word-based and order-independent, because the guidelines say explicitly
    // that the keyword's words "do not need to appear in the exact same order".
    primary: String(page.primaryKeyword || '').trim(),
    city: String(page.locationName || '').trim(),
  };
}

const STOPWORDS = new Set(['in', 'the', 'a', 'an', 'of', 'for', 'and', 'to', 'at', 'with']);

function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

// Every significant word of the keyword appears somewhere in the text, in any
// order. This is the guidelines' own rule, not a substring match.
function containsKeywordWords(text, keyword) {
  const hay = new Set(words(text));
  const kw = words(keyword).filter(w => !STOPWORDS.has(w));
  return kw.length > 0 && kw.every(w => hay.has(w));
}

// A close variant: most of the keyword's words, allowing one to be missing.
// "anxiety treatment in anaheim hills" is satisfied by "anxiety care in
// Anaheim Hills" -- the guidelines ask for the keyword "or a close variant".
function containsKeywordVariant(text, keyword) {
  const hay = new Set(words(text));
  const kw = words(keyword).filter(w => !STOPWORDS.has(w));
  if (!kw.length) return false;
  const hits = kw.filter(w => hay.has(w)).length;
  return hits >= Math.max(1, kw.length - 1);
}

const CTA_RE = /\b(get support|explore treatment|schedule|book|call|contact|get started|reach out|connect with|start today|learn more|talk to)\b/i;

// Every piece of PROSE on the page, labelled with where a reviewer would find
// it. Built from the context rather than by walking the page object, because a
// walk would also pick up the URLs, the slugs and the stored JSON-LD -- none of
// which is copy, and the last of which is rebuilt from the copy anyway.
function prosePieces(ctx) {
  const out = [];
  // `section` is the finer key the client feedback rules are scoped by (see
  // cbhFeedback.SECTIONS); `field` stays the coarse key the wizard anchors on.
  const add = (label, field, text, section) => {
    if (String(text || '').trim()) out.push({ label, field, text, section: section || field });
  };
  const addAll = (label, field, list, section) => (list || []).forEach(t => add(label, field, t, section));
  const approachSection = { h2: 'approach.intro', philosophy: 'approach.philosophy', therapies: 'approach.therapies' };

  add('the meta title', 'meta.title', ctx.meta.title, 'meta.title');
  add('the meta description', 'meta.metaDescription', ctx.meta.metaDescription, 'meta.description');
  add('the H1', 'hero.h1', ctx.hero.h1, 'hero.h1');
  add('the hero description', 'hero.description', ctx.hero.description, 'hero.description');
  ctx.approachBlocks.forEach(b => addAll('the approach section', 'approach', b.paragraphs, approachSection[b.key]));
  add('the insurance paragraph', 'insurance', ctx.insurance.paragraph, 'insurance');
  addAll('the educational intro', 'educational', ctx.educational.paragraphs, 'educational.intro');
  ctx.h3s.forEach((h) => {
    add('an educational H3 heading', 'educational', h.heading, 'educational.heading');
    addAll('an educational H3 body', 'educational', h.lines, 'educational.body');
  });
  add('the Why Choose paragraph', 'uvp', ctx.uvp.paragraph, 'uvp');
  add('the service paragraph', 'service', ctx.service.paragraph, 'service');
  add('the treatment heading', 'treatment', ctx.treatment.heading, 'treatment.heading');
  add('the treatment paragraph', 'treatment', ctx.treatment.paragraph, 'treatment.body');
  ctx.faqs.forEach((f) => {
    add('an FAQ question', 'faq', f.q, 'faq.question');
    add('an FAQ answer', 'faq', f.a, 'faq.answer');
  });
  return out;
}

function lenDetail(label, value, { min, max }) {
  const n = c.textLength(value);
  return `${label}: ${n} characters (${min ? `${min}-` : 'max '}${max}).`;
}

// ── Checks ──────────────────────────────────────────────────────────────────
const CHECKS = [
  // ── Meta ────────────────────────────────────────────────────────────────
  {
    id: 'meta_title_length', severity: 'Major', field: 'meta.title',
    name: `Meta title is ${L.metaTitle.min}-${L.metaTitle.max} characters (excluding the brand suffix)`,
    run: (ctx) => {
      const bare = c.titleWithoutSuffix(ctx.meta.title);
      const n = bare.length;
      return {
        pass: n >= L.metaTitle.min && n <= L.metaTitle.max,
        detail: `"${bare}" is ${n} characters (${L.metaTitle.min}-${L.metaTitle.max}). `
          + `The suffix "${c.TITLE_SUFFIX.trim()}" is excluded from the count and appended on top.`,
      };
    },
  },
  {
    id: 'meta_title_has_keyword', severity: 'Critical', field: 'meta.title',
    name: 'Meta title carries the primary keyword or a close variant',
    run: (ctx) => ({
      pass: containsKeywordVariant(c.titleWithoutSuffix(ctx.meta.title), ctx.primary),
      detail: `Title: "${c.titleWithoutSuffix(ctx.meta.title)}" · keyword: "${ctx.primary}".`,
    }),
  },
  {
    id: 'meta_title_suffix', severity: 'Critical', field: 'meta.title',
    name: 'Meta title ends with the brand suffix',
    run: (ctx) => ({
      pass: String(ctx.meta.fullTitle || '').endsWith(c.TITLE_SUFFIX),
      detail: `Shipped title: "${ctx.meta.fullTitle || ''}".`,
    }),
  },
  {
    id: 'meta_description_length', severity: 'Major', field: 'meta.metaDescription',
    name: `Meta description is ${L.metaDescription.min}-${L.metaDescription.max} characters`,
    run: (ctx) => {
      const n = c.textLength(ctx.meta.metaDescription);
      return {
        pass: n >= L.metaDescription.min && n <= L.metaDescription.max,
        detail: lenDetail('Meta description', ctx.meta.metaDescription, L.metaDescription),
      };
    },
  },
  {
    id: 'meta_description_has_keyword_words', severity: 'Critical', field: 'meta.metaDescription',
    name: 'Meta description contains the primary keyword words (any order)',
    run: (ctx) => ({
      pass: containsKeywordWords(ctx.meta.metaDescription, ctx.primary),
      detail: `Keyword words must all appear, in any order: "${ctx.primary}".`,
    }),
  },
  {
    id: 'meta_description_has_cta', severity: 'Major', field: 'meta.metaDescription',
    name: 'Meta description includes a mental-health CTA',
    run: (ctx) => ({
      pass: CTA_RE.test(ctx.meta.metaDescription || ''),
      detail: 'Expected something like "Get support", "Explore treatment options" or "Schedule a consultation".',
    }),
  },

  // ── Hero ────────────────────────────────────────────────────────────────
  {
    id: 'hero_h1_length', severity: 'Major', field: 'hero.h1',
    name: `H1 is at most ${L.hero.h1MaxChars} characters`,
    run: (ctx) => ({
      pass: c.textLength(ctx.hero.h1) > 0 && c.textLength(ctx.hero.h1) <= L.hero.h1MaxChars,
      detail: lenDetail('H1', ctx.hero.h1, { max: L.hero.h1MaxChars }),
    }),
  },
  {
    id: 'hero_h1_keyword_and_location', severity: 'Critical', field: 'hero.h1',
    name: 'H1 names the primary keyword and the location',
    run: (ctx) => {
      const hasKw = containsKeywordVariant(ctx.hero.h1, ctx.primary);
      const hasLoc = !!ctx.city && words(ctx.hero.h1).join(' ').includes(words(ctx.city).join(' '));
      return {
        pass: hasKw && hasLoc,
        detail: `keyword: ${hasKw ? 'present' : 'MISSING'} · location "${ctx.city}": ${hasLoc ? 'present' : 'MISSING'}.`,
      };
    },
  },
  {
    id: 'hero_description_length', severity: 'Major', field: 'hero.description',
    name: `Hero description is at most ${L.hero.descriptionMaxChars} characters`,
    run: (ctx) => ({
      pass: c.textLength(ctx.hero.description) > 0 && c.textLength(ctx.hero.description) <= L.hero.descriptionMaxChars,
      detail: lenDetail('Hero description', ctx.hero.description, { max: L.hero.descriptionMaxChars }),
    }),
  },
  {
    id: 'hero_description_has_keyword', severity: 'Major', field: 'hero.description',
    name: 'Hero description uses the primary keyword or a close variation',
    run: (ctx) => ({
      pass: containsKeywordVariant(ctx.hero.description, ctx.primary),
      detail: `Keyword: "${ctx.primary}".`,
    }),
  },

  // ── Approach ────────────────────────────────────────────────────────────
  {
    id: 'approach_headings', severity: 'Critical', field: 'approach',
    name: 'Approach carries its H2 and both required H3s',
    run: (ctx) => {
      const philosophy = ctx.approach.philosophy?.heading;
      const therapies = ctx.approach.therapies?.heading;
      const ok = !!ctx.approach.heading
        && philosophy === FIXED_HEADINGS.approachPhilosophy
        && therapies === FIXED_HEADINGS.approachTherapies;
      return {
        pass: ok,
        detail: ok ? 'H2 plus both fixed H3s present, verbatim.'
          : `Expected H3s "${FIXED_HEADINGS.approachPhilosophy}" and "${FIXED_HEADINGS.approachTherapies}"; got "${philosophy || ''}" and "${therapies || ''}".`,
      };
    },
  },
  {
    id: 'approach_section_length', severity: 'Major', field: 'approach',
    name: `Approach section is at most ${L.approach.sectionMaxChars} characters in total`,
    run: (ctx) => ({
      pass: ctx.approachChars > 0 && ctx.approachChars <= L.approach.sectionMaxChars,
      detail: `Approach totals ${ctx.approachChars} characters across its H2 and H3 bodies (max ${L.approach.sectionMaxChars}).`,
    }),
  },
  {
    id: 'approach_paragraph_limits', severity: 'Major', field: 'approach',
    name: `Every approach block has ${L.approach.paragraphsPerBlock.min}-${L.approach.paragraphsPerBlock.max} paragraphs of at most ${L.approach.paragraphMaxChars} characters`,
    run: (ctx) => {
      const problems = [];
      ctx.approachBlocks.forEach((b) => {
        const paras = ctx.paragraphsOf(b);
        if (paras.length < L.approach.paragraphsPerBlock.min || paras.length > L.approach.paragraphsPerBlock.max) {
          problems.push(`${b.key}: ${paras.length} paragraphs`);
        }
        paras.forEach((p, i) => {
          const n = c.textLength(p);
          if (n > L.approach.paragraphMaxChars) problems.push(`${b.key} paragraph ${i + 1}: ${n} chars`);
        });
      });
      return { pass: !problems.length, detail: problems.length ? problems.join('; ') : 'All approach paragraphs within limits.' };
    },
  },

  // ── Insurance ───────────────────────────────────────────────────────────
  {
    id: 'insurance_heading', severity: 'Critical', field: 'insurance',
    name: `Insurance H2 reads exactly "${FIXED_HEADINGS.insurance}"`,
    run: (ctx) => ({
      pass: ctx.insurance.heading === FIXED_HEADINGS.insurance,
      detail: `Got "${ctx.insurance.heading || ''}".`,
    }),
  },
  {
    id: 'insurance_length', severity: 'Major', field: 'insurance',
    name: `Insurance paragraph is at most ${L.insurance.maxChars} characters`,
    run: (ctx) => ({
      pass: c.textLength(ctx.insurance.paragraph) > 0 && c.textLength(ctx.insurance.paragraph) <= L.insurance.maxChars,
      detail: lenDetail('Insurance', ctx.insurance.paragraph, { max: L.insurance.maxChars }),
    }),
  },

  // ── Educational ─────────────────────────────────────────────────────────
  {
    id: 'educational_intro_length', severity: 'Major', field: 'educational',
    name: `Educational intro is at most ${L.educational.introMaxChars} characters`,
    run: (ctx) => {
      const paras = (ctx.educational.paragraphs || []).filter(p => String(p || '').trim());
      const n = paras.reduce((sum, p) => sum + c.textLength(p), 0);
      const countOk = paras.length >= L.educational.introParagraphs.min
        && paras.length <= L.educational.introParagraphs.max;
      return {
        pass: n > 0 && n <= L.educational.introMaxChars && countOk,
        detail: `${paras.length} paragraph(s), ${n} characters (max ${L.educational.introMaxChars}, `
          + `${L.educational.introParagraphs.min}-${L.educational.introParagraphs.max} paragraphs).`,
      };
    },
  },
  {
    id: 'educational_h3_count', severity: 'Critical', field: 'educational',
    name: `Educational section has ${L.educational.h3Count.min}-${L.educational.h3Count.max} H3s`,
    run: (ctx) => ({
      pass: ctx.h3s.length >= L.educational.h3Count.min && ctx.h3s.length <= L.educational.h3Count.max,
      detail: `${ctx.h3s.length} H3s (${L.educational.h3Count.min}-${L.educational.h3Count.max}).`,
    }),
  },
  {
    id: 'educational_h3_heading_length', severity: 'Major', field: 'educational',
    name: `Every H3 heading is at most ${L.educational.h3HeadingMaxChars} characters`,
    run: (ctx) => {
      const over = ctx.h3s
        .map((h, i) => ({ i, n: c.textLength(h.heading) }))
        .filter(x => x.n === 0 || x.n > L.educational.h3HeadingMaxChars);
      return {
        pass: !over.length,
        detail: over.length ? over.map(x => `H3 ${x.i + 1}: ${x.n} chars`).join('; ')
          : ctx.h3s.length ? 'All H3 headings within limit.' : 'No H3s to check.',
      };
    },
  },
  {
    id: 'educational_h3_line_budget', severity: 'Major', field: 'educational',
    name: `Every H3 body is at most ${L.educational.lineMultiplier} lines per H3 in the section, of ${L.educational.lineMaxChars} characters`,
    run: (ctx) => {
      // Each body gets the SAME allowance -- three lines per H3 in the section
      // -- and they do not share it. Five H3s means fifteen lines available to
      // every one of them, not fifteen between them. A bullet costs two and a
      // break after every third line costs one, both charged by linesUsed.
      const cap = c.linesPerBody(ctx.h3s.length);
      const bad = ctx.h3s
        .map((h, i) => ({ i, heading: h.heading || '', used: c.linesUsed(h.lines || []) }))
        .filter(x => x.used === 0 || x.used > cap);
      const spread = ctx.h3s.map((h, i) => `${i + 1}:${c.linesUsed(h.lines || [])}`).join(' ');
      return {
        pass: !!ctx.h3s.length && !bad.length,
        detail: !ctx.h3s.length ? 'No H3s to check.'
          : bad.length
            ? bad.map(x => `H3 ${x.i + 1} ("${x.heading}"): ${x.used} lines`).join('; ')
              + ` (max ${cap} each, breaks included).`
            : `All ${ctx.h3s.length} H3 bodies within ${cap} lines each (${spread}).`,
      };
    },
  },
  {
    // Minor, like faq_type_mix: an all-prose section is still a usable page,
    // so this warns rather than fails. It IS in the writer's CORRECTABLE set,
    // so a draft that comes back one-sided gets rewritten before anyone sees
    // it -- which is the point. Reported at section level, not per body: a
    // short subsection that is all prose is fine, a whole section of
    // one-line fragments is what the client actually objected to.
    id: 'educational_body_mix', severity: 'Minor', field: 'educational',
    name: 'The educational bodies mix paragraphs and bullets',
    run: (ctx) => {
      const forms = ctx.h3s.map(h => (h.lines || []).map(l => c.entryForm(l)));
      const all = forms.flat();
      const n = (f) => all.filter(x => x === f).length;
      const allFragments = forms
        .map((f, i) => ({ i, only: f.length && f.every(x => x === 'fragment') }))
        .filter(x => x.only);
      const problems = [];
      if (!n('paragraph')) problems.push('no paragraphs — every entry is a single line or a bullet');
      if (!n('bullet')) problems.push('no bullets — nothing in the section is scannable');
      if (allFragments.length) {
        problems.push(`H3 ${allFragments.map(x => x.i + 1).join(', ')} `
          + `${allFragments.length === 1 ? 'is' : 'are'} nothing but one-line fragments`);
      }
      return {
        pass: !!ctx.h3s.length && !problems.length,
        detail: !ctx.h3s.length ? 'No H3s to check.'
          : problems.length ? problems.join('; ') + '.'
            : `${n('paragraph')} paragraphs, ${n('bullet')} bullets, ${n('fragment')} single-line entries.`,
      };
    },
  },
  {
    id: 'educational_provenance_stated', severity: 'Major', field: 'educational',
    name: 'Every educational section states whether it is competitor-driven or fallback',
    run: (ctx) => {
      const valid = new Set(Object.values(PROVENANCE));
      const missing = ctx.h3s
        .map((h, i) => ({ i, src: h.source }))
        .filter(x => !valid.has(x.src));
      const introOk = valid.has(ctx.educational.source);
      return {
        pass: !missing.length && introOk,
        detail: (!introOk ? 'The intro has no source tag. ' : '')
          + (missing.length ? `Untagged H3s: ${missing.map(x => x.i + 1).join(', ')}.` : 'All sections tagged.'),
      };
    },
  },
  {
    id: 'educational_fallback_cited', severity: 'Major', field: 'educational',
    name: 'Every fallback section names the source it was written from',
    run: (ctx) => {
      // The guidelines allow authoritative sources to fill gaps but forbid
      // inventing information. An untraceable fallback is indistinguishable
      // from an invented one, so it must carry the URL it came from.
      const bad = ctx.h3s
        .map((h, i) => ({ i, h }))
        .filter(x => x.h.source === PROVENANCE.FALLBACK && !String(x.h.sourceUrl || '').trim());
      return {
        pass: !bad.length,
        // Named, not numbered. "Fallback H3s with no source URL: 2" read as a
        // count of two rather than subsection number two.
        detail: bad.length
          ? `No source URL on ${bad.length === 1 ? 'this fallback H3' : 'these fallback H3s'}: `
            + bad.map(x => `#${x.i + 1} "${x.h.heading || ''}"`).join('; ') + '.'
          : ctx.h3s.length ? 'Every fallback section is attributed.' : 'No H3s to check.',
      };
    },
  },

  // ── UVP ─────────────────────────────────────────────────────────────────
  {
    id: 'uvp_heading', severity: 'Critical', field: 'uvp',
    name: `UVP H2 reads exactly "${FIXED_HEADINGS.uvp}"`,
    run: (ctx) => ({
      pass: ctx.uvp.heading === FIXED_HEADINGS.uvp,
      detail: `Got "${ctx.uvp.heading || ''}".`,
    }),
  },
  {
    id: 'uvp_length', severity: 'Major', field: 'uvp',
    name: `UVP paragraph is at most ${L.uvp.maxChars} characters`,
    run: (ctx) => ({
      pass: c.textLength(ctx.uvp.paragraph) > 0 && c.textLength(ctx.uvp.paragraph) <= L.uvp.maxChars,
      detail: lenDetail('UVP', ctx.uvp.paragraph, { max: L.uvp.maxChars }),
    }),
  },
  {
    id: 'uvp_is_specific', severity: 'Minor', field: 'uvp',
    name: 'UVP paragraph names the service and the location',
    run: (ctx) => {
      // The H2 is fixed and generic, so the specificity the guidelines ask for
      // has to live in the paragraph.
      const hay = words(ctx.uvp.paragraph).join(' ');
      const hasLoc = !!ctx.city && hay.includes(words(ctx.city).join(' '));
      const hasSvc = containsKeywordVariant(ctx.uvp.paragraph, ctx.primary);
      return {
        pass: hasLoc && hasSvc,
        detail: `location: ${hasLoc ? 'present' : 'missing'} · service: ${hasSvc ? 'present' : 'missing'}.`,
      };
    },
  },

  // ── Service ─────────────────────────────────────────────────────────────
  {
    id: 'service_heading', severity: 'Critical', field: 'service',
    name: 'Service H2 reads "<Service> in <Location>"',
    run: (ctx) => {
      const expected = c.serviceHeading(ctx.page.serviceName || '', ctx.city);
      return { pass: ctx.service.heading === expected, detail: `Expected "${expected}", got "${ctx.service.heading || ''}".` };
    },
  },
  {
    id: 'service_length', severity: 'Major', field: 'service',
    name: `Service paragraph is at most ${L.service.maxChars} characters`,
    run: (ctx) => ({
      pass: c.textLength(ctx.service.paragraph) > 0 && c.textLength(ctx.service.paragraph) <= L.service.maxChars,
      detail: lenDetail('Service', ctx.service.paragraph, { max: L.service.maxChars }),
    }),
  },

  // ── Treatment ───────────────────────────────────────────────────────────
  // No LENGTH gate on this H2, at the client's instruction: the shape they
  // asked for runs past any cap that would have caught a runaway heading, and
  // they would rather have the shape. What is left is a PRESENCE check -- the
  // old gate also failed an empty H2, and dropping that too would have let a
  // page ship with no heading at all on the one section code does not write.
  {
    id: 'treatment_heading_present', severity: 'Major', field: 'treatment',
    name: 'Treatment H2 is present',
    run: (ctx) => ({
      pass: c.textLength(ctx.treatment.heading) > 0,
      detail: c.textLength(ctx.treatment.heading) > 0
        ? `Treatment H2: ${c.textLength(ctx.treatment.heading)} characters.`
        : 'Treatment H2 is empty.',
    }),
  },
  {
    id: 'treatment_length', severity: 'Major', field: 'treatment',
    name: `Treatment paragraph is at most ${L.treatment.maxChars} characters`,
    run: (ctx) => ({
      pass: c.textLength(ctx.treatment.paragraph) > 0
        && c.textLength(ctx.treatment.paragraph) <= L.treatment.maxChars,
      detail: lenDetail('Treatment', ctx.treatment.paragraph, { max: L.treatment.maxChars }),
    }),
  },
  // No gate on this H2 naming the service and the city. There was one, and the
  // client's CMS spec then showed the same heading as "Work With Experienced
  // Mental Health Professionals" -- which names neither and is theirs to write.
  // The writer is still ASKED for the specific shape; a reviewer who edits it
  // to something general is no longer told the page is wrong.

  // ── FAQs ────────────────────────────────────────────────────────────────
  {
    id: 'faq_count', severity: 'Critical', field: 'faq',
    name: `Page carries ${L.faqs.count.min}-${L.faqs.count.max} FAQs`,
    run: (ctx) => ({
      pass: ctx.faqs.length >= L.faqs.count.min && ctx.faqs.length <= L.faqs.count.max,
      detail: `${ctx.faqs.length} FAQs (${L.faqs.count.min}-${L.faqs.count.max}).`,
    }),
  },
  {
    id: 'faq_answer_length', severity: 'Major', field: 'faq',
    name: `Every FAQ answer is at most ${L.faqs.answerMaxChars} characters`,
    run: (ctx) => {
      const over = ctx.faqs
        .map((f, i) => ({ i, n: c.textLength(f.a) }))
        .filter(x => x.n === 0 || x.n > L.faqs.answerMaxChars);
      return {
        pass: !over.length,
        detail: over.length ? over.map(x => `FAQ ${x.i + 1}: ${x.n} chars`).join('; ')
          : ctx.faqs.length ? 'All answers within limit.' : 'No FAQs to check.',
      };
    },
  },
  {
    id: 'faq_type_mix', severity: 'Minor', field: 'faq',
    name: 'FAQs cover location, brand and user-intent questions',
    run: (ctx) => {
      const present = new Set(ctx.faqs.map(f => f.type).filter(Boolean));
      const missing = L.faqs.types.filter(t => !present.has(t));
      return {
        pass: !missing.length,
        detail: missing.length ? `No ${missing.join(' or ')} question in the set.` : 'All three question types present.',
      };
    },
  },

  // ── House style ─────────────────────────────────────────────────────────
  {
    id: 'no_em_dash', severity: 'Major', field: 'page',
    name: 'No em dash anywhere on the page',
    // Major, not Critical: it is a stated style rule breached, which is the
    // same class as a breached character limit, and a page carrying one is
    // wrong rather than unusable.
    //
    // Expected never to fire on a generated page. mergeCbhL3 strips em dashes
    // as the writer's output is merged and refreshCbhDerived strips them again
    // on every read and save, so by the time a generated page reaches QC it is
    // already clean. What this gate is FOR is the one path neither covers: a
    // reviewer typing one into the editor and pressing Recheck, where the text
    // has not been through a save yet. Without it, the only signal would be the
    // value quietly changing under them at save time.
    run: (ctx) => {
      const hits = prosePieces(ctx).filter(p => c.hasEmDash(p.text));
      return {
        pass: !hits.length,
        // Names the sections rather than quoting the text: a reviewer needs to
        // know where to look, and the offending line is right there when they do.
        field: hits[0]?.field || 'page',
        detail: hits.length
          ? `Em dash in ${[...new Set(hits.map(h => h.label))].join(', ')}. `
            + 'Replace it with a comma, a colon or a full stop.'
          : 'No em dashes.',
      };
    },
  },
];

const CHECKS_BY_ID = new Map(CHECKS.map(def => [def.id, def]));

function runCheckDef(def, ctx) {
  const result = def.run(ctx);
  return {
    id: def.id,
    name: def.name || def.id,
    severity: def.severity,
    field: result.field || def.field,
    pass: !!result.pass,
    detail: result.detail || '',
  };
}

function verdict(checks) {
  const failed = severity => checks.some(x => x.severity === severity && !x.pass);
  return failed('Critical') ? 'FAIL'
    : failed('Major') ? 'REVISIONS REQUIRED'
      : failed('Minor') ? 'CONDITIONAL PASS' : 'PASS';
}

// `feedbackRules` are the client's active feedback rules (cbhFeedback). They
// gate only pages generated under them -- the `feedback` marker -- so a page
// made before the rules existed is judged exactly as it always was.
function runCbhQc(page, { feedbackRules } = {}) {
  const ctx = context(page);
  const checks = CHECKS.map(def => runCheckDef(def, ctx));
  if (feedbackRules && page && page.feedback) {
    // Required here rather than at the top: cbhFeedback reads this module's
    // prose helpers, so a top-level require would be circular.
    checks.push(...require('./cbhFeedback').qcChecks(page, feedbackRules));
  }
  return { verdict: verdict(checks), checks };
}

// Re-run ONE check after the reviewer has fixed that field, so confirming a
// fix costs a single check instead of a full pass.
function runCbhCheck(page, id) {
  const def = CHECKS_BY_ID.get(id);
  if (!def) return null;
  return runCheckDef(def, context(page));
}

// A CBH page is recognisable by its own section set -- used to route a saved
// page to the right QC engine without trusting a stored page_type alone.
function isCbhPage(page) {
  return !!page && !!page.sections && !!page.sections.educational && !!page.sections.uvp;
}

module.exports = {
  runCbhQc, runCbhCheck, isCbhPage, verdict, context, prosePieces,
  CHECKS, CHECKS_BY_ID, containsKeywordWords, containsKeywordVariant,
};
