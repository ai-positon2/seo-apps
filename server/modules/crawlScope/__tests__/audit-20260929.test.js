// Regression tests for the 2026-09-29 accuracy audit (audit/priority_list.md).
// Each test names the defect it pins down; the evidence is under audit/.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { buildFindings } = require("../analyzer");
const fs = require("node:fs");
const { SeoCrawler } = require("../crawler");
const { findBrowserExecutable } = require("../render-check");

const chrome = findBrowserExecutable() || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
].find((path) => fs.existsSync(path));
const withChrome = (t) => {
  process.env.CRAWLSCOPE_CHROME_PATH = chrome;
  t.after(() => { delete process.env.CRAWLSCOPE_CHROME_PATH; });
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function serve(t, routes) {
  const server = http.createServer((request, response) => {
    const route = routes[request.url.split("#")[0]];
    if (!route) {
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><html><head><title>Not found</title></head><body>Not found</body></html>");
      return;
    }
    const { status = 200, headers = { "Content-Type": "text/html" }, body = "" } = typeof route === "function" ? route(request) : route;
    response.statusCode = status;
    for (const [k, v] of Object.entries(headers)) response.setHeader(k, v);
    response.end(body);
  });
  t.after(() => server.close());
  return listen(server);
}

const crawl = (port, options = {}) =>
  new SeoCrawler({ maxUrls: 20, respectRobots: false, discoverSitemaps: false, checkExternalLinks: false, timeout: 5_000, ...options })
    .start(`http://127.0.0.1:${port}/`);

// ── D1 ──────────────────────────────────────────────────────────────────────
// berkshirehathaway.com: no charset in the header, and
// <meta http-equiv="Content-Type" content="text/html; charset=unicode">.
// "unicode" is a WHATWG label for UTF-16LE; the page decoded as CJK garbage and
// the site was reported as a one-page client-rendered app.
test("D1: a meta-declared UTF-16 label is read as UTF-8, as the HTML spec says", async (t) => {
  const home =
    "<!-- Global site tag -->\n<script async src=\"https://www.googletagmanager.com/gtag/js\"></script>\n" +
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN">\n' +
    '<html><head><title>BERKSHIRE HATHAWAY INC.</title>\n<meta content="text/html; charset=unicode" http-equiv="Content-Type"></head>' +
    '<body><ul><li><a href="/message.html">A Message from Warren E. Buffett</a></li><li><a href="/reports.html">Annual Reports</a></li></ul></body></html>';
  const child = (title) => `<html><head><meta charset="unicode"><title>${title}</title></head><body><p>${title}</p></body></html>`;
  const port = await serve(t, {
    "/": { body: home },
    "/message.html": { body: child("A message from the chairman") },
    "/reports.html": { body: child("Annual and interim reports") },
  });
  const summary = await crawl(port);
  const home_ = summary.results.find((r) => r.url === `http://127.0.0.1:${port}/`);
  assert.equal(home_.title, "BERKSHIRE HATHAWAY INC.");
  assert.equal(home_.anchorCount, 2);
  assert.equal(summary.results.filter((r) => r.scope !== "External").length, 3, "both linked pages are crawled");
  const ids = summary.findings.map((f) => f.ruleId);
  assert.ok(!ids.includes("title-missing"), ids.join(","));
  assert.ok(!ids.includes("javascript-rendered-site"), ids.join(","));
});

// ── D2 / R11 ────────────────────────────────────────────────────────────────
// A client-rendered shell: no links, no text until app.js runs. duolingo.com
// was audited as served (84 "missing H1", 82 "orphans"); and it also sets two
// cookies, which made every render fail with net::ERR_FAILED.
const shellSite = () => ({
  "/": {
    headers: { "Content-Type": "text/html", "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"] },
    body: '<!doctype html><html><head><meta charset="utf-8"><title>App</title><script src="/app.js"></script></head><body><div id="root"></div></body></html>',
  },
  "/app.js": {
    headers: { "Content-Type": "application/javascript" },
    body: `document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.lang = "en";
      const root = document.getElementById("root");
      root.innerHTML = "<h1>Learn anything</h1><p>" + "Real content words here. ".repeat(60) + "</p>" +
        '<a href="/courses">Courses</a> <a href="/about">About us</a>';
      document.title = "Learn anything with the rendered application home page";
    });`,
  },
  "/courses": { body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Courses in the rendered application</title></head><body><h1>Courses</h1><a href="/">Home</a></body></html>' },
  "/about": { body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About the rendered application team</title></head><body><h1>About</h1><a href="/">Home</a></body></html>' },
});

test("D2: a client-rendered start page switches the crawl to rendering", { skip: !chrome && "no Chromium here" }, async (t) => {
  withChrome(t);
  const port = await serve(t, shellSite());
  const summary = await crawl(port, { autoRenderJavaScript: true, crawlAssets: false, concurrency: 2, perHostDelay: 0, timeout: 10_000 });
  assert.ok(summary.siteDiagnostics.autoRenderJavaScript, "auto-render was triggered");
  const home = summary.results.find((r) => r.url === `http://127.0.0.1:${port}/`);
  assert.equal(home.renderedWithJavaScript, true);
  assert.equal(home.h1Count, 1);
  const paths = summary.results.filter((r) => r.scope !== "External").map((r) => new URL(r.url).pathname).sort();
  assert.deepEqual(paths, ["/", "/about", "/courses"], "links built by JavaScript were crawled");
  const onHome = summary.findings.filter((f) => f.url === home.url).map((f) => f.ruleId);
  assert.ok(!onHome.includes("h1-missing") && !onHome.includes("html-lang-missing"), onHome.join(","));
  assert.ok(summary.findings.some((f) => f.ruleId === "javascript-rendered-site"), "the dependency on JavaScript is still reported");
});

test("R11: a page that sets two cookies can be rendered", { skip: !chrome && "no Chromium here" }, async (t) => {
  withChrome(t);
  const port = await serve(t, shellSite());
  const summary = await crawl(port, { renderCheck: true, crawlAssets: false, perHostDelay: 0, timeout: 10_000 });
  assert.equal(summary.siteDiagnostics.renderCheck.ran, true, JSON.stringify(summary.siteDiagnostics.renderCheck));
});

test("D2: without a browser, a shell's content checks are not evaluated rather than failed", () => {
  const H = "https://spa.example";
  const shell = (path) => ({
    url: `${H}${path}`, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
    title: "App", titleCount: 1, titleLength: 3, metaDescription: "", metaLength: 0, viewport: "width=device-width",
    h1Count: 0, h1: "", words: 0, textHtmlRatio: 0.01, canonical: `${H}${path}`, hreflangs: [], robots: "",
    indexability: "Indexable", depth: 1, hash: "shell", htmlLang: "", fromSitemap: true,
    responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: ["og:title"], openGraphInvalidUrls: [],
  });
  const { findings, coverage } = buildFindings({
    results: [shell("/"), shell("/a"), shell("/b")],
    startUrl: `${H}/`,
    sitemapMembership: { [`${H}/`]: ["s"], [`${H}/a`]: ["s"], [`${H}/b`]: ["s"] },
    siteDiagnostics: { clientRenderedShell: true, renderingIssue: "shell" },
  });
  const ids = new Set(findings.map((f) => f.ruleId));
  for (const id of ["h1-missing", "html-lang-missing", "title-short", "title-duplicate", "orphan-page", "meta-missing"]) {
    assert.ok(!ids.has(id), `${id} not reported on a shell`);
  }
  assert.ok(ids.has("javascript-rendered-site"));
  const skipped = new Set(coverage.notEvaluated.map((x) => x.ruleId));
  assert.ok(skipped.has("h1-missing") && skipped.has("orphan-page"));
});

// ── D6 ──────────────────────────────────────────────────────────────────────
const docPage = (url, extra = {}) => ({
  url, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: `Documentation page ${url} for the fixture`, titleCount: 1, titleLength: 45,
  metaDescription: "A description long enough to pass the meta length checks without any trouble.", metaLength: 90,
  viewport: "width=device-width", h1Count: 1, h1: `H1 ${url}`, words: 400, canonical: url, hreflangs: [], robots: "",
  indexability: "Indexable", depth: 1, hash: url, responseTime: 100, strictTransportSecurity: "max-age=1",
  openGraphMissing: [], openGraphInvalidUrls: [], ...extra,
});

test("D6: chapter rel=next/prev with a cross-version canonical is not pagination", () => {
  const D = "https://docs.example";
  const { findings } = buildFindings({
    results: [docPage(`${D}/3.16/bugs.html`, {
      canonical: `${D}/3/bugs.html`, paginationNext: `${D}/3.16/about.html`, paginationPrev: `${D}/3.16/glossary.html`,
    })],
    startUrl: `${D}/3.16/bugs.html`,
    sitemapsChecked: false,
  });
  assert.ok(!findings.some((f) => f.ruleId === "pagination-canonical-conflict"));
});

test("D6: a real paginated listing canonicalised to page 1 is still reported, with its evidence", () => {
  const S = "https://shop.example";
  const { findings } = buildFindings({
    results: [docPage(`${S}/blog/page/2/`, { canonical: `${S}/blog/`, paginationPrev: `${S}/blog/`, paginationNext: `${S}/blog/page/3/` })],
    startUrl: `${S}/blog/page/2/`,
    sitemapsChecked: false,
  });
  const f = findings.find((x) => x.ruleId === "pagination-canonical-conflict");
  assert.ok(f);
  assert.match(f.detail, /rel="next" .*page\/3/);
  assert.match(f.detail, /canonical https:\/\/shop.example\/blog\//);
});

// ── D5 ──────────────────────────────────────────────────────────────────────
test("D5: schema.org's context aliases id/type, and inline context terms are not schema.org's", () => {
  const cheerio = require("cheerio");
  const { structuredDataFromPage } = require("../structured-data");
  const w3 = {
    "@context": ["http://schema.org", { "@vocab": "http://schema.org/", w3p: "http://www.w3.org/2001/02pd/rec54#", isBasedOn: { "@type": "@id" } }],
    id: "https://www.w3.org/TR/vc-data-model-2.0/", type: "TechArticle", name: "Verifiable Credentials", "w3p:level": "REC",
  };
  const wikihow = { "@context": "https://schema.org", "@type": "Article", headline: "IQ Test", mainEntityOfPage: { "@type": "WebPage", id: "https://www.wikihow.com/IQ-Test" } };
  const typo = { "@context": "https://schema.org", "@type": "Article", headlien: "Typo" };
  const $ = cheerio.load(`<html><head>${[w3, wikihow, typo].map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join("")}</head><body></body></html>`);
  const { problems, types } = structuredDataFromPage($);
  const messages = problems.map((p) => p.message);
  assert.ok(!messages.some((m) => /"id" is not a schema.org property/.test(m)), messages.join(" | "));
  assert.ok(!messages.some((m) => /no @type/.test(m)), messages.join(" | "));
  assert.ok(types.includes("TechArticle"), "the aliased type is read");
  assert.ok(messages.some((m) => /"headlien" is not a schema.org property/.test(m)), "a real typo is still caught");
});

// ── D3 ──────────────────────────────────────────────────────────────────────
test("D3: an alternate on another host that was only status-checked is not 'missing its return tag'", () => {
  const W = "https://www.wiki.example";
  const home = docPage(`${W}/Main-Page`, {
    hreflangs: [
      { lang: "en", url: `${W}/Main-Page` },
      { lang: "de", url: "https://de.wiki.example/Hauptseite" },
      { lang: "es", url: "https://es.wiki.example/Portada" },
      { lang: "x-default", url: `${W}/Main-Page` },
    ],
  });
  const external = (url, status) => ({ url, scope: "External", status, statusText: "", contentType: "text/html", hreflangs: [], title: "" });
  const { findings } = buildFindings({
    results: [home, external("https://de.wiki.example/Hauptseite", 200), external("https://es.wiki.example/Portada", 404)],
    startUrl: home.url,
    sitemapsChecked: false,
  });
  assert.ok(!findings.some((f) => f.ruleId === "hreflang-missing-return"), findings.map((f) => f.ruleId).join(","));
  const invalid = findings.filter((f) => f.ruleId === "hreflang-target-invalid").map((f) => f.targetUrl);
  assert.deepEqual(invalid, ["https://es.wiki.example/Portada"], "a status problem on another host is still reported");
});

test("D3: alternates on another host are read, so a real missing return tag is still found", async (t) => {
  let other = 0;
  const main = await serve(t, {
    "/": () => ({
      body: `<!doctype html><html lang="en"><head><title>Main page of the multilingual fixture site</title>
        <link rel="alternate" hreflang="en" href="http://127.0.0.1:${main}/">
        <link rel="alternate" hreflang="de" href="http://localhost:${other}/de">
        <link rel="alternate" hreflang="fr" href="http://localhost:${other}/fr">
        <link rel="alternate" hreflang="x-default" href="http://127.0.0.1:${main}/"></head><body><h1>Home</h1></body></html>`,
    }),
  });
  other = await serve(t, {
    "/de": () => ({ body: `<html><head><link rel="alternate" hreflang="en" href="http://127.0.0.1:${main}/"><link rel="alternate" hreflang="de" href="http://localhost:${other}/de"></head><body>de</body></html>` }),
    "/fr": { body: "<html><head><title>fr</title></head><body>fr, with no return tag</body></html>" },
  });
  const summary = await crawl(main, { checkExternalLinks: true });
  const missing = summary.findings.filter((f) => f.ruleId === "hreflang-missing-return").map((f) => f.targetUrl);
  assert.deepEqual(missing, [`http://localhost:${other}/fr`]);
});

// ── D4 / R14 ────────────────────────────────────────────────────────────────
test("D4/R14: no declared sitemap and a 404 /sitemap.xml is one finding, not an unreadable sitemap", async (t) => {
  const port = await serve(t, {
    "/robots.txt": { headers: { "Content-Type": "text/plain" }, body: "User-agent: *\nDisallow:\n" },
    "/": { body: '<!doctype html><html lang="en"><head><title>Home page of the no-sitemap fixture site</title></head><body><h1>Home</h1><a href="/a">A</a></body></html>' },
    "/a": { body: '<!doctype html><html lang="en"><head><title>Page A of the no-sitemap fixture site</title></head><body><h1>A</h1><a href="/">Home</a></body></html>' },
  });
  const summary = await crawl(port, { respectRobots: true, discoverSitemaps: true });
  const ids = summary.findings.map((f) => f.ruleId);
  assert.ok(!ids.includes("sitemap-unreadable"), ids.join(","));
  assert.ok(!ids.includes("sitemap-missing-indexable"), "not once per page");
  const config = summary.findings.filter((f) => f.ruleId === "sitemap-robots-config");
  assert.equal(config.length, 1);
  assert.match(config[0].detail, /declares no sitemap/);
});

test("D4: an RSS feed declared as a sitemap is read as one", async (t) => {
  let port = 0;
  port = await serve(t, {
    "/robots.txt": () => ({ headers: { "Content-Type": "text/plain" }, body: `User-agent: *\nDisallow:\nSitemap: http://127.0.0.1:${port}/rss/\n` }),
    "/rss/": () => ({
      headers: { "Content-Type": "application/rss+xml" },
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title><link>http://127.0.0.1:${port}/</link>
        <item><title>A</title><link>http://127.0.0.1:${port}/a</link></item></channel></rss>`,
    }),
    "/": { body: '<!doctype html><html lang="en"><head><title>Home page of the feed sitemap fixture</title></head><body><h1>Home</h1><a href="/a">A</a></body></html>' },
    "/a": { body: '<!doctype html><html lang="en"><head><title>Post A of the feed sitemap fixture site</title></head><body><h1>A</h1></body></html>' },
  });
  const summary = await crawl(port, { respectRobots: true, discoverSitemaps: true });
  const ids = summary.findings.map((f) => f.ruleId);
  assert.ok(!ids.includes("sitemap-unreadable"), ids.join(","));
  assert.ok(!summary.findings.some((f) => f.ruleId === "sitemap-missing-indexable" && f.url.endsWith("/a")), "the feed lists /a");
});

// ── D8 / D9 ─────────────────────────────────────────────────────────────────
test("D8/D9: an external link that fails only for the crawler's User-Agent is not broken", async (t) => {
  let ext = 0;
  const external = await serve(t, {
    "/bot-404": (req) => ({ status: /CrawlScope/.test(req.headers["user-agent"] || "") ? 404 : 200, body: "<html><body>ok</body></html>" }),
    "/bot-403": (req) => ({ status: /CrawlScope/.test(req.headers["user-agent"] || "") ? 403 : 200, body: "<html><body>ok</body></html>" }),
    "/gone": { status: 404, body: "<html><body>gone</body></html>" },
  });
  ext = external;
  const main = await serve(t, {
    "/": () => ({ body: `<!doctype html><html lang="en"><head><title>Links page of the external recheck fixture</title></head><body><h1>Links</h1>
      <a href="http://localhost:${ext}/bot-404">Bot 404</a> <a href="http://localhost:${ext}/bot-403">Bot 403</a>
      <a href="http://localhost:${ext}/gone">Gone</a>
      <a href="https://x.com/intent/tweet?url=http%3A%2F%2Fexample.com">Share</a></body></html>` }),
  });
  const summary = await crawl(main, { checkExternalLinks: true });
  const broken = summary.findings.filter((f) => f.ruleId === "broken-external-link").map((f) => f.targetUrl);
  assert.deepEqual(broken, [`http://localhost:${ext}/gone`]);
  assert.ok(!summary.findings.some((f) => f.ruleId === "external-403"), "a refusal that a browser does not get is not listed");
  assert.ok(!summary.results.some((r) => r.url.startsWith("https://x.com/")), "share endpoints are not probed");
  const gone = summary.findings.find((f) => f.ruleId === "broken-external-link");
  assert.match(gone.detail, /HTTP 404.*asked again as a browser: HTTP 404/);
});

// ── D7 ──────────────────────────────────────────────────────────────────────
test("D7: Japanese and Chinese text is counted in words, not whitespace runs", async (t) => {
  const { __countWords: countWords } = require("../crawler");
  assert.equal(countWords("one two  three\nfour"), 4, "spaced languages are unchanged");
  assert.ok(countWords("W3Cは、ウェブのための標準を策定する国際的なコミュニティです。") >= 10);
  // The w3.org/ja/ case end to end: 300+ characters of Japanese is not thin.
  const ja = "W3Cは、ウェブのための標準を策定する国際的なコミュニティです。".repeat(24);
  const port = await serve(t, {
    "/": { body: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>W3Cについて ウェブ標準を策定する国際的な団体</title></head><body><h1>W3Cについて</h1><p>${ja}</p></body></html>` },
  });
  const summary = await crawl(port);
  assert.ok(!summary.findings.some((f) => f.ruleId === "low-word-count" || f.ruleId === "low-text-html-ratio"),
    summary.findings.map((f) => f.ruleId).join(","));
});

// ── D10 ─────────────────────────────────────────────────────────────────────
test("D10: a page slow only under crawl load is re-timed and not reported; a slow server still is", async (t) => {
  let fastHits = 0;
  const page = (title) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1><a href="/">home</a><a href="/once">o</a><a href="/always">a</a></body></html>`;
  const server = http.createServer((request, response) => {
    const send = () => { response.setHeader("Content-Type", "text/html"); response.end(page(`Page ${request.url} of the timing fixture site`)); };
    if (request.url === "/once") {
      fastHits += 1;
      return fastHits === 1 ? setTimeout(send, 1_300) : send();
    }
    if (request.url === "/always") return setTimeout(send, 1_300);
    return send();
  });
  t.after(() => server.close());
  const port = await listen(server);
  const summary = await crawl(port);
  const slow = summary.findings.filter((f) => f.ruleId === "slow-page").map((f) => new URL(f.url).pathname);
  assert.deepEqual(slow, ["/always"]);
  const once = summary.results.find((r) => r.url.endsWith("/once"));
  assert.equal(once.responseTimeSamples.length, 3);
});

// ── D11 / D12 / D13 / F3 / asset floor ──────────────────────────────────────
test("D11-D13, F3: XML prolog doctype, aria-hidden links, og:url without a canonical, noscript link text", async (t) => {
  const port = await serve(t, {
    "/": { body: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html lang="en"><head><title>Home page of the small fixes fixture site here</title>
<meta property="og:url" content="http://example.com/"></head><body><h1>Home</h1>
<a href="/post">A post about something</a>
<a href="/post" aria-hidden="true" tabindex="-1"><img src="/card.png" alt="Card"></a>
<a href="/banner"><img data-src="/banner.jpg" width="728" height="90"><noscript><img src="/banner.jpg"></noscript></a>
</body></html>` },
    "/post": { body: '<!doctype html><html lang="en"><head><title>Post page of the small fixes fixture site</title></head><body><h1>Post</h1></body></html>' },
    "/banner": { body: '<!doctype html><html lang="en"><head><title>Banner page of the small fixes fixture site</title></head><body><h1>Banner</h1></body></html>' },
  });
  const summary = await crawl(port, { crawlAssets: false });
  const home = `http://127.0.0.1:${port}/`;
  const on = (rule) => summary.findings.filter((f) => f.ruleId === rule && f.url === home);
  assert.equal(on("doctype-missing").length, 0, "D11");
  assert.equal(on("open-graph-canonical").length, 0, "D13: no canonical tag, nothing to disagree with");
  const unnamed = on("anchor-missing").map((f) => new URL(f.targetUrl).pathname);
  assert.deepEqual(unnamed, ["/banner"], "D12 skips the aria-hidden card; F3 finds the banner");
  const bannerEdge = summary.linkEdges.find((e) => e.targetUrl.endsWith("/banner"));
  assert.equal(bannerEdge.anchorText, "", "F3: no markup as anchor text");
});

test("asset-uncompressed ignores files too small to benefit", () => {
  const H = "https://assets.example";
  const asset = (path, size) => ({ url: `${H}${path}`, scope: "Internal", status: 200, contentType: "application/javascript", isAsset: true, cacheable: true, contentEncoding: "", decodedSize: size, size });
  const { findings } = buildFindings({ results: [docPage(`${H}/`), asset("/tiny.js", 81), asset("/big.js", 40_000)], startUrl: `${H}/`, sitemapsChecked: false });
  assert.deepEqual(findings.filter((f) => f.ruleId === "asset-uncompressed").map((f) => f.url), [`${H}/big.js`]);
});

// ── F1 / F2 / R3 ────────────────────────────────────────────────────────────
// crawler-test.com /redirects/redirect_to_404 and a link to a 404 past the
// page budget: both went unreported, and broken-internal-links read as passed.
test("F1/F2: link targets and redirect hops past the page budget are status-checked", async (t) => {
  const pages = {
    "/": { body: '<!doctype html><html lang="en"><head><title>Home page of the page budget fixture site</title></head><body><h1>Home</h1><a href="/a">A</a></body></html>' },
    "/a": { body: '<!doctype html><html lang="en"><head><title>Page A of the page budget fixture site</title></head><body><h1>A</h1><a href="/b">B</a><a href="/gone">Gone</a><a href="/hop">Hop</a><a href="/loop1">Loop</a></body></html>' },
    "/b": { body: '<!doctype html><html lang="en"><head><title>Page B of the page budget fixture site</title></head><body><h1>B</h1></body></html>' },
    "/hop": { status: 302, headers: { Location: "/hop2" } },
    "/hop2": { status: 301, headers: { Location: "/dead-end" } },
    "/loop1": { status: 301, headers: { Location: "/loop2" } },
    "/loop2": { status: 301, headers: { Location: "/loop1" } },
  };
  const port = await serve(t, pages);
  const summary = await crawl(port, { maxUrls: 2, maxProbeUrls: 20 });
  const ids = (rule) => summary.findings.filter((f) => f.ruleId === rule).map((f) => new URL(f.targetUrl || f.url).pathname).sort();
  assert.deepEqual(ids("broken-internal-links"), ["/gone", "/hop"], "a link into a redirect that ends at a 404 is broken too");
  assert.ok(summary.findings.some((f) => f.ruleId === "redirect-terminal-failure" && f.url.endsWith("/hop")), "302 -> 301 -> 404 found past the budget");
  assert.ok(summary.findings.some((f) => f.ruleId === "redirect-loop"), "the two-step loop is found");
  const probes = summary.results.filter((r) => r.probe);
  assert.ok(probes.length >= 5);
  assert.ok(!summary.findings.some((f) => f.url.endsWith("/b") && ["title-missing", "meta-missing", "h1-missing"].includes(f.ruleId)),
    "a status-checked page is not audited as an empty page");
  assert.equal(summary.results.filter((r) => !r.probe && r.scope !== "External").length, 2, "the page budget still holds");
});

test("R3: unchecked link targets make broken-internal-links partial, not clean", async (t) => {
  const port = await serve(t, {
    "/": { body: '<!doctype html><html lang="en"><head><title>Home page of the unchecked targets fixture</title></head><body><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></body></html>' },
  });
  const summary = await crawl(port, { maxUrls: 1, maxProbeUrls: 1 });
  const partial = summary.coverage.partial.find((p) => p.ruleId === "broken-internal-links");
  assert.ok(partial, JSON.stringify(summary.coverage.partial));
  assert.match(partial.reason, /^2 internal URLs/);
});

// ── R4 ──────────────────────────────────────────────────────────────────────
test("R4: a crawl cut short by its page budget says so, first thing in the workbook", async (t) => {
  const ExcelJS = require("exceljs");
  const { buildAuditWorkbook } = require("../report-writer");
  const catalog = require("../issue-catalog.json");
  const port = await serve(t, {
    "/": { body: '<!doctype html><html lang="en"><head><title>Home page of the partial crawl fixture</title></head><body><h1>Home</h1><a href="/a">A</a><a href="/b">B</a></body></html>' },
  });
  const summary = await crawl(port, { maxUrls: 1 });
  assert.equal(summary.coverage.crawl.budgetReached, true);
  assert.equal(summary.coverage.crawl.pagesAudited, 1);

  const buffer = await buildAuditWorkbook({ findings: summary.findings, catalog, siteUrl: `http://127.0.0.1:${port}/`, coverage: summary.coverage });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("SUMMARY");
  assert.match(String(sheet.getCell("A2").value), /^Partial audit — 1 of at least 3 known URLs were audited as pages: it reached its page limit\. Counts below cover the audited pages only/);
  assert.equal(sheet.getCell("A3").value, "#", "the table header moves down under the banner");

  const complete = await buildAuditWorkbook({
    findings: [], catalog,
    coverage: { notEvaluated: [], partial: [], pagesNotAudited: [], crawl: { pagesAudited: 3, knownNotAudited: 0 } },
  });
  const done = new ExcelJS.Workbook();
  await done.xlsx.load(complete);
  assert.equal(done.getWorksheet("SUMMARY").getCell("A2").value, "#", "a complete crawl has no banner");
});

// ── R8 ──────────────────────────────────────────────────────────────────────
test("R8: /llms.txt answered with the SPA's HTML page is a missing llms.txt, not a malformed one", async (t) => {
  const port = await serve(t, {
    "/": { body: '<!doctype html><html lang="en"><head><title>Home page of the llms soft 404 fixture</title></head><body><h1>Home</h1></body></html>' },
    "/llms.txt": { body: '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>' },
  });
  const summary = await crawl(port);
  const ids = summary.findings.map((f) => f.ruleId);
  assert.ok(!ids.includes("llms-format"), ids.join(","));
  const missing = summary.findings.find((f) => f.ruleId === "llms-missing");
  assert.ok(missing, ids.join(","));
  assert.match(missing.detail, /HTML page, not a text file/);
});

// ── R10 ─────────────────────────────────────────────────────────────────────
test("R10: an external host that keeps answering 429 stops being asked, and is not called broken", async (t) => {
  const asked = new Set();
  const external = await serve(t, Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`/repo${i}`, (req) => { asked.add(req.url); return { status: 429, body: "slow down" }; }]),
  ));
  const links = Array.from({ length: 8 }, (_, i) => `<a href="http://localhost:${external}/repo${i}">Repository ${i}</a>`).join(" ");
  const main = await serve(t, {
    "/": { body: `<!doctype html><html lang="en"><head><title>Home page of the rate limited host fixture</title></head><body><h1>Home</h1>${links}</body></html>` },
  });
  const summary = await crawl(main, { checkExternalLinks: true, concurrency: 1, retryBaseDelay: 5, maxRetryDelay: 20, maxHostDelay: 20 });
  assert.equal(asked.size, 3, `asked ${[...asked].join(", ")}`);
  assert.equal(summary.results.filter((r) => r.externalNotChecked).length, 5);
  assert.ok(!summary.findings.some((f) => f.ruleId === "broken-external-link"));
  const partial = summary.coverage.partial.find((p) => p.ruleId === "broken-external-link");
  assert.match(partial?.reason || "", /5 external URLs were not checked: localhost kept answering 429\/503/);
});

test("R10: a penalised host's delay steps back down as it answers again", () => {
  const crawler = new SeoCrawler({ perHostDelay: 100, retryBaseDelay: 1_000, hostBackoffFactor: 2, maxHostDelay: 10_000 });
  crawler._penalizeHost("github.com");
  crawler._penalizeHost("github.com");
  const penalised = crawler._hostState.get("github.com").delayMs;
  assert.equal(penalised, 4_000);
  for (let i = 0; i < 5; i += 1) crawler._relieveHost("github.com");
  assert.equal(crawler._hostState.get("github.com").delayMs, 2_000);
  for (let i = 0; i < 50; i += 1) crawler._relieveHost("github.com");
  assert.equal(crawler._hostState.get("github.com").delayMs, 100, "never below the crawl's own delay");
});

// ── R5-R7 ───────────────────────────────────────────────────────────────────
test("R5-R7: findings show the href as written, the link text, and their evidence", async (t) => {
  const port = await serve(t, {
    "/": { body: `<!doctype html><html lang="en"><head><title>Home page of the evidence fixture site</title><meta name="viewport" content="width=device-width"></head><body><h1>Home</h1>
      <a class="button" href="/course?utm_source=site&utm_medium=banner"></a>
      <a href="/old">Permissive licence</a> <a href="/missing">A missing page</a> <a href="/p?ref=main">Main branch</a> <a href="/p?ref=dev">Dev branch</a></body></html>` },
    "/course": { body: '<!doctype html><html lang="en"><head><title>Course page of the evidence fixture site</title></head><body><h1>Course</h1></body></html>' },
    "/old": { status: 301, headers: { Location: "/course" } },
    "/p?ref=main": { body: '<!doctype html><html lang="en"><head><title>Main branch page of the evidence fixture</title></head><body><p>No heading here.</p></body></html>' },
    "/p?ref=dev": { body: '<!doctype html><html lang="en"><head><title>Dev branch page of the evidence fixture</title></head><body><h1>Dev</h1></body></html>' },
  });
  const summary = await crawl(port);
  const anchor = summary.findings.find((f) => f.ruleId === "anchor-missing");
  assert.match(anchor.detail, /Written on the page as \/course\?utm_source=site&utm_medium=banner/);
  const redirect = summary.findings.find((f) => f.ruleId === "link-to-redirect");
  assert.equal(redirect.detectedValue, "Link text: “Permissive licence”");
  assert.match(redirect.detail, /redirects \(301\)/);
  const gone = summary.findings.find((f) => f.ruleId === "page-4xx");
  assert.equal(gone.detectedValue, "HTTP 404 Not Found");
  assert.ok(summary.results.some((r) => r.url.endsWith("/p?ref=main")) && summary.results.some((r) => r.url.endsWith("/p?ref=dev")), "?ref= selects a page and is kept");
  const h1 = summary.findings.find((f) => f.ruleId === "h1-missing");
  assert.ok(h1?.url.endsWith("/p?ref=main"));
  assert.equal(h1.detectedValue, "0 <h1> elements");
});

// Found on the re-crawl of berkshirehathaway.com: the render sample picked
// status-only probes, whose bodies were never read, and reported JavaScript as
// adding 11,598 words and a title to a static page.
test("F1/F2 follow-up: status-only probes are never sampled for the render check", () => {
  const crawler = new SeoCrawler({ renderSampleSize: 10 });
  crawler.startUrl = "https://example.com/";
  const page = (path, extra = {}) => ({ url: `https://example.com${path}`, scope: "Internal", status: 200, contentType: "text/html", ...extra });
  crawler.results = [page("/"), page("/a"), page("/1996ar/1996.html", { probe: true, words: 0, title: "" })];
  const sampled = crawler._renderCandidates().map((candidate) => candidate.url);
  assert.ok(sampled.includes("https://example.com/a"));
  assert.ok(!sampled.some((url) => url.endsWith("/1996ar/1996.html")), sampled.join(", "));
});

// ── Found on the duolingo.com re-crawl ──────────────────────────────────────
// Every rendered page fetched the app's bundles again, each behind the per-host
// delay, so later pages timed out and their empty shells were audited.
test("rendered pages share one copy of each static file for the whole crawl", async (t) => {
  let bundleHits = 0;
  let apiHits = 0;
  const port = await serve(t, {
    "/app.js": () => { bundleHits += 1; return { headers: { "Content-Type": "application/javascript" }, body: "window.ok = 1;" }; },
    "/api/data": () => { apiHits += 1; return { headers: { "Content-Type": "application/json" }, body: "{}" }; },
  });
  const crawler = new SeoCrawler({ respectRobots: false });
  const fetch = crawler._renderFetch();
  for (let i = 0; i < 3; i += 1) {
    const script = await fetch(`http://127.0.0.1:${port}/app.js`, { method: "GET", headers: {} });
    assert.equal(await script.text(), "window.ok = 1;");
    assert.equal(script.headers.get("content-type"), "application/javascript");
    await (await fetch(`http://127.0.0.1:${port}/api/data`, { method: "GET", headers: {} })).text();
  }
  assert.equal(bundleHits, 1, "the script is fetched once");
  assert.equal(apiHits, 3, "data requests are not cached");
});

test("a page of a rendered crawl that could not be rendered is not judged by its empty shell", async () => {
  const { healthMetrics } = await import(require("node:url").pathToFileURL(
    require("node:path").join(__dirname, "../../../../client/src/components/crawlScope/crawlHelpers.js")).href);
  const shell = {
    url: "https://example.com/course", scope: "Internal", status: 200, contentType: "text/html",
    title: "", h1Count: 0, words: 0, anchorCount: 0, scriptCount: 3, htmlLang: "", hreflangs: [], indexability: "Indexable",
    unrenderedShell: true,
  };
  const page = { ...shell, url: "https://example.com/", unrenderedShell: false, renderedWithJavaScript: true, title: "Home page of the rendered fixture", h1Count: 1, h1: "Home", words: 400, htmlLang: "en" };
  const { findings, results } = buildFindings({ results: [page, shell], startUrl: "https://example.com/", sitemapsChecked: false });
  const onShell = findings.filter((f) => f.url === shell.url).map((f) => f.ruleId);
  for (const rule of ["h1-missing", "title-missing", "html-lang-missing", "low-word-count"]) {
    assert.ok(!onShell.includes(rule), onShell.join(","));
  }
  assert.equal(healthMetrics(results, findings).htmlCount, 1, "and Site Health does not count it as a clean page");
});

// duolingo.com/info sets location to about.duolingo.com. Rendered, its DOM was
// read mid-navigation and audited as /info: an empty page, and the other
// site's relative /main.js reported as a broken script here.
test("a JavaScript redirect is reported as a redirect, not audited as the page", { skip: !chrome && "no Chromium here" }, async (t) => {
  withChrome(t);
  const port = await serve(t, {
    "/": { body: '<!doctype html><html lang="en"><head><title>Home page of the JavaScript redirect fixture</title></head><body><h1>Home</h1><p>Some words on the home page of this fixture site.</p><a href="/info">About us</a></body></html>' },
    "/info": { body: '<!doctype html><html><head><title>About</title><script>location.href = "/about";</script></head><body><div id="root"></div><script src="/main.js"></script></body></html>' },
    "/about": { body: '<!doctype html><html lang="en"><head><title>About the JavaScript redirect fixture site</title></head><body><h1>Our mission</h1><p>Words about the mission.</p></body></html>' },
    "/main.js": { status: 404, body: "" },
  });
  const summary = await crawl(port, { renderJavaScript: true, timeout: 10_000 });
  const info = summary.results.find((r) => r.url.endsWith("/info"));
  assert.equal(info.javascriptRedirectUrl, `http://127.0.0.1:${port}/about`);
  const onInfo = summary.findings.filter((f) => f.url.endsWith("/info")).map((f) => f.ruleId);
  assert.ok(!onInfo.includes("h1-missing") && !onInfo.includes("html-lang-missing"), onInfo.join(","));
  const redirect = summary.findings.find((f) => f.ruleId === "link-to-redirect" && f.targetUrl.endsWith("/info"));
  assert.match(redirect?.detail || "", /JavaScript redirect to http:\/\/127\.0\.0\.1:\d+\/about/);
  assert.ok(summary.results.some((r) => r.url.endsWith("/about") && r.h1Count === 1), "the destination is crawled");
});
