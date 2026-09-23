const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler, parseRobots } = require("../crawler");
const { parseCrawlRequest } = require("../shared/options");

// robots.txt was read only as CrawlScope. A Disallow addressed to Googlebot
// was invisible to "Pages blocked from crawling", and a site that blocks every
// crawler but Googlebot was reported as blocking itself from Google.
const ROBOTS = [
  "User-agent: *",
  "Disallow: /private",
  "",
  "User-agent: Googlebot",
  "Disallow: /no-google",
  "",
  "User-agent: CrawlScope",
  "Disallow: /no-crawlscope",
  "Disallow: /private",
].join("\n");

function site(seen = []) {
  return http.createServer((request, response) => {
    seen.push({ url: request.url, agent: request.headers["user-agent"] });
    if (request.url === "/robots.txt") {
      response.setHeader("Content-Type", "text/plain");
      response.end(ROBOTS);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head><title>Googlebot robots fixture ${request.url}</title></head><body>
      <h1>${request.url}</h1>
      <a href="/private">Private</a><a href="/no-google">No Google</a><a href="/no-crawlscope">No CrawlScope</a><a href="/ok">OK</a>
    </body></html>`);
  });
}
async function crawl(t, options = {}) {
  const seen = [];
  const server = site(seen);
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const summary = await new SeoCrawler({
    maxUrls: 20, concurrency: 1, respectRobots: true, discoverSitemaps: false, crawlAssets: false,
    checkExternalLinks: false, timeout: 5_000, perHostDelay: 0, ...options,
  }).start(`http://127.0.0.1:${server.address().port}/`);
  return { summary, seen };
}

test("Googlebot's group is read on its own, exactly", () => {
  assert.deepEqual(parseRobots(ROBOTS, "googlebot", { exact: true }).rules, [{ type: "disallow", pattern: "/no-google" }]);
  // Googlebot-News is not Googlebot.
  const news = "User-agent: Googlebot-News\nDisallow: /\n\nUser-agent: *\nDisallow: /tmp";
  assert.deepEqual(parseRobots(news, "googlebot", { exact: true }).rules, [{ type: "disallow", pattern: "/tmp" }]);
});

test("a URL robots.txt closes to Googlebot is reported, although the crawl could fetch it", async (t) => {
  const { summary, seen } = await crawl(t);
  const fetched = seen.map((s) => s.url);
  assert.ok(fetched.includes("/no-google"), "CrawlScope may fetch it, so it did");
  assert.ok(!fetched.includes("/no-crawlscope") && !fetched.includes("/private"), "and obeyed its own rules");
  const blocked = summary.findings.filter((f) => f.ruleId === "robots-blocked");
  const byPath = new Map(blocked.map((f) => [new URL(f.url).pathname, f]));
  assert.match(byPath.get("/no-google").detail, /Googlebot/);
  assert.ok(!byPath.has("/no-crawlscope"), "closed to CrawlScope only: not blocked from Google");
  assert.ok(!byPath.has("/private"), "Googlebot's own group allows /private");
  assert.ok(!byPath.has("/ok"));
  const unaudited = summary.coverage.pagesNotAudited.find((entry) => /Googlebot/.test(entry.reason));
  assert.equal(unaudited.count, 2);
});

test("a smartphone crawl sends a mobile user agent and still obeys CrawlScope's rules", async (t) => {
  const { options } = parseCrawlRequest({ url: "https://example.com/", options: { userAgentProfile: "mobile" } });
  assert.equal(options.userAgentProfile, "mobile");
  assert.equal(parseCrawlRequest({ url: "https://example.com/", options: { userAgentProfile: "evil" } }).options.userAgentProfile, "desktop");
  const { seen } = await crawl(t, { userAgentProfile: "mobile" });
  const page = seen.find((s) => s.url === "/");
  assert.match(page.agent, /Mobile/);
  assert.match(page.agent, /CrawlScope\/\d/);
  assert.ok(!seen.some((s) => s.url === "/no-crawlscope"), "robots.txt's CrawlScope group still applies");
});
