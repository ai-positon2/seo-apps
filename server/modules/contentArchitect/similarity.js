// ── Stage 5b/5c: similarity matrix + link-graph boost ────────────────────────
const { LINK_BOOST_SINGLE, LINK_BOOST_RECIPROCAL, LINK_BOOST_CAP } = require('./config');

// IDF over the corpus's cleaned vocabulary: log(N / df). A term on every page
// (df === N) scores 0 and contributes nothing to any vector — correct, since
// it can't discriminate between pages. Do not smooth/override this (spec).
function computeIdf(profiles) {
  const df = new Map();
  for (const profile of profiles) {
    for (const term of profile.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const n = profiles.length;
  const idf = new Map();
  for (const [term, count] of df) idf.set(term, Math.log(n / count));
  return idf;
}

function toTfIdfVector(profile, idf) {
  const vec = new Map();
  for (const [term, weight] of profile) {
    const w = weight * (idf.get(term) || 0);
    if (w > 0) vec.set(term, w);
  }
  return vec;
}

function cosineSimilarity(vecA, vecB) {
  const [small, large] = vecA.size <= vecB.size ? [vecA, vecB] : [vecB, vecA];
  let dot = 0;
  for (const [term, w] of small) {
    const wOther = large.get(term);
    if (wOther) dot += w * wOther;
  }
  if (dot === 0) return 0;
  let magA = 0;
  for (const w of vecA.values()) magA += w * w;
  let magB = 0;
  for (const w of vecB.values()) magB += w * w;
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// Builds the full symmetric N×N similarity matrix (values in [0,1], diagonal
// forced to 1). O(n²) pairs — fine at the page counts this tool operates at
// (a few thousand); the O(n²)/O(n² log n) cost lives in clustering, not here.
function buildSimilarityMatrix(profiles) {
  const idf = computeIdf(profiles);
  const vectors = profiles.map((p) => toTfIdfVector(p, idf));
  const n = vectors.length;
  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      matrix[i][j] = sim;
      matrix[j][i] = sim;
    }
  }
  return matrix;
}

// Stage 5c — pages that already link to each other are already topically
// related. `linkGraph` is an Array<Set<pageIndex>> of outbound links (index
// = page index, matching linkGraph.js's buildLinkGraphAndDepths output);
// undefined/empty until Stage 4 (crawl) exists, in which case this is a
// no-op and Stage 3's draft clustering runs on plain content similarity.
// Mutates nothing — returns a new matrix, named constants live in config.js.
function applyLinkBoost(matrix, linkGraph) {
  if (!linkGraph || linkGraph.length === 0) return matrix;
  const n = matrix.length;
  const boosted = matrix.map((row) => Float64Array.from(row));
  for (let i = 0; i < n; i++) {
    const outFromI = linkGraph[i];
    if (!outFromI) continue;
    for (const j of outFromI) {
      if (j === i || j >= n) continue;
      const reciprocal = linkGraph[j]?.has(i);
      const boost = reciprocal ? LINK_BOOST_RECIPROCAL : LINK_BOOST_SINGLE;
      const value = Math.min(LINK_BOOST_CAP, boosted[i][j] + boost);
      boosted[i][j] = value;
      boosted[j][i] = value;
    }
  }
  return boosted;
}

module.exports = { computeIdf, toTfIdfVector, cosineSimilarity, buildSimilarityMatrix, applyLinkBoost };
