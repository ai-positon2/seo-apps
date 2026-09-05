// Regression test for D5 (P3), found by the Phase A audit of www.iana.org (2026-09-05).
// Findings fired 484 times with an empty detail and detectedValue.
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

// ── D5 (P3) ────────────────────────────────────────────────────────────────
// meta-missing fired 484 times on iana.org with detail:"" and detectedValue:"".
test("D5: meta-missing carries an observed value", () => {
  const noMeta = baseResult({ metaDescription: "", metaLength: 0 });
  const { findings } = buildFindings({ results: [noMeta], startUrl: noMeta.url });
  const f = findings.find((x) => x.ruleId === "meta-missing");
  assert.ok(f, "meta-missing should fire when there is no description");
  assert.ok(
    (f.detail || "").trim() || (f.detectedValue || "").trim(),
    "an issue record with no observed value gives a developer nothing to locate",
  );
});
