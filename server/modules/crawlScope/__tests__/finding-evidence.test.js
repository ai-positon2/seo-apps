const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFindings } = require("../analyzer");

const H = "https://example.com";
const page = (path, extra = {}) => ({
  url: `${H}${path}`, scope: "Internal", status: 200, statusText: "OK", contentType: "text/html",
  title: `Title for ${path} on the evidence fixture`, titleCount: 1, titleLength: 40,
  metaDescription: "A description long enough to pass the meta length checks without trouble, really.",
  metaLength: 90, viewport: "width=device-width", h1Count: 1, h1: `H1 ${path}`, words: 400,
  canonical: `${H}${path}`, hreflangs: [], robots: "", indexability: "Indexable", depth: 1, hash: path,
  responseTime: 100, strictTransportSecurity: "max-age=1", openGraphMissing: [], openGraphInvalidUrls: [],
  ...extra,
});
const run = (results, linkEdges) => buildFindings({ results, linkEdges, startUrl: `${H}/`, sitemapsChecked: false });

// A broken-link row said "Not Found" and nothing else: not which link on the
// page, which is what someone has to find in the editor to fix it.
test("a broken internal link names the link text and the full status", () => {
  const { findings } = run(
    [page("/"), page("/gone", { status: 404, statusText: "Not Found", indexability: "Non-indexable" })],
    [{ sourceUrl: `${H}/`, targetUrl: `${H}/gone`, internal: true, anchorText: "Our old pricing" }],
  );
  const broken = findings.find((f) => f.ruleId === "broken-internal-links");
  assert.equal(broken.detail, "HTTP 404 Not Found");
  assert.equal(broken.detectedValue, "Link text: “Our old pricing”");
});

test("an image link with no text says so", () => {
  const { findings } = run(
    [page("/"), page("/gone", { status: 410, statusText: "", indexability: "Non-indexable" })],
    [{ sourceUrl: `${H}/`, targetUrl: `${H}/gone`, internal: true, anchorText: "" }],
  );
  const broken = findings.find((f) => f.ruleId === "broken-internal-links");
  assert.equal(broken.detail, "HTTP 410");
  assert.equal(broken.detectedValue, "(no visible link text)");
});

// A redirect-chain row showed "2" — the hop count — and never the hops.
test("a redirect chain lists every hop", () => {
  const { findings } = run(
    [
      page("/"),
      page("/old", { status: 301, statusText: "Moved Permanently", redirectUrl: `${H}/mid`, indexability: "Non-indexable" }),
      page("/mid", { status: 301, statusText: "Moved Permanently", redirectUrl: `${H}/new`, indexability: "Non-indexable" }),
      page("/new"),
    ],
    [{ sourceUrl: `${H}/`, targetUrl: `${H}/old`, internal: true, anchorText: "Old" }],
  );
  const chain = findings.find((f) => f.ruleId === "redirect-chain" && f.url === `${H}/old`);
  assert.equal(chain.detail, "2 redirect hops");
  assert.equal(chain.detectedValue, `${H}/old -> ${H}/mid -> ${H}/new`);
});
