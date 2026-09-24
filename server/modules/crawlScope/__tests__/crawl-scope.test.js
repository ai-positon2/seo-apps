const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");
const { parseCrawlRequest, ValidationError } = require("../shared/options");

// A crawl could only be the whole host: no way to leave out a section, keep to
// one folder, treat a sort or filter parameter as the same page, or read a
// sitemap that robots.txt does not name. These are Semrush's and Ahrefs'
// scope settings, and what an audit of one part of a big site needs.

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const page = (title, links = []) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>` +
  `<p>${"Scope fixture words. ".repeat(30)}</p>${links.map((href) => `<a href="${href}">${href}</a>`).join("")}</body></html>`;

function site() {
  const requested = [];
  const routes = {
    "/robots.txt": ["text/plain", "User-agent: *\nAllow: /"],
    "/": ["text/html", page("Home", ["/blog/", "/blog/a", "/blog/a?replytocom=5", "/shop/x", "/shop/y?sort=price"])],
    "/blog/": ["text/html", page("Blog", ["/blog/a", "/blog/b", "/shop/x", "/"])],
    "/blog/a": ["text/html", page("Post A", ["/blog/b"])],
    "/blog/b": ["text/html", page("Post B")],
    "/shop/x": ["text/html", page("Shop X", ["/shop/y?sort=name"])],
    "/shop/y": ["text/html", page("Shop Y")],
    "/hidden": ["text/html", page("Only in a sitemap robots.txt does not name")],
  };
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    if (request.url === "/extra-sitemap.xml") {
      response.setHeader("Content-Type", "application/xml");
      response.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://${request.headers.host}/hidden</loc></url></urlset>`);
      return;
    }
    const path = request.url.split("?")[0];
    const route = routes[request.url] || routes[path];
    response.statusCode = route ? 200 : 404;
    response.setHeader("Content-Type", route ? route[0] : "text/html");
    response.end(route ? route[1] : "<html><head><title>Not found</title></head><body>Not found</body></html>");
  });
  return { server, requested };
}

async function crawl(options, path = "/") {
  const { server, requested } = site();
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const asked = typeof options === "function" ? options(base) : options;
    const { url, options: parsed } = parseCrawlRequest({ url: `${base}${path}`, options: { perHostDelay: 0, checkExternalLinks: false, renderCheck: false, ...asked } });
    const crawler = new SeoCrawler(parsed);
    const summary = await crawler.start(url);
    const pages = summary.results
      .filter((r) => String(r.contentType || "").includes("html"))
      .map((r) => r.url.slice(base.length))
      .sort();
    return { summary, pages, requested, base };
  } finally {
    server.close();
  }
}

test("the scope options are read, trimmed and bounded", () => {
  const { options } = parseCrawlRequest({
    url: "https://example.com/",
    options: {
      includePatterns: "/blog/*\n\n# a comment\n  /news/*  ",
      excludePatterns: ["*?replytocom=", "https://example.com/tag/*"],
      scopeToFolder: true,
      removeParameters: "sort, filter\nPage",
      sitemapUrls: "https://example.com/extra.xml\nhttps://example.com/extra.xml",
    },
  });
  assert.deepEqual(options.includePatterns, ["/blog/*", "/news/*"]);
  assert.deepEqual(options.excludePatterns, ["*?replytocom=", "/tag/*"]);
  assert.equal(options.scopeToFolder, true);
  assert.deepEqual(options.removeParameters, ["sort", "filter", "page"]);
  assert.deepEqual(options.sitemapUrls, ["https://example.com/extra.xml"]);

  const defaults = parseCrawlRequest({ url: "https://example.com/" }).options;
  assert.deepEqual(
    [defaults.includePatterns, defaults.excludePatterns, defaults.scopeToFolder, defaults.removeParameters, defaults.sitemapUrls],
    [[], [], false, [], []],
  );
  assert.throws(
    () => parseCrawlRequest({ url: "https://example.com/", options: { sitemapUrls: ["not a url"] } }),
    ValidationError,
  );
  assert.equal(
    parseCrawlRequest({ url: "https://example.com/", options: { excludePatterns: Array.from({ length: 80 }, (_, i) => `/p${i}`) } }).options.excludePatterns.length,
    50,
  );
});

test("include and exclude patterns decide what is crawled, and the report says what they left out", async () => {
  const { summary, pages, requested } = await crawl({ includePatterns: ["/blog/*"], excludePatterns: ["*replytocom="] });
  // The start page is always crawled: it is where the links are found.
  assert.deepEqual(pages, ["/", "/blog/", "/blog/a", "/blog/b"]);
  assert.ok(!requested.some((url) => url.startsWith("/shop/")), "nothing outside the include pattern is fetched");
  assert.ok(!requested.some((url) => url.includes("replytocom")), "nothing matching an exclude pattern is fetched");
  assert.equal(summary.siteDiagnostics.scopeRules.excluded, 3);
  const notAudited = summary.coverage.pagesNotAudited.map((entry) => entry.reason).join(" ");
  assert.match(notAudited, /3 URLs were left out by the crawl's include and exclude rules/);
  // With part of the site left out, links from the rest of it are unknown.
  const orphan = summary.coverage.notEvaluated.find((entry) => entry.ruleId === "orphan-page");
  assert.match(orphan.reason, /part of the site/);
  assert.ok(!summary.findings.some((f) => f.ruleId === "orphan-page"));
});

test("keeping to the start URL's folder", async () => {
  const { pages } = await crawl({ scopeToFolder: true }, "/blog/");
  assert.deepEqual(pages, ["/blog/", "/blog/a", "/blog/b"]);
});

test("a removed parameter makes its URLs one page, for fetching and for counting links", async () => {
  const { summary, pages, requested } = await crawl({ removeParameters: ["sort"] });
  assert.ok(pages.includes("/shop/y"));
  assert.ok(!pages.some((url) => url.includes("sort=")));
  assert.equal(requested.filter((url) => url.startsWith("/shop/y")).length, 1);
  // Linked as ?sort=price from the home page and ?sort=name from /shop/x.
  const shopY = summary.results.find((r) => r.url.endsWith("/shop/y"));
  assert.equal(shopY.followInlinks, 2);
});

test("a sitemap given with the crawl is read, even one robots.txt does not name", async () => {
  const { pages, summary } = await crawl((base) => ({ sitemapUrls: [`${base}/extra-sitemap.xml`] }));
  assert.ok(pages.includes("/hidden"), "the page only that sitemap lists is crawled");
  assert.ok(summary.siteDiagnostics.sitemaps.some((url) => url.endsWith("/extra-sitemap.xml")));
  // It is read with sitemap discovery turned off, too: it was asked for.
  const alone = await crawl((base) => ({ discoverSitemaps: false, sitemapUrls: [`${base}/extra-sitemap.xml`] }));
  assert.ok(alone.pages.includes("/hidden"));
  assert.ok(!alone.requested.includes("/sitemap.xml"), "discovery stays off: /sitemap.xml is not tried");
});

test("patterns read like robots.txt: anchored with /, anywhere without, * and a final $", () => {
  const { createScopeRules } = require("../url-scope");
  const allows = (rules, url) => createScopeRules(rules).allows(`https://example.com${url}`);
  const blog = { includePatterns: ["/blog/*"] };
  assert.equal(allows(blog, "/blog/post"), true);
  assert.equal(allows(blog, "/en/blog/post"), false, "a leading / anchors at the start of the path");
  const sort = { excludePatterns: ["sort="] };
  assert.equal(allows(sort, "/shop?sort=price"), false, "without a leading /, anywhere in the path and query");
  assert.equal(allows(sort, "/shop?page=2"), true);
  const pdf = { excludePatterns: ["/*.pdf$"] };
  assert.equal(allows(pdf, "/files/report.pdf"), false);
  assert.equal(allows(pdf, "/files/report.pdf?download=1"), true, "$ anchors the end");
  assert.equal(allows({ includePatterns: ["/blog/café/*"] }, "/blog/caf%C3%A9/post"), true, "matched decoded too");
  const folder = { folder: "/docs/" };
  assert.equal(allows(folder, "/docs/"), true);
  assert.equal(allows(folder, "/docs"), true, "the folder's own URL without its slash");
  assert.equal(allows(folder, "/docs/a/b"), true);
  assert.equal(allows(folder, "/docsearch"), false);
  assert.equal(createScopeRules({}).active, false);
});
