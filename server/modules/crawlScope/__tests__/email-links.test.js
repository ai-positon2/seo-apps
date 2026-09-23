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
