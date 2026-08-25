"use strict";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

function isRedirectStatus(status) {
  return REDIRECT_STATUSES.has(Number(status));
}

function classifyRedirectLocation({
  status,
  headerPresent = false,
  rawValue = "",
  responseUrl = "",
}) {
  const raw = String(rawValue ?? "");
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
};
