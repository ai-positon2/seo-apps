// The worker passes optionOverrides so unattended crawls are politer than interactive
// ones. Overrides must be monotonic: they can only ever slow a crawl down. A replacing
// override could make a scheduled crawl hammer a client's site harder than the settings
// they chose, which is the opposite of the intent.

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCrawlRequest } = require("../shared/options");

const BODY = { url: "https://example.com" };

test("an override raises perHostDelay but never lowers it", () => {
  const raised = parseCrawlRequest(
    { ...BODY, options: { perHostDelay: 100 } },
    { perHostDelay: 500 },
  );
  assert.equal(raised.options.perHostDelay, 500, "the politer value wins");

  const notLowered = parseCrawlRequest(
    { ...BODY, options: { perHostDelay: 2_000 } },
    { perHostDelay: 500 },
  );
  assert.equal(
    notLowered.options.perHostDelay,
    2_000,
    "an override must not speed up a request that asked to be gentler",
  );
});

test("an override of 0 cannot remove per-host politeness", () => {
  const { options } = parseCrawlRequest(
    { ...BODY, options: { perHostDelay: 400 } },
    { perHostDelay: 0 },
  );
  assert.equal(options.perHostDelay, 400);
});

test("an override lowers concurrency but never raises it", () => {
  const lowered = parseCrawlRequest({ ...BODY, options: { concurrency: 8 } }, { concurrency: 2 });
  assert.equal(lowered.options.concurrency, 2);

  const notRaised = parseCrawlRequest({ ...BODY, options: { concurrency: 2 } }, { concurrency: 8 });
  assert.equal(notRaised.options.concurrency, 2, "a request asking for 2 stays at 2");
});

test("no overrides leaves the request's own options in force", () => {
  const { options } = parseCrawlRequest({
    ...BODY,
    options: { concurrency: 4, perHostDelay: 250 },
  });
  assert.equal(options.concurrency, 4);
  assert.equal(options.perHostDelay, 250);
});

test("overrides still respect the configured ceilings", () => {
  const previous = process.env.MAX_CONCURRENCY_CEILING;
  process.env.MAX_CONCURRENCY_CEILING = "4";
  try {
    const { options } = parseCrawlRequest(
      { ...BODY, options: { concurrency: 12 } },
      { concurrency: 8 },
    );
    assert.equal(options.concurrency, 4, "the env ceiling is the hard bound");
  } finally {
    process.env.MAX_CONCURRENCY_CEILING = previous;
  }
});
