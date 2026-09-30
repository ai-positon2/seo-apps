const test = require("node:test");
const assert = require("node:assert/strict");
const { cssResourceReferences } = require("../css-resource-parser");

test("CSS resource parsing decodes URL forms and preserves source evidence", () => {
  const references = cssResourceReferences(`@import "https://cdn.test/base.css";
.hero {
  background: URL(https\\3a //cdn.test/escaped.png);
  mask-image: url("https://cdn.test/mask.svg");
}
@font-face { src: src('https://cdn.test/font.woff2'); }`);

  assert.deepEqual(
    references.map(({ raw, kind, line }) => ({ raw, kind, line })),
    [
      {
        raw: "https://cdn.test/base.css",
        kind: "@import",
        line: 1,
      },
      {
        raw: "https://cdn.test/escaped.png",
        kind: "url()",
        line: 3,
      },
      {
        raw: "https://cdn.test/mask.svg",
        kind: "url()",
        line: 4,
      },
      {
        raw: "https://cdn.test/font.woff2",
        kind: "src()",
        line: 6,
      },
    ],
  );
  assert.match(references[1].context, /background: URL/);
});

test("CSS resource parsing excludes inert syntax and scales across large stylesheets", () => {
  const inert = `/* url(http://ignored.test/comment.png) */
.copy::before { content: "url(http://ignored.test/string.png)"; }
@supports (background: url(http://ignored.test/supports.png)) {}
@media screen { @import "http://ignored.test/nested.css"; }
@namespace svg url(http://www.w3.org/2000/svg);
:root { --unused: url(http://ignored.test/custom.png); }
.local { filter: url(#shadow); }`;
  assert.deepEqual(cssResourceReferences(inert), []);
  assert.deepEqual(
    cssResourceReferences(
      `background: url(https://cdn.test/active.png);
       @import "http://ignored.test/attribute-import.css";`,
      { allowImports: false },
    ).map(({ raw }) => raw),
    ["https://cdn.test/active.png"],
  );

  const largeCss = `${".rule{color:#123}".repeat(20_000)}
.final{background:url(https://cdn.test/final.png)}`;
  assert.deepEqual(
    cssResourceReferences(largeCss).map(({ raw }) => raw),
    ["https://cdn.test/final.png"],
  );
});

// Minified CSS is one line. Reading each reference's context from the whole
// line made the work quadratic and kept a copy of the line alive per reference
// — a finance publisher's pages ran a crawl out of memory.
test("a reference's context comes from around it, not from its whole minified line", () => {
  const rules = Array.from(
    { length: 2_000 },
    (_, i) => `.r${i}{color:#123;background:url(https://cdn.test/${i}.png)}`,
  );
  const oneLine = `${".pad{margin:0}".repeat(20_000)}${rules.join("")}`;
  const started = Date.now();
  const references = cssResourceReferences(oneLine);
  const elapsed = Date.now() - started;

  assert.equal(references.length, 2_000);
  assert.ok(elapsed < 2_000, `parsing took ${elapsed}ms`);
  for (const reference of [references[0], references[999], references[1_999]]) {
    assert.ok(reference.context.length <= 182, reference.context.length);
    assert.ok(reference.context.startsWith("…"));
  }
  assert.match(references[999].context, /url\(https:\/\/cdn\.test\/999\.png\)/);
  // Short, multi-line CSS reads exactly as before: the reference's own line.
  const [short] = cssResourceReferences(".a {\n  background: url(x.png);\n}");
  assert.equal(short.context, "background: url(x.png);");
});
