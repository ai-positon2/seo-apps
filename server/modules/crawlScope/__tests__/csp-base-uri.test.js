const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateBaseUri, sourceMatches } = require("../csp-base-uri");

const documentUrl = "https://app.test/page";

function decision(candidateUrl, headerPolicy, metaPolicies = []) {
  return evaluateBaseUri({
    candidateUrl,
    documentUrl,
    headerPolicy,
    metaPolicies,
  });
}

test("CSP base-uri ignores default-src and intersects explicit policies", () => {
  assert.equal(
    decision("https://cdn.test/assets/", "default-src 'none'").allowed,
    true,
    "base-uri does not inherit default-src",
  );

  const intersected = decision(
    "https://cdn.test/assets/",
    "base-uri https:, base-uri 'self'",
  );
  assert.equal(intersected.allowed, false);
  assert.equal(intersected.blockedBy.source, "header policy 2");
  assert.deepEqual(intersected.evidence, [
    "header policy 1: base-uri https:",
    "header policy 2: base-uri 'self'",
  ]);

  assert.equal(
    decision(
      "https://cdn.test/assets/",
      "base-uri https:; base-uri 'none'",
    ).allowed,
    true,
    "the first duplicate directive in a policy wins",
  );
  assert.equal(
    decision("https://cdn.test/assets/", "base-uri 'none' https:").allowed,
    true,
    "'none' has no effect when combined with other sources",
  );
  assert.equal(
    decision("https://cdn.test/assets/", "base-uri").allowed,
    false,
    "an empty source list blocks every candidate",
  );
});

test("CSP base-uri matches self, schemes, hosts, ports, and paths", () => {
  assert.equal(decision("https://app.test/assets/", "base-uri 'self'").allowed, true);
  assert.equal(decision("https://cdn.test/assets/", "base-uri 'self'").allowed, false);
  assert.equal(decision("https://cdn.test/assets/", "base-uri https:").allowed, true);
  assert.equal(
    decision(
      "https://static.cdn.test/assets/",
      "base-uri https://*.cdn.test/assets/",
    ).allowed,
    true,
  );
  assert.equal(
    decision(
      "https://cdn.test/assets/",
      "base-uri https://*.cdn.test/assets/",
    ).allowed,
    false,
    "a leading wildcard matches subdomains, not the bare host",
  );
  assert.equal(
    decision(
      "https://cdn.test/assets/campaign/",
      "base-uri http://cdn.test:80/assets/",
    ).allowed,
    true,
    "insecure schemes and default ports match their secure upgrade",
  );
  assert.equal(
    decision(
      "https://cdn.test/other/",
      "base-uri https://cdn.test/assets/",
    ).allowed,
    false,
  );
  assert.equal(
    decision(
      "https://cdn.test/a/b",
      "base-uri https://cdn.test/a%2Fb",
    ).allowed,
    false,
    "percent-decoding does not merge path segments",
  );
});

test("CSP self matching permits only the specification's safe upgrades", () => {
  assert.equal(
    sourceMatches(
      "'self'",
      new URL("https://app.test/secure/"),
      new URL("http://app.test/page"),
    ),
    true,
  );
  assert.equal(
    sourceMatches(
      "'self'",
      new URL("https://app.test:8443/secure/"),
      new URL("http://app.test:8080/page"),
    ),
    false,
  );
  assert.equal(
    sourceMatches(
      "'self'",
      new URL("https://app.test:8080/secure/"),
      new URL("http://app.test:8080/page"),
    ),
    true,
  );
  assert.equal(
    sourceMatches(
      "*",
      new URL("wss://app.test/socket"),
      new URL("ws://app.test/page"),
    ),
    false,
    "the wildcard requires an exact protected scheme for non-HTTP(S) URLs",
  );
  assert.equal(
    sourceMatches(
      "https://127.0.0.1",
      new URL("https://127.0.0.1/base"),
      new URL("https://app.test/page"),
    ),
    false,
    "host-source matching does not treat IP literals as domains",
  );
});

test("each eligible CSP meta policy further restricts base URLs", () => {
  const result = decision(
    "https://cdn.test/assets/",
    "base-uri https:",
    ["default-src 'none'", "base-uri 'self'"],
  );
  assert.equal(result.allowed, false);
  assert.equal(result.blockedBy.source, "meta policy 2");
  assert.deepEqual(result.evidence, [
    "header policy 1: base-uri https:",
    "meta policy 2: base-uri 'self'",
  ]);
});
