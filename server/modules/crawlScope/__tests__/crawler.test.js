const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler, normalizeUrl, __assertGraphReady: assertGraphReady } = require("../crawler");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("normalizes crawlable URLs and drops fragments", () => {
  assert.equal(
    normalizeUrl("../about#team", "https://EXAMPLE.com/products/item"),
    "https://example.com/about",
  );
  assert.equal(normalizeUrl("mailto:hello@example.com"), null);
});

test("crawls internal HTML, follows redirects, respects robots, and finds duplicates", async (t) => {
  const server = http.createServer((request, response) => {
    const routes = {
      "/robots.txt": [
        200,
        "text/plain",
        "User-agent: *\nDisallow: /private\nAllow: /private/public",
      ],
      "/": [
        200,
        "text/html",
        `<!doctype html><html><head>
          <title>Local audit home page title</title>
          <meta name="description" content="A useful local test page description that is long enough for an SEO audit fixture and validates extraction.">
          <link rel="canonical" href="/">
        </head><body><h1>Home</h1><p>${"Useful content ".repeat(210)}</p>
          <a href="/about">About</a>
          <a href="/duplicate">Duplicate title fixture</a>
          <a href="/broken">Broken</a>
          <a href="/redirect">Redirect</a>
          <a href="/private">Private</a>
          <a href="/file.pdf">PDF</a>
          <a href="https://example.org/external">External</a>
        </body></html>`,
      ],
      "/about": [
        200,
        "text/html",
        `<!doctype html><html><head>
          <title>Local audit home page title</title>
          <meta name="robots" content="noindex">
        </head><body><h1>About</h1><p>Short page.</p></body></html>`,
      ],
      "/duplicate": [
        200,
        "text/html",
        `<!doctype html><html><head>
          <title>Local audit home page title</title>
          <meta name="description" content="A distinct and sufficiently long description for the indexable duplicate-title fixture page.">
          <link rel="canonical" href="/duplicate">
        </head><body><h1>Duplicate title fixture</h1><p>${"Different useful content. ".repeat(80)}</p></body></html>`,
      ],
      "/broken": [404, "text/html", "<html><head><title>Missing</title></head><body>Gone</body></html>"],
      "/redirect": [302, "text/html", ""],
      "/private": [200, "text/html", "<html><body>Should not be fetched</body></html>"],
    };
    const [status, type, body] = routes[request.url] || [404, "text/plain", "Not found"];
    response.statusCode = status;
    response.setHeader("Content-Type", type);
    if (request.url === "/redirect") response.setHeader("Location", "/about");
    response.end(body);
  });
  t.after(() => server.close());

  const port = await listen(server);
  const crawler = new SeoCrawler({
    maxUrls: 20,
    concurrency: 2,
    respectRobots: true,
    crawlAssets: false,
    checkExternalLinks: false,
    discoverSitemaps: false,
    timeout: 5_000,
  });
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);

  assert.equal(summary.stopped, false);
  assert.equal(summary.results.length, 6);
  assert.equal(summary.robotsStatus, "Respected");
  // The run carries the whole rule catalog (the 92 original checks, the three
  // ways a crawl can come back thin, title-missing, and every rule added since),
  // not a subset. Compared with the file so adding a rule does not also mean
  // editing a hard-coded count here.
  assert.equal(summary.catalog.length, require("../issue-catalog.json").length);
  assert.ok(summary.catalog.length >= 96);
  assert.ok(
    summary.findings.some((finding) => finding.ruleId === "broken-internal-links"),
  );
  assert.ok(summary.findings.some((finding) => finding.ruleId === "llms-missing"));

  const home = summary.results.find((item) => item.url.endsWith(`${port}/`));
  const about = summary.results.find((item) => item.url.endsWith("/about"));
  const duplicate = summary.results.find((item) => item.url.endsWith("/duplicate"));
  const broken = summary.results.find((item) => item.url.endsWith("/broken"));
  const redirect = summary.results.find((item) => item.url.endsWith("/redirect"));
  const blocked = summary.results.find((item) => item.url.endsWith("/private"));

  assert.equal(home.status, 200);
  assert.equal(home.externalLinks, 1);
  assert.ok(home.words > 200);
  assert.equal(about.indexability, "Non-indexable");
  // Distinct linking pages: the home page links to /about directly and via
  // /redirect (302 -> /about), which is still one page linking to it. The old
  // count of 2 was one per link element plus one for the redirect hop.
  assert.equal(about.inlinks, 1);
  assert.ok(!about.issues.some((issue) => issue.id === "title-duplicate"));
  assert.ok(home.issues.some((issue) => issue.id === "title-duplicate"));
  assert.ok(duplicate.issues.some((issue) => issue.id === "title-duplicate"));
  assert.equal(broken.status, 404);
  assert.ok(broken.issues.some((issue) => issue.id === "page-4xx"));
  assert.equal(redirect.status, 302);
  assert.ok(redirect.redirectUrl.endsWith("/about"));
  assert.equal(blocked.statusText, "Blocked by robots.txt");
});

test("detects third-party tags by static signature match — placement, loading, and a clean page", async (t) => {
  const server = http.createServer((request, response) => {
    const routes = {
      "/robots.txt": [200, "text/plain", "User-agent: *\nAllow: /"],
      "/": [
        200,
        "text/html",
        `<!doctype html><html><head>
          <title>Tag fixture home</title>
          <meta name="description" content="A page carrying a Google Tag Manager container and a legacy Universal Analytics snippet, for detection coverage.">
          <link rel="canonical" href="/">
          <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id=GTM-XXXX'+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-XXXX');</script>
        </head><body><h1>Home</h1><p>${"Fixture content for the tag-detection test page. ".repeat(20)}</p>
          <script>(function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){(i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)})(window,document,'script','https://www.google-analytics.com/analytics.js','ga');ga('create', 'UA-XXXXXX-1', 'auto');ga('send', 'pageview');</script>
          <script src="https://connect.facebook.net/en_US/fbevents.js" async></script>
          <a href="/clean">Clean</a>
        </body></html>`,
      ],
      "/clean": [
        200,
        "text/html",
        `<!doctype html><html><head>
          <title>Tag fixture clean page</title>
          <meta name="description" content="A page with no third-party scripts at all, to confirm detection stays empty rather than false-positive.">
        </head><body><h1>Clean</h1><p>${"No tags on this page at all. ".repeat(20)}</p></body></html>`,
      ],
    };
    const [status, type, body] = routes[request.url] || [404, "text/plain", "Not found"];
    response.statusCode = status;
    response.setHeader("Content-Type", type);
    response.end(body);
  });
  t.after(() => server.close());

  const port = await listen(server);
  const crawler = new SeoCrawler({
    maxUrls: 20,
    concurrency: 2,
    respectRobots: true,
    crawlAssets: false,
    checkExternalLinks: false,
    discoverSitemaps: false,
    timeout: 5_000,
  });
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);

  const home = summary.results.find((item) => item.url.endsWith(`${port}/`));
  const clean = summary.results.find((item) => item.url.endsWith("/clean"));

  const byId = new Map(home.integrations.map((i) => [i.id, i]));
  assert.equal(byId.size, 3);

  const gtm = byId.get("google-tag-manager");
  assert.ok(gtm, "GTM's inline embed snippet should be detected");
  assert.equal(gtm.location, "head");
  // The snippet's own dynamically-inserted script is async, but the
  // detected element here is the INLINE bootstrap script itself, which runs
  // synchronously as the parser reaches it.
  assert.equal(gtm.loading, "sync");

  const ua = byId.get("universal-analytics");
  assert.ok(ua, "the legacy Universal Analytics snippet should still be detected");
  assert.equal(ua.location, "body");

  const pixel = byId.get("facebook-pixel");
  assert.ok(pixel, "the externally-sourced Facebook Pixel script should be detected");
  assert.equal(pixel.location, "body");
  assert.equal(pixel.loading, "async");

  assert.deepEqual(clean.integrations, []);

  // The per-page detections above are only half the feature — the run-level
  // aggregate (what the dashboard's "Tags detected" chart and "Integrations
  // detected" section actually read, via run.summary.integrations) has to
  // survive the trip from analyzer.js's buildFindings() through crawler.js's
  // own returned payload. It's easy to wire the per-page half and forget the
  // aggregate never got copied onto that payload — this would have caught
  // exactly that: summary.integrations silently `null` while every page's
  // own `.integrations` array was already correct.
  assert.ok(summary.integrations, "summary.integrations must not be null when detections exist");
  assert.equal(summary.integrations.totalPages, summary.results.filter((r) => r.contentType?.includes("text/html") && r.scope !== "External").length);
  const gtmAggregate = summary.integrations.items.find((i) => i.id === "google-tag-manager");
  assert.ok(gtmAggregate, "the site-wide aggregate must include the vendor detected on the home page");
  assert.equal(gtmAggregate.pageCount, 1);

  // Same class of bug, same guard: analyzer.js's buildFindings() computes
  // rootCauseGroups (V9.0's root-cause rollup), and it's just as easy to
  // wire it into analysis.* and forget to copy it onto crawler.js's own
  // returned payload — this catches that before it ships silently null.
  assert.ok(Array.isArray(summary.rootCauseGroups), "summary.rootCauseGroups must survive the trip through crawler.js's payload");
});

test("Location creates redirect state and crawl jobs only for Fetch redirect statuses", async () => {
  const origin = "https://secure.test";
  const seedUrl = `${origin}/`;
  const redirectUrl = `${origin}/status-301`;
  const invalidRedirectUrl = `${origin}/status-308-invalid`;
  const missingRedirectUrl = `${origin}/status-302-missing`;
  const nonHttpRedirectUrl = `${origin}/status-307-non-http`;
  const emptyRedirectUrl = `${origin}/status-303-empty`;
  const loopAUrl = `${origin}/loop-a`;
  const loopBUrl = `${origin}/loop-b`;
  const redirectTargetUrl = `${origin}/redirect-target`;
  const phantomTargetUrl = `${origin}/phantom-target`;
  const nonRedirectStatuses = [200, 201, 300, 304, 305, 306];
  const requested = [];
  const healthyPage = (body) => `<!doctype html><html><head>
    <title>Location status fixture page</title>
    <meta name="description" content="A sufficiently long description for the Location response status fixture page.">
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head><body>
    <h1>Location status fixture</h1>
    ${body}
    <p>${"Useful fixture content. ".repeat(220)}</p>
  </body></html>`;
  const crawler = new SeoCrawler({
    maxUrls: 16,
    concurrency: 2,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
    fetch: async (url) => {
      requested.push(url);
      if (url === `${origin}/llms.txt`) {
        return new Response("", { status: 404 });
      }
      if (url === "http://secure.test/") {
        return new Response("", {
          status: 300,
          headers: { Location: `${origin}/not-an-http-upgrade` },
        });
      }
      if (url === seedUrl) {
        const links = [
          ...nonRedirectStatuses.map(
            (status) => `<a href="/status-${status}">Status ${status}</a>`,
          ),
          '<a href="/status-301">Status 301</a>',
          '<a href="/status-308-invalid">Invalid status 308</a>',
          '<a href="/status-302-missing">Missing status 302</a>',
          '<a href="/status-307-non-http">Non-HTTP status 307</a>',
          '<a href="/status-303-empty">Empty status 303</a>',
          '<a href="/loop-a">Redirect loop</a>',
        ].join("");
        return new Response(healthyPage(links), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url === invalidRedirectUrl) {
        return new Response(null, {
          status: 308,
          headers: {
            "Content-Type": "text/html",
            Location: "http://[invalid",
          },
        });
      }
      if (url === missingRedirectUrl) {
        return new Response(null, {
          status: 302,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url === nonHttpRedirectUrl) {
        return new Response(null, {
          status: 307,
          headers: {
            "Content-Type": "text/html",
            Location: "mailto:ops@secure.test",
          },
        });
      }
      if (url === emptyRedirectUrl) {
        return new Response(null, {
          status: 303,
          headers: {
            "Content-Type": "text/html",
            Location: "",
          },
        });
      }
      if (url === loopAUrl) {
        return new Response(null, {
          status: 302,
          headers: {
            "Content-Type": "text/html",
            Location: "/loop-b",
          },
        });
      }
      if (url === loopBUrl) {
        return new Response(null, {
          status: 308,
          headers: {
            "Content-Type": "text/html",
            Location: "/loop-a",
          },
        });
      }
      const statusMatch = /\/status-(\d+)$/.exec(url);
      if (statusMatch) {
        const status = Number(statusMatch[1]);
        const isNullBody = status === 304 || status === 301;
        return new Response(
          isNullBody ? null : status < 300 ? healthyPage("") : "",
          {
            status,
            headers: {
              "Content-Type": "text/html",
              Location:
                status === 301 ? "/redirect-target" : "/phantom-target",
            },
          },
        );
      }
      if (url === redirectTargetUrl || url === phantomTargetUrl) {
        return new Response(healthyPage(""), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("", { status: 404 });
    },
  });

  const summary = await crawler.start(seedUrl);
  assert.ok(requested.includes(redirectTargetUrl));
  assert.ok(!requested.includes(phantomTargetUrl));
  assert.equal(
    requested.filter((url) => url === loopAUrl).length,
    1,
    "the first loop member must be fetched only once",
  );
  assert.equal(
    requested.filter((url) => url === loopBUrl).length,
    1,
    "the second loop member must be fetched only once",
  );
  assert.equal(summary.results.length, 15);

  const resultByUrl = new Map(
    summary.results.map((result) => [result.url, result]),
  );
  for (const status of nonRedirectStatuses) {
    const result = resultByUrl.get(`${origin}/status-${status}`);
    assert.equal(result.locationHeaderRaw, "/phantom-target", String(status));
    assert.equal(result.locationHeaderPresent, true, String(status));
    assert.equal(result.redirectLocationIssue, "", String(status));
    assert.equal(result.redirectUrl, "", String(status));
    assert.ok(
      !result.issues.some((issue) =>
        ["permanent-redirect", "temporary-redirect"].includes(issue.id),
      ),
      `${status} must not be labeled as a redirect`,
    );
  }

  const redirect = resultByUrl.get(redirectUrl);
  assert.equal(redirect.locationHeaderRaw, "/redirect-target");
  assert.equal(redirect.redirectUrl, redirectTargetUrl);
  assert.ok(
    redirect.issues.some((issue) => issue.id === "permanent-redirect"),
  );
  assert.equal(resultByUrl.get(redirectTargetUrl).inlinks, 1);

  const invalidRedirect = resultByUrl.get(invalidRedirectUrl);
  assert.equal(invalidRedirect.status, 308);
  assert.equal(invalidRedirect.locationHeaderRaw, "http://[invalid");
  assert.equal(invalidRedirect.redirectUrl, "");
  assert.equal(invalidRedirect.redirectLocationIssue, "malformed");
  assert.ok(
    !invalidRedirect.issues.some((issue) => issue.id === "crawl-failure"),
    "an invalid Location value must not erase the received redirect response",
  );

  const missingRedirect = resultByUrl.get(missingRedirectUrl);
  assert.equal(missingRedirect.locationHeaderPresent, false);
  assert.equal(missingRedirect.locationHeaderRaw, "");
  assert.equal(missingRedirect.redirectLocationIssue, "missing");

  const nonHttpRedirect = resultByUrl.get(nonHttpRedirectUrl);
  assert.equal(nonHttpRedirect.locationHeaderPresent, true);
  assert.equal(nonHttpRedirect.redirectLocationIssue, "non-http");
  assert.equal(nonHttpRedirect.redirectLocationScheme, "mailto");
  assert.equal(nonHttpRedirect.redirectUrl, "");

  const emptyRedirect = resultByUrl.get(emptyRedirectUrl);
  assert.equal(emptyRedirect.locationHeaderPresent, true);
  assert.equal(emptyRedirect.redirectLocationIssue, "");
  assert.equal(emptyRedirect.redirectUrl, emptyRedirectUrl);
  assert.equal(emptyRedirect.inlinks, 1, "a self redirect must not add a self inlink");
  assert.ok(
    emptyRedirect.issues.some((issue) => issue.id === "redirect-loop"),
  );
  assert.ok(
    !emptyRedirect.issues.some((issue) => issue.id === "redirect-chain"),
  );

  for (const [url, path] of [
    [loopAUrl, `${loopAUrl} -> ${loopBUrl} -> ${loopAUrl}`],
    [loopBUrl, `${loopBUrl} -> ${loopAUrl} -> ${loopBUrl}`],
  ]) {
    const loopFinding = summary.findings.find(
      (finding) =>
        finding.ruleId === "redirect-loop" && finding.url === url,
    );
    assert.ok(loopFinding);
    assert.equal(loopFinding.detectedValue, path);
    assert.ok(
      !summary.findings.some(
        (finding) =>
          finding.ruleId === "redirect-chain" && finding.url === url,
      ),
    );
  }

  const unusableFindings = summary.findings.filter(
    (finding) => finding.ruleId === "redirect-location-invalid",
  );
  assert.equal(unusableFindings.length, 3);
  assert.deepEqual(
    new Set(unusableFindings.map((finding) => finding.url)),
    new Set([invalidRedirectUrl, missingRedirectUrl, nonHttpRedirectUrl]),
  );

  const redirectLinkFindings = summary.findings.filter(
    (finding) => finding.ruleId === "link-to-redirect",
  );
  assert.equal(redirectLinkFindings.length, 6);
  assert.deepEqual(
    new Set(redirectLinkFindings.map((finding) => finding.targetUrl)),
    new Set([
      redirectUrl,
      invalidRedirectUrl,
      missingRedirectUrl,
      nonHttpRedirectUrl,
      emptyRedirectUrl,
      loopAUrl,
    ]),
  );
  assert.equal(
    summary.siteDiagnostics.httpHomepageIssue,
    "HTTP returned 300 without a direct HTTPS redirect or HTTPS canonical.",
  );
});

test("extracts hreflang alternate links from the page head", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><html><head><title>Home</title>
          <link rel="alternate" hreflang="en" href="/">
          <link rel="alternate" hreflang="fr" href="/fr/">
          <link rel="alternate" hreflang="x-default" href="/">
        </head><body><h1>Home</h1></body></html>`,
      );
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  t.after(() => server.close());
  const port = await listen(server);

  const crawler = new SeoCrawler({
    maxUrls: 5,
    respectRobots: false,
    discoverSitemaps: false,
    timeout: 5_000,
  });
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);
  const home = summary.results.find((item) => item.url.endsWith(`${port}/`));

  assert.equal(home.hreflangs.length, 3);
  assert.deepEqual(
    home.hreflangs.map((entry) => entry.lang).sort(),
    ["en", "fr", "x-default"],
  );
  assert.ok(home.hreflangs.some((entry) => entry.url === `http://127.0.0.1:${port}/fr/`));
});

test("extracts rel=next/prev pagination links from the page head", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/page-2") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><html><head><title>Page 2</title>
          <link rel="prev" href="/page-1">
          <link rel="next" href="/page-3">
        </head><body><h1>Page 2</h1></body></html>`,
      );
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  t.after(() => server.close());
  const port = await listen(server);

  const crawler = new SeoCrawler({
    maxUrls: 5,
    respectRobots: false,
    discoverSitemaps: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });
  const summary = await crawler.start(`http://127.0.0.1:${port}/page-2`);
  const page2 = summary.results.find((item) => item.url.endsWith("/page-2"));

  assert.equal(page2.paginationPrev, `http://127.0.0.1:${port}/page-1`);
  assert.equal(page2.paginationNext, `http://127.0.0.1:${port}/page-3`);
});

test("does not parse a redirect's HTML fallback body for links, canonical, or hreflang", async (t) => {
  // Real calibration case: position2.com's redirect responses ship an HTML
  // fallback body ("if you are not redirected, click here") with a real
  // <a href> link and vague anchor text — none of which is real page content.
  const server = http.createServer((request, response) => {
    if (request.url === "/old-page") {
      response.statusCode = 308;
      response.setHeader("Content-Type", "text/html");
      response.setHeader("Location", "/new-page");
      response.end(
        `<!doctype html><html><head><link rel="canonical" href="/old-page"></head>
          <body>Redirecting... if you are not redirected automatically, <a href="/new-page">here</a>.</body></html>`,
      );
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end("<html><head><title>New page</title></head><body>ok</body></html>");
  });
  t.after(() => server.close());
  const port = await listen(server);

  const crawler = new SeoCrawler({
    maxUrls: 5,
    respectRobots: false,
    discoverSitemaps: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });
  const summary = await crawler.start(`http://127.0.0.1:${port}/old-page`);
  const redirectPage = summary.results.find((item) => item.url.endsWith("/old-page"));

  assert.equal(redirectPage.status, 308);
  assert.equal(redirectPage.canonical, "", "should not extract canonical from a redirect's fallback body");
  assert.deepEqual(redirectPage.hreflangs, []);
  assert.ok(
    !summary.findings.some((f) => f.ruleId === "anchor-nondescriptive"),
    "the redirect fallback link's vague anchor text should not be treated as real editorial content",
  );
});

test("validates Product, Article, and Organization JSON-LD against required properties", async (t) => {
  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/product-incomplete") {
      response.end(
        `<!doctype html><html><head><title>Product</title>
          <script type="application/ld+json">{"@type":"Product"}</script>
        </head><body>ok</body></html>`,
      );
      return;
    }
    if (request.url === "/product-complete") {
      response.end(
        `<!doctype html><html><head><title>Product</title>
          <script type="application/ld+json">{"@type":"Product","name":"Widget","offers":{"price":"9.99"}}</script>
        </head><body>ok</body></html>`,
      );
      return;
    }
    if (request.url === "/article-incomplete") {
      response.end(
        `<!doctype html><html><head><title>Article</title>
          <script type="application/ld+json">{"@type":"BlogPosting","headline":"A post"}</script>
        </head><body>ok</body></html>`,
      );
      return;
    }
    if (request.url === "/org-incomplete") {
      response.end(
        `<!doctype html><html><head><title>Org</title>
          <script type="application/ld+json">{"@type":"Organization","url":"https://example.com"}</script>
        </head><body>ok</body></html>`,
      );
      return;
    }
    response.end("<html><body>ok</body></html>");
  });
  t.after(() => server.close());
  const port = await listen(server);

  async function crawlOne(path) {
    const crawler = new SeoCrawler({
      maxUrls: 1,
      respectRobots: false,
      discoverSitemaps: false,
      timeout: 5_000,
    });
    const summary = await crawler.start(`http://127.0.0.1:${port}${path}`);
    return summary.results[0];
  }

  const productIncomplete = await crawlOne("/product-incomplete");
  assert.ok(productIncomplete.schemaErrors.some((e) => e.includes("missing the required name")));
  assert.ok(productIncomplete.schemaErrors.some((e) => e.includes("offers, review, or aggregateRating")));

  const productComplete = await crawlOne("/product-complete");
  assert.equal(productComplete.schemaErrors.length, 0);

  const articleIncomplete = await crawlOne("/article-incomplete");
  assert.ok(articleIncomplete.schemaErrors.some((e) => e.includes("missing the required image")));
  assert.ok(articleIncomplete.schemaErrors.some((e) => e.includes("missing the required datePublished")));
  assert.ok(
    !articleIncomplete.schemaErrors.some((e) => e.includes("headline")),
    "headline was present, should not be flagged",
  );

  const orgIncomplete = await crawlOne("/org-incomplete");
  assert.ok(orgIncomplete.schemaErrors.some((e) => e.includes("Organization is missing the required name")));
});

test("extracts the viewport meta tag's content", async (t) => {
  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/responsive") {
      response.end(
        `<!doctype html><html><head><title>Responsive</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head><body>ok</body></html>`,
      );
      return;
    }
    response.end("<!doctype html><html><head><title>No viewport</title></head><body>ok</body></html>");
  });
  t.after(() => server.close());
  const port = await listen(server);

  async function crawlOne(path) {
    const crawler = new SeoCrawler({
      maxUrls: 1,
      respectRobots: false,
      discoverSitemaps: false,
      timeout: 5_000,
    });
    const summary = await crawler.start(`http://127.0.0.1:${port}${path}`);
    return summary.results[0];
  }

  const responsive = await crawlOne("/responsive");
  assert.equal(responsive.viewport, "width=device-width, initial-scale=1");

  const missing = await crawlOne("/missing");
  assert.equal(missing.viewport, "");
});

test("extracts every skipped heading-level transition with its surrounding text", async (t) => {
  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/valid") {
      response.end(`<!doctype html><html><head>
        <title>Valid heading hierarchy fixture</title>
        <meta name="description" content="A sufficiently long fixture description for testing a valid heading hierarchy accurately.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head><body>
        <h1>Technical SEO audit</h1>
        <h2>Crawlability</h2>
        <h3>Robots directives</h3>
        <h2>Performance</h2>
        <h3>Image delivery</h3>
      </body></html>`);
      return;
    }
    response.end(`<!doctype html><html><head>
      <title>Heading hierarchy fixture</title>
      <meta name="description" content="A sufficiently long fixture description for testing heading hierarchy extraction accurately.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head><body>
      <h1>Technical SEO audit</h1>
      <h3>Crawlability findings</h3>
      <h2>Performance</h2>
      <h4>Image delivery</h4>
    </body></html>`);
  });
  t.after(() => server.close());
  const port = await listen(server);
  async function crawlOne(path) {
    const crawler = new SeoCrawler({
      maxUrls: 1,
      respectRobots: false,
      discoverSitemaps: false,
      crawlAssets: false,
      checkExternalLinks: false,
      timeout: 5_000,
    });
    return crawler.start(`http://127.0.0.1:${port}${path}`);
  }

  const summary = await crawlOne("/");
  const page = summary.results[0];

  assert.equal(page.headingHierarchyIssue, true);
  assert.deepEqual(page.headingHierarchyIssues, [
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
  ]);
  assert.equal(
    summary.findings.filter(
      (finding) => finding.ruleId === "heading-hierarchy-skipped",
    ).length,
    2,
  );

  const validSummary = await crawlOne("/valid");
  assert.equal(validSummary.results[0].headingHierarchyIssue, false);
  assert.deepEqual(validSummary.results[0].headingHierarchyIssues, []);
  assert.ok(
    !validSummary.findings.some(
      (finding) => finding.ruleId === "heading-hierarchy-skipped",
    ),
  );
});

test("detects exact duplicate visible content end to end", async (t) => {
  const sharedBody = `<h1>Shared service page</h1><p>${"Specific service information and customer guidance. ".repeat(60)}</p>`;
  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/") {
      response.end(`<!doctype html><html><head>
        <title>Duplicate content fixture index</title>
        <meta name="description" content="A sufficiently long description for the duplicate-content fixture index page.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="canonical" href="/">
      </head><body><h1>Fixture index</h1><a href="/alpha">Alpha</a><a href="/beta">Beta</a></body></html>`);
      return;
    }
    // Only the two duplicated pages exist. A catch-all 200 would also answer the
    // crawler's missing-page probe with this body, which (correctly) marks both
    // pages as the site's not-found page instead of as duplicates.
    if (request.url !== "/alpha" && request.url !== "/beta") {
      response.statusCode = 404;
      response.end("<!doctype html><html><head><title>Not found</title></head><body>Not found</body></html>");
      return;
    }
    const canonical = request.url === "/alpha" ? "/alpha" : "/beta";
    response.end(`<!doctype html><html><head>
      <title>Shared service title</title>
      <meta name="description" content="A sufficiently long shared description for both intentionally duplicated fixture pages.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="canonical" href="${canonical}">
    </head><body>${sharedBody}</body></html>`);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const crawler = new SeoCrawler({
    maxUrls: 3,
    concurrency: 2,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });

  const summary = await crawler.start(`http://127.0.0.1:${port}/`);
  const alpha = summary.results.find((result) => result.url.endsWith("/alpha"));
  const beta = summary.results.find((result) => result.url.endsWith("/beta"));
  const duplicates = summary.findings.filter(
    (finding) => finding.ruleId === "content-duplicate-exact",
  );

  assert.equal(alpha.hash, beta.hash);
  assert.equal(alpha.words, 363);
  assert.match(alpha.contentSample, /Shared service page Specific service information/);
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every((finding) => finding.targetUrl));
});

test("recognizes accessible names on icon and image links without hiding genuinely unlabeled links", async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head>
      <title>Accessible link names fixture</title>
      <meta name="description" content="A sufficiently long description for the accessible link names extraction fixture.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head><body>
      <h1>Accessible link names</h1>
      <span id="profile-label">View Jane Doe's profile</span>
      <a href="/labelled-by" aria-labelledby="profile-label"><svg aria-hidden="true"></svg></a>
      <a href="/nested-label"><svg aria-label="Open the company profile"></svg></a>
      <a href="/svg-title"><svg><title>Return to the homepage</title></svg></a>
      <a href="/svg-text"><svg><text>Open the location map</text></svg></a>
      <a href="/later-image-alt"><img alt=""><img alt="Browse the product catalog"></a>
      <a href="/hidden-label"><svg aria-label="Decorative icon" aria-hidden="true"></svg></a>
      <a href="/missing"><img alt=""></a>
    </body></html>`);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const crawler = new SeoCrawler({
    maxUrls: 1,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });

  const summary = await crawler.start([`http://127.0.0.1:${port}/`]);
  const missing = summary.findings.filter(
    (finding) => finding.ruleId === "anchor-missing",
  );

  assert.deepEqual(
    missing.map((finding) => new URL(finding.targetUrl).pathname).sort(),
    ["/hidden-label", "/missing"],
  );
  assert.ok(
    missing.every(
      (finding) =>
        finding.detectedValue === "Image link with empty alt text" ||
        finding.detectedValue === "SVG/icon link without an accessible label",
    ),
  );
  const labelledByEdge = crawler.linkEdges.find((edge) =>
    edge.targetUrl.endsWith("/labelled-by"),
  );
  const nestedLabelEdge = crawler.linkEdges.find((edge) =>
    edge.targetUrl.endsWith("/nested-label"),
  );
  const svgTitleEdge = crawler.linkEdges.find((edge) =>
    edge.targetUrl.endsWith("/svg-title"),
  );
  const imageAltEdge = crawler.linkEdges.find((edge) =>
    edge.targetUrl.endsWith("/later-image-alt"),
  );
  const svgTextEdge = crawler.linkEdges.find((edge) =>
    edge.targetUrl.endsWith("/svg-text"),
  );
  assert.equal(labelledByEdge.accessibleName, "View Jane Doe's profile");
  assert.equal(nestedLabelEdge.accessibleName, "Open the company profile");
  assert.equal(svgTitleEdge.accessibleName, "Return to the homepage");
  assert.equal(imageAltEdge.accessibleName, "Browse the product catalog");
  assert.equal(svgTextEdge.anchorText, "Open the location map");
});

test("flags non-descriptive visible text and effective accessible names with precise evidence", async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head>
      <title>Non-descriptive link labels fixture</title>
      <meta name="description" content="A sufficiently long description for the non-descriptive link labels fixture.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head><body>
      <h1>Non-descriptive link labels</h1>
      <a href="/visible-punctuation">Learn more →</a>
      <a href="/accessible-only"><svg aria-label="Click here."></svg></a>
      <a href="/visible-vague-descriptive-accessible" aria-label="Read the technical SEO guide">Read more</a>
      <a href="/descriptive-visible-vague-accessible" aria-label="More">Technical SEO services</a>
      <a href="/descriptive" aria-label="View Jane Doe on LinkedIn"><svg></svg></a>
    </body></html>`);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const crawler = new SeoCrawler({
    maxUrls: 1,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });

  const summary = await crawler.start([`http://127.0.0.1:${port}/`]);
  const findings = summary.findings
    .filter((finding) => finding.ruleId === "anchor-nondescriptive")
    .sort((a, b) => a.targetUrl.localeCompare(b.targetUrl));
  const byPath = new Map(
    findings.map((finding) => [new URL(finding.targetUrl).pathname, finding]),
  );

  assert.equal(findings.length, 4);
  assert.equal(
    byPath.get("/visible-punctuation").detail,
    "Visible anchor text is non-descriptive",
  );
  assert.equal(
    byPath.get("/visible-punctuation").detectedValue,
    "Learn more →",
  );
  assert.equal(
    byPath.get("/accessible-only").detail,
    "Accessible name is non-descriptive",
  );
  assert.equal(byPath.get("/accessible-only").detectedValue, "Click here.");
  assert.equal(
    byPath.get("/visible-vague-descriptive-accessible").detail,
    "Visible anchor text is non-descriptive",
  );
  assert.equal(
    byPath.get("/descriptive-visible-vague-accessible").detail,
    "Accessible name is non-descriptive",
  );
  assert.ok(!byPath.has("/descriptive"));
});

test("separates required Open Graph properties from the optional description", async (t) => {
  const server = http.createServer((request, response) => {
    const pageUrl = `http://${request.headers.host}${request.url}`;
    const common = `
      <meta property="og:title" content="Open Graph fixture">
      <meta property="og:type" content="website">
      <meta property="og:url" content="${pageUrl}">`;
    const variants = {
      "/complete-core": `${common}
        <meta property="og:image" content="https://cdn.example.com/preview.jpg">
        <meta property="og:image:alt" content="A team reviewing a growth dashboard.">`,
      "/missing-required": `${common}
        <meta property="og:description" content="A specific sharing description.">`,
      "/image-url-alias": `${common}
        <meta property="og:image:url" content="https://cdn.example.com/preview.jpg">
        <meta property="og:image:alt" content="A team reviewing a growth dashboard.">
        <meta property="og:description" content="A specific sharing description.">`,
      "/no-open-graph": "",
    };
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head>
      <title>Open Graph metadata fixture</title>
      <meta name="description" content="A sufficiently long description for the Open Graph metadata fixture page.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      ${variants[request.url] ?? ""}
    </head><body>
      <h1>Open Graph metadata fixture</h1>
      <p>${"Useful fixture content. ".repeat(220)}</p>
    </body></html>`);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const paths = [
    "/complete-core",
    "/missing-required",
    "/image-url-alias",
    "/no-open-graph",
  ];
  const crawler = new SeoCrawler({
    maxUrls: paths.length,
    concurrency: 2,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });

  const summary = await crawler.start(
    paths.map((path) => `http://127.0.0.1:${port}${path}`),
  );
  const resultsByPath = new Map(
    summary.results.map((result) => [new URL(result.url).pathname, result]),
  );
  const findingsByPath = new Map(
    paths.map((path) => [
      path,
      summary.findings.filter(
        (finding) =>
          new URL(finding.url).pathname === path &&
          finding.ruleId.startsWith("open-graph-"),
      ),
    ]),
  );

  assert.deepEqual(resultsByPath.get("/complete-core").openGraphMissing, []);
  assert.equal(
    resultsByPath.get("/complete-core").openGraphDescriptionMissing,
    true,
  );
  assert.deepEqual(
    findingsByPath.get("/complete-core").map((finding) => finding.ruleId),
    ["open-graph-description-missing"],
  );

  assert.deepEqual(
    resultsByPath.get("/missing-required").openGraphMissing,
    ["og:image"],
  );
  assert.deepEqual(
    findingsByPath.get("/missing-required").map((finding) => finding.ruleId),
    ["open-graph-incomplete"],
  );
  assert.equal(
    findingsByPath.get("/missing-required")[0].detail,
    "Missing required properties: og:image",
  );

  assert.deepEqual(resultsByPath.get("/image-url-alias").openGraphMissing, []);
  assert.deepEqual(findingsByPath.get("/image-url-alias"), []);

  assert.deepEqual(
    resultsByPath.get("/no-open-graph").openGraphMissing,
    ["og:title", "og:type", "og:image", "og:url"],
  );
  assert.deepEqual(
    findingsByPath.get("/no-open-graph").map((finding) => finding.ruleId),
    ["open-graph-incomplete"],
  );
});

test("flags raw invalid Open Graph URL values without inventing resolved URLs", async (t) => {
  const server = http.createServer((request, response) => {
    const pageUrl = `http://${request.headers.host}${request.url}`;
    const requiredText = `
      <meta property="og:title" content="Open Graph URL fixture">
      <meta property="og:type" content="website">`;
    const variants = {
      "/invalid-og-url": `${requiredText}
        <meta property="og:url" content="not a URL">
        <meta property="og:image" content="https://cdn.example.com/preview.jpg">
        <meta property="og:image:alt" content="A team reviewing a growth dashboard.">
        <meta property="og:description" content="A specific sharing description.">`,
      "/relative-image": `${requiredText}
        <meta property="og:url" content="${pageUrl}">
        <meta property="og:image" content="/preview.jpg">
        <meta property="og:description" content="A specific sharing description.">`,
      "/non-http-image-alias": `${requiredText}
        <meta property="og:url" content="${pageUrl}">
        <meta property="og:image:url" content="data:image/png;base64,abc">
        <meta property="og:description" content="A specific sharing description.">`,
      "/invalid-both-no-description": `${requiredText}
        <meta property="og:url" content="ftp://example.com/page">
        <meta property="og:image" content="//cdn.example.com/preview.jpg">`,
      "/valid-absolute-urls": `${requiredText}
        <meta property="og:url" content="${pageUrl}">
        <meta property="og:image" content="https://cdn.example.com/preview.jpg">
        <meta property="og:image:alt" content="A team reviewing a growth dashboard.">
        <meta property="og:description" content="A specific sharing description.">`,
    };
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head>
      <title>Open Graph URL validation fixture</title>
      <meta name="description" content="A sufficiently long description for the Open Graph URL validation fixture page.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      ${variants[request.url] ?? ""}
    </head><body>
      <h1>Open Graph URL validation fixture</h1>
      <p>${"Useful fixture content. ".repeat(220)}</p>
    </body></html>`);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const paths = [
    "/invalid-og-url",
    "/relative-image",
    "/non-http-image-alias",
    "/invalid-both-no-description",
    "/valid-absolute-urls",
  ];
  const crawler = new SeoCrawler({
    maxUrls: paths.length,
    concurrency: 2,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });

  const summary = await crawler.start(
    paths.map((path) => `http://127.0.0.1:${port}${path}`),
  );
  const resultsByPath = new Map(
    summary.results.map((result) => [new URL(result.url).pathname, result]),
  );
  const findingsByPath = new Map(
    paths.map((path) => [
      path,
      summary.findings.filter(
        (finding) =>
          new URL(finding.url).pathname === path &&
          finding.ruleId.startsWith("open-graph-"),
      ),
    ]),
  );

  assert.equal(resultsByPath.get("/invalid-og-url").ogUrl, "");
  assert.deepEqual(
    resultsByPath.get("/invalid-og-url").openGraphInvalidUrls,
    [{ property: "og:url", value: "not a URL" }],
  );
  assert.equal(findingsByPath.get("/invalid-og-url").length, 1);
  assert.equal(
    findingsByPath.get("/invalid-og-url")[0].ruleId,
    "open-graph-url-invalid",
  );
  assert.equal(
    findingsByPath.get("/invalid-og-url")[0].detail,
    "og:url is not an absolute HTTP(S) URL",
  );
  assert.equal(
    findingsByPath.get("/invalid-og-url")[0].detectedValue,
    "not a URL",
  );

  assert.deepEqual(
    resultsByPath.get("/relative-image").openGraphInvalidUrls,
    [{ property: "og:image", value: "/preview.jpg" }],
  );
  assert.equal(
    findingsByPath.get("/relative-image")[0].detectedValue,
    "/preview.jpg",
  );

  assert.deepEqual(
    resultsByPath.get("/non-http-image-alias").openGraphInvalidUrls,
    [{ property: "og:image:url", value: "data:image/png;base64,abc" }],
  );
  assert.equal(
    findingsByPath.get("/non-http-image-alias")[0].detail,
    "og:image:url is not an absolute HTTP(S) URL",
  );

  assert.deepEqual(
    resultsByPath.get("/invalid-both-no-description").openGraphInvalidUrls,
    [
      { property: "og:url", value: "ftp://example.com/page" },
      { property: "og:image", value: "//cdn.example.com/preview.jpg" },
    ],
  );
  assert.deepEqual(
    findingsByPath
      .get("/invalid-both-no-description")
      .map((finding) => finding.ruleId),
    ["open-graph-url-invalid", "open-graph-url-invalid"],
  );

  assert.deepEqual(
    resultsByPath.get("/valid-absolute-urls").openGraphInvalidUrls,
    [],
  );
  assert.deepEqual(findingsByPath.get("/valid-absolute-urls"), []);
});

test("compares normalized Open Graph and canonical URLs while preserving raw mismatch evidence", async (t) => {
  const server = http.createServer((request, response) => {
    const localUrl = `http://${request.headers.host}${request.url}`;
    const variants = {
      "/equivalent-local": {
        canonical: "/equivalent-local",
        ogUrl: `HTTP://${request.headers.host}/equivalent-local#social-card`,
      },
      "/equivalent-syntax": {
        canonical: "https://example.com/Page?campaign=seo",
        ogUrl:
          "HTTPS://EXAMPLE.COM:443/Page?campaign=seo#social-card",
      },
      "/mismatch": {
        canonical: "https://example.com/preferred",
        ogUrl:
          "HTTPS://SOCIAL.EXAMPLE.COM:443/shared?campaign=paid#social-card",
      },
    };
    const variant = variants[request.url] || {
      canonical: localUrl,
      ogUrl: localUrl,
    };
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head>
      <title>Open Graph canonical comparison fixture</title>
      <meta name="description" content="A sufficiently long description for the Open Graph canonical comparison fixture.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="canonical" href="${variant.canonical}">
      <meta property="og:title" content="Open Graph canonical comparison">
      <meta property="og:type" content="website">
      <meta property="og:url" content="${variant.ogUrl}">
      <meta property="og:image" content="https://cdn.example.com/preview.jpg">
      <meta property="og:image:alt" content="A team reviewing a growth dashboard.">
      <meta property="og:description" content="A specific sharing description.">
    </head><body>
      <h1>Open Graph canonical comparison fixture</h1>
      <p>${"Useful fixture content. ".repeat(220)}</p>
    </body></html>`);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const paths = [
    "/equivalent-local",
    "/equivalent-syntax",
    "/mismatch",
  ];
  const crawler = new SeoCrawler({
    maxUrls: paths.length,
    concurrency: 2,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });

  const summary = await crawler.start(
    paths.map((path) => `http://127.0.0.1:${port}${path}`),
  );
  const resultsByPath = new Map(
    summary.results.map((result) => [new URL(result.url).pathname, result]),
  );
  const findingsByPath = new Map(
    paths.map((path) => [
      path,
      summary.findings.filter(
        (finding) =>
          new URL(finding.url).pathname === path &&
          finding.ruleId === "open-graph-canonical",
      ),
    ]),
  );

  assert.equal(
    resultsByPath.get("/equivalent-local").ogUrlRaw,
    `HTTP://127.0.0.1:${port}/equivalent-local#social-card`,
  );
  assert.equal(
    resultsByPath.get("/equivalent-local").ogUrl,
    `http://127.0.0.1:${port}/equivalent-local`,
  );
  assert.equal(
    resultsByPath.get("/equivalent-local").canonical,
    `http://127.0.0.1:${port}/equivalent-local`,
  );
  assert.deepEqual(findingsByPath.get("/equivalent-local"), []);

  assert.equal(
    resultsByPath.get("/equivalent-syntax").ogUrlRaw,
    "HTTPS://EXAMPLE.COM:443/Page?campaign=seo#social-card",
  );
  assert.equal(
    resultsByPath.get("/equivalent-syntax").ogUrl,
    "https://example.com/Page?campaign=seo",
  );
  assert.deepEqual(findingsByPath.get("/equivalent-syntax"), []);

  const mismatch = findingsByPath.get("/mismatch");
  assert.equal(mismatch.length, 1);
  assert.equal(
    mismatch[0].detectedValue,
    "HTTPS://SOCIAL.EXAMPLE.COM:443/shared?campaign=paid#social-card",
  );
  assert.equal(mismatch[0].targetUrl, "https://example.com/preferred");
  assert.equal(
    mismatch[0].detail,
    "og:url: HTTPS://SOCIAL.EXAMPLE.COM:443/shared?campaign=paid#social-card; canonical: https://example.com/preferred",
  );
});

test("requires image alt text only for the effective valid Open Graph image", async (t) => {
  const server = http.createServer((request, response) => {
    const pageUrl = `http://${request.headers.host}${request.url}`;
    const common = `
      <meta property="og:title" content="Open Graph image alt fixture">
      <meta property="og:type" content="website">
      <meta property="og:url" content="${pageUrl}">
      <meta property="og:description" content="A specific sharing description.">`;
    const variants = {
      "/root-missing-alt": `
        <meta property="og:image" content="https://cdn.example.com/first.jpg">`,
      "/alias-empty-alt": `
        <meta property="og:image:url" content="https://cdn.example.com/alias.jpg">
        <meta property="og:image:alt" content="   ">`,
      "/root-with-alt": `
        <meta property="og:image" content="https://cdn.example.com/described.jpg">
        <meta property="og:image:alt" content="A strategist reviewing a campaign dashboard.">`,
      "/alias-with-alt": `
        <meta property="og:image:url" content="https://cdn.example.com/alias-described.jpg">
        <meta property="og:image:alt" content="A product team discussing a launch plan.">`,
      "/missing-image-with-stray-alt": `
        <meta property="og:image:alt" content="This tag has no image root.">`,
      "/invalid-image": `
        <meta property="og:image" content="/relative-preview.jpg">`,
      "/second-image-alt-only": `
        <meta property="og:image" content="https://cdn.example.com/first-undescribed.jpg">
        <meta property="og:image" content="https://cdn.example.com/second.jpg">
        <meta property="og:image:alt" content="This description belongs to the second image.">`,
      "/paired-alias-with-alt": `
        <meta property="og:image" content="HTTPS://CDN.EXAMPLE.COM:443/paired.jpg#card">
        <meta property="og:image:url" content="https://cdn.example.com/paired.jpg">
        <meta property="og:image:alt" content="A customer journey diagram with five stages.">`,
    };
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head>
      <title>Open Graph image alt fixture</title>
      <meta name="description" content="A sufficiently long description for the Open Graph image alt fixture page.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      ${common}
      ${variants[request.url] ?? ""}
    </head><body>
      <h1>Open Graph image alt fixture</h1>
      <p>${"Useful fixture content. ".repeat(220)}</p>
    </body></html>`);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const paths = [
    "/root-missing-alt",
    "/alias-empty-alt",
    "/root-with-alt",
    "/alias-with-alt",
    "/missing-image-with-stray-alt",
    "/invalid-image",
    "/second-image-alt-only",
    "/paired-alias-with-alt",
  ];
  const crawler = new SeoCrawler({
    maxUrls: paths.length,
    concurrency: 2,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });

  const summary = await crawler.start(
    paths.map((path) => `http://127.0.0.1:${port}${path}`),
  );
  const resultsByPath = new Map(
    summary.results.map((result) => [new URL(result.url).pathname, result]),
  );
  const findingsByPath = new Map(
    paths.map((path) => [
      path,
      summary.findings.filter(
        (finding) =>
          new URL(finding.url).pathname === path &&
          finding.ruleId.startsWith("open-graph-"),
      ),
    ]),
  );

  const rootMissing = findingsByPath.get("/root-missing-alt");
  assert.equal(rootMissing.length, 1);
  assert.equal(rootMissing[0].ruleId, "open-graph-image-alt-missing");
  assert.equal(rootMissing[0].targetUrl, "https://cdn.example.com/first.jpg");
  assert.equal(
    rootMissing[0].detail,
    "og:image:alt is missing or empty for og:image",
  );
  assert.equal(
    rootMissing[0].detectedValue,
    "og:image: https://cdn.example.com/first.jpg",
  );

  const aliasMissing = findingsByPath.get("/alias-empty-alt");
  assert.equal(aliasMissing.length, 1);
  assert.equal(aliasMissing[0].ruleId, "open-graph-image-alt-missing");
  assert.equal(
    aliasMissing[0].detectedValue,
    "og:image:url: https://cdn.example.com/alias.jpg",
  );

  assert.deepEqual(findingsByPath.get("/root-with-alt"), []);
  assert.deepEqual(findingsByPath.get("/alias-with-alt"), []);

  assert.deepEqual(
    findingsByPath
      .get("/missing-image-with-stray-alt")
      .map((finding) => finding.ruleId),
    ["open-graph-incomplete"],
  );
  assert.equal(
    resultsByPath.get("/missing-image-with-stray-alt")
      .openGraphImageAltMissing,
    false,
  );

  assert.deepEqual(
    findingsByPath.get("/invalid-image").map((finding) => finding.ruleId),
    ["open-graph-url-invalid"],
  );
  assert.equal(
    resultsByPath.get("/invalid-image").openGraphImageAltMissing,
    false,
  );

  const firstImageMissing = findingsByPath.get("/second-image-alt-only");
  assert.equal(firstImageMissing.length, 1);
  assert.equal(
    firstImageMissing[0].targetUrl,
    "https://cdn.example.com/first-undescribed.jpg",
  );

  assert.equal(
    resultsByPath.get("/paired-alias-with-alt").openGraphImageProperty,
    "og:image",
  );
  assert.equal(
    resultsByPath.get("/paired-alias-with-alt").openGraphImageAlt,
    "A customer journey diagram with five stages.",
  );
  assert.deepEqual(findingsByPath.get("/paired-alias-with-alt"), []);
});

test("finds missing HTML image alt text across responsive and lazy source patterns with element evidence", async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head>
      <title>HTML image alt extraction fixture</title>
      <meta name="description" content="A sufficiently long description for the HTML image alt extraction fixture page.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head><body>
      <h1>HTML image alt extraction fixture</h1>
      <p>${"Useful fixture content. ".repeat(220)}</p>

      <img id="plain" src="/plain.jpg">
      <img class="responsive hero" srcset="/responsive-small.jpg 480w, /responsive-large.jpg 960w">
      <img id="lazy" src="data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==" data-src="/lazy.jpg">
      <img id="lazyset" data-srcset="/lazy-small.webp 1x, /lazy-large.webp 2x">
      <picture>
        <source srcset="/picture-wide.avif 1x, /picture-wide@2x.avif 2x">
        <img id="picture-only">
      </picture>
      <img id="native-lazy" loading="lazy" src="/native-lazy.jpg">
      <img id="whitespace" src="/whitespace.jpg" alt="   ">
      <img id="embedded" src="data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==">

      <img id="decorative" src="/decorative.jpg" alt="">
      <img id="informative" src="/informative.jpg" alt="A campaign dashboard showing steady growth.">
      <img id="presentational" src="/presentational.jpg" role="presentation">
      <img id="role-none" src="/role-none.jpg" role="none">
      <div aria-hidden="true"><img id="aria-hidden" src="/aria-hidden.jpg"></div>
      <div hidden><img id="hidden" src="/hidden.jpg"></div>
      <source src="/standalone-source.jpg">
    </body></html>`);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const crawler = new SeoCrawler({
    maxUrls: 1,
    concurrency: 1,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });

  const summary = await crawler.start([`http://127.0.0.1:${port}/`]);
  const findings = summary.findings.filter(
    (finding) => finding.ruleId === "image-alt-missing",
  );
  const byTargetPath = new Map(
    findings
      .filter((finding) => finding.targetUrl)
      .map((finding) => [new URL(finding.targetUrl).pathname, finding]),
  );

  assert.equal(findings.length, 8);
  assert.equal(
    byTargetPath.get("/plain.jpg").detail,
    'alt attribute is missing: img#plain via src="/plain.jpg"',
  );
  assert.equal(
    byTargetPath.get("/plain.jpg").detectedValue,
    'img#plain via src="/plain.jpg"',
  );
  assert.equal(
    byTargetPath.get("/responsive-small.jpg").detectedValue,
    'img.responsive.hero via srcset="/responsive-small.jpg"',
  );
  assert.equal(
    byTargetPath.get("/lazy.jpg").detectedValue,
    'img#lazy via data-src="/lazy.jpg"',
  );
  assert.equal(
    byTargetPath.get("/lazy-small.webp").detectedValue,
    'img#lazyset via data-srcset="/lazy-small.webp"',
  );
  assert.equal(
    byTargetPath.get("/picture-wide.avif").detectedValue,
    'img#picture-only via picture source[srcset]="/picture-wide.avif"',
  );
  assert.ok(byTargetPath.has("/native-lazy.jpg"));
  assert.equal(
    byTargetPath.get("/whitespace.jpg").detail,
    'alt attribute contains only whitespace: img#whitespace via src="/whitespace.jpg"',
  );
  assert.equal(
    findings.filter((finding) =>
      finding.detectedValue.startsWith("img.responsive.hero "),
    ).length,
    1,
    "multiple srcset candidates must not duplicate the image alt finding",
  );
  assert.ok(
    findings.some(
      (finding) =>
        !finding.targetUrl &&
        finding.detectedValue.startsWith('img#embedded via src="data:image/gif'),
    ),
  );

  for (const cleanPath of [
    "/decorative.jpg",
    "/informative.jpg",
    "/presentational.jpg",
    "/role-none.jpg",
    "/aria-hidden.jpg",
    "/hidden.jpg",
    "/standalone-source.jpg",
  ]) {
    assert.ok(!byTargetPath.has(cleanPath), `${cleanPath} should not be flagged`);
  }

  const responsiveEdges = crawler.resourceEdges.filter((edge) => {
    if (!edge.targetUrl) return false;
    return [
      "/responsive-small.jpg",
      "/responsive-large.jpg",
      "/picture-wide.avif",
      "/picture-wide@2x.avif",
    ].includes(new URL(edge.targetUrl).pathname);
  });
  assert.deepEqual(
    responsiveEdges
      .map((edge) => new URL(edge.targetUrl).pathname)
      .sort(),
    [
      "/picture-wide.avif",
      "/picture-wide@2x.avif",
      "/responsive-large.jpg",
      "/responsive-small.jpg",
    ],
  );
  assert.equal(
    responsiveEdges.find(
      (edge) => new URL(edge.targetUrl).pathname === "/responsive-small.jpg",
    ).auditAlt,
    true,
  );
  assert.equal(
    responsiveEdges.find(
      (edge) => new URL(edge.targetUrl).pathname === "/responsive-large.jpg",
    ).auditAlt,
    false,
  );
});

test("reports mixed content only for embedded resources with element evidence", async () => {
  const pageUrl = "https://secure.test/page";
  const html = `<!doctype html><html><head>
    <title>Mixed content boundary fixture</title>
    <meta name="description" content="A sufficiently long description for the mixed content boundary fixture page.">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="canonical" href="${pageUrl}">
    <link rel="alternate" href="http://documents.test/feed.xml" type="application/rss+xml">
    <link rel="preconnect" href="http://connection.test">
    <link id="theme" rel="stylesheet" href="http://assets.test/theme.css">
    <script id="application" src="http://assets.test/application.js"></script>
  </head><body>
    <h1>Mixed content boundary fixture</h1>
    <p>${"Useful fixture content. ".repeat(220)}</p>

    <a href="http://destination.test/page">Open the HTTP page</a>
    <a href="http://downloads.test/guide.pdf" download>Download the guide</a>
    <img id="hero" src="http://images.test/hero.jpg" alt="Campaign dashboard">
    <img id="responsive" src="https://images.test/responsive-fallback.jpg"
      srcset="https://images.test/responsive-small.jpg 1x, http://images.test/responsive-large.jpg 2x"
      alt="Responsive campaign dashboard">
    <picture>
      <source src="http://images.test/ignored-picture-source.jpg">
      <source media="(min-width: 60rem)" type="image/avif"
        srcset="https://images.test/picture-wide.avif 1x, http://images.test/picture-wide@2x.avif 2x">
      <img id="art-directed" src="https://images.test/picture-fallback.jpg"
        alt="Art-directed campaign dashboard">
    </picture>
    <iframe class="demo-frame" src="http://frames.test/demo"></iframe>
    <video id="overview" src="https://media.test/overview.mp4"
      poster="http://media.test/poster.jpg"></video>
    <object id="brochure" data="http://documents.test/brochure.pdf"></object>
    <input id="submit-image" type="image" src="http://images.test/submit.png"
      alt="Submit">
  </body></html>`;
  const crawler = new SeoCrawler({
    maxUrls: 1,
    concurrency: 1,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
    fetch: async () =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  });

  const summary = await crawler.start([pageUrl]);
  const mixedFindings = summary.findings.filter(
    (finding) => finding.ruleId === "mixed-content",
  );
  const mixedByTarget = new Map(
    mixedFindings.map((finding) => [finding.targetUrl, finding]),
  );

  assert.equal(mixedFindings.length, 9);
  assert.equal(
    mixedByTarget.get("http://assets.test/theme.css").detectedValue,
    'link#theme[rel="stylesheet"] via href="http://assets.test/theme.css"',
  );
  assert.equal(
    mixedByTarget.get("http://assets.test/application.js").detectedValue,
    'script#application via src="http://assets.test/application.js"',
  );
  assert.equal(
    mixedByTarget.get("http://images.test/hero.jpg").detectedValue,
    'img#hero via src="http://images.test/hero.jpg"',
  );
  assert.equal(
    mixedByTarget.get("http://images.test/responsive-large.jpg").detectedValue,
    'img#responsive via srcset="http://images.test/responsive-large.jpg"',
  );
  assert.equal(
    mixedByTarget.get("http://images.test/picture-wide@2x.avif").detectedValue,
    'source[media="(min-width: 60rem)"][type="image/avif"] via srcset="http://images.test/picture-wide@2x.avif"',
  );
  assert.equal(
    mixedByTarget.get("http://frames.test/demo").detectedValue,
    'iframe.demo-frame via src="http://frames.test/demo"',
  );
  assert.equal(
    mixedByTarget.get("http://media.test/poster.jpg").detectedValue,
    'video#overview via poster="http://media.test/poster.jpg"',
  );
  assert.equal(
    mixedByTarget.get("http://documents.test/brochure.pdf").detectedValue,
    'object#brochure via data="http://documents.test/brochure.pdf"',
  );
  assert.equal(
    mixedByTarget.get("http://images.test/submit.png").detail,
    'Insecure resource reference: input#submit-image via src="http://images.test/submit.png"',
  );

  for (const navigationOrHint of [
    "http://documents.test/feed.xml",
    "http://connection.test/",
    "http://destination.test/page",
    "http://downloads.test/guide.pdf",
    "http://images.test/ignored-picture-source.jpg",
  ]) {
    assert.ok(
      !mixedByTarget.has(navigationOrHint),
      `${navigationOrHint} should not be mixed content`,
    );
    assert.ok(
      !crawler.resourceEdges.some((edge) => edge.targetUrl === navigationOrHint),
      `${navigationOrHint} should not be an embedded resource edge`,
    );
  }

  const httpLinkFindings = summary.findings.filter(
    (finding) => finding.ruleId === "https-to-http-link",
  );
  assert.equal(httpLinkFindings.length, 2);
  assert.equal(
    httpLinkFindings.find(
      (finding) => finding.targetUrl === "http://downloads.test/guide.pdf",
    ).detectedValue,
    "download; HTTP target not fetched",
  );
});

test("resolves document URLs against the first base href with browser fallback semantics", async () => {
  const pageUrl = "https://secure.test/base-fixture";
  const invalidBaseUrl = "https://secure.test/invalid-base";
  const dataBaseUrl = "https://secure.test/data-base";
  const pages = new Map([
    [
      pageUrl,
      `<!doctype html><html><head>
        <title>Document base fixture</title>
        <meta name="description" content="A sufficiently long description for the document base URL fixture page.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <base target="_blank">
        <base href="http://assets.test/root/">
        <base href="https://ignored.test/later/">
        <link rel="canonical" href="canonical">
        <link rel="alternate" hreflang="fr" href="fr">
        <link rel="next" href="next">
        <link id="theme" rel="stylesheet" href="theme.css">
        <style id="critical">
          .banner { background-image: url(css-background.png); }
        </style>
      </head><body>
        <h1>Document base fixture</h1>
        <p>${"Useful fixture content. ".repeat(220)}</p>
        <a href="landing">Base-relative destination</a>
        <img id="hero" src="hero.jpg"
          srcset="hero-small.jpg 1x, hero-large.jpg 2x"
          alt="Campaign dashboard">
        <script id="application" src="app.js"></script>
        <script id="absolute-application" src="http://direct.test/app.js"></script>
        <div id="card" style="background-image: url(card.png)">Card</div>
      </body></html>`,
    ],
    [
      invalidBaseUrl,
      `<!doctype html><html><head>
        <title>Invalid document base fixture</title>
        <meta name="description" content="A sufficiently long description for the invalid document base fixture page.">
        <base href="http://[invalid">
        <base href="http://ignored.test/later/">
      </head><body>
        <h1>Invalid document base fixture</h1>
        <p>${"Useful fixture content. ".repeat(220)}</p>
        <a href="relative">Fallback-relative destination</a>
      </body></html>`,
    ],
    [
      dataBaseUrl,
      `<!doctype html><html><head>
        <title>Data document base fixture</title>
        <meta name="description" content="A sufficiently long description for the data document base fixture page.">
        <base href="data:text/plain,ignored">
        <base href="http://ignored.test/later/">
      </head><body>
        <h1>Data document base fixture</h1>
        <p>${"Useful fixture content. ".repeat(220)}</p>
        <img id="fallback-image" src="relative.png" alt="Fallback image">
      </body></html>`,
    ],
  ]);
  const crawler = new SeoCrawler({
    maxUrls: pages.size,
    concurrency: 2,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
    fetch: async (url) =>
      new Response(pages.get(url), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  });

  const summary = await crawler.start([...pages.keys()]);
  const resultByUrl = new Map(
    summary.results.map((result) => [result.url, result]),
  );
  const baseResult = resultByUrl.get(pageUrl);

  assert.equal(baseResult.baseHrefRaw, "http://assets.test/root/");
  assert.equal(baseResult.documentBaseUrl, "http://assets.test/root/");
  assert.equal(baseResult.documentBaseFallbackReason, "");
  assert.equal(baseResult.canonical, "http://assets.test/root/canonical");
  assert.deepEqual(baseResult.hreflangs, [
    { lang: "fr", url: "http://assets.test/root/fr" },
  ]);
  assert.equal(baseResult.paginationNext, "http://assets.test/root/next");
  assert.equal(
    crawler.linkEdges.find((edge) => edge.sourceUrl === pageUrl).targetUrl,
    "http://assets.test/root/landing",
  );

  const baseResourceTargets = new Set(
    crawler.resourceEdges
      .filter((edge) => edge.sourceUrl === pageUrl)
      .map((edge) => edge.targetUrl),
  );
  assert.deepEqual(
    baseResourceTargets,
    new Set([
      "http://assets.test/root/theme.css",
      "http://assets.test/root/hero.jpg",
      "http://assets.test/root/hero-small.jpg",
      "http://assets.test/root/hero-large.jpg",
      "http://assets.test/root/app.js",
      "http://direct.test/app.js",
      "http://assets.test/root/css-background.png",
      "http://assets.test/root/card.png",
    ]),
  );
  const mixedTargets = new Set(
    summary.findings
      .filter(
        (finding) =>
          finding.ruleId === "mixed-content" && finding.url === pageUrl,
      )
      .map((finding) => finding.targetUrl),
  );
  assert.deepEqual(mixedTargets, baseResourceTargets);
  const baseDerivedMixed = summary.findings.filter(
    (finding) =>
      finding.ruleId === "mixed-content" &&
      finding.url === pageUrl &&
      finding.targetUrl.startsWith("http://assets.test/root/"),
  );
  assert.ok(
    baseDerivedMixed.every(
      (finding) =>
        finding.detail.includes(
          'relative reference resolves through <base href="http://assets.test/root/">',
        ) &&
        finding.detectedValue.includes(
          '<base href="http://assets.test/root/"> -> http://assets.test/root/',
        ),
    ),
  );
  assert.ok(
    !summary.findings
      .find(
        (finding) =>
          finding.ruleId === "mixed-content" &&
          finding.targetUrl === "http://direct.test/app.js",
      )
      .detail.includes("<base href"),
    "an absolute HTTP resource should not blame the document base",
  );
  assert.ok(
    summary.findings.some(
      (finding) =>
        finding.ruleId === "https-to-http-link" &&
        finding.targetUrl === "http://assets.test/root/landing" &&
        finding.detail.includes(
          'relative reference resolves through <base href="http://assets.test/root/">',
        ) &&
        finding.detectedValue.includes(
          '<base href="http://assets.test/root/"> -> http://assets.test/root/',
        ),
    ),
  );

  assert.equal(
    resultByUrl.get(invalidBaseUrl).documentBaseUrl,
    invalidBaseUrl,
  );
  assert.equal(
    resultByUrl.get(invalidBaseUrl).documentBaseFallbackReason,
    "base href is not a valid URL",
  );
  assert.ok(
    summary.findings.some(
      (finding) =>
        finding.ruleId === "base-url-ignored" &&
        finding.url === invalidBaseUrl &&
        finding.detail === "base href is not a valid URL",
    ),
  );
  assert.ok(
    crawler.linkEdges.some(
      (edge) =>
        edge.sourceUrl === invalidBaseUrl &&
        edge.targetUrl === "https://secure.test/relative",
    ),
    "an invalid first base must fall back to the page and ignore later bases",
  );

  assert.equal(resultByUrl.get(dataBaseUrl).documentBaseUrl, dataBaseUrl);
  assert.equal(
    resultByUrl.get(dataBaseUrl).documentBaseFallbackReason,
    "data base URLs are ignored",
  );
  assert.ok(
    summary.findings.some(
      (finding) =>
        finding.ruleId === "base-url-ignored" &&
        finding.url === dataBaseUrl &&
        finding.detail === "data base URLs are ignored",
    ),
  );
  assert.ok(
    crawler.resourceEdges.some(
      (edge) =>
        edge.sourceUrl === dataBaseUrl &&
        edge.targetUrl === "https://secure.test/relative.png",
    ),
  );
  assert.ok(
    ![...crawler.linkEdges, ...crawler.resourceEdges].some((edge) =>
      edge.targetUrl?.startsWith("http://ignored.test/"),
    ),
    "later base href elements must be ignored",
  );
});

test("applies enforcing CSP base-uri policies before resolving document URLs", async () => {
  const headerBlockedUrl = "https://secure.test/csp-header-blocked";
  const headerAllowedUrl = "https://secure.test/csp-header-allowed";
  const defaultOnlyUrl = "https://secure.test/csp-default-only";
  const metaBlockedUrl = "https://secure.test/csp-meta-blocked";
  const metaAfterUrl = "https://secure.test/csp-meta-after";
  const intersectedUrl = "https://secure.test/csp-intersection";
  const fixture = (headBeforeBase = "", headAfterBase = "") => `<!doctype html>
    <html><head>
      <title>CSP document base fixture</title>
      <meta name="description" content="A sufficiently long description for a CSP document base URL fixture page.">
      ${headBeforeBase}
      <base href="https://cdn.test/assets/">
      ${headAfterBase}
    </head><body>
      <h1>CSP document base fixture</h1>
      <p>${"Useful fixture content. ".repeat(220)}</p>
      <a href="relative">Relative destination</a>
      <img src="hero.png" alt="Campaign dashboard">
    </body></html>`;
  const pages = new Map([
    [
      headerBlockedUrl,
      {
        html: fixture(),
        csp: "default-src *; base-uri 'self'",
      },
    ],
    [
      headerAllowedUrl,
      {
        html: fixture(),
        csp: "default-src 'none'; base-uri https://cdn.test/assets/",
        reportOnly: "base-uri 'none'",
      },
    ],
    [
      defaultOnlyUrl,
      {
        html: fixture(),
        csp: "default-src 'none'",
        reportOnly: "base-uri 'none'",
      },
    ],
    [
      metaBlockedUrl,
      {
        html: fixture(
          '<meta http-equiv="Content-Security-Policy" content="base-uri \'self\'">',
        ),
      },
    ],
    [
      metaAfterUrl,
      {
        html: fixture(
          "",
          '<meta http-equiv="Content-Security-Policy" content="base-uri \'self\'">',
        ),
      },
    ],
    [
      intersectedUrl,
      {
        html: fixture(),
        csp: "base-uri https:, base-uri 'self'",
      },
    ],
  ]);
  const crawler = new SeoCrawler({
    maxUrls: pages.size,
    concurrency: 2,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
    fetch: async (url) => {
      const page = pages.get(url);
      return new Response(page.html, {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          ...(page.csp ? { "Content-Security-Policy": page.csp } : {}),
          ...(page.reportOnly
            ? { "Content-Security-Policy-Report-Only": page.reportOnly }
            : {}),
        },
      });
    },
  });

  const summary = await crawler.start([...pages.keys()]);
  const resultByUrl = new Map(
    summary.results.map((result) => [result.url, result]),
  );

  const headerBlocked = resultByUrl.get(headerBlockedUrl);
  assert.equal(headerBlocked.documentBaseUrl, headerBlockedUrl);
  assert.equal(
    headerBlocked.documentBaseFallbackReason,
    "Blocked by Content-Security-Policy header policy 1: base-uri 'self'",
  );
  assert.deepEqual(headerBlocked.documentBasePolicyEvidence, [
    "header policy 1: base-uri 'self'",
  ]);
  assert.ok(
    crawler.linkEdges.some(
      (edge) =>
        edge.sourceUrl === headerBlockedUrl &&
        edge.targetUrl === "https://secure.test/relative",
    ),
    "a blocked base must resolve relative URLs against the page",
  );

  for (const url of [headerAllowedUrl, defaultOnlyUrl, metaAfterUrl]) {
    assert.equal(resultByUrl.get(url).documentBaseUrl, "https://cdn.test/assets/");
    assert.equal(resultByUrl.get(url).documentBaseFallbackReason, "");
    assert.ok(
      crawler.linkEdges.some(
        (edge) =>
          edge.sourceUrl === url &&
          edge.targetUrl === "https://cdn.test/assets/relative",
      ),
    );
  }
  assert.deepEqual(
    resultByUrl.get(headerAllowedUrl).documentBasePolicyEvidence,
    ["header policy 1: base-uri https://cdn.test/assets/"],
    "an enforcing allowlist applies while report-only does not block",
  );
  assert.deepEqual(
    resultByUrl.get(defaultOnlyUrl).documentBasePolicyEvidence,
    [],
    "default-src is not a fallback for base-uri",
  );
  assert.deepEqual(
    resultByUrl.get(metaAfterUrl).documentBasePolicyEvidence,
    [],
    "a meta policy parsed after the first base cannot retroactively block it",
  );

  const metaBlocked = resultByUrl.get(metaBlockedUrl);
  assert.equal(metaBlocked.documentBaseUrl, metaBlockedUrl);
  assert.equal(
    metaBlocked.documentBaseFallbackReason,
    "Blocked by Content-Security-Policy meta policy 1: base-uri 'self'",
  );

  const intersected = resultByUrl.get(intersectedUrl);
  assert.equal(intersected.documentBaseUrl, intersectedUrl);
  assert.equal(
    intersected.documentBaseFallbackReason,
    "Blocked by Content-Security-Policy header policy 2: base-uri 'self'",
  );

  const ignoredBaseFindings = summary.findings.filter(
    (finding) => finding.ruleId === "base-url-ignored",
  );
  assert.deepEqual(
    new Set(ignoredBaseFindings.map((finding) => finding.url)),
    new Set([headerBlockedUrl, metaBlockedUrl, intersectedUrl]),
  );
  assert.ok(
    ignoredBaseFindings.every(
      (finding) =>
        finding.severity === "warning" &&
        finding.detectedValue.includes(
          '<base href="https://cdn.test/assets/">',
        ) &&
        finding.detail.startsWith("Blocked by Content-Security-Policy"),
    ),
  );
});

test("excludes inert template contents while retaining declarative shadow content", async () => {
  const pageUrl = "https://secure.test/template-fixture";
  const html = `<!doctype html><html><head>
    <template id="inert-head">
      <title>Inert template title</title>
      <meta name="description" content="Inert template description">
      <meta name="viewport" content="fixed-width">
      <meta name="robots" content="noindex">
      <meta http-equiv="Content-Security-Policy" content="base-uri 'none'">
      <base href="http://inactive.test/root/">
      <link rel="canonical" href="inactive-canonical">
      <link rel="alternate" hreflang="zz-invalid" href="inactive-language">
      <link rel="next" href="inactive-next">
      <meta property="og:title" content="Inert Open Graph title">
      <meta property="og:type" content="website">
      <meta property="og:image" content="http://inactive.test/social.png">
      <meta property="og:url" content="http://inactive.test/page">
      <script type="application/ld+json">{not valid JSON</script>
    </template>
    <title>Live template fixture page</title>
    <meta name="description" content="A sufficiently long live description for the inert template extraction fixture page.">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <base href="https://secure.test/live-base/">
    <link rel="canonical" href="canonical">
    <link rel="alternate" hreflang="en" href="language">
    <link rel="next" href="next">
    <meta property="og:title" content="Live Open Graph title">
    <meta property="og:type" content="website">
    <meta property="og:image" content="https://secure.test/social.png">
    <meta property="og:image:alt" content="Live social preview">
    <meta property="og:url" content="https://secure.test/live-base/canonical">
    <meta property="og:description" content="Live social description">
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Organization","name":"Live organization"}
    </script>
  </head><body>
    <template id="inert-body">
      <h1>Inert primary heading</h1>
      <h4>Inert skipped heading</h4>
      <p>INERT_TEMPLATE_TEXT_MUST_NOT_ENTER_CONTENT</p>
      <a href="http://inactive.test/click-here">Click here</a>
      <img src="http://inactive.test/missing-alt.png">
      <script src="http://inactive.test/application.js"></script>
      <object data="http://inactive.test/widget.bin"></object>
      <style>.inert { background-image: url(http://inactive.test/style.png); }</style>
      <div style="background-image: url(http://inactive.test/attribute.png)">Inert card</div>
      <script type="application/ld+json">{also invalid JSON</script>
    </template>
    <template shadowrootmode=" open ">
      <a href="http://inactive.test/invalid-shadow-mode">Invalid shadow mode</a>
      <img src="http://inactive.test/invalid-shadow-image.png">
    </template>
    <campaign-card>
      <template shadowrootmode="open">
        <title>Shadow-scoped title must not replace the document title</title>
        <meta name="robots" content="noindex">
        <meta http-equiv="Content-Security-Policy" content="base-uri 'none'">
        <base href="http://inactive.test/shadow-base/">
        <link rel="canonical" href="shadow-canonical">
        <meta property="og:title" content="Shadow Open Graph title">
        <meta property="og:url" content="http://inactive.test/shadow-page">
        <script type="application/ld+json">{invalid shadow JSON</script>
        <p>Declarative shadow content remains analyzable.</p>
        <a href="shadow-destination">Shadow destination</a>
        <img src="shadow.png" alt="Shadow campaign dashboard">
        <style>.shadow { background-image: url(shadow-background.png); }</style>
      </template>
    </campaign-card>
    <main>
      <h1>Live primary heading</h1>
      <h2>Live secondary heading</h2>
      <p>${"Useful live fixture content. ".repeat(220)}</p>
      <a href="destination">Live destination</a>
      <img src="hero.png" alt="Live campaign dashboard">
    </main>
  </body></html>`;
  const crawler = new SeoCrawler({
    maxUrls: 1,
    concurrency: 1,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
    fetch: async () =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  });

  const summary = await crawler.start([pageUrl]);
  const result = summary.results[0];

  assert.equal(result.inertTemplateCount, 3);
  assert.equal(result.title, "Live template fixture page");
  assert.equal(result.titleCount, 1);
  assert.match(result.metaDescription, /^A sufficiently long live description/);
  assert.equal(result.viewport, "width=device-width, initial-scale=1");
  assert.equal(result.robots, "");
  assert.equal(result.indexability, "Indexable");
  assert.equal(result.baseHrefRaw, "https://secure.test/live-base/");
  assert.equal(result.documentBaseUrl, "https://secure.test/live-base/");
  assert.equal(result.canonical, "https://secure.test/live-base/canonical");
  assert.deepEqual(result.hreflangs, [
    { lang: "en", url: "https://secure.test/live-base/language" },
  ]);
  assert.equal(result.paginationNext, "https://secure.test/live-base/next");
  assert.equal(result.h1Count, 1);
  assert.equal(result.h1, "Live primary heading");
  assert.equal(result.h2Count, 1);
  assert.equal(result.headingHierarchyIssue, false);
  assert.doesNotMatch(
    result.contentSample,
    /INERT_TEMPLATE_TEXT_MUST_NOT_ENTER_CONTENT/,
  );
  assert.match(result.contentSample, /Declarative shadow content remains analyzable/);
  assert.deepEqual(result.schemaErrors, []);
  assert.deepEqual(result.openGraphMissing, []);
  assert.equal(result.ogUrl, "https://secure.test/live-base/canonical");

  assert.deepEqual(
    new Set(crawler.linkEdges.map((edge) => edge.targetUrl)),
    new Set([
      "https://secure.test/live-base/destination",
      "https://secure.test/live-base/shadow-destination",
    ]),
  );
  assert.deepEqual(
    new Set(crawler.resourceEdges.map((edge) => edge.targetUrl)),
    new Set([
      "https://secure.test/live-base/hero.png",
      "https://secure.test/live-base/shadow.png",
      "https://secure.test/live-base/shadow-background.png",
    ]),
  );
  assert.ok(
    ![...crawler.linkEdges, ...crawler.resourceEdges].some((edge) =>
      edge.targetUrl.startsWith("http://inactive.test/"),
    ),
  );
  assert.ok(
    !summary.findings.some(
      (finding) =>
        finding.targetUrl.startsWith("http://inactive.test/") ||
        finding.ruleId === "schema-error" ||
        finding.ruleId === "hreflang-invalid-code",
    ),
  );
});

test("parses the first effective meta refresh with template and recovery semantics", async () => {
  const redirectPageUrl = "https://secure.test/meta-refresh";
  const destinationUrl = "https://secure.test/destination";
  const reloadPageUrl = "https://secure.test/meta-reload";
  const invalidPageUrl = "https://secure.test/meta-invalid";
  const beforeBasePageUrl = "https://secure.test/meta-before-base";
  const healthyBody = (head = "") => `<!doctype html><html><head>
    <title>Meta refresh fixture page</title>
    <meta name="description" content="A sufficiently long description for the declarative refresh fixture page.">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${head}
  </head><body>
    <h1>Meta refresh fixture</h1>
    <p>${"Useful fixture content. ".repeat(220)}</p>
  </body></html>`;
  const pages = new Map([
    [
      redirectPageUrl,
      healthyBody(`
        <template>
          <meta http-equiv="refresh" content="0; url=http://inactive.test/template">
        </template>
        <template shadowrootmode="open">
          <meta http-equiv="refresh" content="0; url=http://inactive.test/shadow">
        </template>
        <meta http-equiv=" refresh " content="0; url=http://inactive.test/spaced-state">
        <meta http-equiv="refresh" content="soon; url=http://inactive.test/malformed">
        <base href="https://secure.test/base/">
        <meta http-equiv="Refresh" content="0.9, URL = '../destination#section' trailing">
        <meta http-equiv="refresh" content="0; url=http://inactive.test/later">
      `),
    ],
    [destinationUrl, healthyBody()],
    [
      reloadPageUrl,
      healthyBody('<meta http-equiv="REFRESH" content="15">'),
    ],
    [
      invalidPageUrl,
      healthyBody(`
        <meta http-equiv="refresh" content="0; url=javascript:location='/target'">
        <meta http-equiv="refresh" content="not a delay">
      `),
    ],
    [
      beforeBasePageUrl,
      healthyBody(`
        <meta http-equiv="refresh" content="2; url=relative-target">
        <base href="https://cdn.secure.test/base/">
      `),
    ],
  ]);
  const crawler = new SeoCrawler({
    maxUrls: pages.size,
    concurrency: 2,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
    fetch: async (url) =>
      new Response(pages.get(url), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  });

  const summary = await crawler.start([...pages.keys()]);
  const resultByUrl = new Map(
    summary.results.map((result) => [result.url, result]),
  );
  const redirectPage = resultByUrl.get(redirectPageUrl);
  assert.equal(
    redirectPage.metaRefreshRaw,
    "0.9, URL = '../destination#section' trailing",
  );
  assert.equal(redirectPage.metaRefreshDelay, 0);
  assert.equal(redirectPage.metaRefreshDelayRaw, "0.9");
  assert.equal(redirectPage.metaRefreshTargetRaw, "../destination#section");
  assert.equal(
    redirectPage.metaRefreshUrl,
    "https://secure.test/destination#section",
  );
  assert.equal(redirectPage.metaRefreshIsReload, false);

  const reloadPage = resultByUrl.get(reloadPageUrl);
  assert.equal(reloadPage.metaRefreshDelay, 15);
  assert.equal(reloadPage.metaRefreshUrl, reloadPageUrl);
  assert.equal(reloadPage.metaRefreshIsReload, true);

  const invalidPage = resultByUrl.get(invalidPageUrl);
  assert.equal(invalidPage.metaRefreshRaw, "");
  assert.equal(invalidPage.metaRefreshUrl, "");

  const beforeBasePage = resultByUrl.get(beforeBasePageUrl);
  assert.equal(
    beforeBasePage.metaRefreshUrl,
    "https://secure.test/relative-target",
    "a later base must not retroactively change a refresh parsed on insertion",
  );
  assert.equal(beforeBasePage.documentBaseUrl, "https://cdn.secure.test/base/");

  const refreshFindings = summary.findings.filter(
    (finding) => finding.ruleId === "meta-refresh",
  );
  assert.equal(refreshFindings.length, 3);
  const redirectFinding = refreshFindings.find(
    (finding) => finding.url === redirectPageUrl,
  );
  assert.equal(
    redirectFinding.targetUrl,
    "https://secure.test/destination#section",
  );
  assert.match(redirectFinding.detail, /after 0 seconds/);
  assert.match(redirectFinding.detail, /destination returned HTTP 200/);
  assert.match(
    redirectFinding.detectedValue,
    /content="0\.9, URL = '\.\.\/destination#section' trailing"/,
  );
  const reloadFinding = refreshFindings.find(
    (finding) => finding.url === reloadPageUrl,
  );
  assert.equal(reloadFinding.targetUrl, "");
  assert.match(reloadFinding.detail, /Reloads the current page after 15 seconds/);
  assert.ok(
    !refreshFindings.some((finding) =>
      finding.detectedValue.includes("inactive.test"),
    ),
    "template-contained, invalid-state, malformed, and later directives stay inert",
  );
});

test("spider mode follows an in-scope meta refresh destination", async () => {
  const startUrl = "https://secure.test/start";
  const targetUrl = "https://secure.test/target";
  const requested = [];
  const page = (head, heading) => `<!doctype html><html><head>
    <title>${heading}</title>
    <meta name="description" content="A sufficiently long description for the spider meta refresh fixture page.">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${head}
  </head><body>
    <h1>${heading}</h1>
    <p>${"Useful fixture content. ".repeat(220)}</p>
  </body></html>`;
  const crawler = new SeoCrawler({
    maxUrls: 2,
    concurrency: 1,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
    fetch: async (url) => {
      requested.push(url);
      if (url === "https://secure.test/llms.txt") {
        return new Response("", { status: 404 });
      }
      if (url === "http://secure.test/start") {
        return new Response("", {
          status: 301,
          headers: { Location: startUrl },
        });
      }
      if (url === startUrl) {
        return new Response(
          page('<meta http-equiv="refresh" content="0; url=/target">', "Start"),
          {
            status: 200,
            headers: { "Content-Type": "text/html" },
          },
        );
      }
      if (url === targetUrl) {
        return new Response(page("", "Target"), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("", { status: 404 });
    },
  });

  const summary = await crawler.start(startUrl);
  assert.deepEqual(
    new Set(summary.results.map((result) => result.url)),
    new Set([startUrl, targetUrl]),
  );
  assert.ok(requested.includes(targetUrl));
  const target = summary.results.find((result) => result.url === targetUrl);
  assert.equal(target.depth, 1);
  assert.equal(target.inlinks, 1);
  assert.ok(
    summary.findings.some(
      (finding) =>
        finding.ruleId === "meta-refresh" &&
        finding.url === startUrl &&
        finding.targetUrl === targetUrl,
    ),
  );
});

test("Refresh header wins before markup while an invalid header permits meta fallback", async () => {
  const headerPageUrl = "https://secure.test/header-refresh/page";
  const headerTargetUrl = "https://secure.test/header-target";
  const invalidHeaderUrl = "https://secure.test/invalid-header";
  const reloadHeaderUrl = "https://secure.test/header-reload";
  const page = (head = "") => `<!doctype html><html><head>
    <title>Refresh header fixture page</title>
    <meta name="description" content="A sufficiently long description for the Refresh response header fixture page.">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${head}
  </head><body>
    <h1>Refresh header fixture</h1>
    <p>${"Useful fixture content. ".repeat(220)}</p>
  </body></html>`;
  const responses = new Map([
    [
      headerPageUrl,
      {
        body: page(`
          <base href="https://cdn.test/base/">
          <meta http-equiv="refresh" content="0; url=/meta-must-not-win">
        `),
        refresh: "1.9; URL=../header-target#section",
      },
    ],
    [headerTargetUrl, { body: page(), refresh: "" }],
    [
      invalidHeaderUrl,
      {
        body: page(
          '<meta http-equiv="refresh" content="0; url=/meta-fallback">',
        ),
        refresh: "soon; url=/invalid-header-target",
      },
    ],
    [
      reloadHeaderUrl,
      {
        body: page(
          '<meta http-equiv="refresh" content="0; url=/meta-must-not-win">',
        ),
        refresh: "12",
      },
    ],
  ]);
  const requested = [];
  const crawler = new SeoCrawler({
    maxUrls: responses.size,
    concurrency: 2,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
    fetch: async (url) => {
      requested.push(url);
      const fixture = responses.get(url);
      return new Response(fixture.body, {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          ...(fixture.refresh ? { Refresh: fixture.refresh } : {}),
        },
      });
    },
  });

  const summary = await crawler.start([...responses.keys()]);
  assert.equal(requested.length, responses.size);
  assert.deepEqual(new Set(requested), new Set(responses.keys()));
  const resultByUrl = new Map(
    summary.results.map((result) => [result.url, result]),
  );

  const headerPage = resultByUrl.get(headerPageUrl);
  assert.equal(
    headerPage.refreshHeaderRaw,
    "1.9; URL=../header-target#section",
  );
  assert.equal(headerPage.refreshHeaderDelay, 1);
  assert.equal(headerPage.refreshHeaderDelayRaw, "1.9");
  assert.equal(headerPage.refreshHeaderTargetRaw, "../header-target#section");
  assert.equal(
    headerPage.refreshHeaderUrl,
    "https://secure.test/header-target#section",
    "the header is resolved before a later document base exists",
  );
  assert.equal(headerPage.refreshHeaderIsReload, false);
  assert.equal(headerPage.metaRefreshRaw, "");
  assert.equal(headerPage.documentBaseUrl, "https://cdn.test/base/");

  const invalidHeader = resultByUrl.get(invalidHeaderUrl);
  assert.equal(invalidHeader.refreshHeaderRaw, "");
  assert.equal(invalidHeader.metaRefreshRaw, "0; url=/meta-fallback");
  assert.equal(
    invalidHeader.metaRefreshUrl,
    "https://secure.test/meta-fallback",
  );

  const reloadHeader = resultByUrl.get(reloadHeaderUrl);
  assert.equal(reloadHeader.refreshHeaderDelay, 12);
  assert.equal(reloadHeader.refreshHeaderUrl, reloadHeaderUrl);
  assert.equal(reloadHeader.refreshHeaderIsReload, true);
  assert.equal(reloadHeader.metaRefreshRaw, "");

  const headerFindings = summary.findings.filter(
    (finding) => finding.ruleId === "http-refresh",
  );
  assert.equal(headerFindings.length, 2);
  const redirectFinding = headerFindings.find(
    (finding) => finding.url === headerPageUrl,
  );
  assert.equal(
    redirectFinding.targetUrl,
    "https://secure.test/header-target#section",
  );
  assert.match(redirectFinding.detail, /after 1 second/);
  assert.match(redirectFinding.detail, /destination returned HTTP 200/);
  assert.match(
    redirectFinding.detectedValue,
    /^Refresh: 1\.9; URL=\.\.\/header-target#section;/,
  );
  const reloadFinding = headerFindings.find(
    (finding) => finding.url === reloadHeaderUrl,
  );
  assert.match(reloadFinding.detail, /Reloads the current page after 12 seconds/);
  assert.ok(
    summary.findings.some(
      (finding) =>
        finding.ruleId === "meta-refresh" &&
        finding.url === invalidHeaderUrl &&
        finding.targetUrl === "https://secure.test/meta-fallback",
    ),
  );
  assert.ok(
    !summary.findings.some((finding) =>
      finding.detectedValue.includes("meta-must-not-win"),
    ),
    "a successfully parsed response header prevents later meta directives",
  );
});

test("spider mode follows an in-scope Refresh header destination", async () => {
  const startUrl = "https://secure.test/header-start";
  const targetUrl = "https://secure.test/header-target";
  const requested = [];
  const page = (head, heading) => `<!doctype html><html><head>
    <title>${heading}</title>
    <meta name="description" content="A sufficiently long description for the spider Refresh header fixture page.">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${head}
  </head><body>
    <h1>${heading}</h1>
    <p>${"Useful fixture content. ".repeat(220)}</p>
  </body></html>`;
  const crawler = new SeoCrawler({
    maxUrls: 2,
    concurrency: 1,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
    fetch: async (url) => {
      requested.push(url);
      if (url === "https://secure.test/llms.txt") {
        return new Response("", { status: 404 });
      }
      if (url === "http://secure.test/header-start") {
        return new Response("", {
          status: 301,
          headers: { Location: startUrl },
        });
      }
      if (url === startUrl) {
        return new Response(
          page(
            '<meta http-equiv="refresh" content="0; url=/meta-must-not-win">',
            "Header start",
          ),
          {
            status: 200,
            headers: {
              "Content-Type": "text/html",
              Refresh: "0; URL=/header-target",
            },
          },
        );
      }
      if (url === targetUrl) {
        return new Response(page("", "Header target"), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("", { status: 404 });
    },
  });

  const summary = await crawler.start(startUrl);
  assert.deepEqual(
    new Set(summary.results.map((result) => result.url)),
    new Set([startUrl, targetUrl]),
  );
  assert.ok(requested.includes(targetUrl));
  const target = summary.results.find((result) => result.url === targetUrl);
  assert.equal(target.depth, 1);
  assert.equal(target.inlinks, 1);
  assert.ok(
    summary.findings.some(
      (finding) =>
        finding.ruleId === "http-refresh" &&
        finding.url === startUrl &&
        finding.targetUrl === targetUrl,
    ),
  );
});

test("finds CSS mixed content without matching comments, strings, or inert URL syntax", async () => {
  const pageUrl = "https://secure.test/page";
  const cssUrl = "https://secure.test/assets/theme.css";
  const html = `<!doctype html><html><head>
    <title>CSS mixed content fixture</title>
    <meta name="description" content="A sufficiently long description for the CSS mixed content fixture page.">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="canonical" href="${pageUrl}">
    <link rel="stylesheet" href="${cssUrl}">
    <style id="critical">
      @import "http://assets.test/inline-import.css";
      .hero { background-image: url("http://assets.test/inline-background.png"); }
      .icon { mask-image: URL( http://assets.test/icon.svg ); }
      .copy::before { content: "url(http://ignored.test/string.png)"; }
      /* url(http://ignored.test/comment.png) */
      @supports (background: url(http://ignored.test/supports.png)) {}
      @namespace svg url(http://www.w3.org/2000/svg);
      :root { --unused-image: url(http://ignored.test/custom-property.png); }
      .local-filter { filter: url(#shadow); }
      .embedded { background: url(data:image/png;base64,abc); }
    </style>
    <style type="text/less">
      .less-only { background: url(http://ignored.test/less.png); }
    </style>
  </head><body>
    <h1>CSS mixed content fixture</h1>
    <p>${"Useful fixture content. ".repeat(220)}</p>
    <div id="card" class="promo" style="background-image: url('http://assets.test/card.png'); content: 'url(http://ignored.test/attribute-string.png)'; @import 'http://ignored.test/attribute-import.css'">
      Campaign card
    </div>
  </body></html>`;
  const css = `/* url(http://ignored.test/css-comment.png) */
@import url("http://assets.test/nested.css") layer;
@font-face {
  font-family: AuditFixture;
  src: url(http://assets.test/font.woff2) format("woff2"),
       src("http://assets.test/modern-font.woff2");
}
.logo { background: url("../images/logo.png"); }
.note::after { content: "url(http://ignored.test/css-string.png)"; }
@supports (background: url(http://ignored.test/css-supports.png)) {}
@media screen { @import "http://ignored.test/nested-import.css"; }
@namespace svg url(http://www.w3.org/2000/svg);
:root { --unused-image: url(http://ignored.test/css-custom-property.png); }`;
  const crawler = new SeoCrawler({
    maxUrls: 2,
    concurrency: 2,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
    fetch: async (url) =>
      new Response(url === cssUrl ? css : html, {
        status: 200,
        headers: {
          "Content-Type": url === cssUrl ? "text/css" : "text/html",
        },
      }),
  });

  const summary = await crawler.start([pageUrl, cssUrl]);
  const mixedFindings = summary.findings.filter(
    (finding) => finding.ruleId === "mixed-content",
  );
  const mixedByTarget = new Map(
    mixedFindings.map((finding) => [finding.targetUrl, finding]),
  );

  assert.equal(mixedFindings.length, 7);
  assert.equal(
    mixedByTarget.get("http://assets.test/inline-import.css").url,
    pageUrl,
  );
  assert.match(
    mixedByTarget.get("http://assets.test/inline-import.css").detectedValue,
    /^style#critical line 2 via @import="http:\/\/assets\.test\/inline-import\.css"/,
  );
  assert.match(
    mixedByTarget.get("http://assets.test/inline-background.png").detectedValue,
    /^style#critical line 3 via url\(\)="http:\/\/assets\.test\/inline-background\.png"/,
  );
  assert.match(
    mixedByTarget.get("http://assets.test/icon.svg").detectedValue,
    /^style#critical line 4 via url\(\)="http:\/\/assets\.test\/icon\.svg"/,
  );
  assert.match(
    mixedByTarget.get("http://assets.test/card.png").detectedValue,
    /^div#card\.promo via style url\(\)="http:\/\/assets\.test\/card\.png"/,
  );
  assert.equal(
    mixedByTarget.get("http://assets.test/nested.css").url,
    cssUrl,
  );
  assert.match(
    mixedByTarget.get("http://assets.test/nested.css").detectedValue,
    /^CSS stylesheet line 2 via @import="http:\/\/assets\.test\/nested\.css"/,
  );
  assert.match(
    mixedByTarget.get("http://assets.test/font.woff2").detectedValue,
    /^CSS stylesheet line 5 via url\(\)="http:\/\/assets\.test\/font\.woff2"/,
  );
  assert.match(
    mixedByTarget.get("http://assets.test/modern-font.woff2").detectedValue,
    /^CSS stylesheet line 6 via src\(\)="http:\/\/assets\.test\/modern-font\.woff2"/,
  );

  const ignoredTargets = [
    "http://ignored.test/string.png",
    "http://ignored.test/comment.png",
    "http://ignored.test/supports.png",
    "http://www.w3.org/2000/svg",
    "http://ignored.test/custom-property.png",
    "http://ignored.test/less.png",
    "http://ignored.test/attribute-string.png",
    "http://ignored.test/attribute-import.css",
    "http://ignored.test/css-comment.png",
    "http://ignored.test/css-string.png",
    "http://ignored.test/css-supports.png",
    "http://ignored.test/nested-import.css",
    "http://ignored.test/css-custom-property.png",
  ];
  for (const targetUrl of ignoredTargets) {
    assert.ok(!mixedByTarget.has(targetUrl), `${targetUrl} should not be reported`);
    assert.ok(
      !crawler.resourceEdges.some((edge) => edge.targetUrl === targetUrl),
      `${targetUrl} should not be a CSS resource edge`,
    );
  }

  assert.ok(
    crawler.resourceEdges.some(
      (edge) => edge.targetUrl === "https://secure.test/images/logo.png",
    ),
    "relative URLs in fetched CSS should resolve against the stylesheet URL",
  );
  assert.ok(
    !mixedByTarget.has("https://secure.test/images/logo.png"),
    "resolved HTTPS CSS resources should remain clean",
  );
});

test("distinguishes valid file hyperlinks from link-only resource relationships on anchors", async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head>
      <title>Resource hyperlink semantics fixture</title>
      <meta name="description" content="A sufficiently long description for the resource hyperlink semantics fixture page.">
    </head><body>
      <h1>Resource hyperlink semantics fixture</h1>
      <p>${"Useful fixture content. ".repeat(220)}</p>

      <a href="/guide.pdf" target="_blank" rel="noopener noreferrer">Read the guide</a>
      <a href="/photo.jpg">View the full-size photo</a>
      <a href="/example.css" download>Download the CSS example</a>
      <a href="/example.js">View the JavaScript source</a>
      <a href="/brand.woff2">Download the brand font</a>

      <a href="/theme.css" rel="stylesheet">Load the theme stylesheet</a>
      <a href="/app.js" rel="modulepreload">Preload the application module</a>
      <a href="/assets/brand-font" rel="nofollow preload" as="font">Preload the font</a>
      <a href="https://external.example/community" rel="ugc,nofollow">Community source</a>
    </body></html>`);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const crawler = new SeoCrawler({
    maxUrls: 1,
    concurrency: 1,
    respectRobots: false,
    discoverSitemaps: false,
    crawlAssets: false,
    checkExternalLinks: false,
    timeout: 5_000,
  });

  const summary = await crawler.start([`http://127.0.0.1:${port}/`]);
  const cssDownloadEdge = crawler.linkEdges.find(
    (edge) => new URL(edge.targetUrl).pathname === "/example.css",
  );
  const communityEdge = crawler.linkEdges.find(
    (edge) => edge.targetUrl === "https://external.example/community",
  );
  assert.equal(cssDownloadEdge.download, true);
  assert.equal(communityEdge.rel, "ugc,nofollow");
  assert.equal(communityEdge.nofollow, true);
  assert.ok(
    !summary.findings.some((finding) => finding.ruleId === "external-nofollow"),
    "one explicitly qualified UGC link should not produce a policy warning",
  );
  const findings = summary.findings
    .filter((finding) => finding.ruleId === "resource-as-link")
    .sort((a, b) => a.targetUrl.localeCompare(b.targetUrl));
  const byTargetPath = new Map(
    findings.map((finding) => [new URL(finding.targetUrl).pathname, finding]),
  );

  assert.equal(findings.length, 3);
  assert.equal(
    byTargetPath.get("/theme.css").detail,
    "<a> uses a resource relationship that only works on <link>: stylesheet",
  );
  assert.equal(
    byTargetPath.get("/theme.css").detectedValue,
    'rel="stylesheet"',
  );
  assert.equal(
    byTargetPath.get("/app.js").detectedValue,
    'rel="modulepreload"',
  );
  assert.equal(
    byTargetPath.get("/assets/brand-font").detectedValue,
    'rel="preload"',
  );

  for (const validPath of [
    "/guide.pdf",
    "/photo.jpg",
    "/example.css",
    "/example.js",
    "/brand.woff2",
  ]) {
    assert.ok(!byTargetPath.has(validPath), `${validPath} should remain a valid hyperlink`);
  }
});

// ── Crawler-completeness Phase 1 ────────────────────────────────────────────

test("assertGraphReady: throws if the queue is not drained and the crawl was not stopped", () => {
  assert.throws(
    () => assertGraphReady({ queueLength: 3, active: 0, stopped: false }),
    /queued/,
  );
});

test("assertGraphReady: throws if a fetch is still in flight, queue empty or not", () => {
  assert.throws(
    () => assertGraphReady({ queueLength: 0, active: 1, stopped: false }),
    /in flight/,
  );
  assert.throws(
    () => assertGraphReady({ queueLength: 0, active: 2, stopped: true }),
    /in flight/,
  );
});

test("assertGraphReady: does not throw once the queue is drained (or stopped) and nothing is in flight", () => {
  assert.doesNotThrow(() => assertGraphReady({ queueLength: 0, active: 0, stopped: false }));
  assert.doesNotThrow(() => assertGraphReady({ queueLength: 47, active: 0, stopped: true }));
});

test("a redirect response's blank Content-Type does not misclassify an ordinary internal link as isAsset", async (t) => {
  const server = http.createServer((request, response) => {
    const routes = {
      "/robots.txt": [200, "text/plain", "User-agent: *\nAllow: /"],
      "/": [
        200,
        "text/html",
        `<!doctype html><html><head><title>isAsset fixture</title>
          <meta name="description" content="A page linking to a redirecting tracking link and a real image, to confirm only the image is treated as an asset.">
        </head><body><h1>Home</h1><p>${"Fixture content for the isAsset test page. ".repeat(20)}</p>
          <a href="/goto/offer">Redirecting tracking link</a>
          <img src="/logo.png" alt="Logo">
        </body></html>`,
      ],
      // A 3xx with NO Content-Type header at all — the exact shape that
      // previously tripped the content-type fallback.
      "/goto/offer": [302, "", ""],
      "/logo.png": [200, "image/png", "not-a-real-png-but-has-the-right-type"],
    };
    const [status, type, body] = routes[request.url] || [404, "text/plain", "Not found"];
    response.statusCode = status;
    if (type) response.setHeader("Content-Type", type);
    if (request.url === "/goto/offer") response.setHeader("Location", "/offer");
    response.end(body);
  });
  t.after(() => server.close());

  const port = await listen(server);
  const crawler = new SeoCrawler({
    maxUrls: 20,
    concurrency: 2,
    respectRobots: true,
    crawlAssets: true,
    checkExternalLinks: false,
    discoverSitemaps: false,
    timeout: 5_000,
  });
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);

  const redirectResult = summary.results.find((item) => item.url.endsWith("/goto/offer"));
  const imageResult = summary.results.find((item) => item.url.endsWith("/logo.png"));
  assert.ok(redirectResult, "the redirect should still have been fetched and recorded");
  assert.equal(redirectResult.isAsset, false, "a redirect with no content-type is not an asset just because it wasn't HTML");
  assert.ok(imageResult, "the real image should have been fetched too");
  assert.equal(imageResult.isAsset, true, "a genuine image is still correctly classified as an asset");
});
