const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMetaRefresh } = require("../meta-refresh");

const documentUrl = "https://example.test/page";
const baseUrl = "https://cdn.test/root/";

test("parses reload-only declarative refresh values", () => {
  assert.deepEqual(parseMetaRefresh("300", documentUrl, baseUrl), {
    raw: "300",
    delay: 300,
    delayRaw: "300",
    delayOverflow: false,
    explicitUrl: false,
    targetRaw: "",
    url: documentUrl,
    isReload: true,
  });
  assert.deepEqual(
    parseMetaRefresh("  .5 ;  ", documentUrl, baseUrl),
    {
      raw: "  .5 ;  ",
      delay: 0,
      delayRaw: ".5",
      delayOverflow: false,
      explicitUrl: false,
      targetRaw: "",
      url: documentUrl,
      isReload: true,
    },
    "a fractional-looking delay uses its absent integer portion (zero)",
  );
  assert.equal(parseMetaRefresh("5;", documentUrl, baseUrl).isReload, true);
});

test("parses URL prefixes, separators, quotes, and integer delay portions", () => {
  assert.deepEqual(
    parseMetaRefresh("1.9; URL = '../next?step=2' ignored", documentUrl, baseUrl),
    {
      raw: "1.9; URL = '../next?step=2' ignored",
      delay: 1,
      delayRaw: "1.9",
      delayOverflow: false,
      explicitUrl: true,
      targetRaw: "../next?step=2",
      url: "https://cdn.test/next?step=2",
      isReload: false,
    },
  );
  assert.equal(
    parseMetaRefresh("5, /comma-target", documentUrl, baseUrl).url,
    "https://cdn.test/comma-target",
  );
  assert.equal(
    parseMetaRefresh("5 whitespace-target", documentUrl, baseUrl).url,
    "https://cdn.test/root/whitespace-target",
  );
  assert.equal(
    parseMetaRefresh('0; "quoted-target"', documentUrl, baseUrl).url,
    "https://cdn.test/root/quoted-target",
  );
  assert.equal(
    parseMetaRefresh("0; URL=", documentUrl, baseUrl).url,
    baseUrl,
    "an explicit empty URL resolves against the document base",
  );
});

test("rejects values for which the browser schedules no refresh", () => {
  for (const input of [
    "",
    "soon; url=/target",
    "1x; url=/target",
    "\u00a01; url=/target",
    "0; url=http://[invalid",
    "0; url=javascript:location='/target'",
  ]) {
    assert.equal(parseMetaRefresh(input, documentUrl, baseUrl), null, input);
  }
});

test("preserves explicit non-HTTP targets and bounds huge delays safely", () => {
  const mail = parseMetaRefresh(
    "0; URL=mailto:team@example.test",
    documentUrl,
    baseUrl,
  );
  assert.equal(mail.url, "mailto:team@example.test");

  const huge = parseMetaRefresh(
    `999999999999999999999999999; ${documentUrl}`,
    documentUrl,
    baseUrl,
  );
  assert.equal(huge.delay, Number.MAX_SAFE_INTEGER);
  assert.equal(huge.delayOverflow, true);
  assert.equal(huge.delayRaw, "999999999999999999999999999");
});
