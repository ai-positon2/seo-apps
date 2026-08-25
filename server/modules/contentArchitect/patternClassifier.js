// ── Stage 2: pattern grouping and classification ─────────────────────────────
// Collapses a raw URL list into path templates (never show the user 400
// URLs), classifies each TEMPLATE (not each URL), and guesses a vertical from
// slugs alone — this runs before any crawl, so titles aren't available yet;
// see Stage 3's "draft" concept for the same idea applied to clustering.
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
const LOCATION_TERMS = ['location', 'locations', 'city', 'office', 'branch'];
const ARTICLE_TERMS = ['blog', 'articles', 'resources', 'insights', 'guides', 'learn', 'news', 'post'];

// A representative bundled city list — not exhaustive, but covers the common
// case of a location-page slug being a bare city name with no other signal.
const CITY_LIST = new Set([
  'boston', 'new-york', 'los-angeles', 'chicago', 'houston', 'phoenix', 'philadelphia',
  'san-antonio', 'san-diego', 'dallas', 'austin', 'san-jose', 'seattle', 'denver',
  'atlanta', 'miami', 'portland', 'las-vegas', 'nashville', 'baltimore', 'milwaukee',
  'london', 'manchester', 'birmingham', 'leeds', 'glasgow', 'liverpool', 'bristol', 'sheffield',
]);

function hasTerm(pattern, terms) {
  const lower = pattern.toLowerCase();
  return terms.some((t) => lower.includes(t));
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

function classifyPattern(entry) {
  const { pattern, count, examples } = entry;
  const depth = pattern.split('/').filter(Boolean).length;

  if (matchesExcludeTerm(pattern) || hasQueryString(examples)) return 'exclude';
  if (hasTerm(pattern, SERVICE_TERMS)) return 'service';
  if (hasTerm(pattern, LOCATION_TERMS) || matchesCityList(pattern)) return 'location';
  if (hasTerm(pattern, ARTICLE_TERMS) || pattern.includes('{date}')) return 'article';
  if (count === 1 && depth <= 1) return 'static';
  if (hasLongHyphenatedSlug(examples)) return 'article';
  return 'unknown';
}

const DEFAULT_INCLUDED = { article: true, exclude: false, service: false, location: false, static: false, unknown: false };

function buildPatternTable(urls) {
  const templates = extractTemplates(urls);
  return templates.map((t) => {
    const classification = classifyPattern(t);
    return {
      pattern: t.pattern,
      count: t.count,
      classification,
      examples: t.examples,
      included: DEFAULT_INCLUDED[classification],
    };
  });
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

module.exports = { extractTemplates, buildPatternTable, classifyPattern, detectVertical, LOCATION_TERMS, CITY_LIST };
