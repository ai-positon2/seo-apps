// ── Clear Behavioral Health page contract ───────────────────────────────────
// The client's "Guidelines for Building the Sections", as data.
//
// ONE source of truth, because three places have to agree about every number
// in it: the writer prompt (what the model is asked for), the QC gates (what
// is accepted), and the brief + wizard (what the SEO team is shown). The
// dental side learned this the hard way -- its paragraph cap was written out
// twice and editing one silently decoupled the instruction from the gate.
//
// This contract REPLACES the dental section shape for CBH. It is not a
// variation on it: the dental body is 7-8 flat H2 blocks of HTML with headings
// forbidden inside, and this is ten sections, one of which nests 4-5
// H3s under a single H2.
//
// Every limit here is a MAXIMUM from the guidelines unless the name says
// otherwise. Character counts are on rendered text, never on markup.

const BRAND = 'Clear Behavioral Health';

// The suffix appended to every meta title. The 50-60 window is measured on the
// title WITHOUT it (confirmed with the client: the full tag runs past Google's
// truncation point on purpose, so the brand is what gets cut).
const TITLE_SUFFIX = ` | ${BRAND}`;

// Fixed headings. These are copied verbatim onto the page -- the guidelines
// say "use this H2 exactly as written" -- so they are not model output and the
// writer is never asked to produce them.
const FIXED_HEADINGS = {
  approachPhilosophy: 'Our philosophy of compassionate care',
  approachTherapies: 'Clinical therapies offered',
  insurance: 'Insurance accepted',
  // Sentence case like every other heading, at the client's instruction. Their
  // guidelines wrote it "Why Choose ...", which is the one place that rule and
  // "use this H2 exactly as written" disagree; the later instruction wins.
  uvp: `Why choose ${BRAND}?`,
};


// ── Sentence case ───────────────────────────────────────────────────────────
// Every heading on a CBH page is sentence case. It cannot be done by lowering
// everything after the first word: "Treatment" and "Anaheim" are the same
// shape, and only one of them may come down. Nothing is lowered unless it is
// known not to be a name.
//
// What counts as a name is deliberately NARROW, and it is matched as a PHRASE
// wherever the name is one. Two earlier versions got this wrong:
//
//   - protecting every capitalised word of the service name, which lower-cased
//     nothing: "Anxiety", "Depression" and "Burnout" are common nouns, and the
//     result was "Our approach to Anxiety treatment";
//   - protecting the brand word by word, which capitalised those words
//     everywhere else too: "Health" is in "Clear Behavioral Health", so
//     "outpatient mental health treatment" came out "mental Health".
//
// So single words here are only those that are ALWAYS proper, and everything
// else -- the brand, the city, the state, nearby areas -- is restored as a
// phrase after the text has been lowered.
const PROPER_NOUNS = new Set([
  // Branded medicines that appear in service names and copy. Generic
  // substances -- cocaine, heroin, fentanyl, marijuana, kratom -- are common
  // nouns and are deliberately absent.
  'adderall', 'klonopin', 'suboxone', 'valium', 'vicodin', 'xanax', 'spravato',
  // The only state this client operates in.
  'california',
]);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The names worth restoring for one page, each with the casing it should have.
function protectedTerms({ locationName, location } = {}) {
  const phrases = [];
  const add = (value) => {
    const s = String(value || '').trim();
    if (!s) return;
    phrases.push(s);
    // "Los Angeles – Mid Wilshire" is also two names; a heading may carry
    // either half without the dash that joins them here.
    s.split(/\s*[–—-]\s*/).map(p => p.trim()).filter(p => p.length > 2)
      .forEach(p => { if (p !== s) phrases.push(p); });
  };
  add(BRAND);
  add(locationName);
  add(location?.city);
  add(location?.state);
  add(location?.location_name);
  (location?.nearby_areas || []).forEach(add);
  // Longest first, so "Clear Behavioral Health" is restored before a bare
  // "Health" phrase could ever match part of it.
  phrases.sort((a, b) => b.length - a.length);
  // NOT the service name -- see the note above.
  return { words: new Set(PROPER_NOUNS), phrases };
}

// Accepts either the object protectedTerms returns or a bare Set of words, so
// a caller with nothing page-specific can still pass PROPER_NOUNS.
function keepParts(keep) {
  if (keep instanceof Set) return { words: keep, phrases: [] };
  return { words: keep?.words instanceof Set ? keep.words : PROPER_NOUNS, phrases: keep?.phrases || [] };
}

function sentenceCase(text, keep = PROPER_NOUNS) {
  const s = String(text || '').trim();
  if (!s) return '';
  const { words, phrases } = keepParts(keep);

  let seenWord = false;
  // Split KEEPING the separators, so spacing and punctuation survive untouched.
  let out = s.split(/(\s+)/).map((tok) => {
    if (!tok.trim()) return tok;
    const bare = tok.replace(/[^A-Za-z0-9&'’-]/g, '');
    const isFirst = !seenWord;
    seenWord = true;
    if (!bare) return tok;
    // A possessive is the same name: "Health's" has to match "health", or
    // "Clear Behavioral Health's approach" loses its capital on the last word.
    const base = bare.toLowerCase().replace(/['’]s$/, '');
    const protectedWord = /^[A-Z0-9&'’-]{2,}$/.test(bare)  // ADHD, OCD, II, CA
      // The pronoun, including its contractions. Matching only a bare "I" left
      // "I'm" unprotected and shipped "if i'm too drained to keep working".
      || /^I(['’](m|ve|ll|d))?$/.test(bare)
      || words.has(base);
    if (protectedWord) return tok;
    const lowered = tok.toLowerCase();
    // Capitalise the first LETTER, not the first character: "(stress" must not
    // be skipped because it opens with a bracket.
    return isFirst ? lowered.replace(/[a-z]/, ch => ch.toUpperCase()) : lowered;
  }).join('');

  // Then put the multi-word names back, whole.
  phrases.forEach((p) => {
    const re = new RegExp(`\\b${escapeRe(p).replace(/\s+/g, '\\s+')}\\b`, 'gi');
    out = out.replace(re, p);
  });
  return out;
}

// A heading built from the service, and optionally the city. Cased here so the
// page and any gate that rebuilds the same heading always agree.
function casedHeading(text, { serviceName, locationName } = {}) {
  return sentenceCase(text, protectedTerms({ serviceName, locationName }));
}

// The headings that interpolate the page's own service and location. All three
// are sentence-cased, so "Anxiety Treatment" reads "anxiety treatment" inside
// them while "ADHD" and "Santa Clarita" keep their capitals.
function approachHeading(serviceName) {
  return casedHeading(`Our approach to ${serviceName}`, { serviceName });
}
// "What is depression?", not "What is depression treatment" -- the client's
// live pages all name the CONDITION and ask a question. It takes the raw
// service name from the record, NOT the display phrase that appends
// "treatment": page.serviceName carries that phrase and the approach and
// service headings both need it, so this is a separate field rather than a
// change to that one.
function educationalHeading(conditionName) {
  const name = String(conditionName || '').trim();
  return casedHeading(`What ${whatIsVerb(name)} ${name}?`, { serviceName: name });
}

// "What ARE parent support groups?". A plural head noun needs the plural verb,
// and the words that trip a naive "ends in s" test are exactly the ones in this
// taxonomy: psychosis, stress, IOP & PHP.
function whatIsVerb(name) {
  const last = String(name || '').trim().split(/\s+/).pop() || '';
  const plural = /s$/i.test(last) && !/(ss|us|is|os)$/i.test(last);
  return plural ? 'are' : 'is';
}
// The service section's H2 names PROGRAMS, which is how every one of the
// client's live pages reads: "Depression treatment programs in Van Nuys",
// "Anxiety treatment programs in El Monte".
//
// Appended only where it reads as English:
//
//   - a phrase that already names a programme keeps what it has ("Partial
//     hospitalization program (PHP)", "Legal Diversion Program");
//   - one ending in "treatment" or "therapy" takes "programs". That covers
//     every condition service, because servicePhraseDisplay has already given
//     a bare condition its head noun: "Depression" -> "Depression treatment";
//   - one ending in an ACRONYM is left alone rather than growing "Outpatient
//     mental health treatment (IOP) programs";
//   - anything left ends in a noun that reads as a service without naming the
//     care at all -- "Anger Management", "Case Management", "Parent Support
//     Groups", "Labor Union Support". Those never picked up either word, so
//     they take BOTH, at the client's instruction: "Anger management treatment
//     programs in Anaheim Hills".
const ACRONYM_TAIL_RE = /\([A-Z0-9][A-Z0-9&.\s]*\)$/;

function programPhrase(serviceName) {
  const s = String(serviceName || '').trim();
  if (!s) return s;
  if (/\bprograms?\b/i.test(s)) return s;
  if (/\b(treatment|therapy)$/i.test(s)) return `${s} programs`;
  return ACRONYM_TAIL_RE.test(s) ? s : `${s} treatment programs`;
}

function serviceHeading(serviceName, locationName) {
  return casedHeading(`${programPhrase(serviceName)} in ${locationName}`, { serviceName, locationName });
}

// The clinicians section's H2 (the CMS calls it `experts`), at the client's
// instruction: "Stress treatment experts at Clear Behavioral Health, Manhattan
// Beach". Built from the display phrase, which appends "treatment" only to a
// bare condition, so "Cognitive Behavioral Therapy" never becomes "...Therapy
// Treatment experts" -- the defect that came from letting the writer word it.
//
// Only pages stamped meta.fixedExpertsHeading get it (see cbhCompose). A page
// generated before this keeps the heading its writer composed.
function expertsHeading(serviceName, locationName) {
  return casedHeading(`${serviceName} experts at ${BRAND}, ${locationName}`, { serviceName, locationName });
}

// Which of the CMS's two buckets a service falls in. Derived from the service
// record's own groups rather than a hand-kept list, so a service added to the
// taxonomy is classified without editing code. Approved with the client:
// anything carrying an addiction-* group is "addiction", everything else --
// including the teen services, which carry only a `teen` group -- is
// "mental_health".
function serviceTypeFor(service) {
  const groups = Array.isArray(service?.groups) ? service.groups : [];
  return groups.some(g => String(g).startsWith('addiction-')) ? 'addiction' : 'mental_health';
}

// ── Location slugs ──────────────────────────────────────────────────────────
// The slug of the client's live location page, which is what a service page
// nests under. One office can have TWO live pages: Redondo Beach – Outpatient
// runs addiction and mental-health outpatient care and the site gives each its
// own page, so the record carries a per-service-type override and the service
// decides which applies.
function cbhLocationSlug(location, service) {
  const byType = location?.location_slug_by_service_type || {};
  return String(byType[serviceTypeFor(service)] || location?.location_slug || '').trim();
}

function cbhLocationPageUrl(location, service) {
  const override = (location?.location_slug_by_service_type || {})[serviceTypeFor(service)];
  return override ? `/locations/${override}/` : (location?.location_page_url || '');
}


// ── Em dashes ───────────────────────────────────────────────────────────────
// Banned from everything this module generates, at the client's instruction:
// no em dash in a brief, in page copy, or in a regenerated field.
//
// A prompt alone does not hold this. A model asked for 300 characters of warm
// clinical prose reaches for an em dash whether or not it was told not to, and
// the miss is invisible -- it breaks no length gate, trips no other rule, and
// reads perfectly well. So the rule is enforced in CODE at the three points
// every generated string passes through (normalizeCbhBrief, mergeCbhL3,
// cbhRegen), the prompts are written without em dashes of their own so the
// instruction is not contradicted by the text delivering it, and a QC gate
// reports any that a reviewer types by hand.
//
// ONLY the em dash (U+2014). The EN dash (U+2013) is structural in this
// module: it separates an office label from its programme ("Los Angeles – Mid
// Wilshire", see seed.js, split on by text.baseCity) and it is a legal bullet
// marker in bulletPattern below. Banning it would break both.
// Written as an escape, not as the character. Everything below is the rule's
// own implementation, and a sweep for stray em dashes across this module
// (`grep -r` before a release) should come back with prose that NAMES the
// character and nothing else.
const EM_DASH = '\u2014';

function hasEmDash(text) {
  return String(text == null ? '' : text).includes(EM_DASH);
}

// What an em dash becomes: a comma. That is the job it was doing in the
// constructions a model actually writes -- an aside ("we treat the whole
// person — not just the symptom") or an appositive ("three formats — IOP, PHP
// and virtual — are offered here"). Deleting it instead runs the clauses
// together; a spaced hyphen is the same punctuation wearing a hat.
//
// Two places it is NOT a comma:
//   - OPENING an entry, where it is a bullet marker rather than punctuation.
//     Rewriting "— Evening sessions" to ", Evening sessions" would stop the
//     entry being a bullet, and a bullet costs a different number of lines
//     against the educational budget than the same words as prose (lineCount).
//     It is handed the canonical "-" marker the writer is asked for instead.
//   - BESIDE punctuation already doing that job, where a comma would produce
//     ". ," or ", ,".
function removeEmDashes(text) {
  const input = String(text == null ? '' : text);
  // The overwhelming majority of strings, including every one on a page that
  // was already clean. Worth the guard: this runs over whole page objects.
  if (!input.includes(EM_DASH)) return input;

  let s = input;
  // Opening a bullet.
  s = s.replace(/^(\s*)\u2014+(\s+)/, '$1-$2');
  // Opening anything else: a stray dash with nothing to join.
  s = s.replace(/^(\s*)\u2014+\s*/, '$1');
  // Beside existing punctuation, or closing the string.
  s = s.replace(/([,.;:!?])\s*\u2014+\s*/g, '$1 ');
  s = s.replace(/\s*\u2014+\s*$/, '');
  // Everything left is punctuating a clause.
  s = s.replace(/\s*\u2014+\s*/g, ', ');
  // Tidy the seams. Both " ," and ", ," are reachable above, and a space
  // before a comma is wrong however it got there.
  return s.replace(/ +([,.;:!?])/g, '$1').replace(/,(\s*,)+/g, ',').replace(/ {2,}/g, ' ');
}

// ── Limits ──────────────────────────────────────────────────────────────────
const LIMITS = {
  metaTitle: { min: 50, max: 60, excludesSuffix: true },
  metaDescription: { min: 150, max: 160 },

  hero: {
    h1MaxChars: 70,
    descriptionMaxChars: 175,
  },

  approach: {
    // The cap is on the WHOLE section: H2 body + both H3 bodies together.
    sectionMaxChars: 1200,
    paragraphMaxChars: 300,
    paragraphsPerBlock: { min: 1, max: 2 },
  },

  insurance: {
    maxChars: 200,
  },

  educational: {
    // The H2's own 1-2 paragraphs, before any H3.
    introMaxChars: 500,
    introParagraphs: { min: 1, max: 2 },
    h3Count: { min: 4, max: 5 },
    h3HeadingMaxChars: 60,
    // EVERY H3 body gets (lineMultiplier x number of H3s) lines -- confirmed
    // with the client. Five H3s means fifteen lines EACH, not fifteen shared:
    // the allowance scales with how many subsections the section has.
    //
    // Note what this does to the page. At five H3s the educational section can
    // run to roughly 6,400 characters against 1,200 for the approach section,
    // so the page becomes overwhelmingly educational. The client's call.
    lineMultiplier: 3,
    lineMaxChars: 85,
    // Two costs that were dead under the old flat cap of three -- a body that
    // short can never reach a break -- and bite now that a body runs to twelve
    // or fifteen: a bullet costs one line ON TOP of its wrapped length, and
    // the mandatory break after every third line costs one line itself.
    linesBeforeBreak: 3,
    // A bullet costs a line, like any other entry -- no surcharge. It carried
    // one briefly, and that made the client's own pages impossible: a live
    // subsection is an eight-bullet list, which at two lines each came to
    // sixteen against a cap of nine to fifteen.
    //
    // Note where the cost sits now. Eight bullets are eight lines, but the
    // mandatory break after every third adds two more, so on a list the BREAKS
    // are the larger charge, not the bullets.
    bulletExtraLines: 0,
    // Serialised so the wizard's counter can apply the SAME rule the gates do
    // rather than carry a second regex that drifts from this one.
    bulletPattern: '^\\s*(?:[-\u2013\u2014\u2022*\u00b7]|\\d+[.)])\\s+',
  },

  uvp: {
    maxChars: 300,
  },

  service: {
    maxChars: 150,
  },

  treatment: {
    // Applies only to a page generated before this H2 was built by code
    // (expertsHeading): on those the writer composed it.
    //
    // This is NOT a QC gate any more, at the client's instruction. The shape
    // they want -- "<service> treatment experts at Clear Behavioral Health,
    // <city>" -- runs to 104 characters on the longest service and city, so a
    // gate at 60 failed every page that wrote the heading correctly. What is
    // left is a CEILING: it guides the writer, bounds a regenerated heading and
    // drives the wizard's counter. No page fails over it.
    headingMaxChars: 110,
    maxChars: 250,
  },

  faqs: {
    count: { min: 5, max: 7 },
    answerMaxChars: 300,
    // The guidelines ask for a balanced mix. QC warns rather than blocks when
    // a type is missing -- a genuinely useful five-question set that happens
    // to skip one category is not a defect worth failing a page over.
    types: ['location', 'brand', 'intent'],
  },
};

// Derived: the most body text this contract can produce, which is what makes
// the dental 600-word floor wrong for CBH. Roughly 5,700 characters at every
// maximum, and a legitimate page can land near half that.
function maxBodyChars() {
  const l = LIMITS;
  return l.hero.h1MaxChars
    + l.hero.descriptionMaxChars
    + l.approach.sectionMaxChars
    + l.insurance.maxChars
    + l.educational.introMaxChars
    + l.educational.h3Count.max * (l.educational.h3HeadingMaxChars
        + linesPerBody(l.educational.h3Count.max) * l.educational.lineMaxChars)
    + l.uvp.maxChars
    + l.service.maxChars
    + l.treatment.headingMaxChars + l.treatment.maxChars
    + l.faqs.count.max * l.faqs.answerMaxChars;
}

// Section order on the page, as the guidelines list them. `key` is the field
// in the page object; `label` is what the wizard and the export call it.
const SECTION_ORDER = [
  { key: 'hero', label: 'Hero' },
  { key: 'approach', label: 'Approach' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'educational', label: 'Educational' },
  { key: 'uvp', label: 'Why Choose Us' },
  { key: 'service', label: 'Service' },
  { key: 'treatment', label: 'Treatment' },
  { key: 'faq', label: 'FAQs' },
];

// Where a section's content came from. The guidelines require this to be
// stated per section; it is shown in the wizard and the exports, never on the
// page itself.
const PROVENANCE = {
  COMPETITOR: 'competitor',
  FALLBACK: 'fallback',
};

// A bullet, as the writer emits one: a marker at the start of the entry. That
// marker is the only signal there is -- lines are stored as plain strings --
// and it matters because a bullet costs a line more than the same words would
// as a sentence.
const BULLET_RE = new RegExp(LIMITS.educational.bulletPattern);
function isBullet(text) {
  return BULLET_RE.test(String(text || ''));
}

// A body line may open with a bold sub-label -- "**Biological factors** ..." --
// which is how the client's live pages break a long subsection up. The markers
// are MARKUP, so they are stripped before anything is measured: this module's
// own rule is that character counts are on rendered text, and four asterisks
// per label would otherwise eat the line budget quietly.
//
// BULLET_RE requires whitespace after its marker, so "**Label**" is never
// mistaken for a "*" bullet, and "- **Label:** ..." still matches the "-"
// branch.
function stripInlineMarkup(text) {
  return String(text == null ? '' : text).replace(/\*\*/g, '');
}

// Counts one entry the way the guidelines do: a paragraph of N characters
// occupies ceil(N / 85) lines, and a bullet costs one extra on top of that.
function lineCount(text, lineMaxChars = LIMITS.educational.lineMaxChars) {
  const s = stripInlineMarkup(text).trim();
  if (!s) return 0;
  return Math.ceil(s.length / lineMaxChars)
    + (isBullet(s) ? LIMITS.educational.bulletExtraLines : 0);
}

// An entry is one of two things, and the difference is what the body reads
// like. A BULLET is a scannable item; a PARAGRAPH is 2-4 sentences that wrap
// over several lines. A non-bullet entry short enough to occupy a single line
// is neither -- it is a fragment, and a body made only of those reads like a
// slide deck rather than a page. The gates need to be able to say so.
function entryForm(text, lineMaxChars = LIMITS.educational.lineMaxChars) {
  const s = stripInlineMarkup(text).trim();
  if (!s) return 'empty';
  if (isBullet(s)) return 'bullet';
  return s.length > lineMaxChars ? 'paragraph' : 'fragment';
}

// The lines a body's content occupies, before the breaks that content obliges.
function contentLines(lines = []) {
  return lines.reduce((n, l) => n + lineCount(l), 0);
}

// Breaks a run of N lines requires: one after every third, none after the last
// (a trailing break is not a break between anything). Six lines take one, seven
// take two. They count against the allowance because the guidelines say a
// paragraph break counts as a line.
function breaksFor(n) {
  return n > 0 ? Math.floor((n - 1) / LIMITS.educational.linesBeforeBreak) : 0;
}

// What one H3 body costs in full: its content plus its mandatory breaks.
function linesUsed(lines = []) {
  const n = contentLines(lines);
  return n + breaksFor(n);
}

// What EACH H3 body is allowed: three lines per H3 in the section, so five H3s
// give fifteen lines to every one of them.
function linesPerBody(h3Count) {
  return LIMITS.educational.lineMultiplier * Number(h3Count || 0);
}

// How much CONTENT fits inside that allowance once the breaks are paid for.
// Twelve content lines cost fifteen (twelve plus three breaks), so a cap of
// fifteen buys twelve lines of writing, not fifteen. This is the number the
// writer is given -- telling a model "fifteen lines, but budget for breaks you
// have to work out yourself" produces overruns.
function contentAllowance(cap) {
  let n = 0;
  while (n + 1 + breaksFor(n + 1) <= Number(cap || 0)) n += 1;
  return n;
}

// The section ceiling if every body spent its full allowance. Informational --
// what is GATED is each body against linesPerBody.
function sectionLineTotal(h3Count) {
  const n = Number(h3Count || 0);
  return linesPerBody(n) * n;
}

// The character length the gates measure: rendered text, whitespace collapsed,
// markup stripped. Every cap in the guidelines is about what a reader sees.
function textLength(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

// The title as it ships, and the part the 50-60 window applies to.
function fullTitle(title) {
  const t = String(title || '').trim();
  return t.endsWith(TITLE_SUFFIX) ? t : `${t}${TITLE_SUFFIX}`;
}
function titleWithoutSuffix(title) {
  const t = String(title || '').trim();
  return t.endsWith(TITLE_SUFFIX) ? t.slice(0, -TITLE_SUFFIX.length).trim() : t;
}

module.exports = {
  BRAND, TITLE_SUFFIX, FIXED_HEADINGS, LIMITS, SECTION_ORDER, PROVENANCE,
  approachHeading, educationalHeading, serviceHeading, expertsHeading,
  serviceTypeFor, cbhLocationSlug, cbhLocationPageUrl,
  lineCount, textLength, fullTitle, titleWithoutSuffix, maxBodyChars,
  sentenceCase, protectedTerms, casedHeading, PROPER_NOUNS, programPhrase, whatIsVerb,
  EM_DASH, hasEmDash, removeEmDashes,
  isBullet, entryForm, stripInlineMarkup, contentLines, breaksFor, linesUsed,
  linesPerBody, contentAllowance, sectionLineTotal,
};
