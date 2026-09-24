const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { robotsDirectivesFor, isNoindex, isNofollow } = require("../robots-directives");
const { buildFindings } = require("../analyzer");
const { SeoCrawler } = require("../crawler");

// The audit reports how GOOGLE will treat a page, so directives addressed to
// every crawler, to CrawlScope itself, or to Googlebot all apply; directives
// addressed to some other named crawler do not.
const AGENTS = ["crawlscope", "googlebot"];

test("directives are matched as whole tokens, not substrings", () => {
  // max-image-preview:none contains "none"; it was read as noindex + nofollow.
  const set = robotsDirectivesFor("index, follow, max-image-preview:none", AGENTS);
  assert.equal(isNoindex(set), false);
  assert.equal(isNofollow(set), false);
  assert.ok(set.has("max-image-preview:none"));
});

test("a directive addressed to another crawler does not apply", () => {
  assert.equal(isNoindex(robotsDirectivesFor("otherbot: noindex", AGENTS)), false);
  assert.equal(isNoindex(robotsDirectivesFor("bingbot: noindex, nofollow", AGENTS)), false);
  assert.equal(isNofollow(robotsDirectivesFor("bingbot: noindex, nofollow", AGENTS)), false);
});

test("a directive addressed to Googlebot or to CrawlScope applies, with its whole list", () => {
  const google = robotsDirectivesFor("googlebot: noindex, nofollow", AGENTS);
  assert.equal(isNoindex(google), true);
  assert.equal(isNofollow(google), true);
  assert.equal(isNoindex(robotsDirectivesFor("CrawlScope: noindex", AGENTS)), true);
  // googlebot-news is a different product; its directives do not govern web search.
  assert.equal(isNoindex(robotsDirectivesFor("googlebot-news: noindex", AGENTS)), false);
});

test("space- or semicolon-separated directives still count", () => {
  const set = robotsDirectivesFor("noindex nofollow", AGENTS);
  assert.equal(isNoindex(set), true);
  assert.equal(isNofollow(set), true);
  assert.equal(isNoindex(robotsDirectivesFor("noindex;follow", AGENTS)), true);
});

test("none means noindex and nofollow", () => {
  const set = robotsDirectivesFor("none", AGENTS);
  assert.equal(isNoindex(set), true);
  assert.equal(isNofollow(set), true);
});

test("unavailable_after in the past is a noindex, in the future it is not", () => {
  assert.equal(isNoindex(robotsDirectivesFor("unavailable_after: 25 Jun 2010 15:00:00 PST", AGENTS)), true);
  assert.equal(isNoindex(robotsDirectivesFor("unavailable_after: 2999-01-01", AGENTS)), false);
});

const page = (url, extra = {}) => ({
  url, scope: "Internal", status: 200, contentType: "text/html", title: "A reasonable page title here",
  titleCount: 1, titleLength: 30, metaDescription: "d".repeat(120), metaLength: 120,
  viewport: "width=device-width", h1Count: 1, h1: `H ${url}`, words: 400, textHtmlRatio: 0.3,
  canonical: url, hreflangs: [], robots: "", indexability: "Indexable", inlinks: 3, depth: 1,
  hash: url, responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [],
  openGraphInvalidUrls: [], ...extra,
});

test("the analyzer does not report noindex for max-image-preview:none or another bot's header", () => {
  const H = "https://example.com";
  const { findings } = buildFindings({
    results: [
      page(`${H}/`),
      page(`${H}/preview`, { robots: "index, follow, max-image-preview:none" }),
      page(`${H}/scoped`, { robots: "otherbot: noindex" }),
      page(`${H}/stored`, { robots: "otherbot: noindex", robotsDirectives: [] }),
      page(`${H}/real`, { robots: "noindex", robotsDirectives: ["noindex"], indexability: "Non-indexable" }),
    ],
    startUrl: `${H}/`,
    sitemapsChecked: false,
  });
  const rules = (path) => findings.filter((f) => f.url === `${H}${path}`).map((f) => f.ruleId);
  for (const path of ["/preview", "/scoped", "/stored"]) {
    for (const rule of ["noindex", "nofollow-page", "noindex-nofollow"]) {
      assert.ok(!rules(path).includes(rule), `${path} must not be reported as ${rule}`);
    }
  }
  assert.ok(rules("/real").includes("noindex"));
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("the crawler reads every robots meta tag and ignores other bots' headers", async (t) => {
  const html = (head) => `<!doctype html><html><head><title>Robots fixture page</title>${head}</head><body><h1>Robots</h1></body></html>`;
  const routes = {
    "/second-tag": { head: '<meta name="robots" content="index, follow"><meta name="robots" content="noindex">' },
    "/preview": { head: '<meta name="robots" content="max-image-preview:none">' },
    "/otherbot": { head: "", headers: { "X-Robots-Tag": "otherbot: noindex" } },
    "/googlebot-header": { head: "", headers: { "X-Robots-Tag": "googlebot: noindex" } },
    "/googlebot-meta": { head: '<meta name="googlebot" content="noindex">' },
  };
  const server = http.createServer((request, response) => {
    const route = routes[request.url];
    response.statusCode = route ? 200 : 404;
    response.setHeader("Content-Type", "text/html");
    for (const [name, value] of Object.entries(route?.headers || {})) response.setHeader(name, value);
    response.end(route ? html(route.head) : "nope");
  });
  t.after(() => server.close());
  const port = await listen(server);
  const crawler = new SeoCrawler({ maxUrls: 10, respectRobots: false, timeout: 5_000 });
  const summary = await crawler.start(Object.keys(routes).map((p) => `http://127.0.0.1:${port}${p}`));
  const at = (p) => summary.results.find((r) => r.url.endsWith(p));

  assert.equal(at("/second-tag").indexability, "Non-indexable", "a noindex in a second robots tag applies");
  assert.equal(at("/preview").indexability, "Indexable");
  assert.equal(at("/otherbot").indexability, "Indexable");
  assert.equal(at("/googlebot-header").indexability, "Non-indexable");
  assert.equal(at("/googlebot-header").indexabilityReason, "X-Robots-Tag contains noindex");
  assert.equal(at("/googlebot-meta").indexability, "Non-indexable");
  assert.deepEqual(at("/preview").robotsDirectives, ["max-image-preview:none"]);
});
