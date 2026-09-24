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
    // Brought back down to 500 (from a 10,000-page-audit ceiling that was
    // itself a raise from an original 500). Env-overridable (MAX_URLS_CEILING)
    // without a redeploy if that ever needs to change again.
    maxUrls: intCeiling("MAX_URLS_CEILING", 500),
    maxExternalUrls: intCeiling("MAX_EXTERNAL_CEILING", 500),
    concurrency: intCeiling("MAX_CONCURRENCY_CEILING", 8),
    timeout: intCeiling("TIMEOUT_CEILING_MS", 30_000),
    // Every request to one host is serialized to one every `perHostDelay`
    // (crawler.js#_throttleHost), independent of `concurrency` — concurrency
    // only helps when a crawl is spread across multiple hosts, which a normal
    // same-site crawl is not. So this single number is the real floor on how
    // long a crawl takes: at 250ms, a 500-page site crawl needed 125s just
    // from spacing, before any fetch time. 100ms is still real pacing (10
    // requests/sec to one host) while cutting that floor by more than half.
    perHostDelay: intCeiling("PER_HOST_DELAY_MS", 100),
    // Trap-control ceilings. A crawl used to be bounded by maxUrls alone, which
    // a calendar or a faceted-nav grid will happily consume in full before the
    // real site is reached.
    maxDepth: intCeiling("MAX_DEPTH_CEILING", 20),
    // Raised alongside maxUrls: at the old 500-per-template cap, a real
    // 10,000-page crawl would trip trap detection on its own largest
    // legitimate section (a flat product catalog or paginated blog easily
    // exceeds 500 same-template pages) before ever reaching 10k — the trap
    // guard would fire on real inventory, not a runaway parameter grid. 2,000
    // still catches genuine explosions (a faceted-nav trap generates orders
    // of magnitude more than that from one template) while giving a large
    // legitimate section room to be fully crawled.
    maxUrlsPerTemplate: intCeiling("MAX_URLS_PER_TEMPLATE", 2_000),
    maxEdges: intCeiling("MAX_EDGES_CEILING", 1_000_000),
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
  return { urls: cleaned.slice(0, cap.maxUrls), invalid, truncated, total: cleaned.length };
}

// Returns { url, options, listInfo?, budgetClamped } ready for `new SeoCrawler(options)` (pass
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
  let listTotal = 0;

  if (Array.isArray(body.urls)) {
    const parsed = parseUrlList(body.urls, cap);
    listUrls = parsed.urls;
    listTotal = parsed.total;
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
    // Defaults to the ceiling: 150 left most external links on a real site
    // unchecked, and nothing said so.
    maxExternalUrls: clampInt(0, cap.maxExternalUrls)(raw.maxExternalUrls ?? cap.maxExternalUrls),
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
    // Trap control. Like perHostDelay these are monotonic against the operator's
    // ceiling: a caller may ask for a tighter bound, never a looser one.
    maxDepth: clampInt(1, cap.maxDepth)(
      Math.min(raw.maxDepth ?? cap.maxDepth, overrides.maxDepth ?? Number.POSITIVE_INFINITY),
    ),
    maxUrlsPerTemplate: clampInt(1, cap.maxUrlsPerTemplate)(
      Math.min(
        raw.maxUrlsPerTemplate ?? cap.maxUrlsPerTemplate,
        overrides.maxUrlsPerTemplate ?? Number.POSITIVE_INFINITY,
      ),
    ),
    maxEdges: clampInt(1_000, cap.maxEdges)(raw.maxEdges ?? cap.maxEdges),
    respectCrawlDelay: raw.respectCrawlDelay !== false,
    // Which User-Agent the crawl sends (crawler.js USER_AGENT_PROFILES). A
    // name from a fixed list, never a free string: robots.txt matching and the
    // site's logs both depend on it saying CrawlScope.
    userAgentProfile: raw.userAgentProfile === "mobile" ? "mobile" : "desktop",
    // Render a sample of the crawled pages in a headless browser after the
    // crawl, to see whether JavaScript adds links or content or changes the
    // head tags (render-check.js). On unless asked not to.
    renderCheck: raw.renderCheck !== false,
    // Audit every page as rendered in a headless browser. Off unless asked.
    renderJavaScript: raw.renderJavaScript === true,
    renderSampleSize: clampInt(1, 25)(raw.renderSampleSize ?? 10),
  };
  if (listUrls) options.urls = listUrls;

  // A request for more pages than the operator ceiling allows is REDUCED rather
  // than rejected — but it was reduced SILENTLY, and that silence is how a
  // temporary 50-URL cap in .env read as a crawler bug: ask for 500, get 50,
  // with nothing anywhere saying so. The run then reports a ceiling of
  // maxUrls + maxExternalUrls (crawler._progress), so the only number the user
  // ever sees is one nobody requested. Reported here so a caller can say it out
  // loud, the same way store.updateProject audits crawlBudgetClampedByPolicy.
  //
  // Null unless the caller EXPLICITLY asked for more than it got. The default
  // being filled in and clamped to the ceiling is not a clamp anyone asked
  // about, and reporting that would cry wolf on every ordinary request.
  let budgetClamped = null;
  if (listUrls) {
    if (listInfo.truncated) {
      budgetClamped = { requested: listTotal, granted: listUrls.length, ceiling: cap.maxUrls };
    }
  } else if (raw.maxUrls !== undefined) {
    const asked = Math.floor(Number(raw.maxUrls));
    if (Number.isFinite(asked) && asked > options.maxUrls) {
      budgetClamped = { requested: asked, granted: options.maxUrls, ceiling: cap.maxUrls };
    }
  }

  return { url, options, listInfo, budgetClamped };
}

module.exports = { parseCrawlRequest, ceilings, ValidationError };
