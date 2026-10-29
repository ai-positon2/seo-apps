// ── Stage 6: hub selection ────────────────────────────────────────────────────
// Scores every page in a cluster; the LLM's hubRecommendation (Stage 5e) is
// one input to the score, never the decision itself — matches Stage 5's
// "deterministic signals decide, the LLM only names/suggests" architecture.
const {
  HUB_WEIGHTS, HUB_SCORE_THRESHOLD, HUB_AMBIGUOUS_MARGIN, HUB_PROMOTION_CORE_SHARE, HUB_PROMOTION_MIN_WORDS,
} = require('./config');
const { CITY_LIST } = require('./patternClassifier');

const SPOKE_TITLE_PATTERNS = [
  /\bvs\.?\b/i,
  /\?/,
  /^how to\b/i,
  /^\d+\s+(ways|reasons|tips|things|best|signs|facts|steps)\b/i,
  /\b(19|20)\d{2}\b/,
];

function pathSegments(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean); } catch { return []; }
}

function looksLikeSpokeTitlePattern(title) {
  if (!title) return false;
  return SPOKE_TITLE_PATTERNS.some((re) => re.test(title));
}

// Whether a URL looks like a location page. Matched as whole hyphen-separated
// words, and only in a folder or a short segment ("/locations/", "/offices/",
// "austin-office", "dentist-near-me"): matching substrings penalised
// "chief-marketing-officers" (office), "link-velocity" (city) and
// "car-dealerships" (dealer), and a whole-word match inside a long article slug
// still penalised "emergency-room-vs-dental-office". "multi-location" names a
// topic, not a place — one agency's multi-location marketing cluster lost its
// hub to that.
const LOCATION_WORDS = new Set(['location', 'locations', 'city', 'cities', 'office', 'offices', 'branch', 'branches', 'dealer', 'dealers']);
const LOCATION_SLUG_MAX_WORDS = 3;
function hasLocationTerm(url) {
  const segs = pathSegments(url).map((s) => s.toLowerCase());
  for (const seg of segs) {
    const words = seg.split(/[-_]/).filter(Boolean);
    if (words.join('-').includes('near-me')) return true;
    if (words.length > LOCATION_SLUG_MAX_WORDS) continue;
    if (words.some((w, i) => LOCATION_WORDS.has(w) && words[i - 1] !== 'multi')) return true;
  }
  return segs.some((s) => CITY_LIST.has(s));
}

const LEGAL_UTILITY_TERMS = ['terms-of-use', 'terms-of-service', 'terms-and-conditions', 'privacy-policy', 'privacy', 'cookie-policy', 'cookies', 'accessibility', 'disclaimer', 'legal', 'sitemap'];

function isLegalUtilityPage(url) {
  const segs = pathSegments(url).map((s) => s.toLowerCase());
  return segs.some((s) => LEGAL_UTILITY_TERMS.includes(s));
}

function slugTokenCount(url) {
  const segs = pathSegments(url);
  const last = segs[segs.length - 1] || '';
  return last.split('-').filter(Boolean).length || 1;
}

function urlDepth(url) {
  return pathSegments(url).length;
}

// Inverted min-max: lower raw value -> higher score. Flat (all-equal) inputs
// score 1 for everyone rather than dividing by zero.
function invertedNormalize(value, allValues) {
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  if (max === min) return 1;
  return (max - value) / (max - min);
}

function normalize(value, allValues) {
  const max = Math.max(...allValues);
  return max === 0 ? 0 : value / max;
}

// Proportion of the cluster's aggregate term vocabulary that this one page's
// own term set covers — a real pillar touches more of the cluster's overall
// subtopic space than a narrow spoke does.
function breadthScore(pageIndex, memberIndices, profiles) {
  const aggregate = new Set();
  for (const i of memberIndices) for (const term of profiles[i].keys()) aggregate.add(term);
  if (aggregate.size === 0) return 0;
  const own = new Set(profiles[pageIndex].keys());
  let overlap = 0;
  for (const term of own) if (aggregate.has(term)) overlap++;
  return overlap / aggregate.size;
}

function inboundWithinCluster(pageIndex, memberIndices, graph) {
  let count = 0;
  const memberSet = new Set(memberIndices);
  for (const other of memberIndices) {
    if (other === pageIndex) continue;
    if (graph[other]?.has(pageIndex) && memberSet.has(other)) count++;
  }
  return count;
}

// Scores every page in one cluster and picks a hub per the spec's 3-outcome
// rule. Returns { scores: Map<pageIndex, {score, breakdown}>, hubPageIndex,
// hubConfidence, isGap, gapSuggestion, ambiguous }.
function selectHub(cluster, pages, profiles, graph, llmHubUrl) {
  const { memberIndices } = cluster;
  const w = HUB_WEIGHTS;

  const wordCounts = memberIndices.map((i) => pages[i].wordCount || 0);
  const inboundCounts = memberIndices.map((i) => inboundWithinCluster(i, memberIndices, graph));
  const depths = memberIndices.map((i) => urlDepth(pages[i].url));
  const specificities = memberIndices.map((i) => slugTokenCount(pages[i].url));

  // Inbound-within-cluster is 0 for every candidate whenever the cluster's
  // pages simply don't link to each other yet (common — that's often
  // exactly the gap this tool exists to find). Scoring everyone 0 on that
  // factor isn't "these candidates are weak", it's "this signal has nothing
  // to say here" — left as a flat 0.25 contribution, it silently caps the
  // whole cluster's max possible score and pushed real candidates (breadth,
  // word count, depth, specificity all strong) just under HUB_SCORE_THRESHOLD
  // in testing. When that happens, redistribute its weight proportionally
  // across the other positive factors instead of applying a dead weight.
  const inboundSignalAvailable = Math.max(...inboundCounts, 0) > 0;
  const positiveWeightKeys = ['breadth', 'inboundWithinCluster', 'wordCount', 'urlDepth', 'slugSpecificity', 'llmAgreement'];
  const effectiveWeights = { ...w };
  if (!inboundSignalAvailable) {
    const remaining = positiveWeightKeys.filter((k) => k !== 'inboundWithinCluster');
    const remainingTotal = remaining.reduce((s, k) => s + w[k], 0);
    const scaleFactor = remainingTotal > 0 ? (remainingTotal + w.inboundWithinCluster) / remainingTotal : 1;
    for (const k of remaining) effectiveWeights[k] = w[k] * scaleFactor;
    effectiveWeights.inboundWithinCluster = 0;
  }

  const scores = new Map();
  memberIndices.forEach((pageIndex, k) => {
    const breadth = breadthScore(pageIndex, memberIndices, profiles);
    const inboundNorm = normalize(inboundCounts[k], inboundCounts);
    const wordCountNorm = normalize(wordCounts[k], wordCounts);
    const depthScore = invertedNormalize(depths[k], depths);
    const specificityScore = invertedNormalize(specificities[k], specificities);
    const llmAgrees = llmHubUrl && pages[pageIndex].url === llmHubUrl ? 1 : 0;
    const titlePenalty = looksLikeSpokeTitlePattern(pages[pageIndex].title) ? 1 : 0;
    const locationPenalty = hasLocationTerm(pages[pageIndex].url) ? 1 : 0;
    const legalUtilityPenalty = isLegalUtilityPage(pages[pageIndex].url) ? 1 : 0;

    const score = effectiveWeights.breadth * breadth
      + effectiveWeights.inboundWithinCluster * inboundNorm
      + effectiveWeights.wordCount * wordCountNorm
      + effectiveWeights.urlDepth * depthScore
      + effectiveWeights.slugSpecificity * specificityScore
      + effectiveWeights.llmAgreement * llmAgrees
      + w.titlePatternPenalty * titlePenalty
      + w.locationTermPenalty * locationPenalty
      + w.legalUtilityPenalty * legalUtilityPenalty;

    scores.set(pageIndex, {
      score,
      breakdown: { breadth, inboundNorm, wordCountNorm, depthScore, specificityScore, llmAgrees, titlePenalty, locationPenalty, legalUtilityPenalty, inboundSignalAvailable },
    });
  });

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const [topIdx, topEntry] = ranked[0];
  const second = ranked[1];

  const suggested = (promoted) => ({
    scores,
    hubPageIndex: promoted.pageIndex,
    hubConfidence: 'suggested',
    isGap: false,
    ambiguous: false,
    gapSuggestion: null,
    hubSuggestion: { reason: promoted.reason, coreTerms: promoted.coreTerms },
  });

  if (topEntry.score < HUB_SCORE_THRESHOLD) {
    // Not a gap yet: a page that already names the cluster's whole topic is a
    // better hub than a new page that would overlap it.
    const promoted = promotableHub(memberIndices, pages, scores, llmHubUrl);
    if (promoted) return suggested(promoted);
    return {
      scores, hubPageIndex: null, hubConfidence: null, isGap: true, ambiguous: false,
      gapSuggestion: buildGapSuggestion(cluster, pages),
    };
  }

  // The top score can go to a page about one angle of the topic ("Wisdom Tooth
  // Removal Cost") while the page about the whole of it ("Wisdom Teeth Removal:
  // A Complete Guide") sits in the cluster as a spoke. The broad page wins.
  // Only when the pick is that same topic plus an angle (its slug holds every
  // word of the broad page's, and more), or a location page: two pages on
  // different angles are not swapped just because one has fewer words.
  const broad = promotableHub(memberIndices, pages, scores, llmHubUrl, { replacing: topIdx });
  if (broad && broad.pageIndex !== topIdx && !broad.eligible.includes(topIdx)) {
    const pickWords = new Set(slugWords(pages[topIdx].url));
    const narrowerOfSame = slugWords(pages[broad.pageIndex].url).every((w) => pickWords.has(w));
    if (narrowerOfSame || topEntry.breakdown.locationPenalty) return suggested(broad);
  }

  const margin = second ? (topEntry.score - second[1].score) / Math.max(Math.abs(topEntry.score), 1e-6) : 1;
  const ambiguous = second && margin < HUB_AMBIGUOUS_MARGIN;

  return {
    scores,
    hubPageIndex: topIdx,
    hubConfidence: ambiguous ? 'ambiguous' : 'high',
    isGap: false,
    ambiguous,
    gapSuggestion: null,
  };
}

// ── An existing page instead of a gap ────────────────────────────────────────
//
// The weighted score can leave every page just under HUB_SCORE_THRESHOLD in a
// cluster whose broad page plainly exists: breadth is an absolute share of the
// cluster's whole vocabulary, so it is low for every page in a varied cluster.
// "Teeth Whitening: What You Need to Know" sat under the bar while seven
// narrower whitening articles surrounded it, and the cluster was reported as
// needing a new "Whitening & Teeth" page that would only overlap it.
//
// So before calling a gap, look for a page whose URL is made of the cluster's
// core words and nothing narrower: the words most of the cluster's slugs share
// ("teeth", "whitening"), with no angle of its own ("cost", "insurance",
// "safe"). It must not read as a spoke (a question, "how to", "vs", a year), be
// a location or legal page, or be thin. The model's own hub pick wins when it
// qualifies; otherwise the broadest such page does.

const SLUG_STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'your', 'you', 'is', 'are', 'do', 'does', 'how', 'what', 'why', 'when', 'can', 'it', 'its', 'my', 'vs', 'guide', 'overview']);

// "implants" and "implant" are one word to a reader: a plain plural is folded
// so a slug's singular does not hide it from the cluster's core. "Teeth" and
// "tooth" are the irregular one a dental site uses constantly.
const IRREGULAR_PLURALS = { teeth: 'tooth', feet: 'foot', children: 'child', women: 'woman', men: 'man' };
const singular = (w) => IRREGULAR_PLURALS[w]
  || (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

const DEFINITION_TITLE = /^what (is|are) (a |an |the )?[^?]+\?/i;

function rawSlugWords(url) {
  const segs = pathSegments(url);
  const last = (segs[segs.length - 1] || '').toLowerCase();
  return last.split(/[-_]/).filter((w) => w && !SLUG_STOPWORDS.has(w) && !/^\d+$/.test(w));
}

function slugWords(url) {
  return [...new Set(rawSlugWords(url).map(singular))];
}

// `replacing` is the page the score picked, when the broad page would take its
// place rather than fill a gap; it changes only the reason's wording.
function promotableHub(memberIndices, pages, scores, llmHubUrl, { replacing } = {}) {
  if (memberIndices.length < 3) return null;
  const wordsByPage = new Map(memberIndices.map((i) => [i, slugWords(pages[i].url)]));

  // The cluster's core words: carried by most of its slugs.
  const freq = new Map();
  for (const words of wordsByPage.values()) for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const core = new Set([...freq.entries()]
    .filter(([, n]) => n / memberIndices.length >= HUB_PROMOTION_CORE_SHARE)
    .map(([w]) => w));
  if (!core.size) return null;

  const eligible = memberIndices.filter((i) => {
    const words = wordsByPage.get(i);
    const b = scores.get(i)?.breakdown || {};
    // "What Is a Root Canal?" is a question, but on the page whose slug is the
    // topic itself it defines the whole topic — the hub's job, not a spoke's.
    const spokeTitle = b.titlePenalty && !DEFINITION_TITLE.test(pages[i].title || '');
    return words.length > 0
      && words.every((w) => core.has(w))
      && words.length >= Math.min(2, core.size)
      && !spokeTitle && !b.locationPenalty && !b.legalUtilityPenalty
      && (pages[i].wordCount || 0) >= HUB_PROMOTION_MIN_WORDS;
  });
  if (!eligible.length) return null;

  const llmPick = llmHubUrl ? eligible.find((i) => pages[i].url === llmHubUrl) : undefined;
  const best = llmPick ?? eligible.sort((a, b) => (
    wordsByPage.get(b).length - wordsByPage.get(a).length          // names more of the core
    || (scores.get(b)?.score || 0) - (scores.get(a)?.score || 0)    // then the stronger page
  ))[0];

  // The page's own words, so "wisdom teeth removal" is not shown as "tooth".
  const topic = rawSlugWords(pages[best].url).join(' ');
  const others = memberIndices.length - 1;
  const narrower = replacing !== undefined && replacing !== best ? pages[replacing] : null;
  return {
    pageIndex: best,
    eligible,
    coreTerms: [...core],
    reason: `Already covers the whole topic (“${topic}”) that the other ${others} pages each cover one angle of`
      + (llmPick !== undefined ? ', and the topic analysis picked it as the hub too' : '')
      + (narrower
        ? `. Make it the hub instead of “${(narrower.title || narrower.url).split(' | ')[0]}”, which covers only one part of the topic.`
        : '. Make it the hub rather than creating a new page that would overlap it.'),
  };
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Deduplicated (case-insensitive) H2s across the cluster's members, in order
// of first appearance — the outline for a page that doesn't exist yet.
function buildGapSuggestion(cluster, pages) {
  const seen = new Set();
  const outline = [];
  for (const i of cluster.memberIndices) {
    for (const h2 of pages[i].h2s || []) {
      const key = h2.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      outline.push(h2.trim());
      if (outline.length >= 15) break;
    }
    if (outline.length >= 15) break;
  }
  return { title: cluster.name, slug: `/${slugify(cluster.name)}/`, outline };
}

module.exports = { selectHub, promotableHub, slugWords, looksLikeSpokeTitlePattern, hasLocationTerm, isLegalUtilityPage, slugTokenCount, urlDepth, breadthScore, buildGapSuggestion };
