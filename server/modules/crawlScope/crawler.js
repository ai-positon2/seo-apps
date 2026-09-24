const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const cheerio = require("cheerio");
const { buildFindings } = require("./analyzer");
const { renderSample, renderHtml, launchBrowser } = require("./render-check");
const { contentSignature } = require("./text-fingerprint");
// Pages with less main text than this are not fingerprinted: too little of
// their own to be a duplicate of anything.
const NEAR_DUPLICATE_MIN_WORDS = 50;
// Browser tabs rendering at once when a crawl renders every page.
const RENDER_SLOTS = 2;
const { cssResourceReferences } = require("./css-resource-parser");
const { evaluateBaseUri } = require("./csp-base-uri");
const {
  classifyRedirectLocation,
  isRedirectStatus,
} = require("./http-redirect");
const { parseMetaRefresh } = require("./meta-refresh");
const { createUrlIdentity, normalizeUrl } = require("./url-identity");
const {
  auditAgents,
  isNoindex,
  robotsDirectivesFor,
  robotsProductToken,
} = require("./robots-directives");
const integrationCatalog = require("./integration-catalog.json");

// The "+" in a bot User-Agent is the de-facto marker for an info URL an operator
// can open to identify and allowlist the crawler; prose after it tells a site
// admin reading their logs nothing. CRAWL_INFO_URL lets a deployment point at its
// own page without a code change.
const USER_AGENT_INFO_URL =
  process.env.CRAWL_INFO_URL || "https://github.com/position2/crawlscope-bot";
const USER_AGENT = `CrawlScope/1.1 (+${USER_AGENT_INFO_URL})`;
// What robots.txt groups are matched against, whatever User-Agent string a
// crawl sends: a smartphone profile's string starts "Mozilla/5.0", and its
// first word must not decide which rules CrawlScope obeys.
const ROBOTS_TOKEN = "crawlscope";
// The User-Agent a crawl sends. "mobile" is a current Chrome-on-Android string
// with CrawlScope's own token in it, for sites that serve phones different
// markup — which is what Google's smartphone crawler indexes.
const USER_AGENT_PROFILES = {
  desktop: USER_AGENT,
  mobile:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
    `Chrome/129.0.0.0 Mobile Safari/537.36 (compatible; CrawlScope/1.1; +${USER_AGENT_INFO_URL})`,
};
const SKIP_SCHEMES = /^(mailto:|tel:|javascript:|data:|blob:)/i;
const ASSET_EXTENSIONS =
  /\.(?:avif|bmp|css|eot|gif|ico|jpe?g|js|json|map|mp3|mp4|ogg|otf|pdf|png|svg|tiff?|ttf|wav|webm|webp|woff2?|xml|zip)(?:$|\?)/i;
const TEXT_ASSET = /(?:javascript|json|css|xml|text\/)/i;
const MAX_BODY_BYTES = 5_000_000;
// The sitemap protocol's per-file limits: 50 MB uncompressed and 50,000 URLs.
// Sitemaps are read up to the first (a page's 5 MB would cut a legal sitemap
// short) and a file past either is reported, since search engines reject it.
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;
const MAX_SITEMAP_URLS = 50_000;
// All sitemap files of one crawl together. Per-file limits alone would let 200
// documents of 50 MB each be 10 GB; this keeps the old worst case (200 files at
// the old 5 MB), while any one legal sitemap is still read whole.
const MAX_SITEMAP_TOTAL_BYTES = 1_000_000_000;
// Duration of the network request that produced each Response, recorded in
// _politeFetch. A WeakMap so a response carries its timing without the crawler
// mutating objects it does not own, and without retaining them.
const RESPONSE_TIMINGS = new WeakMap();
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

// An integer option with a real default. `Number(x) || fallback` turns an
// explicit 0 into the fallback, and `Number(x) ?? fallback` never falls back at
// all (Number() never returns null), so neither is safe for options where 0 is
// meaningful or where the option is usually absent.
function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

// Headings are joined into one field for the report. Unbounded, a page with
// hundreds of them stored an arbitrarily large string that was then retained for
// the whole crawl in this.results AND written into crawl_run_results.data.
const MAX_JOINED_HEADINGS = 25;
const MAX_JOINED_HEADING_CHARS = 2_000;

function joinHeadings(values) {
  const joined = values.slice(0, MAX_JOINED_HEADINGS).join(" | ");
  const suffix =
    values.length > MAX_JOINED_HEADINGS
      ? ` | …(+${values.length - MAX_JOINED_HEADINGS} more)`
      : "";
  const full = `${joined}${suffix}`;
  return full.length > MAX_JOINED_HEADING_CHARS
    ? `${full.slice(0, MAX_JOINED_HEADING_CHARS)}…`
    : full;
}

// ── Character encoding ──────────────────────────────────────────────────────
// Response.text() runs the Fetch spec's "UTF-8 decode" unconditionally — it
// ignores the charset parameter it was served with. Every windows-1252 or
// ISO-8859-1 page therefore came back with U+FFFD where its punctuation and
// accented characters had been, which corrupted the title, meta description,
// every heading, all anchor text, and the content hash used for duplicate
// detection. Decoding has to be done from the bytes.
const LABEL_ALIASES = new Map([
  ["latin1", "windows-1252"],
  ["iso-8859-1", "windows-1252"],
  ["iso8859-1", "windows-1252"],
  ["us-ascii", "windows-1252"],
  ["ascii", "windows-1252"],
  ["utf8", "utf-8"],
  ["shift-jis", "shift_jis"],
  ["sjis", "shift_jis"],
]);

function canonicalCharset(label) {
  const cleaned = String(label || "").trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!cleaned) return "";
  return LABEL_ALIASES.get(cleaned) || cleaned;
}

function charsetFromContentType(headerValueRaw) {
  const match = /charset\s*=\s*("[^"]*"|'[^']*'|[^;\s]+)/i.exec(String(headerValueRaw || ""));
  return match ? canonicalCharset(match[1]) : "";
}

// The <meta charset> sniff the HTML spec prescribes: only the first 1024 bytes
// are examined, decoded as latin-1 so no byte sequence can throw.
function charsetFromMeta(buffer) {
  const head = buffer.subarray(0, 1024).toString("latin1");
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head);
  if (metaCharset) return canonicalCharset(metaCharset[1]);
  const httpEquiv =
    /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["']([^"']+)["']/i.exec(head);
  return httpEquiv ? charsetFromContentType(httpEquiv[1]) : "";
}

function charsetFromBom(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return "utf-8";
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return "utf-16le";
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return "utf-16be";
  return "";
}

// A leading HTML signature, for responses that arrive with no Content-Type at
// all. Without this they were stored as unparsed binary assets: no title, no
// links, no canonical, and excluded from every HTML check in the analyzer.
function looksLikeHtml(buffer) {
  const head = buffer.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<?xml") ||
    /^<(?:head|body|meta|title|script|div)\b/.test(head)
  );
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

// The text a reader sees in <body>: markup, scripts, styles and inline SVG
// removed, with a boundary after block elements so adjacent blocks do not fuse
// into one word. Shared by page extraction and the missing-page probe, whose
// fingerprints are compared.
// Cheerio's `.text()` concatenates adjacent elements without a separator
// (`</h1><p>` becomes `HeadingParagraph`). Boundaries go after block-like
// elements before whitespace normalization so samples stay readable and word
// counts do not merge the last/first words of neighboring elements.
const BLOCK_ELEMENTS =
  "address, article, aside, blockquote, br, dd, div, dl, dt, fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, td, th, tr, ul";

function visibleTextOf($) {
  const bodyClone = $("body").clone();
  bodyClone.find("base, link, meta, script, style, noscript, svg, title").remove();
  bodyClone.find(BLOCK_ELEMENTS).after(" ");
  return cleanText(bodyClone.text());
}

// The page's own content: <main> (or role=main) when the page marks it, else
// the body without the navigation, header, footer and sidebars every page of
// the template repeats. Two pages that differ only in those are the same page
// for near-duplicate purposes, and two whose main text differs are not, whatever
// the template around them shares.
function mainContentTextOf($) {
  const main = $("main, [role='main']").first();
  const clone = (main.length ? main : $("body")).clone();
  clone
    .find("base, link, meta, script, style, noscript, svg, title, template, nav, aside, [role='navigation'], [role='complementary']")
    .remove();
  if (!main.length) clone.find("header, footer, [role='banner'], [role='contentinfo']").remove();
  clone.find(BLOCK_ELEMENTS).after(" ");
  return cleanText(clone.text());
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

// <svg> and <math> are foreign content: they have their own element namespace
// in which <title> means "accessible label for this graphic", not "title of
// this document". Nothing document-level (title, meta description, hreflang)
// is ever legitimately inside one.
//
// Filtering only template contents let SVG chart labels count as document
// titles: iana.org's /performance carries one real <title> and 48 <title>
// elements inside inline charts reading "August 2025: 100%", and title-multiple
// fired on titleCount 49. Fixed here rather than at the `title` call site, so
// the next selector added to this helper does not inherit the same trap.
function isInForeignContent(element) {
  let ancestor = element?.parent;
  while (ancestor) {
    if (ancestor.type === "tag") {
      const tag = String(ancestor.tagName || ancestor.name).toLowerCase();
      if (tag === "svg" || tag === "math") return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

function documentElements($, selector) {
  return $(selector).filter(
    (_, element) => !isInTemplateContents(element) && !isInForeignContent(element),
  );
}

// The hard guard `buildFindings` is invoked behind — issue-catalog.json's
// `requiresCompleteGraph` checks (broken-internal-links, the duplicate-*
// checks, orphan-page, canonical-*, etc.) are only correct evaluated against
// the WHOLE crawl, and today that's true only because this crawler's single
// call site (below, in `_schedule()`) happens to sit behind the right `if`.
// This makes that a throw, not a convention: exported and unit-testable on
// its own (see crawler.test.js's phase-ordering test) so a future refactor
// that loosens the call site's condition fails loudly instead of quietly
// starting to evaluate cross-page checks against a partial result set.
function assertGraphReady({ queueLength, active, stopped }) {
  if (!stopped && queueLength !== 0) {
    throw new Error(
      `Refusing to evaluate requiresCompleteGraph checks: ${queueLength} URL(s) still queued and the crawl was not stopped.`,
    );
  }
  if (active !== 0) {
    throw new Error(
      `Refusing to evaluate requiresCompleteGraph checks: ${active} fetch(es) still in flight.`,
    );
  }
}

// Third-party tag/integration detection — a static signature match against
// integration-catalog.json, not real execution: this crawler parses served
// HTML, it doesn't run JavaScript, so "when it fires" is scoped honestly to
// what's actually visible here — placement (head/body) and loading strategy
// (async/defer/sync) — not a claim about runtime timing.
//
// A vendor's tag manager or analytics snippet is usually INLINE (GTM's and
// Universal Analytics' classic embed snippets both are), so both external
// `src` and inline script bodies are checked against the catalog, plus
// `iframe[src]` for the handful of vendors (YouTube, Google Maps) that
// embed via an iframe rather than a script. One entry per distinct vendor
// per page — the first matching element decides its recorded location/
// loading, later matches for an already-found vendor are skipped.
function detectIntegrations($, catalog) {
  const found = new Map(); // vendor id -> {id, location, loading}

  const consider = (haystack, kind, element) => {
    if (!haystack) return;
    for (const vendor of catalog) {
      if (found.has(vendor.id)) continue;
      const patterns = kind === "src" ? vendor.srcPatterns : vendor.inlinePatterns;
      if (!patterns?.length) continue;
      if (!patterns.some((pattern) => haystack.includes(pattern))) continue;
      const location = $(element).closest("head").length ? "head" : "body";
      // async/defer only mean anything for an externally-sourced script; an
      // inline script always runs synchronously as the parser reaches it,
      // and an iframe has no such attribute to read — both fall through to
      // "sync" here, which is accurate for both cases.
      const loading =
        kind === "src" && $(element).is("[async]")
          ? "async"
          : kind === "src" && $(element).is("[defer]")
            ? "defer"
            : "sync";
      found.set(vendor.id, { id: vendor.id, location, loading });
    }
  };

  documentElements($, "script").each((_, element) => {
    const src = $(element).attr("src");
    if (src) consider(src, "src", element);
    else consider($(element).html(), "inline", element);
  });

  documentElements($, "iframe[src]").each((_, element) => {
    consider($(element).attr("src"), "src", element);
  });

  return [...found.values()];
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

const XML_NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// One pass over the input, never over its own output. The old chained
// .replace() calls resolved "&amp;" first, so "&amp;lt;" decoded to "&lt;" and
// then to "<" — double-decoding text the publisher escaped on purpose. Numeric
// references (&#38;, &#x2F;) were not handled at all, so a <loc> containing one
// either produced the wrong URL or failed normalizeUrl and dropped the page.
function decodeXml(value = "") {
  return String(value).replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi,
    (match, hex, decimal, name) => {
      if (hex !== undefined || decimal !== undefined) {
        const code = Number.parseInt(hex ?? decimal, hex !== undefined ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
        // Lone surrogates are not scalar values and String.fromCodePoint
        // accepts them; keep the reference literal rather than emitting one.
        if (code >= 0xd800 && code <= 0xdfff) return match;
        return String.fromCodePoint(code);
      }
      return XML_NAMED_ENTITIES[name.toLowerCase()] ?? match;
    },
  );
}

function headerValue(headers, name) {
  return headers.get(name) || "";
}

// RFC 8288 Link header, far enough to read rel=canonical / rel=alternate.
// Splitting on "," is safe only outside <>, because a URI-Reference may contain
// one; the scan tracks that rather than assuming it does not.
function parseLinkHeader(value) {
  const raw = String(value || "");
  if (!raw.trim()) return [];
  const entries = [];
  let depth = 0;
  let start = 0;
  const segments = [];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "<") depth += 1;
    else if (character === ">") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      segments.push(raw.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(raw.slice(start));

  for (const segment of segments) {
    const match = /<([^>]*)>\s*(.*)$/s.exec(segment.trim());
    if (!match) continue;
    const url = match[1].trim();
    if (!url) continue;
    const params = match[2];
    const rel = /;\s*rel\s*=\s*("([^"]*)"|'([^']*)'|[^;,\s]+)/i.exec(params);
    const hreflang = /;\s*hreflang\s*=\s*("([^"]*)"|'([^']*)'|[^;,\s]+)/i.exec(params);
    const relValue = rel ? (rel[2] ?? rel[3] ?? rel[1]) : "";
    entries.push({
      url,
      rels: relValue.toLowerCase().split(/\s+/).filter(Boolean),
      hreflang: hreflang ? (hreflang[2] ?? hreflang[3] ?? hreflang[1]) : "",
    });
  }
  return entries;
}

// Robots directives (meta robots / X-Robots-Tag) are parsed in
// robots-directives.js, shared with the analyzer so the two can never disagree
// about whether a page is noindex.

// Returns { rules, crawlDelay } for the group that applies to `userAgent`.
//
// Group selection follows RFC 9309: the MOST SPECIFIC matching group wins, and
// only that one group's rules apply. The previous implementation collected every
// group whose name was a substring of the agent and concatenated all of their
// rules, so a robots.txt with separate CrawlScope and Crawl groups had both
// enforced at once.
//
// `exact`: only a group naming exactly this token (or "*") applies, the way
// Google matches Googlebot. Substring matching would read a Googlebot-News or
// Googlebot-Image group as addressed to Googlebot itself.
function parseRobots(content, userAgent = "crawlscope", { exact = false } = {}) {
  const groups = [];
  let agents = [];
  let rules = [];
  let crawlDelay = null;

  const flush = () => {
    if (agents.length) groups.push({ agents, rules, crawlDelay });
    agents = [];
    rules = [];
    crawlDelay = null;
  };

  for (const sourceLine of String(content).split(/\r?\n/)) {
    const line = sourceLine.split("#")[0].trim();
    if (!line || !line.includes(":")) continue;
    const separator = line.indexOf(":");
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      // A user-agent line after any rule line starts a NEW group; consecutive
      // user-agent lines share one.
      if (rules.length || crawlDelay !== null) flush();
      agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && agents.length) {
      if (value || key === "allow") rules.push({ type: key, pattern: value });
    } else if (key === "crawl-delay" && agents.length) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) crawlDelay = seconds;
    }
  }
  flush();

  const token = robotsProductToken(userAgent) || "crawlscope";
  let best = null;
  let bestLength = -1;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === "*") continue;
      // Either side may be the more specific spelling: robots.txt may name
      // "crawlscope" while the header is "CrawlScope/1.1", or name a longer
      // vendor string that contains our token.
      if (exact ? agent !== token : !token.includes(agent) && !agent.includes(token)) continue;
      if (agent.length > bestLength) {
        bestLength = agent.length;
        best = group;
      }
    }
  }
  if (!best) {
    // Every wildcard group merged, because a file may legitimately repeat
    // "User-agent: *" and all of those rules are addressed to us.
    const wildcard = groups.filter((group) => group.agents.includes("*"));
    if (wildcard.length) {
      best = {
        rules: wildcard.flatMap((group) => group.rules),
        crawlDelay: wildcard
          .map((group) => group.crawlDelay)
          .filter((value) => value !== null)
          .reduce((a, b) => Math.max(a, b), null),
      };
    }
  }
  const selected = best || { rules: [], crawlDelay: null };
  return { rules: selected.rules, crawlDelay: selected.crawlDelay ?? null };
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

// Compiled once per distinct pattern, not once per (pattern, URL) pair. This
// used to build a fresh RegExp on every rule for every URL: a 200-rule
// robots.txt across a 50k-URL crawl is ten million compilations, all of them on
// the crawler's event loop.
const robotsPatternCache = new Map();

function robotsPattern(pattern) {
  let compiled = robotsPatternCache.get(pattern);
  if (compiled === undefined) {
    const anchored = pattern.endsWith("$");
    const raw = anchored ? pattern.slice(0, -1) : pattern;
    const escaped = raw
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      // Consecutive wildcards collapse to one: "/a**b" and "/a*b" match the
      // same paths, and ".*.*" is what makes this pattern class backtrack.
      .replace(/\*+/g, "*")
      .replace(/\*/g, "[^]*");
    compiled = new RegExp(`^${escaped}${anchored ? "$" : ""}`);
    // Bounded so a pathological robots.txt cannot grow this without limit.
    if (robotsPatternCache.size < 5_000) robotsPatternCache.set(pattern, compiled);
  }
  return compiled;
}

function robotsPatternMatches(path, pattern) {
  if (!pattern) return false;
  return robotsPattern(pattern).test(path);
}

function isAllowedByRobots(url, rules) {
  if (!rules?.length) return true;
  const parsed = new URL(url);
  const path = `${parsed.pathname}${parsed.search}`;
  let winner = null;
  for (const rule of rules) {
    if (!robotsPatternMatches(path, rule.pattern)) continue;
    if (!winner) {
      winner = rule;
      continue;
    }
    if (rule.pattern.length > winner.pattern.length) {
      winner = rule;
    } else if (
      rule.pattern.length === winner.pattern.length &&
      rule.type === "allow"
    ) {
      // RFC 9309: at equal specificity the least restrictive rule wins, so an
      // Allow beats a Disallow. Sorting by length alone left the outcome to
      // whichever happened to appear first in the file.
      winner = rule;
    }
  }
  return !winner || winner.type === "allow";
}

function quickIssues(result) {
  const issues = [];
  const add = (id, label, severity, category) =>
    issues.push({ id, label, severity, category });
  // A broken image, stylesheet or script is reported on the page that uses it
  // (analyzer.js), not as a page error on its own URL.
  const brokenAsset = result.isAsset && (result.status >= 400 || !result.status);
  if (!brokenAsset && result.status >= 500) add("server-error", "Server error (5xx)", "error", "Technical");
  else if (!brokenAsset && result.status >= 400) add("page-4xx", "Page returns a 4XX error", "error", "Technical");
  // Matches analyzer.js's post-crawl split exactly (permanent-redirect for
  // 301/308, temporary-redirect for 302/303/307) rather than a generic
  // "redirect" id with no catalog entry — that used to leave the live-crawl
  // card with no category or description, and relabel itself the moment the
  // crawl finished and findings replaced it with the real id.
  else if ([301, 308].includes(result.status))
    add("permanent-redirect", "Permanent redirects", "warning", "Indexability");
  else if ([302, 303, 307].includes(result.status))
    add("temporary-redirect", "Temporary redirects", "warning", "Indexability");
  else if (!brokenAsset && !result.status)
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
    contentTypeSniffed: false,
    size: 0,
    // Transfer size (what crossed the wire, possibly compressed) and decoded
    // size are separate measurements and no longer share one field.
    transferSize: 0,
    decodedSize: 0,
    bodyTruncated: false,
    bodyError: "",
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
    xRobotsTag: "",
    anchorCount: 0,
    redirectChain: [],
    finalUrl: "",
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
    schemaTypes: [],
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
    // One entry per distinct vendor detected on this page (never repeated
    // per script instance) — see detectIntegrations() below. Empty on every
    // non-HTML/external/redirect result, same as issues.
    integrations: [],
    issues: [],
    ...overrides,
  };
}

// JSON.parse accepts arbitrarily deep input, so an unbounded walk over its
// output can exhaust the stack. A RangeError here escapes the per-block try
// below, and the outer handler in _process would then report a perfectly good
// 200 page as an unreachable crawl failure.
const MAX_SCHEMA_DEPTH = 64;

// Returns both the validation errors (as before) and the distinct @type
// values seen across every JSON-LD block on the page — the same walk was
// already collecting `types` per node and discarding it. Page categorization
// (analyzer.js#categorizePage) wants that list too: a page whose schema says
// Product or Article is a far stronger signal than a URL path guess.
function schemaErrorsFromPage($) {
  const errors = [];
  const allTypes = new Set();
  const inspectNode = (node, depth = 0) => {
    if (!node || typeof node !== "object") return;
    if (depth > MAX_SCHEMA_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) inspectNode(item, depth + 1);
      return;
    }
    const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    const types = type.filter(Boolean).map(String);
    for (const t of types) allTypes.add(t);
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
    if (node["@graph"]) inspectNode(node["@graph"], depth + 1);
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
  return { errors: [...new Set(errors)].slice(0, 20), types: [...allTypes].slice(0, 20) };
}

// Inflate a gzip body up to `limit` bytes, keeping what fits. gunzipSync with
// maxOutputLength throws past the limit, which dropped a whole sitemap for being
// large, and throws on a truncated download, which dropped every complete
// entry before the cut.
function gunzipUpTo(buffer, limit) {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ buffer: Buffer.concat(chunks), truncated });
    };
    gunzip.on("data", (chunk) => {
      if (settled) return;
      if (bytes + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - bytes));
        truncated = true;
        finish();
        gunzip.destroy();
        return;
      }
      bytes += chunk.length;
      chunks.push(chunk);
    });
    gunzip.on("end", finish);
    gunzip.on("error", (error) => {
      if (settled) return;
      if (!chunks.length) {
        settled = true;
        reject(error);
        return;
      }
      // Output before a corrupt or cut-off tail is still the sitemap's.
      truncated = true;
      finish();
    });
    gunzip.end(buffer);
  });
}

class SeoCrawler extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      maxUrls: Math.max(1, Math.min(Number(options.maxUrls) || 10_000, 50_000)),
      // `Number(x) || 150` turned an explicit 0 ("skip external checks", as the
      // options form says) back into 150.
      maxExternalUrls: boundedInteger(options.maxExternalUrls, 500, 0, 2_000),
      concurrency: Math.max(1, Math.min(Number(options.concurrency) || 4, 16)),
      timeout: Math.max(3_000, Math.min(Number(options.timeout) || 15_000, 60_000)),
      respectRobots: options.respectRobots !== false,
      includeSubdomains: options.includeSubdomains === true,
      crawlAssets: options.crawlAssets !== false,
      checkExternalLinks: options.checkExternalLinks !== false,
      discoverSitemaps: options.discoverSitemaps !== false,
      userAgentProfile: options.userAgentProfile === "mobile" ? "mobile" : "desktop",
      // Render a sample of pages in headless Chromium after the crawl
      // (render-check.js). Off unless asked for: the hosted service asks by
      // default (shared/options.js), a crawler constructed directly does not.
      renderCheck: options.renderCheck === true,
      // Audit every HTML page as rendered by headless Chromium ("Render
      // JavaScript"). Slower: each page is loaded in a browser tab.
      renderJavaScript: options.renderJavaScript === true,
      renderSampleSize: Math.max(1, Math.min(Math.floor(Number(options.renderSampleSize)) || 10, 25)),
      // Test hook: a function returning a browser, or null for none.
      launchBrowser: typeof options.launchBrowser === "function" ? options.launchBrowser : null,
      userAgent: options.userAgent || USER_AGENT_PROFILES[options.userAgentProfile] || USER_AGENT,
      // Politeness / outbound-reputation controls. Defaults keep local + desktop
      // behavior identical (no artificial delay); the hosted worker raises
      // perHostDelay to space requests and reduce the chance of being blocked.
      perHostDelay: Math.max(0, Math.min(Number(options.perHostDelay) || 0, 60_000)),
      // The default has to be applied BEFORE Number(): `Number(undefined) ?? 2`
      // is NaN (?? only replaces null/undefined), and `attempt < NaN` is always
      // false. Hosted crawls never pass maxRetries (shared/options.js), so that
      // NaN silently disabled every retry and all host backoff in production.
      maxRetries: boundedInteger(options.maxRetries, 2, 0, 5),
      retryBaseDelay: Math.max(100, Math.min(Number(options.retryBaseDelay) || 1_000, 30_000)),
      maxRetryDelay: Math.max(1_000, Math.min(Number(options.maxRetryDelay) || 30_000, 120_000)),
      hostBackoffFactor: Math.max(1, Math.min(Number(options.hostBackoffFactor) || 2, 10)),
      maxHostDelay: Math.max(0, Math.min(Number(options.maxHostDelay) || 10_000, 120_000)),
      // ── Trap control ──────────────────────────────────────────────────────
      // Nothing here changes what a normal site produces; they exist so a
      // calendar, a faceted-nav grid, or a mutually-linking pair of infinite
      // paths cannot consume the whole URL budget before the real site is
      // reached. Only maxUrls used to bound any of this.
      maxDepth: Math.max(1, Math.min(Number(options.maxDepth) || 20, 100)),
      maxUrlsPerTemplate: Math.max(
        1,
        Math.min(Number(options.maxUrlsPerTemplate) || 500, 50_000),
      ),
      // Reserve part of the budget for link-discovered pages so a sitemap
      // larger than maxUrls cannot spend all of it before the crawl starts.
      sitemapBudgetRatio: Math.max(
        0.1,
        Math.min(Number(options.sitemapBudgetRatio) || 0.8, 1),
      ),
      maxSitemapDocuments: Math.max(
        1,
        Math.min(Number(options.maxSitemapDocuments) || 200, 5_000),
      ),
      // Edge lists are the crawler's largest allocation on a big site (a 100-
      // link nav across 50k pages is 5M objects). Bounded and declared, the way
      // maxUrls truncation already is, rather than growing until the box dies.
      maxEdges: Math.max(1_000, Math.min(Number(options.maxEdges) || 400_000, 5_000_000)),
      // Honour Crawl-delay unless the operator explicitly opts out.
      respectCrawlDelay: options.respectCrawlDelay !== false,
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
    // A head index instead of Array#shift(): shift() is O(n) per dequeue, so a
    // 50k-URL frontier costs O(n²) element moves just to drain the queue.
    this.queue = [];
    this._queueHead = 0;
    this.seen = new Set();
    this.externalSeen = new Set();
    // Distinct external URLs found after maxExternalUrls was reached.
    this._externalUnchecked = new Set();
    this.results = [];
    this.inlinkCounts = new Map();
    this.discovery = new Map();
    this.linkEdges = [];
    this.resourceEdges = [];
    this.edgesTruncated = false;
    // How many URLs each path-template has contributed, for trap detection.
    this._templateCounts = new Map();
    this.trapTemplates = new Set();
    this.sitemapMembership = new Map();
    this.sitemapUrls = [];
    this.active = 0;
    this.paused = false;
    this.stopped = false;
    this.truncated = false;
    this.depthLimited = false;
    // The page budget itself ran out. `truncated` is also set by the depth
    // limit and by crawl traps, so it cannot say "raise the budget" alone.
    this.budgetReached = false;
    this.startedAt = 0;
    // The token robots.txt groups are matched against: CrawlScope's own, even
    // when the crawl sends a smartphone User-Agent (ROBOTS_TOKEN). A custom
    // userAgent keeps its own first word, as before.
    this.robotsToken = options.userAgent ? robotsProductToken(options.userAgent) || ROBOTS_TOKEN : ROBOTS_TOKEN;
    this.robotsRules = [];
    // robots.txt as Googlebot reads it: what an SEO audit reports as blocked.
    // null until robots.txt is read, and when it could not be (unknown, not
    // "allowed").
    this.googlebotRobotsRules = null;
    this.robotsCrawlDelay = null;
    this.robotsStatus = "Not checked";
    // Set from the seed once it is known, so an http:// link on an https:// site
    // is crawled as the same page rather than as a second one.
    this.scheme = "";
    // Minimal per-host cookie jar. undici's fetch keeps no cookie state, so a
    // site that sets a session or consent cookie on the first response served
    // the crawler its interstitial on every subsequent page.
    this._cookieJar = new Map();
    this._progressPending = false;
    // Set by restore() when this run continues an interrupted attempt.
    this._resumed = false;
    this._resumedCompleted = 0;
    // Pages the previous attempt stored, reloaded by restore(), and how many of
    // them came without their link data (rows stored before it was kept).
    this._priorPages = 0;
    this._priorPagesWithoutEdges = 0;
    // Jobs taken off the queue and not yet answered. A checkpoint puts them
    // back: they are in `seen`, so a resume would otherwise never fetch them.
    this._inFlight = new Set();
    this._discoveryDone = false;
    this.siteDiagnostics = {
      robotsWarnings: [],
      robotsUrl: "",
      sitemapConfigIssue: "",
      sitemapErrors: [],
      httpHomepageIssue: "",
      llmsStatus: "not checked",
      llmsFormatIssue: "",
      renderingIssue: "",
      trapTemplates: [],
    };
  }

  async start(input) {
    this.startedAt = Date.now();

    if (this._resumed) {
      // The frontier came from restore(): robots, sitemaps and site files were
      // all resolved by the attempt that produced the checkpoint, so re-running
      // discovery here would only re-fetch them and re-seed URLs already in
      // `seen`. Straight to draining what is queued.
      this.emit("log", {
        level: "info",
        message: `Resuming crawl: ${this._resumedCompleted} pages already stored, ${this._queueLength()} queued`,
      });
      this._emitProgressSoon();
    } else if (Array.isArray(input)) {
      this._startList(input);
    } else {
      const initial = normalizeUrl(input);
      if (!initial) throw new Error("Enter a valid http:// or https:// URL.");
      this._anchorSeed(initial);

      // robots.txt is still read up front: the seed itself must not be fetched
      // before we are allowed to fetch it.
      if (this.options.respectRobots || this.options.discoverSitemaps) {
        await this._loadRobots();
      }

      // Sitemap and site-file discovery is DEFERRED until the seed has answered.
      // A site that 301s apex -> www (or http -> https, or to a migrated domain)
      // moves the origin those files belong to: doing this first read sitemap.xml
      // and llms.txt from the origin the site had just abandoned, while the
      // redirect target itself fell out of scope, _enqueueInternal dropped it,
      // and the whole crawl ended after a single result. Deferring costs nothing
      // — the seed is still fetched exactly once. See _afterSeed.
      this._enqueueInternal(initial, 0, "", { fromSitemap: false, seed: true });
    }

    return new Promise((resolve) => {
      this.resolve = resolve;
      this._schedule();
    });
  }

  // ── Resume ────────────────────────────────────────────────────────────────
  // The frontier is the one piece of a crawl that exists nowhere but memory.
  // Results are streamed to the database as they are produced, so a run killed
  // at 95% had 95% of its evidence safely stored — and then threw it away,
  // because nothing could say which URLs were already done or which were still
  // queued, and the only safe restart was from the seed.
  //
  // Deliberately NOT included: results, linkEdges and resourceEdges. Those are
  // large, they are already persisted row by row (each page's own edges with
  // it), and copying them into a checkpoint would make each write proportional
  // to the whole crawl. restore() reloads them from those rows instead.
  //
  // `seen` covers every URL taken off the queue, so two kinds of page would be
  // lost across a restart without help: jobs in flight when the checkpoint is
  // taken, and results produced but not yet stored (the caller buffers rows in
  // batches). Both go back at the front of the checkpoint's queue; restore()
  // drops any that turn out to be stored after all.
  snapshot({ unstoredResults = [] } = {}) {
    if (this.mode === "list") return null;
    const requeue = new Map();
    for (const job of this._inFlight) requeue.set(job.url, { ...job, seed: false, seedHop: 0 });
    for (const result of unstoredResults) {
      if (!result?.url || requeue.has(result.url)) continue;
      const discovery = this.discovery.get(result.url) || {};
      requeue.set(result.url, {
        url: result.url,
        depth: result.depth ?? 0,
        sourceUrl: discovery.sourceUrl || "",
        isAsset: Boolean(result.isAsset || discovery.isAsset),
        fromSitemap: Boolean(result.fromSitemap || discovery.fromSitemap),
        external: result.scope === "External",
        seed: false,
        seedHop: 0,
      });
    }
    const pending = this.queue.slice(this._queueHead).filter((job) => job && !requeue.has(job.url));
    return {
      version: 1,
      startUrl: this.startUrl,
      origin: this.origin,
      hostname: this.hostname,
      scheme: this.scheme,
      discoveryDone: Boolean(this._discoveryDone),
      seen: [...this.seen],
      externalSeen: [...this.externalSeen],
      queue: [...requeue.values(), ...pending],
      inlinkCounts: [...this.inlinkCounts],
      discovery: [...this.discovery],
      templateCounts: [...this._templateCounts],
      trapTemplates: [...this.trapTemplates],
      sitemapMembership: [...this.sitemapMembership].map(([url, set]) => [url, [...set]]),
      sitemapUrls: this.sitemapUrls,
      robotsRules: this.robotsRules,
      googlebotRobotsRules: this.googlebotRobotsRules,
      robotsCrawlDelay: this.robotsCrawlDelay,
      robotsStatus: this.robotsStatus,
      siteDiagnostics: this.siteDiagnostics,
      truncated: this.truncated,
      depthLimited: this.depthLimited,
      budgetReached: this.budgetReached,
      // Pages already stored by the previous attempt. The resumed run does not
      // re-fetch them, so this is what its own results array starts short by.
      completedCount: this.results.length + (this._resumedCompleted || 0),
    };
  }

  // Restores a frontier produced by snapshot(). Called before start(), which
  // then skips seeding and discovery and simply drains what is already queued.
  //
  // `prior` is what the interrupted attempt stored: `storedUrls` (every URL with
  // a row, so a URL the checkpoint re-queued but that was stored after all is
  // not fetched twice) and the pages themselves with their link and resource
  // edges, so the analysis at the end covers the whole crawl rather than the
  // part fetched after the restart. Without them the run still resumes, and
  // its analysis covers only what it fetches itself.
  restore(checkpoint, prior = {}) {
    if (!checkpoint || checkpoint.version !== 1) return false;
    const {
      storedUrls = null,
      results: priorResults = [],
      linkEdges: priorLinkEdges = [],
      resourceEdges: priorResourceEdges = [],
      pagesWithoutEdges = 0,
    } = prior;
    this.mode = "spider";
    this.startUrl = checkpoint.startUrl;
    this.origin = checkpoint.origin;
    this.hostname = checkpoint.hostname;
    this.scheme = checkpoint.scheme || "";
    this._discoveryDone = Boolean(checkpoint.discoveryDone);
    this.seen = new Set(checkpoint.seen || []);
    this.externalSeen = new Set(checkpoint.externalSeen || []);
    this.queue = (checkpoint.queue || []).filter((job) => job && !storedUrls?.has(job.url));
    this._queueHead = 0;
    this.inlinkCounts = new Map(checkpoint.inlinkCounts || []);
    this.discovery = new Map(checkpoint.discovery || []);
    this._templateCounts = new Map(checkpoint.templateCounts || []);
    this.trapTemplates = new Set(checkpoint.trapTemplates || []);
    this.sitemapMembership = new Map(
      (checkpoint.sitemapMembership || []).map(([url, list]) => [url, new Set(list)]),
    );
    this.sitemapUrls = checkpoint.sitemapUrls || [];
    this.robotsRules = checkpoint.robotsRules || [];
    this.googlebotRobotsRules = checkpoint.googlebotRobotsRules ?? null;
    this.robotsCrawlDelay = checkpoint.robotsCrawlDelay ?? null;
    this.robotsStatus = checkpoint.robotsStatus || "Not checked";
    this.siteDiagnostics = { ...this.siteDiagnostics, ...(checkpoint.siteDiagnostics || {}) };
    this.truncated = Boolean(checkpoint.truncated);
    this.depthLimited = Boolean(checkpoint.depthLimited);
    this.budgetReached = Boolean(checkpoint.budgetReached);
    if (priorResults.length) {
      this.results = [...priorResults];
      this.linkEdges = [...priorLinkEdges];
      this.resourceEdges = [...priorResourceEdges];
      // Counted in this.results now, not on top of it.
      this._resumedCompleted = 0;
    } else {
      this._resumedCompleted = checkpoint.completedCount || 0;
    }
    this._priorPages = priorResults.length;
    this._priorPagesWithoutEdges = pagesWithoutEdges;
    this._resumed = true;
    this._applyCrawlDelay();
    return true;
  }

  // Everything that defines "this site" comes from one place, so re-anchoring
  // after a seed redirect cannot leave half the crawler pointing at the old host.
  _anchorSeed(url) {
    const parsed = new URL(url);
    this.startUrl = url;
    this.origin = parsed.origin;
    this.hostname = parsed.hostname;
    this.scheme = parsed.protocol;
  }

  // Runs once, after the seed's own response is known.
  //
  // A seed that redirects to another host is the single most common way a crawl
  // used to collapse to one result: the destination was out of scope, so
  // _enqueueInternal refused it and there was nothing left to crawl. The whole
  // site definition is re-anchored on where the seed actually lands, and
  // robots.txt is re-read whenever that changes host, because the old origin's
  // rules do not govern the new one.
  //
  // Site-file discovery (sitemaps, llms.txt, the HTTP->HTTPS check) happens here
  // rather than in start() so it is always performed against the final origin.
  async _afterSeed(job, redirectUrl) {
    if (this._discoveryDone) return;
    const hops = job.seedHop || 0;

    this._seedChain = this._seedChain || new Set([job.url]);

    if (redirectUrl && hops < 5) {
      const target = normalizeUrl(redirectUrl);
      // A chain that revisits an address it has already been through is a
      // redirect loop. Following it further would re-fetch the same pair up to
      // the hop cap and delay discovery for no information; the loop itself is
      // already fully recorded in the results as a redirect finding.
      if (target && target !== job.url && !this._seedChain.has(target)) {
        this._seedChain.add(target);
        const movedHost = new URL(target).hostname !== this.hostname;
        this._anchorSeed(target);
        if (movedHost && (this.options.respectRobots || this.options.discoverSitemaps)) {
          await this._loadRobots();
        }
        // Queued directly rather than through _enqueueInternal: this job carries
        // the hop count that bounds the walk, and _process deliberately does not
        // enqueue a seed's redirect so the two cannot both queue it.
        this.seen.add(target);
        this.queue.push({
          url: target,
          depth: job.depth,
          sourceUrl: job.url,
          isAsset: false,
          fromSitemap: false,
          external: false,
          seed: true,
          seedHop: hops + 1,
        });
        return;
      }
    }

    this._discoveryDone = true;
    await Promise.all([
      this.options.discoverSitemaps ? this._loadSitemaps() : Promise.resolve(),
      this._checkSiteFiles(),
    ]);
    this._seedSitemapUrls();
  }

  // Sitemap URLs are seeded before a single link has been discovered, so without
  // a reserved share a sitemap larger than maxUrls spent the entire budget and
  // no link-discovered page was ever fetched.
  _seedSitemapUrls() {
    const sitemapBudget = Math.max(
      1,
      Math.floor(this.options.maxUrls * this.options.sitemapBudgetRatio),
    );
    let seeded = 0;
    for (const sitemapUrl of this.sitemapMembership.keys()) {
      if (this.seen.size >= sitemapBudget) {
        this.truncated = true;
        this.budgetReached = true;
        break;
      }
      if (this._enqueueInternal(sitemapUrl, 1, "", { fromSitemap: true })) seeded += 1;
    }
    if (this.sitemapMembership.size > seeded && !this.siteDiagnostics.sitemapConfigIssue) {
      this.siteDiagnostics.sitemapConfigIssue =
        `Only ${seeded} of ${this.sitemapMembership.size} sitemap URLs fitted within the crawl budget.`;
    }
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
    this._queueHead = 0;
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
    if (!referenceHost) return false;
    if (this.options.includeSubdomains) {
      // Compare against the registrable root on BOTH sides. Stripping "www."
      // only from the reference left the apex out of scope whenever the seed
      // was a www host: "example.com" is neither "www.example.com" nor a
      // ".example.com" suffix, so the apex of the very site being crawled was
      // treated as an external domain.
      const root = referenceHost.replace(/^www\./, "");
      return parsed.hostname === root || parsed.hostname.endsWith(`.${root}`);
    }
    return parsed.hostname === referenceHost;
  }

  // http:// and https:// copies of one page are one page. _inScope compares only
  // the hostname, so without this both spellings enter the frontier, each burns
  // a slot of maxUrls, and the pair reports itself as duplicate content.
  _canonicalScheme(url) {
    if (!this.scheme || this.mode === "list") return url;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === this.scheme) return url;
      if (parsed.hostname !== this.hostname) return url;
      parsed.protocol = this.scheme;
      return parsed.href;
    } catch {
      return url;
    }
  }

  // A stable identity for "URLs shaped like this one", used to stop calendars
  // and faceted navigation from generating an unbounded family of pages. Numeric
  // and hash-like path segments collapse, and only the parameter NAMES count, so
  // /events/2031/07 and /events/2031/08 share one template.
  _urlTemplate(url) {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").map((segment) => {
        if (/^\d+$/.test(segment)) return "#";
        if (/^[0-9a-f]{8,}$/i.test(segment)) return "#";
        if (/^[0-9a-f-]{16,}$/i.test(segment)) return "#";
        return segment;
      });
      const keys = [...new Set([...parsed.searchParams.keys()].map((k) => k.toLowerCase()))].sort();
      return `${parsed.hostname}${segments.join("/")}${keys.length ? `?${keys.join("&")}` : ""}`;
    } catch {
      return url;
    }
  }

  // A path that keeps repeating the same segment is a self-referencing link
  // loop (/shop/page/shop/page/shop/page...), which no template counter catches
  // because every level is a new template.
  _hasRepeatingPath(url) {
    try {
      const segments = new URL(url).pathname.split("/").filter(Boolean);
      const counts = new Map();
      for (const segment of segments) {
        const seen = (counts.get(segment) || 0) + 1;
        if (seen > 3) return true;
        counts.set(segment, seen);
      }
      return false;
    } catch {
      return false;
    }
  }

  _enqueueInternal(url, depth, sourceUrl, metadata = {}) {
    const normalized = this._canonicalScheme(normalizeUrl(url) || "");
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
      this.budgetReached = true;
      return false;
    }
    if (depth > this.options.maxDepth) {
      // Depth had no ceiling at all: deep-page only REPORTED depth > 3 after
      // the fact, and nothing stopped the descent.
      this.depthLimited = true;
      this.truncated = true;
      return false;
    }
    if (!metadata.fromSitemap && this._hasRepeatingPath(normalized)) {
      this._noteTrap(this._urlTemplate(normalized));
      return false;
    }
    if (!metadata.fromSitemap) {
      const template = this._urlTemplate(normalized);
      const count = (this._templateCounts.get(template) || 0) + 1;
      this._templateCounts.set(template, count);
      if (count > this.options.maxUrlsPerTemplate) {
        this._noteTrap(template);
        return false;
      }
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
      seed: Boolean(metadata.seed),
      seedHop: 0,
    });
    this._emitProgressSoon();
    return true;
  }

  // A suppressed template is reported rather than silently dropped: the pages
  // behind it really were skipped, and truncated=true tells the analyzer to stop
  // trusting inlink counts.
  _noteTrap(template) {
    this.truncated = true;
    if (this.trapTemplates.size >= 50 || this.trapTemplates.has(template)) return;
    this.trapTemplates.add(template);
    this.siteDiagnostics.trapTemplates = [...this.trapTemplates];
    this.emit("log", {
      level: "warning",
      message: `Crawl trap suppressed: ${template} exceeded ${this.options.maxUrlsPerTemplate} URLs`,
    });
  }

  _enqueueExternal(url, sourceUrl) {
    const normalized = normalizeUrl(url);
    if (!normalized || this.externalSeen.has(normalized)) return false;
    if (this.externalSeen.size >= this.options.maxExternalUrls) {
      // Counted, not dropped silently: every external link past the limit goes
      // unchecked, and "no broken external links" must not be read as a clean
      // bill for links nobody looked at.
      if (!this._externalUnchecked.has(normalized)) {
        if (this._externalUnchecked.size < 100_000) this._externalUnchecked.add(normalized);
        this.siteDiagnostics.externalLinksUnchecked =
          (this.siteDiagnostics.externalLinksUnchecked || 0) + 1;
      }
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
    this._emitProgressSoon();
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
        const content = await this._readTextBody(response);
        const parsed = parseRobots(content, this.robotsToken);
        this.robotsRules = parsed.rules;
        this.googlebotRobotsRules = parseRobots(content, "googlebot", { exact: true }).rules;
        this.robotsCrawlDelay = parsed.crawlDelay;
        const inspection = inspectRobots(content);
        this.siteDiagnostics.robotsWarnings = inspection.warnings;
        this.sitemapUrls = inspection.sitemapUrls;
        this.robotsStatus = this.robotsRules.length ? "Respected" : "No crawl rules";
        this._applyCrawlDelay();
      } else if (response.status >= 500) {
        // RFC 9309 §2.3.1.4: a 5xx robots.txt means "unavailable", and an
        // unavailable robots.txt must be treated as full disallow. Treating it
        // as "no rules" — which is what an empty robotsRules array does — is how
        // a crawler hammers a site that is already failing.
        this._denyAll("robots.txt is unavailable (HTTP 5xx)");
        this.robotsStatus = `Unavailable (${response.status}) — treating as Disallow: /`;
      } else {
        // 4xx genuinely means "no robots.txt", which does mean crawl freely.
        this.robotsStatus = `Not found (${response.status})`;
        this.googlebotRobotsRules = [];
      }
    } catch (error) {
      this._denyAll("robots.txt could not be fetched");
      this.robotsStatus = `Unavailable (${cleanText(error.message)}) — treating as Disallow: /`;
    }
  }

  // The unavailable-robots.txt state, expressed as a rule so every existing
  // isAllowedByRobots call site enforces it without a second code path.
  _denyAll(reason) {
    if (!this.options.respectRobots) return;
    this.robotsRules = [{ type: "disallow", pattern: "/" }];
    this.siteDiagnostics.robotsWarnings = [
      ...(this.siteDiagnostics.robotsWarnings || []),
      `${reason}; every URL is treated as disallowed.`,
    ];
  }

  // Crawl-delay was listed as a recognised robots.txt key and then thrown away:
  // a site asking for 10 seconds between requests got the crawler's own default
  // instead. It raises perHostDelay and never lowers it, so an operator's
  // stricter setting still wins.
  _applyCrawlDelay() {
    if (!this.options.respectCrawlDelay) return;
    if (this.robotsCrawlDelay === null) return;
    const requested = Math.min(this.robotsCrawlDelay * 1_000, 60_000);
    if (requested <= this.options.perHostDelay) return;
    this.options.perHostDelay = requested;
    for (const state of this._hostState.values()) {
      state.delayMs = Math.max(state.delayMs, requested);
    }
    this.emit("log", {
      level: "info",
      message: `robots.txt Crawl-delay: ${this.robotsCrawlDelay}s — spacing requests to ${requested}ms`,
    });
  }

  async _loadSitemaps() {
    const declared = [...this.sitemapUrls];
    // `pending` used to BE `declared` when robots.txt named a sitemap, and the
    // shift() below then drained both. By the time the diagnostic ran,
    // declared.length was always 0 — so a site whose robots.txt declared its
    // sitemap perfectly correctly was still told "a sitemap was found, but
    // robots.txt does not declare it". The count has to be taken before the
    // queue is consumed, and the queue has to be its own array.
    const declaredCount = declared.length;
    const pending = declaredCount
      ? [...declared]
      : [new URL("/sitemap.xml", this.origin).href];
    const visited = new Set();
    let foundAny = false;

    const errors = [];
    let truncatedTraversal = false;
    // Files past the protocol's limits, and entries on hosts the crawl does not
    // cover: both used to vanish without a word.
    let sitemapBytes = 0;
    let bytesExhausted = false;
    const oversized = new Map(); // sitemap URL -> what is over the limit
    const noteOversized = (url, detail) => oversized.set(url, [...(oversized.get(url) || []), detail]);
    const offHost = { count: 0, hosts: new Map(), samples: [] };

    while (pending.length && !this.stopped) {
      if (visited.size >= this.options.maxSitemapDocuments) {
        // The old limit was 15 DOCUMENTS, index files included, so a site whose
        // index pointed at 50 child sitemaps silently lost 35 of them and every
        // URL inside. Now it is a declared truncation at a realistic ceiling.
        truncatedTraversal = true;
        break;
      }
      if (sitemapBytes >= MAX_SITEMAP_TOTAL_BYTES) {
        truncatedTraversal = true;
        bytesExhausted = true;
        break;
      }
      const sitemapUrl = pending.shift();
      if (!sitemapUrl || visited.has(sitemapUrl)) continue;
      visited.add(sitemapUrl);
      try {
        const response = await this._politeFetch(
          sitemapUrl,
          {
            headers: {
              "User-Agent": this.options.userAgent,
              // Sitemaps are frequently served as application/gzip.
              Accept: "application/xml,text/xml,application/gzip;q=0.9,*/*;q=0.5",
            },
          },
          { timeout: this.options.timeout, signal: this.rootController.signal },
        );
        if (!response.ok) {
          errors.push(`${sitemapUrl}: HTTP ${response.status}`);
          if (response.body) await response.body.cancel().catch(() => {});
          continue;
        }
        const { xml, truncated: cutShort, bytes } = await this._readSitemapBody(response, sitemapUrl);
        sitemapBytes += bytes || 0;
        if (cutShort) {
          noteOversized(sitemapUrl, "is larger than 50 MB uncompressed, and only the first 50 MB were read");
        }
        if (!xml) {
          errors.push(`${sitemapUrl}: body could not be read`);
          continue;
        }
        if (!/<(?:urlset|sitemapindex)(?:\s|>)/i.test(xml)) {
          errors.push(`${sitemapUrl}: not a sitemap document`);
          continue;
        }
        foundAny = true;
        const locations = [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
          .map((match) => normalizeUrl(decodeXml(cleanText(match[1])), sitemapUrl))
          .filter(Boolean);
        if (/<sitemapindex(?:\s|>)/i.test(xml)) {
          for (const location of locations) {
            if (!visited.has(location)) pending.push(location);
          }
        } else {
          if (locations.length > MAX_SITEMAP_URLS) {
            noteOversized(
              sitemapUrl,
              `lists ${locations.length.toLocaleString("en-US")} URLs, over the limit of ${MAX_SITEMAP_URLS.toLocaleString("en-US")}`,
            );
          }
          for (const location of locations) {
            if (!this._inScope(location)) {
              // Search engines ignore a sitemap entry on another host, and so
              // does the crawl; counted so the report can say so.
              const host = new URL(location).host;
              offHost.count += 1;
              offHost.hosts.set(host, (offHost.hosts.get(host) || 0) + 1);
              if (offHost.samples.length < 5) offHost.samples.push(location);
              continue;
            }
            const memberships = this.sitemapMembership.get(location) || new Set();
            memberships.add(sitemapUrl);
            this.sitemapMembership.set(location, memberships);
          }
        }
      } catch (error) {
        // A sitemap that timed out is NOT a sitemap that does not exist, and
        // reporting the two identically told operators their sitemap was
        // missing when it was merely slow.
        errors.push(`${sitemapUrl}: ${cleanText(error.message) || error.name}`);
      }
    }

    this.siteDiagnostics.sitemapErrors = errors.slice(0, 20);
    this.siteDiagnostics.sitemapLimits = [...oversized]
      .slice(0, 20)
      .map(([url, details]) => ({ url, detail: details.join(", and "), truncated: details.some((d) => d.includes("50 MB")) }));
    this.siteDiagnostics.sitemapOffHost = offHost.count
      ? {
          count: offHost.count,
          hosts: [...offHost.hosts].sort((a, b) => b[1] - a[1]).slice(0, 10),
          samples: offHost.samples,
        }
      : null;
    if (truncatedTraversal) {
      this.siteDiagnostics.sitemapConfigIssue = bytesExhausted
        ? `Sitemap traversal stopped after reading 1 GB of sitemaps; ${pending.length} more were not read.`
        : `Sitemap traversal stopped at ${this.options.maxSitemapDocuments} documents; ` +
          `${pending.length} more were not read.`;
    } else if (!declaredCount) {
      this.siteDiagnostics.sitemapConfigIssue = foundAny
        ? "A sitemap was found, but robots.txt does not declare it."
        : errors.length
          ? `No sitemap could be read (${errors[0]}).`
          : "No sitemap declaration or accessible default sitemap was detected.";
    } else if (!foundAny && errors.length) {
      this.siteDiagnostics.sitemapConfigIssue = `Declared sitemaps could not be read (${errors[0]}).`;
    }
    this.siteDiagnostics.sitemaps = [...visited];
  }

  // Sitemaps are very often served gzipped (sitemap.xml.gz), and Content-Encoding
  // is usually absent because the gzip is the RESOURCE, not a transfer encoding —
  // so fetch does not inflate it. response.text() then returned binary, the
  // "<urlset|<sitemapindex" guard failed, and every URL in that sitemap was
  // dropped without a word.
  //
  // Read up to the protocol's 50 MB, not a page's 5 MB, and say when a file was
  // cut there: `truncated` is set when the file (or what it inflates to) is
  // larger, and what was read is still used — every complete <loc> in it counts.
  async _readSitemapBody(response, sitemapUrl) {
    const { buffer, truncated, bytes } = await this._readBodyBuffer(response, MAX_SITEMAP_BYTES);
    const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    if (!isGzip) return { xml: this._decodeBuffer(buffer, response), truncated, bytes };
    try {
      const inflated = await gunzipUpTo(buffer, MAX_SITEMAP_BYTES);
      return { xml: inflated.buffer.toString("utf8"), truncated: truncated || inflated.truncated, bytes };
    } catch (error) {
      this.emit("log", {
        level: "warning",
        message: `${sitemapUrl}: gzip could not be inflated (${cleanText(error.message)})`,
      });
      return { xml: "", truncated, bytes };
    }
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
          const content = await this._readTextBody(response);
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

    checks.push(this._probeMissingPage());
    checks.push(this._checkWwwResolve());

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
              const body = await this._readTextBody(response);
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

  // ── Does the other host (www or bare) serve the site too? ─────────────────
  // www.example.com and example.com both answering with content is two copies
  // of the site, and links and ranking signals split between them. The other
  // host should redirect to this one. No such host, or one that cannot be
  // reached, is fine: there is nothing for anyone to land on.
  _checkWwwResolve() {
    let start;
    try {
      start = new URL(this.startUrl);
    } catch {
      return Promise.resolve();
    }
    const host = start.hostname;
    const isAddress = /^\d+(\.\d+){3}$/.test(host) || host.includes(":") || host.startsWith("[");
    if (!host || isAddress || host === "localhost" || !host.includes(".")) return Promise.resolve();
    const alternate = new URL("/", start.origin);
    alternate.hostname = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
    return this._politeFetch(
      alternate.href,
      { redirect: "manual", headers: { "User-Agent": this.options.userAgent, Accept: "text/html,*/*;q=0.8" } },
      { timeout: this.options.timeout, signal: this.rootController.signal },
    )
      .then(async (response) => {
        const location = headerValue(response.headers, "location");
        const servesContent = response.status >= 200 && response.status < 300;
        let canonical = "";
        if (servesContent && headerValue(response.headers, "content-type").includes("html")) {
          const body = await this._readTextBody(response);
          canonical =
            normalizeUrl(cheerio.load(body)('head link[rel~="canonical" i]').first().attr("href") || "", alternate.href) || "";
        } else if (response.body) {
          await response.body.cancel().catch(() => {});
        }
        this.siteDiagnostics.wwwResolve = {
          url: alternate.href,
          status: response.status,
          servesContent,
          redirectsTo: location ? normalizeUrl(location, alternate.href) || location : "",
          canonical,
        };
      })
      .catch(() => {
        this.siteDiagnostics.wwwResolve = { url: alternate.href, status: 0, servesContent: false, unreachable: true };
      });
  }

  // ── What does this site answer for a URL that does not exist? ─────────────
  // A site that serves 200 (or redirects) for unknown URLs hides every deleted
  // page and mistyped link from status-based checks: they all look live. One
  // request to a random path that cannot exist says which kind of site this
  // is, and a fingerprint of its not-found page lets the analyzer recognise
  // that page wherever else the crawl met it (see soft-404 in analyzer.js).
  //
  // Same-host redirects are followed first: /missing -> /missing/ -> 404 is a
  // correct setup, not a soft 404. The fingerprint is only kept when the page
  // was served AT the missing URL — when missing URLs redirect to the homepage,
  // the page at the end is the homepage, which must not be flagged.
  async _probeMissingPage() {
    const probeUrl = new URL(
      `/crawlscope-missing-page-check-${crypto.randomBytes(6).toString("hex")}`,
      this.origin,
    ).href;
    if (this.options.respectRobots && !isAllowedByRobots(probeUrl, this.robotsRules)) return;
    const probe = { url: probeUrl, status: 0, finalUrl: probeUrl, redirected: false, title: "", hash: "", words: 0 };
    try {
      let url = probeUrl;
      for (let hop = 0; hop < 5; hop += 1) {
        const response = await this._politeFetch(
          url,
          {
            redirect: "manual",
            headers: { "User-Agent": this.options.userAgent, Accept: "text/html,*/*;q=0.8" },
          },
          { timeout: this.options.timeout, signal: this.rootController.signal },
        );
        probe.status = response.status;
        probe.finalUrl = url;
        const location = normalizeUrl(headerValue(response.headers, "location"), url);
        if (isRedirectStatus(response.status) && location) {
          if (response.body) await response.body.cancel().catch(() => {});
          if (new URL(location).host !== new URL(url).host) {
            probe.redirected = true;
            probe.finalUrl = location;
            break;
          }
          // A redirect that only adds/removes a trailing slash or changes case
          // is URL normalization; anything else is a redirect to another page.
          const sameResource =
            location.replace(/\/$/, "").toLowerCase() === url.replace(/\/$/, "").toLowerCase();
          if (!sameResource) probe.redirected = true;
          url = location;
          continue;
        }
        if (
          response.status >= 200 &&
          response.status < 300 &&
          !probe.redirected &&
          /html/i.test(headerValue(response.headers, "content-type"))
        ) {
          const $ = cheerio.load(await this._readTextBody(response));
          pruneInertTemplates($);
          const text = visibleTextOf($);
          probe.title = cleanText(documentElements($, "title").first().text());
          probe.hash = crypto.createHash("sha1").update(text).digest("hex");
          probe.words = text ? text.split(/\s+/).length : 0;
        } else if (response.body) {
          await response.body.cancel().catch(() => {});
        }
        break;
      }
      this.siteDiagnostics.missingPageProbe = probe;
    } catch {
      // A probe that could not be completed says nothing either way.
    }
  }

  _progress() {
    return {
      // Includes pages a previous attempt already stored, so a resumed run's
      // progress bar continues rather than restarting at zero.
      crawled: this.results.length + this._resumedCompleted,
      discovered: this.seen.size + this.externalSeen.size,
      queued: this._queueLength(),
      active: this.active,
      maxUrls: this.options.maxUrls + this.options.maxExternalUrls,
      elapsed: Date.now() - this.startedAt,
    };
  }

  _queueLength() {
    return this.queue.length - this._queueHead;
  }

  // Edge lists were the crawler's one genuinely unbounded allocation: a 100-link
  // navigation across 50,000 pages is five million objects, each holding anchor
  // text, an accessible name and an element hint, all retained until the crawl
  // ends because the analyzer needs the complete result set to interpret them.
  // Now they are capped and the cap is DECLARED, the same way maxUrls truncation
  // already is, so a partial graph is never mistaken for a complete one.
  _pushEdge(collection, edge) {
    if (collection.length >= this.options.maxEdges) {
      if (!this.edgesTruncated) {
        this.edgesTruncated = true;
        this.emit("log", {
          level: "warning",
          message: `Link graph capped at ${this.options.maxEdges} edges; later edges are not recorded.`,
        });
      }
      return false;
    }
    collection.push(edge);
    return true;
  }

  // Discovery emits one of these per enqueued URL, so a page with 500 links used
  // to build and dispatch 500 progress objects through every listener before the
  // consumer's own interval check threw them away. Coalescing to one emission per
  // turn of the event loop keeps the signal and drops the cost.
  _emitProgressSoon() {
    if (this._progressPending) return;
    this._progressPending = true;
    queueMicrotask(() => {
      this._progressPending = false;
      this.emit("progress", this._progress());
    });
  }

  _schedule() {
    // A stop has to get through even while paused. This used to be a bare
    // `if (this.paused) return`, so stop() -- which sets `stopped`, clears the
    // queue and then calls _schedule() -- was turned away here and never reached
    // the completion check below. The start() promise therefore never resolved:
    // the run stayed 'running' with no findings ever written, and shutdown()
    // burned its whole drain timeout waiting on an execution that could not end.
    // "Pause to think, then stop" is an ordinary flow in the UI (both buttons
    // render for any non-terminal run), not an edge case.
    if (this.paused && !this.stopped) return;
    while (
      !this.stopped &&
      this.active < this.options.concurrency &&
      this._queueLength()
    ) {
      // A head index rather than Array#shift(): shift() re-indexes the whole
      // array on every dequeue, which is O(n²) across a 50k-URL frontier.
      const job = this.queue[this._queueHead];
      this.queue[this._queueHead] = undefined; // release the reference
      this._queueHead += 1;
      // Reclaim the drained prefix once it dominates the array, so the backing
      // store tracks the live frontier rather than every URL ever queued.
      if (this._queueHead > 1_000 && this._queueHead * 2 > this.queue.length) {
        this.queue = this.queue.slice(this._queueHead);
        this._queueHead = 0;
      }
      this.active += 1;
      this._inFlight.add(job);
      this._process(job)
        .catch((error) => this.emit("log", { level: "error", message: error.message }))
        .finally(() => {
          this._inFlight.delete(job);
          this.active -= 1;
          this.emit("progress", this._progress());
          this._schedule();
        });
    }

    if (
      (this.stopped || this._queueLength() === 0) &&
      this.active === 0 &&
      this.resolve &&
      !this._finishing
    ) {
      this._finishing = true;
      this._finish().catch((error) => {
        this.emit("log", { level: "error", message: `Crawl completion failed: ${error.message}` });
      });
    }
  }

  // ── Render JavaScript: one browser for the crawl ──────────────────────────
  // Launched on the first page that needs it, shared by every page, at most
  // RENDER_SLOTS pages at once (each is a full browser tab), and closed when
  // the crawl finishes. null when no browser is available here.
  _browser() {
    if (!this._browserLaunch) {
      const launch = this.options.launchBrowser || launchBrowser;
      this._browserLaunch = Promise.resolve()
        .then(() => launch())
        .catch((error) => {
          this.emit("log", { level: "warning", message: `JavaScript rendering unavailable: ${cleanText(error.message)}` });
          return null;
        });
    }
    return this._browserLaunch;
  }

  async _renderedHtml(url, body, status) {
    const stats = (this.siteDiagnostics.renderJavaScript ||= { rendered: 0, failed: 0, available: true });
    const browser = await this._browser();
    if (!browser) {
      stats.available = false;
      stats.failed += 1;
      return null;
    }
    this._renderQueue ||= { active: 0, waiting: [] };
    const slots = this._renderQueue;
    if (slots.active >= RENDER_SLOTS) await new Promise((resolve) => slots.waiting.push(resolve));
    slots.active += 1;
    try {
      const html = await renderHtml(browser, url, {
        fetch: this._fetch,
        userAgent: this.options.userAgent,
        timeout: this.options.timeout,
        document: { status, contentType: "text/html; charset=utf-8", body },
      });
      stats.rendered += 1;
      return html;
    } catch (error) {
      stats.failed += 1;
      this.emit("log", { level: "warning", message: `${url}: could not be rendered (${cleanText(error.message)}); audited as served` });
      return null;
    } finally {
      slots.active -= 1;
      slots.waiting.shift()?.();
    }
  }

  async _closeBrowser() {
    if (!this._browserLaunch) return;
    const browser = await this._browserLaunch;
    this._browserLaunch = null;
    if (browser) await browser.close().catch(() => {});
  }

  // ── The JavaScript rendering sample (render-check.js) ────────────────────
  // Up to renderSampleSize crawled pages, rendered in headless Chromium and
  // compared with what this crawl parsed from them. Never fails the crawl:
  // any problem comes back as { ran: false, reason }, which the coverage block
  // reports as "not evaluated".
  async _renderSample() {
    // Every page was rendered: what JavaScript builds is what was audited.
    if (this.options.renderJavaScript) return { ran: false, reason: "rendered" };
    if (!this.options.renderCheck || process.env.CRAWLSCOPE_RENDER_CHECK === "off") {
      return { ran: false, reason: "off" };
    }
    try {
      const identity = createUrlIdentity(this.startUrl);
      return await renderSample(this._renderCandidates(), {
        fetch: this._fetch,
        userAgent: this.options.userAgent,
        launch: this.options.launchBrowser || launchBrowser,
        shouldStop: () => this.stopped,
        identity: {
          normalize: (url) => normalizeUrl(url),
          isInternal: (url, pageUrl) => {
            try {
              return this._inScope(url, { url: pageUrl });
            } catch {
              return false;
            }
          },
          same: (a, b) => identity(a) === identity(b),
        },
      });
    } catch (error) {
      return { ran: false, reason: "failed", error: cleanText(error.message).slice(0, 200) };
    }
  }

  // The pages worth rendering: the start page, then the most-linked pages, no
  // more than two from any one top-level section so the sample spans the
  // site's templates rather than one listing's siblings.
  _renderCandidates() {
    const pages = this.results.filter(
      (result) =>
        result.scope !== "External" &&
        !result.isAsset &&
        result.status === 200 &&
        String(result.contentType || "").includes("html"),
    );
    const section = (url) => {
      try {
        return new URL(url).pathname.split("/").filter(Boolean)[0] || "";
      } catch {
        return "";
      }
    };
    const ordered = [
      ...pages.filter((result) => result.url === this.startUrl),
      ...pages
        .filter((result) => result.url !== this.startUrl)
        .sort((a, b) =>
          (this.inlinkCounts.get(b.url) || 0) - (this.inlinkCounts.get(a.url) || 0) ||
          String(a.url).localeCompare(String(b.url))),
    ];
    const perSection = new Map();
    const chosen = [];
    for (const result of ordered) {
      if (chosen.length >= this.options.renderSampleSize) break;
      const key = section(result.url);
      if (result.url !== this.startUrl && (perSection.get(key) || 0) >= 2) continue;
      perSection.set(key, (perSection.get(key) || 0) + 1);
      chosen.push(result);
    }
    const linksFrom = new Map();
    for (const edge of this.linkEdges) {
      if (!edge.internal) continue;
      const list = linksFrom.get(edge.sourceUrl) || new Set();
      list.add(edge.targetUrl);
      linksFrom.set(edge.sourceUrl, list);
    }
    return chosen.map((result) => ({
      url: result.url,
      raw: {
        links: [...(linksFrom.get(result.url) || [])],
        words: result.words,
        title: result.title,
        metaDescription: result.metaDescription,
        canonical: result.canonical,
        robots: result.robots,
      },
    }));
  }

  // Everything after the last page: the JavaScript rendering sample (it needs
  // the finished crawl to choose from, and never fails the crawl), then the
  // analysis. Asynchronous because rendering is; _finishing keeps a pause,
  // resume or stop arriving meanwhile from finishing the crawl twice.
  async _finish() {
    await this._closeBrowser();
    if (!this.stopped) this.siteDiagnostics.renderCheck = await this._renderSample();
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
    assertGraphReady({
      queueLength: this._queueLength(),
      active: this.active,
      stopped: this.stopped,
    });
    const analysis = buildFindings({
      results: baseResults,
      linkEdges: this.linkEdges,
      resourceEdges: this.resourceEdges,
      sitemapMembership: membership,
      siteDiagnostics: this.siteDiagnostics,
      startUrl: this.startUrl,
      sitemapsChecked: this.mode !== "list" && this.options.discoverSitemaps,
      clickDepthFromStart: this.mode !== "list",
      externalLinksChecked: Boolean(this.options.checkExternalLinks),
      robotsRespected: Boolean(this.options.respectRobots),
      // Pages a resumed run reloaded without their links and resources
      // (stored before those were kept), which the link checks cannot see.
      pagesMissingLinkData: this._priorPagesWithoutEdges,
      googlebotRobotsChecked: Array.isArray(this.googlebotRobotsRules),
      // A stopped crawl saw only part of the link graph, exactly like one that
      // hit a cap: "nothing links to this page" is unknowable when the pages
      // that might link to it were never fetched.
      // …and so did one whose link graph hit maxEdges: incoming-link counts
      // from a capped edge list cannot prove a page is an orphan.
      crawlTruncated: this.truncated || this.stopped || this.edgesTruncated,
    });
    const payload = {
      stopped: this.stopped,
      truncated: this.truncated,
      // Distinguishes the three reasons a crawl can be partial, which
      // `truncated` alone flattened into one bit.
      depthLimited: this.depthLimited,
      budgetReached: this.budgetReached,
      edgesTruncated: this.edgesTruncated,
      trapTemplates: [...this.trapTemplates],
      results: analysis.results,
      findings: analysis.findings,
      mediaLibrary: analysis.mediaLibrary,
      integrations: analysis.integrations,
      rootCauseGroups: analysis.rootCauseGroups,
      coverage: analysis.coverage,
      ruleOrder: analysis.ruleOrder,
      // A run that continued an interrupted attempt, and how much of that
      // attempt's work it reloaded.
      resumed: this._resumed
        ? { priorPages: this._priorPages, withoutLinkData: this._priorPagesWithoutEdges }
        : null,
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

  _hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  }

  // Reads a body with a REAL byte ceiling.
  //
  // MAX_BODY_BYTES used to be compared against Content-Length and nothing else,
  // so any chunked response — which carries no Content-Length — was buffered
  // whole by response.text(). A single large or endless stream took the worker
  // out with it. Reading through the stream bounds it whatever the headers said,
  // and it also bounds a small gzip that inflates to something enormous, because
  // undici has already decompressed by the time these chunks arrive.
  async _readBodyBuffer(response, limit = MAX_BODY_BYTES) {
    if (!response.body) return { buffer: Buffer.alloc(0), truncated: false, bytes: 0 };
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (bytes + chunk.length > limit) {
          // Keep only what fits. `bytes` counts RETAINED bytes, so the reported
          // size can never exceed the cap it was supposed to enforce.
          const room = limit - bytes;
          if (room > 0) chunks.push(chunk.subarray(0, room));
          bytes += room;
          truncated = true;
          break;
        }
        bytes += chunk.length;
        chunks.push(chunk);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream is already closed when the read loop ended naturally.
      }
    }
    return { buffer: Buffer.concat(chunks), truncated, bytes };
  }

  _decodeBuffer(buffer, response) {
    const declared =
      charsetFromBom(buffer) ||
      charsetFromContentType(headerValue(response.headers, "content-type")) ||
      charsetFromMeta(buffer) ||
      "utf-8";
    try {
      return new TextDecoder(declared).decode(buffer);
    } catch {
      // An unknown or unsupported label falls back to UTF-8 rather than losing
      // the page, which is what the old unconditional behaviour did anyway.
      return new TextDecoder("utf-8").decode(buffer);
    }
  }

  async _readTextBody(response, limit = MAX_BODY_BYTES) {
    const { buffer } = await this._readBodyBuffer(response, limit);
    return this._decodeBuffer(buffer, response);
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
    // Push the reservation line out too. Raising delayMs alone only affected
    // slots booked AFTER the penalty: every request already holding a slot from
    // before it kept firing at the old cadence, so the host went on being hit at
    // full rate throughout its own backoff — exactly while it was asking us to
    // stop.
    state.nextAt = Math.max(state.nextAt, Date.now() + state.delayMs);
    this._hostState.set(host, state);
  }

  // ── Cookies ───────────────────────────────────────────────────────────────
  // Deliberately minimal: one name=value store per host, no path or expiry
  // modelling. It exists because undici's fetch keeps no cookie state at all, so
  // a site that hands out a session or consent cookie on the first response used
  // to serve the crawler its interstitial on every single page — the audit then
  // measured the interstitial, not the site.
  _rememberCookies(url, response) {
    const raw =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    if (!raw.length) return;
    const host = this._hostOf(url);
    if (!host) return;
    const jar = this._cookieJar.get(host) || new Map();
    for (const entry of raw) {
      const [pair] = String(entry).split(";");
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name) continue;
      // Bounded so a host that sets a new cookie per response cannot grow this.
      if (!jar.has(name) && jar.size >= 50) continue;
      jar.set(name, value);
    }
    if (jar.size) this._cookieJar.set(host, jar);
  }

  _cookieHeader(url) {
    const jar = this._cookieJar.get(this._hostOf(url));
    if (!jar?.size) return "";
    return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
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

  // Whether a thrown fetch failure is worth another attempt. A reset connection,
  // a keep-alive socket the origin closed under us, or a momentary DNS failure
  // all say "try again"; an abort, an SSRF refusal, or a bad URL do not.
  _isRetriableTransportError(error) {
    if (!error) return false;
    if (error.name === "AbortError" || error.name === "SsrfError") return false;
    // A per-attempt timeout IS retriable: the next attempt gets a fresh window.
    if (error.name === "TimeoutError") return true;
    const codes = new Set([
      "ECONNRESET",
      "ECONNREFUSED",
      "ECONNABORTED",
      "EPIPE",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENETRESET",
      "EAI_AGAIN",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_RESPONSE_STATUS_CODE",
    ]);
    // Depth-bounded rather than following `cause` to the end: an error chain can
    // be cyclic, and this must never be the thing that hangs the crawl.
    let cause = error;
    for (let depth = 0; cause && depth < 8; depth += 1, cause = cause.cause) {
      if (codes.has(cause.code)) return true;
      if (/socket hang up|other side closed|terminated/i.test(cause.message || "")) {
        return true;
      }
    }
    return false;
  }

  // Single outbound request point: per-host throttle, injected transport, then
  // bounded retry with Retry-After / exponential backoff on 429 and 503, and on
  // transport failures.
  async _politeFetch(url, init = {}, { timeout, signal } = {}) {
    const host = this._hostOf(url);
    let attempt = 0;
    for (;;) {
      if (this.stopped) throw new DOMException("Aborted", "AbortError");
      await this._throttleHost(host, signal);
      const attemptSignal = this._attemptSignal(timeout, signal);

      const cookie = this._cookieHeader(url);
      const headers = cookie ? { ...(init.headers || {}), Cookie: cookie } : init.headers;

      let response;
      try {
        // Timed here, around the request alone, so the figure describes the
        // server: the politeness slot and any retry backoff above are the
        // crawler's own waiting, not the site's response time.
        const requestStarted = performance.now();
        response = await this._fetch(url, { ...init, headers, signal: attemptSignal });
        RESPONSE_TIMINGS.set(response, Math.round(performance.now() - requestStarted));
      } catch (error) {
        // maxRetries advertised a retry budget that only ever covered two status
        // codes. A transport-level throw — socket hang up, connection reset,
        // transient DNS failure — escaped this loop on the first occurrence, and
        // the page was permanently recorded as an unreachable crawl failure.
        if (
          attempt < this.options.maxRetries &&
          !this.stopped &&
          this._isRetriableTransportError(error)
        ) {
          const wait = Math.min(
            this.options.retryBaseDelay * 2 ** attempt,
            this.options.maxRetryDelay,
          );
          this.emit("log", {
            level: "warning",
            message: `${host} ${error.name}: ${cleanText(error.message)}; retrying in ${wait}ms (retry ${attempt + 1}/${this.options.maxRetries})`,
          });
          await this._delay(wait, signal);
          attempt += 1;
          continue;
        }
        throw error;
      }

      this._rememberCookies(url, response);
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
        // Whether Googlebot may crawl it all the same: a URL closed to
        // CrawlScope alone is not blocked from Google, only from this audit.
        ...(this.googlebotRobotsRules
          ? { googlebotAllowed: isAllowedByRobots(job.url, this.googlebotRobotsRules) }
          : {}),
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
      // A seed the rules forbid still leaves robots.txt-declared sitemaps
      // readable, and skipping discovery here would silently reduce the crawl to
      // this one blocked row.
      if (job.seed && this.mode !== "list") await this._afterSeed(job, "");
      return;
    }

    const started = performance.now();
    let result;
    let pageEdges = null;

    // An external URL is only ever status-checked, so a GET made the origin
    // render a whole page whose body was then thrown away — and cancelling that
    // body destroys the keep-alive socket instead of returning it to the pool.
    // HEAD costs the origin nothing and keeps the connection reusable. Two
    // fallbacks cover servers that mishandle it: 405/501 below, and the timeout
    // retry in the catch.
    const fetchInit = (method) => ({
      method,
      redirect: "manual",
      headers: {
        "User-Agent": this.options.userAgent,
        Accept: job.external
          ? "*/*"
          : "text/html,application/xhtml+xml,application/xml,text/css,application/javascript;q=0.9,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.8",
      },
    });

    try {
      let response;
      try {
        response = await this._politeFetch(
          job.url,
          fetchInit(job.external ? "HEAD" : "GET"),
          { timeout: this.options.timeout, signal: this.rootController.signal },
        );
      } catch (error) {
        // A server that HANGS on HEAD is the same class of broken as one that
        // answers 405 — the difference is only which failure mode it picked,
        // and the 405/501 fallback below never runs because a timeout throws
        // before it. icann.org behind Cloudflare answers 301 to GET and never
        // responds to HEAD; without this retry, 966 findings on a single crawl
        // declared two live links broken.
        //
        // External only, once, and never for a deliberate stop() abort or an
        // SSRF refusal. Not only timeouts: a server that resets the connection
        // on HEAD is just as live when asked with GET.
        if (!job.external || this.stopped || error.name === "SsrfError") throw error;
        this.emit("log", {
          level: "warning",
          message: `${this._hostOf(job.url)} did not answer HEAD; retrying ${job.url} with GET`,
        });
        response = await this._politeFetch(job.url, fetchInit("GET"), {
          timeout: this.options.timeout,
          signal: this.rootController.signal,
        });
      }

      // Servers that answer HEAD with an error they would not give a GET: 405
      // and 501 by the book, but also 403, 404 and 400 from CDNs and apps that
      // only route GET. Every failing HEAD is asked once more with GET before
      // the link is called broken. The ones that never reply at all are
      // handled by the retry in the catch above.
      const usable =
        job.external && response.status >= 400
          ? await this._politeFetch(job.url, fetchInit("GET"), {
              timeout: this.options.timeout,
              signal: this.rootController.signal,
            })
          : response;
      if (usable !== response && response.body) {
        await response.body.cancel().catch(() => {});
      }

      // Time to first byte of the response actually used — excluding the
      // per-host queue and retry waits, which on the worker's 500ms/host
      // setting alone put nearly every page over the slow-page threshold.
      const responseTime =
        RESPONSE_TIMINGS.get(usable) ?? Math.round(performance.now() - started);
      const contentTypeHeader = headerValue(usable.headers, "content-type");
      let contentType = contentTypeHeader.split(";")[0].trim().toLowerCase();
      const redirectLocation = classifyRedirectLocation({
        status: usable.status,
        headerPresent: usable.headers.has("location"),
        rawValue: usable.headers.get("location") ?? "",
        responseUrl: job.url,
      });
      const redirectUrl =
        redirectLocation.kind === "valid" ? redirectLocation.url : "";
      const contentLength = Number(headerValue(usable.headers, "content-length")) || 0;
      // Content-Length is advisory: it is absent on every chunked response and
      // describes the COMPRESSED transfer when the body is encoded. It decides
      // nothing now except whether an obviously oversized body is worth opening.
      const wantsBody =
        !job.external &&
        (contentType === "" ||
          contentType.includes("html") ||
          TEXT_ASSET.test(contentType));
      let body = "";
      let bodyBytes = 0;
      let bodyTruncated = false;
      let sniffedHtml = false;
      let bodyError = "";
      // Whether the page says what encoding it is in: a byte-order mark, the
      // Content-Type charset, or a <meta> charset in its first 1,024 bytes (the
      // only place a browser looks for one). null for anything not HTML.
      let charsetDeclared = null;
      if (wantsBody) {
        try {
          const read = await this._readBodyBuffer(usable);
          bodyBytes = read.bytes;
          bodyTruncated = read.truncated;
          if (contentType === "" && looksLikeHtml(read.buffer)) {
            // A response with no Content-Type used to fail every branch: body
            // discarded, HTML parsing skipped, and isAsset forced true, so the
            // page was stored with no title, no links and no canonical, and was
            // dropped from every HTML check downstream.
            contentType = "text/html";
            sniffedHtml = true;
          }
          body =
            contentType.includes("html") || TEXT_ASSET.test(contentType)
              ? this._decodeBuffer(read.buffer, usable)
              : "";
          if (contentType.includes("html")) {
            charsetDeclared = Boolean(
              charsetFromBom(read.buffer) ||
                charsetFromContentType(headerValue(usable.headers, "content-type")) ||
                charsetFromMeta(read.buffer),
            );
          }
        } catch (error) {
          // The headers already told us the real status. Letting a mid-body
          // reset fall through to the outer handler threw that away and filed a
          // live 200 page as an unreachable crawl failure.
          if (this.stopped && error.name === "AbortError") throw error;
          bodyError = cleanText(error.message) || error.name;
          bodyTruncated = true;
        }
      } else if (usable.body) {
        await usable.body.cancel().catch(() => {});
      }

      // "Render JavaScript": audit the page as the browser builds it, not as
      // the server sent it. The browser is handed the response already read
      // here, so the page is not fetched twice. A page that cannot be rendered
      // is audited as served, and counted.
      let renderedWithJavaScript = false;
      if (
        this.options.renderJavaScript &&
        !job.external &&
        body &&
        contentType.includes("html") &&
        usable.status >= 200 &&
        usable.status < 300
      ) {
        const rendered = await this._renderedHtml(job.url, body, usable.status);
        if (typeof rendered === "string" && rendered) {
          body = rendered;
          renderedWithJavaScript = true;
        }
      }

      // The edges this page contributes, stored with its row (see snapshot()).
      // _extract is synchronous, so nothing else can push between here and its
      // return.
      const edgeMarks = [this.linkEdges.length, this.resourceEdges.length];
      try {
        result = this._extract({
          job,
          response: usable,
          body,
          contentType,
          contentLength,
          bodyBytes,
          bodyTruncated,
          bodyError,
          sniffedHtml,
          charsetDeclared,
          responseTime,
          redirectUrl,
          redirectLocation,
        });
      } catch (error) {
        // Extraction is parsing, not fetching. A throw in here is a defect in
        // our own analysis of a page that was served perfectly well, so it is
        // recorded against the real status rather than as a network failure.
        this.emit("log", {
          level: "error",
          message: `${job.url}: extraction failed (${cleanText(error.message)})`,
        });
        result = emptyResult(job, {
          status: usable.status,
          statusText: usable.statusText,
          contentType,
          responseTime,
          indexabilityReason: `Extraction failed: ${cleanText(error.message)}`,
        });
        result.issues = quickIssues(result);
      }
      if (renderedWithJavaScript) result.renderedWithJavaScript = true;
      // Empty lists for a page with no links are still its lists: a stored
      // row without them reads as a page whose links were never kept.
      pageEdges = {
        linkEdges: this.linkEdges.slice(edgeMarks[0]),
        resourceEdges: this.resourceEdges.slice(edgeMarks[1]),
      };

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
        // A seed's redirect belongs to _afterSeed, which has to re-anchor the
        // crawl on it first. Enqueueing it here as well would queue a same-host
        // hop twice — once in scope now, once as the seed continuation.
        !job.seed &&
        this._inScope(redirectUrl)
      ) {
        // Redirect hops share the SOURCE's depth rather than descending. A hop
        // is the same page at a different address, so charging it a level pushed
        // real pages past the depth ceiling and inflated every deep-page report.
        this._enqueueInternal(redirectUrl, job.depth, job.url);
      }

      // The chain the crawler actually walked, recorded on the row that started
      // it. The analyzer previously had to rebuild this by joining results on
      // URL, which silently produced a shorter chain whenever an intermediate
      // hop fell outside the crawl's scope and so was never fetched.
      if (redirectUrl) {
        result.redirectChain = [job.url, redirectUrl];
        result.finalUrl = redirectUrl;
      } else {
        result.finalUrl = job.url;
      }

      // Re-anchor on where the seed actually landed, then run site-file
      // discovery against that origin. Awaited inside _process so the scheduler
      // still counts this slot as active and cannot decide the crawl is finished
      // while discovery is outstanding.
      if (job.seed && !job.external && this.mode !== "list") {
        await this._afterSeed(job, redirectUrl);
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

      // An unreachable seed must not also cost the site its sitemap discovery:
      // robots.txt may still name sitemaps that are perfectly readable, and the
      // audit is more useful with them than without.
      if (job.seed && !job.external && this.mode !== "list" && !this.stopped) {
        await this._afterSeed(job, "").catch(() => {});
      }
    }

    // Fetched because CrawlScope may, but closed to Googlebot: blocked from
    // Google, which is what the audit reports.
    if (
      !job.external &&
      this.googlebotRobotsRules &&
      !isAllowedByRobots(job.url, this.googlebotRobotsRules)
    ) {
      result.googlebotDisallowed = true;
    }
    this.results.push(result);
    this.emit("result", result, pageEdges);
  }

  _extract({
    job,
    response,
    body,
    contentType,
    contentLength,
    bodyBytes = 0,
    bodyTruncated = false,
    bodyError = "",
    sniffedHtml = false,
    charsetDeclared = null,
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
    // A redirect response's Content-Type is frequently blank or meaningless —
    // the final destination hasn't been fetched yet, so there's nothing to
    // sniff. Falling back to "no text/html content-type => must be an asset"
    // on a 3xx response misclassifies ordinary internal navigation links
    // (tracking redirects, "goto" links) as resources: they pollute the
    // isAsset-bounded crawl budget and can surface as false "media" once
    // fetched to a real destination. Only trust the content-type fallback for
    // a response that actually served real content — job.isAsset (set at
    // discovery time from the URL's own extension/element context, see
    // `_enqueueInternal`) is still authoritative regardless of status.
    const isAsset =
      job.isAsset ||
      (!isRedirectStatus(response.status) &&
        !contentType.includes("text/html") &&
        !contentType.includes("xhtml"));
    const refreshHeaderValue = headerValue(response.headers, "refresh");
    const refreshHeader =
      !job.external &&
      contentType.includes("html") &&
      response.status >= 200 &&
      response.status < 300 &&
      refreshHeaderValue
        ? parseMetaRefresh(refreshHeaderValue, job.url, job.url)
        : null;
    // X-Robots-Tag is read here, before the non-HTML early return, and kept
    // separate from the meta tag. Two things were wrong before: it was only
    // consulted when <meta name="robots"> was ABSENT, so a page carrying both
    // reported itself indexable while the header said noindex; and it lived
    // inside the HTML-only branch, so a PDF or an image served with
    // X-Robots-Tag: noindex was always reported Indexable.
    const xRobotsTag = headerValue(response.headers, "x-robots-tag");
    // Evaluated for CrawlScope AND Googlebot: the audit reports how Google will
    // treat the page, and "googlebot: noindex" is a noindex for that purpose.
    const robotsAgents = auditAgents(this.robotsToken);
    const headerDirectives = robotsDirectivesFor(xRobotsTag, robotsAgents);
    const headerNonIndexable = isNoindex(headerDirectives);

    const base = emptyResult(job, {
      status: response.status,
      statusText: response.statusText,
      contentType,
      contentTypeSniffed: sniffedHtml,
      // Two different measurements that used to share one field: `size` was the
      // COMPRESSED transfer size when Content-Length was present and the
      // decoded size when it was not, so the column mixed units, and every
      // binary asset on a chunked response reported 0.
      size: bodyBytes || contentLength || Buffer.byteLength(body),
      transferSize: contentLength || 0,
      decodedSize: bodyBytes || Buffer.byteLength(body),
      bodyTruncated: Boolean(bodyTruncated),
      bodyError,
      responseTime,
      isAsset,
      xRobotsTag,
      robotsDirectives: [...headerDirectives],
      indexability: job.external
        ? "External"
        : headerNonIndexable
          ? "Non-indexable"
          : response.status >= 200 && response.status < 300
            ? "Indexable"
            : "Non-indexable",
      indexabilityReason: job.external
        ? ""
        : headerNonIndexable
          ? "X-Robots-Tag contains noindex"
          : response.status >= 200 && response.status < 300
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
      this._pushEdge(this.resourceEdges, edge);
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
    // Every robots directive that applies to this page, from BOTH sources. The
    // header is no longer a fallback for a missing meta tag: a page can carry
    // both, and when it does they combine rather than one hiding the other.
    //
    // EVERY robots and googlebot meta tag, not the first of each: Google
    // combines all of them and the most restrictive wins, so a theme's
    // "index, follow" followed by a plugin's "noindex" is a noindexed page.
    // Reading .first() reported it indexable.
    const metaRobotsValues = documentElements(
      $,
      'meta[name="robots" i], meta[name="googlebot" i]',
    )
      .map((_, element) => cleanText($(element).attr("content") || ""))
      .get()
      .filter(Boolean);
    const metaDirectives = robotsDirectivesFor(metaRobotsValues.join(", "), robotsAgents);
    const robotsDirectives = new Set([...metaDirectives, ...headerDirectives]);
    // The raw values, kept for display and evidence only — every decision
    // below reads the parsed directive set.
    const robots = [...metaRobotsValues, xRobotsTag].filter(Boolean).join(", ");

    // Canonical and hreflang can also arrive in the HTTP Link header, which was
    // never read — a header-declared canonical was reported as missing.
    const linkHeader = parseLinkHeader(headerValue(response.headers, "link"));

    // `new URL("", base)` resolves to the BASE, so normalizeUrl("") returns the
    // page's own address rather than nothing. Every one of these fields was
    // therefore self-referencing whenever its <link> was absent — which is why
    // an absent rel=next used to read as "next page: this page". The presence of
    // the attribute has to be tested before its value is resolved.
    const declaredHref = (selector) => {
      const href = documentElements($, selector).first().attr("href");
      return typeof href === "string" ? href.trim() : "";
    };
    const headerUrl = (...rels) => {
      const entry = linkHeader.find((item) => rels.some((rel) => item.rels.includes(rel)));
      return entry ? normalizeUrl(entry.url, job.url) || "" : "";
    };
    const resolveLink = (selector, ...rels) => {
      const href = declaredHref(selector);
      if (href) return normalizeUrl(href, documentBase.url) || "";
      return headerUrl(...rels);
    };

    // Canonical keeps its long-standing "absent means self-referencing"
    // reading, which the analyzer's canonical rules are all written against.
    //
    // Only <head> counts: search engines ignore a rel=canonical in <body>
    // (including one the HTML parser moved there because something that does
    // not belong in <head> came before it), so the first tag anywhere was not
    // the page's canonical. Every distinct canonical the page declares — in
    // <head> and in the Link header — is kept, since two that disagree are a
    // conflict search engines resolve by ignoring both.
    const canonicalHrefs = (selector) =>
      documentElements($, selector)
        .map((_, element) => String($(element).attr("href") ?? "").trim())
        .get()
        .filter(Boolean);
    const headerCanonical = headerUrl("canonical");
    const canonicals = [
      ...new Set([
        ...canonicalHrefs('head link[rel~="canonical" i]')
          .map((href) => normalizeUrl(href, documentBase.url))
          .filter(Boolean),
        ...(headerCanonical ? [headerCanonical] : []),
      ]),
    ];
    const canonicalsOutsideHead = [
      ...new Set(
        canonicalHrefs('body link[rel~="canonical" i]')
          .map((href) => normalizeUrl(href, documentBase.url))
          .filter(Boolean),
      ),
    ];
    const canonical = canonicals[0] || documentBase.url;

    const hreflangEntries = documentElements(
      $,
      'link[rel~="alternate" i][hreflang]',
    )
      .map((_, element) => {
        const href = String($(element).attr("href") || "").trim();
        return {
          lang: ($(element).attr("hreflang") || "").trim().toLowerCase(),
          url: href ? normalizeUrl(href, documentBase.url) || "" : "",
        };
      })
      .get();
    for (const entry of linkHeader) {
      if (!entry.rels.includes("alternate") || !entry.hreflang) continue;
      hreflangEntries.push({
        lang: entry.hreflang.toLowerCase(),
        url: normalizeUrl(entry.url, job.url) || "",
      });
    }
    const hreflangSeen = new Set();
    const hreflangs = hreflangEntries.filter((entry) => {
      if (!entry.lang || !entry.url) return false;
      const key = `${entry.lang}|${entry.url}`;
      if (hreflangSeen.has(key)) return false;
      hreflangSeen.add(key);
      return true;
    });

    const paginationNext = resolveLink('link[rel~="next" i]', "next");
    const paginationPrev = resolveLink(
      'link[rel~="prev" i], link[rel~="previous" i]',
      "prev",
      "previous",
    );

    // Pagination, canonical and hreflang targets were parsed and then dropped on
    // the floor. rel=next in particular is how a great many archives expose page
    // 2 onwards without a visible anchor, so those pages were never crawled at
    // all and the audit reported one page of an eighty-page archive.
    if (this.mode !== "list" && !job.external) {
      for (const discovered of [paginationNext, paginationPrev, canonical]) {
        if (!discovered || discovered === job.url) continue;
        if (!this._inScope(discovered, job)) continue;
        this._enqueueInternal(discovered, job.depth + 1, "");
      }
      for (const entry of hreflangs) {
        if (entry.url === job.url) continue;
        if (!this._inScope(entry.url, job)) continue;
        this._enqueueInternal(entry.url, job.depth + 1, "");
      }
    }

    // One traversal for every heading-derived field: h1Count, h2Count, the
    // joined h1/h2 strings and the hierarchy check used to run three separate
    // selector passes over the same document. Raw $ rather than
    // documentElements, deliberately — pruneInertTemplates has already removed
    // the inert templates, and what remains inside a <template shadowrootmode>
    // is attached as a live shadow tree, so it IS rendered page content.
    const headingElements = $("h1,h2,h3,h4,h5,h6").toArray();
    const headingCount = (tag) =>
      headingElements.filter((element) => element.tagName.toLowerCase() === tag).length;
    const headingTexts = (tag) =>
      headingElements
        .filter((element) => element.tagName.toLowerCase() === tag)
        .map((element) => cleanText($(element).text()))
        .filter(Boolean);
    const h1Values = headingTexts("h1");
    const h2Values = headingTexts("h2");
    const visibleText = visibleTextOf($);
    const words = visibleText ? visibleText.split(/\s+/).length : 0;
    const mainText = mainContentTextOf($);
    const mainWords = mainText ? mainText.split(/\s+/).length : 0;
    const links = new Set();
    let externalLinks = 0;
    const headings = headingElements.map((element) => ({
      level: Number(element.tagName.slice(1)),
      text: cleanText($(element).text()),
    }));
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
    // Built on first use, not on every page. This walked EVERY element carrying
    // an id and called .text() on each one — a full extra traversal with heavy
    // string building — to serve aria-labelledby, which most pages never use.
    let labelledTextById = null;
    const resolveLabelledBy = (value) => {
      const ids = String(value || "").split(/\s+/).filter(Boolean);
      if (!ids.length) return "";
      if (!labelledTextById) {
        labelledTextById = new Map();
        $("[id]").each((_, element) => {
          const id = ($(element).attr("id") || "").trim();
          if (id && !labelledTextById.has(id)) {
            labelledTextById.set(id, cleanText($(element).text()));
          }
        });
      }
      return cleanText(ids.map((id) => labelledTextById.get(id) || "").join(" "));
    };
    const isHiddenFromAccessibilityTree = (element) =>
      $(element).closest('[aria-hidden="true"], [hidden]').length > 0;

    // <area href> is a real navigable link — an image map is how some sites
    // still build their primary navigation — and it was never extracted, so
    // everything reachable only through one was invisible to discovery.
    let anchorCount = 0;
    $("a[href], area[href]").each((_, element) => {
      const link = $(element);
      const href = (link.attr("href") || "").trim();
      if (!href || SKIP_SCHEMES.test(href)) return;
      const normalized = normalizeUrl(href, documentBase.url);
      if (!normalized) return;
      anchorCount += 1;
      const internal = this._inScope(normalized, job);
      const rel = (link.attr("rel") || "").toLowerCase();
      const relTokens = rel.split(/[\s,]+/).filter(Boolean);
      // Cloning every anchor duplicated its whole subtree once per link, which
      // on a 500-link page is 500 subtree copies purely to strip a few nodes.
      // Only the anchors that actually contain something to strip are cloned.
      const strippable = link.find(
        '[aria-hidden="true"], [hidden], script, style, svg title, svg desc',
      );
      let anchorText;
      if (strippable.length) {
        const textClone = link.clone();
        textClone
          .find('[aria-hidden="true"], [hidden], script, style, svg title, svg desc')
          .remove();
        anchorText = cleanText(textClone.text());
      } else {
        anchorText = cleanText(link.text());
      }
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
      this._pushEdge(this.linkEdges, {
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
        const tag = element.tagName.toLowerCase();
        trackResource({
          sourceUrl: job.url,
          targetUrl: normalized,
          tag,
          sourceAttribute: attribute,
          // What a <link> loads — a stylesheet, an icon, a manifest — is its
          // rel, and a broken one is reported by what it is.
          ...(tag === "link" ? { rel: cleanText($(element).attr("rel")).toLowerCase() } : {}),
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

    const nonIndexableDirective = isNoindex(robotsDirectives);
    const schemaInfo = schemaErrorsFromPage($);
    const integrations = detectIntegrations($, integrationCatalog);
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
      h1Count: headingCount("h1"),
      h1: joinHeadings(h1Values),
      h2Count: headingCount("h2"),
      h2: joinHeadings(h2Values),
      words,
      textHtmlRatio: body.length ? visibleText.length / body.length : 0,
      headingHierarchyIssue,
      headingHierarchyIssues,
      indexability: nonIndexableDirective ? "Non-indexable" : base.indexability,
      // Credited to the source that actually carried it: a header-only noindex
      // keeps the "X-Robots-Tag contains noindex" reason set above.
      indexabilityReason: isNoindex(metaDirectives)
        ? "Meta robots contains noindex"
        : base.indexabilityReason,
      robotsDirectives: [...robotsDirectives],
      // The document's declared language; "" when <html> has no lang.
      htmlLang: String($("html").first().attr("lang") || "").trim(),
      charsetDeclared,
      // A doctype before anything but whitespace and comments; without one the
      // browser renders in quirks mode.
      doctypeDeclared: /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype\s+html\b/i.test(body),
      canonical,
      canonicals,
      canonicalsOutsideHead,
      hreflangs,
      paginationNext,
      paginationPrev,
      robots,
      outlinks: links.size,
      externalLinks,
      hash: crypto.createHash("sha1").update(visibleText).digest("hex"),
      // The main content's size and MinHash fingerprint (text-fingerprint.js),
      // for near-duplicate detection. No fingerprint for a page with too
      // little of its own text to compare.
      mainWords,
      contentSignature: mainWords >= NEAR_DUPLICATE_MIN_WORDS ? contentSignature(mainText) : "",
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
      schemaErrors: schemaInfo.errors,
      schemaTypes: schemaInfo.types,
      integrations,
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
      anchorCount,
    });
    base.issues = quickIssues(base);
    this._noteRenderingGap(job, base, anchorCount);
    return base;
  }

  // This crawler parses served HTML; it does not execute JavaScript. On a
  // client-rendered site that means the seed comes back as a shell with no
  // anchors and no text, the crawl ends at one page, and — because nothing was
  // broken — the audit reads as CLEAN. An empty result set and a healthy site
  // looked identical. Now the shape is named.
  _noteRenderingGap(job, result, anchorCount) {
    if (this.mode === "list" || job.external) return;
    if (job.url !== this.startUrl) return;
    if (result.status < 200 || result.status >= 300) return;
    if (anchorCount > 0) return;
    if (this.siteDiagnostics.renderingIssue) return;
    this.siteDiagnostics.renderingIssue =
      result.words < 50
        ? "The entry page returned no links and almost no text. This is the signature of a " +
          "client-rendered (JavaScript) site: CrawlScope reads served HTML and does not " +
          "execute JavaScript, so its content and internal links were not visible to this crawl."
        : "The entry page returned readable text but no crawlable links, so no further page " +
          "could be discovered from it. Navigation rendered by JavaScript is not visible to " +
          "this crawl.";
    this.emit("log", {
      level: "warning",
      message: this.siteDiagnostics.renderingIssue,
    });
  }
}

module.exports = {
  SeoCrawler,
  normalizeUrl,
  parseRobots,
  isAllowedByRobots,
  // Exported for tests. Underscore-prefixed because they are implementation
  // detail, not part of the module's contract with the rest of the app.
  __decodeXml: decodeXml,
  __parseLinkHeader: parseLinkHeader,
  __robotsDirectivesFor: robotsDirectivesFor,
  __assertGraphReady: assertGraphReady,
};
