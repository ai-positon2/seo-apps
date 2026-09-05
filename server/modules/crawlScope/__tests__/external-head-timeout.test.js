// Regression test for D2 (P2), found by the Phase A audit of www.iana.org (2026-09-05).
// A host that hangs on HEAD had its live links reported as broken.
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

// ── D2 (P2) ────────────────────────────────────────────────────────────────
// External URLs are probed with HEAD; the GET fallback triggers only on
// 405/501. icann.org hangs on HEAD and answers 301 to GET, so 966 findings
// called live links broken.
test("D2: an external host that hangs on HEAD is re-probed with GET", async (t) => {
  let headSeen = 0;
  let getSeen = 0;
  const target = http.createServer((req, res) => {
    if (req.method === "HEAD") { headSeen += 1; return; }   // hang, exactly like Cloudflare
    getSeen += 1;
    res.statusCode = 301;
    res.setHeader("Location", "https://example.com/moved");
    res.end();
  });
  t.after(() => target.close());
  const targetPort = await listen(target);

  const origin = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><html><head><title>Origin page with an outbound link</title>" +
        '<meta name="description" content="A sufficiently long meta description for this fixture page to pass extraction.">' +
        "</head><body><h1>Origin</h1>" +
        `<a href="http://localhost:${targetPort}/policy">Privacy policy</a>` +
        "<p>" + "Content ".repeat(220) + "</p></body></html>",
    );
  });
  t.after(() => origin.close());
  const originPort = await listen(origin);

  const crawler = new SeoCrawler({
    maxUrls: 2, maxExternalUrls: 5, concurrency: 1, respectRobots: false,
    discoverSitemaps: false, checkExternalLinks: true, crawlAssets: false,
    timeout: 1_500, maxRetries: 0,
  });
  const summary = await crawler.start(`http://127.0.0.1:${originPort}/`);

  const ext = summary.results.find((r) => r.scope === "External");
  assert.ok(ext, "the outbound link should have been checked");
  assert.ok(headSeen > 0, "the crawler should have tried HEAD first");
  assert.ok(getSeen > 0, "a HEAD that times out must be retried with GET");
  assert.equal(ext.status, 301, `expected the GET status, got ${ext.status} (${ext.statusText})`);
  assert.equal(
    summary.findings.filter((f) => f.ruleId === "broken-external-link").length,
    0,
    "a link that answers 301 to GET is not broken",
  );
});
