// Regression test for D1 (P1), found by the Phase A audit of www.iana.org (2026-09-05).
// A count measured on a truncated document was published as complete.
// See .audit-runs/20260905/www.iana.org/findings.md

// Defects found by the Phase A audit of www.iana.org (2026-09-05).
// See .audit-runs/20260905/www.iana.org/findings.md — defect ids referenced below.
//
// Fixtures reproduce the CONDITION, not the artifact that carried it: D1's real
// evidence is a 14MB page, and the condition is "a body larger than the parse
// cap", which a synthesised string expresses in one line.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings } = require("../analyzer");

function baseResult(overrides = {}) {
  return {
    url: "https://example.com/page",
    scope: "Internal",
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    size: 50_000,
    depth: 1,
    title: "A perfectly fine title for this page",
    titleCount: 1,
    titleLength: 37,
    metaDescription: "A sufficiently long meta description for this fixture page.",
    metaLength: 61,
    viewport: "width=device-width, initial-scale=1",
    h1Count: 1,
    h1: "A perfectly fine heading",
    h2Count: 0,
    words: 400,
    textHtmlRatio: 0.2,
    headingHierarchyIssue: false,
    headingHierarchyIssues: [],
    indexability: "Indexable",
    canonical: "https://example.com/page",
    robots: "",
    inlinks: 2,
    fromSitemap: true,
    isAsset: false,
    bodyTruncated: false,
    openGraphMissing: [],
    openGraphInvalidUrls: [],
    openGraphImageAltMissing: false,
    openGraphDescriptionMissing: false,
    schemaTypes: [],
    schemaErrors: [],
    hreflangs: [],
    ...overrides,
  };
}

// ── D1 (P1) ────────────────────────────────────────────────────────────────
// The crawler stops reading at MAX_BODY_BYTES and records bodyTruncated on the
// RESULT. Nothing carried that onto the findings derived from it, so a count
// measured on the first 5MB of a 14.4MB document was published as though it
// were complete: 3,830 reported against 11,113 actual.
test("D1: findings derived from a truncated body are marked as partial", () => {
  const truncated = baseResult({
    url: "https://example.com/huge",
    metaDescription: "",
    metaLength: 0,
    bodyTruncated: true,
  });
  const { findings } = buildFindings({ results: [truncated], startUrl: truncated.url });

  const derived = findings.filter((f) => f.url === truncated.url);
  assert.ok(derived.length, "the fixture should produce at least one finding");
  for (const f of derived) {
    assert.equal(
      f.sourceTruncated,
      true,
      `${f.ruleId} was derived from a truncated document and must say so`,
    );
  }
});

test("D1: findings from a complete body are not marked", () => {
  const complete = baseResult({ url: "https://example.com/small", metaDescription: "", metaLength: 0 });
  const { findings } = buildFindings({ results: [complete], startUrl: complete.url });
  const derived = findings.filter((f) => f.url === complete.url);
  assert.ok(derived.length);
  for (const f of derived) {
    assert.notEqual(f.sourceTruncated, true, `${f.ruleId} came from a complete document`);
  }
});
