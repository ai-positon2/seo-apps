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

// "Top issues" was severity then count, blind to which pages.
test("the email's top issues follow the run's importance order, with its reason", () => {
  const { topIssues } = require("../worker/email");
  const findings = [
    { ruleId: "h1-missing", title: "Missing H1", severity: "warning" },
    { ruleId: "h1-missing", title: "Missing H1", severity: "warning" },
    { ruleId: "title-long", title: "Long title", severity: "warning" },
  ];
  assert.deepEqual(topIssues(findings).map((i) => i.title), ["Missing H1", "Long title"], "no order: severity then count");
  const ruleOrder = [
    { ruleId: "title-long", rank: 1, reason: "On 1 page, the homepage." },
    { ruleId: "h1-missing", rank: 2, reason: "On 2 pages." },
  ];
  const ordered = topIssues(findings, 8, ruleOrder);
  assert.deepEqual(ordered.map((i) => i.title), ["Long title", "Missing H1"]);
  assert.equal(ordered[0].reason, "On 1 page, the homepage.");
  const html = buildHtml({ run, counts: {}, previousCounts: null, findings, baseUrl: "", ruleOrder });
  assert.match(html, /On 1 page, the homepage\./);
});
