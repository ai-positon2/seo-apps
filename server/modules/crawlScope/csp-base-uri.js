"use strict";

const { isIP } = require("node:net");

function splitPolicies(value) {
  return String(value || "")
    .split(",")
    .map((policy) => policy.trim())
    .filter(Boolean);
}

function baseUriDirective(policy) {
  const seen = new Set();
  for (const serializedDirective of String(policy || "").split(";")) {
    const normalized = serializedDirective.trim();
    if (!normalized || !/^[\x00-\x7F]*$/.test(normalized)) continue;
    const [rawName, ...values] = normalized.split(/\s+/);
    const name = rawName.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === "base-uri") {
      return {
        serialized: [rawName, ...values].join(" "),
        sources: values,
      };
    }
  }
  return null;
}

function restrictionsFromPolicyList(value, sourceLabel) {
  const policies = splitPolicies(value);
  return policies.flatMap((policy, index) => {
    const directive = baseUriDirective(policy);
    return directive
      ? [
          {
            ...directive,
            source: sourceLabel(index, policies.length),
          },
        ]
      : [];
  });
}

function normalizedProtocol(value) {
  return String(value || "").replace(/:$/, "").toLowerCase();
}

function schemeMatches(sourceScheme, candidateScheme) {
  const source = normalizedProtocol(sourceScheme);
  const candidate = normalizedProtocol(candidateScheme);
  if (source === candidate) return true;
  if (source === "http" && candidate === "https") return true;
  if (
    source === "ws" &&
    ["wss", "http", "https"].includes(candidate)
  ) {
    return true;
  }
  if (source === "wss" && candidate === "https") return true;
  return false;
}

function defaultPort(protocol) {
  switch (normalizedProtocol(protocol)) {
    case "http":
    case "ws":
      return "80";
    case "https":
    case "wss":
      return "443";
    case "ftp":
      return "21";
    default:
      return "";
  }
}

function normalizeHost(host) {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return String(host || "").toLowerCase();
  }
}

function parseHostSource(source) {
  let remainder = source;
  let scheme = "";
  const schemeMarker = remainder.indexOf("://");
  if (schemeMarker >= 0) {
    scheme = remainder.slice(0, schemeMarker);
    if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return null;
    remainder = remainder.slice(schemeMarker + 3);
  }

  const pathIndex = remainder.indexOf("/");
  const authority = pathIndex >= 0 ? remainder.slice(0, pathIndex) : remainder;
  const path = pathIndex >= 0 ? remainder.slice(pathIndex) : "";
  if (!authority || authority.includes("@")) return null;

  let host = authority;
  let port = "";
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket < 0) return null;
    host = authority.slice(0, closingBracket + 1);
    const trailing = authority.slice(closingBracket + 1);
    if (trailing) {
      if (!trailing.startsWith(":")) return null;
      port = trailing.slice(1);
    }
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
  }

  if (!host || (port && port !== "*" && !/^\d+$/.test(port))) return null;
  return { scheme, host, port, path };
}

function portMatches(expression, candidate, documentUrl) {
  if (expression.port === "*") return true;
  if (!expression.port) return candidate.port === "";

  const candidatePort = candidate.port || defaultPort(candidate.protocol);
  if (expression.port === candidatePort) return true;

  const expressionScheme = expression.scheme || documentUrl.protocol;
  return (
    expression.port === defaultPort(expressionScheme) &&
    candidatePort === defaultPort(candidate.protocol) &&
    schemeMatches(expressionScheme, candidate.protocol)
  );
}

function pathMatches(sourcePath, candidatePath) {
  if (!sourcePath) return true;
  const exact = !sourcePath.endsWith("/");
  const expected = sourcePath.split("/");
  const actual = candidatePath.split("/");
  if (expected.length > actual.length) return false;
  if (exact && expected.length !== actual.length) return false;
  if (!exact) expected.pop();

  return expected.every((piece, index) => {
    let expectedPiece = piece;
    let actualPiece = actual[index];
    try {
      expectedPiece = decodeURIComponent(expectedPiece);
    } catch {
      // Compare the literal segment when percent-decoding fails.
    }
    try {
      actualPiece = decodeURIComponent(actualPiece);
    } catch {
      // Compare the literal segment when percent-decoding fails.
    }
    return expectedPiece === actualPiece;
  });
}

function hostSourceMatches(source, candidate, documentUrl) {
  const expression = parseHostSource(source);
  if (!expression) return false;

  const sourceScheme = expression.scheme || documentUrl.protocol;
  if (!schemeMatches(sourceScheme, candidate.protocol)) return false;

  const candidateHost = candidate.hostname.toLowerCase();
  if (isIP(candidateHost.replace(/^\[|\]$/g, ""))) return false;
  if (expression.host !== "*") {
    if (expression.host.startsWith("*.")) {
      const suffix = `.${normalizeHost(expression.host.slice(2))}`;
      if (!candidateHost.endsWith(suffix)) return false;
    } else if (normalizeHost(expression.host) !== candidateHost) {
      return false;
    }
  }

  return (
    portMatches(expression, candidate, documentUrl) &&
    pathMatches(expression.path, candidate.pathname)
  );
}

function sameOriginOrUpgrade(candidate, documentUrl) {
  if (candidate.origin === documentUrl.origin) return true;
  if (candidate.hostname !== documentUrl.hostname) return false;

  const portsMatch =
    (candidate.port || defaultPort(candidate.protocol)) ===
      (documentUrl.port || defaultPort(documentUrl.protocol)) ||
    (!candidate.port && !documentUrl.port);
  if (!portsMatch) return false;

  const candidateScheme = normalizedProtocol(candidate.protocol);
  const documentScheme = normalizedProtocol(documentUrl.protocol);
  return (
    ["https", "wss"].includes(candidateScheme) ||
    (documentScheme === "http" && ["http", "ws"].includes(candidateScheme))
  );
}

function sourceMatches(source, candidate, documentUrl) {
  const normalized = String(source || "").trim();
  const keyword = normalized.toLowerCase();
  if (!normalized || keyword === "'none'") return false;
  if (keyword === "'self'") return sameOriginOrUpgrade(candidate, documentUrl);
  if (normalized === "*") {
    return (
      ["http:", "https:"].includes(candidate.protocol) ||
      normalizedProtocol(documentUrl.protocol) ===
        normalizedProtocol(candidate.protocol)
    );
  }

  const schemeSource = normalized.match(/^([a-z][a-z0-9+.-]*):$/i);
  if (schemeSource) return schemeMatches(schemeSource[1], candidate.protocol);
  if (normalized.startsWith("'")) return false;
  return hostSourceMatches(normalized, candidate, documentUrl);
}

function restrictionAllows(restriction, candidate, documentUrl) {
  const sources = restriction.sources;
  if (!sources.length) return false;
  if (
    sources.length === 1 &&
    sources[0].toLowerCase() === "'none'"
  ) {
    return false;
  }
  return sources.some((source) => sourceMatches(source, candidate, documentUrl));
}

function evaluateBaseUri({
  candidateUrl,
  documentUrl,
  headerPolicy = "",
  metaPolicies = [],
}) {
  let candidate;
  let document;
  try {
    candidate = new URL(candidateUrl);
    document = new URL(documentUrl);
  } catch {
    return {
      allowed: false,
      evidence: [],
      blockedBy: null,
    };
  }

  const restrictions = [
    ...restrictionsFromPolicyList(
      headerPolicy,
      (index) => `header policy ${index + 1}`,
    ),
    ...metaPolicies.flatMap((policy, index) => {
      const directive = baseUriDirective(policy);
      return directive
        ? [
            {
              ...directive,
              source: `meta policy ${index + 1}`,
            },
          ]
        : [];
    }),
  ];
  const blockedBy =
    restrictions.find(
      (restriction) => !restrictionAllows(restriction, candidate, document),
    ) || null;

  return {
    allowed: !blockedBy,
    evidence: restrictions.map(
      (restriction) => `${restriction.source}: ${restriction.serialized}`,
    ),
    blockedBy,
  };
}

module.exports = {
  evaluateBaseUri,
  sourceMatches,
};
