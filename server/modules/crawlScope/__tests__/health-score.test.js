const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { buildFindings } = require("../analyzer");
const overview = require("../../projects/overview");

// The crawl report's score lives in the client (it recomputes as findings are
// reviewed); client/package.json is "type": "module" and crawlHelpers.js has no
// imports, so it loads directly.
const HELPERS = pathToFileURL(
  path.join(__dirname, "../../../../client/src/components/crawlScope/crawlHelpers.js"),
).href;

const H = "https://example.com";

function page(i, extra = {}) {
  const url = `${H}/p${i}`;
  return {
    url, scope: "Internal", status: 200, contentType: "text/html",
    title: `Unique page title number ${i} for the fixture`, titleCount: 1, titleLength: 40,
    metaDescription: `Unique description ${i} `.repeat(6), metaLength: 130,
    viewport: "width=device-width", h1Count: 1, h1: `Heading ${i}`, words: 400, textHtmlRatio: 0.3,
    canonical: url, hreflangs: [], robots: "", indexability: "Indexable", inlinks: 5, depth: 1,
    fromSitemap: true, hash: `h${i}`, responseTime: 100, strictTransportSecurity: "max-age=1",
    openGraphMissing: [], openGraphInvalidUrls: [], ...extra,
  };
}

function crawlWithMissingMeta(share, total = 20) {
  const results = [];
  for (let i = 0; i < total; i += 1) {
    const missing = i < Math.round(total * share);
    results.push(page(i, missing ? { metaDescription: "", metaLength: 0 } : {}));
  }
  const membership = Object.fromEntries(results.map((r) => [r.url, ["s.xml"]]));
  const { findings } = buildFindings({ results, sitemapMembership: membership, startUrl: `${H}/p0` });
  return { results, findings };
}

// collapseTemplateFindings re-tags a rule as scope 'template' once it shows up
// on at least half the pages. The score only counted scope 'page', so a problem
// that spread to every page dropped OUT of the score: 45% of pages missing a meta
// description scored 90, 100% scored 100. The worse the site, the better it read.
test("Site Health never improves as a page-level problem spreads", async () => {
  const { healthMetrics } = await import(HELPERS);
  const scores = [0, 0.3, 0.45, 0.5, 1].map((share) => {
    const { results, findings } = crawlWithMissingMeta(share);
    return healthMetrics(results, findings).health;
  });
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(
      scores[i] <= scores[i - 1],
      `score rose from ${scores[i - 1]} to ${scores[i]} as more pages lost their meta description (${scores.join(", ")})`,
    );
  }
  assert.ok(scores.at(-1) < 100, "every page missing a meta description is not a perfect site");
});

test("findings on non-page URLs do not count against the page share", async () => {
  const { healthMetrics } = await import(HELPERS);
  const results = [page(0), page(1), { url: `${H}/img/a.png`, scope: "Internal", status: 404, contentType: "image/png" }];
  const findings = [
    { ruleId: "page-4xx", severity: "error", scope: "page", url: `${H}/img/a.png`, reviewStatus: "Needs review" },
  ];
  // The denominator is HTML pages; an image URL is not one of them, so it
  // cannot also be one of the pages "with an error".
  assert.equal(healthMetrics(results, findings).affectedErrorPages, 0);
});

test("dashboard score counts template-wide findings too", () => {
  const { findings } = crawlWithMissingMeta(1);
  assert.ok(findings.every((f) => f.ruleId !== "meta-missing" || f.scope === "template"));
  const run = { summary: { counts: { warning: findings.length }, findings } };
  const score = overview.siteHealth(run, 20).score;
  assert.ok(score < 100, `every page missing meta must not score 100 (got ${score})`);
});

test("dashboard score ignores site- and resource-scoped findings, like the report", () => {
  const run = {
    summary: {
      counts: { error: 2 },
      findings: [
        { severity: "error", url: `${H}/`, scope: "site" },
        { severity: "error", url: `${H}/app.js`, scope: "resource" },
      ],
    },
  };
  assert.equal(overview.siteHealth(run, 10).score, 100);
});

test("dashboard score uses precomputed page counts when given them", () => {
  const run = { summary: { counts: { error: 1 }, findings: [] } };
  const score = overview.siteHealth(run, 10, [], { error: 5, warning: 0, notice: 0 });
  // v5, page counts only: each affected page fails one error rule (40 points).
  assert.equal(score.score, Math.round(100 - (5 * 40) / 10));
  // With the SQL aggregate's summed loss, that is used as is.
  const exact = overview.siteHealth(run, 10, [], { error: 5, warning: 0, notice: 0, lossTotals: { error: 230, warning: 40, notice: 6 } });
  assert.equal(exact.score, Math.round(100 - 276 / 10));
});

test("v5: the dashboard and the crawl report compute the same score", async () => {
  const { healthMetrics } = await import(HELPERS);
  const results = Array.from({ length: 6 }, (_, i) => page(i));
  const findings = [
    { url: results[0].url, severity: "error", ruleId: "a", scope: "page" },
    { url: results[0].url, severity: "error", ruleId: "b", scope: "page" },
    { url: results[0].url, severity: "error", ruleId: "c", scope: "page" },
    { url: results[1].url, severity: "warning", ruleId: "d", scope: "template" },
    { url: results[1].url, severity: "warning", ruleId: "d", scope: "template" },
    { url: results[2].url, severity: "notice", ruleId: "e", scope: "page" },
    { url: results[3].url, severity: "warning", ruleId: "f", scope: "page", reviewStatus: "False positive" },
  ];
  const client = healthMetrics(results, findings).health;
  const server = overview.siteHealth({ summary: { findings } }, results.length, findings).score;
  assert.equal(client, server);
  assert.equal(client, Math.round(100 - (100 + 10 + 2) / 6), "page 0 is capped at 100");
});
