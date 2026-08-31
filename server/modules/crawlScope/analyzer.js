const crypto = require("node:crypto");
const catalog = require("./issue-catalog.json");
const {
  isRedirectStatus,
  redirectLocationIssueDetail,
} = require("./http-redirect");

const catalogById = new Map(catalog.map((definition) => [definition.id, definition]));
const NON_DESCRIPTIVE_LINK_LABELS = new Set([
  "click here",
  "here",
  "read more",
  "learn more",
  "more",
  "link",
  "this",
  "website",
  "view",
  "details",
  "continue",
  "go",
]);
const LINK_ONLY_RESOURCE_RELS = new Set([
  "dns-prefetch",
  "icon",
  "manifest",
  "modulepreload",
  "preconnect",
  "prefetch",
  "preload",
  "stylesheet",
]);
const MIN_GENERIC_EXTERNAL_NOFOLLOW_LINKS = 5;
const MIN_GENERIC_EXTERNAL_NOFOLLOW_RATIO = 0.8;
const MAX_FETCH_REDIRECTS = 20;
const MAX_REDIRECT_TRACE_HOPS = 100;
// ISO 639-1 language, optionally "-" + ISO 3166-1 region, or the special
// "x-default" value. Values are lowercased before this check runs.
const HREFLANG_CODE = /^(x-default|[a-z]{2,3}(-[a-z]{2})?)$/;

function truncateAtWord(text, maxLen) {
  const value = String(text || "").trim();
  if (value.length <= maxLen) return value;
  const slice = value.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  const base = lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${base.trim().replace(/[,;:.\-–—]+$/, "")}…`;
}

// Titles commonly carry a "Page Name | Brand" or "Page Name - Brand" suffix.
// Trimming to the primary segment first keeps the brand off the chopping
// block, so a long title shrinks by dropping boilerplate before it starts
// cutting the part that actually identifies the page.
function primaryTitleSegment(title) {
  return String(title || "")
    .split(/\s*[|–—-]\s*/)[0]
    .trim();
}

function humanizeUrlSlug(url) {
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split("/").filter(Boolean);
    const last = segments.at(-1) || "";
    const words = last
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return words ? words.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "";
  } catch {
    return "";
  }
}

function suggestTitle(title) {
  const trimmed = String(title || "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= 60) return trimmed;
  const primary = primaryTitleSegment(trimmed);
  return primary.length <= 60 ? primary : truncateAtWord(primary, 60);
}

function suggestH1(result) {
  const fromTitle = primaryTitleSegment(result.title);
  if (fromTitle) return fromTitle;
  const fromSlug = humanizeUrlSlug(result.url);
  return fromSlug || "Add a descriptive H1 naming this page's topic.";
}

// There is no editorial content model to draw real copy from, so a "too
// short"/"missing" description gets a mechanical starter draft built from the
// title/URL — meant to be edited, not published as-is. It still saves a
// reviewer from starting on a blank page for hundreds of rows.
function suggestMetaDescription(result) {
  const topic = primaryTitleSegment(result.title) || humanizeUrlSlug(result.url) || "This page";
  const existing = String(result.metaDescription || "").trim();
  if (existing) {
    return truncateAtWord(
      `${existing} Learn more about ${topic.toLowerCase()} — explore the details on this page.`,
      160,
    );
  }
  return truncateAtWord(
    `${topic} — find key details, services, and next steps on this page.`,
    160,
  );
}

function sitemapIncorrectUrlRecommendation({
  result,
  terminalFailure,
  terminalSuitability,
  declarativeRedirect,
}) {
  if (terminalFailure) {
    return `Remove this URL from the sitemap — its redirect path ends at a broken destination (${terminalFailure.detail}). Fix or redirect the destination first, then add back a URL that returns 200.`;
  }
  if (terminalSuitability) {
    return `Update the sitemap entry — this redirect ends at a non-indexable or non-canonical page (${terminalSuitability.detail}). Point the sitemap at the actual indexable canonical URL instead.`;
  }
  if (result.status !== 200) {
    return `Remove this URL from the sitemap. It returns HTTP ${result.status || "no response"} instead of 200, so it should not be listed as canonical, indexable content.`;
  }
  if (declarativeRedirect) {
    return `Replace this sitemap entry with its redirect destination: ${declarativeRedirect}.`;
  }
  if (result.canonical && result.canonical !== result.url) {
    return `Replace this sitemap entry with its canonical URL: ${result.canonical}. Only list the canonical version in the sitemap.`;
  }
  return `Remove this non-indexable URL from the sitemap (${result.indexabilityReason || "not the preferred canonical version"}), or resolve the underlying indexability issue first.`;
}

function findingId(ruleId, url = "", targetUrl = "", detail = "") {
  return crypto
    .createHash("sha1")
    .update(`${ruleId}|${url}|${targetUrl}|${detail}`)
    .digest("hex")
    .slice(0, 16);
}

function isNonDescriptiveLinkLabel(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s.!?…,:;–—→›»↗↘-]+|[\s.!?…,:;–—→›»↗↘-]+$/gu, "")
    .trim();
  return NON_DESCRIPTIVE_LINK_LABELS.has(normalized);
}

function linkRelTokens(edge) {
  return new Set(
    String(edge.rel || "")
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean),
  );
}

function redirectEdge(result) {
  if (!result) return null;
  if (isRedirectStatus(result.status) && result.redirectUrl) {
    return { url: result.redirectUrl, mechanism: "http" };
  }
  const refresh = declarativeRefresh(result);
  return refresh && !refresh.isReload
    ? { url: refresh.url, mechanism: refresh.source }
    : null;
}

function redirectDestination(result) {
  return redirectEdge(result)?.url || "";
}

function redirectTrace(result, resultByUrl) {
  let edge = redirectEdge(result);
  if (!result || !edge) return null;

  const path = [result.url];
  const firstVisit = new Map([[result.url, 0]]);
  let consecutiveHttpRedirects = 0;
  let fetchSegmentStartIndex = 0;

  for (let hops = 1; hops <= MAX_REDIRECT_TRACE_HOPS; hops += 1) {
    if (
      edge.mechanism === "http" &&
      consecutiveHttpRedirects === MAX_FETCH_REDIRECTS
    ) {
      return {
        path,
        hops: hops - 1,
        targetUrl: edge.url,
        loop: false,
        loopStartIndex: -1,
        cycleLength: 0,
        limitReached: true,
        limitPath: path.slice(fetchSegmentStartIndex).concat(edge.url),
        blockedAtUrl: path.at(-1),
        blockedTargetUrl: edge.url,
        traceTruncated: false,
      };
    }

    if (edge.mechanism === "http") {
      consecutiveHttpRedirects += 1;
    } else {
      consecutiveHttpRedirects = 0;
    }

    const next = edge.url;
    path.push(next);
    const target = resultAtUrl(resultByUrl, next);
    const targetIdentity = target?.url || next;
    const loopStartIndex = firstVisit.get(targetIdentity);
    if (loopStartIndex !== undefined) {
      return {
        path,
        hops,
        targetUrl: targetIdentity,
        loop: true,
        loopStartIndex,
        cycleLength: hops - loopStartIndex,
        limitReached: false,
        limitPath: [],
        blockedAtUrl: "",
        blockedTargetUrl: "",
        traceTruncated: false,
      };
    }

    firstVisit.set(targetIdentity, path.length - 1);
    if (edge.mechanism !== "http") {
      fetchSegmentStartIndex = path.length - 1;
    }
    edge = redirectEdge(target);
    if (!edge) {
      return {
        path,
        hops,
        targetUrl: next,
        loop: false,
        loopStartIndex: -1,
        cycleLength: 0,
        limitReached: false,
        limitPath: [],
        blockedAtUrl: "",
        blockedTargetUrl: "",
        traceTruncated: false,
      };
    }
  }

  return {
    path,
    hops: MAX_REDIRECT_TRACE_HOPS,
    targetUrl: path.at(-1),
    loop: false,
    loopStartIndex: -1,
    cycleLength: 0,
    limitReached: false,
    limitPath: [],
    blockedAtUrl: "",
    blockedTargetUrl: "",
    traceTruncated: true,
  };
}

function redirectLoopDetail(trace) {
  if (trace.cycleLength === 1 && trace.loopStartIndex === 0) {
    return "The redirect returns to the same URL after 1 hop, forming a self-loop. No final response is reachable.";
  }
  const leadIn = trace.loopStartIndex
    ? ` after a ${trace.loopStartIndex}-hop lead-in`
    : "";
  const loopType =
    trace.cycleLength === 1 ? "1-URL self-loop" : `${trace.cycleLength}-URL loop`;
  return `The path repeats ${trace.targetUrl} after ${trace.hops} redirect hops, forming a ${loopType}${leadIn}. No final response is reachable.`;
}

function redirectLimitDetail(trace) {
  return `After ${MAX_FETCH_REDIRECTS} consecutive HTTP redirects, ${trace.blockedAtUrl} advertises another redirect to ${trace.blockedTargetUrl}. Fetch returns a network error before following that next hop.`;
}

function redirectLimitEvidence(trace) {
  const followedPath = trace.limitPath.slice(0, -1).join(" -> ");
  return `${followedPath} -[next redirect blocked]-> ${trace.blockedTargetUrl}`;
}

function redirectTerminalFailure(trace, resultByUrl) {
  if (
    !trace ||
    trace.loop ||
    trace.limitReached ||
    trace.traceTruncated
  ) {
    return null;
  }

  const terminal = resultAtUrl(resultByUrl, trace.targetUrl);
  if (
    !terminal ||
    terminal.scope === "External" ||
    terminal.statusText === "Blocked by robots.txt"
  ) {
    return null;
  }

  const pathEvidence = trace.path.join(" -> ");
  if (terminal.redirectLocationIssue) {
    const relationshipDetail = `redirect path ends at ${terminal.url}, whose HTTP ${terminal.status} redirect destination is unusable`;
    return {
      terminal,
      statusCode: terminal.status,
      pathEvidence,
      relationshipDetail,
      detail: `The ${relationshipDetail}. ${redirectLocationIssueDetail(terminal)}`,
      detectedValue: `${pathEvidence}; ${redirectLocationDetectedValue(terminal)}`,
    };
  }

  if (terminal.status >= 400) {
    const responseLabel = `HTTP ${terminal.status}${
      terminal.statusText ? ` ${terminal.statusText}` : ""
    }`;
    const relationshipDetail = `redirect path ends at ${terminal.url} with ${responseLabel}`;
    return {
      terminal,
      statusCode: terminal.status,
      pathEvidence,
      relationshipDetail,
      detail: `The ${relationshipDetail}.`,
      detectedValue: `${pathEvidence}; terminal ${responseLabel}`,
    };
  }

  if (!terminal.status) {
    const failure = terminal.statusText || "no response";
    const relationshipDetail = `redirect path ends at ${terminal.url}, which could not be fetched (${failure})`;
    return {
      terminal,
      statusCode: 0,
      pathEvidence,
      relationshipDetail,
      detail: `The ${relationshipDetail}.`,
      detectedValue: `${pathEvidence}; terminal fetch failed: ${failure}`,
    };
  }

  return null;
}

function redirectTerminalSuitability(trace, resultByUrl) {
  if (
    !trace ||
    trace.loop ||
    trace.limitReached ||
    trace.traceTruncated
  ) {
    return null;
  }

  const terminal = resultAtUrl(resultByUrl, trace.targetUrl);
  const terminalContentType = String(
    terminal?.contentType || "",
  ).toLowerCase();
  if (
    !terminal ||
    terminal.scope === "External" ||
    terminal.status !== 200 ||
    !(
      terminalContentType.includes("text/html") ||
      terminalContentType.includes("xhtml")
    )
  ) {
    return null;
  }

  const robots = String(terminal.robots || "").toLowerCase();
  const isNonIndexable =
    terminal.indexability === "Non-indexable" ||
    robots.includes("noindex") ||
    robots.includes("none");
  const canonicalMismatch =
    Boolean(terminal.canonical) && terminal.canonical !== terminal.url;
  if (!isNonIndexable && !canonicalMismatch) return null;

  const reasons = [];
  const evidence = [];
  if (isNonIndexable) {
    const reason =
      terminal.indexabilityReason ||
      (terminal.robots ? `robots directive: ${terminal.robots}` : "noindex directive");
    reasons.push(`is non-indexable (${reason})`);
    evidence.push(`terminal indexability: Non-indexable (${reason})`);
  }
  if (canonicalMismatch) {
    reasons.push(`declares ${terminal.canonical} as its canonical URL`);
    evidence.push(`terminal canonical: ${terminal.canonical}`);
  }

  const pathEvidence = trace.path.join(" -> ");
  const relationshipDetail = `redirect path ends at ${terminal.url}, which ${reasons.join(" and ")}`;
  return {
    terminal,
    statusCode: terminal.status,
    pathEvidence,
    relationshipDetail,
    detail: `The ${relationshipDetail}.`,
    detectedValue: `${pathEvidence}; ${evidence.join("; ")}`,
    isNonIndexable,
    canonicalMismatch,
  };
}

function declarativeRefresh(result) {
  if (result?.refreshHeaderRaw) {
    return {
      source: "header",
      raw: result.refreshHeaderRaw,
      delay: result.refreshHeaderDelay,
      delayRaw: result.refreshHeaderDelayRaw,
      delayOverflow: result.refreshHeaderDelayOverflow,
      url: result.refreshHeaderUrl,
      isReload: result.refreshHeaderIsReload,
    };
  }
  if (result?.metaRefreshRaw) {
    return {
      source: "meta",
      raw: result.metaRefreshRaw,
      delay: result.metaRefreshDelay,
      delayRaw: result.metaRefreshDelayRaw,
      delayOverflow: result.metaRefreshDelayOverflow,
      url: result.metaRefreshUrl,
      isReload: result.metaRefreshIsReload,
    };
  }
  return null;
}

function declarativeRefreshLabel(refresh) {
  return refresh?.source === "header" ? "HTTP Refresh header" : "Meta refresh";
}

function resultAtUrl(resultByUrl, url) {
  if (resultByUrl.has(url)) return resultByUrl.get(url);
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return resultByUrl.get(parsed.href);
  } catch {
    return undefined;
  }
}

function refreshDelayLabel(refresh) {
  if (refresh.delayOverflow) {
    return `${refresh.delayRaw} seconds`;
  }
  const delay = Number(refresh.delay) || 0;
  return `${delay} ${delay === 1 ? "second" : "seconds"}`;
}

function redirectLocationDetectedValue(result) {
  return result.redirectLocationIssue === "missing"
    ? `HTTP ${result.status}; Location header missing`
    : `HTTP ${result.status}; Location: ${result.locationHeaderRaw || ""}`;
}

function httpLinkEvidence(edge, target) {
  const status = Number(target?.status) || 0;
  const redirectUrl = String(target?.redirectUrl || "");
  const isRedirect = isRedirectStatus(status);
  const directlyUpgradesToHttps =
    isRedirect && redirectUrl.startsWith("https:");

  // A checked top-level navigation that immediately upgrades is not an
  // HTTP-only destination. Explicit downloads remain reportable because
  // secure-context download handling considers insecure URLs in the response
  // chain, even when the final response is HTTPS.
  if (directlyUpgradesToHttps && !edge.download) return null;

  if (directlyUpgradesToHttps) {
    return {
      statusCode: status,
      detail:
        "The explicit download starts with HTTP before redirecting to HTTPS; point it directly to the HTTPS URL.",
      detectedValue: `download; HTTP ${status} -> ${redirectUrl}`,
    };
  }

  if (!target) {
    return {
      statusCode: 0,
      detail: edge.download
        ? "The explicit download target was not fetched in this crawl, so HTTPS support is unverified."
        : "The destination was not fetched in this crawl, so HTTPS support is unverified.",
      detectedValue: edge.download
        ? "download; HTTP target not fetched"
        : "HTTP target not fetched",
    };
  }

  if (!status) {
    const failure = target.statusText || "fetch failed";
    return {
      statusCode: 0,
      detail: edge.download
        ? `The explicit download's HTTP check failed (${failure}), so HTTPS support is unverified.`
        : `The HTTP destination check failed (${failure}), so HTTPS support is unverified.`,
      detectedValue: edge.download
        ? `download; HTTP check failed: ${failure}`
        : `HTTP check failed: ${failure}`,
    };
  }

  if (isRedirect && redirectUrl) {
    return {
      statusCode: status,
      detail: `The HTTP destination redirects to another non-HTTPS URL: ${redirectUrl}`,
      detectedValue: `${edge.download ? "download; " : ""}HTTP ${status} -> ${redirectUrl}`,
    };
  }

  if (isRedirect && target.redirectLocationIssue) {
    return {
      statusCode: status,
      detail: `${redirectLocationIssueDetail(target)} A direct HTTPS upgrade could not be followed.`,
      detectedValue: `${edge.download ? "download; " : ""}${redirectLocationDetectedValue(target)}`,
    };
  }

  return {
    statusCode: status,
    detail: `The checked HTTP destination returned ${status} without a direct HTTPS redirect.`,
    detectedValue: `${edge.download ? "download; " : ""}HTTP ${status} without HTTPS upgrade`,
  };
}

function appendDocumentBaseEvidence(evidence, edge) {
  if (!edge.baseHrefRaw || !edge.documentBaseUrl) return evidence;
  const raw = String(edge.baseHrefRaw).replaceAll('"', "'");
  const baseEvidence = `<base href="${raw}"> -> ${edge.documentBaseUrl}`;
  return {
    ...evidence,
    detail: `${evidence.detail} The relative reference resolves through ${baseEvidence}; fix the base URL once if the affected relative links should remain secure.`,
    detectedValue: `${evidence.detectedValue}; ${baseEvidence}`,
  };
}

function describeHeading(level, text) {
  const normalized = String(text || "").trim();
  return normalized
    ? `H${level} "${normalized.slice(0, 120)}${normalized.length > 120 ? "…" : ""}"`
    : `empty H${level}`;
}

function isPreferredIndexablePage(result) {
  return (
    result.status === 200 &&
    result.indexability === "Indexable" &&
    (!result.canonical || result.canonical === result.url)
  );
}

function isReciprocalHreflangGroup(group) {
  const groupUrls = new Set(group.map((result) => result.url));
  return group.every((result) => {
    const alternateUrls = new Set(
      (result.hreflangs || []).map((entry) => entry.url),
    );
    return [...groupUrls].every((url) => alternateUrls.has(url));
  });
}

function buildFindings({
  results,
  linkEdges = [],
  resourceEdges = [],
  sitemapMembership = {},
  siteDiagnostics = {},
  startUrl = "",
  // Whether sitemap discovery actually ran this crawl. Without this, a page
  // absent from `sitemapMembership` is indistinguishable from "we never
  // checked sitemaps at all" — firing sitemap-missing-indexable in the latter
  // case is a false positive, not a finding.
  sitemapsChecked = true,
  // True when the crawl hit its URL limit before exhausting discovered links.
  // Inlink counts become a partial sample at that point, not the real site,
  // so inlink-count-based checks (single-inlink, orphan-page) would otherwise
  // report false confidence on a crawl that never saw the whole site.
  crawlTruncated = false,
}) {
  const findings = [];
  // Dedupe ids in a Set rather than scanning `findings` on every add(). The scan
  // was O(n²): measured 3.6s at 50k findings versus 11ms here, all of it on the
  // worker's event loop at the end of every crawl.
  const findingIds = new Set();
  const resultByUrl = new Map(results.map((result) => [result.url, result]));
  const internalResults = results.filter((result) => result.scope !== "External");
  const htmlResults = internalResults.filter((result) =>
    result.contentType?.includes("text/html"),
  );
  const redirectTraces = new Map(
    internalResults
      .map((result) => [result.url, redirectTrace(result, resultByUrl)])
      .filter(([, trace]) => trace),
  );
  const redirectTerminalFailures = new Map(
    [...redirectTraces]
      .map(([url, trace]) => [
        url,
        redirectTerminalFailure(trace, resultByUrl),
      ])
      .filter(([, failure]) => failure),
  );
  const redirectTerminalSuitabilityIssues = new Map(
    [...redirectTraces]
      .filter(([url]) => !redirectTerminalFailures.has(url))
      .map(([url, trace]) => [
        url,
        redirectTerminalSuitability(trace, resultByUrl),
      ])
      .filter(([, issue]) => issue),
  );

  const add = (ruleId, source = {}, extra = {}) => {
    const definition = catalogById.get(ruleId);
    if (!definition) return;
    const url = extra.url || source.url || startUrl;
    const targetUrl = extra.targetUrl || "";
    const detail = extra.detail || "";
    const id = findingId(ruleId, url, targetUrl, detail);
    if (findingIds.has(id)) return;
    findingIds.add(id);
    findings.push({
      id,
      ruleId,
      title: definition.title,
      description: definition.description,
      recommendation: extra.recommendation || definition.recommendation,
      severity: definition.severity,
      priority: definition.priority,
      category: definition.category,
      detection: definition.detection,
      url,
      targetUrl,
      detail,
      statusCode: extra.statusCode ?? source.status ?? 0,
      detectedValue: extra.detectedValue ?? "",
      recommendedValue: extra.recommendedValue ?? "",
      reviewStatus: "Needs review",
      reviewerNotes: "",
      automated: definition.detection === "Automatic",
    });
  };

  for (const result of internalResults) {
    const isHtml = result.contentType?.includes("text/html");
    const inSitemaps = sitemapMembership[result.url] || [];
    const robots = (result.robots || "").toLowerCase();
    const hasNoindex = robots.includes("noindex") || robots.includes("none");
    const hasNofollow = robots.includes("nofollow") || robots.includes("none");

    if (result.status >= 500 && result.status < 600) {
      add("page-5xx", result, {
        detail: result.statusText,
        detectedValue: `HTTP ${result.status}${
          result.statusText ? ` ${result.statusText}` : ""
        }`,
      });
    } else if (result.status >= 400 && result.status < 500) {
      add("page-4xx", result);
    }
    if (!result.status && result.statusText !== "Blocked by robots.txt") {
      add("crawl-failure", result, { detail: result.statusText });
      if (/altname|certificate.*name|cert.*hostname/i.test(result.statusText)) {
        add("ssl-certificate-name", result, { detail: result.statusText });
      }
      if (/sni|unrecognized.?name/i.test(result.statusText)) {
        add("sni-unsupported", result, { detail: result.statusText });
      }
    }

    if (
      result.isAsset &&
      result.status >= 400 &&
      (result.contentType?.includes("javascript") || /\.m?js(?:$|\?)/i.test(result.url))
    ) {
      add("broken-javascript", result);
    }
    if (result.statusText === "Blocked by robots.txt") {
      add(result.isAsset ? "blocked-resource" : "robots-blocked", result);
    }

    if (inSitemaps.length) {
      const refresh = declarativeRefresh(result);
      const declarativeRedirect = redirectDestination(result);
      const terminalFailure = redirectTerminalFailures.get(result.url);
      const terminalSuitability =
        redirectTerminalSuitabilityIssues.get(result.url);
      if (
        result.status !== 200 ||
        result.indexability !== "Indexable" ||
        (result.canonical && result.canonical !== result.url) ||
        declarativeRedirect
      ) {
        add("sitemap-incorrect-url", result, {
          detail:
            terminalFailure
              ? `${terminalFailure.relationshipDetail}. Path: ${terminalFailure.pathEvidence}`
              : terminalSuitability
                ? `${terminalSuitability.relationshipDetail}. Path: ${terminalSuitability.pathEvidence}`
              : result.status !== 200
                ? `HTTP ${result.status || "unreachable"}`
                : declarativeRedirect
                  ? `${declarativeRefreshLabel(refresh)} to ${declarativeRedirect}`
                  : result.indexabilityReason || "Non-canonical URL",
          recommendation: sitemapIncorrectUrlRecommendation({
            result,
            terminalFailure,
            terminalSuitability,
            declarativeRedirect,
          }),
        });
      }
      if (isRedirectStatus(result.status)) add("sitemap-redirect", result);
      if (inSitemaps.length > 1) {
        add("sitemap-duplicate", result, {
          detail: `Listed in ${inSitemaps.length} sitemaps`,
          detectedValue: inSitemaps.join(", "),
        });
      }
    } else if (
      sitemapsChecked &&
      isHtml &&
      result.status === 200 &&
      result.indexability === "Indexable" &&
      !redirectDestination(result)
    ) {
      add("sitemap-missing-indexable", result);
    }

    if (hasNoindex && hasNofollow) add("noindex-nofollow", result);
    else if (hasNoindex) add("noindex", result);
    else if (hasNofollow) add("nofollow-page", result);

    if (
      !crawlTruncated &&
      isHtml &&
      result.status === 200 &&
      result.url !== startUrl &&
      result.fromSitemap &&
      result.inlinks === 0
    ) {
      add("orphan-page", result);
    }
    if (
      !crawlTruncated &&
      isHtml &&
      result.status === 200 &&
      result.url !== startUrl &&
      result.inlinks === 1
    ) {
      add("single-inlink", result);
    }
    if (isHtml && result.depth > 3) {
      add("deep-page", result, { detectedValue: result.depth });
    }

    if ([301, 308].includes(result.status)) add("permanent-redirect", result);
    if ([302, 303, 307].includes(result.status)) add("temporary-redirect", result);
    if (result.redirectLocationIssue) {
      add("redirect-location-invalid", result, {
        detail: redirectLocationIssueDetail(result),
        detectedValue: redirectLocationDetectedValue(result),
      });
    }

    const trace = redirectTraces.get(result.url);
    const terminalFailure = redirectTerminalFailures.get(result.url);
    const terminalSuitability =
      redirectTerminalSuitabilityIssues.get(result.url);
    if (trace?.loop) {
      add("redirect-loop", result, {
        detail: redirectLoopDetail(trace),
        targetUrl: trace.targetUrl,
        detectedValue: trace.path.join(" -> "),
      });
    } else if (trace?.limitReached) {
      add("redirect-limit-exceeded", result, {
        detail: redirectLimitDetail(trace),
        targetUrl: trace.blockedTargetUrl,
        detectedValue: redirectLimitEvidence(trace),
      });
    } else if (terminalFailure) {
      add("redirect-terminal-failure", result, {
        detail: terminalFailure.detail,
        targetUrl: terminalFailure.terminal.url,
        statusCode: terminalFailure.statusCode,
        detectedValue: terminalFailure.detectedValue,
      });
    } else if (terminalSuitability) {
      add("redirect-terminal-indexability", result, {
        detail: terminalSuitability.detail,
        targetUrl: terminalSuitability.terminal.url,
        statusCode: terminalSuitability.statusCode,
        detectedValue: terminalSuitability.detectedValue,
      });
    } else if (trace?.hops > 1) {
      add("redirect-chain", result, {
        detail: trace.traceTruncated
          ? `At least ${trace.hops} redirect-like hops; trace stopped at the safety bound`
          : `${trace.hops} redirect hops`,
        targetUrl: trace.targetUrl,
        detectedValue: trace.hops,
      });
    }

    // status < 300 (not < 400): a 3xx response is a redirect stub with no real
    // page content — evaluating it for title/meta/word-count/etc. produces
    // false positives on every redirected URL (confirmed via calibration:
    // position2.com's sitemap has ~55 double-slash URLs that 308-redirect,
    // and every one of them was being flagged for "missing meta description"
    // and "low word count" despite having no actual page to evaluate).
    if (isHtml && result.status >= 200 && result.status < 300) {
      const refresh = declarativeRefresh(result);
      if (refresh) {
        const raw = String(refresh.raw).replaceAll('"', "'");
        const delay = refreshDelayLabel(refresh);
        const ruleId = refresh.source === "header" ? "http-refresh" : "meta-refresh";
        const evidence =
          refresh.source === "header"
            ? `Refresh: ${raw}`
            : `<meta http-equiv="refresh" content="${raw}">`;
        if (refresh.isReload) {
          add(ruleId, result, {
            detail: `Reloads the current page after ${delay}; no destination URL was supplied.`,
            detectedValue: `${evidence}; reload after ${delay}`,
          });
        } else {
          const target = resultAtUrl(resultByUrl, refresh.url);
          const targetStatus = target
            ? ` The crawled destination returned HTTP ${target.status || "no response"}.`
            : "";
          add(ruleId, result, {
            targetUrl: refresh.url,
            detail: `Redirects after ${delay} to ${refresh.url}.${targetStatus}`,
            detectedValue: `${evidence}; ${delay} -> ${refresh.url}`,
          });
        }
      }
      if (result.baseHrefRaw && result.documentBaseFallbackReason) {
        const raw = String(result.baseHrefRaw).replaceAll('"', "'");
        add("base-url-ignored", result, {
          detail: result.documentBaseFallbackReason,
          detectedValue: `<base href="${raw}">; ${result.documentBaseFallbackReason}`,
        });
      }
      if (result.titleCount > 1) {
        add("title-multiple", result, { detectedValue: result.titleCount });
      }
      if (result.titleLength > 60) {
        add("title-long", result, {
          detail: `${result.titleLength} characters`,
          detectedValue: result.title,
          recommendedValue: suggestTitle(result.title),
        });
      }
      if (!result.metaDescription) {
        add("meta-missing", result, {
          recommendedValue: suggestMetaDescription(result),
        });
      } else if (result.metaLength > 160) {
        add("meta-long", result, {
          detail: `${result.metaLength} characters`,
          detectedValue: result.metaDescription,
          recommendedValue: truncateAtWord(result.metaDescription, 155),
        });
      } else if (result.metaLength < 70) {
        add("meta-short", result, {
          detail: `${result.metaLength} characters`,
          detectedValue: result.metaDescription,
          recommendedValue: suggestMetaDescription(result),
        });
      }
      if (!result.h1Count) {
        add("h1-missing", result, { recommendedValue: suggestH1(result) });
      } else if (result.h1Count > 1) {
        add("h1-multiple", result, { detectedValue: result.h1Count });
      }
      if (!result.viewport) {
        add("viewport-missing", result);
      } else if (!/width\s*=\s*device-width/i.test(result.viewport)) {
        add("viewport-not-responsive", result, { detectedValue: result.viewport });
      }
      if (
        result.h1 &&
        result.title &&
        result.h1.split("|")[0].trim().toLowerCase() === result.title.trim().toLowerCase()
      ) {
        add("h1-title-duplicate", result);
      }
      for (const issue of result.headingHierarchyIssues || []) {
        add("heading-hierarchy-skipped", result, {
          detail: `${describeHeading(issue.fromLevel, issue.fromText)} is followed by ${describeHeading(issue.toLevel, issue.toText)}`,
          detectedValue: `H${issue.fromLevel} → H${issue.toLevel}`,
        });
      }
      // Ratio alone is unreliable on modern JS-framework pages: React/Next/Vue
      // etc. ship hydration data and chunk manifests inline in the HTML, so a
      // page with genuinely substantial content can still sit at a 3-5% ratio.
      // Requiring low word count too means this only fires when the page is
      // actually thin, not just framework-heavy.
      if (
        result.textHtmlRatio > 0 &&
        result.textHtmlRatio <= 0.1 &&
        result.words > 0 &&
        result.words < 200
      ) {
        add("low-text-html-ratio", result, {
          detectedValue: Number(result.textHtmlRatio.toFixed(3)),
        });
      }
      if (result.words > 0 && result.words < 200) {
        add("low-word-count", result, { detectedValue: result.words });
      }
      const openGraphMissing = result.openGraphMissing || [];
      const openGraphInvalidUrls = result.openGraphInvalidUrls || [];
      if (openGraphMissing.length) {
        add("open-graph-incomplete", result, {
          detail: `Missing required properties: ${openGraphMissing.join(", ")}`,
          detectedValue: openGraphMissing.map((property) => `• ${property}`).join("\n"),
        });
      }
      for (const invalid of openGraphInvalidUrls) {
        add("open-graph-url-invalid", result, {
          detail: `${invalid.property} is not an absolute HTTP(S) URL`,
          detectedValue: invalid.value,
        });
      }
      if (result.openGraphImageAltMissing) {
        const imageProperty = result.openGraphImageProperty || "og:image";
        const imageValue = result.openGraphImageRaw || result.openGraphImageUrl;
        add("open-graph-image-alt-missing", result, {
          targetUrl: result.openGraphImageUrl,
          detail: `og:image:alt is missing or empty for ${imageProperty}`,
          detectedValue: `${imageProperty}: ${imageValue}`,
        });
      }
      if (
        !openGraphMissing.length &&
        !openGraphInvalidUrls.length &&
        result.openGraphDescriptionMissing
      ) {
        add("open-graph-description-missing", result, {
          detail: "Optional but recommended property is missing: og:description",
          detectedValue: "og:description",
        });
      }
      if (result.ogUrl && result.canonical && result.ogUrl !== result.canonical) {
        const rawOgUrl = result.ogUrlRaw || result.ogUrl;
        add("open-graph-canonical", result, {
          targetUrl: result.canonical,
          detail: `og:url: ${rawOgUrl}; canonical: ${result.canonical}`,
          detectedValue: rawOgUrl,
        });
      }
      for (const schemaError of result.schemaErrors || []) {
        add("schema-error", result, {
          detail: schemaError,
          detectedValue: schemaError,
        });
      }
      if (result.responseTime > 1000) {
        add("slow-page", result, {
          detail: `${result.responseTime} ms`,
          detectedValue: Math.round(result.responseTime) / 1000,
        });
      }
    }

    if (result.isAsset && result.status === 200) {
      const isScriptOrStyle =
        /javascript|css/.test(result.contentType || "") ||
        /\.(?:m?js|css)(?:$|\?)/i.test(result.url);
      if (isScriptOrStyle && !result.cacheable) add("asset-uncached", result);
      if (isScriptOrStyle && result.unminified) add("asset-unminified", result);
      if (isScriptOrStyle && !result.contentEncoding) add("asset-uncompressed", result);
      if (
        (result.contentType || "").startsWith("image/") &&
        result.size > 200 * 1024
      ) {
        add("image-oversized", result, {
          detectedValue: result.size,
        });
      }
    }
  }

  for (const result of internalResults) {
    if (result.status !== 200 || !result.hreflangs?.length) continue;

    for (const entry of result.hreflangs) {
      if (!HREFLANG_CODE.test(entry.lang)) {
        add("hreflang-invalid-code", result, {
          targetUrl: entry.url,
          detectedValue: entry.lang,
        });
      }
    }

    const hasSelfReference = result.hreflangs.some((entry) => entry.url === result.url);
    if (!hasSelfReference) add("hreflang-missing-self", result);

    for (const entry of result.hreflangs) {
      if (entry.url === result.url) continue;
      const target = resultByUrl.get(entry.url);
      // Can't verify a return tag on a page we never crawled — that's a
      // separate, weaker signal than a confirmed one-way link, so it's left
      // alone rather than guessed at.
      if (!target) continue;
      const pointsBack = (target.hreflangs || []).some((t) => t.url === result.url);
      if (!pointsBack) {
        add("hreflang-missing-return", result, {
          targetUrl: entry.url,
          detail: `${entry.url} does not link back to this page via hreflang`,
        });
      }
    }
  }

  for (const result of internalResults) {
    if (result.status !== 200 || !result.canonical || result.canonical === result.url) {
      continue;
    }
    const target = resultByUrl.get(result.canonical);
    // Can't verify a canonical pointing at a URL the crawl never reached —
    // same principle as the hreflang return-tag check above.
    if (!target) continue;

    const targetRedirect = redirectDestination(target);
    const targetTrace = redirectTraces.get(target.url);
    const targetTerminalFailure = redirectTerminalFailures.get(target.url);
    const targetTerminalSuitability =
      redirectTerminalSuitabilityIssues.get(target.url);
    if (targetTrace?.loop) {
      add("canonical-to-redirect", result, {
        targetUrl: result.canonical,
        detail: `Canonical target enters a redirect loop: ${targetTrace.path.join(" -> ")}`,
      });
    } else if (targetTrace?.limitReached) {
      add("canonical-to-redirect", result, {
        targetUrl: result.canonical,
        detail: `Canonical target exceeds Fetch's ${MAX_FETCH_REDIRECTS}-redirect limit: ${redirectLimitEvidence(targetTrace)}`,
      });
    } else if (targetTerminalFailure) {
      add("canonical-to-broken", result, {
        targetUrl: result.canonical,
        statusCode: targetTerminalFailure.statusCode,
        detail: `Canonical target's ${targetTerminalFailure.relationshipDetail}. Path: ${targetTerminalFailure.pathEvidence}`,
      });
    } else if (targetTerminalSuitability?.isNonIndexable) {
      add("canonical-to-noindex", result, {
        targetUrl: result.canonical,
        statusCode: targetTerminalSuitability.statusCode,
        detail: `Canonical target's ${targetTerminalSuitability.relationshipDetail}. Path: ${targetTerminalSuitability.pathEvidence}`,
      });
    } else if (targetTerminalSuitability?.canonicalMismatch) {
      add("canonical-chain", result, {
        targetUrl: result.canonical,
        statusCode: targetTerminalSuitability.statusCode,
        detail: `Canonical target's ${targetTerminalSuitability.relationshipDetail}. Path: ${targetTerminalSuitability.pathEvidence}`,
      });
    } else if (isRedirectStatus(target.status)) {
      add("canonical-to-redirect", result, {
        targetUrl: result.canonical,
        detail: target.redirectLocationIssue
          ? `Canonical target returns ${target.status}. ${redirectLocationIssueDetail(target)}`
          : `Canonical target returns ${target.status} instead of resolving directly`,
      });
    } else if (targetRedirect) {
      const targetRefresh = declarativeRefresh(target);
      add("canonical-to-redirect", result, {
        targetUrl: result.canonical,
        detail: `Canonical target uses ${
          targetRefresh?.source === "header"
            ? "an HTTP Refresh header"
            : "a meta refresh"
        } to ${targetRedirect}`,
      });
    } else if (target.status >= 400 || !target.status) {
      add("canonical-to-broken", result, {
        targetUrl: result.canonical,
        statusCode: target.status,
        detail: target.statusText,
      });
    } else if (target.canonical && target.canonical !== target.url) {
      add("canonical-chain", result, {
        targetUrl: result.canonical,
        detail: `${result.canonical} canonicalizes to a different URL (${target.canonical}) instead of itself`,
      });
    } else {
      const targetRobots = (target.robots || "").toLowerCase();
      if (targetRobots.includes("noindex") || targetRobots.includes("none")) {
        add("canonical-to-noindex", result, { targetUrl: result.canonical });
      }
    }
  }

  for (const result of internalResults) {
    if (result.status !== 200 || (!result.paginationNext && !result.paginationPrev)) {
      continue;
    }

    for (const [direction, url] of [
      ["next", result.paginationNext],
      ["prev", result.paginationPrev],
    ]) {
      if (!url) continue;
      const target = resultByUrl.get(url);
      if (!target) continue; // uncrawled target — can't verify, don't guess
      if (target.status >= 400 || !target.status) {
        add("pagination-link-broken", result, {
          targetUrl: url,
          detail: `rel="${direction}" target returns ${target.status || "no response"}`,
        });
      }
    }

    if (result.canonical && result.canonical !== result.url) {
      add("pagination-canonical-conflict", result, { targetUrl: result.canonical });
    }
  }

  const duplicateDefinitions = [
    ["title", "title-duplicate"],
    ["metaDescription", "meta-duplicate"],
    // `result.h1` joins every H1 with " | ". Only compare pages that have one
    // primary H1 so the finding reports a duplicated heading, not a duplicated
    // serialization of two already-invalid heading sets.
    ["h1", "h1-duplicate", (result) => result.h1Count === 1],
  ];
  for (const [key, ruleId, isEligible = () => true] of duplicateDefinitions) {
    const groups = new Map();
    for (const result of htmlResults) {
      const value = result[key]?.trim().toLowerCase();
      if (!value || !isPreferredIndexablePage(result) || !isEligible(result)) {
        continue;
      }
      const group = groups.get(value) || [];
      group.push(result);
      groups.set(value, group);
    }
    for (const unsortedGroup of groups.values()) {
      if (unsortedGroup.length < 2) continue;
      const group = [...unsortedGroup].sort((a, b) => a.url.localeCompare(b.url));
      if (isReciprocalHreflangGroup(group)) continue;
      for (const result of group) {
        add(ruleId, result, {
          detail: `Shared by ${group.length} independently indexable pages`,
          detectedValue: result[key],
        });
      }
    }
  }

  const contentGroups = new Map();
  for (const result of htmlResults) {
    if (
      !isPreferredIndexablePage(result) ||
      !result.hash ||
      result.words < 50
    ) {
      continue;
    }
    const group = contentGroups.get(result.hash) || [];
    group.push(result);
    contentGroups.set(result.hash, group);
  }
  for (const unsortedGroup of contentGroups.values()) {
    if (unsortedGroup.length < 2) continue;
    const group = [...unsortedGroup].sort((a, b) => a.url.localeCompare(b.url));
    // Complete reciprocal hreflang sets commonly represent intentional
    // regional variants whose body copy is allowed to be identical.
    if (isReciprocalHreflangGroup(group)) continue;

    for (const result of group) {
      const comparison = group.find((candidate) => candidate.url !== result.url);
      add("content-duplicate-exact", result, {
        targetUrl: comparison.url,
        detail: "Visible body text is identical to the comparison URL.",
        detectedValue: result.contentSample || `${result.words} identical words`,
      });
    }
  }

  const incomingFollow = new Map();
  const externalNofollowBySource = new Map();
  for (const edge of linkEdges) {
    const source = resultByUrl.get(edge.sourceUrl);
    const target = resultByUrl.get(edge.targetUrl);
    if (!source) continue;
    const relTokens = linkRelTokens(edge);
    const isNofollow = edge.nofollow || relTokens.has("nofollow");

    if (edge.internal) {
      const targetTrace = target && redirectTraces.get(target.url);
      const targetTerminalFailure =
        target && redirectTerminalFailures.get(target.url);
      const targetTerminalSuitability =
        target && redirectTerminalSuitabilityIssues.get(target.url);
      if (target && (target.status >= 400 || !target.status)) {
        add("broken-internal-links", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: target.statusText,
        });
      } else if (targetTerminalFailure) {
        add("broken-internal-links", source, {
          targetUrl: edge.targetUrl,
          statusCode: targetTerminalFailure.statusCode,
          detail: `Link target's ${targetTerminalFailure.relationshipDetail}. Path: ${targetTerminalFailure.pathEvidence}`,
        });
      }
      const targetRedirect = redirectDestination(target);
      if (targetTrace?.loop) {
        add("link-to-redirect", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: `Redirect loop: ${targetTrace.path.join(" -> ")}`,
        });
      } else if (targetTrace?.limitReached) {
        add("link-to-redirect", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: `Exceeds Fetch's ${MAX_FETCH_REDIRECTS}-redirect limit: ${redirectLimitEvidence(targetTrace)}`,
        });
      } else if (targetTerminalSuitability) {
        add("link-to-redirect", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: `Link target's ${targetTerminalSuitability.relationshipDetail}. Path: ${targetTerminalSuitability.pathEvidence}`,
        });
      } else if (
        !targetTerminalFailure &&
        target &&
        isRedirectStatus(target.status)
      ) {
        add("link-to-redirect", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: target.redirectLocationIssue
            ? redirectLocationIssueDetail(target)
            : target.redirectUrl,
        });
      } else if (!targetTerminalFailure && targetRedirect) {
        const targetRefresh = declarativeRefresh(target);
        add("link-to-redirect", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: `${declarativeRefreshLabel(targetRefresh)} to ${targetRedirect}`,
        });
      }
      if (isNofollow) {
        add("internal-nofollow-link", source, {
          targetUrl: edge.targetUrl,
          detectedValue: edge.anchorText,
        });
      }
      const statuses = incomingFollow.get(edge.targetUrl) || new Set();
      statuses.add(isNofollow ? "nofollow" : "dofollow");
      incomingFollow.set(edge.targetUrl, statuses);
    } else {
      const policy = externalNofollowBySource.get(edge.sourceUrl) || {
        total: 0,
        genericNofollow: [],
      };
      policy.total += 1;
      if (
        isNofollow &&
        !relTokens.has("sponsored") &&
        !relTokens.has("ugc")
      ) {
        policy.genericNofollow.push(edge);
      }
      externalNofollowBySource.set(edge.sourceUrl, policy);

      if (target?.status === 403) {
        add("external-403", source, {
          targetUrl: edge.targetUrl,
          statusCode: 403,
          detail:
            "The crawler received HTTP 403 (Forbidden); this proves request refusal, not that the destination is missing.",
          detectedValue: "HTTP 403 (Forbidden)",
        });
      } else if (target && (target.status >= 400 || !target.status)) {
        add("broken-external-link", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: target.statusText,
        });
      }
    }

    if (!edge.anchorText && !edge.accessibleName) {
      add("anchor-missing", source, {
        targetUrl: edge.targetUrl,
        detail: edge.elementHint || "Link has no visible or accessible name",
        detectedValue: edge.elementHint || "",
      });
    } else {
      const vagueVisibleText = isNonDescriptiveLinkLabel(edge.anchorText);
      const vagueAccessibleName = isNonDescriptiveLinkLabel(edge.accessibleName);
      const label = vagueVisibleText
        ? edge.anchorText
        : vagueAccessibleName
          ? edge.accessibleName
          : "";
      const labelSource = vagueVisibleText
        ? "Visible anchor text"
        : "Accessible name";
      if (label) {
        add("anchor-nondescriptive", source, {
          targetUrl: edge.targetUrl,
          detail: `${labelSource} is non-descriptive`,
          detectedValue: label,
        });
      }
    }
    if (source.url.startsWith("https:") && edge.targetUrl.startsWith("http:")) {
      const evidence = httpLinkEvidence(edge, target);
      if (evidence) {
        add("https-to-http-link", source, {
          targetUrl: edge.targetUrl,
          ...appendDocumentBaseEvidence(evidence, edge),
        });
      }
    }
    const linkOnlyResourceRels = [...relTokens]
      .filter((token) => LINK_ONLY_RESOURCE_RELS.has(token));
    if (edge.tag === "a" && linkOnlyResourceRels.length > 0) {
      const relValue = linkOnlyResourceRels.join(" ");
      add("resource-as-link", source, {
        targetUrl: edge.targetUrl,
        detail: `<a> uses a resource relationship that only works on <link>: ${relValue}`,
        detectedValue: `rel="${relValue}"`,
      });
    }
  }

  for (const [sourceUrl, policy] of externalNofollowBySource) {
    const genericCount = policy.genericNofollow.length;
    const ratio = policy.total ? genericCount / policy.total : 0;
    if (
      genericCount < MIN_GENERIC_EXTERNAL_NOFOLLOW_LINKS ||
      ratio < MIN_GENERIC_EXTERNAL_NOFOLLOW_RATIO
    ) {
      continue;
    }
    const percentage = Math.round(ratio * 100);
    const examples = [
      ...new Set(policy.genericNofollow.map((edge) => edge.targetUrl)),
    ].slice(0, 3);
    add("external-nofollow", resultByUrl.get(sourceUrl) || { url: sourceUrl }, {
      detail: `${genericCount} of ${policy.total} external links (${percentage}%) use generic rel="nofollow" without sponsored or ugc qualification.`,
      detectedValue: `${genericCount}/${policy.total} external links (${percentage}%); examples: ${examples.join(" | ")}`,
    });
  }

  for (const [url, statuses] of incomingFollow) {
    if (statuses.has("nofollow") && statuses.has("dofollow")) {
      add("mixed-incoming-follow", resultByUrl.get(url) || { url });
    }
  }

  for (const edge of resourceEdges) {
    const source = resultByUrl.get(edge.sourceUrl) || { url: edge.sourceUrl };
    if (
      source.url?.startsWith("https:") &&
      edge.targetUrl?.startsWith("http:")
    ) {
      const elementEvidence =
        edge.elementHint ||
        `${edge.tag || "resource"} via ${edge.sourceAttribute || "URL"}`;
      const baseEvidence =
        edge.baseHrefRaw && edge.documentBaseUrl
          ? `; relative reference resolves through <base href="${String(
              edge.baseHrefRaw,
            ).replaceAll('"', "'")}"> -> ${edge.documentBaseUrl}`
          : "";
      add("mixed-content", source, {
        targetUrl: edge.targetUrl,
        detail: `Insecure resource reference: ${elementEvidence}${baseEvidence}`,
        detectedValue: `${elementEvidence}${baseEvidence}`,
      });
    }
    const altMissing = edge.alt == null;
    const altWhitespaceOnly =
      edge.alt != null &&
      edge.alt !== "" &&
      !String(edge.alt).trim();
    if (
      edge.tag === "img" &&
      edge.auditAlt !== false &&
      !edge.altExempt &&
      (altMissing || altWhitespaceOnly)
    ) {
      const reason = altMissing
        ? "alt attribute is missing"
        : "alt attribute contains only whitespace";
      const elementEvidence =
        edge.altElementHint || edge.elementHint || "img element";
      add("image-alt-missing", source, {
        targetUrl: edge.targetUrl,
        detail: `${reason}: ${elementEvidence}`,
        detectedValue: elementEvidence,
      });
    }
  }

  if (siteDiagnostics.robotsWarnings?.length) {
    add("robots-issue", { url: siteDiagnostics.robotsUrl || startUrl }, {
      detail: siteDiagnostics.robotsWarnings.join("; "),
      detectedValue: siteDiagnostics.robotsWarnings.join("; "),
    });
  }
  if (siteDiagnostics.sitemapConfigIssue) {
    add("sitemap-robots-config", { url: siteDiagnostics.robotsUrl || startUrl }, {
      detail: siteDiagnostics.sitemapConfigIssue,
    });
  }
  // A declared sitemap that could not be read is a different problem from having
  // no sitemap, and the crawler used to report both the same way — so a site
  // whose sitemap merely timed out was told it did not have one.
  if (siteDiagnostics.sitemapErrors?.length) {
    add("sitemap-unreadable", { url: siteDiagnostics.robotsUrl || startUrl }, {
      detail: siteDiagnostics.sitemapErrors.join("; "),
      detectedValue: siteDiagnostics.sitemapErrors.join("; "),
    });
  }
  // Without this the audit of a client-rendered site reads as clean: one page,
  // no links, nothing broken. The absence of findings WAS the finding.
  if (siteDiagnostics.renderingIssue) {
    add("javascript-rendered-site", { url: startUrl }, {
      detail: siteDiagnostics.renderingIssue,
    });
  }
  for (const template of siteDiagnostics.trapTemplates || []) {
    add("crawl-trap", { url: startUrl }, {
      detail: `URLs matching ${template} were generated past the per-pattern limit and were not crawled.`,
      detectedValue: template,
    });
  }
  if (siteDiagnostics.httpHomepageIssue) {
    add("http-homepage", { url: startUrl }, {
      detail: siteDiagnostics.httpHomepageIssue,
    });
  }
  if (siteDiagnostics.llmsStatus === "missing") {
    add("llms-missing", { url: new URL("/llms.txt", startUrl).href });
  } else if (siteDiagnostics.llmsFormatIssue) {
    add("llms-format", { url: new URL("/llms.txt", startUrl).href }, {
      detail: siteDiagnostics.llmsFormatIssue,
    });
  }

  const root = resultByUrl.get(startUrl);
  if (
    root?.url.startsWith("https:") &&
    !root.strictTransportSecurity
  ) {
    add("hsts-missing", root);
  }

  const findingsByUrl = new Map();
  for (const finding of findings) {
    const list = findingsByUrl.get(finding.url) || [];
    list.push(finding);
    findingsByUrl.set(finding.url, list);
  }
  const enrichedResults = results.map((result) => ({
    ...result,
    issues: (findingsByUrl.get(result.url) || []).map((finding) => ({
      id: finding.ruleId,
      label: finding.title,
      severity: finding.severity,
      category: finding.category,
    })),
  }));

  return { findings, results: enrichedResults, catalog };
}

module.exports = { buildFindings, catalog };
