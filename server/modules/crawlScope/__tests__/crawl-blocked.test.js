const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings } = require("../analyzer");

const H = "https://example.com";
const page = (path, extra = {}) => ({
  url: `${H}${path}`, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: `Title for ${path}`, titleCount: 1, titleLength: 30, metaDescription: `Description for ${path} `.repeat(4),
  metaLength: 120, viewport: "width=device-width", h1Count: 1, h1: `H1 ${path}`, words: 400, textHtmlRatio: 0.3,
  canonical: `${H}${path}`, hreflangs: [], robots: "", indexability: "Indexable", depth: 1, hash: path,
  responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [], openGraphInvalidUrls: [],
  ...extra,
});
const linksFromHome = (paths) => paths.map((p) => ({ sourceUrl: `${H}/`, targetUrl: `${H}${p}`, internal: true, anchorText: p }));
const run = (results, linkEdges = []) =>
  buildFindings({ results, linkEdges, startUrl: `${H}/`, sitemapsChecked: false });

// When bot protection or a rate limiter refuses the crawler, every refused URL
// became a "page returning 4XX" and every link to one a "broken internal link":
// hundreds of findings describing the block, not the site.
test("a crawl the site mostly refused is reported once, as blocked", () => {
  const refused = ["/a", "/b", "/c", "/d", "/e"];
  const { findings } = run(
    [page("/"), ...refused.map((p) => page(p, { status: 403, statusText: "Forbidden", indexability: "Non-indexable" }))],
    linksFromHome(refused),
  );
  const blocked = findings.filter((f) => f.ruleId === "crawl-blocked");
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].detail, /5 of 6/);
  assert.ok(!findings.some((f) => f.ruleId === "broken-internal-links"), "a refusal is not a broken link");
  const pageErrors = findings.filter((f) => f.ruleId === "page-4xx");
  assert.equal(pageErrors.length, 5, "the refused URLs are still listed");
  assert.ok(pageErrors.every((f) => /refused the crawler/i.test(f.detail)));
});

test("a refused start page is enough", () => {
  const { findings } = run([page("/", { status: 429, statusText: "Too Many Requests", indexability: "Non-indexable" })]);
  assert.ok(findings.some((f) => f.ruleId === "crawl-blocked"));
});

test("bot-check pages served with 200 count as blocked and are not audited as content", () => {
  const challenge = { title: "Just a moment...", titleLength: 16, h1: "Checking your browser", words: 12, hash: "challenge" };
  const paths = ["/a", "/b", "/c", "/d"];
  const { findings } = run([page("/"), ...paths.map((p) => page(p, challenge))], linksFromHome(paths));
  assert.ok(findings.some((f) => f.ruleId === "crawl-blocked"));
  const onChallenge = findings.filter((f) => paths.some((p) => f.url === `${H}${p}`));
  assert.deepEqual(onChallenge.map((f) => f.ruleId), [], "a bot-check page is not the site's content");
});

test("a few restricted pages on a crawl that otherwise worked are not a block", () => {
  const open = Array.from({ length: 18 }, (_, i) => `/p${i}`);
  const { findings } = run(
    [page("/"), ...open.map((p) => page(p)), page("/members", { status: 403, statusText: "Forbidden", indexability: "Non-indexable" })],
    linksFromHome([...open, "/members"]),
  );
  assert.ok(!findings.some((f) => f.ruleId === "crawl-blocked"));
  assert.ok(findings.some((f) => f.ruleId === "broken-internal-links" && f.targetUrl === `${H}/members`));
});

test("a 429 is a refusal on any site: rate limiting, not a broken page", () => {
  const open = Array.from({ length: 10 }, (_, i) => `/p${i}`);
  const { findings, results } = run(
    [page("/"), ...open.map((p) => page(p)), page("/busy", { status: 429, statusText: "Too Many Requests", indexability: "Non-indexable" })],
    linksFromHome([...open, "/busy"]),
  );
  const blocked = findings.find((f) => f.ruleId === "crawl-blocked");
  assert.ok(blocked, "being rate-limited is reported");
  assert.match(blocked.detail, /1 of 12 pages/);
  assert.match(blocked.detail, /HTTP 429 Too Many Requests ×1/);
  assert.ok(!findings.some((f) => f.ruleId === "broken-internal-links"));
  const busy = findings.find((f) => f.ruleId === "page-4xx");
  assert.match(busy.detail, /rate-limited the crawler/);
  assert.equal(results.find((r) => r.url === `${H}/busy`).crawlRefused, true);
  assert.equal(results.find((r) => r.url === `${H}/p0`).crawlRefused, undefined);
});

test("refused pages are listed page by page, never collapsed into a template defect", () => {
  const refused = Array.from({ length: 10 }, (_, i) => `/r${i}`);
  const { findings } = run(
    [page("/"), page("/ok"), ...refused.map((p) => page(p, { status: 403, statusText: "Forbidden", indexability: "Non-indexable" }))],
    linksFromHome(["/ok", ...refused]),
  );
  const pageErrors = findings.filter((f) => f.ruleId === "page-4xx");
  assert.equal(pageErrors.length, 10);
  assert.ok(pageErrors.every((f) => f.scope === "page" && f.crawlRefused === true));
});

test("a bot check on the start page is not reported as a JavaScript-rendered site", () => {
  const { findings } = buildFindings({
    results: [page("/", { title: "Just a moment...", h1: "", words: 8, hash: "challenge" })],
    linkEdges: [],
    startUrl: `${H}/`,
    sitemapsChecked: false,
    siteDiagnostics: {
      renderingIssue: "The entry page returned no links and almost no text.",
      missingPageProbe: { url: `${H}/crawlscope-missing-page-check-1`, status: 200, title: "Just a moment...", words: 8, hash: "challenge" },
    },
  });
  const ids = findings.map((f) => f.ruleId);
  assert.ok(ids.includes("crawl-blocked"));
  assert.ok(!ids.includes("javascript-rendered-site"), "the refusal explains the empty page");
  assert.ok(!ids.includes("soft-404-site"), "a bot check says nothing about how missing URLs are answered");
});

test("a refused redirect target: the start URL redirects to a page that answers 403", () => {
  const { findings } = run([
    page("/", { status: 301, statusText: "Moved Permanently", redirectUrl: `${H}/en/`, contentType: "", indexability: "Non-indexable" }),
    page("/en/", { status: 403, statusText: "Forbidden", indexability: "Non-indexable" }),
  ]);
  const ids = findings.map((f) => f.ruleId);
  assert.ok(ids.includes("crawl-blocked"));
  assert.ok(!ids.includes("redirect-terminal-failure"), "the redirect was fine; the crawler was refused at its destination");
});
