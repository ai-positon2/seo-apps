// Regression tests for defects the audit loop found on real crawls. Each test
// names its defect id and loads its fixture from ./fixtures, so a failure here
// points back at the finding in .audit-runs/<date>/<domain>/findings.json.

const test = require("node:test");
const assert = require("node:assert/strict");
const { SeoCrawler } = require("../crawler");
const { httpFixture, serve, page } = require("./fixtures");

const sitemapOf = (urls) => ({
  status: 200,
  headers: { "content-type": "application/xml" },
  body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((url) => `<url><loc>${url}</loc></url>`)
    .join("")}</urlset>`,
});

const crawl = (origin, options) =>
  new SeoCrawler({
    concurrency: 2,
    perHostDelay: 0,
    crawlAssets: false,
    checkExternalLinks: false,
    ...options,
  }).start(`${origin}/`);

// ── D1 · www.brushandfloss.com, 2026-09-23 ────────────────────────────────────
// robots.txt declared the sitemap correctly, but the sitemap listed 569 URLs
// against a 500-URL budget, and the crawl reported "Only 386 of 569 sitemap
// URLs fitted within the crawl budget" as the sitemap-robots-config ERROR,
// recommending a robots.txt line that was already there.

test("D1: a sitemap larger than the crawl budget is crawl coverage, not a robots.txt sitemap error", async (t) => {
  const site = await serve((origin) => {
    const urls = Array.from({ length: 12 }, (_, i) => `${origin}/page-${i}`);
    return {
      "/robots.txt": httpFixture("sitemap-robots-config__D1.http", { ORIGIN: origin }),
      "/sitemap.xml": sitemapOf(urls),
      "/": page({ title: "Home" }),
      ...Object.fromEntries(urls.map((url, i) => [new URL(url).pathname, page({ title: `Page ${i}` })])),
    };
  });
  t.after(site.close);

  const payload = await crawl(site.origin, { maxUrls: 5 });

  assert.equal(payload.truncated, true, "the budget still truncates the crawl");
  assert.deepEqual(
    payload.findings.filter((f) => f.ruleId === "sitemap-robots-config").map((f) => f.detail),
    [],
    "robots.txt declares a readable sitemap, so there is no sitemap configuration problem",
  );
  const coverage = payload.siteDiagnostics.sitemapCoverage;
  assert.equal(coverage.listed, 12);
  assert.equal(coverage.budgetLimited, true);
  assert.ok(coverage.queued < 12, `queued ${coverage.queued} of 12`);
});

// The same message fired with no budget pressure at all: sitemap URLs the
// homepage already links to are seen before seeding runs, so "seeded" came up
// short on every ordinary site. Measured at a9dfc0f: a two-page site whose
// sitemap lists its homepage and one linked page reported "Only 0 of 2 sitemap
// URLs fitted within the crawl budget" as an error, with a budget of 20.
test("D1: sitemap URLs already discovered through links are not a budget shortfall", async (t) => {
  const site = await serve((origin) => ({
    "/robots.txt": httpFixture("sitemap-robots-config__D1.http", { ORIGIN: origin }),
    "/sitemap.xml": sitemapOf([`${origin}/`, `${origin}/a`]),
    "/": page({ title: "Home", body: '<a href="/a">A page</a>' }),
    "/a": page({ title: "A" }),
  }));
  t.after(site.close);

  const payload = await crawl(site.origin, { maxUrls: 20 });

  assert.equal(payload.truncated, false);
  assert.deepEqual(
    payload.findings.filter((f) => f.ruleId === "sitemap-robots-config").map((f) => f.detail),
    [],
  );
  assert.deepEqual(
    { ...payload.siteDiagnostics.sitemapCoverage },
    { listed: 2, queued: 2, budgetLimited: false, traversalStopped: false, documentsNotRead: 0 },
  );
});

test("D1: stopping sitemap traversal at the document cap is crawl coverage, not a robots.txt sitemap error", async (t) => {
  const site = await serve((origin) => ({
    "/robots.txt": httpFixture("sitemap-robots-config__D1.http", { ORIGIN: origin }),
    "/sitemap.xml": {
      status: 200,
      headers: { "content-type": "application/xml" },
      body: `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap-a.xml</loc></sitemap><sitemap><loc>${origin}/sitemap-b.xml</loc></sitemap></sitemapindex>`,
    },
    "/sitemap-a.xml": sitemapOf([`${origin}/a`]),
    "/sitemap-b.xml": sitemapOf([`${origin}/b`]),
    "/": page({ title: "Home" }),
    "/a": page({ title: "A" }),
    "/b": page({ title: "B" }),
  }));
  t.after(site.close);

  const payload = await crawl(site.origin, { maxUrls: 20, maxSitemapDocuments: 1 });

  assert.deepEqual(
    payload.findings.filter((f) => f.ruleId === "sitemap-robots-config").map((f) => f.detail),
    [],
  );
  assert.equal(payload.siteDiagnostics.sitemapCoverage.traversalStopped, true);
  assert.equal(payload.siteDiagnostics.sitemapCoverage.documentsNotRead, 2);
});

test("D1: a sitemap robots.txt does not declare is still reported", async (t) => {
  const site = await serve((origin) => ({
    "/robots.txt": { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /search\n" },
    "/sitemap.xml": sitemapOf([`${origin}/a`]),
    "/": page({ title: "Home" }),
    "/a": page({ title: "A" }),
  }));
  t.after(site.close);

  const payload = await crawl(site.origin, { maxUrls: 20 });

  assert.deepEqual(
    payload.findings.filter((f) => f.ruleId === "sitemap-robots-config").map((f) => f.detail),
    ["A sitemap was found, but robots.txt does not declare it."],
  );
});

// ── D3 · www.brushandfloss.com, 2026-09-23 ────────────────────────────────────
// slow-page fired on 461 of 482 pages. The pages answered in ~0.2s; the crawl
// recorded ~1.9s because the timer started before the per-host politeness
// queue (perHostDelay 500 on every production crawl), so it measured the
// crawler waiting for its own turn.

test("D3: responseTime measures the server, not the crawler's per-host queue", async (t) => {
  const pagePaths = ["/p1", "/p2", "/p3", "/p4", "/p5", "/p6"];
  const site = await serve(
    () => ({
      "/": page({
        title: "Fixture home",
        body: pagePaths.map((p) => `<a href="${p}">Fixture page ${p}</a>`).join(""),
      }),
      ...Object.fromEntries(pagePaths.map((p) => [p, httpFixture("slow-page__D3.http")])),
    }),
    { delayMs: 20 },
  );
  t.after(site.close);

  const payload = await crawl(site.origin, {
    maxUrls: 10,
    concurrency: 4,
    perHostDelay: 300,
    respectRobots: false,
    discoverSitemaps: false,
  });

  const pages = payload.results.filter((r) => r.status === 200);
  assert.equal(pages.length, 7);
  const times = pages.map((r) => [new URL(r.url).pathname, r.responseTime]);
  assert.ok(
    times.every(([, ms]) => ms < 250),
    `a 20ms server must not read as slower than 250ms: ${JSON.stringify(times)}`,
  );
  assert.deepEqual(payload.findings.filter((f) => f.ruleId === "slow-page").map((f) => f.url), []);
});

// ── D5 · www.brushandfloss.com, 2026-09-23 ────────────────────────────────────
// 88 https-to-http-link findings said Google's review links "returned 200
// without a direct HTTPS redirect". They answer HEAD with 200 and GET with a
// 302 to https — and the crawler only ever asked with HEAD. Whether an http:
// link upgrades is a question about the navigation a browser makes, which is
// a GET.

const asResponse = ({ status, headers, body }, method) =>
  new Response(method === "HEAD" || !body ? null : body, { status, headers });

test("D5: an http: link target is judged by the GET a navigation makes, not a HEAD probe", async () => {
  const REVIEW = "http://search.google.com/local/writereview?placeid=ChIJe1-xszlrAIkRxqQOpFn11fA";
  const PLAIN = "http://plain-http.test/partner";
  const requests = [];
  const payload = await new SeoCrawler({
    maxUrls: 5,
    maxExternalUrls: 10,
    concurrency: 2,
    perHostDelay: 0,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: true,
    fetch: async (url, init = {}) => {
      const method = init.method || "GET";
      requests.push(`${method} ${url}`);
      if (url === "https://practice.test/") {
        return new Response(
          `<!doctype html><html><head><title>Patient reviews</title></head><body><h1>Reviews</h1><a href="${REVIEW}">Leave a review</a> <a href="${PLAIN}">Our partner</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url === REVIEW) {
        return asResponse(
          httpFixture(method === "HEAD" ? "https-to-http-link__D5.head.http" : "https-to-http-link__D5.get.http"),
          method,
        );
      }
      if (url === PLAIN) {
        return new Response(method === "HEAD" ? null : "<html><body>Plain HTTP only</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "http://practice.test/") {
        return new Response(null, { status: 301, headers: { location: "https://practice.test/" } });
      }
      return new Response(null, { status: 404 });
    },
  }).start("https://practice.test/");

  const review = payload.results.find((r) => r.url === REVIEW);
  assert.equal(review.status, 302, `recorded as what a navigation gets; requests: ${requests.join(", ")}`);
  assert.deepEqual(
    payload.findings
      .filter((f) => f.ruleId === "https-to-http-link")
      .map((f) => [f.targetUrl, f.detectedValue]),
    [[PLAIN, "HTTP 200 without HTTPS upgrade"]],
    "only the destination that really stays on HTTP is reported",
  );
});
