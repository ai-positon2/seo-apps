// A crawl request for more pages than the limit allows is REDUCED, not rejected.
// That is the right behaviour — but for a long time it happened in total
// silence, and the silence cost real debugging time: a temporary
// MAX_URLS_CEILING=50 in .env turned every "crawl 500 pages" into a 50-page
// crawl, and nothing in the request, the response, or the run said so. The only
// number on screen was crawler._progress()'s ceiling (maxUrls + maxExternalUrls),
// which reports the REDUCED budget — indistinguishable from a site that simply
// has fewer pages. It read as a crawler bug for an afternoon.
//
// parseCrawlRequest reports the reduction as `budgetClamped`. These tests pin the
// two halves that matter: it fires when someone actually asked for more than they
// got, and it stays null otherwise — a signal that cries wolf on every ordinary
// request would be ignored, which is how we got here.
//
// ── One ceiling, and the admin owns it ──────────────────────────────────────
//
// There used to be two: an env ceiling read here, and the admin policy passed in
// as `overrides.maxUrls`, combined with Math.min. Three things were wrong with
// that and all three are pinned below.
//
//   1. The lower won, so an operator's .env could silently undercut what an
//      admin had configured. Admin now wins outright; env is a FALLBACK for a
//      server that cannot reach the limits table.
//   2. The combined value was computed and then not used — the spider-mode
//      budget clamped against the env ceiling alone, so the admin limit bound a
//      LIST crawl but not a SPIDER crawl, while budgetClamped reported that it
//      had. That is the bug these tests exist to keep fixed.
//   3. `source` was guessed from which number was smaller, rather than taken
//      from where the limit actually came from.

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCrawlRequest } = require("../shared/options");
const adminLimits = require("../../../services/adminLimits");

const BODY = { url: "https://example.com" };

// An effective limit set as services/adminLimits would resolve one, with the
// provenance the admin UI shows. `scope` is what `sources` reports.
function policy(maxUrlsPerCrawl, scope = "workspace") {
  return {
    limits: { ...adminLimits.DEFAULT_LIMITS, maxUrlsPerCrawl },
    sources: { maxUrlsPerCrawl: scope },
  };
}

// baseLimits() reads process.env on every call, so a test can set the fallback
// directly. Restored around each case because the suite runs with
// --test-isolation=none: every file in this directory shares one process, and a
// leaked value would silently retune unrelated tests.
function withEnvFallback(value, fn) {
  const previous = process.env.MAX_URLS_CEILING;
  process.env.MAX_URLS_CEILING = String(value);
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.MAX_URLS_CEILING;
    else process.env.MAX_URLS_CEILING = previous;
  }
}

// ── The fallback, when no policy reaches the parser ─────────────────────────

test("asking for more pages than the limit reports the clamp", () => {
  withEnvFallback(50, () => {
    const { options, budgetClamped } = parseCrawlRequest({
      ...BODY,
      options: { maxUrls: 500 },
    });

    assert.equal(options.maxUrls, 50, "the request is still reduced, not rejected");
    assert.deepEqual(
      budgetClamped,
      { requested: 500, granted: 50, ceiling: 50, source: "env_fallback" },
      "and the reduction is reported rather than left to be discovered",
    );
  });
});

test("a request within the limit reports no clamp", () => {
  withEnvFallback(500, () => {
    const { options, budgetClamped } = parseCrawlRequest({
      ...BODY,
      options: { maxUrls: 500 },
    });
    assert.equal(options.maxUrls, 500);
    assert.equal(budgetClamped, null, "500 of an allowed 500 is not a clamp");
  });
});

test("omitting maxUrls entirely never reports a clamp", () => {
  // The default is filled in from the ceiling on every plain request. Reporting
  // that would fire on traffic nobody asked a question about, and a warning that
  // fires always is a warning nobody reads.
  withEnvFallback(50, () => {
    const { options, budgetClamped } = parseCrawlRequest(BODY);
    assert.equal(options.maxUrls, 50);
    assert.equal(budgetClamped, null, "the caller expressed no preference to clamp");
  });
});

test("a URL list longer than the limit reports the clamp and truncates", () => {
  withEnvFallback(50, () => {
    const urls = Array.from({ length: 500 }, (_, i) => `https://example.com/p${i}`);
    const { options, listInfo, budgetClamped } = parseCrawlRequest({ urls });

    assert.equal(options.urls.length, 50, "only the ceiling's worth is queued");
    assert.equal(options.maxUrls, 50, "and the budget matches what was queued");
    assert.equal(listInfo.truncated, true);
    assert.deepEqual(budgetClamped, {
      requested: 500, granted: 50, ceiling: 50, source: "env_fallback",
    });
  });
});

test("a URL list within the limit reports no clamp", () => {
  withEnvFallback(500, () => {
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
  withEnvFallback(10, () => {
    const valid = Array.from({ length: 20 }, (_, i) => `https://example.com/p${i}`);
    const { budgetClamped } = parseCrawlRequest({
      urls: [...valid, ...valid.slice(0, 5), "not a url", ""],
    });
    assert.deepEqual(
      budgetClamped,
      { requested: 20, granted: 10, ceiling: 10, source: "env_fallback" },
      "duplicates and invalid lines are not counted as pages we refused",
    );
  });
});

// ── The Admin limit ────────────────────────────────────────────────────────
//
// adminLimits.maxUrlsPerCrawl used to clamp only a project's STORED options, at
// create and patch time. Nothing consulted it when a run started, so lowering
// the limit in Admin left every existing project crawling at the number it was
// created with. "Set 500 in Admin, got 10,000 pages" was the report.
//
// run/manager.js resolves the workspace policy per run and passes it as
// `overrides.limits` — the one place manual, scheduled, worker, autostart and
// list runs all funnel through.

test("the admin policy lowers the page budget", () => {
  withEnvFallback(10_000, () => {
    const { options, budgetClamped } = parseCrawlRequest(
      { ...BODY, options: { maxUrls: 5_000 } },
      policy(500),
    );
    assert.equal(options.maxUrls, 500);
    assert.deepEqual(budgetClamped, {
      requested: 5_000, granted: 500, ceiling: 500, source: "workspace",
    }, "the reported ceiling is the effective one, and names the surface that set it");
  });
});

test("the admin policy binds a SPIDER crawl, not just a list", () => {
  // The regression this file exists for. `effectiveCeiling` was computed and
  // then used for list mode only; spider mode clamped against the env ceiling,
  // so the admin limit did not bind the common case at all — while
  // budgetClamped reported that it had.
  withEnvFallback(10_000, () => {
    const spider = parseCrawlRequest({ ...BODY, options: { maxUrls: 5_000 } }, policy(500));
    const list = parseCrawlRequest(
      { urls: Array.from({ length: 5_000 }, (_, i) => `https://example.com/p${i}`) },
      policy(500),
    );
    assert.equal(spider.options.maxUrls, 500);
    assert.equal(list.options.maxUrls, 500);
    assert.equal(
      spider.options.maxUrls, list.options.maxUrls,
      "the two modes must not disagree about the same workspace's budget",
    );
    assert.equal(
      spider.budgetClamped.granted, spider.options.maxUrls,
      "and what we REPORT granting has to be what we actually granted",
    );
  });
});

test("the admin policy RAISES the budget past an env fallback", () => {
  // The inversion of the old rule, and the point of the change. Env used to be a
  // competing ceiling combined with Math.min, so MAX_URLS_CEILING=50 quietly
  // overrode an admin who had set 500. Env is now a fallback for a server that
  // cannot reach the limits table; when a policy exists, the policy is the cap.
  withEnvFallback(50, () => {
    const { options, budgetClamped } = parseCrawlRequest(
      { ...BODY, options: { maxUrls: 500 } },
      policy(500),
    );
    assert.equal(options.maxUrls, 500, "the admin's number wins over the operator's");
    assert.equal(budgetClamped, null);
  });
});

test("no policy may exceed the platform hard maximum", () => {
  // The backstop that replaced the env ceiling. Past this the crawler's own
  // constructor truncates anyway, so it is declared and attributed here rather
  // than discovered as a silent cut later.
  const hard = adminLimits.HARD_MAX.maxUrlsPerCrawl;
  const { limits, sources } = adminLimits.combine([
    { scope: "workspace", limits: { maxUrlsPerCrawl: hard * 10 } },
  ]);
  assert.equal(limits.maxUrlsPerCrawl, hard);
  assert.equal(sources.maxUrlsPerCrawl, "hard_max");

  const { options } = parseCrawlRequest(
    { ...BODY, options: { maxUrls: hard * 10 } },
    { limits, sources },
  );
  assert.equal(options.maxUrls, hard);
});

test("a request under the policy is untouched and reports no clamp", () => {
  withEnvFallback(10_000, () => {
    const { options, budgetClamped } = parseCrawlRequest(
      { ...BODY, options: { maxUrls: 100 } },
      policy(500),
    );
    assert.equal(options.maxUrls, 100, "the policy is a ceiling, not a target");
    assert.equal(budgetClamped, null, "nothing was refused, so nothing is reported");
  });
});

test("a request with no maxUrls gets the policy, not the env fallback", () => {
  // The default path, and the one that made the bug invisible: a project whose
  // stored options predate the limit sends whatever it was created with. The
  // policy here is deliberately NOT equal to any default — an earlier version of
  // this test used 500, which is also the built-in default, so it passed without
  // the policy being consulted at all.
  withEnvFallback(10_000, () => {
    const { options } = parseCrawlRequest(BODY, policy(317));
    assert.equal(options.maxUrls, 317);
  });
});

test("a URL list is truncated by the policy too", () => {
  // List mode is bounded by how many URLs it keeps, and the list is parsed
  // before the budget is computed — so the policy has to reach the parse, or a
  // 1,200-URL list would run in full for a workspace capped at 300.
  withEnvFallback(10_000, () => {
    const urls = Array.from({ length: 1_200 }, (_, i) => `https://example.com/p${i}`);
    const { options, listInfo, budgetClamped } = parseCrawlRequest({ urls }, policy(300));
    assert.equal(options.maxUrls, 300);
    assert.equal(options.urls.length, 300, "the URLs themselves must be cut, not just the counter");
    assert.equal(listInfo.truncated, true);
    assert.equal(budgetClamped.source, "workspace");
  });
});

test("budgetClamped.source is the policy's own provenance, never a guess", () => {
  // It used to be derived from which of two numbers was smaller, which made it
  // wrong precisely when it mattered. It is now `sources.maxUrlsPerCrawl`.
  for (const scope of ["platform", "workspace", "tier"]) {
    const { budgetClamped } = parseCrawlRequest(
      { ...BODY, options: { maxUrls: 9_999 } },
      policy(200, scope),
    );
    assert.equal(budgetClamped.source, scope);
  }
});

test("a nonsense policy value is ignored rather than crashing the crawl", () => {
  // effectiveLimits validates, but this is the last gate before a run and a
  // malformed stored policy must not become maxUrls: NaN.
  withEnvFallback(10_000, () => {
    for (const bad of [0, -5, "lots", null, undefined, NaN]) {
      const { options } = parseCrawlRequest(
        { ...BODY, options: { maxUrls: 400 } },
        { limits: { ...adminLimits.DEFAULT_LIMITS, maxUrlsPerCrawl: bad }, sources: {} },
      );
      assert.equal(options.maxUrls, 400, `policy ${JSON.stringify(bad)} should be ignored`);
    }
  });
});

// ── Per-run tightenings ────────────────────────────────────────────────────

test("a per-run tightening can lower the budget below the policy", () => {
  const { options, budgetClamped } = parseCrawlRequest(
    { ...BODY, options: { maxUrls: 5_000 } },
    { ...policy(1_000), maxUrls: 200 },
  );
  assert.equal(options.maxUrls, 200);
  assert.equal(budgetClamped.source, "run_override", "and says so, rather than blaming the admin");
});

test("a per-run tightening can never raise the budget above the policy", () => {
  const { options, budgetClamped } = parseCrawlRequest(
    { ...BODY, options: { maxUrls: 5_000 } },
    { ...policy(300), maxUrls: 9_000 },
  );
  assert.equal(options.maxUrls, 300);
  assert.equal(budgetClamped.source, "workspace");
});

// ── Storing a preference is not running a crawl ────────────────────────────

test("storing keeps the number the caller asked for", () => {
  // A stored budget clamped to today's policy is a budget frozen at today's
  // policy: raise the workspace limit next month and the row still holds the
  // smaller number, so the raise never reaches the project. That is how a real
  // client sat at 150 pages a week for months.
  const { options } = parseCrawlRequest(
    { ...BODY, options: { maxUrls: 5_000 } },
    { ...policy(500), storing: true },
  );
  assert.equal(options.maxUrls, 5_000, "the request is preserved, not frozen at today's ceiling");
});

test("storing still refuses to exceed the platform hard maximum", () => {
  const { options } = parseCrawlRequest(
    { ...BODY, options: { maxUrls: 10_000_000 } },
    { storing: true },
  );
  assert.equal(options.maxUrls, adminLimits.HARD_MAX.maxUrlsPerCrawl);
});

test("storing leaves an unstated budget unstated", () => {
  // So the row says "no preference" rather than recording a number nobody chose
  // — which the run would then read back as a deliberate setting.
  const { options } = parseCrawlRequest(BODY, { ...policy(500), storing: true });
  assert.equal("maxUrls" in options, false);
  assert.equal("maxDepth" in options, false);
});

test("an executed run fills in what storing left out", () => {
  const stored = parseCrawlRequest(BODY, { ...policy(500), storing: true }).options;
  const executed = parseCrawlRequest({ ...BODY, options: stored }, policy(500)).options;
  assert.equal(executed.maxUrls, 500, "the policy in force at run time decides");
  assert.equal(executed.maxDepth, adminLimits.DEFAULT_LIMITS.maxCrawlDepth);
});
