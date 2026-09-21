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
      { requested: 500, granted: 50, ceiling: 50, source: 'operator_ceiling' },
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
    assert.deepEqual(budgetClamped, { requested: 500, granted: 50, ceiling: 50, source: 'operator_ceiling' });
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
      { requested: 20, granted: 10, ceiling: 10, source: 'operator_ceiling' },
      "duplicates and invalid lines are not counted as pages we refused",
    );
  });
});

// ── The Admin limit ────────────────────────────────────────────────────────
//
// adminLimits.maxUrlsPerCrawl used to clamp only a project's STORED options, at
// create and patch time. Nothing consulted it when a run started, so lowering
// the limit in Admin left every existing project crawling at the number it was
// created with, and a run that sent its own options was bounded by the env
// ceiling alone. "Set 500 in Admin, got 10,000 pages" was the report.
//
// run/manager.js now resolves the workspace policy per run and passes it as
// `overrides.maxUrls` — the one place manual, scheduled, worker and autostart
// runs all funnel through. These pin the properties that make that safe.

test("the admin policy lowers the page budget", () => {
  withCeiling(10_000, () => {
    const { options, budgetClamped } = parseCrawlRequest(
      { ...BODY, options: { maxUrls: 5_000 } },
      { maxUrls: 500 },
    );
    assert.equal(options.maxUrls, 500);
    assert.deepEqual(budgetClamped, {
      requested: 5_000, granted: 500, ceiling: 500, source: "admin_policy",
    }, "the reported ceiling is the effective one, and says which limit bound it");
  });
});

test("the admin policy can never RAISE the operator ceiling", () => {
  // A workspace policy is a tightening, not a grant. If this ever inverted, an
  // admin setting would become a way past the operator's own env ceiling.
  withCeiling(1_000, () => {
    const { options, budgetClamped } = parseCrawlRequest(
      { ...BODY, options: { maxUrls: 50_000 } },
      { maxUrls: 50_000 },
    );
    assert.equal(options.maxUrls, 1_000);
    assert.equal(budgetClamped.source, "operator_ceiling");
  });
});

test("a request under the policy is untouched and reports no clamp", () => {
  withCeiling(10_000, () => {
    const { options, budgetClamped } = parseCrawlRequest(
      { ...BODY, options: { maxUrls: 100 } },
      { maxUrls: 500 },
    );
    assert.equal(options.maxUrls, 100, "the policy is a ceiling, not a target");
    assert.equal(budgetClamped, null, "nothing was refused, so nothing is reported");
  });
});

test("a request with no maxUrls gets the policy, not the env ceiling", () => {
  // The default path, and the one that made the bug invisible: a project whose
  // stored options predate the limit sends whatever it was created with.
  withCeiling(10_000, () => {
    const { options } = parseCrawlRequest(BODY, { maxUrls: 500 });
    assert.equal(options.maxUrls, 500);
  });
});

test("a URL list is truncated by the policy too", () => {
  // List mode is bounded by how many URLs it keeps, and the list is parsed
  // before the budget is computed — so the policy has to reach the parse, or a
  // 1,200-URL list would run in full for a workspace capped at 300.
  withCeiling(10_000, () => {
    const urls = Array.from({ length: 1_200 }, (_, i) => `https://example.com/p${i}`);
    const { options, listInfo, budgetClamped } = parseCrawlRequest({ urls }, { maxUrls: 300 });
    assert.equal(options.maxUrls, 300);
    assert.equal(options.urls.length, 300, "the URLs themselves must be cut, not just the counter");
    assert.equal(listInfo.truncated, true);
    assert.equal(budgetClamped.source, "admin_policy");
  });
});

test("no policy leaves every existing behaviour exactly as it was", () => {
  withCeiling(10_000, () => {
    const withoutPolicy = parseCrawlRequest({ ...BODY, options: { maxUrls: 5_000 } });
    const emptyOverrides = parseCrawlRequest({ ...BODY, options: { maxUrls: 5_000 } }, {});
    assert.equal(withoutPolicy.options.maxUrls, 5_000);
    assert.deepEqual(emptyOverrides.options, withoutPolicy.options);
    assert.equal(withoutPolicy.budgetClamped, null);
  });
});

test("a nonsense policy value is ignored rather than crashing the crawl", () => {
  // effectiveLimits validates, but this is the last gate before a run and a
  // malformed stored policy must not become maxUrls: NaN.
  withCeiling(10_000, () => {
    for (const bad of [0, -5, "lots", null, undefined, NaN]) {
      const { options } = parseCrawlRequest({ ...BODY, options: { maxUrls: 400 } }, { maxUrls: bad });
      assert.equal(options.maxUrls, 400, `policy ${JSON.stringify(bad)} should be ignored`);
    }
  });
});
