const test = require("node:test");
const assert = require("node:assert/strict");
const { pageSpeedFindings } = require("../run/pagespeed-findings");

// PageSpeed Insights results were stored on each checked page and shown as
// numbers, but never became findings: a page failing Core Web Vitals for real
// users was not an issue anywhere in the audit, its score or its export.
const H = "https://example.com";
const psi = ({ field = null, lcpMs = 1800, cls = "0.02", fieldDesktop = null } = {}) => ({
  mobile: { lcpMs, cls, field },
  desktop: { lcpMs: 900, cls: "0.01", field: fieldDesktop },
  checkedAt: "2026-09-24T10:00:00.000Z",
});
const field = (scope, metrics) => ({ scope, overall: "SLOW", metrics });
const ids = (findings) => findings.map((f) => `${f.ruleId}@${new URL(f.url).pathname}:${f.scope}`).sort();

test("real-user data for the page: each poor metric is a finding on the page", () => {
  const findings = pageSpeedFindings([
    { url: `${H}/slow`, pagespeed: psi({ field: field("page", { lcp: "SLOW", cls: "FAST", inp: "SLOW" }) }) },
    { url: `${H}/fine`, pagespeed: psi({ field: field("page", { lcp: "FAST", cls: "AVERAGE", inp: "FAST" }) }) },
  ]);
  assert.deepEqual(ids(findings), ["cwv-inp-poor@/slow:page", "cwv-lcp-poor@/slow:page"]);
  const lcp = findings.find((f) => f.ruleId === "cwv-lcp-poor");
  assert.match(lcp.detail, /real users/i);
  assert.equal(lcp.detectedValue, "Poor (real users, mobile)");
});

test("only origin-wide real-user data: one site-wide finding per poor metric", () => {
  const origin = field("origin", { lcp: "AVERAGE", cls: "SLOW" });
  const findings = pageSpeedFindings([
    { url: `${H}/a`, pagespeed: psi({ field: origin }) },
    { url: `${H}/b`, pagespeed: psi({ field: origin }) },
  ]);
  assert.deepEqual(ids(findings), ["cwv-cls-poor@/:site"]);
  assert.match(findings[0].detail, /whole site/);
});

test("no real-user data at all: the lab run decides, and says it is one simulated visit", () => {
  const findings = pageSpeedFindings([
    { url: `${H}/heavy`, pagespeed: psi({ lcpMs: 5200, cls: "0.31" }) },
    { url: `${H}/light`, pagespeed: psi({ lcpMs: 2100, cls: "0.05" }) },
    { url: `${H}/failed`, pagespeed: { mobile: { lcpMs: null, cls: "N/A", field: null }, dataUnavailable: true } },
  ]);
  assert.deepEqual(ids(findings), ["cwv-cls-poor@/heavy:page", "cwv-lcp-poor@/heavy:page"]);
  const lcp = findings.find((f) => f.ruleId === "cwv-lcp-poor");
  assert.match(lcp.detail, /simulated mobile visit/);
  assert.equal(lcp.detectedValue, "5.2 s (lab, mobile)");
});
