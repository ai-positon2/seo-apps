// Regression test for D3 (P2), found by the Phase A audit of www.iana.org (2026-09-05).
// SVG <title> chart labels were counted as document titles.
// See .audit-runs/20260905/www.iana.org/findings.md

// Defects found by the Phase A audit of www.iana.org (2026-09-05).
// See .audit-runs/20260905/www.iana.org/findings.md — defect ids referenced below.
//
// Fixtures reproduce the CONDITION, not the artifact that carried it: D1's real
// evidence is a 14MB page, and the condition is "a body larger than the parse
// cap", which a synthesised string expresses in one line.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");

function listen(server, host = "0.0.0.0") {
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve(server.address().port));
  });
}

// ── D3 (P2) ────────────────────────────────────────────────────────────────
// documentElements() filters template contents but not <svg>. iana.org's
// /performance has one document <title> and 48 SVG chart labels; the crawler
// recorded titleCount 49 and title-multiple fired.
test("D3: <title> inside <svg> is not counted as a document title", async (t) => {
  const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><html><head><title>Performance</title>" +
        '<meta name="description" content="A sufficiently long meta description for this fixture page to pass extraction.">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        "</head><body><h1>Performance</h1>" +
        '<svg viewBox="0 0 10 10"><title>August 2025: 100%</title><rect/></svg>' +
        '<svg viewBox="0 0 10 10"><title>September 2025: 98%</title><rect/></svg>' +
        "<p>" + "Content ".repeat(220) + "</p></body></html>",
    );
  });
  t.after(() => server.close());
  const port = await listen(server);

  const crawler = new SeoCrawler({
    maxUrls: 1, concurrency: 1, respectRobots: false, discoverSitemaps: false,
    checkExternalLinks: false, crawlAssets: false, timeout: 5_000,
  });
  const summary = await crawler.start(`http://127.0.0.1:${port}/`);
  const page = summary.results[0];

  assert.equal(page.titleCount, 1, "two SVG <title> elements are not document titles");
  assert.equal(
    summary.findings.filter((f) => f.ruleId === "title-multiple").length,
    0,
    "title-multiple must not fire on a page with exactly one document title",
  );
});
