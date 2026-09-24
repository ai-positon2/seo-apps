const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings, catalog } = require("../analyzer");

// "Add links from related pages" said nothing the crawl did not already know:
// it has the whole link graph, so it can name the pages. And several
// recommendations were written for a local business ("services, benefits and
// location-specific details") whatever the site was.

const H = "https://example.com";
const html = (path, extra = {}) => ({
  url: `${H}${path}`, status: 200, contentType: "text/html", scope: "Internal", depth: 1,
  indexability: "Indexable", title: `Title for ${path}`, titleLength: 20, titleCount: 1,
  metaDescription: "d".repeat(120), metaLength: 120, h1: path, h1Count: 1, words: 400,
  viewport: "width=device-width", robots: "", robotsDirectives: [], responseTime: 100, hash: path,
  ...extra,
});
const edge = (from, to) => ({ sourceUrl: `${H}${from}`, targetUrl: `${H}${to}`, internal: true, text: `Read ${to}` });

function analyse(pages, links) {
  return buildFindings({
    results: pages,
    linkEdges: links,
    resourceEdges: [],
    sitemapMembership: Object.fromEntries(pages.filter((p) => p.fromSitemap).map((p) => [p.url, [`${H}/sitemap.xml`]])),
    siteDiagnostics: {},
    startUrl: `${H}/`,
  }).findings;
}

test("a deep page is told which shallow pages in its section could link to it, nearest section first", () => {
  const pages = ["/", "/guides/", "/guides/a", "/guides/a/b", "/guides/a/b/c", "/about"].map((p) => html(p));
  const links = [edge("/", "/guides/"), edge("/", "/about"), edge("/guides/", "/guides/a"), edge("/guides/a", "/guides/a/b"), edge("/guides/a/b", "/guides/a/b/c")];
  const deep = analyse(pages, links).find((f) => f.ruleId === "deep-page");
  assert.equal(deep.url, `${H}/guides/a/b/c`);
  assert.equal(deep.detail, "4 clicks from the start page");
  assert.equal(
    deep.recommendation,
    "Add a link to this page from /guides/a (2 clicks from the start page) or /guides/ (1 click), in the same section, so it is 3 clicks or fewer from the start page.",
  );
});

test("a page with one incoming link is told which related pages could add one", () => {
  const pages = ["/", "/blog/", "/blog/one", "/blog/two", "/blog/three"].map((p) => html(p));
  const links = [
    edge("/", "/blog/"), edge("/blog/", "/blog/one"), edge("/blog/", "/blog/two"), edge("/blog/two", "/blog/one"),
    edge("/blog/one", "/blog/two"), edge("/blog/two", "/blog/three"),
  ];
  const single = analyse(pages, links).find((f) => f.ruleId === "single-inlink" && f.url === `${H}/blog/three`);
  assert.equal(
    single.recommendation,
    "Only /blog/two links to this page. Add links to it from related pages, such as /blog/ or /blog/one.",
  );
});

test("an orphan page is told where a link could come from, or to retire it", () => {
  const pages = [html("/"), html("/shop/"), html("/shop/hats"), html("/shop/old-sale", { fromSitemap: true })];
  const links = [edge("/", "/shop/"), edge("/shop/", "/shop/hats")];
  const orphan = analyse(pages, links).find((f) => f.ruleId === "orphan-page");
  assert.equal(
    orphan.recommendation,
    "No crawled page links to this page; only the sitemap lists it. Link to it from related pages, such as /shop/ or /shop/hats. " +
      "If it is no longer needed, redirect or remove it and take it out of the sitemap.",
  );
});

test("recommendations are written for any site, not for a local business", () => {
  // ("Location header" is HTTP, not a shop.)
  const localWording = /\b(?:services?|location-specific|local specifics)\b|\blocations?\b(?!\s+header)/i;
  const offenders = catalog
    .filter((rule) => rule.id !== "schema-required-missing")
    .filter((rule) => localWording.test(rule.recommendation))
    .map((rule) => rule.id);
  assert.deepEqual(offenders, []);
});
