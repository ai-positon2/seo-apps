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

function cleanTokens(words) {
  return words.filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w)).map((w) => stemmer(w));
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

// "gentledental.com" / "www.gentledental.com" -> "gentledental". Slug-only
// mode has no <title> tail to compare variants against (that half of brand
// detection is a Stage 4/Checkpoint-4 concern, once crawled titles exist).
function deriveBrandTokens(domain) {
  const host = String(domain || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  const sld = host.split('.')[0];
  return sld ? new Set([stemmer(sld)]) : new Set();
}

// One page's raw weighted term map, before corpus-level brand/generic-term
// removal (see buildCorpusTermProfiles). `page.url` is required; every other
// field is optional and simply contributes nothing when absent.
function buildRawTermProfile(page) {
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
    const tokens = cleanTokens(tokenizeWords(text));
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
  const brandTokens = deriveBrandTokens(domain);
  const genericTerms = new Set((VERTICAL_GENERIC_TERMS[vertical] || []).map((t) => stemmer(t)));

  const rawProfiles = pages.map((p) => buildRawTermProfile(p));

  const docFreq = new Map();
  for (const profile of rawProfiles) {
    for (const term of profile.keys()) docFreq.set(term, (docFreq.get(term) || 0) + 1);
  }
  const n = pages.length || 1;
  for (const [term, df] of docFreq) {
    if (df / n > GENERIC_TERM_DOC_FREQUENCY) genericTerms.add(term);
  }

  return rawProfiles.map((profile) => {
    const cleaned = new Map();
    for (const [term, weight] of profile) {
      if (brandTokens.has(term) || genericTerms.has(term)) continue;
      cleaned.set(term, weight);
    }
    return cleaned;
  });
}

module.exports = { buildRawTermProfile, buildCorpusTermProfiles, deriveBrandTokens, tokenizeWords };
