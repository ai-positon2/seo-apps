"use strict";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

function isRedirectStatus(status) {
  return REDIRECT_STATUSES.has(Number(status));
}

// Header values arrive decoded as latin1, one character per byte. A server
// that writes a Location as raw UTF-8 (nginx `return 301 $uri`, on a
// non-ASCII slug) then reads "/café" as "/cafÃ©", and the crawler requested
// "/caf%C3%83%C2%A9", a page that does not exist. Browsers, and undici when it
// follows redirects itself, read those bytes as UTF-8; so does this, whenever
// they form valid UTF-8.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function utf8HeaderValue(value) {
  const text = String(value ?? "");
  if (!/[\x80-\xff]/.test(text) || /[^\x00-\xff]/.test(text)) return text;
  try {
    return utf8Decoder.decode(Buffer.from(text, "latin1"));
  } catch {
    return text;
  }
}

function classifyRedirectLocation({
  status,
  headerPresent = false,
  rawValue = "",
  responseUrl = "",
}) {
  const raw = utf8HeaderValue(rawValue);
  const evidence = {
    kind: "not-redirect",
    headerPresent: Boolean(headerPresent),
    raw,
    url: "",
    scheme: "",
  };

  if (!isRedirectStatus(status)) return evidence;
  if (!headerPresent) return { ...evidence, kind: "missing" };

  let parsed;
  try {
    parsed = new URL(raw, responseUrl);
  } catch {
    return { ...evidence, kind: "malformed" };
  }

  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!HTTP_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    return {
      ...evidence,
      kind: "non-http",
      url: parsed.href,
      scheme,
    };
  }

  parsed.hash = "";
  return {
    ...evidence,
    kind: "valid",
    url: parsed.href,
    scheme,
  };
}

function redirectLocationIssueDetail(result = {}) {
  switch (result.redirectLocationIssue) {
    case "missing":
      return `HTTP ${result.status} response has no Location header, so it does not advertise a destination.`;
    case "malformed":
      return `HTTP ${result.status} response has a malformed Location header that cannot be resolved as a URL.`;
    case "non-http": {
      const scheme = result.redirectLocationScheme
        ? `${result.redirectLocationScheme}:`
        : "non-HTTP(S)";
      return `HTTP ${result.status} response points to the unsupported ${scheme} scheme, which a Fetch redirect cannot follow.`;
    }
    default:
      return "";
  }
}

module.exports = {
  classifyRedirectLocation,
  isRedirectStatus,
  redirectLocationIssueDetail,
  utf8HeaderValue,
};
