const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyRedirectLocation,
  isRedirectStatus,
} = require("../http-redirect");

test("matches only the redirect statuses defined by Fetch", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    assert.equal(isRedirectStatus(status), true, String(status));
  }
  for (const status of [200, 201, 300, 304, 305, 306, 400, 404, 500]) {
    assert.equal(isRedirectStatus(status), false, String(status));
  }
});

test("classifies Fetch redirect Location outcomes without collapsing their evidence", () => {
  const base = "https://example.com/from";

  assert.deepEqual(
    classifyRedirectLocation({
      status: 200,
      headerPresent: true,
      rawValue: "/ignored",
      responseUrl: base,
    }),
    {
      kind: "not-redirect",
      headerPresent: true,
      raw: "/ignored",
      url: "",
      scheme: "",
    },
  );

  assert.equal(
    classifyRedirectLocation({
      status: 302,
      headerPresent: false,
      responseUrl: base,
    }).kind,
    "missing",
  );

  const empty = classifyRedirectLocation({
    status: 303,
    headerPresent: true,
    rawValue: "",
    responseUrl: base,
  });
  assert.equal(empty.kind, "valid");
  assert.equal(empty.url, base);

  assert.equal(
    classifyRedirectLocation({
      status: 308,
      headerPresent: true,
      rawValue: "http://[invalid",
      responseUrl: base,
    }).kind,
    "malformed",
  );

  const nonHttp = classifyRedirectLocation({
    status: 307,
    headerPresent: true,
    rawValue: "mailto:ops@example.com",
    responseUrl: base,
  });
  assert.equal(nonHttp.kind, "non-http");
  assert.equal(nonHttp.scheme, "mailto");
  assert.equal(nonHttp.url, "mailto:ops@example.com");

  const valid = classifyRedirectLocation({
    status: 301,
    headerPresent: true,
    rawValue: "../final#fragment",
    responseUrl: base,
  });
  assert.equal(valid.kind, "valid");
  assert.equal(valid.url, "https://example.com/final");
});
