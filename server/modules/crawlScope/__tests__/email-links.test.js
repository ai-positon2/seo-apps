const test = require("node:test");
const assert = require("node:assert/strict");
const { buildHtml, buildFailureHtml } = require("../worker/email");

// The emailed "Open full report" link pointed at /?run=<id>, which nothing in
// the React app reads: it opened the home page. A run's report lives at
// /crawl-scope/runs/:id (client/src/App.jsx).
const run = { id: "run 42", url: "https://example.com/", finished_at: "2026-09-23" };

test("the report email links to the run's report page", () => {
  const html = buildHtml({ run, counts: {}, previousCounts: null, findings: [], baseUrl: "https://app.example.com/" });
  assert.match(html, /href="https:\/\/app\.example\.com\/crawl-scope\/runs\/run%2042"/);
  assert.doesNotMatch(html, /\?run=/);
});

test("the failure email links to the same page", () => {
  const html = buildFailureHtml({ run, projectName: "Example", message: "timeout", baseUrl: "https://app.example.com" });
  assert.match(html, /href="https:\/\/app\.example\.com\/crawl-scope\/runs\/run%2042"/);
});

test("no base URL, no link", () => {
  const html = buildHtml({ run, counts: {}, previousCounts: null, findings: [], baseUrl: "" });
  assert.doesNotMatch(html, /Open full report/);
});

// The email compared severity totals with the last crawl and nothing else:
// "Errors 40 (no change)" when 12 were fixed and 12 others appeared.
test("the report email says what is new and what was fixed since the last crawl", () => {
  const html = buildHtml({
    run, counts: {}, previousCounts: null, findings: [], baseUrl: "",
    comparison: { totals: { new: 12, fixed: 30, persisting: 140 } },
  });
  assert.match(html, /Since the last crawl: 12 new issues, 30 fixed, 140 still open\./);
  const none = buildHtml({ run, counts: {}, previousCounts: null, findings: [], baseUrl: "" });
  assert.doesNotMatch(none, /Since the last crawl/);
});
