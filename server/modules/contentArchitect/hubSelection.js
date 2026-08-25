// ── Stage 6: hub selection ────────────────────────────────────────────────────
// Scores every page in a cluster; the LLM's hubRecommendation (Stage 5e) is
// one input to the score, never the decision itself — matches Stage 5's
// "deterministic signals decide, the LLM only names/suggests" architecture.
const { HUB_WEIGHTS, HUB_SCORE_THRESHOLD, HUB_AMBIGUOUS_MARGIN } = require('./config');
const { LOCATION_TERMS, CITY_LIST } = require('./patternClassifier');

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

function hasLocationTerm(url) {
  const segs = pathSegments(url).map((s) => s.toLowerCase());
  if (segs.some((s) => LOCATION_TERMS.some((t) => s === t || s.includes(t)))) return true;
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

  if (topEntry.score < HUB_SCORE_THRESHOLD) {
    return {
      scores, hubPageIndex: null, hubConfidence: null, isGap: true, ambiguous: false,
      gapSuggestion: buildGapSuggestion(cluster, pages),
    };
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

module.exports = { selectHub, looksLikeSpokeTitlePattern, hasLocationTerm, isLegalUtilityPage, slugTokenCount, urlDepth, breadthScore, buildGapSuggestion };
