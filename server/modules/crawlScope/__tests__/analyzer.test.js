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
  const single = baseResult({ url: "https://example.com/single", inlinks: 1 });
  const orphan = baseResult({ url: "https://example.com/orphan", inlinks: 0, fromSitemap: true });
  const { findings } = buildFindings({
    results: [single, orphan],
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
