const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings, issueKeyOf } = require("../analyzer");
const { compareRuns, carriedReviews } = require("../run/comparison");

// A finding's id hashes its detail, and details carry counts ("Shared by 4
// pages", "72 characters"), so the same issue got a new id whenever a number in
// it moved: reviews could not follow it to the next crawl, and there was no way
// to say what was new or fixed since the last one.
const H = "https://example.com";
const page = (path, extra = {}) => ({
  url: `${H}${path}`, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: "A title that is far too long for any search result to show without cutting it off",
  titleCount: 1, titleLength: 83, metaDescription: "A description long enough to pass the meta length checks without any trouble.",
  metaLength: 90, viewport: "width=device-width", h1Count: 1, h1: `H1 ${path}`, words: 400,
  canonical: `${H}${path}`, hreflangs: [], robots: "", indexability: "Indexable", depth: 1, hash: path,
  responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [], openGraphInvalidUrls: [],
  ...extra,
});
const titleLong = (extra) =>
  buildFindings({ results: [page("/", extra)], linkEdges: [], startUrl: `${H}/`, sitemapsChecked: false })
    .findings.find((f) => f.ruleId === "title-long");

test("the issue key survives a change in the finding's detail", () => {
  const before = titleLong();
  const after = titleLong({ title: `${"B".repeat(75)}`, titleLength: 75 });
  assert.notEqual(before.detail, after.detail);
  assert.notEqual(before.id, after.id, "the per-run id still tells two details apart");
  assert.equal(before.issueKey, after.issueKey);
  assert.equal(before.issueKey, issueKeyOf("title-long", `${H}/`, ""));
  assert.notEqual(issueKeyOf("title-long", `${H}/a`, ""), before.issueKey);
});

const f = (ruleId, url, targetUrl = "", id = `${ruleId}${url}${targetUrl}`) =>
  ({ id, ruleId, url, targetUrl, issueKey: issueKeyOf(ruleId, url, targetUrl) });

test("new, fixed and persisting, per rule", () => {
  const previous = [f("title-long", "/a"), f("title-long", "/b"), f("broken-internal-links", "/a", "/gone")];
  const current = [f("title-long", "/a"), f("title-long", "/c"), f("title-long", "/c")];
  const comparison = compareRuns(current, previous);
  assert.deepEqual(comparison.totals, { new: 1, fixed: 2, persisting: 1 });
  assert.deepEqual(comparison.byRule["title-long"], { new: 1, fixed: 1, persisting: 1 });
  assert.deepEqual(comparison.byRule["broken-internal-links"], { new: 0, fixed: 1, persisting: 0 });
});

test("an older run's findings without an issue key are keyed from their fields", () => {
  const legacy = { id: "old", ruleId: "title-long", url: "/a", targetUrl: "" };
  assert.deepEqual(compareRuns([f("title-long", "/a")], [legacy]).totals, { new: 0, fixed: 0, persisting: 1 });
});

test("a false positive follows its issue to the next crawl; nothing else does", () => {
  const previous = [f("title-long", "/a", "", "p1"), f("title-long", "/b", "", "p2"), f("h1-missing", "/a", "", "p3")];
  const reviews = [
    { finding_id: "p1", rule_id: "title-long", review_status: "False positive", reviewer_notes: "Brand name, intended", reviewed_by: "u1" },
    { finding_id: "p2", rule_id: "title-long", review_status: "Resolved", reviewer_notes: "", reviewed_by: "u1" },
    { finding_id: "p3", rule_id: "h1-missing", review_status: "Confirmed issue", reviewer_notes: "", reviewed_by: "u1" },
  ];
  const current = [f("title-long", "/a", "", "c1"), f("title-long", "/b", "", "c2"), f("h1-missing", "/a", "", "c3")];
  const carried = carriedReviews(current, previous, reviews);
  assert.deepEqual(carried.map((r) => [r.findingId, r.reviewStatus, r.reviewedBy]), [["c1", "False positive", "u1"]]);
  assert.match(carried[0].reviewerNotes, /^Brand name, intended/);
  assert.match(carried[0].reviewerNotes, /carried over from the previous crawl/i);
});
