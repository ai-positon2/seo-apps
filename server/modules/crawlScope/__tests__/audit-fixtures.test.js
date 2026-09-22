// Regression tests for defects the audit loop found on real crawls. Each test
// names its defect id and loads its fixture from ./fixtures, so a failure here
// points back at the finding in .audit-runs/<date>/<domain>/findings.json.

const test = require("node:test");
const assert = require("node:assert/strict");
const { SeoCrawler } = require("../crawler");
const { buildFindings } = require("../analyzer");
const { httpFixture, jsonFixture, serve, page } = require("./fixtures");

// An extracted result for the analyzer: a healthy, indexable, self-canonical
// HTML page unless the fixture says otherwise.
function resultFor(overrides) {
  return {
    scope: "Internal",
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    depth: 1,
    title: "A perfectly fine title for this page",
    titleCount: 1,
    titleLength: 37,
    metaDescription: "A sufficiently long meta description for this fixture page, long enough to pass.",
    metaLength: 82,
    viewport: "width=device-width, initial-scale=1",
    h1Count: 1,
    h1: "A perfectly fine heading",
    words: 400,
    textHtmlRatio: 0.2,
    headingHierarchyIssues: [],
    indexability: "Indexable",
    robots: "",
    inlinks: 2,
    isAsset: false,
    openGraphMissing: [],
    openGraphInvalidUrls: [],
    schemaErrors: [],
    hreflangs: [],
    paginationNext: "",
    paginationPrev: "",
    ...overrides,
    canonical: overrides.canonical ?? overrides.url,
    titleLength: (overrides.title ?? "A perfectly fine title for this page").length,
    hash: `hash:${overrides.url}`,
  };
}

function findingsFor(fixture, extra = {}) {
  const sitemapMembership = Object.fromEntries(
    (fixture.sitemap || []).map((url) => [url, [`${fixture.startUrl}sitemap.xml`]]),
  );
  return buildFindings({
    results: fixture.results.map(resultFor),
    sitemapMembership,
    startUrl: fixture.startUrl,
    ...extra,
  });
}

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

// ── D2 · www.brushandfloss.com, 2026-09-23 ────────────────────────────────────
// 37 of 38 sitemap-missing-indexable ERRORS were Webflow pagination pages
// (?<id>_page=2), with the advice to add them to the sitemap. The pages of a
// listing past the first are reached through the listing's own pagination
// links and are normally left out of a sitemap, so their absence is not an
// error. Their duplicated title/description/H1 are still reported by the
// duplicate rules.

test("D2: paginated listing pages are not reported as missing from the sitemap", () => {
  const fixture = jsonFixture("sitemap-missing-indexable__D2.json");
  const { findings } = findingsFor(fixture);
  assert.deepEqual(
    findings
      .filter((f) => f.ruleId === "sitemap-missing-indexable")
      .map((f) => f.url)
      .sort(),
    fixture.expectedMissing,
  );
});

test("D2: a page carrying rel=prev is a later page of a series, whatever its URL", () => {
  const { findings } = findingsFor({
    startUrl: "https://practice.example/",
    sitemap: ["https://practice.example/", "https://practice.example/news"],
    results: [
      { url: "https://practice.example/", title: "Home | Practice" },
      { url: "https://practice.example/news", title: "News | Practice" },
      {
        url: "https://practice.example/news/older",
        title: "News | Practice",
        paginationPrev: "https://practice.example/news",
      },
    ],
  });
  assert.deepEqual(findings.filter((f) => f.ruleId === "sitemap-missing-indexable"), []);
});

// ── D4 · www.brushandfloss.com, 2026-09-23 ────────────────────────────────────
// /search is in the sitemap and disallowed by robots.txt, so it was never
// fetched. sitemap-incorrect-url described it as "HTTP unreachable" and told
// the reader it "returns HTTP no response" — it serves 200 to a browser. The
// URL does not belong in the sitemap, but for a different reason, and a reader
// following that text looks for an outage.

test("D4: a sitemap URL blocked by robots.txt is described as blocked, not unreachable", () => {
  const { findings } = findingsFor(jsonFixture("sitemap-incorrect-url__D4.json"));
  const byUrl = new Map(
    findings.filter((f) => f.ruleId === "sitemap-incorrect-url").map((f) => [new URL(f.url).pathname, f]),
  );

  const blocked = byUrl.get("/search");
  assert.ok(blocked, "a robots-blocked sitemap URL is still reported");
  assert.match(blocked.detail, /robots\.txt/);
  assert.doesNotMatch(`${blocked.detail} ${blocked.recommendation}`, /unreachable|no response/i);
  assert.match(blocked.recommendation, /robots\.txt/);

  const failed = byUrl.get("/gone");
  assert.ok(failed, "a sitemap URL that could not be fetched is still reported");
  assert.equal(failed.detail, "HTTP unreachable");
});

// ── D8 · www.brushandfloss.com, 2026-09-23 ────────────────────────────────────
// The export's "Checks Passed" sheet counts every Automatic rule without a
// finding as clean. Eight had not run: orphan-page and single-inlink are
// switched off on a truncated crawl, and six asset checks had no internal
// asset to look at (Webflow serves every asset from its CDN). The client was
// told image-oversized passed while two CDN images were over the limit.

test("D8: the analyzer names the checks it could not evaluate, with the reason", () => {
  const fixture = jsonFixture("checks-passed__D8.json");
  const { notEvaluated } = findingsFor(fixture, { crawlTruncated: fixture.crawlTruncated });
  assert.deepEqual(notEvaluated.map((entry) => entry.ruleId).sort(), fixture.expectedNotEvaluated);
  assert.ok(notEvaluated.every((entry) => entry.reason), "every entry says why");

  const complete = findingsFor(
    {
      startUrl: "https://practice.example/",
      results: [
        { url: "https://practice.example/" },
        { url: "https://practice.example/app.js", contentType: "application/javascript", isAsset: true },
        { url: "https://practice.example/site.css", contentType: "text/css", isAsset: true },
        { url: "https://practice.example/hero.jpg", contentType: "image/jpeg", isAsset: true },
      ],
    },
    { crawlTruncated: false },
  );
  assert.deepEqual(complete.notEvaluated, [], "a complete crawl with internal assets evaluates everything");
});

test("D8: 'Checks Passed' leaves checks that did not run out of the ratio and says so", async () => {
  const ExcelJS = require("exceljs");
  const { buildAuditWorkbook } = require("../report-writer");
  const catalog = require("../issue-catalog.json");
  const notEvaluated = [
    { ruleId: "orphan-page", reason: "Switched off on a truncated crawl" },
    { ruleId: "image-oversized", reason: "No internal images were fetched" },
  ];

  const buffer = await buildAuditWorkbook({
    findings: [],
    catalog,
    notEvaluated,
    siteUrl: "https://practice.example/",
    crawlDate: "2026-09-23T00:00:00.000Z",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Checks Passed");

  const automatic = catalog.filter((c) => c.detection === "Automatic").length;
  assert.equal(
    sheet.getCell("A1").value,
    `${automatic - 2} of ${automatic - 2} automatic checks clean (2 not evaluated this run)`,
  );
  const rows = [];
  sheet.eachRow((row) => rows.push(row.values.slice(1).map((v) => String(v ?? ""))));
  const orphanTitle = catalog.find((c) => c.id === "orphan-page").title;
  const orphanRows = rows.filter((cells) => cells[0] === orphanTitle);
  assert.equal(orphanRows.length, 1, "listed once, as not evaluated, never among the clean checks");
  assert.match(orphanRows[0].join(" | "), /Not evaluated/);
  assert.match(orphanRows[0].join(" | "), /truncated crawl/);
});

test("D8: the list travels from the crawl to the stored report", async (t) => {
  const site = await serve((origin) => ({
    "/robots.txt": httpFixture("sitemap-robots-config__D1.http", { ORIGIN: origin }),
    "/sitemap.xml": sitemapOf(Array.from({ length: 12 }, (_, i) => `${origin}/page-${i}`)),
    "/": page({ title: "Home" }),
  }));
  t.after(site.close);
  const payload = await crawl(site.origin, { maxUrls: 5 });
  assert.equal(payload.truncated, true);
  assert.ok(
    payload.notEvaluated.some((entry) => entry.ruleId === "orphan-page"),
    "the crawl payload carries the analyzer's list",
  );

  const ExcelJS = require("exceljs");
  const report = require("../run/report");
  const buffer = await report.buildReportBuffer({
    findings: payload.findings,
    notEvaluated: payload.notEvaluated,
    siteUrl: site.origin,
    crawlDate: "2026-09-23T00:00:00.000Z",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const title = String(workbook.getWorksheet("Checks Passed").getCell("A1").value);
  assert.ok(
    title.endsWith(`(${payload.notEvaluated.length} not evaluated this run)`),
    `title: ${title}`,
  );
});

// ── D14 · www.brushandfloss.com, 2026-09-23 ───────────────────────────────────
// open-graph-description-missing only runs when every required Open Graph
// property is present, and open-graph-incomplete listed only the required
// ones — so on a page missing both, og:description was reported nowhere.

test("D14: a page missing required Open Graph properties also names a missing og:description", () => {
  const { findings } = findingsFor(jsonFixture("open-graph-description-missing__D14.json"));
  const incomplete = new Map(
    findings.filter((f) => f.ruleId === "open-graph-incomplete").map((f) => [new URL(f.url).pathname, f]),
  );

  const articles = incomplete.get("/articles");
  assert.match(articles.detail, /og:description \(recommended\)/);
  assert.match(articles.detectedValue, /og:description \(recommended\)/);
  assert.equal(articles.evidenceKey, "og:image,og:type,og:url", "root-cause grouping still keys on required properties");

  assert.doesNotMatch(incomplete.get("/locations").detail, /og:description/, "only when it is actually missing");
  assert.deepEqual(
    findings.filter((f) => f.ruleId === "open-graph-description-missing").map((f) => new URL(f.url).pathname),
    ["/careers"],
    "the standalone rule still covers pages whose required properties are complete",
  );
});

// ── D9 · www.brushandfloss.com, 2026-09-23 ────────────────────────────────────
// 21 /dental-services/* pages render <title></title>. The finding carried no
// evidence at all, so someone checking view-source saw a <title> element and
// had no way to tell the tool meant "empty" rather than "absent".

test("D9: title-missing says whether the title element is empty or absent", async (t) => {
  const site = await serve(() => ({
    "/": page({
      title: "Fixture home",
      body: '<a href="/dental-services/invisalign-teen">Invisalign Teen</a> <a href="/no-title">No title</a>',
    }),
    "/dental-services/invisalign-teen": httpFixture("title-missing__D9.http"),
    "/no-title": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width\"></head><body><h1>No title element</h1></body></html>",
    },
  }));
  t.after(site.close);

  const payload = await crawl(site.origin, { maxUrls: 10, respectRobots: false, discoverSitemaps: false });
  const byPath = Object.fromEntries(
    payload.findings
      .filter((f) => f.ruleId === "title-missing")
      .map((f) => [new URL(f.url).pathname, f.detectedValue]),
  );
  assert.deepEqual(byPath, {
    "/dental-services/invisalign-teen": "<title> present but empty",
    "/no-title": "No <title> element",
  });
});

// ── D10 · www.brushandfloss.com, 2026-09-23 ───────────────────────────────────
// A sitemap entry that 301s got two errors — sitemap-redirect and
// sitemap-incorrect-url — and the one saying "replace it with its final
// destination" did not say what the destination was.

test("D10: a redirecting sitemap entry is one sitemap-redirect finding that names its destination", () => {
  const { findings } = findingsFor(jsonFixture("sitemap-redirect__D10.json"));
  const entry = "https://practice.example/dental-services/prosthodontics";
  const onEntry = findings.filter((f) => f.url === entry && f.ruleId.startsWith("sitemap-"));
  assert.deepEqual(onEntry.map((f) => f.ruleId), ["sitemap-redirect"]);
  assert.equal(onEntry[0].targetUrl, "https://practice.example/category/prosthodontics");
  assert.equal(onEntry[0].detectedValue, "301 -> https://practice.example/category/prosthodontics");
});

test("D10: a redirecting sitemap entry whose destination is broken still gets sitemap-incorrect-url", () => {
  const fixture = jsonFixture("sitemap-redirect__D10.json");
  fixture.results = fixture.results.map((result) =>
    result.url.endsWith("/category/prosthodontics")
      ? { ...result, status: 404, statusText: "Not Found", indexability: "Non-indexable" }
      : result,
  );
  const { findings } = findingsFor(fixture);
  const incorrect = findings.find(
    (f) => f.ruleId === "sitemap-incorrect-url" && f.url.endsWith("/dental-services/prosthodontics"),
  );
  assert.ok(incorrect, "the broken destination is what makes this entry incorrect");
  assert.match(incorrect.recommendation, /broken destination/);
});

// ── D12 · www.brushandfloss.com, 2026-09-23 ───────────────────────────────────
// <h1>Patient<br/>Reviews</h1> was reported as the heading "PatientReviews"
// (and "Find a RiccobeneLocation Near You"): text either side of a line break
// or a block child was joined with no space, in text that reaches the client.

test("D12: heading text keeps the word boundary at a line break or block child", async (t) => {
  const site = await serve(() => ({
    "/": page({ title: "Fixture home", body: '<a href="/reviews">Reviews</a>' }),
    "/reviews": httpFixture("h1-duplicate__D12.http"),
  }));
  t.after(site.close);

  const payload = await crawl(site.origin, { maxUrls: 5, respectRobots: false, discoverSitemaps: false });
  const reviews = payload.results.find((r) => r.url.endsWith("/reviews"));
  assert.equal(reviews.h1, "Patient Reviews");
  assert.deepEqual(
    reviews.headingHierarchyIssues,
    [],
    "fixture headings are in order; this only checks extraction does not break",
  );
  const texts = payload.results
    .filter((r) => r.url.endsWith("/reviews"))
    .flatMap((r) => [r.h1, r.h2]);
  assert.ok(
    texts.includes("What patients say about BrushandFloss | Find a Riccobene Location Near You"),
    `inline children stay joined, block children are separated: ${JSON.stringify(texts)}`,
  );
});

// ── D13 · www.brushandfloss.com, 2026-09-23 ───────────────────────────────────
// schema-error said "Organization is missing the required name property".
// Google's Organization docs say "There are no required properties", and so do
// its Article docs, for which headline/image/datePublished were also called
// required. LocalBusiness (name, address) and Product (name) genuinely are
// required and keep the word. Checked against developers.google.com 2026-09-23.

test("D13: schema-error calls a property required only where Google requires it", async (t) => {
  const site = await serve((origin) => ({
    "/": page({ title: "Fixture home", body: '<a href="/locations/harrisburg">Harrisburg</a>' }),
    "/locations/harrisburg": httpFixture("schema-error__D13.http", { ORIGIN: origin }),
  }));
  t.after(site.close);

  const payload = await crawl(site.origin, { maxUrls: 5, respectRobots: false, discoverSitemaps: false });
  const errors = payload.results.find((r) => r.url.endsWith("/locations/harrisburg")).schemaErrors;
  assert.deepEqual(errors.slice().sort(), [
    "BlogPosting is missing the recommended datePublished property",
    "BlogPosting is missing the recommended headline property",
    "BlogPosting is missing the recommended image property",
    "Dentist is missing the required address property",
    "Organization is missing the recommended name property",
  ]);
});
