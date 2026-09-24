const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings } = require("../analyzer");

const H = "https://example.com";
const page = (url, extra = {}) => ({
  url, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: `Title for ${url}`, titleCount: 1, titleLength: 30, metaDescription: `Description for ${url} `.repeat(4),
  metaLength: 120, viewport: "width=device-width", h1Count: 1, h1: `H1 ${url}`, words: 400, textHtmlRatio: 0.3,
  canonical: url, hreflangs: [], robots: "", indexability: "Indexable", inlinks: 0, depth: 1, hash: url,
  responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [], openGraphInvalidUrls: [],
  fromSitemap: true, ...extra,
});
const link = (from, to, extra = {}) => ({ sourceUrl: `${H}${from}`, targetUrl: `${H}${to}`, internal: true, anchorText: "x", ...extra });

// inlinks used to be the crawler's count of <a> ELEMENTS pointing at a URL: a
// nav link and its footer twin were two inlinks, a nofollow link counted, and a
// redirect hop counted as a link from the redirecting URL. So "only one
// incoming internal link" missed every page linked from a single page's nav and
// footer, which is most of them.
function crawl() {
  return buildFindings({
    results: [
      page(`${H}/`),
      page(`${H}/a`),
      page(`${H}/b`),
      page(`${H}/c`),
      page(`${H}/orphan`),
      page(`${H}/old`, { status: 301, contentType: "", redirectUrl: `${H}/moved` }),
      page(`${H}/moved`),
    ],
    linkEdges: [
      link("/", "/a"), // nav
      link("/", "/a"), // footer — same page, same link
      link("/c", "/a", { nofollow: true, rel: "nofollow" }),
      link("/", "/b"),
      link("/a", "/b"),
      link("/", "/c"),
      link("/b", "/c"),
      link("/orphan", "/orphan"), // a self-link is not an inlink
      link("/", "/old"), // reaches /moved through the redirect
    ],
    sitemapMembership: Object.fromEntries(
      ["/", "/a", "/b", "/c", "/orphan", "/moved"].map((p) => [`${H}${p}`, ["s.xml"]]),
    ),
    startUrl: `${H}/`,
  });
}

test("inlinks count distinct linking pages, and followable ones separately", () => {
  const { results } = crawl();
  const at = (p) => results.find((r) => r.url === `${H}${p}`);
  assert.equal(at("/a").inlinks, 2, "linked from / (twice) and /c");
  assert.equal(at("/a").followInlinks, 1, "the /c link is nofollow");
  assert.equal(at("/b").inlinks, 2);
  assert.equal(at("/orphan").inlinks, 0);
  assert.equal(at("/moved").inlinks, 1, "a link to a redirect reaches its destination");
});

test("single-inlink and orphan-page use the page counts", () => {
  const { findings } = crawl();
  const rules = (p) => findings.filter((f) => f.url === `${H}${p}`).map((f) => f.ruleId);
  assert.ok(rules("/a").includes("single-inlink"), "one followable linking page, however many <a> elements");
  assert.ok(!rules("/b").includes("single-inlink"));
  assert.ok(rules("/orphan").includes("orphan-page"));
  assert.ok(!rules("/moved").includes("orphan-page"));
});
