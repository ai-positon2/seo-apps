const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings } = require("../analyzer");
const { parseCrawlRequest } = require("../shared/options");

// Every limit an audit judges pages by was fixed in the code: a 60-character
// title (Semrush uses 70), a 200-word page counting navigation and footer, a
// one-second response, three clicks. A site, or an agency's house style, that
// wants other limits had to live with findings it disagreed with.

const H = "https://example.com";
const html = (path, extra = {}) => ({
  url: `${H}${path}`, status: 200, contentType: "text/html", scope: "Internal", depth: 1,
  indexability: "Indexable", title: `A title long enough for ${path}`, titleLength: 40, titleCount: 1,
  metaDescription: `A description of ${path} `.padEnd(120, "x"), metaLength: 120, h1: path, h1Count: 1, words: 400,
  viewport: "width=device-width", robots: "", robotsDirectives: [], responseTime: 100, hash: path,
  ...extra,
});
const edge = (from, to) => ({ sourceUrl: `${H}${from}`, targetUrl: `${H}${to}`, internal: true, text: `Read ${to}` });

function analyse(thresholds) {
  const chain = ["/", "/a", "/a/b", "/a/b/c", "/a/b/c/d", "/a/b/c/d/e"];
  const pages = [
    ...chain.map((path) => html(path)),
    html("/long-title", { title: "t".repeat(65), titleLength: 65 }),
    html("/thin", { words: 150 }),
    html("/slow", { responseTime: 1500 }),
  ];
  const links = [
    ...chain.slice(1).map((path, i) => edge(chain[i], path)),
    edge("/", "/long-title"), edge("/", "/thin"), edge("/", "/slow"),
  ];
  return buildFindings({ results: pages, linkEdges: links, resourceEdges: [], sitemapMembership: {}, siteDiagnostics: {}, startUrl: `${H}/`, thresholds }).findings;
}
const on = (findings, ruleId) => findings.filter((f) => f.ruleId === ruleId).map((f) => new URL(f.url).pathname).sort();

test("the defaults are the limits the checks always used", () => {
  const findings = analyse(undefined);
  assert.deepEqual(on(findings, "title-long"), ["/long-title"]);
  assert.deepEqual(on(findings, "low-word-count"), ["/thin"]);
  assert.deepEqual(on(findings, "slow-page"), ["/slow"]);
  assert.deepEqual(on(findings, "deep-page"), ["/a/b/c/d", "/a/b/c/d/e"]);
  assert.equal(findings.find((f) => f.ruleId === "title-long").detail, "65 characters");
});

test("a crawl's own thresholds decide instead, and the finding says which limit it used", () => {
  const findings = analyse({ titleMaxLength: 64, minWords: 100, slowResponseMs: 2000, maxClickDepth: 4 });
  assert.deepEqual(on(findings, "title-long"), ["/long-title"]);
  assert.equal(findings.find((f) => f.ruleId === "title-long").detail, "65 characters (this crawl's limit: 64)");
  assert.deepEqual(on(findings, "low-word-count"), []);
  assert.deepEqual(on(findings, "slow-page"), []);
  assert.deepEqual(on(findings, "deep-page"), ["/a/b/c/d/e"]);
  const deep = findings.find((f) => f.ruleId === "deep-page");
  assert.equal(deep.detail, "5 clicks from the start page (this crawl's limit: 4)");
  assert.match(deep.recommendation, /so it is 4 clicks or fewer from the start page\.$/);
  assert.deepEqual(on(analyse({ titleMaxLength: 70 }), "title-long"), []);
});

test("thresholds come with the crawl's options, bounded, and a blank one keeps its default", () => {
  const { options } = parseCrawlRequest({
    url: "https://example.com/",
    options: { thresholds: { titleMaxLength: "70", minWords: 0, slowResponseMs: "", maxClickDepth: 999, junk: 5 } },
  });
  assert.deepEqual(options.thresholds, {
    titleMinLength: 30, titleMaxLength: 70, metaMinLength: 70, metaMaxLength: 160, minWords: 1,
    slowResponseMs: 1000, maxClickDepth: 50, urlMaxLength: 200, maxLinksPerPage: 3000,
  });
});
