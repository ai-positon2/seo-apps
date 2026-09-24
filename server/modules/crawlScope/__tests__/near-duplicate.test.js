const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { contentSignature, signatureSimilarity } = require("../text-fingerprint");
const { buildFindings } = require("../analyzer");
const { SeoCrawler } = require("../crawler");

// Only byte-identical visible text was a duplicate, nav and footer included:
// two product pages differing in one word, or one page with a different
// sidebar, were "unique". Semrush reports pages that are mostly the same.
const article = Array.from({ length: 120 }, (_, i) => `word${i % 37} topic${i % 11} detail${i % 5}`).join(" ");

test("near-identical text has a near-identical fingerprint, different text does not", () => {
  const a = contentSignature(article);
  const b = contentSignature(article.replace("word3 topic3", "word3 topicX"));
  const c = contentSignature(Array.from({ length: 120 }, (_, i) => `other${i % 29} thing${i % 13} part${i % 7}`).join(" "));
  assert.ok(signatureSimilarity(a, b) >= 0.85, `similarity ${signatureSimilarity(a, b)}`);
  assert.ok(signatureSimilarity(a, c) < 0.3, `similarity ${signatureSimilarity(a, c)}`);
  assert.equal(signatureSimilarity(a, a), 1);
  assert.equal(contentSignature(""), "");
});

const H = "https://example.com";
const page = (path, extra = {}) => ({
  url: `${H}${path}`, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: `A reasonable title for ${path} in the fixture`, titleCount: 1, titleLength: 40,
  metaDescription: `A description long enough to pass the meta length checks for ${path}.`,
  metaLength: 90, viewport: "width=device-width", h1Count: 1, h1: `H1 ${path}`, words: 400,
  canonical: `${H}${path}`, hreflangs: [], robots: "", indexability: "Indexable", depth: 1, hash: path,
  mainWords: 360, responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [], openGraphInvalidUrls: [],
  ...extra,
});

test("pages whose main content is nearly the same are reported, exact copies are not reported twice", () => {
  const a = contentSignature(article);
  const near = contentSignature(article.replace("word3 topic3", "word3 topicX"));
  const far = contentSignature(Array.from({ length: 120 }, (_, i) => `other${i % 29} thing${i % 13} part${i % 7}`).join(" "));
  const { findings } = buildFindings({
    results: [
      page("/"),
      page("/a", { contentSignature: a }),
      page("/b", { contentSignature: near }),
      page("/c", { contentSignature: far }),
      page("/exact-1", { contentSignature: a, hash: "same-text" }),
      page("/exact-2", { contentSignature: a, hash: "same-text" }),
      page("/thin", { contentSignature: near, mainWords: 20 }),
      page("/canonicalised", { contentSignature: a, canonical: `${H}/a` }),
    ],
    linkEdges: [],
    startUrl: `${H}/`,
    sitemapsChecked: false,
  });
  const near_ = findings.filter((f) => f.ruleId === "content-duplicate-near");
  const byUrl = new Map(near_.map((f) => [new URL(f.url).pathname, f]));
  assert.deepEqual([...byUrl.keys()].sort(), ["/a", "/b", "/exact-1", "/exact-2"]);
  assert.match(byUrl.get("/b").detail, /^Main content \d+% the same as https:\/\/example\.com\/(a|exact-1|exact-2), one of 4 near-identical pages$/);
  // The exact pair is near /a and /b, but never reported as near each other.
  assert.ok(!near_.some((f) => f.url.endsWith("/exact-1") && f.targetUrl.endsWith("/exact-2")));
});

test("the crawler fingerprints main content, not the navigation around it", async (t) => {
  const shell = (nav, main) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Near duplicate fixture ${nav}</title></head>
    <body><nav>${Array.from({ length: 60 }, (_, i) => `<a href="/n${i}">${nav} menu entry ${i}</a>`).join("")}</nav>
    <main><h1>Guide</h1><p>${main}</p></main><footer>${nav} footer text that differs between the pages</footer></body></html>`;
  const pages = {
    "/": '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Near duplicate fixture home page</title></head><body><a href="/guide">Guide</a><a href="/guide-copy">Copy</a></body></html>',
    "/guide": shell("alpha", article),
    "/guide-copy": shell("beta", article.replace("word3 topic3", "word3 topicX")),
  };
  const server = http.createServer((request, response) => {
    const body = pages[request.url];
    response.statusCode = body ? 200 : 404;
    response.setHeader("Content-Type", "text/html");
    response.end(body || "<html><head><title>Not found</title></head><body>Not found</body></html>");
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const summary = await new SeoCrawler({
    maxUrls: 5, concurrency: 1, respectRobots: false, discoverSitemaps: false, crawlAssets: false,
    checkExternalLinks: false, timeout: 5_000, perHostDelay: 0,
  }).start(`${base}/`);
  const guide = summary.results.find((r) => r.url === `${base}/guide`);
  assert.equal(guide.mainWords, 361);
  const near = summary.findings.filter((f) => f.ruleId === "content-duplicate-near").map((f) => new URL(f.url).pathname).sort();
  assert.deepEqual(near, ["/guide", "/guide-copy"]);
});
