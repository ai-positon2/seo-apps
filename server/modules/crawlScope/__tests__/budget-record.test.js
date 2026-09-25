// What a run RECORDS about its own page budget, and how it gets the limit in
// the first place.
//
// crawl_runs.options holds the options the row was CREATED with. The number a
// run actually crawls with is resolved later, when it executes, against the
// admin limit as it stands at that moment. Nothing recorded the difference, so
// the run page read run.options.maxUrls and labelled it "budget" — a run cut
// from 5,000 pages to 500 displayed 5,000, the one number nobody got.
//
// manager._execute now writes the resolved options back and stores
// budgetRecord() alongside them. These pin that record's shape, because the UI
// and the migration's column comment both depend on it.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  budgetRecord,
  resolveLimits,
  describeBudgetSource,
  BUDGET_SOURCE_LABELS,
} = require("../shared/options");
const adminLimits = require("../../../services/adminLimits");

// ── budgetRecord ───────────────────────────────────────────────────────────

test("an unclamped run records the budget it got, attributed to its policy", () => {
  assert.deepEqual(
    budgetRecord({ maxUrls: 500 }, null, { maxUrlsPerCrawl: "workspace" }),
    { granted: 500, requested: 500, source: "workspace", clamped: false },
  );
});

test("requested equals granted when nothing was cut", () => {
  // Rather than null. A reader should not have to know whether null means "not
  // clamped" or "not recorded" — the two have very different implications for a
  // run whose numbers look wrong.
  const record = budgetRecord({ maxUrls: 120 }, null, {});
  assert.equal(record.requested, record.granted);
  assert.equal(record.clamped, false);
});

test("a clamped run records both numbers and what cut it", () => {
  assert.deepEqual(
    budgetRecord(
      { maxUrls: 500 },
      { requested: 5_000, granted: 500, ceiling: 500, source: "workspace" },
      { maxUrlsPerCrawl: "workspace" },
    ),
    { granted: 500, requested: 5_000, source: "workspace", clamped: true },
  );
});

test("granted is the options the crawler was built with, never the clamp report", () => {
  // The two agreed only by accident before: budgetClamped was computed from the
  // effective ceiling while options.maxUrls was clamped against the env one, so
  // a run could report granting 500 while crawling 5,000. If these ever diverge
  // again, the recorded budget must follow the crawler.
  const record = budgetRecord(
    { maxUrls: 500 },
    { requested: 5_000, granted: 999, ceiling: 999, source: "platform" },
    {},
  );
  assert.equal(record.granted, 500);
});

test("with no policy source the record says 'default' rather than nothing", () => {
  const record = budgetRecord({ maxUrls: 500 }, null, {});
  assert.equal(record.source, "default");
  assert.equal(describeBudgetSource(record.source), BUDGET_SOURCE_LABELS.default);
});

test("every source a record can carry has a plain-language label", () => {
  // The log line, the toast and the run page all read these. A missing entry
  // would surface a bare token like 'env_fallback' to a customer.
  const sources = ["platform", "workspace", "tier", "hard_max", "env_fallback", "run_override", "default"];
  for (const source of sources) {
    assert.ok(BUDGET_SOURCE_LABELS[source], `no label for ${source}`);
  }
  assert.equal(describeBudgetSource("something_new"), "the limit in force", "and an unknown one degrades");
});

// ── resolveLimits ──────────────────────────────────────────────────────────
//
// The one way every crawl entry path gets its ceiling. It must never throw: an
// unreachable limits table must not stop a crawl from being accepted or run.

test("no workspace resolves to no limits, not an error", async () => {
  assert.deepEqual(await resolveLimits(null), {});
  assert.deepEqual(await resolveLimits(undefined), {});
});

test("a failing limits lookup falls back instead of failing the crawl", async () => {
  const original = adminLimits.effectiveLimits;
  const seen = [];
  adminLimits.effectiveLimits = async () => { throw new Error("limits table unreachable"); };
  try {
    const resolved = await resolveLimits("ws-1", (error) => seen.push(error.message));
    assert.deepEqual(resolved, {}, "so parseCrawlRequest uses the platform defaults");
    assert.deepEqual(seen, ["limits table unreachable"], "and the caller gets to say so");
  } finally {
    adminLimits.effectiveLimits = original;
  }
});

test("a resolved workspace carries both the numbers and their provenance", async () => {
  const original = adminLimits.effectiveLimits;
  adminLimits.effectiveLimits = async ({ workspaceId }) => {
    assert.equal(workspaceId, "ws-1");
    return {
      limits: { ...adminLimits.DEFAULT_LIMITS, maxUrlsPerCrawl: 250 },
      sources: { maxUrlsPerCrawl: "workspace" },
    };
  };
  try {
    const { limits, sources } = await resolveLimits("ws-1");
    assert.equal(limits.maxUrlsPerCrawl, 250);
    assert.equal(sources.maxUrlsPerCrawl, "workspace", "without this the record cannot attribute the cap");
  } finally {
    adminLimits.effectiveLimits = original;
  }
});
