const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings } = require("../analyzer");

// A noindexed page is out of search results, so how its title, description,
// headings or viewport would look there has no SEO consequence. The analyzer
// already skipped H1-missing, word count and Open Graph on noindex pages but
// still filed title, meta-description, multiple-H1, viewport and schema findings
// on them — noise on the /cart, /login and tag pages sites noindex on purpose.
test("search-appearance checks skip noindex pages; server, security and link checks do not", () => {
  const H = "https://example.com";
  const noindexed = {
    url: `${H}/cart`, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
    title: "", titleCount: 2, titleLength: 0, metaDescription: "", metaLength: 0, viewport: "",
    h1Count: 3, h1: "Cart | Cart | Cart", words: 40, textHtmlRatio: 0.05, canonical: `${H}/cart`,
    hreflangs: [], robots: "noindex, follow", robotsDirectives: ["noindex", "follow"],
    indexability: "Non-indexable", inlinks: 2, depth: 1, hash: "cart", responseTime: 1500,
    strictTransportSecurity: "max-age=1", openGraphMissing: ["og:title"], openGraphInvalidUrls: [],
    schemaErrors: ["Product is missing the required name property"],
  };
  const { findings } = buildFindings({
    results: [
      { ...noindexed, url: `${H}/`, robots: "", robotsDirectives: [], indexability: "Indexable", title: "Home page title", titleLength: 15, titleCount: 1, h1Count: 1, h1: "Home", metaDescription: "d".repeat(120), metaLength: 120, viewport: "width=device-width", schemaErrors: [], responseTime: 100, hash: "home" },
      noindexed,
    ],
    resourceEdges: [{ sourceUrl: `${H}/cart`, targetUrl: "http://cdn.example.org/lib.js", tag: "script", sourceAttribute: "src" }],
    startUrl: `${H}/`,
    sitemapsChecked: false,
  });
  const rules = new Set(findings.filter((f) => f.url === `${H}/cart`).map((f) => f.ruleId));
  for (const skipped of [
    "title-missing", "title-multiple", "meta-missing", "h1-multiple", "viewport-missing", "schema-error",
  ]) {
    assert.ok(!rules.has(skipped), `${skipped} must not fire on a noindex page`);
  }
  for (const kept of ["noindex", "slow-page", "mixed-content"]) {
    assert.ok(rules.has(kept), `${kept} still applies to a noindex page`);
  }
});
