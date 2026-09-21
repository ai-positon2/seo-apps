// ── Stage 2: pattern grouping and classification ─────────────────────────────
// Collapses a raw URL list into path templates (never show the user 400
// URLs), classifies each TEMPLATE (not each URL), and guesses a vertical from
// slugs alone — this runs before any crawl, so titles aren't available yet;
// see Stage 3's "draft" concept for the same idea applied to clustering.
//
// Classification is two-tier, the same split used for page classification in
// server/modules/competitorAnalysis/contentAnalysis/pageClassifier.js: fast
// keyword rules decide the patterns that have a clear signal, and only the
// ones they can't (rule.confident === false) get a second look from an LLM,
// which reads the pattern's example URLs the rules already extracted. Neither
// stage is required to run alone — refineWithAI degrades to the rules' own
// guess whenever there's no API key, a batch fails, or the model's answer
// isn't one of the known categories.
const { createLlmClient } = require('../../services/llmProviders');
const SIBLING_CARDINALITY_THRESHOLD = 8;
// A value recurring at least this many times at a position is treated as its
// own literal branch, never swept into the generic {slug} bucket just
// because OTHER siblings at the same position are highly variable — e.g.
// "/blog/tag/{slug}" (10 tag pages) vs "/blog/{slug}" (20 post slugs): both
// share depth-0 "blog", and without this, "tag" (freq=10) would be counted
// as just one more distinct value among 20+ post-slug values and collapsed
// into {slug} too, destroying the "/blog/tag/*" pattern the classifier needs
// to see in order to exclude tag-archive pages.
const FREQUENT_LITERAL_MIN_COUNT = 2;
const YEAR_RE = /^(19|20)\d{2}$/;
const NUMERIC_RE = /^\d+$/;

function pathSegments(url) {
  let pathname;
  try { pathname = new URL(url).pathname; } catch { pathname = '/'; }
  return pathname.split('/').filter(Boolean);
}

// Level-by-level templating, same progressive-grouping approach as
// server/modules/competitorAnalysis/contentAnalysis/folderMapping.js, but
// typed placeholders ({n}/{slug}/{date}) instead of one generic wildcard,
// and with frequent-literal protection (see FREQUENT_LITERAL_MIN_COUNT).
function extractTemplates(urls) {
  const segsByUrl = urls.map(pathSegments);
  const maxDepth = segsByUrl.reduce((m, s) => Math.max(m, s.length), 0);
  const templPrefix = urls.map(() => '');

  for (let depth = 0; depth < maxDepth; depth++) {
    const groups = new Map();
    for (let i = 0; i < urls.length; i++) {
      if (segsByUrl[i].length <= depth) continue;
      const key = templPrefix[i];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }

    for (const idxs of groups.values()) {
      const valuesAtDepth = idxs.map((i) => segsByUrl[i][depth]);
      const distinctValues = [...new Set(valuesAtDepth)];

      // Homogeneous typed sets (all years, or all pure numbers) collapse
      // together as one dimension regardless of how often each individual
      // value recurs — a handful of year values ("2023","2024","2025") each
      // appearing often is still one {date} dimension, not three literals.
      if (distinctValues.length > 1 && distinctValues.every((v) => YEAR_RE.test(v))) {
        for (const i of idxs) templPrefix[i] += '/{date}';
        continue;
      }
      if (distinctValues.length > 1 && distinctValues.every((v) => NUMERIC_RE.test(v))) {
        for (const i of idxs) templPrefix[i] += '/{n}';
        continue;
      }

      const counts = new Map();
      for (const v of valuesAtDepth) counts.set(v, (counts.get(v) || 0) + 1);
      const rareValues = distinctValues.filter((v) => counts.get(v) < FREQUENT_LITERAL_MIN_COUNT);
      const collapseRare = rareValues.length > SIBLING_CARDINALITY_THRESHOLD;

      for (const i of idxs) {
        const v = segsByUrl[i][depth];
        const isRare = counts.get(v) < FREQUENT_LITERAL_MIN_COUNT;
        templPrefix[i] += '/' + (isRare && collapseRare ? '{slug}' : v);
      }
    }
  }

  const byTemplate = new Map(); // template -> { count, examples: [], urls: [] }
  for (let i = 0; i < urls.length; i++) {
    const t = templPrefix[i] || '/';
    if (!byTemplate.has(t)) byTemplate.set(t, { pattern: t, count: 0, examples: [], urls: [] });
    const entry = byTemplate.get(t);
    entry.count++;
    entry.urls.push(urls[i]);
    if (entry.examples.length < 3) entry.examples.push(urls[i]);
  }
  return [...byTemplate.values()].sort((a, b) => b.count - a.count);
}

// ── Classification table ─────────────────────────────────────────────────────
// Checked in this precedence order: exclude signals are the most specific
// (technical/taxonomy URLs) and win even when a content keyword is also
// present — e.g. "/blog/tag/{slug}" is excluded, not classified as article,
// despite containing "blog".
const EXCLUDE_TERMS = ['tag', 'category', 'author', 'page', 'feed', 'search', 'wp-', 'amp', 'print'];
const SERVICE_TERMS = ['service', 'services', 'treatment', 'procedure', 'solution'];
// Deliberately NOT 'find-a-' or 'store'/'stores' — both are too ambiguous for a
// blanket keyword match: "find-a-pediatrician" is a provider directory, not a
// place, and "store" also names the ecommerce vertical's product-listing pages
// (see VERTICAL_KEYWORDS.ecommerce below). Left for refineWithAI to judge from
// the actual example URLs rather than asserted here with false confidence.
const LOCATION_TERMS = ['location', 'locations', 'city', 'office', 'branch', 'dealer', 'near-me'];
const ARTICLE_TERMS = ['blog', 'articles', 'resources', 'insights', 'guides', 'learn', 'news', 'post'];
// A team/staff bio or directory — its own category rather than folding into
// "article", which is what a bare {slug} pattern with no other signal used to
// default to (see the "meet-our-dentists" example below). Structural phrases
// ('meet-our', 'our-team') catch this regardless of vertical; the role nouns
// are a fallback for sites that skip that phrasing.
const PEOPLE_TERMS = ['team', 'staff', 'our-team', 'meet-our', 'meet-the', 'leadership', 'provider', 'providers', 'doctor', 'dentist', 'physician', 'attorney'];

// A representative bundled city list — not exhaustive, but covers the common
// case of a location-page slug being a bare city name with no other signal.
const CITY_LIST = new Set([
  'boston', 'new-york', 'los-angeles', 'chicago', 'houston', 'phoenix', 'philadelphia',
  'san-antonio', 'san-diego', 'dallas', 'austin', 'san-jose', 'seattle', 'denver',
  'atlanta', 'miami', 'portland', 'las-vegas', 'nashville', 'baltimore', 'milwaukee',
  'london', 'manchester', 'birmingham', 'leeds', 'glasgow', 'liverpool', 'bristol', 'sheffield',
]);

// Same whole-word technique detectVertical (below) already uses, applied to
// the classification term lists too: a single-word term only counts against a
// whole path TOKEN (split on "/", "-", "_"), matched as a prefix so plurals
// and stems still hit ("service" -> "services"), rather than as a raw
// substring anywhere in the joined path — the latter is how "post" matched
// inside "job-post" and "city" matched inside "capacity". A term that is
// itself a hyphenated PHRASE (e.g. "meet-our") names an exact structural
// signal rather than a word, so it's still checked as a substring of the
// full pattern.
function hasTerm(pattern, terms) {
  const lower = pattern.toLowerCase();
  const tokens = lower.split(/[/_-]+/).filter(Boolean);
  return terms.some((t) => (t.includes('-') ? lower.includes(t) : tokens.some((tok) => tok.startsWith(t))));
}

// Exclude terms are CMS taxonomy/system markers (WordPress tag/category/
// author archives, pagination, feeds, AMP/print variants) that only mean
// "exclude this" when they ARE a path segment on their own — never when
// they're merely a substring inside an unrelated word. Matched by exact
// segment equality (prefix-of-segment for 'wp-', which is never a whole
// segment by itself). Plain substring matching here previously misfired on
// real content: "/blog/tag-management/{slug}" (a genuine blog category,
// structurally identical to Tealium's other /blog/{category}/{slug}
// patterns) via "tag", and a blog post slug mentioning "LiveRamp" via "amp".
function matchesExcludeTerm(pattern) {
  const segments = pattern.toLowerCase().split('/').filter(Boolean);
  return segments.some((s) => EXCLUDE_TERMS.some((t) => (t.endsWith('-') ? s.startsWith(t) : s === t)));
}

function matchesCityList(pattern) {
  const segs = pattern.toLowerCase().split('/').filter(Boolean);
  return segs.some((s) => CITY_LIST.has(s));
}

// The site's own "about us" / company section. Checked against the FIRST path
// segment only, not a substring anywhere in the pattern — a blog post titled
// "all-about-teeth-whitening" must not trip this, but "/about-us/anything"
// should, no matter what's nested under it (press releases, awards, csr,
// history, meet-the-team). Company-info pages read as news or editorial
// content surprisingly often (a press release IS "news"), which is exactly
// how "/about-us/press/{slug}" kept coming out "article": ARTICLE_TERMS and
// the hyphenated-slug fallback both judge the SLUG's wording, and press-release
// slugs read like real news. This instead judges the SECTION the pages live
// in, which is a stronger and cheaper signal than the AI having to infer
// "these don't belong in a topical content architecture" from wording alone.
// A more specific signal above (service/location/people/an explicit article
// term) still wins — "/about-us/meet-our-dentists/{slug}" is 'people', not
// this, because PEOPLE_TERMS is checked first.
const COMPANY_SECTIONS = new Set(['about', 'about-us', 'company']);
function isCompanySection(pattern) {
  const segs = pattern.toLowerCase().split('/').filter(Boolean);
  return segs.length > 0 && COMPANY_SECTIONS.has(segs[0]);
}

function hasQueryString(exampleUrls) {
  return exampleUrls.some((u) => u.includes('?'));
}

// "Slug with 3+ hyphenated words and no exclusion signal" — inspected against
// the pattern's example URLs' final segment, since the template itself is
// just "{slug}" at that point.
function hasLongHyphenatedSlug(exampleUrls) {
  return exampleUrls.some((u) => {
    const segs = pathSegments(u);
    const last = segs[segs.length - 1] || '';
    return (last.match(/-/g) || []).length >= 2; // 3+ words = 2+ hyphens
  });
}

// Returns both the verdict and whether the rules actually recognized a signal
// for it, so the caller knows which patterns are worth a second, AI opinion —
// see refineWithAI below.
function ruleVerdict(entry) {
  const { pattern, count, examples } = entry;

  if (matchesExcludeTerm(pattern) || hasQueryString(examples)) return { classification: 'exclude', confident: true };
  if (hasTerm(pattern, SERVICE_TERMS)) return { classification: 'service', confident: true };
  if (hasTerm(pattern, LOCATION_TERMS) || matchesCityList(pattern)) return { classification: 'location', confident: true };
  if (hasTerm(pattern, PEOPLE_TERMS)) return { classification: 'people', confident: true };
  if (hasTerm(pattern, ARTICLE_TERMS) || pattern.includes('{date}')) return { classification: 'article', confident: true };
  // Company-info section (about/about-us/company) with no more specific
  // signal above it — see isCompanySection. Confident and static regardless
  // of count: a whole section of the site being off-topic for the content
  // architecture is exactly as certain as a single one-off page being.
  if (isCompanySection(pattern)) return { classification: 'static', confident: true };
  // count === 1 means a literal, non-templated one-off URL — extractTemplates
  // only ever collapses a position into {slug}/{n}/{date} for a group of 2+
  // sibling values (see FREQUENT_LITERAL_MIN_COUNT and the {date}/{n} checks
  // above it), so a template this specific always has exactly one real URL
  // behind it regardless of how deep it sits ("/dental-payment-plans/pay-my-bill"
  // is exactly as one-off as "/contact"). Previously required depth <= 1,
  // which is why a billing utility page two segments deep fell through to the
  // hyphenated-slug guess below and came out "article".
  if (count === 1) return { classification: 'static', confident: true };
  // No keyword or structural signal at all — genuinely ambiguous from the URL
  // alone (a staff bio, a case study, and a blog post can all end in a
  // long hyphenated slug). hasLongHyphenatedSlug is kept only as the
  // no-AI-available default, not as a confident verdict.
  return { classification: hasLongHyphenatedSlug(examples) ? 'article' : 'unknown', confident: false };
}

function classifyPattern(entry) {
  return ruleVerdict(entry).classification;
}

const DEFAULT_INCLUDED = { article: true, exclude: false, service: false, location: false, people: false, static: false, unknown: false };

function buildPatternTable(urls) {
  const templates = extractTemplates(urls);
  return templates.map((t) => {
    const { classification, confident } = ruleVerdict(t);
    return {
      pattern: t.pattern,
      count: t.count,
      classification,
      examples: t.examples,
      included: DEFAULT_INCLUDED[classification],
      confident,
    };
  });
}

// ── AI refinement of the rule layer's unconfident guesses ────────────────────
const CLASSIFY_CATEGORIES = ['article', 'service', 'location', 'people', 'exclude', 'static', 'unknown'];
// Claude Sonnet through the shared factory, matching llmNaming.js and
// contentRelevance.js — this module's other two LLM call sites. The factory
// absorbs every transport difference this prompt would otherwise care about:
// it drops `temperature` (which Anthropic's models reject), maps max_tokens
// onto max_completion_tokens, reinforces "JSON only" in the system prompt
// because the compatible endpoint ignores response_format, and strips any
// markdown fence off the reply before it's parsed below.
const CLASSIFY_MODEL = 'claude-sonnet-5';
const CLASSIFY_BATCH_SIZE = 40;

// Every pattern this prompt is ever shown already failed the keyword rules —
// there is no rule-based "guess" worth repeating here. An earlier version of
// this prompt passed the rules' own last-resort default along as a "guess"
// and asked the model to "only override it when clearly wrong" — a billing
// page ("pay-my-bill") isn't OBVIOUSLY not an article, so the model kept
// deferring to a guess that was never actually confident. Presenting every
// pattern as a cold, undecided classification (no anchor to defer to) is what
// fixed it.
const CLASSIFY_SYSTEM_PROMPT = `You are an SEO information architect. You are given URL path patterns from one
website that a keyword-based classifier could NOT confidently categorize, each with a few real example URLs.
No page titles or content have been read yet — judge only from the URL structure and wording, especially the
final slug segment of the example URLs (that's usually where the real signal is, since the pattern itself may
just be a generic {slug}).

Categories:
- article: editorial content — blog posts, guides, resources, news.
- service: a specific service, treatment, or procedure page.
- location: a specific office, branch, dealer, or city/region page.
- people: a staff, team, provider, or leadership bio or directory.
- exclude: CMS taxonomy or system pages (tag/category archives, search, pagination, cart, login, etc.) that
  are not real content.
- static: a one-off utility or informational page (about, contact, billing, careers, home) that isn't
  editorial content and doesn't repeat as a topic.
- unknown: none of the above genuinely fits — use this only when you are truly unsure.

Pick the single best-fitting category for each pattern. Return valid JSON only:
{"patterns":[{"i": <same i>, "category": "<one of the categories>"}]}. Include every pattern you were given —
omitting one leaves it as "unknown", so only do that when "unknown" really is your answer.`;

// Named for what it gates rather than for a provider, as in llmNaming.js: this
// only decides whether the second, AI tier is attempted at all — the keyword
// rules' own verdicts stand either way.
function hasClassifyKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k !== 'your_anthropic_api_key_here';
}

let _client = null;
function client() {
  if (!_client) _client = createLlmClient(CLASSIFY_MODEL);
  return _client;
}

async function classifyBatchWithAI(batch) {
  // No "guess" field — every entry here already failed the keyword rules, so
  // there's no rule-based prior worth anchoring the model to (see the comment
  // above CLASSIFY_SYSTEM_PROMPT).
  const payload = batch.map((p, i) => ({ i, pattern: p.pattern, examples: p.examples }));
  const completion = await client().chat.completions.create({
    model: client().model,
    temperature: 0,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ patterns: payload }) },
    ],
  });
  const raw = completion.choices[0]?.message?.content || '{}';
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.patterns)) throw new Error('response missing "patterns" array');
  return parsed.patterns;
}

/**
 * Asks the model to classify the patterns the rule layer wasn't confident
 * about, mirroring the "rules decide, model resolves what's left" split in
 * server/modules/competitorAnalysis/contentAnalysis/pageClassifier.js. Never
 * blocks the caller: with no key, or when a batch's API call itself fails,
 * those patterns simply keep the rules' own last-resort guess. But once a
 * batch's call DOES succeed, its answer is authoritative — a pattern the
 * model left out, or gave an unrecognized category for, becomes "unknown"
 * rather than quietly keeping a rule-based guess that a real classification
 * attempt already had the chance to correct.
 */
async function refineWithAI(table) {
  const uncertain = table.filter((t) => !t.confident);
  if (!hasClassifyKey() || !uncertain.length) return table.map(({ confident, ...rest }) => rest);

  const byPattern = new Map(table.map((t) => [t.pattern, t]));
  for (let i = 0; i < uncertain.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = uncertain.slice(i, i + CLASSIFY_BATCH_SIZE);
    try {
      // eslint-disable-next-line no-await-in-loop
      const results = await classifyBatchWithAI(batch);
      const answered = new Set();
      for (const r of results) {
        const source = batch[r.i];
        if (!source) continue; // model invented an index — ignore
        const entry = byPattern.get(source.pattern);
        if (entry && CLASSIFY_CATEGORIES.includes(r.category)) {
          entry.classification = r.category;
          entry.included = DEFAULT_INCLUDED[r.category];
          answered.add(source.pattern);
        }
      }
      // The model got a real, well-formed reply — trust it over the rules'
      // own last-resort guess even for a pattern it left out or gave an
      // unrecognized category for. This is the fix for the exact failure
      // mode that motivated dropping the "guess" field above: a weak
      // rule-based default (e.g. "pay-my-bill" -> article) must never stand
      // labeled as-is once a real classification attempt has run over it —
      // "unknown" is an honest answer where the old guess was not.
      for (const p of batch) {
        if (answered.has(p.pattern)) continue;
        const entry = byPattern.get(p.pattern);
        if (entry) { entry.classification = 'unknown'; entry.included = false; }
      }
    } catch (err) {
      console.error('[content-architect] AI pattern classification batch failed, keeping rule-based guesses:', err.message);
    }
  }
  return table.map(({ confident, ...rest }) => rest);
}

// ── Vertical detection (slug-only first pass — no titles yet at this stage) ──
const VERTICAL_KEYWORDS = {
  dental: ['dental', 'dentist', 'teeth', 'tooth', 'orthodont', 'invisalign', 'braces', 'oral'],
  healthcare: ['health', 'medical', 'clinic', 'doctor', 'physician', 'patient', 'therapy', 'wellness'],
  legal: ['law', 'lawyer', 'attorney', 'legal', 'injury', 'litigation', 'firm'],
  saas: ['software', 'platform', 'api', 'integration', 'dashboard', 'saas', 'pricing', 'features'],
  ecommerce: ['shop', 'product', 'products', 'cart', 'checkout', 'store', 'collections'],
  'home-services': ['plumbing', 'hvac', 'roofing', 'electrician', 'contractor', 'remodel', 'landscap', 'pest'],
};
const VERTICAL_MIN_MATCHES = 3;

// Tokenizes to individual path words (splitting on "/", "-", "_") so terms
// match as a whole word or a stem-prefix of one ("orthodont" -> "orthodontics")
// rather than as a substring anywhere in the joined path — the latter matched
// "firm" (legal) inside "confirmation" and inflated a diabetes-device site's
// count past unrelated healthcare signals.
function detectVertical(urls) {
  const allTokens = urls.flatMap((u) => {
    try { return new URL(u).pathname.toLowerCase().split(/[/_-]+/).filter(Boolean); } catch { return []; }
  });
  let best = 'other';
  let bestCount = VERTICAL_MIN_MATCHES - 1;
  for (const [vertical, terms] of Object.entries(VERTICAL_KEYWORDS)) {
    const count = allTokens.reduce((sum, tok) => sum + (terms.some((t) => tok.startsWith(t)) ? 1 : 0), 0);
    if (count > bestCount) { best = vertical; bestCount = count; }
  }
  return best;
}

module.exports = {
  extractTemplates, buildPatternTable, classifyPattern, refineWithAI, detectVertical, LOCATION_TERMS, CITY_LIST,
};
