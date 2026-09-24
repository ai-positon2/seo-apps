const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { buildFindings } = require("../analyzer");
const { SeoCrawler } = require("../crawler");

const H = "https://example.com";
const page = (path, extra = {}) => ({
  url: `${H}${path}`, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: `A reasonable title for ${path} in the fixture`, titleCount: 1, titleLength: 40,
  metaDescription: "A description long enough to pass the meta length checks without any trouble.",
  metaLength: 90, viewport: "width=device-width", h1Count: 1, h1: `H1 ${path}`, words: 400,
  canonical: `${H}${path}`, hreflangs: [], robots: "", indexability: "Indexable", depth: 1, hash: path,
  htmlLang: "en", charsetDeclared: true, doctypeDeclared: true, decodedSize: 20_000, contentEncoding: "gzip",
  anchorCount: 40, responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [], openGraphInvalidUrls: [],
  ...extra,
});
const on = (results, ruleId) =>
  buildFindings({ results: [page("/"), ...results], linkEdges: [], startUrl: `${H}/`, sitemapsChecked: false })
    .findings.filter((f) => f.ruleId === ruleId).map((f) => new URL(f.url).pathname + new URL(f.url).search);

test("a title too short to describe the page", () => {
  assert.deepEqual(on([page("/a", { title: "Home", titleLength: 4 }), page("/b", { title: "", titleLength: 0 })], "title-short"), ["/a"]);
  assert.deepEqual(on([page("/n", { title: "Home", titleLength: 4, robots: "noindex", indexability: "Non-indexable" })], "title-short"), [], "not on a noindex page");
});

test("HTML over 2 MB, and HTML sent uncompressed", () => {
  assert.deepEqual(on([page("/big", { decodedSize: 2_500_000 }), page("/huge", { decodedSize: 5_000_000, bodyTruncated: true })], "html-too-large"), ["/big", "/huge"]);
  assert.deepEqual(on([
    page("/plain", { contentEncoding: "" }),
    page("/identity", { contentEncoding: "identity" }),
    page("/tiny", { contentEncoding: "", decodedSize: 900 }),
  ], "html-uncompressed"), ["/plain", "/identity"]);
});

test("more than 3,000 links on one page", () => {
  assert.deepEqual(on([page("/links", { anchorCount: 3_200 }), page("/ok", { anchorCount: 2_999 })], "too-many-links"), ["/links"]);
});

test("URL hygiene: over 200 characters, underscores, more than two parameters", () => {
  const long = `/${"a".repeat(210)}`;
  assert.deepEqual(on([page(long)], "url-too-long"), [long]);
  assert.deepEqual(on([page("/my_page"), page("/fine?utm_x=1")], "url-underscore"), ["/my_page"]);
  assert.deepEqual(on([page("/f?a=1&b=2&c=3"), page("/g?a=1&b=2")], "url-too-many-parameters"), ["/f?a=1&b=2&c=3"]);
});

test("charset and doctype, when the crawler read the page and found neither", () => {
  assert.deepEqual(on([page("/nc", { charsetDeclared: false }), page("/old", { charsetDeclared: undefined })], "charset-missing"), ["/nc"]);
  assert.deepEqual(on([page("/nd", { doctypeDeclared: false })], "doctype-missing"), ["/nd"]);
});

test("the crawler records charset and doctype as served", async (t) => {
  const server = http.createServer((request, response) => {
    const withHeaderCharset = request.url === "/header";
    response.setHeader("Content-Type", withHeaderCharset ? "text/html; charset=utf-8" : "text/html");
    if (request.url === "/") {
      response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hygiene fixture home page</title></head><body><a href="/bare">Bare</a><a href="/header">Header</a></body></html>');
    } else if (request.url === "/bare") {
      response.end("<html><head><title>Hygiene fixture bare page</title></head><body>No doctype, no charset</body></html>");
    } else {
      response.end("<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\"><html><head><title>Hygiene fixture header page</title></head><body>Charset in the header</body></html>");
    }
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const summary = await new SeoCrawler({
    maxUrls: 10, concurrency: 1, respectRobots: false, discoverSitemaps: false, crawlAssets: false,
    checkExternalLinks: false, timeout: 5_000, perHostDelay: 0,
  }).start(`http://127.0.0.1:${server.address().port}/`);
  const at = (path) => summary.results.find((r) => new URL(r.url).pathname === path);
  assert.deepEqual([at("/").charsetDeclared, at("/").doctypeDeclared], [true, true]);
  assert.deepEqual([at("/bare").charsetDeclared, at("/bare").doctypeDeclared], [false, false]);
  assert.deepEqual([at("/header").charsetDeclared, at("/header").doctypeDeclared], [true, true]);
});
