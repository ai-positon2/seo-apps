// Authoritative crawl-option validation for the hosted service.
//
// The desktop app trusted the client. The server must not: a browser can POST any
// maxUrls/concurrency/timeout it likes. This module validates and clamps every
// request BEFORE a run is accepted, so a caller can never exceed the limits in
// force. The crawler applies its own hard caps too; these are the (usually
// stricter) hosted policy on top.
//
// ── Where the ceiling comes from ────────────────────────────────────────────
//
// One place: the workspace's effective admin limits, passed in as
// `overrides.limits` by whoever resolved them (run/manager.js for every executed
// run, api/routes.js for the 201 on POST /runs). This module no longer reads
// MAX_URLS_CEILING and friends itself.
//
// It used to, and that was the bug. There were two ceilings — the env one here
// and the admin policy passed in as `overrides.maxUrls` — combined with
// Math.min, so an operator's .env could silently undercut the admin's setting.
// Worse, the combined value was computed and then not used: the spider-mode
// budget below clamped against the ENV ceiling alone, so the admin limit did not
// bind a spider crawl at all, while `budgetClamped` cheerfully reported that it
// had. Now there is one ceiling and nothing left to pick the wrong one of.
//
// When no limits are passed, adminLimits.baseLimits() supplies platform defaults
// with the env fallback applied — the server-without-a-database case, and the
// only place those env vars still mean anything.

const { z } = require("zod");
const { resolveThresholds } = require("../thresholds");
const adminLimits = require("../../../services/adminLimits");

// Politeness and trap controls. These have no admin key: they are not a
// customer-facing budget but the crawler's own manners, tightened per run by the
// worker. Env stays the right surface for them.
function envKnob(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

// adminLimits.validateLimits() guards what gets STORED, but this is the last
// gate before a crawler is constructed and a malformed row — or a caller passing
// a half-built object — must not become `maxUrls: NaN`. A bad value falls back
// to the platform default rather than to 1, which would look like a working
// crawl that found one page.
function positive(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// `limits` is an effective limit set from services/adminLimits (the admin's
// numbers). Anything not governed by an admin key falls through to envKnob.
function ceilings(limits) {
  const L = limits || adminLimits.baseLimits().limits;
  const D = adminLimits.DEFAULT_LIMITS;
  return {
    maxUrls: positive(L.maxUrlsPerCrawl, D.maxUrlsPerCrawl),
    concurrency: positive(L.maxCrawlConcurrency, D.maxCrawlConcurrency),
    timeout: positive(L.requestTimeoutMs, D.requestTimeoutMs),
    // Trap control. A crawl used to be bounded by maxUrls alone, which a
    // calendar or a faceted-nav grid will happily consume in full before the
    // real site is reached.
    maxDepth: positive(L.maxCrawlDepth, D.maxCrawlDepth),
    maxExternalUrls: envKnob("MAX_EXTERNAL_CEILING", 500),
    // Every request to one host is serialized to one every `perHostDelay`
    // (crawler.js#_throttleHost), independent of `concurrency` — concurrency
    // only helps when a crawl is spread across multiple hosts, which a normal
    // same-site crawl is not. So this single number is the real floor on how
    // long a crawl takes: at 250ms, a 500-page site crawl needed 125s just
    // from spacing, before any fetch time. 100ms is still real pacing (10
    // requests/sec to one host) while cutting that floor by more than half.
    perHostDelay: envKnob("PER_HOST_DELAY_MS", 100),
    // At the old 500-per-template cap, a large crawl would trip trap detection
    // on its own largest legitimate section (a flat product catalog or
    // paginated blog easily exceeds 500 same-template pages) — the trap guard
    // would fire on real inventory, not a runaway parameter grid. 2,000 still
    // catches genuine explosions (a faceted-nav trap generates orders of
    // magnitude more than that from one template) while giving a large
    // legitimate section room to be fully crawled.
    maxUrlsPerTemplate: envKnob("MAX_URLS_PER_TEMPLATE", 2_000),
    maxEdges: envKnob("MAX_EDGES_CEILING", 1_000_000),
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

// ── Crawl scope ─────────────────────────────────────────────────────────────
// Lists typed into a form arrive as one string (a line, or a comma, per entry)
// or as an array. Either way: trimmed, blank lines and # comments dropped,
// duplicates removed, and bounded.
const MAX_PATTERNS = 50;
const MAX_PARAMETERS = 50;
const MAX_SITEMAPS = 10;

function entriesOf(value, separators = /\r?\n/) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(separators) : [];
  return list
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry && !entry.startsWith("#"));
}

// URL patterns in robots.txt's syntax (url-scope.js). A full URL pasted in is
// taken as its path.
function patternList(value) {
  const patterns = entriesOf(value).map((entry) => {
    if (!/^https?:\/\//i.test(entry)) return entry;
    try {
      const parsed = new URL(entry.replace(/\*/g, "__STAR__"));
      return `${parsed.pathname}${parsed.search}`.replace(/__STAR__/g, "*");
    } catch {
      return entry;
    }
  });
  return [...new Set(patterns.filter((entry) => entry.length <= 200))].slice(0, MAX_PATTERNS);
}

// Parameter names, compared without case; "*" for every parameter.
function parameterList(value) {
  return [...new Set(entriesOf(value, /[\r\n,]+/).map((name) => name.toLowerCase()).filter((name) => name.length <= 100))]
    .slice(0, MAX_PARAMETERS);
}

function sitemapList(value) {
  const urls = [];
  for (const entry of entriesOf(value)) {
    const result = urlSchema.safeParse(entry);
    if (!result.success) throw new ValidationError(`Sitemap URL "${entry.slice(0, 80)}" is not a valid http:// or https:// URL.`);
    urls.push(new URL(result.data).href);
  }
  return [...new Set(urls)].slice(0, MAX_SITEMAPS);
}

// Returns { url, options, listInfo?, budgetClamped } ready for `new SeoCrawler(options)` (pass
// `options.urls` to start() when present), or throws ValidationError (status 400).
//
// `overrides` carries two different things:
//
//   overrides.limits / overrides.sources
//       the workspace's effective admin limits and where each came from
//       (services/adminLimits.effectiveLimits). This IS the ceiling — see the
//       file header. `sources` only makes the result explainable; it never
//       changes a number.
//
//   overrides.perHostDelay / .concurrency / .maxDepth / .maxUrls / ...
//       per-run tightenings the worker applies so unattended crawls are politer
//       than interactive ones. Monotonic: they can only slow a crawl down or
//       make it smaller, never speed it up past what the request asked for, so
//       an override can't make the worker less polite than the web path.
//
// `body.urls` (array) selects list mode instead of the single-URL `body.url`
// spider mode.
//
// ── This is where the Admin limit becomes real ──────────────────────────────
//
// adminLimits.maxUrlsPerCrawl used to clamp only a project's STORED options, at
// create and patch time. Nothing consulted it when a run actually started, so
// lowering the limit left every existing project crawling at the number it was
// created with. Setting 500 in Admin and getting 10,000 pages was the symptom.
// run/manager.js resolves the policy per run and passes it here, which is the
// one place every path — manual, scheduled, worker, autostart, list — funnels
// through.
function parseCrawlRequest(body = {}, overrides = {}) {
  const cap = ceilings(overrides.limits);
  const sources = overrides.sources || adminLimits.baseLimits().sources;
  const raw = body.options && typeof body.options === "object" ? body.options : body;

  // Resolved BEFORE the URL list is parsed, because a list crawl is bounded by
  // how many URLs it keeps — truncating it to the admin ceiling and only then
  // applying a run tightening would let a 5,000-URL list run in full for a run
  // that asked to be capped at 500.
  const runMaxUrls = Number.isFinite(Number(overrides.maxUrls)) && Number(overrides.maxUrls) > 0
    ? Math.floor(Number(overrides.maxUrls))
    : null;
  const effectiveCeiling = runMaxUrls === null ? cap.maxUrls : Math.min(cap.maxUrls, runMaxUrls);

  // ── Storing a preference vs executing a run ────────────────────────────────
  //
  // `overrides.storing` marks a request being SAVED as a project's preference
  // rather than executed now (projects/store.js and CrawlScope's own POST/PATCH
  // /projects). The two want different things from the same body.
  //
  // A stored budget clamped to today's policy is a budget frozen at today's
  // policy. Raise the workspace limit next month and every existing project
  // keeps crawling the number it was created with, because the stored value is
  // now the smaller of the two — that is how a real client sat at 150 pages,
  // re-crawling 150 pages a week, while every score on the dashboard described
  // that fraction of the site. So when storing: bounded only by the platform
  // hard maximum, and an absent budget STAYS absent. The executing run fills it
  // in from the policy in force at the time, which is the only moment the
  // question has a correct answer.
  //
  // List mode is deliberately not affected: an explicit URL list is content, not
  // a number, and storing 50,000 of them in a jsonb column is its own problem.
  const storing = overrides.storing === true;
  const storeCeiling = {
    maxUrls: adminLimits.HARD_MAX.maxUrlsPerCrawl,
    maxDepth: adminLimits.HARD_MAX.maxCrawlDepth,
  };
  // Which surface to name when a request is cut. The admin limit's own
  // provenance ('platform' | 'workspace' | 'tier' | 'env_fallback' |
  // 'hard_max' | 'default') unless a per-run tightening went lower still.
  const clampSource = runMaxUrls !== null && runMaxUrls < cap.maxUrls
    ? 'run_override'
    : (sources.maxUrlsPerCrawl || 'default');

  let url;
  let listUrls;
  let listInfo;
  let listTotal = 0;

  if (Array.isArray(body.urls)) {
    const parsed = parseUrlList(body.urls, { ...cap, maxUrls: effectiveCeiling });
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
    // List mode counts the URLs actually kept — parseUrlList has already
    // truncated them to the ceiling below, so the two agree.
    // `effectiveCeiling`, NOT cap.maxUrls. Clamping against the raw ceiling here
    // while the effective one was computed above is exactly how the admin limit
    // came to bind list crawls but not spider crawls.
    maxUrls: listUrls
      ? listUrls.length
      : storing
        ? (raw.maxUrls === undefined ? undefined : clampInt(1, storeCeiling.maxUrls)(raw.maxUrls))
        : clampInt(1, effectiveCeiling)(raw.maxUrls ?? effectiveCeiling),
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
    maxDepth: storing
      ? (raw.maxDepth === undefined ? undefined : clampInt(1, storeCeiling.maxDepth)(raw.maxDepth))
      : clampInt(1, cap.maxDepth)(
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
    // What part of the site to crawl (url-scope.js). Patterns follow
    // robots.txt: "/blog/*" from the start of the path, "*?sort=" anywhere,
    // "$" for the end. The start page is crawled whatever they say.
    includePatterns: patternList(raw.includePatterns),
    excludePatterns: patternList(raw.excludePatterns),
    // Only URLs under the start URL's path.
    scopeToFolder: raw.scopeToFolder === true,
    // Query parameters that do not make a different page (sort orders,
    // filters, view modes): removed before a URL is crawled or compared.
    removeParameters: parameterList(raw.removeParameters),
    // Sitemaps to read besides the ones robots.txt names (or /sitemap.xml).
    sitemapUrls: sitemapList(raw.sitemapUrls),
    // The limits pages are judged by (thresholds.js): title and description
    // lengths, thin content, slow responses, click depth, URL length, links.
    thresholds: resolveThresholds(raw.thresholds),
  };
  if (listUrls) options.urls = listUrls;
  // Storing mode leaves an unstated budget unstated rather than writing a
  // number the caller never chose. Drop the key entirely so the stored blob says
  // "no preference" instead of "maxUrls: null", which reads as a real setting.
  if (options.maxUrls === undefined) delete options.maxUrls;
  if (options.maxDepth === undefined) delete options.maxDepth;

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
  // `ceiling` is the EFFECTIVE one. Reporting a raw operator number here would
  // tell a workspace capped at 500 that its ceiling is 10,000, which is the same
  // silence this field exists to break. `source` names the surface that actually
  // bound the run, so "why did I only get 500" has an answer without reading two
  // config screens.
  let budgetClamped = null;
  if (listUrls) {
    if (listInfo.truncated) {
      budgetClamped = {
        requested: listTotal, granted: listUrls.length, ceiling: effectiveCeiling, source: clampSource,
      };
    }
  } else if (raw.maxUrls !== undefined) {
    const asked = Math.floor(Number(raw.maxUrls));
    if (Number.isFinite(asked) && asked > options.maxUrls) {
      budgetClamped = {
        requested: asked, granted: options.maxUrls, ceiling: effectiveCeiling, source: clampSource,
      };
    }
  }

  return { url, options, listInfo, budgetClamped };
}

// The one way a crawl entry path gets its ceiling. Every caller that starts or
// accepts a run funnels through here: api/routes.js (POST /runs), run/manager.js
// (every executed run) and projects/crawlAutostart.js.
//
// Never throws. An unreachable limits table must not stop a crawl from being
// accepted or executed, so a failure returns {} and parseCrawlRequest falls back
// to the platform defaults with the env fallback applied — which is the one
// situation those env vars still exist for.
async function resolveLimits(workspaceId, onError) {
  if (!workspaceId) return {};
  try {
    const { limits, sources } = await adminLimits.effectiveLimits({ workspaceId });
    return { limits, sources };
  } catch (error) {
    onError?.(error);
    return {};
  }
}

// Plain-language names for `budgetClamped.source`, so a log line and a UI can
// say the same thing about the same run. "reduced by the operator ceiling" was
// the old wording for every case, including the ones that were nothing of the
// kind.
const BUDGET_SOURCE_LABELS = {
  platform:     'the platform admin limit',
  workspace:    "this workspace's admin limit",
  tier:         "this project's tier limit",
  hard_max:     'the platform hard maximum',
  env_fallback: 'the server fallback limit (the limits table was unreachable)',
  run_override: 'a per-run tightening',
  default:      'the built-in default limit',
};

function describeBudgetSource(source) {
  return BUDGET_SOURCE_LABELS[source] || 'the limit in force';
}

// What gets written to crawl_runs.budget: the page budget the run actually
// executed with, and which surface decided it. Separate from the manager so the
// shape is pinned by a test rather than by reading a crawl's side effects.
//
// `requested` equals `granted` when nothing was cut — the field says what the
// run asked for, not "how much we refused", so a reader does not have to know
// whether null means "not clamped" or "not recorded".
function budgetRecord(options, budgetClamped, sources = {}) {
  return {
    granted: options.maxUrls,
    requested: budgetClamped ? budgetClamped.requested : options.maxUrls,
    source: budgetClamped ? budgetClamped.source : (sources.maxUrlsPerCrawl || 'default'),
    clamped: Boolean(budgetClamped),
  };
}

module.exports = {
  parseCrawlRequest,
  ceilings,
  resolveLimits,
  ValidationError,
  BUDGET_SOURCE_LABELS,
  describeBudgetSource,
  budgetRecord,
};
