// ── Text utilities for uniqueness / originality checks (Spec §7.3) ──────────
// Dependency-free. Used by the QA engine and the generator's cross-page check.

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Six Gentle Dental offices carry a sub-area label in their `city` field
// rather than a city name — "Boston - Newbury Street", "Worcester at The
// Trolley Yard", "Manchester Elm Street" (see seed.js GD_LOCATION_DEFS, where
// `city` doubles as the office label). Nobody searches "invisalign manchester
// elm street", the keyword universe files those rows under the parent city,
// the Primary eligibility gate needs a literal city match, and the page's H1 /
// title / schema locality all have to name a real city — so every consumer
// resolves the parent city through here. The office's own label is preserved
// separately in `location_name`.
//
// Lives in text.js, not in keywordAdapter, because compose.js needs it too and
// must not pull the SERP/SEMrush/LLM stack in to call one string function.
//
// Two signals, both narrow on purpose. Real multi-word cities in this data set
// ("South Boston", "West Roxbury", "Jamaica Plain", "North Andover",
// "New Bedford", "South Nashua") match neither and pass through unchanged:
//   1. an explicit " - " separator  -> take the part before it
//   2. a label that LEADS with its own region's city name -> take the region
function baseCity(city, region) {
  const c = String(city || '').trim();
  const split = c.split(/\s+[-–—]\s+/)[0].trim();
  if (split && split !== c) return split;
  const r = String(region || '').trim();
  if (r && c.toLowerCase() !== r.toLowerCase()
        && new RegExp('^' + escapeRegex(r) + '\\s', 'i').test(c)) return r;
  return c;
}

function wordCount(s) {
  const n = normalize(s);
  return n ? n.split(' ').length : 0;
}

// ── Educational-block HTML normalization ────────────────────────────────────
// The writer is told, in every prompt, that block HTML uses ONLY <p>, <ul> and
// <li>. It mostly complies, but a full-body regeneration intermittently emits
// a stray heading or bare un-wrapped copy, which qaEngine's readability gate
// reports as "N words sit outside any <p>/<ul>" — a Major failure that pushes
// an otherwise-good page to REVISIONS REQUIRED.
//
// That is a pure formatting defect with a safe, meaning-preserving repair, so
// fix it deterministically rather than hoping the next roll of the model
// complies. Same belt-and-braces spirit as alignToOutline and
// normalizeMetaDescriptionLength.
//
// Keeps <p> and <ul>/<ol> blocks as they are and in order; every run of text
// between or around them (including one inside a disallowed block tag such as
// <h3> or <div>) is unwrapped and re-emitted as its own <p>.
function normalizeBlockHtml(html) {
  const src = String(html || '').trim();
  if (!src) return '';
  const out = [];
  // Matches a whole list or paragraph block; anything not matched is loose.
  const BLOCK_RE = /<(ul|ol)\b[^>]*>[\s\S]*?<\/(?:ul|ol)>|<p\b[^>]*>[\s\S]*?<\/p>/gi;
  const flushLoose = (chunk) => {
    // Drop tags the contract does not allow, keep their words.
    const textOnly = String(chunk || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (textOnly) out.push(`<p>${textOnly}</p>`);
  };
  let last = 0;
  let m;
  while ((m = BLOCK_RE.exec(src))) {
    flushLoose(src.slice(last, m.index));
    out.push(m[0].trim());
    last = m.index + m[0].length;
  }
  flushLoose(src.slice(last));
  return out.join('');
}

// k-word shingles for n-gram overlap similarity.
function shingles(s, k = 3) {
  const words = normalize(s).split(' ').filter(Boolean);
  const set = new Set();
  for (let i = 0; i + k <= words.length; i++) set.add(words.slice(i, i + k).join(' '));
  return set;
}

// Jaccard similarity over shingles → 0..1.
function similarity(a, b, k = 3) {
  const A = shingles(a, k), B = shingles(b, k);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const sh of A) if (B.has(sh)) inter++;
  return inter / (A.size + B.size - inter);
}

// Flatten a page_data object into a single body string for comparison.
function pageBodyText(pageData = {}) {
  const parts = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) parts.push(v); };
  push(pageData.hero_intro);
  push(pageData.approach?.intro);
  (pageData.approach?.care_pillars || []).forEach(p => push(p.copy));
  (pageData.competitor_section?.blocks || []).forEach(b => {
    push(b.h2);
    (b.h3s || []).forEach(h => { push(h.heading); push(h.copy); });
  });
  (pageData.faqs || []).forEach(f => { push(f.question); push(f.answer); });
  return parts.join('\n');
}

// ── Keyword-phrase matching (shared by the QA engine and the dental outline
// planner) ──────────────────────────────────────────────────────────────────
const STOPWORDS = new Set(['in', 'the', 'a', 'an', 'of', 'for', 'near', 'me', 'and']);
// Light plural/singular stemming — service names are plural ("Root Canals",
// "Veneers") but a chosen primary keyword is often the singular, bare form
// ("root canal malden ma"). Without this, "canal" vs "canals" never match as
// the same word even though they're an obvious close variant. Good enough
// for this domain's regular plurals; not a real stemmer.
function stem(word) {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}
function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map(stem);
}
function containsAllKeywordWords(haystack, phrase, exclude) {
  const hayWords = new Set(words(haystack));
  const kwWords = words(phrase).filter(w => !STOPWORDS.has(w) && !(exclude && exclude.has(w)));
  return kwWords.length > 0 && kwWords.every(w => hayWords.has(w));
}

// Counts "close variant" occurrences of a single keyword phrase, given its
// significant words. Kept as a thin wrapper over countAnyKeywordOccurrences so
// there is exactly ONE counting algorithm in this module: it used to be a
// second copy that advanced by a whole window after each hit, which undercounts
// copy that legitimately uses the keyword twice inside eight words.
function countKeywordOccurrences(bodyText, keywordWords, window = 8) {
  if (!keywordWords.length) return 0;
  return countAnyKeywordOccurrences(bodyText, [keywordWords.join(' ')], { window }).total;
}

// ── Keyword variant / related-keyword matching ──────────────────────────────
// "Did the page use the keyword?" is not a question about one exact phrase. A
// well-written page uses a close variant ("whitening in Malden"), the OTHER
// approved primary, or one of the approved related/secondary keywords. These
// two take the whole approved phrase list and report WHICH phrase matched, so
// QC can say "matched 'teeth whitening malden'" instead of a bare fail.

// Returns the first phrase whose significant words all appear in `haystack`,
// or null. Order the phrases by preference (primary first) — the caller uses
// the returned phrase to explain the match.
function matchAnyKeyword(haystack, phrases, exclude) {
  const hayWords = new Set(words(haystack));
  for (const phrase of phrases || []) {
    const kwWords = words(phrase).filter(w => !STOPWORDS.has(w) && !(exclude && exclude.has(w)));
    if (kwWords.length && kwWords.every(w => hayWords.has(w))) return phrase;
  }
  return null;
}

// Counts uses of ANY of `phrases` in the body: a window that satisfies more
// than one phrase counts ONCE, never once per phrase. Returns the total plus
// the per-phrase breakdown.
//
// After a hit it resumes just past the MINIMAL run of words that satisfied the
// phrase, not past the whole window. Jumping a full window looks equivalent and
// isn't: it skips whatever follows the match inside that window, so five
// consecutive sentences each using the keyword counted four. Advancing past the
// matched run alone still makes matches non-overlapping — the same words can
// never be counted twice — while letting genuinely separate uses each count.
function countAnyKeywordOccurrences(bodyText, phrases, { window = 8, exclude } = {}) {
  const sets = (phrases || [])
    .map(phrase => ({ phrase, kwWords: words(phrase).filter(w => !STOPWORDS.has(w) && !(exclude && exclude.has(w))) }))
    .filter(s => s.kwWords.length);
  const byPhrase = {};
  if (!sets.length) return { total: 0, byPhrase };

  const bodyWords = words(bodyText);
  let total = 0;
  let i = 0;
  while (i < bodyWords.length) {
    const slice = bodyWords.slice(i, i + window);
    const present = new Set(slice);
    const hit = sets.find(s => s.kwWords.every(w => present.has(w)));
    if (!hit) { i++; continue; }
    total++;
    byPhrase[hit.phrase] = (byPhrase[hit.phrase] || 0) + 1;
    // The run ends at the last of the keyword's words to first appear.
    const runEnd = Math.max(...hit.kwWords.map(w => slice.indexOf(w)));
    i += runEnd + 1;
  }
  return { total, byPhrase };
}

// ── Force-fitted keyword detection ─────────────────────────────────────────
// A keyword is a SEARCH QUERY, not a phrase to reproduce. Query strings are
// usually not grammatical English — "invisalign cost boston", "root canal
// dentist malden" — and pasting one into a sentence is the single most
// recognizable tell of machine-written local SEO copy:
//
//   WRONG  "Invisalign Boston patients trust offers a discreet way ...
//           we'll discuss Invisalign cost Boston"
//   RIGHT  "Straighten your teeth discreetly with Invisalign clear aligners
//           in Boston. Learn about the treatment process, costs ..."
//
// The tell is ADJACENCY: the city sitting directly against a service term with
// no preposition between them. Natural English almost always inserts one ("in
// Boston", "the cost of Invisalign in Boston") or drops the city entirely.
//
// Matching only a run of SPACES is what keeps this precise: a comma, a period
// or a connector word breaks the match, so "...travel to Boston. Invisalign is
// popular" and "clear aligners in Boston" are both left alone.
//
// Returns the offending fragments (de-duplicated) so QC can quote them back.
function findForcedKeywordPhrases(body, { keywordPhrases = [], city = '', brandName = '' } = {}) {
  const cityRaw = String(city || '').trim();
  if (!cityRaw || !keywordPhrases.length) return [];

  // "Gentle Dental Methuen" is the office's NAME — a proper noun a patient
  // would say out loud — even though it puts a service word ("Dental") right
  // against the city. Mask the brand+city pair before scanning so the office's
  // own name is never reported as a force-fitted keyword.
  let text = String(body || '');
  const brand = String(brandName || '').trim();
  if (brand) {
    const brandCity = new RegExp(`${escapeRegex(brand)}\\s+(?:of\\s+)?${escapeRegex(cityRaw)}`, 'gi');
    text = text.replace(brandCity, ' ');
  }

  const geo = new Set(words(cityRaw));
  const terms = [...new Set(
    keywordPhrases.flatMap(p => words(p)).filter(w => !STOPWORDS.has(w) && !geo.has(w)),
  )];
  if (!terms.length) return [];

  const alt = terms.map(escapeRegex).join('|');
  const c = escapeRegex(cityRaw);
  // \\w* absorbs the plural the stemmer removed ("canal" -> "canals").
  // Escapes are DOUBLED because this is a template literal: a single \b
  // there is a literal backspace and \w / \s collapse to letters.
  const re = new RegExp(`\\b(?:(?:${alt})\\w*\\s+${c}|${c}\\s+(?:${alt})\\w*)\\b`, 'gi');
  return [...new Set((text.match(re) || []).map(m => m.replace(/\s+/g, ' ')))];
}

// ── FAQ localization: is naming the city here meaningful, or forced? ───────
// At least two FAQs should name the location, but ONLY where the answer
// actually depends on it. Compare:
//
//   GOOD  "Do you offer IV sedation at your Methuen practice?"
//         "Is oral conscious sedation offered in Methuen?"
//         "What types of sedation dentistry are available at your Methuen location?"
//   BAD   "Does sedation dentistry hurt in Methuen?"
//         "How long does sedation dentistry take in Methuen?"
//         "Is sedation dentistry safe for me in Methuen?"
//         "Who should consider sedation dentistry in Methuen?"
//
// Both lists say "in Methuen", so the phrasing is not the signal — the QUESTION
// TYPE is. Sedation does not hurt more in Methuen, take longer in Methuen or
// have a different safety profile in Methuen; those answers are identical in
// every city, so the city is decoration. Availability, which options this
// office runs, and who to ask are genuinely local.
//
// So: flag a question that names the city AND asks about the procedure itself,
// unless it also asks what this practice provides.
const FAQ_UNIVERSAL_RE = /\b(hurts?|hurting|painful|pain)\b|how long (does|will|is)|\bsafe\b|\brisks?\b|\bside effects?\b|\bwho should\b|\bcandidates?\b|\bsuitable\b|how does it (work|feel)/i;

function faqAvailabilityRe(brandName) {
  const brand = String(brandName || '').trim();
  const brandClause = brand ? `|\\bat ${escapeRegex(brand)}\\b` : '';
  return new RegExp(
    `\\bdo(?:es)? (?:you|your)\\b|\\bavailable\\b|\\boffere?d?\\b|\\bprovide[sd]?\\b|\\bat your\\b|\\bwhat types?\\b|\\bcan i (?:get|book|schedule)\\b${brandClause}`,
    'i',
  );
}

function mentionsCity(s, city) {
  const c = String(city || '').trim();
  if (!c) return false;
  return new RegExp(`\\b${escapeRegex(c)}\\b`, 'i').test(String(s || ''));
}

// Returns the questions whose localization is decoration rather than substance.
function findForcedFaqLocalization(questions, { city = '', brandName = '' } = {}) {
  const availability = faqAvailabilityRe(brandName);
  return (questions || [])
    .map(q => String(q || ''))
    .filter(q => mentionsCity(q, city) && !availability.test(q) && FAQ_UNIVERSAL_RE.test(q));
}

// How many FAQ items name the location at all (question or answer).
function countLocalizedFaqs(items, city) {
  return (items || []).filter(f => mentionsCity(`${f?.q || ''} ${f?.a || ''}`, city)).length;
}

module.exports = {
  normalize, escapeRegex, baseCity, normalizeBlockHtml,
  wordCount, shingles, similarity, pageBodyText,
  STOPWORDS, stem, words, containsAllKeywordWords, countKeywordOccurrences,
  matchAnyKeyword, countAnyKeywordOccurrences, findForcedKeywordPhrases,
  findForcedFaqLocalization, countLocalizedFaqs, mentionsCity,
};
