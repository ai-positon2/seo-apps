// A crawl request for more pages than the operator ceiling allows is REDUCED,
// not rejected. That is the right behaviour — but for a long time it happened
// in total silence, and the silence cost real debugging time: a temporary
// MAX_URLS_CEILING=50 in .env turned every "crawl 500 pages" into a 50-page
// crawl, and nothing in the request, the response, or the run said so. The only
// number on screen was crawler._progress()'s ceiling (maxUrls + maxExternalUrls),
// which reports the REDUCED budget — indistinguishable from a site that simply
// has fewer pages. It read as a crawler bug for an afternoon.
//
// parseCrawlRequest now reports the reduction as `budgetClamped`. These tests
// pin the two halves that matter: it fires when someone actually asked for more
// than they got, and it stays null otherwise — a signal that cries wolf on every
// ordinary request would be ignored, which is how we got here.

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCrawlRequest } = require("../shared/options");

const BODY = { url: "https://example.com" };

// ceilings() reads process.env on every call, so a test can set the operator
// ceiling directly. Restored around each case because the suite runs with
// --test-isolation=none: every file in this directory shares one process, and a
// leaked ceiling would silently retune unrelated tests.
function withCeiling(value, fn) {
  const previous = process.env.MAX_URLS_CEILING;
  process.env.MAX_URLS_CEILING = String(value);
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.MAX_URLS_CEILING;
    else process.env.MAX_URLS_CEILING = previous;
  }
}

test("asking for more pages than the ceiling reports the clamp", () => {
  withCeiling(50, () => {
    const { options, budgetClamped } = parseCrawlRequest({
      ...BODY,
      options: { maxUrls: 500 },
    });

    assert.equal(options.maxUrls, 50, "the request is still reduced, not rejected");
    assert.deepEqual(
      budgetClamped,
      { requested: 500, granted: 50, ceiling: 50 },
      "and the reduction is reported rather than left to be discovered",
    );
  });
});

test("a request within the ceiling reports no clamp", () => {
  withCeiling(500, () => {
    const { options, budgetClamped } = parseCrawlRequest({
      ...BODY,
      options: { maxUrls: 500 },
    });
    assert.equal(options.maxUrls, 500);
    assert.equal(budgetClamped, null, "500 of an allowed 500 is not a clamp");
  });
});

test("omitting maxUrls entirely never reports a clamp", () => {
  // The default (10,000) is filled in and then clamped to the ceiling on every
  // plain request. Reporting that would fire on traffic nobody asked a question
  // about, and a warning that fires always is a warning nobody reads.
  withCeiling(50, () => {
    const { options, budgetClamped } = parseCrawlRequest(BODY);
    assert.equal(options.maxUrls, 50);
    assert.equal(budgetClamped, null, "the caller expressed no preference to clamp");
  });
});

test("a URL list longer than the ceiling reports the clamp and truncates", () => {
  withCeiling(50, () => {
    const urls = Array.from({ length: 500 }, (_, i) => `https://example.com/p${i}`);
    const { options, listInfo, budgetClamped } = parseCrawlRequest({ urls });

    assert.equal(options.urls.length, 50, "only the ceiling's worth is queued");
    assert.equal(options.maxUrls, 50, "and the budget matches what was queued");
    assert.equal(listInfo.truncated, true);
    assert.deepEqual(budgetClamped, { requested: 500, granted: 50, ceiling: 50 });
  });
});

test("a URL list within the ceiling reports no clamp", () => {
  withCeiling(500, () => {
    const urls = Array.from({ length: 120 }, (_, i) => `https://example.com/p${i}`);
    const { options, listInfo, budgetClamped } = parseCrawlRequest({ urls });

    assert.equal(options.urls.length, 120);
    assert.equal(listInfo.truncated, false);
    assert.equal(budgetClamped, null);
  });
});

test("the clamp counts valid URLs, not raw input lines", () => {
  // parseUrlList drops invalid entries and duplicates before the ceiling is
  // applied. Reporting the raw input length would overstate the reduction —
  // "we dropped 40 of your URLs" when 35 of them were never valid URLs.
  withCeiling(10, () => {
    const valid = Array.from({ length: 20 }, (_, i) => `https://example.com/p${i}`);
    const { budgetClamped } = parseCrawlRequest({
      urls: [...valid, ...valid.slice(0, 5), "not a url", ""],
    });
    assert.deepEqual(
      budgetClamped,
      { requested: 20, granted: 10, ceiling: 10 },
      "duplicates and invalid lines are not counted as pages we refused",
    );
  });
});
