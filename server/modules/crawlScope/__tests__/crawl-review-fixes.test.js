const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SeoCrawler,
  parseRobots,
  isAllowedByRobots,
  __locText: locText,
  __srcsetUrls: srcsetUrls,
} = require("../crawler");
const { createScopeRules, folderOf } = require("../url-scope");
const { utf8HeaderValue, classifyRedirectLocation } = require("../http-redirect");
const { isPublicAddress } = require("../net/guard");
const { siteOf } = require("../db/repo");

// Defects found reviewing the crawl, each pinned with the input that showed it.

const allowed = (path, robots, agent) =>
  isAllowedByRobots(`https://example.com${path}`, parseRobots(robots, agent, { exact: agent === "googlebot" }).rules);

test("an empty Disallow still ends its group, so the next group's rules stay its own", () => {
  const robots = "User-agent: *\nDisallow:\n\nUser-agent: AhrefsBot\nDisallow: /\n";
  assert.equal(allowed("/page", robots), true, "the whole site was read as disallowed");
  assert.equal(allowed("/page", robots, "googlebot"), true);
  const googleOnly = "User-agent: Googlebot\nDisallow:\n\nUser-agent: *\nDisallow: /\n";
  assert.equal(allowed("/page", googleOnly, "googlebot"), true);
});

test("robots.txt with bare CR line endings is read line by line", () => {
  assert.equal(allowed("/private", "User-agent: *\rDisallow: /private\r"), false);
});

test("an empty User-agent line addresses nobody", () => {
  const robots = "User-agent:\nDisallow: /\n\nUser-agent: *\nDisallow: /private\n";
  assert.equal(allowed("/page", robots), true);
});

test("robots.txt paths compare percent-encoding-insensitively (RFC 9309 2.2.2)", () => {
  assert.equal(allowed("/caf%C3%A9/menu", "User-agent: *\nDisallow: /café\n"), false);
  assert.equal(allowed("/caf%C3%A9", "User-agent: *\nDisallow: /caf%c3%a9\n"), false);
  assert.equal(allowed("/~user/", "User-agent: *\nDisallow: /%7Euser\n"), false);
});

test("robots.txt wildcards still match as before", () => {
  const robots = "User-agent: *\nDisallow: /*.php$\nDisallow: /p\nAllow: /p/\n";
  assert.equal(allowed("/x.php", robots), false);
  assert.equal(allowed("/x.php?q=1", robots), true);
  assert.equal(allowed("/p/page", robots), true, "the longer Allow wins");
  assert.equal(allowed("/page", "User-agent: *\nDisallow: /page\nAllow: /page\n"), true, "a tie goes to Allow");
});

test("a hostile wildcard pattern is matched in linear time", () => {
  const hostile = "/*a*a*a*a*a*a*a*a*a*a*a*a*b";
  const path = `/${"a".repeat(60)}`;
  const started = Date.now();
  assert.equal(allowed(path, `User-agent: *\nDisallow: ${hostile}\n`), true);
  assert.equal(createScopeRules({ excludePatterns: [hostile.slice(1)] }).allows(`https://e.com${path}`), true);
  assert.ok(Date.now() - started < 200, "the RegExp form took seconds here");
});

test("scope patterns keep their anchoring", () => {
  assert.equal(createScopeRules({ excludePatterns: ["tag"] }).allows("https://e.com/a/tag/x"), false);
  assert.equal(createScopeRules({ includePatterns: ["/blog"] }).allows("https://e.com/x/blog"), false);
  assert.equal(createScopeRules({ excludePatterns: [".pdf$"] }).allows("https://e.com/a.pdf?x"), true);
});

test("scoping to a page's folder uses the folder the page is in", () => {
  assert.equal(folderOf("https://e.com/en/home.html"), "/en/");
  assert.equal(folderOf("https://e.com/blog"), "/blog/");
  assert.equal(folderOf("https://e.com/blog/"), "/blog/");
});

test("srcset URLs keep their commas", () => {
  assert.deepEqual(
    srcsetUrls("https://res.cloudinary.com/demo/image/upload/w_300,c_scale/a.jpg 300w, /b.jpg?resize=600,400 2x"),
    ["https://res.cloudinary.com/demo/image/upload/w_300,c_scale/a.jpg", "/b.jpg?resize=600,400"],
  );
});

test("a CDATA-wrapped sitemap <loc> is read literally", () => {
  assert.equal(locText("<![CDATA[https://example.com/a?b=1&c=2]]>"), "https://example.com/a?b=1&c=2");
  assert.equal(locText(" https://example.com/a?b=1&amp;c=2 "), "https://example.com/a?b=1&c=2");
});

test("a raw UTF-8 Location header is read as UTF-8", () => {
  const latin1 = Buffer.from("/café", "utf8").toString("latin1");
  assert.equal(utf8HeaderValue(latin1), "/café");
  assert.equal(
    classifyRedirectLocation({ status: 301, headerPresent: true, rawValue: latin1, responseUrl: "https://e.com/x" }).url,
    "https://e.com/caf%C3%A9",
  );
  assert.equal(utf8HeaderValue("/plain"), "/plain");
});

test("the IPv4-compatible IPv6 form is not public", () => {
  assert.equal(isPublicAddress("::a00:1"), false);
  assert.equal(isPublicAddress("::7f00:1"), false);
});

test("a site is its host without www, for one crawl per site per project", () => {
  assert.equal(siteOf("https://www.Example.com/a"), "example.com");
  assert.equal(siteOf("http://example.com"), "example.com");
  assert.equal(siteOf("List crawl (3 URLs)"), null);
});

// ── Whole crawls, against an injected fetch ─────────────────────────────────

const page = (title, links = [], head = "") =>
  `<!doctype html><html lang="en"><head>${head}<title>${title}</title></head><body><h1>${title}</h1>`
  + `<p>${"words ".repeat(80)}</p>${links.map((l) => `<a href="${l}">${l}</a>`).join("")}</body></html>`;

function site(files) {
  return async (url) => {
    const u = new URL(url);
    const entry = files[u.pathname];
    if (entry === undefined) return new Response("missing", { status: 404, headers: { "content-type": "text/html" } });
    const [status, type, body] = entry;
    return new Response(body, { status, headers: { "content-type": type } });
  };
}

const OPTIONS = { maxUrls: 50, concurrency: 1, perHostDelay: 0, checkExternalLinks: false, renderCheck: false };

test("an analysis that throws ends the crawl instead of hanging it", async () => {
  const crawler = new SeoCrawler({ ...OPTIONS, respectRobots: false, discoverSitemaps: false, fetch: site({ "/": [200, "text/html", page("Home")] }) });
  crawler._renderSample = async () => { throw new Error("simulated analysis failure"); };
  await assert.rejects(crawler.start("https://example.com/"), /simulated analysis failure/);
});

test("a stopped crawl has no checkpoint to offer", async () => {
  const crawler = new SeoCrawler({ ...OPTIONS, respectRobots: false, discoverSitemaps: false, fetch: site({ "/": [200, "text/html", page("Home", ["/a"])] }) });
  const run = crawler.start("https://example.com/");
  crawler.stop();
  await run;
  assert.equal(crawler.snapshot(), null, "an empty frontier would resume as a finished crawl");
});

test("without a canonical tag a page is its own canonical, whatever its <base href>", async () => {
  const head = '<base href="/"><meta name="description" content="Same description on every page">';
  const crawler = new SeoCrawler({
    ...OPTIONS,
    respectRobots: false,
    discoverSitemaps: false,
    fetch: site({
      "/": [200, "text/html", page("Same", ["/a/", "/b/"], head)],
      "/a/": [200, "text/html", page("Same", [], head)],
      "/b/": [200, "text/html", page("Same", [], head)],
    }),
  });
  const summary = await crawler.start("https://example.com/");
  const page2 = summary.results.find((r) => r.url === "https://example.com/a/");
  assert.equal(page2.canonical, "https://example.com/a/");
  assert.ok(summary.findings.some((f) => f.ruleId === "title-duplicate" || f.id === "title-duplicate"));
});

test("a robots.txt outage is not reported as the site blocking its pages", async () => {
  const crawler = new SeoCrawler({
    ...OPTIONS,
    maxRetries: 0,
    discoverSitemaps: false,
    fetch: site({ "/robots.txt": [503, "text/plain", "down"], "/": [200, "text/html", page("Home")] }),
  });
  const summary = await crawler.start("https://example.com/");
  const home = summary.results.find((r) => r.url === "https://example.com/");
  assert.equal(home.robotsUnavailable, true);
  assert.equal(home.indexabilityReason, "robots.txt unavailable");
  assert.ok(!summary.findings.some((f) => (f.ruleId || f.id) === "robots-blocked"));
});

test("a seed that moves to a host without robots.txt drops the old host's rules and sitemaps", async () => {
  const files = {
    "old.test": {
      "/robots.txt": [200, "text/plain", "User-agent: *\nDisallow: /blog\nSitemap: https://old.test/sitemap.xml\n"],
    },
    "new.test": {
      "/": [200, "text/html", page("Home", ["/blog/post"])],
      "/blog/post": [200, "text/html", page("Post")],
    },
  };
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "old.test" && u.pathname === "/") {
      return new Response("", { status: 301, headers: { location: "https://new.test/" } });
    }
    return site(files[u.hostname] || {})(url);
  };
  const crawler = new SeoCrawler({ ...OPTIONS, discoverSitemaps: true, fetch });
  const summary = await crawler.start("https://old.test/");
  const post = summary.results.find((r) => r.url === "https://new.test/blog/post");
  assert.equal(post?.status, 200, "old.test's Disallow: /blog applied to new.test");
  assert.equal(summary.robotsStatus, "Not found (404)");
});

test("a CDATA sitemap entry is crawled at its real address", async () => {
  const crawler = new SeoCrawler({
    ...OPTIONS,
    discoverSitemaps: true,
    fetch: site({
      "/robots.txt": [200, "text/plain", "User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml\n"],
      "/sitemap.xml": [200, "application/xml", '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc><![CDATA[https://example.com/listed]]></loc></url></urlset>'],
      "/": [200, "text/html", page("Home")],
      "/listed": [200, "text/html", page("Listed")],
    }),
  });
  const summary = await crawler.start("https://example.com/");
  assert.ok(summary.results.some((r) => r.url === "https://example.com/listed"));
  assert.ok(!summary.results.some((r) => r.url.includes("CDATA")));
});
