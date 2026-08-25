const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const cheerio = require("cheerio");
const { buildFindings } = require("./analyzer");
const { cssResourceReferences } = require("./css-resource-parser");
const { evaluateBaseUri } = require("./csp-base-uri");
const {
  classifyRedirectLocation,
  isRedirectStatus,
} = require("./http-redirect");
const { parseMetaRefresh } = require("./meta-refresh");

const USER_AGENT =
  "CrawlScope/1.1 (+local technical SEO audit; contact the site owner)";
const SKIP_SCHEMES = /^(mailto:|tel:|javascript:|data:|blob:)/i;
const ASSET_EXTENSIONS =
  /\.(?:avif|bmp|css|eot|gif|ico|jpe?g|js|json|map|mp3|mp4|ogg|otf|pdf|png|svg|tiff?|ttf|wav|webm|webp|woff2?|xml|zip)(?:$|\?)/i;
const TEXT_ASSET = /(?:javascript|json|css|xml|text\/)/i;
const MAX_BODY_BYTES = 5_000_000;
const REQUIRED_OPEN_GRAPH = ["og:title", "og:type", "og:image", "og:url"];
const OPEN_GRAPH_PROPERTIES = [
  ...REQUIRED_OPEN_GRAPH,
  "og:image:url",
  "og:description",
];
const LINK_SUBRESOURCE_RELS = new Set([
  "apple-touch-icon",
  "icon",
  "manifest",
  "mask-icon",
  "modulepreload",
  "prefetch",
  "preload",
  "stylesheet",
]);

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function pruneInertTemplates($) {
  const inertTemplates = $("template").filter((_, element) => {
    const shadowRootMode = String(
      $(element).attr("shadowrootmode") || "",
    ).toLowerCase();
    return !["open", "closed"].includes(shadowRootMode);
  });
  const count = inertTemplates.length;
  inertTemplates.remove();
  return count;
}

function isInTemplateContents(element) {
  let ancestor = element?.parent;
  while (ancestor) {
    if (
      ancestor.type === "tag" &&
      String(ancestor.tagName || ancestor.name).toLowerCase() === "template"
    ) {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

function documentElements($, selector) {
  return $(selector).filter((_, element) => !isInTemplateContents(element));
}

function normalizeUrl(input, base) {
  try {
    const parsed = new URL(input, base);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function declarativeRefreshFromResult(result) {
  if (result?.refreshHeaderRaw) {
    return {
      source: "header",
      raw: result.refreshHeaderRaw,
      delay: result.refreshHeaderDelay,
      delayRaw: result.refreshHeaderDelayRaw,
      delayOverflow: result.refreshHeaderDelayOverflow,
      targetRaw: result.refreshHeaderTargetRaw,
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
      targetRaw: result.metaRefreshTargetRaw,
      url: result.metaRefreshUrl,
      isReload: result.metaRefreshIsReload,
    };
  }
  return null;
}

function metaCspPoliciesBeforeBase($, baseElement) {
  const policies = [];
  for (const element of documentElements(
    $,
    "meta[http-equiv], base[href]",
  ).toArray()) {
    if (element === baseElement[0]) break;
    if (
      element.tagName === "meta" &&
      $(element).closest("head").length &&
      String($(element).attr("http-equiv") || "").trim().toLowerCase() ===
        "content-security-policy"
    ) {
      policies.push(String($(element).attr("content") || ""));
    }
  }
  return policies;
}

function documentBaseFromPage(
  $,
  fallbackUrl,
  headerPolicy = "",
  beforeElement = null,
) {
  let baseElement = documentElements($, "base[href]").first();
  if (beforeElement) {
    baseElement = $();
    for (const element of documentElements(
      $,
      "base[href], meta[http-equiv]",
    ).toArray()) {
      if (element === beforeElement) break;
      if (element.tagName === "base") {
        baseElement = $(element);
        break;
      }
    }
  }
  if (!baseElement.length) {
    return {
      raw: "",
      url: fallbackUrl,
      fallbackReason: "",
      policyEvidence: [],
    };
  }

  const raw = String(baseElement.attr("href") ?? "");
  try {
    const parsed = new URL(raw, fallbackUrl);
    if (["data:", "javascript:"].includes(parsed.protocol)) {
      return {
        raw,
        url: fallbackUrl,
        fallbackReason: `${parsed.protocol.slice(0, -1)} base URLs are ignored`,
        policyEvidence: [],
      };
    }
    const decision = evaluateBaseUri({
      candidateUrl: parsed.href,
      documentUrl: fallbackUrl,
      headerPolicy,
      metaPolicies: metaCspPoliciesBeforeBase($, baseElement),
    });
    if (!decision.allowed) {
      return {
        raw,
        url: fallbackUrl,
        fallbackReason: `Blocked by Content-Security-Policy ${decision.blockedBy.source}: ${decision.blockedBy.serialized}`,
        policyEvidence: decision.evidence,
      };
    }
    return {
      raw,
      url: parsed.href,
      fallbackReason: "",
      policyEvidence: decision.evidence,
    };
  } catch {
    return {
      raw,
      url: fallbackUrl,
      fallbackReason: "base href is not a valid URL",
      policyEvidence: [],
    };
  }
}

function metaRefreshFromPage($, documentUrl, headerPolicy = "") {
  for (const element of documentElements($, "meta[http-equiv]").toArray()) {
    if (
      String($(element).attr("http-equiv") || "").toLowerCase() !== "refresh"
    ) {
      continue;
    }
    if ($(element).attr("content") === undefined) continue;
    const insertionBase = documentBaseFromPage(
      $,
      documentUrl,
      headerPolicy,
      element,
    );
    const parsed = parseMetaRefresh(
      $(element).attr("content"),
      documentUrl,
      insertionBase.url,
    );
    if (parsed) return parsed;
  }
  return null;
}

function documentBaseMetadata(rawValue, documentBase) {
  if (
    !documentBase?.raw ||
    documentBase.fallbackReason ||
    !String(rawValue || "").trim()
  ) {
    return {};
  }
  try {
    new URL(String(rawValue).trim());
    return {};
  } catch {
    return {
      baseHrefRaw: documentBase.raw,
      documentBaseUrl: documentBase.url,
    };
  }
}

function srcsetUrls(value) {
  const input = String(value || "").trim();
  const urls = [];
  let position = 0;
  while (position < input.length) {
    while (
      position < input.length &&
      (input[position] === "," || /\s/.test(input[position]))
    ) {
      position += 1;
    }
    const start = position;
    while (position < input.length && !/\s/.test(input[position])) {
      position += 1;
    }
    const token = input.slice(start, position).replace(/,+$/, "");
    if (token) {
      if (/^data:/i.test(token)) urls.push(token);
      else urls.push(...token.split(",").filter(Boolean));
    }
    while (position < input.length && input[position] !== ",") {
      position += 1;
    }
    if (input[position] === ",") position += 1;
  }
  return urls;
}

function imageSourceFromElement($, element, baseUrl) {
  const image = $(element);
  let embeddedSource = null;
  const candidateGroups = [
    { attribute: "src", values: [image.attr("src")] },
    { attribute: "srcset", values: srcsetUrls(image.attr("srcset")) },
    { attribute: "data-src", values: [image.attr("data-src")] },
    { attribute: "data-lazy-src", values: [image.attr("data-lazy-src")] },
    { attribute: "data-original", values: [image.attr("data-original")] },
    {
      attribute: "data-srcset",
      values: srcsetUrls(image.attr("data-srcset")),
    },
    {
      attribute: "data-lazy-srcset",
      values: srcsetUrls(image.attr("data-lazy-srcset")),
    },
  ];

  for (const group of candidateGroups) {
    for (const candidate of group.values) {
      const raw = String(candidate || "").trim();
      if (!raw) continue;
      if (/^data:/i.test(raw)) {
        embeddedSource ||= {
          attribute: group.attribute,
          raw,
          url: "",
          element,
        };
        continue;
      }
      if (SKIP_SCHEMES.test(raw)) continue;
      const url = normalizeUrl(raw, baseUrl);
      if (url) {
        return {
          attribute: group.attribute,
          raw,
          url,
          element,
        };
      }
    }
  }

  const picture = image.closest("picture");
  if (picture.length) {
    const pictureSources = image
      .prevAll("source[srcset]")
      .toArray()
      .reverse();
    for (const source of pictureSources) {
      for (const raw of srcsetUrls($(source).attr("srcset"))) {
        if (!raw || SKIP_SCHEMES.test(raw)) continue;
        const url = normalizeUrl(raw, baseUrl);
        if (url) {
          return {
            attribute: "picture source[srcset]",
            resourceAttribute: "srcset",
            raw,
            url,
            element: source,
          };
        }
      }
    }
  }

  return embeddedSource;
}

function imageResourceSourcesFromElement($, element, baseUrl) {
  const candidates = [];
  const addCandidates = (sourceElement, attribute, values) => {
    for (const candidate of values) {
      const raw = String(candidate || "").trim();
      if (!raw || SKIP_SCHEMES.test(raw)) continue;
      const url = normalizeUrl(raw, baseUrl);
      if (!url) continue;
      candidates.push({
        attribute,
        raw,
        url,
        element: sourceElement,
      });
    }
  };
  const image = $(element);

  addCandidates(element, "src", [image.attr("src")]);
  addCandidates(element, "srcset", srcsetUrls(image.attr("srcset")));

  const pictureSources = image
    .prevAll("source[srcset]")
    .toArray()
    .reverse();
  for (const sourceElement of pictureSources) {
    addCandidates(
      sourceElement,
      "srcset",
      srcsetUrls($(sourceElement).attr("srcset")),
    );
  }

  return candidates;
}

function imageElementHint($, element, source) {
  return resourceElementHint($, element, source);
}

function resourceElementIdentity($, element) {
  const resource = $(element);
  const tag = element.tagName.toLowerCase();
  const id = cleanText(resource.attr("id")).slice(0, 60);
  const classes = cleanText(resource.attr("class"))
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  const rel =
    tag === "link"
      ? cleanText(resource.attr("rel")).toLowerCase().slice(0, 100)
      : "";
  const sourceMedia =
    tag === "source"
      ? cleanText(resource.attr("media")).slice(0, 100)
      : "";
  const sourceType =
    tag === "source"
      ? cleanText(resource.attr("type")).toLowerCase().slice(0, 100)
      : "";
  return `${tag}${id ? `#${id}` : ""}${
    classes.length ? `.${classes.join(".")}` : ""
  }${rel ? `[rel="${rel.replaceAll('"', "'")}"]` : ""}${
    sourceMedia ? `[media="${sourceMedia.replaceAll('"', "'")}"]` : ""
  }${sourceType ? `[type="${sourceType.replaceAll('"', "'")}"]` : ""}`;
}

function resourceElementHint($, element, source) {
  const identity = resourceElementIdentity($, element);
  const raw = source.raw.replaceAll('"', "'");
  const preview = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
  return `${identity} via ${source.attribute}="${preview}"`;
}

function cssReferenceHint(owner, reference, attributePrefix = "") {
  const raw = reference.raw.replaceAll('"', "'");
  const preview = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
  const source = attributePrefix
    ? `${attributePrefix} ${reference.kind}`
    : reference.kind;
  const line = reference.line > 1 ? ` line ${reference.line}` : "";
  const context =
    reference.context && reference.context !== reference.raw
      ? ` (${reference.context})`
      : "";
  return `${owner}${line} via ${source}="${preview}"${context}`;
}

function primaryOpenGraphImage($) {
  let primary = null;
  documentElements($, "meta[property]").each((_, element) => {
    const property = cleanText($(element).attr("property")).toLowerCase();
    const value = cleanText($(element).attr("content") || "");
    if (property === "og:image" || property === "og:image:url") {
      if (!primary) {
        primary = {
          property,
          value,
          alt: "",
          altDeclared: false,
        };
        return;
      }
      const primaryUrl = normalizeUrl(primary.value);
      const candidateUrl = normalizeUrl(value);
      const isEquivalentAlias =
        property !== primary.property &&
        Boolean(primaryUrl) &&
        primaryUrl === candidateUrl;
      if (isEquivalentAlias) return;
      return false;
    }
    if (
      property === "og:image:alt" &&
      primary &&
      !primary.altDeclared
    ) {
      primary.alt = value;
      primary.altDeclared = true;
    }
  });
  return (
    primary || {
      property: "",
      value: "",
      alt: "",
      altDeclared: false,
    }
  );
}

function decodeXml(value = "") {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function headerValue(headers, name) {
  return headers.get(name) || "";
}

function parseRobots(content, userAgent = "crawlscope") {
  const groups = [];
  let agents = [];
  let rules = [];

  const flush = () => {
    if (agents.length) groups.push({ agents, rules });
    agents = [];
    rules = [];
  };

  for (const sourceLine of content.split(/\r?\n/)) {
    const line = sourceLine.split("#")[0].trim();
    if (!line || !line.includes(":")) continue;
    const separator = line.indexOf(":");
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (rules.length) flush();
      agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && agents.length) {
      if (value || key === "allow") rules.push({ type: key, pattern: value });
    }
  }
  flush();

  const exact = groups.filter((group) =>
    group.agents.some((agent) => agent !== "*" && userAgent.includes(agent)),
  );
  const wildcard = groups.filter((group) => group.agents.includes("*"));
  return (exact.length ? exact : wildcard).flatMap((group) => group.rules);
}

function inspectRobots(content) {
  const warnings = [];
  let hasUserAgent = false;
  let sitemapUrls = [];
  const validKeys = new Set(["user-agent", "allow", "disallow", "sitemap", "crawl-delay"]);

  for (const [index, sourceLine] of content.split(/\r?\n/).entries()) {
    const line = sourceLine.split("#")[0].trim();
    if (!line) continue;
    if (!line.includes(":")) {
      warnings.push(`Line ${index + 1} is missing a colon`);
      continue;
    }
    const separator = line.indexOf(":");
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!validKeys.has(key)) continue;
    if (key === "user-agent") hasUserAgent = true;
    if ((key === "allow" || key === "disallow") && !hasUserAgent) {
      warnings.push(`Line ${index + 1} contains ${key} before a user-agent`);
    }
    if (key === "sitemap") {
      const sitemap = normalizeUrl(value);
      if (sitemap) sitemapUrls.push(sitemap);
      else warnings.push(`Line ${index + 1} contains an invalid sitemap URL`);
    }
  }
  sitemapUrls = [...new Set(sitemapUrls)];
  return { warnings, sitemapUrls };
}

function robotsPatternMatches(path, pattern) {
  if (!pattern) return false;
  const anchored = pattern.endsWith("$");
  const raw = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = raw
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(path);
}

function isAllowedByRobots(url, rules) {
  const parsed = new URL(url);
  const path = `${parsed.pathname}${parsed.search}`;
  const matches = rules
    .filter((rule) => robotsPatternMatches(path, rule.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length);
  return !matches.length || matches[0].type === "allow";
}

function quickIssues(result) {
  const issues = [];
  const add = (id, label, severity, category) =>
    issues.push({ id, label, severity, category });
  if (result.status >= 500) add("server-error", "Server error (5xx)", "error", "Technical");
  else if (result.status >= 400) add("page-4xx", "Page returns a 4XX error", "error", "Technical");
  else if (isRedirectStatus(result.status))
    add("redirect", "Redirect response", "warning", "Indexability");
  else if (!result.status)
    add("crawl-failure", "Page cannot be crawled", "error", "Technical");
  if (result.redirectLocationIssue) {
    add(
      "redirect-location-invalid",
      "Redirect destination is missing or unusable",
      "error",
      "Indexability",
    );
  }
  if (
    result.contentType.includes("text/html") &&
    result.status >= 200 &&
    result.status < 300
  ) {
    if (result.baseHrefRaw && result.documentBaseFallbackReason) {
      add(
        "base-url-ignored",
        "Document base URL is ignored",
        "warning",
        "Technical",
      );
    }
    if (result.refreshHeaderRaw) {
      add(
        "http-refresh",
        "HTTP Refresh header redirect or reload",
        "warning",
        "Indexability",
      );
    } else if (result.metaRefreshRaw) {
      add(
        "meta-refresh",
        "Meta refresh redirect or reload",
        "warning",
        "Indexability",
      );
    }
    if (!result.title) add("title-missing", "Missing page title", "error", "Metadata");
    if (result.titleLength > 60)
      add("title-long", "Title is too long", "warning", "Metadata");
    if (!result.metaDescription)
      add("meta-missing", "Missing meta description", "warning", "Metadata");
    if (!result.h1Count) add("h1-missing", "Missing H1 heading", "warning", "Metadata");
    if (result.words > 0 && result.words < 200)
      add("low-word-count", "Low word count", "warning", "Content");
  }
  return issues;
}

function emptyResult(job, overrides = {}) {
  return {
    url: job.url,
    scope: job.external ? "External" : "Internal",
    status: 0,
    statusText: "",
    contentType: "",
    size: 0,
    responseTime: 0,
    depth: job.depth || 0,
    title: "",
    titleCount: 0,
    titleLength: 0,
    metaDescription: "",
    metaLength: 0,
    viewport: "",
    h1Count: 0,
    h1: "",
    h2Count: 0,
    h2: "",
    words: 0,
    textHtmlRatio: 0,
    headingHierarchyIssue: false,
    headingHierarchyIssues: [],
    indexability: job.external ? "External" : "Unknown",
    indexabilityReason: "",
    canonical: "",
    hreflangs: [],
    paginationNext: "",
    paginationPrev: "",
    robots: "",
    inlinks: 0,
    outlinks: 0,
    externalLinks: 0,
    hash: "",
    contentSample: "",
    sourceUrl: job.sourceUrl || "",
    redirectUrl: "",
    locationHeaderRaw: "",
    locationHeaderPresent: false,
    redirectLocationIssue: "",
    redirectLocationScheme: "",
    isAsset: Boolean(job.isAsset),
    fromSitemap: Boolean(job.fromSitemap),
    cacheControl: "",
    cacheable: false,
    contentEncoding: "",
    strictTransportSecurity: "",
    unminified: false,
    openGraphMissing: [],
    openGraphInvalidUrls: [],
    openGraphImageProperty: "",
    openGraphImageUrl: "",
    openGraphImageRaw: "",
    openGraphImageAlt: "",
    openGraphImageAltMissing: false,
    openGraphDescriptionMissing: false,
    ogUrlRaw: "",
    ogUrl: "",
    schemaErrors: [],
    baseHrefRaw: "",
    documentBaseUrl: "",
    documentBaseFallbackReason: "",
    documentBasePolicyEvidence: [],
    inertTemplateCount: 0,
    refreshHeaderRaw: "",
    refreshHeaderDelay: null,
    refreshHeaderDelayRaw: "",
    refreshHeaderDelayOverflow: false,
    refreshHeaderTargetRaw: "",
    refreshHeaderUrl: "",
    refreshHeaderIsReload: false,
    metaRefreshRaw: "",
    metaRefreshDelay: null,
    metaRefreshDelayRaw: "",
    metaRefreshDelayOverflow: false,
    metaRefreshTargetRaw: "",
    metaRefreshUrl: "",
    metaRefreshIsReload: false,
    issues: [],
    ...overrides,
  };
}

function schemaErrorsFromPage($) {
  const errors = [];
  const inspectNode = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(inspectNode);
      return;
    }
    const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    const types = type.filter(Boolean).map(String);
    if (types.some((item) => /LocalBusiness|Dentist/i.test(item))) {
      if (!node.name) errors.push(`${types[0]} is missing the required name property`);
      if (!node.address) errors.push(`${types[0]} is missing the required address property`);
    }
    if (types.includes("FAQPage") && !node.mainEntity) {
      errors.push("FAQPage is missing mainEntity");
    }
    if (types.includes("BreadcrumbList") && !node.itemListElement) {
      errors.push("BreadcrumbList is missing itemListElement");
    }
    if (types.includes("Product")) {
      if (!node.name) errors.push("Product is missing the required name property");
      if (!node.offers && !node.review && !node.aggregateRating) {
        errors.push("Product needs at least one of offers, review, or aggregateRating");
      }
    }
    if (types.some((item) => /^(Article|BlogPosting|NewsArticle)$/i.test(item))) {
      const label = types.find((item) => /^(Article|BlogPosting|NewsArticle)$/i.test(item));
      if (!node.headline) errors.push(`${label} is missing the required headline property`);
      if (!node.image) errors.push(`${label} is missing the required image property`);
      if (!node.datePublished) {
        errors.push(`${label} is missing the required datePublished property`);
      }
    }
    if (types.includes("Organization") && !node.name) {
      errors.push("Organization is missing the required name property");
    }
    if (node["@graph"]) inspectNode(node["@graph"]);
  };

  documentElements($, 'script[type="application/ld+json" i]').each(
    (index, element) => {
      const raw = $(element).html()?.replace(/^\s*<!--|-->\s*$/g, "").trim();
      if (!raw) return;
      try {
        inspectNode(JSON.parse(raw));
      } catch (error) {
        errors.push(
          `JSON-LD block ${index + 1} is invalid: ${cleanText(error.message)}`,
        );
      }
    },
  );
  return [...new Set(errors)].slice(0, 20);
}

class SeoCrawler extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      maxUrls: Math.max(1, Math.min(Number(options.maxUrls) || 500, 50_000)),
      maxExternalUrls: Math.max(
        0,
        Math.min(Number(options.maxExternalUrls) || 150, 2_000),
      ),
      concurrency: Math.max(1, Math.min(Number(options.concurrency) || 4, 16)),
      timeout: Math.max(3_000, Math.min(Number(options.timeout) || 15_000, 60_000)),
      respectRobots: options.respectRobots !== false,
      includeSubdomains: options.includeSubdomains === true,
      crawlAssets: options.crawlAssets !== false,
      checkExternalLinks: options.checkExternalLinks !== false,
      discoverSitemaps: options.discoverSitemaps !== false,
      userAgent: options.userAgent || USER_AGENT,
      // Politeness / outbound-reputation controls. Defaults keep local + desktop
      // behavior identical (no artificial delay); the hosted worker raises
      // perHostDelay to space requests and reduce the chance of being blocked.
      perHostDelay: Math.max(0, Math.min(Number(options.perHostDelay) || 0, 60_000)),
      maxRetries: Math.max(0, Math.min(Number(options.maxRetries) ?? 2, 5)),
      retryBaseDelay: Math.max(100, Math.min(Number(options.retryBaseDelay) || 1_000, 30_000)),
      maxRetryDelay: Math.max(1_000, Math.min(Number(options.maxRetryDelay) || 30_000, 120_000)),
      hostBackoffFactor: Math.max(1, Math.min(Number(options.hostBackoffFactor) || 2, 10)),
      maxHostDelay: Math.max(0, Math.min(Number(options.maxHostDelay) || 10_000, 120_000)),
    };
    // Outbound fetch is injected so the transport (direct / proxy / SSRF-guarded)
    // is a hosting concern, not a crawler concern. Defaults to the platform fetch
    // for desktop and unit tests, which may reach localhost.
    this._fetch = typeof options.fetch === "function" ? options.fetch : globalThis.fetch;
    this._hostState = new Map();
    // A single controller aborted by stop() cancels every in-flight request and
    // any pending politeness/backoff wait.
    this.rootController = new AbortController();
    // "spider" (default): start from one URL and follow internal links.
    // "list": fetch exactly the provided URLs and nothing they link to — set by
    // start() when given an array instead of a single URL.
    this.mode = "spider";
    this.queue = [];
    this.seen = new Set();
    this.externalSeen = new Set();
    this.results = [];
    this.inlinkCounts = new Map();
    this.discovery = new Map();
    this.linkEdges = [];
    this.resourceEdges = [];
    this.sitemapMembership = new Map();
    this.sitemapUrls = [];
    this.active = 0;
    this.paused = false;
    this.stopped = false;
    this.truncated = false;
    this.startedAt = 0;
    this.robotsRules = [];
    this.robotsStatus = "Not checked";
    this.siteDiagnostics = {
      robotsWarnings: [],
      robotsUrl: "",
      sitemapConfigIssue: "",
      httpHomepageIssue: "",
      llmsStatus: "not checked",
      llmsFormatIssue: "",
    };
  }

  async start(input) {
    this.startedAt = Date.now();

    if (Array.isArray(input)) {
      this._startList(input);
    } else {
      const initial = normalizeUrl(input);
      if (!initial) throw new Error("Enter a valid http:// or https:// URL.");
      this.startUrl = initial;
      this.origin = new URL(initial).origin;
      this.hostname = new URL(initial).hostname;

      if (this.options.respectRobots || this.options.discoverSitemaps) {
        await this._loadRobots();
      }
      await Promise.all([
        this.options.discoverSitemaps ? this._loadSitemaps() : Promise.resolve(),
        this._checkSiteFiles(),
      ]);

      this._enqueueInternal(initial, 0, "", { fromSitemap: false });
      for (const sitemapUrl of this.sitemapMembership.keys()) {
        this._enqueueInternal(sitemapUrl, 1, "", { fromSitemap: true });
      }
    }

    return new Promise((resolve) => {
      this.resolve = resolve;
      this._schedule();
    });
  }

  // List mode: fetch and analyze exactly the given URLs. No link-following, no
  // scope restriction (URLs may span any number of domains), and no site-wide
  // diagnostics (robots.txt/sitemaps/llms.txt/HTTP-to-HTTPS) since those are only
  // meaningful for a single origin. Each URL is still subject to the same
  // per-host politeness/backoff and SSRF guarding as spider mode.
  _startList(urls) {
    this.mode = "list";
    this.startUrl = "";
    this.origin = "";
    this.hostname = "";

    const deduped = [];
    for (const raw of urls) {
      const normalized = normalizeUrl(raw);
      if (!normalized || this.seen.has(normalized)) continue;
      this.seen.add(normalized);
      deduped.push(normalized);
    }
    if (!deduped.length) throw new Error("Provide at least one valid http:// or https:// URL.");

    for (const url of deduped.slice(0, this.options.maxUrls)) {
      this.queue.push({
        url,
        depth: 0,
        sourceUrl: "",
        isAsset: ASSET_EXTENSIONS.test(url),
        fromSitemap: false,
        external: false,
      });
    }
    this.emit("progress", this._progress());
  }

  pause() {
    this.paused = true;
    this.emit("state", { state: "paused" });
  }

  resume() {
    this.paused = false;
    this.emit("state", { state: "running" });
    this._schedule();
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    this.rootController.abort();
    this.emit("state", { state: "stopping" });
    this._schedule();
  }

  // In list mode there is no single site, so "in scope" means "same host as the
  // page it was found on" (per `job`) rather than "same host as the seed URL".
  _inScope(url, job) {
    const parsed = new URL(url);
    const referenceHost =
      this.mode === "list" && job ? new URL(job.url).hostname : this.hostname;
    if (this.options.includeSubdomains) {
      const root = referenceHost.replace(/^www\./, "");
      return parsed.hostname === referenceHost || parsed.hostname.endsWith(`.${root}`);
    }
    return parsed.hostname === referenceHost;
  }

  _enqueueInternal(url, depth, sourceUrl, metadata = {}) {
    const normalized = normalizeUrl(url);
    if (!normalized || !this._inScope(normalized)) return false;

    const isAsset = metadata.isAsset ?? ASSET_EXTENSIONS.test(normalized);
    const existing = this.discovery.get(normalized) || {};
    this.discovery.set(normalized, {
      ...existing,
      fromSitemap: existing.fromSitemap || Boolean(metadata.fromSitemap),
      isAsset: existing.isAsset || isAsset,
    });

    if (this.seen.has(normalized)) {
      if (sourceUrl) {
        this.inlinkCounts.set(normalized, (this.inlinkCounts.get(normalized) || 0) + 1);
      }
      return false;
    }
    if (this.seen.size >= this.options.maxUrls) {
      // A genuinely new, in-scope URL was dropped purely because the URL
      // limit was hit — inlink/depth counts from here on are a partial-crawl
      // sample, not the real site, and checks that depend on them (e.g.
      // single-inlink, orphan-page) would otherwise report false confidence.
      this.truncated = true;
      return false;
    }
    if (!this.options.crawlAssets && isAsset && !metadata.fromSitemap) return false;

    this.seen.add(normalized);
    if (sourceUrl) {
      this.inlinkCounts.set(normalized, (this.inlinkCounts.get(normalized) || 0) + 1);
    }
    this.queue.push({
      url: normalized,
      depth,
      sourceUrl,
      isAsset,
      fromSitemap: Boolean(metadata.fromSitemap),
      external: false,
    });
    this.emit("progress", this._progress());
    return true;
  }

  _enqueueExternal(url, sourceUrl) {
    const normalized = normalizeUrl(url);
    if (
      !normalized ||
      this.externalSeen.has(normalized) ||
      this.externalSeen.size >= this.options.maxExternalUrls
    ) {
      return false;
    }
    this.externalSeen.add(normalized);
    this.queue.push({
      url: normalized,
      depth: 0,
      sourceUrl,
      isAsset: ASSET_EXTENSIONS.test(normalized),
      fromSitemap: false,
      external: true,
    });
    this.emit("progress", this._progress());
    return true;
  }

  async _loadRobots() {
    const robotsUrl = new URL("/robots.txt", this.origin).href;
    this.siteDiagnostics.robotsUrl = robotsUrl;
    try {
      const response = await this._politeFetch(
        robotsUrl,
        { headers: { "User-Agent": this.options.userAgent, Accept: "text/plain,*/*;q=0.1" } },
        { timeout: this.options.timeout, signal: this.rootController.signal },
      );
      if (response.ok) {
        const content = await response.text();
        this.robotsRules = parseRobots(content);
        const inspection = inspectRobots(content);
        this.siteDiagnostics.robotsWarnings = inspection.warnings;
        this.sitemapUrls = inspection.sitemapUrls;
        this.robotsStatus = this.robotsRules.length ? "Respected" : "No crawl rules";
      } else {
        this.robotsStatus = `Not found (${response.status})`;
      }
    } catch {
      this.robotsStatus = "Unavailable";
    }
  }

  async _loadSitemaps() {
    const declared = [...this.sitemapUrls];
    const pending = declared.length
      ? declared
      : [new URL("/sitemap.xml", this.origin).href];
    const visited = new Set();
    let foundAny = false;

    while (pending.length && visited.size < 15 && !this.stopped) {
      const sitemapUrl = pending.shift();
      if (!sitemapUrl || visited.has(sitemapUrl)) continue;
      visited.add(sitemapUrl);
      try {
        const response = await this._politeFetch(
          sitemapUrl,
          {
            headers: {
              "User-Agent": this.options.userAgent,
              Accept: "application/xml,text/xml,*/*;q=0.5",
            },
          },
          { timeout: this.options.timeout, signal: this.rootController.signal },
        );
        if (!response.ok) continue;
        const xml = await response.text();
        if (!/<(?:urlset|sitemapindex)(?:\s|>)/i.test(xml)) continue;
        foundAny = true;
        const locations = [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
          .map((match) => normalizeUrl(decodeXml(cleanText(match[1])), sitemapUrl))
          .filter(Boolean);
        if (/<sitemapindex(?:\s|>)/i.test(xml)) {
          for (const location of locations) {
            if (!visited.has(location)) pending.push(location);
          }
        } else {
          for (const location of locations) {
            if (!this._inScope(location)) continue;
            const memberships = this.sitemapMembership.get(location) || new Set();
            memberships.add(sitemapUrl);
            this.sitemapMembership.set(location, memberships);
          }
        }
      } catch {
        // Sitemap failures are summarized in the configuration finding below.
      }
    }

    if (!declared.length) {
      this.siteDiagnostics.sitemapConfigIssue = foundAny
        ? "A sitemap was found, but robots.txt does not declare it."
        : "No sitemap declaration or accessible default sitemap was detected.";
    }
    this.siteDiagnostics.sitemaps = [...visited];
  }

  async _checkSiteFiles() {
    const checks = [];
    const llmsUrl = new URL("/llms.txt", this.origin).href;
    checks.push(
      this._politeFetch(
        llmsUrl,
        { headers: { "User-Agent": this.options.userAgent, Accept: "text/plain,*/*;q=0.2" } },
        { timeout: this.options.timeout, signal: this.rootController.signal },
      )
        .then(async (response) => {
          if (response.status === 404) {
            this.siteDiagnostics.llmsStatus = "missing";
            return;
          }
          if (!response.ok) {
            this.siteDiagnostics.llmsStatus = "unavailable";
            return;
          }
          const content = await response.text();
          this.siteDiagnostics.llmsStatus = "found";
          if (!/^#\s+\S+/m.test(content)) {
            this.siteDiagnostics.llmsFormatIssue =
              "The file does not contain a Markdown H1 heading.";
          }
        })
        .catch(() => {
          this.siteDiagnostics.llmsStatus = "unavailable";
        }),
    );

    if (this.startUrl.startsWith("https:")) {
      const httpUrl = this.startUrl.replace(/^https:/, "http:");
      checks.push(
        this._politeFetch(
          httpUrl,
          { redirect: "manual", headers: { "User-Agent": this.options.userAgent } },
          { timeout: this.options.timeout, signal: this.rootController.signal },
        )
          .then(async (response) => {
            const location = normalizeUrl(headerValue(response.headers, "location"), httpUrl);
            if (
              isRedirectStatus(response.status) &&
              location?.startsWith("https:")
            ) {
              return;
            }
            let canonical = "";
            if (response.ok && headerValue(response.headers, "content-type").includes("html")) {
              const body = await response.text();
              const page = cheerio.load(body);
              canonical =
                normalizeUrl(
                  page('link[rel~="canonical" i]').first().attr("href") || "",
                  httpUrl,
                ) || "";
            }
            if (!canonical.startsWith("https:")) {
              this.siteDiagnostics.httpHomepageIssue =
                `HTTP returned ${response.status} without a direct HTTPS redirect or HTTPS canonical.`;
            }
          })
          .catch(() => {
            this.siteDiagnostics.httpHomepageIssue =
              "The HTTP homepage could not be verified for an HTTPS redirect.";
          }),
      );
    }
    await Promise.all(checks);
  }

  _progress() {
    return {
      crawled: this.results.length,
      discovered: this.seen.size + this.externalSeen.size,
      queued: this.queue.length,
      active: this.active,
      maxUrls: this.options.maxUrls + this.options.maxExternalUrls,
      elapsed: Date.now() - this.startedAt,
    };
  }

  _schedule() {
    if (this.paused) return;
    while (
      !this.stopped &&
      this.active < this.options.concurrency &&
      this.queue.length
    ) {
      const job = this.queue.shift();
      this.active += 1;
      this._process(job)
        .catch((error) => this.emit("log", { level: "error", message: error.message }))
        .finally(() => {
          this.active -= 1;
          this.emit("progress", this._progress());
          this._schedule();
        });
    }

    if ((this.stopped || this.queue.length === 0) && this.active === 0 && this.resolve) {
      const baseResults = this.results.map((item) => {
        const discovery = this.discovery.get(item.url) || {};
        return {
          ...item,
          inlinks:
            item.scope === "External"
              ? item.inlinks || 0
              : this.inlinkCounts.get(item.url) || item.inlinks || 0,
          fromSitemap: Boolean(discovery.fromSitemap || item.fromSitemap),
          isAsset: Boolean(discovery.isAsset || item.isAsset),
        };
      });
      const membership = Object.fromEntries(
        [...this.sitemapMembership].map(([url, sitemaps]) => [url, [...sitemaps]]),
      );
      const analysis = buildFindings({
        results: baseResults,
        linkEdges: this.linkEdges,
        resourceEdges: this.resourceEdges,
        sitemapMembership: membership,
        siteDiagnostics: this.siteDiagnostics,
        startUrl: this.startUrl,
        sitemapsChecked: this.mode !== "list" && this.options.discoverSitemaps,
        crawlTruncated: this.truncated,
      });
      const payload = {
        stopped: this.stopped,
        truncated: this.truncated,
        results: analysis.results,
        findings: analysis.findings,
        // The internal link graph. Already collected for the findings pass, and
        // now carried out so it can be stored: hub-and-spoke clustering is a
        // question about edges, and crawl_run_results only keeps counts. Not
        // recomputed and not re-fetched — PRD §32 forbids re-crawling to answer
        // a question an existing crawl already saw.
        linkEdges: this.linkEdges,
        catalog: analysis.catalog,
        elapsed: Date.now() - this.startedAt,
        robotsStatus: this.robotsStatus,
        siteDiagnostics: this.siteDiagnostics,
      };
      const resolve = this.resolve;
      this.resolve = null;
      this.emit("complete", payload);
      resolve(payload);
    }
  }

  _hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  }

  // Resolves after `ms`, or rejects if the crawl is stopped mid-wait.
  _delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (!(ms > 0)) return resolve();
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, ms);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  // Spaces requests to the same host. Slots are reserved up front so concurrent
  // workers hitting one host get staggered start times rather than a thundering herd.
  async _throttleHost(host, signal) {
    if (!this._hostState.has(host)) {
      this._hostState.set(host, { nextAt: 0, delayMs: this.options.perHostDelay });
    }
    const state = this._hostState.get(host);
    if (state.delayMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, state.nextAt);
    state.nextAt = slot + state.delayMs;
    await this._delay(slot - now, signal);
  }

  // A host that pushed back (429/503) gets a larger per-host delay going forward.
  _penalizeHost(host) {
    const state = this._hostState.get(host) || { nextAt: 0, delayMs: 0 };
    const base = Math.max(state.delayMs, this.options.retryBaseDelay);
    state.delayMs = Math.min(base * this.options.hostBackoffFactor, this.options.maxHostDelay);
    this._hostState.set(host, state);
  }

  _retryAfterMs(response, attempt) {
    const header = response.headers.get("retry-after");
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) {
        return Math.min(Math.max(0, seconds * 1_000), this.options.maxRetryDelay);
      }
      const when = Date.parse(header);
      if (Number.isFinite(when)) {
        return Math.min(Math.max(0, when - Date.now()), this.options.maxRetryDelay);
      }
    }
    const backoff = this.options.retryBaseDelay * 2 ** attempt;
    return Math.min(backoff, this.options.maxRetryDelay);
  }

  _attemptSignal(timeout, external) {
    const signals = [];
    if (Number.isFinite(timeout) && timeout > 0) signals.push(AbortSignal.timeout(timeout));
    if (external) signals.push(external);
    if (!signals.length) return undefined;
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
  }

  // Single outbound request point: per-host throttle, injected transport, then
  // bounded retry with Retry-After / exponential backoff on 429 and 503.
  async _politeFetch(url, init = {}, { timeout, signal } = {}) {
    const host = this._hostOf(url);
    let attempt = 0;
    for (;;) {
      if (this.stopped) throw new DOMException("Aborted", "AbortError");
      await this._throttleHost(host, signal);
      const attemptSignal = this._attemptSignal(timeout, signal);
      const response = await this._fetch(url, { ...init, signal: attemptSignal });
      const retriable = response.status === 429 || response.status === 503;
      if (retriable && attempt < this.options.maxRetries && !this.stopped) {
        const wait = this._retryAfterMs(response, attempt);
        if (response.body) {
          try {
            await response.body.cancel();
          } catch {
            // ignore body-cancel races
          }
        }
        this._penalizeHost(host);
        this.emit("log", {
          level: "warning",
          message: `${host} returned ${response.status}; backing off ${wait}ms (retry ${attempt + 1}/${this.options.maxRetries})`,
        });
        await this._delay(wait, signal);
        attempt += 1;
        continue;
      }
      return response;
    }
  }

  async _process(job) {
    if (
      !job.external &&
      this.options.respectRobots &&
      !isAllowedByRobots(job.url, this.robotsRules)
    ) {
      const blocked = emptyResult(job, {
        statusText: "Blocked by robots.txt",
        indexability: "Non-indexable",
        indexabilityReason: "Blocked by robots.txt",
        issues: [
          {
            id: job.isAsset ? "blocked-resource" : "robots-blocked",
            label: job.isAsset ? "Blocked internal resource" : "Page blocked from crawling",
            severity: "warning",
            category: job.isAsset ? "Technical" : "Indexability",
          },
        ],
      });
      this.results.push(blocked);
      this.emit("result", blocked);
      return;
    }

    const started = performance.now();
    let result;

    try {
      const response = await this._politeFetch(
        job.url,
        {
          redirect: "manual",
          headers: {
            "User-Agent": this.options.userAgent,
            Accept: job.external
              ? "*/*"
              : "text/html,application/xhtml+xml,application/xml,text/css,application/javascript;q=0.9,*/*;q=0.7",
            "Accept-Language": "en-US,en;q=0.8",
          },
        },
        { timeout: this.options.timeout, signal: this.rootController.signal },
      );

      const responseTime = Math.round(performance.now() - started);
      const contentType = headerValue(response.headers, "content-type")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const redirectLocation = classifyRedirectLocation({
        status: response.status,
        headerPresent: response.headers.has("location"),
        rawValue: response.headers.get("location") ?? "",
        responseUrl: job.url,
      });
      const redirectUrl =
        redirectLocation.kind === "valid" ? redirectLocation.url : "";
      const contentLength = Number(headerValue(response.headers, "content-length")) || 0;
      const canRead =
        !job.external &&
        (!contentLength || contentLength <= MAX_BODY_BYTES) &&
        (contentType.includes("html") || TEXT_ASSET.test(contentType));
      let body = "";
      if (canRead) body = await response.text();
      else if (response.body) await response.body.cancel();

      result = this._extract({
        job,
        response,
        body,
        contentType,
        contentLength,
        responseTime,
        redirectUrl,
        redirectLocation,
      });

      const declarativeRefresh = declarativeRefreshFromResult(result);
      if (
        declarativeRefresh &&
        !declarativeRefresh.isReload &&
        !job.external &&
        this.mode !== "list"
      ) {
        const crawlTarget = normalizeUrl(declarativeRefresh.url);
        if (
          crawlTarget &&
          crawlTarget !== job.url &&
          this._inScope(crawlTarget, job)
        ) {
          this._enqueueInternal(crawlTarget, job.depth + 1, job.url);
        }
      }

      if (
        redirectUrl &&
        redirectUrl !== job.url &&
        !job.external &&
        this.mode !== "list" &&
        this._inScope(redirectUrl)
      ) {
        this._enqueueInternal(redirectUrl, job.depth + 1, job.url);
      }
    } catch (error) {
      const aborted = error.name === "AbortError" || error.name === "TimeoutError";
      // A stop() abort is intentional — drop the job silently.
      if (this.stopped && aborted) return;
      const timedOut = error.name === "TimeoutError";
      result = emptyResult(job, {
        statusText: timedOut ? "Timed out" : cleanText(error.message),
        responseTime: Math.round(performance.now() - started),
        indexability: job.external ? "External" : "Unknown",
        indexabilityReason: timedOut ? "Request timed out" : "Fetch failed",
      });
      result.issues = quickIssues(result);
    }

    this.results.push(result);
    this.emit("result", result);
  }

  _extract({
    job,
    response,
    body,
    contentType,
    contentLength,
    responseTime,
    redirectUrl,
    redirectLocation,
  }) {
    const cacheControl = headerValue(response.headers, "cache-control");
    const expires = Date.parse(headerValue(response.headers, "expires"));
    const maxAge = /max-age=(\d+)/i.exec(cacheControl);
    const cacheable =
      cacheControl.includes("immutable") ||
      (maxAge && Number(maxAge[1]) > 0) ||
      (Number.isFinite(expires) && expires > Date.now());
    const isAsset =
      job.isAsset ||
      (!contentType.includes("text/html") && !contentType.includes("xhtml"));
    const refreshHeaderValue = headerValue(response.headers, "refresh");
    const refreshHeader =
      !job.external &&
      contentType.includes("html") &&
      response.status >= 200 &&
      response.status < 300 &&
      refreshHeaderValue
        ? parseMetaRefresh(refreshHeaderValue, job.url, job.url)
        : null;
    const base = emptyResult(job, {
      status: response.status,
      statusText: response.statusText,
      contentType,
      size: contentLength || Buffer.byteLength(body),
      responseTime,
      isAsset,
      indexability: job.external
        ? "External"
        : response.status >= 200 && response.status < 300
          ? "Indexable"
          : "Non-indexable",
      indexabilityReason:
        job.external || (response.status >= 200 && response.status < 300)
          ? ""
          : `HTTP status ${response.status}`,
      inlinks: this.inlinkCounts.get(job.url) || 0,
      redirectUrl,
      locationHeaderRaw: redirectLocation.raw,
      locationHeaderPresent: redirectLocation.headerPresent,
      redirectLocationIssue: ["missing", "malformed", "non-http"].includes(
        redirectLocation.kind,
      )
        ? redirectLocation.kind
        : "",
      redirectLocationScheme: redirectLocation.scheme,
      cacheControl,
      cacheable: Boolean(cacheable),
      contentEncoding: headerValue(response.headers, "content-encoding"),
      strictTransportSecurity: headerValue(response.headers, "strict-transport-security"),
      refreshHeaderRaw: refreshHeader?.raw || "",
      refreshHeaderDelay: refreshHeader?.delay ?? null,
      refreshHeaderDelayRaw: refreshHeader?.delayRaw || "",
      refreshHeaderDelayOverflow: Boolean(refreshHeader?.delayOverflow),
      refreshHeaderTargetRaw: refreshHeader?.targetRaw || "",
      refreshHeaderUrl: refreshHeader?.url || "",
      refreshHeaderIsReload: Boolean(refreshHeader?.isReload),
      unminified:
        TEXT_ASSET.test(contentType) &&
        !contentType.includes("html") &&
        body.length > 500 &&
        body.includes("\n") &&
        body.length > body.replace(/\s+/g, "").length * 1.12,
    });

    const trackResource = (edge) => {
      this.resourceEdges.push(edge);
      if (!edge.targetUrl) return;
      if (
        this.mode !== "list" &&
        this.options.crawlAssets &&
        edge.fetchAsset !== false &&
        this._inScope(edge.targetUrl, job)
      ) {
        this._enqueueInternal(edge.targetUrl, job.depth + 1, job.url, {
          isAsset: true,
        });
      }
    };
    const trackCssReferences = (
      css,
      {
        sourceUrl = job.url,
        baseUrl = job.url,
        owner = "CSS stylesheet",
        attributePrefix = "",
        allowImports = true,
        documentBase = null,
      } = {},
    ) => {
      for (const reference of cssResourceReferences(css, { allowImports })) {
        if (SKIP_SCHEMES.test(reference.raw)) continue;
        const targetUrl = normalizeUrl(reference.raw, baseUrl);
        if (!targetUrl) continue;
        const sourceAttribute = attributePrefix
          ? `${attributePrefix} ${reference.kind}`
          : reference.kind;
        trackResource({
          sourceUrl,
          targetUrl,
          tag: "css",
          sourceAttribute,
          elementHint: cssReferenceHint(
            owner,
            reference,
            attributePrefix,
          ),
          ...documentBaseMetadata(reference.raw, documentBase),
        });
      }
    };

    if (
      body &&
      !job.external &&
      contentType.includes("css") &&
      response.status >= 200 &&
      response.status < 300
    ) {
      trackCssReferences(body);
    }

    // A non-2xx response's body (if any — some redirects ship an HTML fallback
    // like "if you are not redirected, click here") is infrastructure
    // boilerplate, not real page content. Parsing it for links/canonical/
    // hreflang/pagination produces noise (confirmed via calibration: a
    // redirect's fallback link text was flagged as "non-descriptive anchor
    // text" as if an editor had written it). The redirect itself is already
    // fully represented by status/redirectUrl.
    if (
      !body ||
      job.external ||
      !contentType.includes("html") ||
      response.status < 200 ||
      response.status >= 300
    ) {
      base.issues = quickIssues(base);
      return base;
    }

    const $ = cheerio.load(body);
    // Ordinary template contents belong to a separate DocumentFragment with
    // no browsing context. Removing those roots once keeps every downstream
    // selector from treating dormant markup as document content or a fetch.
    // Declarative-shadow templates are retained because their contents can be
    // attached as a live shadow tree by the HTML parser.
    const inertTemplateCount = pruneInertTemplates($);
    const documentBase = documentBaseFromPage(
      $,
      job.url,
      headerValue(response.headers, "content-security-policy"),
    );
    const metaRefresh = refreshHeader
      ? null
      : metaRefreshFromPage(
          $,
          job.url,
          headerValue(response.headers, "content-security-policy"),
        );
    const titleElements = documentElements($, "title");
    const title = cleanText(titleElements.first().text());
    const metaDescription = cleanText(
      documentElements($, 'meta[name="description" i]')
        .first()
        .attr("content") || "",
    );
    const viewport = cleanText(
      documentElements($, 'meta[name="viewport" i]')
        .first()
        .attr("content") || "",
    );
    const robots = cleanText(
      documentElements($, 'meta[name="robots" i]').first().attr("content") ||
        headerValue(response.headers, "x-robots-tag"),
    );
    const canonical =
      normalizeUrl(
        documentElements($, 'link[rel~="canonical" i]')
          .first()
          .attr("href") || "",
        documentBase.url,
      ) || "";
    const hreflangs = documentElements(
      $,
      'link[rel~="alternate" i][hreflang]',
    )
      .map((_, element) => ({
        lang: ($(element).attr("hreflang") || "").trim().toLowerCase(),
        url:
          normalizeUrl(
            $(element).attr("href") || "",
            documentBase.url,
          ) || "",
      }))
      .get()
      .filter((entry) => entry.lang && entry.url);
    const paginationNext =
      normalizeUrl(
        documentElements($, 'link[rel~="next" i]')
          .first()
          .attr("href") || "",
        documentBase.url,
      ) || "";
    const paginationPrev =
      normalizeUrl(
        documentElements(
          $,
          'link[rel~="prev" i], link[rel~="previous" i]',
        )
          .first()
          .attr("href") || "",
        documentBase.url,
      ) || "";
    const h1Values = $("h1")
      .map((_, element) => cleanText($(element).text()))
      .get()
      .filter(Boolean);
    const h2Values = $("h2")
      .map((_, element) => cleanText($(element).text()))
      .get()
      .filter(Boolean);
    const bodyClone = $("body").clone();
    bodyClone.find("base, link, meta, script, style, noscript, svg, title").remove();
    // Cheerio's `.text()` concatenates adjacent elements without a separator
    // (`</h1><p>` becomes `HeadingParagraph`). Add boundaries after block-like
    // elements before whitespace normalization so samples stay readable and
    // word counts do not merge the last/first words of neighboring elements.
    bodyClone
      .find(
        "address, article, aside, blockquote, br, dd, div, dl, dt, fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, td, th, tr, ul",
      )
      .after(" ");
    const visibleText = cleanText(bodyClone.text());
    const words = visibleText ? visibleText.split(/\s+/).length : 0;
    const links = new Set();
    let externalLinks = 0;
    const headings = $("h1,h2,h3,h4,h5,h6")
      .map((_, element) => ({
        level: Number(element.tagName.slice(1)),
        text: cleanText($(element).text()),
      }))
      .get();
    const headingHierarchyIssues = headings
      .slice(1)
      .map((heading, index) => {
        const previous = headings[index];
        if (heading.level <= previous.level + 1) return null;
        return {
          fromLevel: previous.level,
          fromText: previous.text,
          toLevel: heading.level,
          toText: heading.text,
        };
      })
      .filter(Boolean);
    const headingHierarchyIssue = headingHierarchyIssues.length > 0;
    const labelledTextById = new Map();
    $("[id]").each((_, element) => {
      const id = ($(element).attr("id") || "").trim();
      if (id) labelledTextById.set(id, cleanText($(element).text()));
    });
    const resolveLabelledBy = (value) =>
      cleanText(
        String(value || "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => labelledTextById.get(id) || "")
          .join(" "),
      );
    const isHiddenFromAccessibilityTree = (element) =>
      $(element).closest('[aria-hidden="true"], [hidden]').length > 0;

    $("a[href]").each((_, element) => {
      const link = $(element);
      const href = (link.attr("href") || "").trim();
      if (!href || SKIP_SCHEMES.test(href)) return;
      const normalized = normalizeUrl(href, documentBase.url);
      if (!normalized) return;
      const internal = this._inScope(normalized, job);
      const rel = (link.attr("rel") || "").toLowerCase();
      const relTokens = rel.split(/[\s,]+/).filter(Boolean);
      const textClone = link.clone();
      textClone
        .find(
          '[aria-hidden="true"], [hidden], script, style, svg title, svg desc',
        )
        .remove();
      const anchorText = cleanText(textClone.text());
      const descendantAriaLabel = link
        .find("[aria-label]")
        .filter((_, child) => !isHiddenFromAccessibilityTree(child))
        .map((_, child) => cleanText($(child).attr("aria-label")))
        .get()
        .find(Boolean);
      const descendantLabelledBy = link
        .find("[aria-labelledby]")
        .filter((_, child) => !isHiddenFromAccessibilityTree(child))
        .map((_, child) => resolveLabelledBy($(child).attr("aria-labelledby")))
        .get()
        .find(Boolean);
      const imageAlt = link
        .find("img[alt]")
        .filter((_, image) => !isHiddenFromAccessibilityTree(image))
        .map((_, image) => cleanText($(image).attr("alt")))
        .get()
        .find(Boolean);
      const svgTitle = link
        .find("svg title")
        .filter((_, titleElement) => !isHiddenFromAccessibilityTree(titleElement))
        .map((_, titleElement) => cleanText($(titleElement).text()))
        .get()
        .find(Boolean);
      const accessibleName = [
        resolveLabelledBy(link.attr("aria-labelledby")),
        cleanText(link.attr("aria-label")),
        descendantAriaLabel,
        descendantLabelledBy,
        imageAlt,
        svgTitle,
        cleanText(link.attr("title")),
      ].find(Boolean) || "";
      const images = link.find("img");
      const elementHint = images.length
        ? images.toArray().every((image) => $(image).attr("alt") === "")
          ? "Image link with empty alt text"
          : "Image link without an accessible label"
        : link.find("svg").length
          ? "SVG/icon link without an accessible label"
          : "Empty or CSS-only link without an accessible label";
      links.add(normalized);
      this.linkEdges.push({
        sourceUrl: job.url,
        targetUrl: normalized,
        internal,
        nofollow: relTokens.includes("nofollow"),
        rel,
        download: link.is("[download]"),
        anchorText,
        accessibleName,
        elementHint,
        tag: "a",
        ...documentBaseMetadata(href, documentBase),
      });
      if (internal) {
        // List mode reports link edges (for broken-link findings) but never
        // expands the crawl beyond the URLs it was given.
        if (this.mode !== "list") {
          this._enqueueInternal(normalized, job.depth + 1, job.url, {
            isAsset: ASSET_EXTENSIONS.test(normalized),
          });
        }
      } else {
        externalLinks += 1;
        if (this.mode !== "list" && this.options.checkExternalLinks) {
          this._enqueueExternal(normalized, job.url);
        }
      }
    });

    $("img").each((_, element) => {
      const source = imageSourceFromElement(
        $,
        element,
        documentBase.url,
      );
      if (!source) return;
      const image = $(element);
      const role = cleanText(image.attr("role")).toLowerCase();
      const sourceElement = source.element || element;
      const resourceAttribute =
        source.resourceAttribute || source.attribute;
      const resourceSource = {
        attribute: resourceAttribute,
        raw: source.raw,
      };
      trackResource({
        sourceUrl: job.url,
        targetUrl: source.url,
        tag: "img",
        alt: image.attr("alt"),
        auditAlt: true,
        altExempt:
          ["none", "presentation"].includes(role) ||
          image.closest('[aria-hidden="true" i], [hidden]').length > 0,
        sourceAttribute: resourceAttribute,
        elementHint: resourceElementHint(
          $,
          sourceElement,
          resourceSource,
        ),
        altElementHint: imageElementHint($, element, source),
        ...documentBaseMetadata(source.raw, documentBase),
      });

      for (const candidate of imageResourceSourcesFromElement(
        $,
        element,
        documentBase.url,
      )) {
        const isPrimary =
          candidate.element === sourceElement &&
          candidate.attribute === resourceAttribute &&
          candidate.raw === source.raw &&
          candidate.url === source.url;
        if (isPrimary) continue;
        trackResource({
          sourceUrl: job.url,
          targetUrl: candidate.url,
          tag: "img",
          auditAlt: false,
          fetchAsset: false,
          sourceAttribute: candidate.attribute,
          elementHint: resourceElementHint($, candidate.element, candidate),
          ...documentBaseMetadata(candidate.raw, documentBase),
        });
      }
    });

    const trackElementResource = (selector, attribute, predicate = () => true) => {
      $(selector).each((_, element) => {
        if (!predicate(element)) return;
        const raw = ($(element).attr(attribute) || "").trim();
        if (!raw || SKIP_SCHEMES.test(raw)) return;
        const normalized = normalizeUrl(raw, documentBase.url);
        if (!normalized) return;
        const source = { attribute, raw };
        trackResource({
          sourceUrl: job.url,
          targetUrl: normalized,
          tag: element.tagName.toLowerCase(),
          sourceAttribute: attribute,
          elementHint: resourceElementHint($, element, source),
          ...documentBaseMetadata(raw, documentBase),
        });
      });
    };

    trackElementResource(
      "script[src], iframe[src], frame[src], embed[src], audio[src], video[src], audio source[src], video source[src], track[src], input[type='image' i][src]",
      "src",
    );
    trackElementResource("object[data]", "data");
    trackElementResource("video[poster]", "poster");
    trackElementResource("link[href]", "href", (element) => {
      const relTokens = cleanText($(element).attr("rel"))
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      return relTokens.some((token) => LINK_SUBRESOURCE_RELS.has(token));
    });

    $("style").each((_, element) => {
      const type = cleanText($(element).attr("type")).toLowerCase();
      if (type && type !== "text/css") return;
      trackCssReferences($(element).html() || "", {
        baseUrl: documentBase.url,
        documentBase,
        owner: resourceElementIdentity($, element),
      });
    });
    $("[style]").each((_, element) => {
      trackCssReferences($(element).attr("style") || "", {
        baseUrl: documentBase.url,
        documentBase,
        owner: resourceElementIdentity($, element),
        attributePrefix: "style",
        allowImports: false,
      });
    });

    const lowerRobots = robots.toLowerCase();
    const nonIndexableDirective =
      lowerRobots.includes("noindex") || lowerRobots.includes("none");
    const openGraph = Object.fromEntries(
      OPEN_GRAPH_PROPERTIES.map((property) => [
        property,
        cleanText(
          documentElements($, `meta[property="${property}" i]`)
            .first()
            .attr("content") || "",
        ),
      ]),
    );
    const openGraphImage = primaryOpenGraphImage($);
    const hasOpenGraphImage = Boolean(openGraphImage.value);
    const openGraphImageUrl = normalizeUrl(openGraphImage.value) || "";
    const ogUrl = normalizeUrl(openGraph["og:url"]) || "";
    const openGraphInvalidUrls = [
      openGraph["og:url"] && !ogUrl
        ? { property: "og:url", value: openGraph["og:url"] }
        : null,
      openGraphImage.value && !openGraphImageUrl
        ? {
            property: openGraphImage.property,
            value: openGraphImage.value,
          }
        : null,
    ].filter(Boolean);

    Object.assign(base, {
      title,
      titleCount: titleElements.length,
      titleLength: title.length,
      metaDescription,
      metaLength: metaDescription.length,
      viewport,
      h1Count: $("h1").length,
      h1: h1Values.join(" | "),
      h2Count: $("h2").length,
      h2: h2Values.join(" | "),
      words,
      textHtmlRatio: body.length ? visibleText.length / body.length : 0,
      headingHierarchyIssue,
      headingHierarchyIssues,
      indexability: nonIndexableDirective ? "Non-indexable" : base.indexability,
      indexabilityReason: nonIndexableDirective
        ? "Meta robots contains noindex"
        : base.indexabilityReason,
      canonical,
      hreflangs,
      paginationNext,
      paginationPrev,
      robots,
      outlinks: links.size,
      externalLinks,
      hash: crypto.createHash("sha1").update(visibleText).digest("hex"),
      contentSample:
        visibleText.length > 240 ? `${visibleText.slice(0, 240)}…` : visibleText,
      openGraphMissing: REQUIRED_OPEN_GRAPH.filter((property) =>
        property === "og:image"
          ? !hasOpenGraphImage
          : !openGraph[property],
      ),
      openGraphInvalidUrls,
      openGraphImageProperty: openGraphImage.property,
      openGraphImageUrl,
      openGraphImageRaw: openGraphImage.value,
      openGraphImageAlt: openGraphImage.alt,
      openGraphImageAltMissing: Boolean(
        openGraphImageUrl && !openGraphImage.alt,
      ),
      openGraphDescriptionMissing: !openGraph["og:description"],
      ogUrlRaw: openGraph["og:url"],
      ogUrl,
      schemaErrors: schemaErrorsFromPage($),
      baseHrefRaw: documentBase.raw,
      documentBaseUrl: documentBase.url,
      documentBaseFallbackReason: documentBase.fallbackReason,
      documentBasePolicyEvidence: documentBase.policyEvidence,
      inertTemplateCount,
      metaRefreshRaw: metaRefresh?.raw || "",
      metaRefreshDelay: metaRefresh?.delay ?? null,
      metaRefreshDelayRaw: metaRefresh?.delayRaw || "",
      metaRefreshDelayOverflow: Boolean(metaRefresh?.delayOverflow),
      metaRefreshTargetRaw: metaRefresh?.targetRaw || "",
      metaRefreshUrl: metaRefresh?.url || "",
      metaRefreshIsReload: Boolean(metaRefresh?.isReload),
    });
    base.issues = quickIssues(base);
    return base;
  }
}

module.exports = {
  SeoCrawler,
  normalizeUrl,
  parseRobots,
  isAllowedByRobots,
};
