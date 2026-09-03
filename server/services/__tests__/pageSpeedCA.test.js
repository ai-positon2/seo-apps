const test = require("node:test");
const assert = require("node:assert/strict");
const { ttfbShareOf, extractFieldData } = require("../pageSpeedCA");

// ── ttfbShareOf ─────────────────────────────────────────────────────────
test("ttfbShareOf: computes TTFB as a share of LCP, rounded to two decimals", () => {
  assert.equal(ttfbShareOf(600, 1000), 0.6);
  assert.equal(ttfbShareOf(333, 1000), 0.33);
});

test("ttfbShareOf: null when either input is missing or LCP is non-positive", () => {
  assert.equal(ttfbShareOf(null, 1000), null);
  assert.equal(ttfbShareOf(600, null), null);
  assert.equal(ttfbShareOf(600, 0), null);
  assert.equal(ttfbShareOf(undefined, undefined), null);
});

// ── extractFieldData ────────────────────────────────────────────────────
function fieldExperience(overallCategory, metrics) {
  return {
    overall_category: overallCategory,
    metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, { category: v }])),
  };
}

test("extractFieldData: prefers page-level field data when present", () => {
  const page = fieldExperience("FAST", { LARGEST_CONTENTFUL_PAINT_MS: "FAST", CUMULATIVE_LAYOUT_SHIFT_SCORE: "FAST" });
  const origin = fieldExperience("SLOW", { LARGEST_CONTENTFUL_PAINT_MS: "SLOW" });
  const result = extractFieldData(page, origin);
  assert.equal(result.scope, "page");
  assert.equal(result.overall, "FAST");
  assert.equal(result.metrics.lcp, "FAST");
  assert.equal(result.metrics.cls, "FAST");
});

test("extractFieldData: falls back to origin-level data when the page has none", () => {
  const origin = fieldExperience("AVERAGE", { LARGEST_CONTENTFUL_PAINT_MS: "AVERAGE" });
  const result = extractFieldData(undefined, origin);
  assert.equal(result.scope, "origin");
  assert.equal(result.overall, "AVERAGE");
  assert.equal(result.metrics.lcp, "AVERAGE");
});

test("extractFieldData: null when neither page nor origin has field data (e.g. low-traffic site)", () => {
  assert.equal(extractFieldData(undefined, undefined), null);
  assert.equal(extractFieldData({}, {}), null);
});

test("extractFieldData: only includes metrics CrUX actually reported", () => {
  const page = fieldExperience("AVERAGE", { LARGEST_CONTENTFUL_PAINT_MS: "AVERAGE" });
  const result = extractFieldData(page, null);
  assert.deepEqual(Object.keys(result.metrics), ["lcp"]);
});
