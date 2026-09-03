const test = require("node:test");
const assert = require("node:assert/strict");
const { pickPageSpeedSample } = require("../run/manager");

function page(url, overrides = {}) {
  return {
    url, isAsset: false, scope: "Internal", status: 200,
    contentType: "text/html", depth: 1, inlinks: 0, pageCategory: "Other",
    ...overrides,
  };
}

test("pickPageSpeedSample: with unlimited size, picks every eligible page exactly once", () => {
  const home = page("https://example.com/", { depth: 0, pageCategory: "Home" });
  const p1 = page("https://example.com/products/a", { pageCategory: "Product", inlinks: 5 });
  const p2 = page("https://example.com/products/b", { pageCategory: "Product", inlinks: 1 });
  const blog = page("https://example.com/blog/x", { pageCategory: "Blog / Article", inlinks: 2 });
  const asset = page("https://example.com/logo.png", { isAsset: true, contentType: "image/png" });
  const broken = page("https://example.com/gone", { status: 404 });
  const external = page("https://other.com/", { scope: "External" });

  const picked = pickPageSpeedSample(
    { results: [home, p1, p2, blog, asset, broken, external] },
    Infinity,
  );

  assert.deepEqual(new Set(picked), new Set([home.url, p1.url, p2.url, blog.url]));
  assert.equal(picked.length, 4); // no duplicates, no assets/broken/external
});

test("pickPageSpeedSample: with a small size, covers every template before doubling up on one", () => {
  const home = page("https://example.com/", { depth: 0, pageCategory: "Home" });
  // Three Product pages (most-linked first) but only two other templates.
  const prod1 = page("https://example.com/products/a", { pageCategory: "Product", inlinks: 10 });
  const prod2 = page("https://example.com/products/b", { pageCategory: "Product", inlinks: 5 });
  const prod3 = page("https://example.com/products/c", { pageCategory: "Product", inlinks: 1 });
  const blog = page("https://example.com/blog/x", { pageCategory: "Blog / Article", inlinks: 1 });

  const picked = pickPageSpeedSample(
    { results: [home, prod1, prod2, prod3, blog] },
    3,
  );

  // Budget of 3: seed + one page per template (Product's top-linked, Blog's
  // only one) fills it exactly — prod2/prod3 must NOT be in before blog is.
  assert.equal(picked.length, 3);
  assert.ok(picked.includes(home.url));
  assert.ok(picked.includes(prod1.url), "the most-linked Product page represents that template");
  assert.ok(picked.includes(blog.url), "every template gets a slot before a second Product page does");
  assert.ok(!picked.includes(prod2.url));
  assert.ok(!picked.includes(prod3.url));
});

test("pickPageSpeedSample: returns nothing when there are no eligible pages", () => {
  const asset = page("https://example.com/logo.png", { isAsset: true });
  assert.deepEqual(pickPageSpeedSample({ results: [asset] }, Infinity), []);
  assert.deepEqual(pickPageSpeedSample({ results: [] }, Infinity), []);
  assert.deepEqual(pickPageSpeedSample({}, Infinity), []);
});
