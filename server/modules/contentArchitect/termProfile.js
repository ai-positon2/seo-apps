// ── Stage 5a: term profile per page ──────────────────────────────────────────
// Builds one weighted term-frequency map per page. Fields are all optional —
// Stage 3 (draft, no crawl yet) passes only `url` (slug tokens); Stage 5
// (post-crawl) passes the full crawled fields. Same function, two input
// qualities, per the build spec's explicit "one engine" requirement — Stage 3
// must never become a second, drifting implementation of this logic.
const { stemmer } = require('stemmer');
const { FIELD_WEIGHTS, NGRAM_MAX, GENERIC_TERM_DOC_FREQUENCY } = require('./config');

// Deliberately NOT patternClassifier.js's VERTICAL_KEYWORDS — that list is
// tuned to DETECT a vertical, so it intentionally includes specific,
// discriminating procedure/product words ("invisalign", "braces", "teeth").
// Stripping those from clustering was a real bug caught in testing: an
// invisalign-topic cluster and a teeth-whitening-topic cluster both
// collapsed to unassigned once their one distinguishing term was removed as
// "generic". This list only holds practice-TYPE words the spec's own example
// describes ("dental" and "dentist" appear on nearly every page of a dental
// site and carry zero discriminating information) — never specific services.
const VERTICAL_GENERIC_TERMS = {
  dental: ['dental', 'dentist', 'dentistry'],
  healthcare: ['health', 'healthcare', 'medical', 'clinic', 'wellness'],
  legal: ['law', 'legal', 'lawyer', 'attorney', 'firm'],
  saas: ['software', 'platform', 'saas'],
  ecommerce: ['shop', 'store', 'ecommerce'],
  'home-services': ['contractor', 'services'],
};

// Compact, standard English stopword list — enough to strip connective noise
// without a heavyweight NLP dependency for a slug/title/heading vocabulary.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'at', 'by', 'for', 'with',
  'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
  'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
  'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do',
  'does', 'did', 'doing', 'it', 'its', 'this', 'that', 'these', 'those', 'i',
  'you', 'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her', 'as',
  'what', 'which', 'who', 'whom', 'am', 'also', 'us', 'get', 'new',
]);

function tokenizeWords(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function cleanTokens(words, surface = null) {
  return words.filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w)).map((w) => {
    const stem = stemmer(w);
    if (surface) {
      if (!surface.has(stem)) surface.set(stem, new Map());
      const forms = surface.get(stem);
      forms.set(w, (forms.get(w) || 0) + 1);
    }
    return stem;
  });
}

// A stemmed term back in words a reader recognises: each stem as the spelling
// the pages used most ("tabl" -> "tables", "daili" -> "daily"). Mechanical
// cluster names showed the stems themselves ("Canva & Zapier Tabl").
function surfaceTerm(term, surface) {
  if (!surface) return term;
  return term.split(' ').map((stem) => {
    const forms = surface.get(stem);
    if (!forms) return stem;
    return [...forms.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  }).join(' ');
}

// Unigrams through NGRAM_MAX-grams from an already-cleaned token sequence —
// n-grams built AFTER stopword removal so "clear the aligner" and "clear
// aligner" produce the same bigram; that's intentional, not a bug.
function ngrams(tokens, maxN) {
  const grams = [];
  for (let n = 1; n <= maxN && n <= tokens.length; n++) {
    for (let i = 0; i + n <= tokens.length; i++) grams.push(tokens.slice(i, i + n).join(' '));
  }
  return grams;
}

function slugText(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).join(' ').replace(/[-_]/g, ' ');
  } catch {
    return '';
  }
}

// Second-level labels that belong to a country's suffix ("example.co.uk").
const PUBLIC_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or', 'go']);

// The registrable domain's own label: "www.gentledental.com" -> "gentledental",
// "my.clevelandclinic.org" -> "clevelandclinic", "blog.example.co.uk" ->
// "example". (Taking the FIRST label made the brand "my" and "blog".)
function brandLabel(domain) {
  const host = String(domain || '').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] || '';
  let i = labels.length - 2;
  if (labels[labels.length - 1].length === 2 && PUBLIC_SECOND_LEVEL.has(labels[i]) && i > 0) i -= 1;
  return labels[i];
}

function deriveBrandTokens(domain) {
  const label = brandLabel(domain);
  return label ? new Set([stemmer(label)]) : new Set();
}

// The brand as the site writes it in its titles — "… | Aspen Dental",
// "… - Moz" — when that tail, run together, is the domain's label ("aspen
// dental" -> "aspendental"). Returns the raw words ("aspen dental") or null.
// Only a tail on at least a third of the titles counts.
function titleBrandPhrase(pages, domain) {
  const label = brandLabel(domain).replace(/[^a-z0-9]/g, '');
  if (!label) return null;
  const counts = new Map();
  for (const p of pages || []) {
    const parts = String(p.title || '').split(/\s+[|–—-]\s+|\s*[|–—]\s*/);
    if (parts.length < 2) continue;
    // NFKC, so "Position²" reads as "position2".
    const tail = parts[parts.length - 1].normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (tail) counts.set(tail, (counts.get(tail) || 0) + 1);
  }
  for (const [tail, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (count < Math.max(2, (pages || []).length / 3)) break;
    const joined = tail.replace(/\s+/g, '');
    if (joined === label || (label.startsWith(joined) && /^\d*$/.test(label.slice(joined.length)))) return tail;
  }
  return null;
}

/**
 * The brand, for stripping from terms and names: stemmed single tokens (the
 * domain label, and the words of a multi-word title brand run together) and
 * stemmed phrases ("aspen dental" -> "aspen dental"), plus the raw word forms
 * a model or a reader would write ("zapier", "aspen dental").
 */
function deriveBrand(domain, pages = []) {
  const label = brandLabel(domain);
  const tokens = new Set(label ? [stemmer(label)] : []);
  const words = new Set(label ? [label] : []);
  const phrases = [];
  const phrase = titleBrandPhrase(pages, domain);
  if (phrase) {
    words.add(phrase);
    const stemmed = cleanTokens(tokenizeWords(phrase));
    if (stemmed.length === 1) tokens.add(stemmed[0]);
    else if (stemmed.length > 1) phrases.push(stemmed.join(' '));
  }
  return { tokens, phrases, words: [...words] };
}

function isBrandTerm(term, brand) {
  if (!brand) return false;
  if (term.split(' ').some((w) => brand.tokens.has(w))) return true;
  return brand.phrases.some((p) => term === p || term.includes(p));
}

// One page's raw weighted term map, before corpus-level brand/generic-term
// removal (see buildCorpusTermProfiles). `page.url` is required; every other
// field is optional and simply contributes nothing when absent.
function buildRawTermProfile(page, surface = null) {
  const fields = [
    [page.title, FIELD_WEIGHTS.title],
    [page.h1, FIELD_WEIGHTS.h1],
    [slugText(page.url), FIELD_WEIGHTS.slugTokens],
    [(page.h2s || []).join(' '), FIELD_WEIGHTS.h2h3],
    [page.metaDescription, FIELD_WEIGHTS.metaDescription],
    [page.firstParagraph, FIELD_WEIGHTS.firstParagraph],
  ];

  const profile = new Map();
  for (const [text, weight] of fields) {
    if (!text) continue;
    const tokens = cleanTokens(tokenizeWords(text), surface);
    for (const gram of ngrams(tokens, NGRAM_MAX)) {
      profile.set(gram, (profile.get(gram) || 0) + weight);
    }
  }
  return profile;
}

// Corpus-level pass: strips brand tokens and any term appearing on more than
// GENERIC_TERM_DOC_FREQUENCY of pages — a term on nearly every page (whether
// a known vertical word like "dental" or something corpus-specific the
// static list can't predict) carries no discriminating signal for clustering.
function buildCorpusTermProfiles(pages, { domain, vertical }) {
  const brand = deriveBrand(domain, pages);
  const genericTerms = new Set((VERTICAL_GENERIC_TERMS[vertical] || []).map((t) => stemmer(t)));

  const surface = new Map();
  const rawProfiles = pages.map((p) => buildRawTermProfile(p, surface));

  const docFreq = new Map();
  for (const profile of rawProfiles) {
    for (const term of profile.keys()) docFreq.set(term, (docFreq.get(term) || 0) + 1);
  }
  const n = pages.length || 1;
  for (const [term, df] of docFreq) {
    if (df / n > GENERIC_TERM_DOC_FREQUENCY) genericTerms.add(term);
  }

  // A term is dropped when any of its words is the brand, not only when the
  // whole term is: "zapier tabl" survived as a bigram and named a cluster.
  const profiles = rawProfiles.map((profile) => {
    const cleaned = new Map();
    for (const [term, weight] of profile) {
      if (isBrandTerm(term, brand) || genericTerms.has(term)) continue;
      cleaned.set(term, weight);
    }
    return cleaned;
  });
  // Carried on the array, not in each profile, so every existing reader of a
  // profile (a Map of term -> weight) is unaffected.
  profiles.surface = surface;
  profiles.brand = brand;
  return profiles;
}

module.exports = {
  buildRawTermProfile, buildCorpusTermProfiles, deriveBrandTokens, deriveBrand, brandLabel, titleBrandPhrase,
  isBrandTerm, surfaceTerm, tokenizeWords, cleanTokens,
};
