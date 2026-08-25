// Authoritative crawl-option validation for the hosted service.
//
// The desktop app trusted the client. The server must not: a browser can POST any
// maxUrls/concurrency/timeout it likes. This module validates and clamps every
// request against env-configured ceilings BEFORE a run is accepted, so a caller
// can never exceed the operator's limits. The crawler applies its own hard caps
// too; these are the (usually stricter) hosted policy on top.

const { z } = require("zod");

function intCeiling(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function ceilings() {
  return {
    maxUrls: intCeiling("MAX_URLS_CEILING", 5_000),
    maxExternalUrls: intCeiling("MAX_EXTERNAL_CEILING", 500),
    concurrency: intCeiling("MAX_CONCURRENCY_CEILING", 8),
    timeout: intCeiling("TIMEOUT_CEILING_MS", 30_000),
    perHostDelay: intCeiling("PER_HOST_DELAY_MS", 250),
  };
}

const clampInt = (min, max) => (value) => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(n, max));
};

const urlSchema = z
  .string()
  .trim()
  .min(1, "A URL is required.")
  .refine((value) => {
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "Enter a valid http:// or https:// URL.");

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

// Validates a batch of URLs for list mode: dedupes, drops invalid entries (rather
// than failing the whole request over one bad line), and caps the count at the
// maxUrls ceiling. Throws if nothing valid remains.
function parseUrlList(candidates, cap) {
  const cleaned = [];
  const seen = new Set();
  let invalid = 0;
  for (const candidate of candidates) {
    const result = urlSchema.safeParse(candidate);
    if (!result.success) {
      invalid += 1;
      continue;
    }
    if (seen.has(result.data)) continue;
    seen.add(result.data);
    cleaned.push(result.data);
  }
  if (!cleaned.length) {
    throw new ValidationError("Provide at least one valid http:// or https:// URL.");
  }
  const truncated = cleaned.length > cap.maxUrls;
  return { urls: cleaned.slice(0, cap.maxUrls), invalid, truncated };
}

// Returns { url, options, listInfo? } ready for `new SeoCrawler(options)` (pass
// `options.urls` to start() when present), or throws ValidationError (status 400).
// `overrides` lets the worker tighten politeness for unattended crawls. Overrides are
// monotonic — they can only ever slow a crawl down, never speed it up past what the
// request asked for — so an override can't accidentally make the worker less polite
// than an interactive run. `body.urls` (array) selects list mode instead of the
// single-URL `body.url` spider mode.
function parseCrawlRequest(body = {}, overrides = {}) {
  const cap = ceilings();
  const raw = body.options && typeof body.options === "object" ? body.options : body;

  let url;
  let listUrls;
  let listInfo;

  if (Array.isArray(body.urls)) {
    const parsed = parseUrlList(body.urls, cap);
    listUrls = parsed.urls;
    listInfo = { count: listUrls.length, invalid: parsed.invalid, truncated: parsed.truncated };
    url = `List crawl (${listUrls.length} URL${listUrls.length === 1 ? "" : "s"})`;
  } else {
    const urlResult = urlSchema.safeParse(body.url);
    if (!urlResult.success) {
      throw new ValidationError(urlResult.error.issues[0]?.message || "Invalid URL.");
    }
    url = urlResult.data;
  }

  const options = {
    maxUrls: listUrls
      ? listUrls.length
      : clampInt(1, cap.maxUrls)(raw.maxUrls ?? 500),
    maxExternalUrls: clampInt(0, cap.maxExternalUrls)(raw.maxExternalUrls ?? 150),
    concurrency: clampInt(1, cap.concurrency)(
      Math.min(raw.concurrency ?? 4, overrides.concurrency ?? Number.POSITIVE_INFINITY),
    ),
    timeout: clampInt(3_000, cap.timeout)(raw.timeout ?? 15_000),
    perHostDelay: clampInt(0, 60_000)(
      Math.max(raw.perHostDelay ?? cap.perHostDelay, overrides.perHostDelay ?? 0),
    ),
    respectRobots: raw.respectRobots !== false,
    includeSubdomains: raw.includeSubdomains === true,
    crawlAssets: raw.crawlAssets !== false,
    checkExternalLinks: raw.checkExternalLinks !== false,
    discoverSitemaps: raw.discoverSitemaps !== false,
  };
  if (listUrls) options.urls = listUrls;

  return { url, options, listInfo };
}

module.exports = { parseCrawlRequest, ceilings, ValidationError };
