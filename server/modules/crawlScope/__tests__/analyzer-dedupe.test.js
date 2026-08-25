// Guards the finding-dedupe complexity in buildFindings.
//
// The dedupe used to be `findings.some(item => item.id === id)` on every add, i.e. O(n²).
// Measured on this machine: 5k findings 44ms, 25k 680ms, 50k 3582ms — versus ~11ms with a
// Set. That cost lands on the worker's event loop at the end of every large crawl.
//
// The budget below is deliberately generous rather than tight: it passes with room to
// spare using a Set and fails by a wide margin with a linear scan, so it catches a
// regression without being sensitive to how loaded the machine is.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings } = require("../analyzer");

function page(index) {
  return {
    url: `https://example.com/page-${index}`,
    status: 200,
    contentType: "text/html",
    scope: "Internal",
    indexability: "Indexable",
    depth: 1,
    inlinks: 2,
    title: "",
    titleLength: 0,
    titleCount: 1,
    metaDescription: "",
    metaLength: 0,
    h1: "",
    h1Count: 0,
    h2: "",
    h2Count: 0,
    words: 10,
    textHtmlRatio: 0.5,
    viewport: "width=device-width, initial-scale=1",
    responseTime: 100,
    canonical: `https://example.com/page-${index}`,
    robots: "",
    hreflangs: [],
    schemaErrors: [],
    openGraphMissing: [],
    openGraphInvalidUrls: [],
    headingHierarchyIssues: [],
  };
}

test("buildFindings stays fast as the finding count grows", () => {
  // Each page trips several per-page rules (missing title/meta/H1), so this produces
  // roughly 10k+ findings — well into the range where an O(n²) dedupe is seconds slow.
  const results = Array.from({ length: 3_000 }, (_, index) => page(index));

  const startedAt = Date.now();
  const { findings } = buildFindings({
    results,
    startUrl: "https://example.com/",
    sitemapsChecked: false,
    crawlTruncated: true,
  });
  const elapsed = Date.now() - startedAt;

  assert.ok(findings.length > 5_000, `expected a large finding set, got ${findings.length}`);
  assert.ok(elapsed < 4_000, `buildFindings took ${elapsed}ms for ${findings.length} findings`);
});

test("identical findings are still deduped to one entry", () => {
  // The Set must preserve the original behaviour: one finding per (rule, url, target,
  // detail), even when the same page appears twice in the result set.
  const duplicated = [page(1), page(1)];
  const { findings } = buildFindings({
    results: duplicated,
    startUrl: "https://example.com/",
    sitemapsChecked: false,
    crawlTruncated: true,
  });

  const ids = findings.map((finding) => finding.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate finding ids");

  const missingH1 = findings.filter(
    (finding) => finding.ruleId === "h1-missing" && finding.url === "https://example.com/page-1",
  );
  assert.equal(missingH1.length, 1, "the same rule on the same URL yields one finding");
});

test("distinct pages each keep their own finding", () => {
  const { findings } = buildFindings({
    results: [page(1), page(2), page(3)],
    startUrl: "https://example.com/",
    sitemapsChecked: false,
    crawlTruncated: true,
  });

  const missingH1 = findings.filter((finding) => finding.ruleId === "h1-missing");
  assert.equal(missingH1.length, 3);
  assert.deepEqual(
    missingH1.map((finding) => finding.url).sort(),
    [
      "https://example.com/page-1",
      "https://example.com/page-2",
      "https://example.com/page-3",
    ],
  );
});
