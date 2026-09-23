const test = require("node:test");
const assert = require("node:assert/strict");
const { ruleOrder } = require("../rule-order");

// The report ordered issues by severity then by page count, the workbook by
// priority then occurrences, the email by severity then count, and none of them
// asked which pages: a broken link in the global navigation ranked like one on
// a deep tag page. One ordering now serves all three, and says why.
const H = "https://example.com";
const page = (path, extra = {}) => ({
  url: `${H}${path}`, scope: "Internal", status: 200, contentType: "text/html",
  indexability: "Indexable", followInlinks: 1, clickDepth: 3, ...extra,
});
const results = [
  page("/", { followInlinks: 40, clickDepth: 0 }),
  page("/pricing", { followInlinks: 38, clickDepth: 1 }),
  ...["/tag/a", "/tag/b", "/tag/c"].map((path) => page(path, { followInlinks: 1, clickDepth: 5 })),
];
const finding = (ruleId, path, extra = {}) => ({ ruleId, severity: "warning", scope: "page", url: `${H}${path}`, ...extra });
const order = (findings) => ruleOrder(findings, results, { startUrl: `${H}/` });

test("an issue on the homepage outranks the same severity on three deep pages", () => {
  const rows = order([
    finding("meta-short", "/tag/a"), finding("meta-short", "/tag/b"), finding("meta-short", "/tag/c"),
    finding("title-long", "/"),
  ]);
  assert.deepEqual(rows.map((r) => r.ruleId), ["title-long", "meta-short"]);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].reason, "On 1 page, the homepage.");
  assert.equal(rows[1].reason, "On 3 pages.");
});

test("severity first, then site-wide problems, then the pages affected", () => {
  const rows = order([
    finding("meta-short", "/"),
    finding("hsts-missing", "/", { scope: "site" }),
    finding("page-4xx", "/tag/a", { severity: "error" }),
  ]);
  assert.deepEqual(rows.map((r) => r.ruleId), ["page-4xx", "hsts-missing", "meta-short"]);
  assert.match(rows[1].reason, /^Site-wide/);
});

test("the reason names the site's most-linked pages among those affected", () => {
  const rows = order([finding("h1-missing", "/pricing"), finding("h1-missing", "/tag/a")]);
  assert.equal(rows[0].reason, "On 2 pages, including 1 of the site's most-linked pages.");
});

test("a template-wide problem is ranked as site-wide", () => {
  const rows = order([
    finding("meta-short", "/"),
    ...["/tag/a", "/tag/b", "/tag/c", "/pricing"].map((path) => finding("viewport-missing", path, { scope: "template" })),
  ]);
  assert.equal(rows[0].ruleId, "viewport-missing");
  assert.match(rows[0].reason, /^On most pages \(4 of 5\)/);
});
