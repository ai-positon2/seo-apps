const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings } = require("../analyzer");

function baseResult(overrides = {}) {
  return {
    url: "https://example.com/page",
    scope: "Internal",
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    size: 50_000,
    depth: 1,
    title: "A perfectly fine title for this page",
    titleCount: 1,
    titleLength: 37,
    metaDescription: "A sufficiently long meta description for this fixture page.",
    metaLength: 61,
    viewport: "width=device-width, initial-scale=1",
    h1Count: 1,
    h1: "A perfectly fine heading",
    h2Count: 0,
    words: 400,
    textHtmlRatio: 0.2,
    headingHierarchyIssue: false,
    headingHierarchyIssues: [],
    indexability: "Indexable",
    canonical: "https://example.com/page",
    robots: "",
    inlinks: 2,
    fromSitemap: true,
    isAsset: false,
    openGraphMissing: [],
    openGraphInvalidUrls: [],
    openGraphImageProperty: "",
    openGraphImageUrl: "",
    openGraphImageRaw: "",
    openGraphImageAlt: "",
    openGraphImageAltMissing: false,
    openGraphDescriptionMissing: false,
    ogUrlRaw: "",
    schemaErrors: [],
    hreflangs: [],
    paginationNext: "",
    paginationPrev: "",
    hash: `unique-page-hash:${overrides.url || "https://example.com/page"}`,
    contentSample: "A representative sample of this page's visible body text.",
    ...overrides,
  };
}

function httpRedirectPath(prefix, redirectCount) {
  const urls = Array.from(
    { length: redirectCount + 1 },
    (_, index) => `${prefix}-${index}`,
  );
  const results = urls.map((url, index) =>
    index < redirectCount
      ? baseResult({
          url,
          status: 302,
          statusText: "Found",
          canonical: "",
          redirectUrl: urls[index + 1],
        })
      : baseResult({ url, canonical: url }),
  );
  return { urls, results };
}

test("https-to-http links use checked target evidence and suppress direct HTTPS upgrades", () => {
  const source = baseResult({ url: "https://example.com/source" });
  const directUpgrade = baseResult({
    url: "http://example.com/upgrades",
    status: 301,
    statusText: "Moved Permanently",
    redirectUrl: "https://example.com/upgrades",
    canonical: "",
  });
  const httpOnly = baseResult({
    url: "http://external.test/http-only",
    scope: "External",
    status: 200,
    canonical: "",
  });
  const httpRedirect = baseResult({
    url: "http://external.test/redirects-over-http",
    scope: "External",
    status: 302,
    redirectUrl: "http://external.test/still-http",
    canonical: "",
  });
  const failedCheck = baseResult({
    url: "http://external.test/timed-out",
    scope: "External",
    status: 0,
    statusText: "Timed out",
    canonical: "",
  });
  const downloadUpgrade = baseResult({
    url: "http://external.test/download",
    scope: "External",
    status: 307,
    redirectUrl: "https://external.test/download",
    canonical: "",
  });
  const multipleChoices = baseResult({
    url: "http://external.test/multiple-choices",
    scope: "External",
    status: 300,
    redirectUrl: "https://external.test/chosen",
    canonical: "",
  });
  const linkEdges = [
    {
      sourceUrl: source.url,
      targetUrl: directUpgrade.url,
      internal: true,
      anchorText: "Checked direct upgrade",
    },
    {
      sourceUrl: source.url,
      targetUrl: httpOnly.url,
      internal: false,
      anchorText: "Verified HTTP destination",
    },
    {
      sourceUrl: source.url,
      targetUrl: httpRedirect.url,
      internal: false,
      anchorText: "HTTP redirect",
    },
    {
      sourceUrl: source.url,
      targetUrl: failedCheck.url,
      internal: false,
      anchorText: "Unavailable HTTP destination",
    },
    {
      sourceUrl: source.url,
      targetUrl: "http://unchecked.test/page",
      internal: false,
      anchorText: "Unchecked HTTP destination",
    },
    {
      sourceUrl: source.url,
      targetUrl: downloadUpgrade.url,
      internal: false,
      download: true,
      anchorText: "Download over HTTP",
    },
    {
      sourceUrl: source.url,
      targetUrl: multipleChoices.url,
      internal: false,
      anchorText: "Multiple choices over HTTP",
    },
    {
      sourceUrl: source.url,
      targetUrl: "https://secure.test/page",
      internal: false,
      anchorText: "HTTPS destination",
    },
  ];

  const { findings } = buildFindings({
    results: [
      source,
      directUpgrade,
      httpOnly,
      httpRedirect,
      failedCheck,
      downloadUpgrade,
      multipleChoices,
    ],
    linkEdges,
    startUrl: source.url,
  });
  const httpFindings = findings.filter(
    (finding) => finding.ruleId === "https-to-http-link",
  );
  const byTarget = new Map(
    httpFindings.map((finding) => [finding.targetUrl, finding]),
  );

  assert.equal(httpFindings.length, 6);
  assert.ok(!byTarget.has(directUpgrade.url));
  assert.equal(
    byTarget.get(httpOnly.url).detectedValue,
    "HTTP 200 without HTTPS upgrade",
  );
  assert.equal(byTarget.get(httpOnly.url).statusCode, 200);
  assert.equal(
    byTarget.get(httpRedirect.url).detectedValue,
    "HTTP 302 -> http://external.test/still-http",
  );
  assert.equal(
    byTarget.get(failedCheck.url).detail,
    "The HTTP destination check failed (Timed out), so HTTPS support is unverified.",
  );
  assert.equal(
    byTarget.get("http://unchecked.test/page").detectedValue,
    "HTTP target not fetched",
  );
  assert.equal(
    byTarget.get(downloadUpgrade.url).detectedValue,
    "download; HTTP 307 -> https://external.test/download",
  );
  assert.equal(
    byTarget.get(multipleChoices.url).detectedValue,
    "HTTP 300 without HTTPS upgrade",
    "300 with Location is not a direct HTTPS redirect under Fetch",
  );
  assert.ok(
    findings.some(
      (finding) =>
        finding.ruleId === "link-to-redirect" &&
        finding.targetUrl === directUpgrade.url,
    ),
    "the internal redirect remains visible through the dedicated redirect-link rule",
  );
});

test("external nofollow reports only dominant generic page-level policy patterns", () => {
  const pages = ["blanket", "few", "mixed", "qualified"].map((name) =>
    baseResult({
      url: `https://example.com/${name}`,
      canonical: `https://example.com/${name}`,
    }),
  );
  const pageByName = new Map(
    pages.map((page) => [new URL(page.url).pathname.slice(1), page]),
  );
  const externalEdge = (pageName, index, rel = "") => ({
    sourceUrl: pageByName.get(pageName).url,
    targetUrl: `https://outside.test/${pageName}/${index}`,
    internal: false,
    rel,
    nofollow: rel.split(/[\s,]+/).includes("nofollow"),
    anchorText: `${pageName} external link ${index}`,
  });
  const linkEdges = [
    ...Array.from({ length: 5 }, (_, index) =>
      externalEdge("blanket", index, index === 0 ? "nofollow noopener" : "nofollow"),
    ),
    externalEdge("blanket", 5),
    ...Array.from({ length: 4 }, (_, index) =>
      externalEdge("few", index, "nofollow"),
    ),
    ...Array.from({ length: 5 }, (_, index) =>
      externalEdge("mixed", index, "nofollow"),
    ),
    externalEdge("mixed", 5),
    externalEdge("mixed", 6),
    ...Array.from({ length: 6 }, (_, index) =>
      externalEdge(
        "qualified",
        index,
        index % 2 ? "ugc,nofollow" : "sponsored nofollow",
      ),
    ),
  ];

  const { findings } = buildFindings({
    results: pages,
    linkEdges,
    startUrl: pages[0].url,
  });
  const nofollowFindings = findings.filter(
    (finding) => finding.ruleId === "external-nofollow",
  );

  assert.equal(nofollowFindings.length, 1);
  assert.equal(nofollowFindings[0].url, pageByName.get("blanket").url);
  assert.equal(nofollowFindings[0].targetUrl, "");
  assert.equal(nofollowFindings[0].severity, "notice");
  assert.equal(
    nofollowFindings[0].detail,
    '5 of 6 external links (83%) use generic rel="nofollow" without sponsored or ugc qualification.',
  );
  assert.match(
    nofollowFindings[0].detectedValue,
    /^5\/6 external links \(83%\); examples: https:\/\/outside\.test\/blanket\/0/,
  );
});

test("external 403 is one review notice while unavailable targets remain broken links", () => {
  const source = baseResult({
    url: "https://example.com/external-statuses",
    canonical: "https://example.com/external-statuses",
  });
  const targets = [
    baseResult({
      url: "https://outside.test/forbidden",
      scope: "External",
      status: 403,
      statusText: "Forbidden",
      canonical: "",
    }),
    baseResult({
      url: "https://outside.test/not-found",
      scope: "External",
      status: 404,
      statusText: "Not Found",
      canonical: "",
    }),
    baseResult({
      url: "https://outside.test/gone",
      scope: "External",
      status: 410,
      statusText: "Gone",
      canonical: "",
    }),
  ];
  const linkEdges = targets.map((target) => ({
    sourceUrl: source.url,
    targetUrl: target.url,
    internal: false,
    anchorText: `External destination returning ${target.status}`,
  }));

  const { findings } = buildFindings({
    results: [source, ...targets],
    linkEdges,
    startUrl: source.url,
  });
  const forbiddenFindings = findings.filter(
    (finding) => finding.ruleId === "external-403",
  );
  const brokenFindings = findings.filter(
    (finding) => finding.ruleId === "broken-external-link",
  );

  assert.equal(forbiddenFindings.length, 1);
  assert.equal(forbiddenFindings[0].targetUrl, targets[0].url);
  assert.equal(forbiddenFindings[0].statusCode, 403);
  assert.equal(forbiddenFindings[0].severity, "notice");
  assert.equal(forbiddenFindings[0].detectedValue, "HTTP 403 (Forbidden)");
  assert.equal(
    forbiddenFindings[0].detail,
    "The crawler received HTTP 403 (Forbidden); this proves request refusal, not that the destination is missing.",
  );

  assert.deepEqual(
    brokenFindings
      .map((finding) => [finding.targetUrl, finding.statusCode])
      .sort((a, b) => a[1] - b[1]),
    [
      [targets[1].url, 404],
      [targets[2].url, 410],
    ],
  );
  assert.ok(
    !brokenFindings.some((finding) => finding.targetUrl === targets[0].url),
    "the 403 target must not also be labeled as a broken external link",
  );
});

test("low-text-html-ratio does not fire on a substantial page with a low ratio (modern JS framework case)", () => {
  // Real calibration case: a Next.js page with 400+ words of real content but
  // a low ratio purely from hydration/framework markup overhead.
  const result = baseResult({ textHtmlRatio: 0.04, words: 400 });
  const { findings } = buildFindings({ results: [result], startUrl: result.url });
  assert.ok(
    !findings.some((f) => f.ruleId === "low-text-html-ratio"),
    "should not flag a content-rich page just because framework markup makes the ratio low",
  );
});

test("low-text-html-ratio still fires when the page is both low-ratio and genuinely thin", () => {
  const result = baseResult({ textHtmlRatio: 0.04, words: 50 });
  const { findings } = buildFindings({ results: [result], startUrl: result.url });
  assert.ok(
    findings.some((f) => f.ruleId === "low-text-html-ratio"),
    "should still flag a page that is both markup-heavy and genuinely thin",
  );
});

test("low-text-html-ratio does not fire when the ratio is healthy even if content is thin", () => {
  const result = baseResult({ textHtmlRatio: 0.5, words: 50 });
  const { findings } = buildFindings({ results: [result], startUrl: result.url });
  assert.ok(!findings.some((f) => f.ruleId === "low-text-html-ratio"));
  assert.ok(
    findings.some((f) => f.ruleId === "low-word-count"),
    "thin content should still be caught by the word-count check on its own",
  );
});

test("sitemap-missing-indexable does not fire when sitemap discovery was never run", () => {
  const result = baseResult({ fromSitemap: false });
  const { findings } = buildFindings({
    results: [result],
    startUrl: result.url,
    sitemapMembership: {},
    sitemapsChecked: false,
  });
  assert.ok(
    !findings.some((f) => f.ruleId === "sitemap-missing-indexable"),
    "should not claim a page is missing from the sitemap when sitemaps were never checked",
  );
});

test("sitemap-missing-indexable still fires when sitemaps were checked and the page is genuinely absent", () => {
  const result = baseResult({ fromSitemap: false });
  const { findings } = buildFindings({
    results: [result],
    startUrl: result.url,
    sitemapMembership: {},
    sitemapsChecked: true,
  });
  assert.ok(findings.some((f) => f.ruleId === "sitemap-missing-indexable"));
});

test("content-quality checks do not fire on a redirect stub", () => {
  // Real calibration case: a 308 redirect response with an empty title and a
  // few words of boilerplate ("Redirecting...") body, content-type text/html.
  // Content checks should evaluate the destination page, not the stub.
  const redirect = baseResult({
    status: 308,
    title: "",
    titleCount: 0,
    titleLength: 0,
    metaDescription: "",
    metaLength: 0,
    h1Count: 0,
    h1: "",
    words: 7,
    redirectUrl: "https://example.com/target",
  });
  const { findings } = buildFindings({ results: [redirect], startUrl: redirect.url });
  const ruleIds = findings.map((f) => f.ruleId);
  for (const shouldNotFire of ["meta-missing", "h1-missing", "low-word-count", "content-optimization"]) {
    assert.ok(!ruleIds.includes(shouldNotFire), `${shouldNotFire} should not fire on a redirect stub`);
  }
});

test("content-quality checks still fire on a genuine 200 page with the same weaknesses", () => {
  const result = baseResult({
    status: 200,
    title: "",
    titleCount: 0,
    metaDescription: "",
    metaLength: 0,
    h1Count: 0,
    h1: "",
    words: 7,
  });
  const { findings } = buildFindings({ results: [result], startUrl: result.url });
  const ruleIds = findings.map((f) => f.ruleId);
  assert.ok(ruleIds.includes("meta-missing"));
  assert.ok(ruleIds.includes("h1-missing"));
});

test("single-inlink and orphan-page are suppressed when the crawl was truncated by the URL limit", () => {
  const single = baseResult({ url: "https://example.com/single", inlinks: 1 });
  const orphan = baseResult({ url: "https://example.com/orphan", inlinks: 0, fromSitemap: true });
  const { findings } = buildFindings({
    results: [single, orphan],
    startUrl: "https://example.com/",
    crawlTruncated: true,
  });
  const ruleIds = findings.map((f) => f.ruleId);
  assert.ok(!ruleIds.includes("single-inlink"), "inlink counts are an unreliable partial sample when truncated");
  assert.ok(!ruleIds.includes("orphan-page"), "inlink counts are an unreliable partial sample when truncated");
});

test("single-inlink and orphan-page still fire on a complete (non-truncated) crawl", () => {
  // Incoming links are counted from the link graph (distinct linking pages),
  // so the fixture supplies the one page that links to /single.
  const home = baseResult({ url: "https://example.com/" });
  const single = baseResult({ url: "https://example.com/single" });
  const orphan = baseResult({ url: "https://example.com/orphan", fromSitemap: true });
  const { findings } = buildFindings({
    results: [home, single, orphan],
    linkEdges: [
      { sourceUrl: home.url, targetUrl: single.url, internal: true, anchorText: "Single" },
    ],
    startUrl: "https://example.com/",
    crawlTruncated: false,
  });
  const ruleIds = findings.map((f) => f.ruleId);
  assert.ok(ruleIds.includes("single-inlink"));
  assert.ok(ruleIds.includes("orphan-page"));
});

test("hreflang-invalid-code fires on a malformed language/region value", () => {
  const page = baseResult({
    url: "https://example.com/en/",
    hreflangs: [{ lang: "english", url: "https://example.com/en/" }],
  });
  const { findings } = buildFindings({ results: [page], startUrl: page.url });
  const finding = findings.find((f) => f.ruleId === "hreflang-invalid-code");
  assert.ok(finding);
  assert.equal(finding.detectedValue, "english");
});

test("hreflang-invalid-code does not fire on valid codes including x-default", () => {
  const page = baseResult({
    url: "https://example.com/en/",
    hreflangs: [
      { lang: "en", url: "https://example.com/en/" },
      { lang: "en-us", url: "https://example.com/en/" },
      { lang: "fr-ca", url: "https://example.com/fr-ca/" },
      { lang: "x-default", url: "https://example.com/" },
    ],
  });
  const other = baseResult({
    url: "https://example.com/fr-ca/",
    hreflangs: [
      { lang: "fr-ca", url: "https://example.com/fr-ca/" },
      { lang: "en", url: "https://example.com/en/" },
    ],
  });
  const { findings } = buildFindings({ results: [page, other], startUrl: page.url });
  assert.ok(!findings.some((f) => f.ruleId === "hreflang-invalid-code"));
});

test("hreflang-missing-self fires when a page's hreflang set omits itself", () => {
  const page = baseResult({
    url: "https://example.com/en/",
    hreflangs: [{ lang: "fr", url: "https://example.com/fr/" }],
  });
  const { findings } = buildFindings({ results: [page], startUrl: page.url });
  assert.ok(findings.some((f) => f.ruleId === "hreflang-missing-self"));
});

test("hreflang-missing-return fires when the linked page does not link back", () => {
  const page = baseResult({
    url: "https://example.com/en/",
    hreflangs: [
      { lang: "en", url: "https://example.com/en/" },
      { lang: "fr", url: "https://example.com/fr/" },
    ],
  });
  // /fr/ was crawled but its hreflang set doesn't reference /en/ back.
  const other = baseResult({
    url: "https://example.com/fr/",
    hreflangs: [{ lang: "fr", url: "https://example.com/fr/" }],
  });
  const { findings } = buildFindings({ results: [page, other], startUrl: page.url });
  const finding = findings.find(
    (f) => f.ruleId === "hreflang-missing-return" && f.url === page.url,
  );
  assert.ok(finding);
  assert.equal(finding.targetUrl, "https://example.com/fr/");
});

test("hreflang-missing-return does not fire when both pages reference each other", () => {
  const page = baseResult({
    url: "https://example.com/en/",
    hreflangs: [
      { lang: "en", url: "https://example.com/en/" },
      { lang: "fr", url: "https://example.com/fr/" },
    ],
  });
  const other = baseResult({
    url: "https://example.com/fr/",
    hreflangs: [
      { lang: "fr", url: "https://example.com/fr/" },
      { lang: "en", url: "https://example.com/en/" },
    ],
  });
  const { findings } = buildFindings({ results: [page, other], startUrl: page.url });
  assert.ok(!findings.some((f) => f.ruleId === "hreflang-missing-return"));
});

test("hreflang-missing-return does not guess about a target that was never crawled", () => {
  const page = baseResult({
    url: "https://example.com/en/",
    hreflangs: [
      { lang: "en", url: "https://example.com/en/" },
      { lang: "de", url: "https://example.com/de/" },
    ],
  });
  const { findings } = buildFindings({ results: [page], startUrl: page.url });
  assert.ok(
    !findings.some((f) => f.ruleId === "hreflang-missing-return"),
    "should not flag a target page it never actually crawled and can't verify",
  );
});

test("canonical-to-broken fires when the canonical target is a 404", () => {
  const page = baseResult({
    url: "https://example.com/duplicate",
    canonical: "https://example.com/original",
  });
  const target = baseResult({
    url: "https://example.com/original",
    status: 404,
    statusText: "Not Found",
    canonical: "https://example.com/original",
  });
  const { findings } = buildFindings({ results: [page, target], startUrl: page.url });
  const finding = findings.find((f) => f.ruleId === "canonical-to-broken");
  assert.ok(finding);
  assert.equal(finding.targetUrl, "https://example.com/original");
});

test("canonical-to-redirect fires when the canonical target 3xx-redirects", () => {
  const page = baseResult({
    url: "https://example.com/duplicate",
    canonical: "https://example.com/original",
  });
  const target = baseResult({
    url: "https://example.com/original",
    status: 301,
    canonical: "https://example.com/original",
    redirectUrl: "https://example.com/final",
  });
  const { findings } = buildFindings({ results: [page, target], startUrl: page.url });
  assert.ok(findings.some((f) => f.ruleId === "canonical-to-redirect"));
});

test("unusable redirect Locations explain the response and affected relationships", () => {
  const source = baseResult({
    url: "https://example.com/source",
    canonical: "https://example.com/unusable",
  });
  const target = baseResult({
    url: "https://example.com/unusable",
    status: 302,
    statusText: "Found",
    canonical: "https://example.com/unusable",
    redirectUrl: "",
    locationHeaderRaw: "",
    locationHeaderPresent: false,
    redirectLocationIssue: "missing",
    redirectLocationScheme: "",
  });
  const { findings } = buildFindings({
    results: [source, target],
    linkEdges: [
      {
        sourceUrl: source.url,
        targetUrl: target.url,
        internal: true,
        anchorText: "Unusable redirect",
      },
    ],
    startUrl: source.url,
  });

  const direct = findings.find(
    (finding) =>
      finding.ruleId === "redirect-location-invalid" &&
      finding.url === target.url,
  );
  assert.ok(direct);
  assert.equal(direct.detectedValue, "HTTP 302; Location header missing");
  assert.match(direct.detail, /does not advertise a destination/);

  const canonical = findings.find(
    (finding) =>
      finding.ruleId === "canonical-to-redirect" &&
      finding.url === source.url,
  );
  assert.ok(canonical);
  assert.match(canonical.detail, /no Location header/);

  const link = findings.find(
    (finding) =>
      finding.ruleId === "link-to-redirect" &&
      finding.url === source.url,
  );
  assert.ok(link);
  assert.match(link.detail, /no Location header/);
});

test("self redirects produce a loop error instead of disappearing or becoming a chain", () => {
  const url = "https://example.com/self-loop";
  const selfLoop = baseResult({
    url,
    status: 308,
    statusText: "Permanent Redirect",
    canonical: "",
    redirectUrl: url,
  });
  const { findings } = buildFindings({
    results: [selfLoop],
    startUrl: url,
  });

  const loop = findings.find(
    (finding) =>
      finding.ruleId === "redirect-loop" && finding.url === url,
  );
  assert.ok(loop);
  assert.equal(loop.targetUrl, url);
  assert.equal(loop.detectedValue, `${url} -> ${url}`);
  assert.match(loop.detail, /self-loop/);
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "redirect-chain" && finding.url === url,
    ),
  );

  const entryUrl = "https://example.com/self-loop-entry";
  const entry = baseResult({
    url: entryUrl,
    status: 302,
    statusText: "Found",
    canonical: "",
    redirectUrl: url,
  });
  const entryAnalysis = buildFindings({
    results: [entry, selfLoop],
    startUrl: entryUrl,
  });
  const entryLoop = entryAnalysis.findings.find(
    (finding) =>
      finding.ruleId === "redirect-loop" && finding.url === entryUrl,
  );
  assert.ok(entryLoop);
  assert.equal(entryLoop.detectedValue, `${entryUrl} -> ${url} -> ${url}`);
  assert.match(entryLoop.detail, /1-URL self-loop after a 1-hop lead-in/);
});

test("multi-URL redirect loops expose the cycle on pages, canonicals, and links", () => {
  const sourceUrl = "https://example.com/source";
  const firstUrl = "https://example.com/loop-a";
  const secondUrl = "https://example.com/loop-b";
  const source = baseResult({
    url: sourceUrl,
    canonical: firstUrl,
  });
  const first = baseResult({
    url: firstUrl,
    status: 301,
    statusText: "Moved Permanently",
    canonical: "",
    redirectUrl: secondUrl,
  });
  const second = baseResult({
    url: secondUrl,
    canonical: secondUrl,
    metaRefreshRaw: "0; url=/loop-a",
    metaRefreshDelay: 0,
    metaRefreshDelayRaw: "0",
    metaRefreshUrl: firstUrl,
    metaRefreshIsReload: false,
  });
  const { findings } = buildFindings({
    results: [source, first, second],
    linkEdges: [
      {
        sourceUrl,
        targetUrl: firstUrl,
        internal: true,
        anchorText: "Loop entry",
      },
    ],
    startUrl: sourceUrl,
  });

  const loops = findings.filter((finding) => finding.ruleId === "redirect-loop");
  assert.equal(loops.length, 2);
  assert.equal(
    loops.find((finding) => finding.url === firstUrl).detectedValue,
    `${firstUrl} -> ${secondUrl} -> ${firstUrl}`,
  );
  assert.equal(
    loops.find((finding) => finding.url === secondUrl).detectedValue,
    `${secondUrl} -> ${firstUrl} -> ${secondUrl}`,
  );
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "redirect-chain" &&
        [firstUrl, secondUrl].includes(finding.url),
    ),
  );

  const canonical = findings.find(
    (finding) =>
      finding.ruleId === "canonical-to-redirect" &&
      finding.url === sourceUrl,
  );
  assert.ok(canonical);
  assert.equal(
    canonical.detail,
    `Canonical target enters a redirect loop: ${firstUrl} -> ${secondUrl} -> ${firstUrl}`,
  );

  const link = findings.find(
    (finding) =>
      finding.ruleId === "link-to-redirect" &&
      finding.url === sourceUrl,
  );
  assert.ok(link);
  assert.equal(
    link.detail,
    `Redirect loop: ${firstUrl} -> ${secondUrl} -> ${firstUrl}`,
  );
});

test("a twenty-first consecutive HTTP redirect produces a Fetch-limit error", () => {
  const sourceUrl = "https://example.com/source";
  const { urls, results } = httpRedirectPath(
    "https://example.com/limit-hop",
    21,
  );
  const source = baseResult({
    url: sourceUrl,
    canonical: urls[0],
  });
  const { findings } = buildFindings({
    results: [source, ...results],
    linkEdges: [
      {
        sourceUrl,
        targetUrl: urls[0],
        internal: true,
        anchorText: "Long redirect path",
      },
    ],
    startUrl: sourceUrl,
  });

  const limitFindings = findings.filter(
    (finding) => finding.ruleId === "redirect-limit-exceeded",
  );
  assert.equal(limitFindings.length, 1);
  const limit = limitFindings[0];
  assert.equal(limit.url, urls[0]);
  assert.equal(limit.targetUrl, urls[21]);
  assert.equal(
    limit.detectedValue,
    `${urls.slice(0, 21).join(" -> ")} -[next redirect blocked]-> ${urls[21]}`,
  );
  assert.match(limit.detail, /After 20 consecutive HTTP redirects/);
  assert.match(limit.detail, new RegExp(`${urls[20]}.*${urls[21]}`));
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "redirect-chain" && finding.url === urls[0],
    ),
  );

  const boundaryChain = findings.find(
    (finding) =>
      finding.ruleId === "redirect-chain" && finding.url === urls[1],
  );
  assert.ok(boundaryChain, "exactly 20 redirects to a final response must remain valid");
  assert.equal(boundaryChain.detectedValue, 20);
  assert.equal(boundaryChain.targetUrl, urls[21]);

  const canonical = findings.find(
    (finding) =>
      finding.ruleId === "canonical-to-redirect" &&
      finding.url === sourceUrl,
  );
  assert.ok(canonical);
  assert.match(canonical.detail, /exceeds Fetch's 20-redirect limit/);

  const link = findings.find(
    (finding) =>
      finding.ruleId === "link-to-redirect" &&
      finding.url === sourceUrl,
  );
  assert.ok(link);
  assert.match(link.detail, /Exceeds Fetch's 20-redirect limit/);
});

test("a Refresh navigation resets Fetch's consecutive HTTP redirect count", () => {
  const first = httpRedirectPath("https://example.com/before-refresh", 20);
  const second = httpRedirectPath("https://example.com/after-refresh", 20);
  first.results[20] = baseResult({
    url: first.urls[20],
    canonical: first.urls[20],
    metaRefreshRaw: `0; url=${second.urls[0]}`,
    metaRefreshDelay: 0,
    metaRefreshDelayRaw: "0",
    metaRefreshUrl: second.urls[0],
    metaRefreshIsReload: false,
  });

  const { findings } = buildFindings({
    results: [...first.results, ...second.results],
    startUrl: first.urls[0],
  });

  assert.ok(
    !findings.some(
      (finding) => finding.ruleId === "redirect-limit-exceeded",
    ),
    "two valid 20-redirect Fetch segments separated by Refresh must not be combined",
  );
  const combinedChain = findings.find(
    (finding) =>
      finding.ruleId === "redirect-chain" &&
      finding.url === first.urls[0],
  );
  assert.ok(combinedChain);
  assert.equal(combinedChain.detectedValue, 41);
  assert.equal(combinedChain.targetUrl, second.urls[20]);
});

test("broken redirect endpoints propagate to entries, canonicals, links, and sitemaps", () => {
  const sourceUrl = "https://example.com/source";
  const entryUrl = "https://example.com/redirect-entry";
  const middleUrl = "https://example.com/redirect-middle";
  const brokenUrl = "https://example.com/missing";
  const source = baseResult({
    url: sourceUrl,
    canonical: entryUrl,
  });
  const entry = baseResult({
    url: entryUrl,
    status: 301,
    statusText: "Moved Permanently",
    canonical: "",
    redirectUrl: middleUrl,
  });
  const middle = baseResult({
    url: middleUrl,
    status: 302,
    statusText: "Found",
    canonical: "",
    redirectUrl: brokenUrl,
  });
  const broken = baseResult({
    url: brokenUrl,
    status: 404,
    statusText: "Not Found",
    canonical: brokenUrl,
  });
  const { findings } = buildFindings({
    results: [source, entry, middle, broken],
    linkEdges: [
      {
        sourceUrl,
        targetUrl: entryUrl,
        internal: true,
        anchorText: "Broken redirect path",
      },
    ],
    sitemapMembership: {
      [entryUrl]: ["https://example.com/sitemap.xml"],
    },
    sitemapsChecked: true,
    startUrl: sourceUrl,
  });

  const terminalFailures = findings.filter(
    (finding) => finding.ruleId === "redirect-terminal-failure",
  );
  assert.equal(terminalFailures.length, 2);
  const entryFailure = terminalFailures.find(
    (finding) => finding.url === entryUrl,
  );
  assert.ok(entryFailure);
  assert.equal(entryFailure.targetUrl, brokenUrl);
  assert.equal(entryFailure.statusCode, 404);
  assert.equal(
    entryFailure.detectedValue,
    `${entryUrl} -> ${middleUrl} -> ${brokenUrl}; terminal HTTP 404 Not Found`,
  );
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "redirect-chain" &&
        [entryUrl, middleUrl].includes(finding.url),
    ),
  );

  const canonical = findings.find(
    (finding) =>
      finding.ruleId === "canonical-to-broken" &&
      finding.url === sourceUrl,
  );
  assert.ok(canonical);
  assert.equal(canonical.statusCode, 404);
  assert.match(canonical.detail, /redirect path ends.*HTTP 404 Not Found/);
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "canonical-to-redirect" &&
        finding.url === sourceUrl,
    ),
  );

  const brokenLink = findings.find(
    (finding) =>
      finding.ruleId === "broken-internal-links" &&
      finding.url === sourceUrl &&
      finding.targetUrl === entryUrl,
  );
  assert.ok(brokenLink);
  assert.equal(brokenLink.statusCode, 404);
  assert.match(brokenLink.detail, new RegExp(`${entryUrl}.*${brokenUrl}`));
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "link-to-redirect" &&
        finding.url === sourceUrl &&
        finding.targetUrl === entryUrl,
    ),
  );

  const sitemap = findings.find(
    (finding) =>
      finding.ruleId === "sitemap-incorrect-url" &&
      finding.url === entryUrl,
  );
  assert.ok(sitemap);
  assert.match(sitemap.detail, /redirect path ends.*HTTP 404 Not Found/);
  assert.match(sitemap.detail, new RegExp(`${entryUrl}.*${brokenUrl}`));
});

test("terminal failure classes stay precise and exclude unverified endpoints", () => {
  const makeEntry = (name, targetUrl) =>
    baseResult({
      url: `https://example.com/${name}-entry`,
      status: 302,
      statusText: "Found",
      canonical: "",
      redirectUrl: targetUrl,
    });
  const failedUrl = "https://example.com/timed-out";
  const unusableUrl = "https://example.com/unusable";
  const serverErrorUrl = "https://example.com/server-error";
  const robotsUrl = "https://example.com/robots-blocked";
  const externalUrl = "https://external.test/not-found";
  const failed = baseResult({
    url: failedUrl,
    status: 0,
    statusText: "Timed out",
    canonical: "",
  });
  const unusable = baseResult({
    url: unusableUrl,
    status: 302,
    statusText: "Found",
    canonical: "",
    redirectUrl: "",
    locationHeaderRaw: "",
    locationHeaderPresent: false,
    redirectLocationIssue: "missing",
    redirectLocationScheme: "",
  });
  const serverError = baseResult({
    url: serverErrorUrl,
    status: 503,
    statusText: "Service Unavailable",
    canonical: "",
  });
  const robotsBlocked = baseResult({
    url: robotsUrl,
    status: 0,
    statusText: "Blocked by robots.txt",
    canonical: "",
  });
  const external = baseResult({
    url: externalUrl,
    scope: "External",
    status: 404,
    statusText: "Not Found",
    canonical: "",
  });
  const entries = [
    makeEntry("failed", failedUrl),
    makeEntry("unusable", unusableUrl),
    makeEntry("server", serverErrorUrl),
    makeEntry("robots", robotsUrl),
    makeEntry("external", externalUrl),
  ];

  const { findings } = buildFindings({
    results: [
      ...entries,
      failed,
      unusable,
      serverError,
      robotsBlocked,
      external,
    ],
    startUrl: entries[0].url,
  });

  const terminalFailures = findings.filter(
    (finding) => finding.ruleId === "redirect-terminal-failure",
  );
  assert.deepEqual(
    new Set(terminalFailures.map((finding) => finding.url)),
    new Set(entries.slice(0, 3).map((entry) => entry.url)),
  );
  assert.match(
    terminalFailures.find((finding) => finding.url === entries[0].url).detail,
    /could not be fetched \(Timed out\)/,
  );
  assert.match(
    terminalFailures.find((finding) => finding.url === entries[1].url).detail,
    /has no Location header/,
  );
  assert.match(
    terminalFailures.find((finding) => finding.url === entries[2].url).detail,
    /HTTP 503 Service Unavailable/,
  );

  const serverFinding = findings.find(
    (finding) =>
      finding.ruleId === "page-5xx" && finding.url === serverErrorUrl,
  );
  assert.ok(serverFinding);
  assert.equal(serverFinding.statusCode, 503);
  assert.equal(serverFinding.detectedValue, "HTTP 503 Service Unavailable");
});

test("redirect paths ending at noindex canonicalized HTML report exact terminal evidence", () => {
  const sourceUrl = "https://example.com/source";
  const entryUrl = "https://example.com/legacy";
  const middleUrl = "https://example.com/moved";
  const terminalUrl = "https://example.com/landing";
  const alternateUrl = "https://example.com/preferred";
  const source = baseResult({
    url: sourceUrl,
    canonical: entryUrl,
  });
  const entry = baseResult({
    url: entryUrl,
    status: 301,
    statusText: "Moved Permanently",
    canonical: "",
    redirectUrl: middleUrl,
  });
  const middle = baseResult({
    url: middleUrl,
    status: 302,
    statusText: "Found",
    canonical: "",
    redirectUrl: terminalUrl,
  });
  const terminal = baseResult({
    url: terminalUrl,
    indexability: "Non-indexable",
    indexabilityReason: "Meta robots contains noindex",
    robots: "noindex, follow",
    canonical: alternateUrl,
  });
  const alternate = baseResult({
    url: alternateUrl,
    canonical: alternateUrl,
  });

  const { findings } = buildFindings({
    results: [source, entry, middle, terminal, alternate],
    linkEdges: [
      {
        sourceUrl,
        targetUrl: entryUrl,
        internal: true,
        anchorText: "Legacy landing page",
      },
    ],
    sitemapMembership: {
      [entryUrl]: ["https://example.com/sitemap.xml"],
    },
    sitemapsChecked: true,
    startUrl: sourceUrl,
  });

  const suitabilityFindings = findings.filter(
    (finding) => finding.ruleId === "redirect-terminal-indexability",
  );
  assert.equal(suitabilityFindings.length, 2);
  const entryFinding = suitabilityFindings.find(
    (finding) => finding.url === entryUrl,
  );
  assert.ok(entryFinding);
  assert.equal(entryFinding.targetUrl, terminalUrl);
  assert.equal(entryFinding.statusCode, 200);
  assert.equal(
    entryFinding.detectedValue,
    `${entryUrl} -> ${middleUrl} -> ${terminalUrl}; terminal indexability: Non-indexable (Meta robots contains noindex); terminal canonical: ${alternateUrl}`,
  );
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "redirect-chain" &&
        [entryUrl, middleUrl].includes(finding.url),
    ),
  );

  const canonical = findings.find(
    (finding) =>
      finding.ruleId === "canonical-to-noindex" &&
      finding.url === sourceUrl,
  );
  assert.ok(canonical);
  assert.equal(canonical.statusCode, 200);
  assert.match(canonical.detail, /redirect path ends.*non-indexable/);
  assert.match(canonical.detail, new RegExp(`${entryUrl}.*${terminalUrl}`));
  assert.ok(
    !findings.some(
      (finding) =>
        ["canonical-to-redirect", "canonical-chain"].includes(finding.ruleId) &&
        finding.url === sourceUrl,
    ),
  );

  const link = findings.find(
    (finding) =>
      finding.ruleId === "link-to-redirect" &&
      finding.url === sourceUrl &&
      finding.targetUrl === entryUrl,
  );
  assert.ok(link);
  assert.match(link.detail, /redirect path ends.*non-indexable/);
  assert.match(link.detail, new RegExp(`${entryUrl}.*${terminalUrl}`));
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "broken-internal-links" &&
        finding.url === sourceUrl &&
        finding.targetUrl === entryUrl,
    ),
  );

  const sitemap = findings.find(
    (finding) =>
      finding.ruleId === "sitemap-incorrect-url" &&
      finding.url === entryUrl,
  );
  assert.ok(sitemap);
  assert.match(sitemap.detail, /redirect path ends.*non-indexable/);
  assert.match(sitemap.detail, new RegExp(`${entryUrl}.*${terminalUrl}`));
});

test("canonicalized redirect terminals stay distinct from healthy and non-HTML targets", () => {
  const sourceUrl = "https://example.com/source-canonical";
  const entryUrl = "https://example.com/old-canonical";
  const terminalUrl = "https://example.com/current";
  const alternateUrl = "https://example.com/preferred-current";
  const healthyEntryUrl = "https://example.com/healthy-entry";
  const healthyTerminalUrl = "https://example.com/healthy-terminal";
  const pdfEntryUrl = "https://example.com/pdf-entry";
  const pdfUrl = "https://example.com/guide.pdf";
  const source = baseResult({
    url: sourceUrl,
    canonical: entryUrl,
  });
  const entry = baseResult({
    url: entryUrl,
    status: 301,
    statusText: "Moved Permanently",
    canonical: "",
    redirectUrl: terminalUrl,
  });
  const terminal = baseResult({
    url: terminalUrl,
    canonical: alternateUrl,
  });
  const alternate = baseResult({
    url: alternateUrl,
    canonical: alternateUrl,
  });
  const healthyEntry = baseResult({
    url: healthyEntryUrl,
    status: 301,
    statusText: "Moved Permanently",
    canonical: "",
    redirectUrl: healthyTerminalUrl,
  });
  const healthyTerminal = baseResult({
    url: healthyTerminalUrl,
    canonical: healthyTerminalUrl,
  });
  const pdfEntry = baseResult({
    url: pdfEntryUrl,
    status: 301,
    statusText: "Moved Permanently",
    canonical: "",
    redirectUrl: pdfUrl,
  });
  const pdf = baseResult({
    url: pdfUrl,
    contentType: "application/pdf",
    isAsset: true,
    canonical: alternateUrl,
  });

  const { findings } = buildFindings({
    results: [
      source,
      entry,
      terminal,
      alternate,
      healthyEntry,
      healthyTerminal,
      pdfEntry,
      pdf,
    ],
    linkEdges: [
      {
        sourceUrl,
        targetUrl: entryUrl,
        internal: true,
        anchorText: "Old canonical",
      },
    ],
    startUrl: sourceUrl,
  });

  const suitability = findings.find(
    (finding) =>
      finding.ruleId === "redirect-terminal-indexability" &&
      finding.url === entryUrl,
  );
  assert.ok(suitability);
  assert.equal(
    suitability.detectedValue,
    `${entryUrl} -> ${terminalUrl}; terminal canonical: ${alternateUrl}`,
  );
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "redirect-terminal-indexability" &&
        [healthyEntryUrl, pdfEntryUrl].includes(finding.url),
    ),
  );

  const canonical = findings.find(
    (finding) =>
      finding.ruleId === "canonical-chain" &&
      finding.url === sourceUrl,
  );
  assert.ok(canonical);
  assert.equal(canonical.statusCode, 200);
  assert.match(canonical.detail, /declares .* as its canonical URL/);
  assert.match(canonical.detail, new RegExp(`${entryUrl}.*${terminalUrl}`));
  assert.ok(
    !findings.some(
      (finding) =>
        ["canonical-to-redirect", "canonical-to-noindex"].includes(
          finding.ruleId,
        ) && finding.url === sourceUrl,
    ),
  );

  const link = findings.find(
    (finding) =>
      finding.ruleId === "link-to-redirect" &&
      finding.url === sourceUrl &&
      finding.targetUrl === entryUrl,
  );
  assert.ok(link);
  assert.match(link.detail, /declares .* as its canonical URL/);
});

test("canonical-chain fires when the canonical target's own canonical points elsewhere", () => {
  const page = baseResult({
    url: "https://example.com/a",
    canonical: "https://example.com/b",
  });
  const middle = baseResult({
    url: "https://example.com/b",
    canonical: "https://example.com/c",
  });
  const { findings } = buildFindings({ results: [page, middle], startUrl: page.url });
  const finding = findings.find((f) => f.ruleId === "canonical-chain");
  assert.ok(finding);
  assert.equal(finding.targetUrl, "https://example.com/b");
});

test("canonical-to-noindex fires when the canonical target carries a noindex directive", () => {
  const page = baseResult({
    url: "https://example.com/duplicate",
    canonical: "https://example.com/original",
  });
  const target = baseResult({
    url: "https://example.com/original",
    canonical: "https://example.com/original",
    robots: "noindex",
  });
  const { findings } = buildFindings({ results: [page, target], startUrl: page.url });
  assert.ok(findings.some((f) => f.ruleId === "canonical-to-noindex"));
});

test("canonical checks fire nothing when the canonical target is healthy and self-referencing", () => {
  const page = baseResult({
    url: "https://example.com/duplicate",
    canonical: "https://example.com/original",
  });
  const target = baseResult({
    url: "https://example.com/original",
    canonical: "https://example.com/original",
  });
  const { findings } = buildFindings({ results: [page, target], startUrl: page.url });
  const ruleIds = findings.map((f) => f.ruleId);
  for (const rule of ["canonical-to-broken", "canonical-to-redirect", "canonical-chain", "canonical-to-noindex"]) {
    assert.ok(!ruleIds.includes(rule));
  }
});

test("canonical checks do not guess about a canonical target that was never crawled", () => {
  const page = baseResult({
    url: "https://example.com/duplicate",
    canonical: "https://example.com/never-crawled",
  });
  const { findings } = buildFindings({ results: [page], startUrl: page.url });
  const ruleIds = findings.map((f) => f.ruleId);
  for (const rule of ["canonical-to-broken", "canonical-to-redirect", "canonical-chain", "canonical-to-noindex"]) {
    assert.ok(!ruleIds.includes(rule));
  }
});

test("pagination-link-broken fires when the rel=next target is unreachable", () => {
  const page = baseResult({
    url: "https://example.com/page-1",
    paginationNext: "https://example.com/page-2",
  });
  const target = baseResult({ url: "https://example.com/page-2", status: 500, statusText: "Server Error" });
  const { findings } = buildFindings({ results: [page, target], startUrl: page.url });
  const finding = findings.find((f) => f.ruleId === "pagination-link-broken");
  assert.ok(finding);
  assert.equal(finding.targetUrl, "https://example.com/page-2");
});

test("pagination-link-broken does not fire when both prev and next resolve fine", () => {
  const page = baseResult({
    url: "https://example.com/page-2",
    paginationNext: "https://example.com/page-3",
    paginationPrev: "https://example.com/page-1",
  });
  const next = baseResult({ url: "https://example.com/page-3" });
  const prev = baseResult({ url: "https://example.com/page-1" });
  const { findings } = buildFindings({ results: [page, next, prev], startUrl: page.url });
  assert.ok(!findings.some((f) => f.ruleId === "pagination-link-broken"));
});

test("pagination-canonical-conflict fires when a paginated page canonicalizes to a different URL", () => {
  const page = baseResult({
    url: "https://example.com/category?page=2",
    paginationNext: "https://example.com/category?page=3",
    canonical: "https://example.com/category",
  });
  const { findings } = buildFindings({ results: [page], startUrl: page.url });
  const finding = findings.find((f) => f.ruleId === "pagination-canonical-conflict");
  assert.ok(finding);
  assert.equal(finding.targetUrl, "https://example.com/category");
});

test("pagination-canonical-conflict does not fire on a self-referencing canonical", () => {
  const page = baseResult({
    url: "https://example.com/category?page=2",
    paginationNext: "https://example.com/category?page=3",
    canonical: "https://example.com/category?page=2",
  });
  const { findings } = buildFindings({ results: [page], startUrl: page.url });
  assert.ok(!findings.some((f) => f.ruleId === "pagination-canonical-conflict"));
});

test("pagination checks do not fire on a page with no rel=next/prev at all", () => {
  const page = baseResult({ canonical: "https://example.com/somewhere-else" });
  const { findings } = buildFindings({ results: [page], startUrl: page.url });
  assert.ok(!findings.some((f) => f.ruleId === "pagination-canonical-conflict"));
});

test("viewport-missing fires when there is no viewport meta tag", () => {
  const page = baseResult({ viewport: "" });
  const { findings } = buildFindings({ results: [page], startUrl: page.url });
  assert.ok(findings.some((f) => f.ruleId === "viewport-missing"));
});

test("viewport-not-responsive fires when the tag exists but omits width=device-width", () => {
  const page = baseResult({ viewport: "width=1024" });
  const { findings } = buildFindings({ results: [page], startUrl: page.url });
  const finding = findings.find((f) => f.ruleId === "viewport-not-responsive");
  assert.ok(finding);
  assert.equal(finding.detectedValue, "width=1024");
  assert.ok(!findings.some((f) => f.ruleId === "viewport-missing"));
});

test("neither viewport check fires on a properly responsive tag", () => {
  const page = baseResult({ viewport: "width=device-width, initial-scale=1" });
  const { findings } = buildFindings({ results: [page], startUrl: page.url });
  assert.ok(!findings.some((f) => f.ruleId === "viewport-missing"));
  assert.ok(!findings.some((f) => f.ruleId === "viewport-not-responsive"));
});

test("h1-duplicate fires for the same primary heading across pages, ignoring case and outer whitespace", () => {
  const first = baseResult({
    url: "https://example.com/services/seo",
    canonical: "https://example.com/services/seo",
    h1: "Technical SEO Services",
  });
  const second = baseResult({
    url: "https://example.com/services/content",
    canonical: "https://example.com/services/content",
    h1: "  technical seo services  ",
  });

  const { findings } = buildFindings({
    results: [first, second],
    startUrl: first.url,
  });
  const duplicates = findings.filter((finding) => finding.ruleId === "h1-duplicate");

  assert.equal(duplicates.length, 2);
  assert.ok(
    duplicates.every(
      (finding) =>
        finding.detail === "Shared by 2 independently indexable pages",
    ),
  );
  assert.deepEqual(
    duplicates.map((finding) => finding.detectedValue),
    ["  technical seo services  ", "Technical SEO Services"],
  );
});

test("h1-duplicate does not fire for unique headings or pages with multiple H1s", () => {
  const unique = baseResult({
    url: "https://example.com/unique",
    canonical: "https://example.com/unique",
    h1: "Unique primary heading",
  });
  const multipleA = baseResult({
    url: "https://example.com/multiple-a",
    canonical: "https://example.com/multiple-a",
    h1Count: 2,
    h1: "Repeated heading set | Supporting H1",
  });
  const multipleB = baseResult({
    url: "https://example.com/multiple-b",
    canonical: "https://example.com/multiple-b",
    h1Count: 2,
    h1: "Repeated heading set | Supporting H1",
  });

  const { findings } = buildFindings({
    results: [unique, multipleA, multipleB],
    startUrl: unique.url,
  });

  assert.ok(!findings.some((finding) => finding.ruleId === "h1-duplicate"));
  assert.equal(
    findings.filter((finding) => finding.ruleId === "h1-multiple").length,
    2,
    "pages with multiple H1s should retain the more direct heading-hierarchy finding",
  );
});

test("cross-page metadata duplicate rules ignore noindexed and canonicalized variants", () => {
  const shared = {
    title: "Shared page title",
    metaDescription: "A shared meta description long enough to be a realistic search snippet.",
    h1: "Shared primary heading",
  };
  const primary = baseResult({
    ...shared,
    url: "https://example.com/primary",
    canonical: "https://example.com/primary",
  });
  const canonicalized = baseResult({
    ...shared,
    url: "https://example.com/canonicalized",
    canonical: primary.url,
  });
  const noindexed = baseResult({
    ...shared,
    url: "https://example.com/private",
    canonical: "https://example.com/private",
    indexability: "Non-indexable",
  });

  const { findings } = buildFindings({
    results: [primary, canonicalized, noindexed],
    startUrl: primary.url,
  });
  const crossPageRules = new Set([
    "title-duplicate",
    "meta-duplicate",
    "h1-duplicate",
  ]);

  assert.ok(!findings.some((finding) => crossPageRules.has(finding.ruleId)));
});

test("cross-page metadata duplicate rules suppress only complete reciprocal hreflang groups", () => {
  const enUrl = "https://example.com/en-us/service";
  const gbUrl = "https://example.com/en-gb/service";
  const shared = {
    title: "Shared regional service title",
    metaDescription: "A shared regional meta description long enough to represent a real snippet.",
    h1: "Shared regional service heading",
  };
  const hreflangs = [
    { lang: "en-us", url: enUrl },
    { lang: "en-gb", url: gbUrl },
  ];
  const en = baseResult({
    ...shared,
    url: enUrl,
    canonical: enUrl,
    hreflangs,
  });
  const gb = baseResult({
    ...shared,
    url: gbUrl,
    canonical: gbUrl,
    hreflangs,
  });

  const reciprocal = buildFindings({
    results: [en, gb],
    startUrl: enUrl,
  });
  for (const ruleId of ["title-duplicate", "meta-duplicate", "h1-duplicate"]) {
    assert.ok(!reciprocal.findings.some((finding) => finding.ruleId === ruleId));
  }

  const incompleteGb = {
    ...gb,
    hreflangs: [{ lang: "en-gb", url: gbUrl }],
  };
  const incomplete = buildFindings({
    results: [en, incompleteGb],
    startUrl: enUrl,
  });
  for (const ruleId of ["title-duplicate", "meta-duplicate", "h1-duplicate"]) {
    assert.equal(
      incomplete.findings.filter((finding) => finding.ruleId === ruleId).length,
      2,
      `${ruleId} should remain visible when hreflang reciprocity is incomplete`,
    );
  }
});

test("heading-hierarchy-skipped reports the exact headings around each skipped level", () => {
  const page = baseResult({
    headingHierarchyIssue: true,
    headingHierarchyIssues: [
      {
        fromLevel: 1,
        fromText: "Technical SEO audit",
        toLevel: 3,
        toText: "Crawlability findings",
      },
      {
        fromLevel: 2,
        fromText: "Performance",
        toLevel: 4,
        toText: "Image delivery",
      },
    ],
  });

  const { findings } = buildFindings({ results: [page], startUrl: page.url });
  const hierarchyFindings = findings.filter(
    (finding) => finding.ruleId === "heading-hierarchy-skipped",
  );

  assert.equal(hierarchyFindings.length, 2);
  assert.deepEqual(
    hierarchyFindings.map((finding) => finding.detectedValue),
    ["H1 → H3", "H2 → H4"],
  );
  assert.match(
    hierarchyFindings[0].detail,
    /H1 "Technical SEO audit" is followed by H3 "Crawlability findings"/,
  );
});

test("content-duplicate-exact reports both indexable pages with a real comparison URL and text sample", () => {
  const shared = {
    hash: "shared-visible-text-hash",
    words: 120,
    contentSample: "Shared service copy with the same claims, details, and call to action.",
  };
  const first = baseResult({
    ...shared,
    url: "https://example.com/services/alpha",
    canonical: "https://example.com/services/alpha",
  });
  const second = baseResult({
    ...shared,
    url: "https://example.com/services/beta",
    canonical: "https://example.com/services/beta",
  });

  const { findings } = buildFindings({
    results: [second, first],
    startUrl: first.url,
  });
  const duplicates = findings.filter(
    (finding) => finding.ruleId === "content-duplicate-exact",
  );

  assert.equal(duplicates.length, 2);
  assert.deepEqual(
    duplicates.map((finding) => finding.url),
    [first.url, second.url],
    "duplicate findings should be deterministic regardless of crawl completion order",
  );
  assert.equal(duplicates[0].targetUrl, second.url);
  assert.equal(duplicates[1].targetUrl, first.url);
  assert.equal(duplicates[0].detectedValue, shared.contentSample);
});

test("content-duplicate-exact ignores canonicalized, noindexed, and very short pages", () => {
  const primary = baseResult({
    url: "https://example.com/primary",
    canonical: "https://example.com/primary",
    hash: "shared-hash",
    words: 120,
  });
  const canonicalized = baseResult({
    url: "https://example.com/canonicalized",
    canonical: primary.url,
    hash: "shared-hash",
    words: 120,
  });
  const noindexedA = baseResult({
    url: "https://example.com/private-a",
    canonical: "https://example.com/private-a",
    indexability: "Non-indexable",
    hash: "private-hash",
    words: 120,
  });
  const noindexedB = baseResult({
    url: "https://example.com/private-b",
    canonical: "https://example.com/private-b",
    indexability: "Non-indexable",
    hash: "private-hash",
    words: 120,
  });
  const shortA = baseResult({
    url: "https://example.com/shell-a",
    canonical: "https://example.com/shell-a",
    hash: "short-shell-hash",
    words: 20,
  });
  const shortB = baseResult({
    url: "https://example.com/shell-b",
    canonical: "https://example.com/shell-b",
    hash: "short-shell-hash",
    words: 20,
  });

  const { findings } = buildFindings({
    results: [primary, canonicalized, noindexedA, noindexedB, shortA, shortB],
    startUrl: primary.url,
  });

  assert.ok(
    !findings.some((finding) => finding.ruleId === "content-duplicate-exact"),
  );
});

test("content-duplicate-exact suppresses intentional reciprocal hreflang variants", () => {
  const enUrl = "https://example.com/en-us/service";
  const gbUrl = "https://example.com/en-gb/service";
  const hreflangs = [
    { lang: "en-us", url: enUrl },
    { lang: "en-gb", url: gbUrl },
  ];
  const en = baseResult({
    url: enUrl,
    canonical: enUrl,
    hash: "localized-shared-hash",
    words: 120,
    hreflangs,
  });
  const gb = baseResult({
    url: gbUrl,
    canonical: gbUrl,
    hash: "localized-shared-hash",
    words: 120,
    hreflangs,
  });

  const { findings } = buildFindings({
    results: [en, gb],
    startUrl: enUrl,
  });

  assert.ok(
    !findings.some((finding) => finding.ruleId === "content-duplicate-exact"),
  );

  const incompleteGb = {
    ...gb,
    hreflangs: [{ lang: "en-gb", url: gbUrl }],
  };
  const incompleteAnalysis = buildFindings({
    results: [en, incompleteGb],
    startUrl: enUrl,
  });
  assert.equal(
    incompleteAnalysis.findings.filter(
      (finding) => finding.ruleId === "content-duplicate-exact",
    ).length,
    2,
    "an incomplete hreflang relationship should not hide confirmed duplicate content",
  );
});

test("meta refresh participates in mixed redirect, sitemap, canonical, and link checks", () => {
  const sourceUrl = "https://example.com/source";
  const refreshUrl = "https://example.com/refresh";
  const hopUrl = "https://example.com/hop";
  const finalUrl = "https://example.com/final";
  const source = baseResult({
    url: sourceUrl,
    canonical: refreshUrl,
  });
  const refresh = baseResult({
    url: refreshUrl,
    canonical: refreshUrl,
    metaRefreshRaw: "0; url=/hop",
    metaRefreshDelay: 0,
    metaRefreshDelayRaw: "0",
    metaRefreshUrl: hopUrl,
    metaRefreshIsReload: false,
  });
  const hop = baseResult({
    url: hopUrl,
    status: 302,
    statusText: "Found",
    canonical: "",
    redirectUrl: finalUrl,
  });
  const final = baseResult({
    url: finalUrl,
    canonical: finalUrl,
  });

  const { findings } = buildFindings({
    results: [source, refresh, hop, final],
    linkEdges: [
      {
        sourceUrl,
        targetUrl: refreshUrl,
        internal: true,
        anchorText: "Refresh route",
      },
    ],
    sitemapMembership: {
      [refreshUrl]: ["https://example.com/sitemap.xml"],
    },
    sitemapsChecked: true,
    startUrl: sourceUrl,
  });

  const refreshFinding = findings.find(
    (finding) =>
      finding.ruleId === "meta-refresh" && finding.url === refreshUrl,
  );
  assert.ok(refreshFinding);
  assert.equal(refreshFinding.targetUrl, hopUrl);
  assert.match(refreshFinding.detail, /HTTP 302/);

  const chain = findings.find(
    (finding) =>
      finding.ruleId === "redirect-chain" && finding.url === refreshUrl,
  );
  assert.ok(chain);
  assert.equal(chain.detectedValue, 2);
  assert.equal(chain.targetUrl, finalUrl);

  const sitemap = findings.find(
    (finding) =>
      finding.ruleId === "sitemap-incorrect-url" && finding.url === refreshUrl,
  );
  assert.ok(sitemap);
  assert.equal(sitemap.detail, `Meta refresh to ${hopUrl}`);

  const canonical = findings.find(
    (finding) =>
      finding.ruleId === "canonical-to-redirect" && finding.url === sourceUrl,
  );
  assert.ok(canonical);
  assert.match(canonical.detail, /uses a meta refresh/);

  const link = findings.find(
    (finding) =>
      finding.ruleId === "link-to-redirect" && finding.url === sourceUrl,
  );
  assert.ok(link);
  assert.equal(link.detail, `Meta refresh to ${hopUrl}`);
});

test("HTTP Refresh header participates in redirect relationships with source-specific evidence", () => {
  const sourceUrl = "https://example.com/header-source";
  const refreshUrl = "https://example.com/header-refresh";
  const hopUrl = "https://example.com/meta-hop";
  const finalUrl = "https://example.com/header-final";
  const source = baseResult({
    url: sourceUrl,
    canonical: refreshUrl,
  });
  const refresh = baseResult({
    url: refreshUrl,
    canonical: refreshUrl,
    refreshHeaderRaw: "0; URL=/meta-hop",
    refreshHeaderDelay: 0,
    refreshHeaderDelayRaw: "0",
    refreshHeaderUrl: hopUrl,
    refreshHeaderIsReload: false,
  });
  const hop = baseResult({
    url: hopUrl,
    canonical: hopUrl,
    metaRefreshRaw: "2; URL=/header-final",
    metaRefreshDelay: 2,
    metaRefreshDelayRaw: "2",
    metaRefreshUrl: finalUrl,
    metaRefreshIsReload: false,
  });
  const final = baseResult({
    url: finalUrl,
    canonical: finalUrl,
  });

  const { findings } = buildFindings({
    results: [source, refresh, hop, final],
    linkEdges: [
      {
        sourceUrl,
        targetUrl: refreshUrl,
        internal: true,
        anchorText: "Header refresh route",
      },
    ],
    sitemapMembership: {
      [refreshUrl]: ["https://example.com/sitemap.xml"],
    },
    sitemapsChecked: true,
    startUrl: sourceUrl,
  });

  const headerFinding = findings.find(
    (finding) =>
      finding.ruleId === "http-refresh" && finding.url === refreshUrl,
  );
  assert.ok(headerFinding);
  assert.equal(headerFinding.targetUrl, hopUrl);
  assert.match(headerFinding.detectedValue, /^Refresh: 0; URL=\/meta-hop;/);
  assert.match(headerFinding.detail, /destination returned HTTP 200/);

  const chain = findings.find(
    (finding) =>
      finding.ruleId === "redirect-chain" && finding.url === refreshUrl,
  );
  assert.ok(chain);
  assert.equal(chain.detectedValue, 2);
  assert.equal(chain.targetUrl, finalUrl);

  const sitemap = findings.find(
    (finding) =>
      finding.ruleId === "sitemap-incorrect-url" &&
      finding.url === refreshUrl,
  );
  assert.ok(sitemap);
  assert.equal(sitemap.detail, `HTTP Refresh header to ${hopUrl}`);

  const canonical = findings.find(
    (finding) =>
      finding.ruleId === "canonical-to-redirect" &&
      finding.url === sourceUrl,
  );
  assert.ok(canonical);
  assert.match(canonical.detail, /uses an HTTP Refresh header/);

  const link = findings.find(
    (finding) =>
      finding.ruleId === "link-to-redirect" && finding.url === sourceUrl,
  );
  assert.ok(link);
  assert.equal(link.detail, `HTTP Refresh header to ${hopUrl}`);
});

test("non-Fetch 3xx statuses never enter redirect relationships even with Location-like data", () => {
  const sourceUrl = "https://example.com/source";
  const choicesUrl = "https://example.com/choices";
  const apparentTargetUrl = "https://example.com/apparent-target";
  const source = baseResult({
    url: sourceUrl,
    canonical: choicesUrl,
  });
  const choices = baseResult({
    url: choicesUrl,
    status: 300,
    statusText: "Multiple Choices",
    canonical: choicesUrl,
    redirectUrl: apparentTargetUrl,
  });
  const apparentTarget = baseResult({
    url: apparentTargetUrl,
    canonical: apparentTargetUrl,
  });

  const { findings } = buildFindings({
    results: [source, choices, apparentTarget],
    linkEdges: [
      {
        sourceUrl,
        targetUrl: choicesUrl,
        internal: true,
        anchorText: "Choose a representation",
      },
    ],
    sitemapMembership: {
      [choicesUrl]: ["https://example.com/sitemap.xml"],
    },
    sitemapsChecked: true,
    startUrl: sourceUrl,
  });

  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "canonical-to-redirect" &&
        finding.url === sourceUrl,
    ),
  );
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "link-to-redirect" && finding.url === sourceUrl,
    ),
  );
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "redirect-chain" && finding.url === choicesUrl,
    ),
  );
  assert.ok(
    !findings.some(
      (finding) =>
        finding.ruleId === "sitemap-redirect" && finding.url === choicesUrl,
    ),
  );
  assert.ok(
    findings.some(
      (finding) =>
        finding.ruleId === "sitemap-incorrect-url" &&
        finding.url === choicesUrl,
    ),
    "the non-200 sitemap entry remains incorrect without being mislabeled as a redirect",
  );
});

// ── Page categorization ─────────────────────────────────────────────────
test("categorizePage: depth 0 and the root path are always Home", () => {
  const root = baseResult({ url: "https://example.com/", depth: 0 });
  const deepRoot = baseResult({ url: "https://example.com/anything", depth: 0 });
  const { results } = buildFindings({ results: [root, deepRoot], startUrl: root.url });
  assert.equal(results.find((r) => r.url === root.url).pageCategory, "Home");
  assert.equal(results.find((r) => r.url === deepRoot.url).pageCategory, "Home");
});

test("categorizePage: schema.org @type outranks a non-matching URL", () => {
  const result = baseResult({
    url: "https://example.com/items/widget-9000",
    schemaTypes: ["Product", "BreadcrumbList"],
  });
  const { results } = buildFindings({ results: [result], startUrl: "https://example.com/" });
  assert.equal(results[0].pageCategory, "Product");
});

test("categorizePage: URL path patterns cover the common page types", () => {
  const cases = [
    ["https://example.com/products/widget", "Product"],
    ["https://example.com/blog/how-we-built-it", "Blog / Article"],
    ["https://example.com/training/level-1", "Training"],
    ["https://example.com/guides/getting-started", "Guide / Resource"],
    ["https://example.com/faqs/", "FAQ"],
    ["https://example.com/about-us/", "About"],
    ["https://example.com/careers/", "Careers"],
    ["https://example.com/privacy/", "Legal"],
  ];
  const results = cases.map(([url]) => baseResult({ url }));
  const { results: enriched } = buildFindings({ results, startUrl: "https://example.com/" });
  for (const [url, expected] of cases) {
    assert.equal(enriched.find((r) => r.url === url).pageCategory, expected, url);
  }
});

test("categorizePage: an unmatched page falls back to Other, not a guess", () => {
  const result = baseResult({ url: "https://example.com/xj4k2" });
  const { results } = buildFindings({ results: [result], startUrl: "https://example.com/" });
  assert.equal(results[0].pageCategory, "Other");
});

// ── Media library ────────────────────────────────────────────────────────
test("buildMediaLibrary: an image referenced from two pages is one item with usedByCount 2", () => {
  const home = baseResult({ url: "https://example.com/", depth: 0 });
  const about = baseResult({ url: "https://example.com/about/" });
  const image = baseResult({
    url: "https://example.com/wp-content/uploads/hero.jpg",
    isAsset: true,
    contentType: "image/jpeg",
    size: 204_800,
    depth: 1,
  });
  const resourceEdges = [
    { sourceUrl: home.url, targetUrl: image.url },
    { sourceUrl: about.url, targetUrl: image.url },
  ];
  const { mediaLibrary } = buildFindings({
    results: [home, about, image],
    resourceEdges,
    startUrl: home.url,
  });
  assert.equal(mediaLibrary.count, 1);
  assert.equal(mediaLibrary.items[0].url, image.url);
  assert.equal(mediaLibrary.items[0].type, "Image");
  assert.equal(mediaLibrary.items[0].usedByCount, 2);
  assert.equal(mediaLibrary.totalBytes, 204_800);
});

test("buildMediaLibrary: excludes non-media assets (CSS/JS) and non-200s, includes external media labeled isExternal", () => {
  // External used to be a hard exclusion — that silently dropped a linked
  // compliance PDF or spec sheet hosted on a sibling domain from the media
  // library entirely. It's now included, just labeled, so the reader judges
  // relevance instead of the tool guessing it away (see buildMediaLibrary).
  const script = baseResult({ url: "https://example.com/app.js", isAsset: true, contentType: "application/javascript", status: 200 });
  const externalImage = baseResult({ url: "https://cdn.other.com/pic.png", isAsset: true, contentType: "image/png", scope: "External", status: 200 });
  const brokenImage = baseResult({ url: "https://example.com/missing.png", isAsset: true, contentType: "image/png", status: 404 });
  const pdf = baseResult({ url: "https://example.com/whitepaper.pdf", isAsset: true, contentType: "application/pdf", size: 50_000, status: 200 });
  const { mediaLibrary } = buildFindings({
    results: [script, externalImage, brokenImage, pdf],
    resourceEdges: [],
    startUrl: "https://example.com/",
  });
  assert.equal(mediaLibrary.count, 2);
  const byUrl = new Map(mediaLibrary.items.map((item) => [item.url, item]));
  assert.ok(byUrl.has(pdf.url));
  assert.equal(byUrl.get(pdf.url).type, "Document");
  assert.equal(byUrl.get(pdf.url).isExternal, false);
  assert.ok(byUrl.has(externalImage.url));
  assert.equal(byUrl.get(externalImage.url).type, "Image");
  assert.equal(byUrl.get(externalImage.url).isExternal, true);
  assert.ok(!byUrl.has(script.url), "a script is not media even though it's isAsset");
  assert.ok(!byUrl.has(brokenImage.url), "a 404'd asset was never actually delivered");
});

test("buildMediaLibrary: recognizes a linked calendar/office/archive file, not just images/video/audio/PDF", () => {
  const ics = baseResult({ url: "https://example.com/event.ics", isAsset: true, contentType: "text/calendar", status: 200 });
  const docx = baseResult({
    url: "https://example.com/brochure.docx",
    isAsset: true,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    status: 200,
  });
  const { mediaLibrary } = buildFindings({
    results: [ics, docx],
    resourceEdges: [],
    startUrl: "https://example.com/",
  });
  assert.equal(mediaLibrary.count, 2);
  assert.ok(mediaLibrary.items.every((item) => item.type === "Document"));
});

test("buildIntegrations: aggregates a vendor's page count, placement, and loading strategy across pages", () => {
  const home = baseResult({
    url: "https://example.com/",
    integrations: [
      { id: "google-tag-manager", location: "head", loading: "sync" },
      { id: "facebook-pixel", location: "body", loading: "async" },
    ],
  });
  const about = baseResult({
    url: "https://example.com/about",
    integrations: [
      { id: "google-tag-manager", location: "head", loading: "sync" },
    ],
  });
  const { integrations } = buildFindings({ results: [home, about], startUrl: home.url });

  assert.equal(integrations.totalPages, 2);
  const gtm = integrations.items.find((item) => item.id === "google-tag-manager");
  assert.equal(gtm.pageCount, 2);
  assert.equal(gtm.headCount, 2);
  assert.equal(gtm.bodyCount, 0);
  assert.equal(gtm.loadingCounts.sync, 2);
  assert.equal(gtm.name, "Google Tag Manager");
  assert.equal(gtm.category, "Tag Manager");
  assert.equal(gtm.status, "active");

  const pixel = integrations.items.find((item) => item.id === "facebook-pixel");
  assert.equal(pixel.pageCount, 1);
  assert.equal(pixel.bodyCount, 1);
  assert.equal(pixel.loadingCounts.async, 1);

  // Sorted by adoption, most-used first.
  assert.equal(integrations.items[0].id, "google-tag-manager");
});

test("buildIntegrations: flags a deprecated vendor and returns nothing for a clean page", () => {
  const legacy = baseResult({
    integrations: [{ id: "universal-analytics", location: "body", loading: "sync" }],
  });
  const { integrations: withLegacy } = buildFindings({ results: [legacy], startUrl: legacy.url });
  const ua = withLegacy.items.find((item) => item.id === "universal-analytics");
  assert.equal(ua.status, "deprecated");

  const clean = baseResult({ integrations: [] });
  const { integrations: withNone } = buildFindings({ results: [clean], startUrl: clean.url });
  assert.equal(withNone.items.length, 0);
  assert.equal(withNone.totalPages, 1);
});

test("buildIntegrations: an unrecognized/stale vendor id is skipped rather than surfaced blank", () => {
  const page = baseResult({ integrations: [{ id: "some-retired-catalog-id", location: "head", loading: "sync" }] });
  const { integrations } = buildFindings({ results: [page], startUrl: page.url });
  assert.equal(integrations.items.length, 0);
});

// ── Crawler-completeness Phase 1 ────────────────────────────────────────────

test("broken-internal-links does not fire when the target was only skipped for the crawl's own robots.txt compliance", () => {
  const source = baseResult({ url: "https://example.com/" });
  const target = baseResult({
    url: "https://example.com/search",
    status: 0,
    statusText: "Blocked by robots.txt",
    indexability: "Non-indexable",
  });
  const { findings } = buildFindings({
    results: [source, target],
    linkEdges: [{ sourceUrl: source.url, targetUrl: target.url, internal: true, anchorText: "Search" }],
    startUrl: source.url,
  });
  assert.ok(
    !findings.some((f) => f.ruleId === "broken-internal-links" && f.url === source.url),
    "a robots-disallowed target is a polite no-fetch, not a dead link",
  );
  // The target itself still gets its own, milder finding — this isn't
  // silently dropping the fact that an internal link points somewhere the
  // site's own robots.txt blocks.
  assert.ok(findings.some((f) => f.ruleId === "robots-blocked" && f.url === target.url));
});

test("broken-internal-links still fires for a genuinely broken target (404, not robots-blocked)", () => {
  const source = baseResult({ url: "https://example.com/" });
  const target = baseResult({ url: "https://example.com/dead", status: 404, statusText: "Not Found" });
  const { findings } = buildFindings({
    results: [source, target],
    linkEdges: [{ sourceUrl: source.url, targetUrl: target.url, internal: true, anchorText: "Dead" }],
    startUrl: source.url,
  });
  assert.ok(findings.some((f) => f.ruleId === "broken-internal-links" && f.url === source.url && f.statusCode === 404));
});

test("collapseTemplateFindings: a broken link present on nearly every page collapses to ONE scope='template' signature, not N page findings", () => {
  const target = baseResult({ url: "https://example.com/search", status: 0, statusText: "Server error" });
  const pages = Array.from({ length: 10 }, (_, i) => baseResult({ url: `https://example.com/page-${i}` }));
  const linkEdges = pages.map((page) => ({
    sourceUrl: page.url,
    targetUrl: target.url,
    internal: true,
    anchorText: "Search",
  }));
  const { findings } = buildFindings({
    results: [...pages, target],
    linkEdges,
    startUrl: pages[0].url,
  });
  const broken = findings.filter((f) => f.ruleId === "broken-internal-links");
  assert.equal(broken.length, 10, "still one finding per affected page — nothing is deleted");
  assert.ok(broken.every((f) => f.scope === "template"), "every instance is re-tagged, not merged into one row");
  assert.ok(!findings.some((f) => f.ruleId === "broken-internal-links" && f.scope === "page"));
});

test("collapseTemplateFindings: a broken link on only a couple of pages stays scope='page', not template", () => {
  const target = baseResult({ url: "https://example.com/one-off", status: 404 });
  const pages = Array.from({ length: 10 }, (_, i) => baseResult({ url: `https://example.com/page-${i}` }));
  // Only 2 of 10 pages link to it — well under the 50%-of-crawl threshold.
  const linkEdges = pages.slice(0, 2).map((page) => ({
    sourceUrl: page.url,
    targetUrl: target.url,
    internal: true,
    anchorText: "One off",
  }));
  const { findings } = buildFindings({
    results: [...pages, target],
    linkEdges,
    startUrl: pages[0].url,
  });
  const broken = findings.filter((f) => f.ruleId === "broken-internal-links");
  assert.equal(broken.length, 2);
  assert.ok(broken.every((f) => f.scope === "page"), "too few affected pages to call it a template pattern");
});

test("collapseTemplateFindings: distinct targets under the same rule collapse independently", () => {
  // Two DIFFERENT broken targets, each linked from every page — two separate
  // template findings, not one merged one (they're different defects).
  const targetA = baseResult({ url: "https://example.com/dead-a", status: 404 });
  const targetB = baseResult({ url: "https://example.com/dead-b", status: 404 });
  const pages = Array.from({ length: 6 }, (_, i) => baseResult({ url: `https://example.com/page-${i}` }));
  const linkEdges = pages.flatMap((page) => [
    { sourceUrl: page.url, targetUrl: targetA.url, internal: true, anchorText: "A" },
    { sourceUrl: page.url, targetUrl: targetB.url, internal: true, anchorText: "B" },
  ]);
  const { findings } = buildFindings({
    results: [...pages, targetA, targetB],
    linkEdges,
    startUrl: pages[0].url,
  });
  const broken = findings.filter((f) => f.ruleId === "broken-internal-links" && f.scope === "template");
  const byTarget = new Map();
  for (const f of broken) byTarget.set(f.targetUrl, (byTarget.get(f.targetUrl) || 0) + 1);
  assert.equal(byTarget.get(targetA.url), 6);
  assert.equal(byTarget.get(targetB.url), 6);
});

// ── Root-cause rollup (V9.0) ─────────────────────────────────────────────
// buildRootCauseGroups() groups every finding by (ruleId, evidence
// signature) per its `evidenceFamily` in issue-catalog.json — always, not
// threshold-gated like collapseTemplateFindings above. Scaled-down versions
// of the brief's own nine worked examples (a)-(i); the shape of each fixture
// mirrors the real one, just with fewer rows.

function groupsFor(rootCauseGroups, ruleId) {
  return rootCauseGroups.filter((g) => g.ruleId === ruleId);
}

test("root-cause (a): links to redirected pages — one shared target collapses to ONE group", () => {
  const finalPage = baseResult({ url: "https://example.com/final", canonical: "https://example.com/final" });
  const redirector = baseResult({
    url: "https://example.com/old-service",
    status: 301,
    canonical: "",
    redirectUrl: finalPage.url,
  });
  const pages = Array.from({ length: 6 }, (_, i) => baseResult({ url: `https://example.com/page-${i}` }));
  const linkEdges = pages.map((page) => ({
    sourceUrl: page.url,
    targetUrl: redirector.url,
    internal: true,
    anchorText: "Old service",
  }));
  const { findings, rootCauseGroups } = buildFindings({
    results: [...pages, redirector, finalPage],
    linkEdges,
    startUrl: pages[0].url,
  });
  const groups = groupsFor(rootCauseGroups, "link-to-redirect");
  assert.equal(groups.length, 1, "all 6 links to the same redirected URL are one root cause");
  assert.equal(groups[0].memberCount, 6);
  assert.equal(groups[0].uniqueTargetCount, 1);
  const members = findings.filter((f) => f.ruleId === "link-to-redirect");
  assert.ok(members.every((f) => f.rootCauseGroupId === groups[0].groupId));
  assert.ok(members.every((f) => f.groupMemberCount === 6));
});

test("root-cause (b): a permanent redirect is its own single-member group (merge with (a) is Part 2)", () => {
  const redirector = baseResult({
    url: "https://example.com/legacy",
    status: 301,
    canonical: "",
    redirectUrl: "https://example.com/current",
  });
  const { rootCauseGroups } = buildFindings({
    results: [redirector, baseResult({ url: "https://example.com/current" })],
    startUrl: redirector.url,
  });
  const groups = groupsFor(rootCauseGroups, "permanent-redirect");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].memberCount, 1);
  assert.equal(groups[0].uniqueTargetCount, 1, "self-url family: the group's own identity is the redirecting URL");
});

test("root-cause (c): links without an accessible name collapse per distinct destination, not per row", () => {
  const targets = ["a", "b", "c"].map((id) =>
    baseResult({ url: `https://example.com/icon-${id}`, contentType: "image/svg+xml", isAsset: true }),
  );
  const pages = Array.from({ length: 4 }, (_, i) => baseResult({ url: `https://example.com/page-${i}` }));
  // 3 icon links per page, same 3 destinations every time — 12 rows, 3 distinct targets.
  const linkEdges = pages.flatMap((page) =>
    targets.map((target) => ({ sourceUrl: page.url, targetUrl: target.url, internal: true })),
  );
  const { findings, rootCauseGroups } = buildFindings({
    results: [...pages, ...targets],
    linkEdges,
    startUrl: pages[0].url,
  });
  const missing = findings.filter((f) => f.ruleId === "anchor-missing");
  assert.equal(missing.length, 12, "still one row per occurrence");
  const groups = groupsFor(rootCauseGroups, "anchor-missing");
  assert.equal(groups.length, 3, "3 unique targets -> 3 groups, not 12");
  assert.ok(groups.every((g) => g.memberCount === 4));
});

test("root-cause (d): missing Open Graph properties group by the sorted set of what's missing", () => {
  const bothMissing = Array.from({ length: 4 }, (_, i) =>
    baseResult({
      url: `https://example.com/loc-${i}`,
      openGraphMissing: ["og:image", "og:title"],
      openGraphDescriptionMissing: false,
    }),
  );
  const imageOnlyMissing = baseResult({
    url: "https://example.com/loc-other",
    openGraphMissing: ["og:image"],
    openGraphDescriptionMissing: false,
  });
  const { findings, rootCauseGroups } = buildFindings({
    results: [...bothMissing, imageOnlyMissing],
    startUrl: bothMissing[0].url,
  });
  const incomplete = findings.filter((f) => f.ruleId === "open-graph-incomplete");
  assert.equal(incomplete.length, 5);
  const groups = groupsFor(rootCauseGroups, "open-graph-incomplete");
  assert.equal(groups.length, 2, "two distinct missing-property sets -> two groups");
  const sizes = groups.map((g) => g.memberCount).sort((a, b) => a - b);
  assert.deepEqual(sizes, [1, 4]);
});

test("root-cause (e): schema.org validation errors with the identical message collapse to ONE group", () => {
  const message = "Dentist is missing the required address property";
  const pages = Array.from({ length: 5 }, (_, i) =>
    baseResult({ url: `https://example.com/location-${i}`, schemaErrors: [message] }),
  );
  const { findings, rootCauseGroups } = buildFindings({ results: pages, startUrl: pages[0].url });
  assert.equal(findings.filter((f) => f.ruleId === "schema-error").length, 5);
  const groups = groupsFor(rootCauseGroups, "schema-error");
  assert.equal(groups.length, 1, "identical validation message -> one schema template fix");
  assert.equal(groups[0].memberCount, 5);
});

test("root-cause (f): non-descriptive link labels cluster case-insensitively per destination, but not across destinations", () => {
  const targetA = baseResult({ url: "https://example.com/guide-a" });
  const targetB = baseResult({ url: "https://example.com/guide-b" });
  const pages = Array.from({ length: 3 }, (_, i) => baseResult({ url: `https://example.com/page-${i}` }));
  const linkEdges = [
    { sourceUrl: pages[0].url, targetUrl: targetA.url, internal: true, anchorText: "Read More" },
    { sourceUrl: pages[1].url, targetUrl: targetA.url, internal: true, anchorText: "read more" },
    { sourceUrl: pages[2].url, targetUrl: targetB.url, internal: true, anchorText: "Learn More" },
  ];
  const { findings, rootCauseGroups } = buildFindings({
    results: [...pages, targetA, targetB],
    linkEdges,
    startUrl: pages[0].url,
  });
  assert.equal(findings.filter((f) => f.ruleId === "anchor-nondescriptive").length, 3);
  const groups = groupsFor(rootCauseGroups, "anchor-nondescriptive");
  assert.equal(groups.length, 2, "'Read More'/'read more' -> targetA collapse; 'Learn More' -> targetB stays separate");
  const byTarget = new Map(groups.map((g) => [g.uniqueTargetCount, g.memberCount]));
  assert.equal(groups.find((g) => g.memberCount === 2)?.uniqueTargetCount, 1);
});

test("root-cause (g): slow pages are one Config group regardless of how many pages are slow", () => {
  const pages = Array.from({ length: 5 }, (_, i) =>
    baseResult({ url: `https://example.com/slow-${i}`, responseTime: 1200 + i * 500 }),
  );
  const { findings, rootCauseGroups } = buildFindings({ results: pages, startUrl: pages[0].url });
  assert.equal(findings.filter((f) => f.ruleId === "slow-page").length, 5);
  const groups = groupsFor(rootCauseGroups, "slow-page");
  assert.equal(groups.length, 1, "server response time is one fix, not N page-by-page ones");
  assert.equal(groups[0].memberCount, 5);
  assert.equal(groups[0].fixType, "Config");
});

test("root-cause (h): external links unavailable during checking do NOT over-collapse — distinct targets stay distinct", () => {
  const source = baseResult({ url: "https://example.com/resources" });
  const targets = Array.from({ length: 4 }, (_, i) =>
    baseResult({ url: `https://dead-${i}.test/page`, scope: "External", status: 404, statusText: "Not Found", canonical: "" }),
  );
  const linkEdges = targets.map((target) => ({
    sourceUrl: source.url,
    targetUrl: target.url,
    internal: false,
    anchorText: "Reference",
  }));
  const { findings, rootCauseGroups } = buildFindings({
    results: [source, ...targets],
    linkEdges,
    startUrl: source.url,
  });
  assert.equal(findings.filter((f) => f.ruleId === "broken-external-link").length, 4);
  const groups = groupsFor(rootCauseGroups, "broken-external-link");
  assert.equal(groups.length, 4, "4 distinct broken destinations -> 4 groups, NOT one merged action");
  assert.ok(groups.every((g) => g.memberCount === 1));
});

test("root-cause (i): external 403s group per distinct bot-protected destination", () => {
  const source = baseResult({ url: "https://example.com/partners" });
  const domainA = baseResult({ url: "https://social-a.test/profile", scope: "External", status: 403, statusText: "Forbidden", canonical: "" });
  const domainB = baseResult({ url: "https://social-b.test/profile", scope: "External", status: 403, statusText: "Forbidden", canonical: "" });
  const otherPages = Array.from({ length: 2 }, (_, i) => baseResult({ url: `https://example.com/page-${i}` }));
  const linkEdges = [source, ...otherPages].flatMap((page) => [
    { sourceUrl: page.url, targetUrl: domainA.url, internal: false, anchorText: "Follow us" },
    { sourceUrl: page.url, targetUrl: domainB.url, internal: false, anchorText: "Follow us" },
  ]);
  const { findings, rootCauseGroups } = buildFindings({
    results: [source, ...otherPages, domainA, domainB],
    linkEdges,
    startUrl: source.url,
  });
  assert.equal(findings.filter((f) => f.ruleId === "external-403").length, 6);
  const groups = groupsFor(rootCauseGroups, "external-403");
  assert.equal(groups.length, 2, "2 bot-protected destinations linked from every page -> 2 groups, not 6");
  assert.ok(groups.every((g) => g.memberCount === 3));
});
