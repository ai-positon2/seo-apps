const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings } = require("../analyzer");

const H = "https://example.com";
const page = (path, extra = {}) => ({
  url: `${H}${path}`, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: `A reasonable title for ${path} in the fixture`, titleCount: 1, titleLength: 40,
  metaDescription: "A description long enough to pass the meta length checks without any trouble.",
  metaLength: 90, viewport: "width=device-width", h1Count: 1, h1: `H1 ${path}`, words: 400,
  canonical: `${H}${path}`, hreflangs: [], robots: "", indexability: "Indexable", depth: 1, hash: path,
  htmlLang: "en", responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [], openGraphInvalidUrls: [],
  ...extra,
});
const alt = (lang, path) => ({ lang, url: `${H}${path}` });
const run = (results) => buildFindings({ results, linkEdges: [], startUrl: `${H}/`, sitemapsChecked: false }).findings;
const on = (findings, ruleId) => findings.filter((f) => f.ruleId === ruleId);

test("one language pointing at two pages is a conflict; a set without x-default is noted", () => {
  const findings = run([
    page("/", { hreflangs: [alt("en", "/"), alt("de", "/de"), alt("de", "/de-2")] }),
    page("/de", { htmlLang: "de", hreflangs: [alt("en", "/"), alt("de", "/de"), alt("x-default", "/")] }),
    page("/de-2", { htmlLang: "de", hreflangs: [alt("en", "/"), alt("de", "/de-2"), alt("x-default", "/")] }),
  ]);
  const conflict = on(findings, "hreflang-conflict");
  assert.deepEqual(conflict.map((f) => f.url), [`${H}/`]);
  assert.match(conflict[0].detail, /hreflang="de" points at 2 different URLs/);
  assert.deepEqual(on(findings, "hreflang-x-default-missing").map((f) => f.url), [`${H}/`]);
});

test("hreflang to a broken, redirected, noindex or non-canonical page", () => {
  const set = [alt("en", "/"), alt("de", "/de"), alt("fr", "/fr"), alt("es", "/es"), alt("it", "/it"), alt("x-default", "/")];
  const findings = run([
    page("/", { hreflangs: set }),
    page("/de", { status: 404, statusText: "Not Found", indexability: "Non-indexable", hreflangs: [] }),
    page("/fr", { status: 301, statusText: "Moved Permanently", redirectUrl: `${H}/fr/`, contentType: "", hreflangs: [] }),
    page("/fr/", { hreflangs: set }),
    page("/es", { robots: "noindex", indexability: "Non-indexable", hreflangs: set }),
    page("/it", { canonical: `${H}/`, hreflangs: set }),
  ]);
  const invalid = on(findings, "hreflang-target-invalid").filter((f) => f.url === `${H}/`);
  const byTarget = new Map(invalid.map((f) => [new URL(f.targetUrl).pathname, f.detail]));
  assert.match(byTarget.get("/de"), /HTTP 404/);
  assert.match(byTarget.get("/fr"), /redirects/);
  assert.match(byTarget.get("/es"), /noindex/);
  assert.match(byTarget.get("/it"), /canonical/);
  // The target's problem is the finding; "does not link back" would blame the wrong page.
  assert.ok(!on(findings, "hreflang-missing-return").some((f) => f.url === `${H}/` && /\/(de|fr)$/.test(f.targetUrl)));
});

test("script subtags are valid hreflang codes", () => {
  const findings = run([page("/", { hreflangs: [alt("zh-hant", "/"), alt("zh-hant-tw", "/tw"), alt("x-default", "/")] }), page("/tw", { hreflangs: [alt("zh-hant", "/"), alt("zh-hant-tw", "/tw"), alt("x-default", "/")] })]);
  assert.deepEqual(on(findings, "hreflang-invalid-code"), []);
});

test("a page with no <html lang> is noted", () => {
  const findings = run([page("/", { htmlLang: "" }), page("/b"), page("/old-row", { htmlLang: undefined })]);
  assert.deepEqual(on(findings, "html-lang-missing").map((f) => f.url), [`${H}/`], "only where the crawler saw no lang, not where it did not look");
});
