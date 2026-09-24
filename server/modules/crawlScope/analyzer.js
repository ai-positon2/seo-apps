const crypto = require("node:crypto");
const catalog = require("./issue-catalog.json");
const integrationCatalog = require("./integration-catalog.json");
const {
  isRedirectStatus,
  redirectLocationIssueDetail,
} = require("./http-redirect");
const {
  isNofollow,
  isNoindex,
  resultRobotsDirectives,
} = require("./robots-directives");
const { createUrlIdentity } = require("./url-identity");
const { ruleOrder } = require("./rule-order");

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
// External responses that refuse the crawler rather than report a missing page:
// login walls (401), bot protection (403, LinkedIn's non-standard 999) and rate
// limiting (429). Reported as "refusing crawler access", never as broken.
const REFUSED_EXTERNAL_STATUS = {
  401: "Unauthorized",
  403: "Forbidden",
  429: "Too Many Requests",
  999: "Request denied",
};
const MIN_GENERIC_EXTERNAL_NOFOLLOW_LINKS = 5;
const MIN_GENERIC_EXTERNAL_NOFOLLOW_RATIO = 0.8;
const MAX_FETCH_REDIRECTS = 20;
const MAX_REDIRECT_TRACE_HOPS = 100;
// ISO 639-1 language, optionally "-" + an ISO 15924 script ("zh-hant"), then
// optionally "-" + ISO 3166-1 region, or the special "x-default" value. Values
// are lowercased before this check runs. Script subtags are valid hreflang
// values and were being reported as invalid codes.
const HREFLANG_CODE = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-[a-z]{2})?)$/;
// Wording of a "not found" page, for soft-404 detection — phrased the way error
// pages are, not merely containing "404" ("Area code 404", "How to fix 404
// errors" are real pages). Only trusted on a thin page, too.
const NOT_FOUND_WORDING = [
  /^\s*(?:error\s*)?404\b/i,
  /\b404\b.*\bnot\s+found\b|\bnot\s+found\b.*\b404\b/i,
  /^\s*not\s+found\b/i,
  /\bpage\s+(?:not\s+found|(?:does\s+not|doesn['’]t|could\s+not\s+be)\s+(?:exist|found))\b/i,
  /\b(?:page|content|article|product)\s+(?:is\s+)?no\s+longer\s+(?:available|exists)\b/i,
];
const readsLikeNotFound = (text) => NOT_FOUND_WORDING.some((pattern) => pattern.test(String(text || "")));
const SOFT_404_MAX_WORDS = 300;
// Page and URL hygiene thresholds, at the values Semrush's Site Audit uses
// (title length: the common 30-character floor).
const TITLE_MIN_LENGTH = 30;
const HTML_TOO_LARGE_BYTES = 2 * 1024 * 1024;
// Below about one packet, compression saves nothing worth a finding.
const HTML_COMPRESSION_MIN_BYTES = 1_400;
const TOO_MANY_LINKS = 3_000;
const URL_MAX_LENGTH = 200;
const URL_MAX_PARAMETERS = 2;

// ── Responses that refused the crawler ───────────────────────────────────────
// Bot protection, rate limiting and login walls answer a crawler instead of the
// page it asked for. Such a response says nothing about the page, so it is not
// audited: it cannot be a broken-link target, a duplicate, an orphan or a slow
// page, and it is left out of Site Health. How the site treated the crawler is
// reported once, as crawl-blocked.
//
// 429 always means "slow down", on any page. 401, 403 and 503 are also what a
// members area, a private page or a maintenance window legitimately return, so
// they are only read as refusals when they are how the site answered the crawl
// as a whole (REFUSED_SHARE of its pages, or its start page). A bot check served
// as a normal page is recognised by its wording.
const RATE_LIMIT_STATUS = 429;
const REFUSAL_STATUS = new Set([401, 403, 429, 503]);
const REFUSED_SHARE = 0.5;
const CHALLENGE_WORDING = [
  /^\s*just a moment\b/i,
  /^\s*attention required\b/i,
  /^\s*one more step\b/i,
  /\bchecking (?:your browser|if the site connection is secure)\b/i,
  /\b(?:verify(?:ing)?|confirm) (?:that )?(?:you are|you['’]re) (?:a )?human\b/i,
  /^\s*(?:human verification|security check(?:point)?|bot (?:check|verification))\s*$/i,
  /^\s*are you a (?:robot|human)\b/i,
  /^\s*access (?:to this page has been )?denied\b/i,
  /^\s*pardon our interruption\b/i,
  /^\s*request unsuccessful\b.*\bincapsula\b/i,
  /^\s*ddos protection by\b/i,
];
const CHALLENGE_MAX_WORDS = 150;
const readsLikeChallenge = (result) =>
  (Number(result?.words) || 0) < CHALLENGE_MAX_WORDS &&
  [result?.title, result?.h1].some((text) =>
    CHALLENGE_WORDING.some((pattern) => pattern.test(String(text || ""))),
  );

/**
 * Which internal responses refused the crawler, and whether the site refused
 * the crawl as a whole.
 *
 * @param {object[]} internalResults
 * @param {string} startUrl
 * @returns {{ refused: Map<string, string>, blocked: boolean, startRefused: boolean,
 *   pageResponses: number, refusedPages: number, refusedFiles: number,
 *   statusCounts: Map<string, number> }}
 *   `refused` maps each refused URL to a label ("HTTP 403 Forbidden", "bot check").
 */
function crawlRefusals(internalResults, startUrl) {
  const byUrl = new Map(internalResults.map((result) => [result.url, result]));
  const identity = createUrlIdentity(startUrl);
  const byIdentity = new Map();
  for (const result of internalResults) {
    const key = identity(result.url);
    if (key && !byIdentity.has(key)) byIdentity.set(key, result);
  }
  const find = (url) => (url ? byUrl.get(url) || byIdentity.get(identity(url)) : undefined);
  // A page, answered: not a redirect hop, a file, or a URL that was never
  // fetched (robots.txt, network failure).
  const pages = internalResults.filter(
    (result) => !result.isAsset && result.status >= 200 && !isRedirectStatus(result.status),
  );
  const label = (result) =>
    REFUSAL_STATUS.has(result.status)
      ? `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ""}`
      : result.status < 300 && result.contentType?.includes("text/html") && readsLikeChallenge(result)
        ? "bot check"
        : "";
  const candidates = pages.filter((result) => label(result));

  // The start page, after any redirect the site sends it through.
  let start = find(startUrl);
  for (let hops = 0; start && isRedirectStatus(start.status) && start.redirectUrl && hops < MAX_FETCH_REDIRECTS; hops += 1) {
    start = find(start.redirectUrl);
  }
  const startRefused = Boolean(start && !start.isAsset && label(start));
  const blocked =
    startRefused ||
    (candidates.length >= 2 && candidates.length >= pages.length * REFUSED_SHARE);

  const refused = new Map();
  for (const result of internalResults) {
    const reason = label(result);
    if (!reason) continue;
    // Files are only read as refused when the site refused the crawl: an
    // image answering 403 on an otherwise open site is a broken image.
    if (blocked || result.status === RATE_LIMIT_STATUS || reason === "bot check") {
      refused.set(result.url, reason);
    }
  }
  const statusCounts = new Map();
  let refusedPages = 0;
  for (const [url, reason] of refused) {
    if (!byUrl.get(url)?.isAsset) refusedPages += 1;
    statusCounts.set(reason, (statusCounts.get(reason) || 0) + 1);
  }
  return {
    refused,
    blocked,
    startRefused,
    pageResponses: pages.length,
    refusedPages,
    refusedFiles: refused.size - refusedPages,
    statusCounts,
  };
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

// A title over 60 characters gets one real rewrite attempt: trim to the
// segment before a "Page Name | Brand" / "Page Name - Brand" separator, but
// only when that segment is itself a plausible title (30-60 chars) — a short
// segment (e.g. just the brand) silently drops the page's value proposition,
// and there's no way to invent the rest of a title. When there's no usable
// separator, word-truncating the current title with an ellipsis isn't a
// rewrite at all, just the same title cut short — so this returns a plain
// note instead of dressing up a truncation as a recommendation.
function suggestTitle(title) {
  const trimmed = String(title || "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= 60) return trimmed;
  const primary = primaryTitleSegment(trimmed);
  if (primary.length >= 30 && primary.length <= 60) return primary;
  return `Needs a manual rewrite — current title is ${trimmed.length} characters (target 50-60). Keep the primary topic and brand; don't just shorten this one.`;
}

// Only fall back to the title when it actually has a "Page Name | Brand"-style
// separator to trim to. A title with no separator is usually one long
// sentence or a sitewide tagline, not a page-specific label — using it
// verbatim as an H1 recommendation just reproduces whatever the title says,
// including a tagline that has nothing to do with this one page. The URL
// slug is a safer generic fallback for that case.
function suggestH1(result) {
  const title = String(result.title || "").trim();
  const fromTitle = /[|–—-]/.test(title) ? primaryTitleSegment(title) : "";
  if (fromTitle) return fromTitle;
  const fromSlug = humanizeUrlSlug(result.url);
  return fromSlug || "Add a descriptive H1 naming this page's topic.";
}

// There is no editorial content model to draw real copy from, so a "too
// short"/"missing" description gets a mechanical starter draft built from the
// title/URL — meant to be edited, not published as-is. It still saves a
// reviewer from starting on a blank page for hundreds of rows. The missing
// case deliberately does NOT pad every row out to 150-160 characters with a
// fixed trailing sentence: that boilerplate is identical on every page it
// fires on, and a report flagging duplicate content should not manufacture
// its own near-duplicate descriptions to fill a length target.
function suggestMetaDescription(result) {
  const topic = primaryTitleSegment(result.title) || humanizeUrlSlug(result.url) || "This page";
  const existing = String(result.metaDescription || "").trim();
  if (existing) {
    if (existing.length >= 150 && existing.length <= 160) return existing;
    if (existing.length < 150) {
      // Real, existing page copy — safe to extend rather than replace, but
      // only if the extension actually lands in range. Truncating the
      // extension itself would be the exact same truncation-as-rewrite
      // problem this function exists to avoid, just one step removed.
      const extended = `${existing} Learn more about ${topic} on this page.`;
      if (extended.length <= 160) return extended;
      return `Needs a manual rewrite — current description is ${existing.length} characters (target 150-160). Current text: "${existing}"`;
    }
    return `Needs a manual rewrite — current description is ${existing.length} characters (target 150-160). Current text: "${existing}"`;
  }
  return `Needs original copy (150-160 characters) about ${topic}. Write it specific to this page — a generic "find key details on this page" filler repeated across rows reads as duplicate content.`;
}

function sitemapIncorrectUrlRecommendation({
  result,
  terminalFailure,
  terminalSuitability,
  declarativeRedirect,
  canonicalMismatch,
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
  if (canonicalMismatch) {
    return `Replace this sitemap entry with its canonical URL: ${result.canonical}. Only list the canonical version in the sitemap.`;
  }
  return `Remove this non-indexable URL from the sitemap (${result.indexabilityReason || "not the preferred canonical version"}), or resolve the underlying indexability issue first.`;
}

// ── Page categorization ──────────────────────────────────────────────────
// A heuristic label (Home, Product, Blog/Article, ...), not a ranking factor
// and not a finding — just enough structure to group pages meaningfully in
// the UI/report instead of one flat list. No LLM call: this runs on every
// page of every crawl, so it has to be free and instant, and pattern +
// schema signals get the common cases right without one.
//
// Checked in order, first match wins:
//   1. Depth 0 / root path is unambiguous — always Home.
//   2. Schema.org @type is the strongest content signal available (the page
//      told us what it is), checked before any URL guessing.
//   3. URL path patterns — ordered specific-to-generic so e.g. a blog post
//      about product reviews at /blog/product-review-x doesn't get claimed
//      by a broader pattern checked first.
//   4. Title/H1 text, only as a last resort — the weakest signal, since a
//      page can mention "review" without being one.
const CATEGORY_SCHEMA_TYPES = [
  { types: ["Product"], category: "Product" },
  { types: ["FAQPage"], category: "FAQ" },
  { types: ["Article", "BlogPosting", "NewsArticle"], category: "Blog / Article" },
  { types: ["JobPosting"], category: "Careers" },
  { types: ["Course"], category: "Training" },
  { types: ["Review", "AggregateRating"], category: "Review" },
  { types: ["Event"], category: "Event" },
  { types: ["ItemList", "CollectionPage"], category: "Category / Listing" },
];

// [pattern, category] — pattern tested against the URL's pathname, lowercased.
const CATEGORY_URL_PATTERNS = [
  [/\/(products?|shop|store|catalog\/[^/]+)(\/|$)/, "Product"],
  [/\/(blog|articles?|news|post)(\/|$)/, "Blog / Article"],
  [/\breview[s]?(\/|$|-)/, "Review"],
  [/\/(training|courses?|certifications?|academy)(\/|$)/, "Training"],
  [/\/(guides?|resources?|how-to|tutorials?|learn)(\/|$)/, "Guide / Resource"],
  [/\/faqs?(\/|$)/, "FAQ"],
  [/\/(case-stud(y|ies)|testimonials?)(\/|$)/, "Case Study"],
  [/\/(webinars?)(\/|$)/, "Webinar"],
  [/\/(events?)(\/|$)/, "Event"],
  [/\/(pricing|plans?)(\/|$)/, "Pricing"],
  [/\/(careers?|jobs?)(\/|$)/, "Careers"],
  [/\/(about([-_]?us)?|company|our-team|team)(\/|$)/, "About"],
  [/\/contact([-_]?us)?(\/|$)/, "Contact"],
  [/\/(login|sign-?in|account|portal|dashboard|my-account)(\/|$)/, "Account / Portal"],
  [/\/(privacy|terms|legal|cookies?)(\/|$)/, "Legal"],
  [/\/(category|categories|collections?)(\/|$)/, "Category / Listing"],
];

const CATEGORY_TEXT_PATTERNS = [
  [/\breview(s|ed)?\b/i, "Review"],
  [/\bfaq\b/i, "FAQ"],
  [/\bpricing\b/i, "Pricing"],
  [/\bcareers?\b|\bjobs?\b/i, "Careers"],
];

function categorizePage(result) {
  if (!result.url) return "";
  if (result.depth === 0) return "Home";

  let pathname = "";
  try {
    pathname = new URL(result.url).pathname.toLowerCase();
  } catch {
    pathname = "";
  }
  if (pathname === "/" || pathname === "") return "Home";

  const schemaTypes = new Set((result.schemaTypes || []).map(String));
  for (const rule of CATEGORY_SCHEMA_TYPES) {
    if (rule.types.some((t) => schemaTypes.has(t))) return rule.category;
  }

  for (const [pattern, category] of CATEGORY_URL_PATTERNS) {
    if (pattern.test(pathname)) return category;
  }

  const text = `${result.title || ""} ${result.h1 || ""}`;
  for (const [pattern, category] of CATEGORY_TEXT_PATTERNS) {
    if (pattern.test(text)) return category;
  }

  return "Other";
}

function findingId(ruleId, url = "", targetUrl = "", detail = "") {
  return crypto
    .createHash("sha1")
    .update(`${ruleId}|${url}|${targetUrl}|${detail}`)
    .digest("hex")
    .slice(0, 16);
}

// The same issue across crawls. A finding's id includes its detail, which
// carries counts and lengths ("Shared by 4 pages", "72 characters"), so it
// changes whenever a number in it moves; the issue key is only the rule, the
// page and what it points at, so a review can follow it to the next crawl and
// new / fixed / persisting can be counted against the last one.
function issueKeyOf(ruleId, url = "", targetUrl = "") {
  return crypto
    .createHash("sha1")
    .update(`${ruleId}|${url}|${targetUrl || ""}`)
    .digest("hex")
    .slice(0, 16);
}

// A page×check matrix can represent "this page has this problem," but it
// cannot represent "one shared nav/footer link is broken, and every page
// happens to carry it" without either double-counting (once per page) or —
// what this fixes — presenting one root cause as N separate findings. A
// broken link to a robots-disallowed /search box in a shared header was
// reported as 149 individual "broken" findings on brushandfloss.com; it is
// one broken link.
//
// Signature = ruleId + whatever actually distinguishes the evidence
// (targetUrl for a link-shaped finding, detectedValue otherwise — e.g. the
// same missing OG property recurring with no target at all). Findings
// sharing BOTH, on enough distinct pages, are re-tagged scope='template' in
// place — not merged into one row — so the existing scope-aware machinery
// (siteScopedGroups client-side, the site-band section in report-writer.js,
// the reconciliation strip's occurrence math) already excludes them from
// page-level tier counts and the occurrence total exactly the way a
// scope='site' finding already does, with zero new code on that side.
//
// Deliberately conservative: needs BOTH an absolute floor (5) AND a majority
// of the crawl's own HTML pages, so a handful of coincidentally-identical
// findings on a small crawl isn't mislabeled "template" on thin evidence —
// a real shared-template defect shows up almost everywhere, not on a
// scattered few.
function collapseTemplateFindings(findings, htmlPageCount) {
  const threshold = Math.max(5, Math.ceil(htmlPageCount * 0.5));
  if (!Number.isFinite(threshold) || threshold < 1) return;

  const groups = new Map(); // "ruleId|signature" -> finding[]
  for (const finding of findings) {
    if (finding.scope !== "page") continue; // only page-scope findings can collapse
    // A thousand refusals are the crawl being blocked (crawl-blocked), not a
    // defect in a template the pages share.
    if (finding.crawlRefused) continue;
    const signature = finding.targetUrl || finding.detectedValue || "";
    const key = `${finding.ruleId}|${signature}`;
    const list = groups.get(key) || [];
    list.push(finding);
    groups.set(key, list);
  }

  for (const group of groups.values()) {
    const distinctPages = new Set(group.map((finding) => finding.url)).size;
    if (distinctPages < threshold) continue;
    for (const finding of group) finding.scope = "template";
  }
}

// ── Root-cause rollup ────────────────────────────────────────────────────
// collapseTemplateFindings (above) answers one question — "does this rule's
// findings belong in the page-level TOTAL, or the site-band section?" — a
// threshold-gated, whole-rule-or-nothing retag the existing TOTAL/reconcili-
// ation-strip math depends on. This answers a different one — "how many
// DISTINCT root causes does this rule's findings actually represent?" —
// and is never threshold-gated: a rule can produce one group covering every
// row (119 links to the same redirected URL) or dozens of one-row groups
// (44 broken external links to 43 different domains, correctly NOT
// collapsed). It runs after collapseTemplateFindings so scope is already
// final on every finding; a group's own scope is just whatever its members
// already carry; they always agree, since group membership is keyed on
// ruleId + evidence signature and collapseTemplateFindings retags scope per
// (ruleId, signature) too.
function normalizeLinkLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// Per check-family evidence key, per issue-catalog.json's `evidenceFamily`
// field. A rule with no `evidenceFamily` set (the overwhelming majority —
// this is opt-in, added rule by rule as each is verified against real
// export data) falls through to the default: targetUrl, then detectedValue,
// then the finding's own url — always something instance-specific, never a
// shared blank, so an unclassified rule can never accidentally collapse
// unrelated findings into one group.
function evidenceSignature(finding, definition) {
  switch (definition?.evidenceFamily) {
    case "link-target":
    case "resource-target":
      return finding.targetUrl || finding.url;
    // The finding fires on the page itself (e.g. a permanent redirect is a
    // property of the URL that redirects, not a link pointing at it) — the
    // page's own URL is the evidence, and doubles as the join key Part 2's
    // redirect-target-overlap rule uses against link-target findings.
    case "self-url":
      return finding.url;
    case "schema-message":
      return finding.detail || finding.detectedValue || finding.url;
    case "missing-property":
      return finding.evidenceKey || finding.detectedValue || finding.url;
    // "Read More" linking to 50 different articles must not collapse into
    // one group (the destinations are unrelated); "Read More" and "read
    // more" and "LEARN MORE" pointing at the SAME destination must. The key
    // is label-normalized-then-target, not either alone.
    case "link-label":
      return `${normalizeLinkLabel(finding.detectedValue)}|${finding.targetUrl || finding.url}`;
    // No rule produces a templateId/selector yet — falls through to the
    // same per-instance-unique default an unclassified rule gets, so
    // declaring this family ahead of a real producer is a documented no-op,
    // not a silent miscollapse.
    case "template-local":
      return finding.targetUrl || finding.detectedValue || finding.url;
    // Server/config checks: every finding under this ruleId is one group —
    // there is exactly one server to fix, however many pages it's slow on.
    case "config":
      return "";
    default:
      return finding.targetUrl || finding.detectedValue || finding.url;
  }
}

// A group's fix type falls out of what grouping already proved, rather
// than guessing from a shared-value ratio the way report-writer.js's
// per-detail-sheet assessFixType still does for the (coarser, ruleId-only)
// Excel tabs: every member of a root-cause group already shares an
// identical evidence signature by construction, so a group spanning more
// than one page IS a confirmed shared cause, not an inferred one.
function groupFixType(members, definition) {
  if (members[0]?.scope === "template") return "Template";
  if (definition?.scope === "site") return "Site";
  if (definition?.evidenceFamily === "config") return "Config";
  const affectedPages = new Set(members.map((finding) => finding.url)).size;
  if (members.length > 1 && affectedPages > 1) return "Template";
  return "Page";
}

function buildRootCauseGroups(findings) {
  const groups = new Map(); // groupId -> finding[]
  for (const finding of findings) {
    const definition = catalogById.get(finding.ruleId);
    const signature = evidenceSignature(finding, definition);
    const groupId = crypto
      .createHash("sha1")
      .update(`${finding.ruleId}|${signature}`)
      .digest("hex")
      .slice(0, 16);
    finding.rootCauseGroupId = groupId;
    const list = groups.get(groupId) || [];
    list.push(finding);
    groups.set(groupId, list);
  }

  const result = [];
  for (const [groupId, members] of groups) {
    for (const finding of members) finding.groupMemberCount = members.length;
    const sample = members[0];
    const definition = catalogById.get(sample.ruleId);
    result.push({
      groupId,
      ruleId: sample.ruleId,
      title: definition?.title || sample.title,
      category: definition?.category || sample.category,
      priority: definition?.priority || sample.priority,
      // Falls back the same way add() itself does — real findings always
      // carry an explicit scope, but a hand-built fixture (tests, or any
      // future caller that skips add()) might not.
      scope: sample.scope || definition?.scope || "page",
      recommendation: sample.recommendation,
      memberCount: members.length,
      affectedPageCount: new Set(members.map((finding) => finding.url)).size,
      uniqueTargetCount: new Set(members.map((finding) => finding.targetUrl || finding.url)).size,
      fixType: groupFixType(members, definition),
      sampleFinding: sample,
    });
  }
  // Biggest lever first — a group resolving hundreds of occurrences with
  // one fix belongs above one resolving a handful, independent of severity
  // (Part 3 adds a real severity sort on top of this once it ships).
  result.sort((a, b) => b.memberCount - a.memberCount);
  return result;
}

// Which broken-resource rule a resource belongs to, from how the page loads it.
// The response cannot say: a missing /site.css is usually served as a text/html
// 404 page.
const IMAGE_FILE = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;
const SCRIPT_OR_STYLE_FILE = /\.(?:m?js|css)(?:$|[?#])/i;
const BROKEN_RESOURCE_RULE = {
  image: "broken-internal-image",
  "script-style": "broken-javascript",
  other: "broken-internal-resource",
};

function resourceKind(edge) {
  const tag = String(edge.tag || "").toLowerCase();
  const attribute = String(edge.sourceAttribute || "").toLowerCase();
  const rel = String(edge.rel || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (tag === "script") return "script-style";
  if (tag === "link" && rel.some((token) => token === "stylesheet" || token === "modulepreload")) {
    return "script-style";
  }
  if (tag === "css" && attribute.endsWith("@import")) return "script-style";
  if (tag === "img" || tag === "input" || (tag === "video" && attribute === "poster")) return "image";
  if (tag === "link" && rel.some((token) => /icon$/.test(token))) return "image";
  if (IMAGE_FILE.test(edge.targetUrl || "")) return "image";
  if (SCRIPT_OR_STYLE_FILE.test(edge.targetUrl || "")) return "script-style";
  return "other";
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

// Which link on the page a link finding is about, as someone looking at the page
// or its editor would recognise it.
function linkTextEvidence(edge) {
  const text = String(edge?.anchorText || "").replace(/\s+/g, " ").trim();
  if (!text) return "(no visible link text)";
  return `Link text: “${text.length > 120 ? `${text.slice(0, 119)}…` : text}”`;
}

// Why a crawled hreflang target cannot stand in the set, or "" when it can.
function hreflangTargetProblem(target, index) {
  if (target.statusText === "Blocked by robots.txt") return "";
  if (!target.status) return `could not be fetched (${target.statusText || "no response"})`;
  if (target.status >= 400) return `returns HTTP ${target.status}${target.statusText ? ` ${target.statusText}` : ""}`;
  if (isRedirectStatus(target.status)) {
    return `redirects (HTTP ${target.status}${target.redirectUrl ? ` to ${target.redirectUrl}` : ""}) instead of being the page itself`;
  }
  const refresh = redirectDestination(target);
  if (refresh) return `sends visitors on to ${refresh} with a refresh instead of being the page itself`;
  if (isNoindex(resultRobotsDirectives(target))) return "is noindex, so it will not be shown in any language";
  if (target.canonical && !index.same(target.canonical, target.url)) {
    return `declares ${target.canonical} as its canonical, so it is not the version that gets indexed`;
  }
  return "";
}

function redirectDestination(result) {
  return redirectEdge(result)?.url || "";
}

function redirectTrace(result, index) {
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
    const target = index.get(next);
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

function redirectTerminalFailure(trace, index) {
  if (
    !trace ||
    trace.loop ||
    trace.limitReached ||
    trace.traceTruncated
  ) {
    return null;
  }

  const terminal = index.get(trace.targetUrl);
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

function redirectTerminalSuitability(trace, index) {
  if (
    !trace ||
    trace.loop ||
    trace.limitReached ||
    trace.traceTruncated
  ) {
    return null;
  }

  const terminal = index.get(trace.targetUrl);
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

  const isNonIndexable =
    terminal.indexability === "Non-indexable" ||
    isNoindex(resultRobotsDirectives(terminal));
  const canonicalMismatch =
    Boolean(terminal.canonical) && !index.same(terminal.canonical, terminal.url);
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

// Crawl results, addressable by any spelling of their URL the crawler would
// have fetched them under (url-identity.js). Evidence keeps URLs as written —
// an http:// href, a Location with a tracking parameter, a sitemap <loc> — and
// looking those up by exact string missed the page the crawler actually
// fetched for them.
function createResultIndex(results, startUrl) {
  const identity = createUrlIdentity(startUrl);
  const exact = new Map(results.map((result) => [result.url, result]));
  const byIdentity = new Map();
  for (const result of results) {
    const key = identity(result.url);
    if (key && !byIdentity.has(key)) byIdentity.set(key, result);
  }
  return {
    identity,
    // The result stored under exactly this URL, and nothing else — for
    // evidence about the URL as written (did the http:// URL itself redirect?).
    exact: (url) => exact.get(url),
    get: (url) => (url ? exact.get(url) || byIdentity.get(identity(url)) : undefined),
    same: (a, b) => {
      if (!a || !b) return false;
      if (a === b) return true;
      const key = identity(a);
      return Boolean(key) && key === identity(b);
    },
  };
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

function httpLinkEvidence(edge, target, fetchedAs = null) {
  // The crawler never requests an http:// URL on the crawled host: it fetches
  // the https equivalent instead (crawler.js#_canonicalScheme). So "not
  // fetched" was never true for those — what is true is that the link is
  // written as HTTP and the page lives at the HTTPS address.
  if (!target && fetchedAs) {
    const status = Number(fetchedAs.status) || 0;
    return {
      statusCode: status,
      detail: `The link is written as HTTP; the crawl fetched the HTTPS version instead (${fetchedAs.url} returned ${status ? `HTTP ${status}` : "no response"}). Link to the HTTPS URL directly.`,
      detectedValue: `${edge.download ? "download; " : ""}written as HTTP; HTTPS version returned ${status || "no response"}`,
    };
  }
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

function isPreferredIndexablePage(result, index) {
  return (
    result.status === 200 &&
    result.indexability === "Indexable" &&
    (!result.canonical || index.same(result.canonical, result.url))
  );
}

function isReciprocalHreflangGroup(group, index) {
  const groupUrls = new Set(group.map((result) => index.identity(result.url)));
  return group.every((result) => {
    const alternateUrls = new Set(
      (result.hreflangs || []).map((entry) => index.identity(entry.url)),
    );
    return [...groupUrls].every((url) => alternateUrls.has(url));
  });
}

// ── Media library ────────────────────────────────────────────────────────
// Every image/video/audio/PDF the crawl found actually referenced on a page,
// with its measured size (the crawler already fetched it — this is a real
// Content-Length, not an estimate) and which pages use it. Deliberately NOT
// "the site's full media library": a crawler only ever knows about files it
// found linked from somewhere, so a file sitting unreferenced in an uploads
// folder doesn't exist as far as this can tell. That's a real limitation,
// not an oversight — a true "what's unused" answer needs an independent
// inventory (a media sitemap, a CMS's media API) this doesn't have.
const MEDIA_CONTENT_TYPE_MAP = [
  [/^image\//, "Image"],
  [/^video\//, "Video"],
  [/^audio\//, "Audio"],
  [/^application\/pdf/, "Document"],
  // A downloadable file linked from the site — a calendar invite, an office
  // doc, an archive — is exactly as much "media library" material as a PDF:
  // something a visitor downloads, not a page they browse. Previously only
  // PDFs were recognized; everything else with a real, linked file quietly
  // vanished from the library even when it was fetched successfully.
  [/^text\/calendar/, "Document"],
  [/^application\/(msword|vnd\.openxmlformats-officedocument|vnd\.ms-excel|vnd\.ms-powerpoint)/, "Document"],
  [/^application\/(zip|x-zip-compressed)/, "Document"],
];
const MEDIA_EXTENSION_MAP = [
  [/\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(\?|$)/i, "Image"],
  [/\.(mp4|webm|ogv?)(\?|$)/i, "Video"],
  [/\.(mp3|wav)(\?|$)/i, "Audio"],
  [/\.pdf(\?|$)/i, "Document"],
  [/\.ics(\?|$)/i, "Document"],
  [/\.(docx?|xlsx?|pptx?|zip)(\?|$)/i, "Document"],
];

// Content-type is checked first (authoritative when the server sends one);
// the URL extension is only a fallback for a response with no/garbage
// Content-Type. Returns null for anything that isn't media in the ordinary
// sense — css/js/fonts/json are assets too, but nobody calls a stylesheet
// part of "the media library".
function mediaTypeFor(result) {
  const contentType = (result.contentType || "").toLowerCase();
  for (const [pattern, type] of MEDIA_CONTENT_TYPE_MAP) {
    if (pattern.test(contentType)) return type;
  }
  for (const [pattern, type] of MEDIA_EXTENSION_MAP) {
    if (pattern.test(result.url)) return type;
  }
  return null;
}

function buildMediaLibrary(results, resourceEdges) {
  const usedBy = new Map(); // asset url -> Set(page url)
  for (const edge of resourceEdges) {
    if (!edge.targetUrl) continue;
    const set = usedBy.get(edge.targetUrl) || new Set();
    if (edge.sourceUrl) set.add(edge.sourceUrl);
    usedBy.set(edge.targetUrl, set);
  }

  const items = [];
  for (const result of results) {
    // External used to be excluded outright, on the theory that only your
    // own site's files belong in "your media library." But a page routinely
    // links to a genuine document it doesn't host itself — a compliance PDF
    // on a sibling subdomain, a spec sheet on a partner's CDN — and that was
    // silently vanishing instead of showing up labeled. It's kept and
    // labeled (`isExternal`) rather than hidden, so the reader judges
    // relevance instead of the tool guessing it away.
    if (!result.isAsset || result.status !== 200) continue;
    const type = mediaTypeFor(result);
    if (!type) continue;
    const sources = usedBy.get(result.url) || new Set();
    items.push({
      url: result.url,
      type,
      contentType: result.contentType || "",
      size: result.size || 0,
      isExternal: result.scope === "External",
      usedByCount: sources.size,
      // Capped, not the full list: a widely-reused hero image or icon can be
      // referenced from every page on the site, and this is a summary for
      // the UI, not the edge list itself (that's linkEdges/resourceEdges).
      usedBy: [...sources].slice(0, 20),
    });
  }
  items.sort((a, b) => b.size - a.size);

  const byType = {};
  let totalBytes = 0;
  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    totalBytes += item.size;
  }

  return { items, byType, totalBytes, count: items.length };
}

const integrationCatalogById = new Map(
  integrationCatalog.map((vendor) => [vendor.id, vendor]),
);

// Site-wide rollup of crawler.js's detectIntegrations() output — one loop
// over every (internal, HTML) page's already-deduped `result.integrations`,
// mirroring buildMediaLibrary's shape: a capped, pre-aggregated list the UI
// reads as-is, not raw per-page detections. `totalPages` is the % denominator
// the adoption chart divides pageCount by.
function buildIntegrations(results) {
  const totals = new Map(); // vendor id -> aggregate row
  for (const result of results) {
    for (const integration of result.integrations || []) {
      const vendor = integrationCatalogById.get(integration.id);
      // A stale id from a crawl run before a catalog entry was renamed or
      // removed — skip rather than surface a row with no name/category.
      if (!vendor) continue;
      const entry = totals.get(vendor.id) || {
        id: vendor.id,
        name: vendor.name,
        category: vendor.category,
        status: vendor.status,
        pageCount: 0,
        headCount: 0,
        bodyCount: 0,
        loadingCounts: { async: 0, defer: 0, sync: 0 },
      };
      entry.pageCount += 1;
      if (integration.location === "head") entry.headCount += 1;
      else entry.bodyCount += 1;
      if (entry.loadingCounts[integration.loading] !== undefined) {
        entry.loadingCounts[integration.loading] += 1;
      }
      totals.set(vendor.id, entry);
    }
  }
  return {
    totalPages: results.length,
    items: [...totals.values()].sort((a, b) => b.pageCount - a.pageCount),
  };
}

// ── Coverage ─────────────────────────────────────────────────────────────────
// A check that did not run produces no findings, and no findings read as
// "passed": a crawl stopped at its page limit showed orphan pages as clean, and
// one with sitemaps turned off showed every sitemap check clean. These are the
// checks a crawl's own settings or shape keep from running, each with the
// reason in words.
const SITEMAP_RULES = [
  "sitemap-missing-indexable",
  "sitemap-incorrect-url",
  "sitemap-redirect",
  "sitemap-duplicate",
  "sitemap-http-url",
  "sitemap-unreadable",
  "sitemap-robots-config",
  "sitemap-too-large",
  "sitemap-off-host",
  // An orphan is a page the sitemap lists and no link reaches.
  "orphan-page",
];
const EXTERNAL_FETCH_RULES = ["broken-external-link", "external-403"];
// Checks read from the pages' link and resource edges.
const LINK_DATA_RULES = [
  "broken-internal-links",
  "link-to-redirect",
  "internal-nofollow-link",
  "mixed-incoming-follow",
  "orphan-page",
  "single-inlink",
  "deep-page",
  "anchor-missing",
  "anchor-nondescriptive",
  "broken-external-link",
  "external-403",
  "external-nofollow",
  "broken-internal-image",
  "broken-internal-resource",
  "broken-javascript",
  "mixed-content",
  "image-alt-missing",
];

function crawlCoverage({
  firedRuleIds,
  crawlTruncated,
  sitemapsChecked,
  externalLinksChecked,
  robotsRespected,
  clickDepthFromStart,
  siteDiagnostics = {},
  startUrl = "",
  pagesMissingLinkData = 0,
  googlebotRobotsChecked = false,
  closedToCrawlScopeOnly = 0,
}) {
  const notEvaluated = new Map();
  // Pages the crawl reached but did not audit, and why (not per rule).
  const pagesNotAudited = [];
  if (closedToCrawlScopeOnly > 0) {
    pagesNotAudited.push({
      count: closedToCrawlScopeOnly,
      reason:
        `robots.txt closes ${closedToCrawlScopeOnly.toLocaleString("en-US")} URL${closedToCrawlScopeOnly === 1 ? "" : "s"} ` +
        "to CrawlScope but not to Googlebot, so Google can crawl them and this audit did not. " +
        "Allow CrawlScope in robots.txt to audit them.",
    });
  }
  const partial = new Map();
  const skip = (ruleIds, reason) => {
    for (const ruleId of ruleIds) if (!notEvaluated.has(ruleId)) notEvaluated.set(ruleId, reason);
  };

  if (!sitemapsChecked) {
    skip(SITEMAP_RULES, "Sitemaps were not read on this crawl: sitemap discovery was off, or this was a URL list.");
  } else {
    const cut = (siteDiagnostics.sitemapLimits || []).filter((limit) => limit.truncated).length;
    if (cut) {
      for (const ruleId of SITEMAP_RULES) {
        partial.set(
          ruleId,
          `${cut} sitemap ${cut === 1 ? "file was" : "files were"} larger than 50 MB and read only that far, so URLs listed past that point were not seen.`,
        );
      }
    }
  }
  if (crawlTruncated) {
    skip(
      ["orphan-page", "single-inlink"],
      "The crawl did not see the whole site (it was stopped, reached its page limit, or its link list was capped), " +
        "so the links pointing at a page could not all be counted.",
    );
  }
  if (!externalLinksChecked) {
    skip(EXTERNAL_FETCH_RULES, "External links were not checked on this crawl.");
  } else if (Number(siteDiagnostics.externalLinksUnchecked) > 0) {
    const unchecked = Number(siteDiagnostics.externalLinksUnchecked);
    for (const ruleId of EXTERNAL_FETCH_RULES) {
      partial.set(
        ruleId,
        `${unchecked.toLocaleString("en-US")} external URLs past the crawl's external-link limit were not requested, so links to them were not checked.`,
      );
    }
  }
  if (!robotsRespected && !googlebotRobotsChecked) {
    skip(
      ["robots-blocked", "blocked-resource"],
      "The crawl ignored robots.txt, so it fetched the URLs robots.txt disallows instead of reporting them.",
    );
  }
  if (!siteDiagnostics.robotsUrl) {
    skip(["robots-issue", "sitemap-robots-config"], "robots.txt was not read on this crawl.");
  }
  if (!clickDepthFromStart) {
    skip(
      ["deep-page", "javascript-rendered-site", "crawl-trap"],
      "A URL list has no start page to follow links from.",
    );
  }
  // llms.txt, the missing-page probe and the HTTP homepage are checked once,
  // after the start page answers, and never for a URL list.
  if (!siteDiagnostics.llmsStatus) {
    skip(
      ["llms-missing", "llms-format", "soft-404-site", "http-homepage", "www-resolve"],
      "Site-wide files were not checked on this crawl (a URL list, or the start page never answered).",
    );
  } else {
    if (siteDiagnostics.llmsStatus === "unavailable") {
      skip(["llms-missing", "llms-format"], "llms.txt could not be fetched, so whether it exists is unknown.");
    }
    if (!siteDiagnostics.missingPageProbe?.status) {
      skip(["soft-404-site"], "The request for a URL that cannot exist got no answer.");
    }
    if (!String(startUrl).startsWith("https:")) {
      skip(["http-homepage"], "The crawl started on http://, so the HTTP homepage was not tested for a redirect to HTTPS.");
    }
  }

  if (pagesMissingLinkData > 0) {
    const reason =
      `This crawl was interrupted and resumed, and ${pagesMissingLinkData.toLocaleString("en-US")} ` +
      `page${pagesMissingLinkData === 1 ? "" : "s"} fetched before the interruption were stored without their ` +
      "links and resources, so those pages' links, images and scripts were not checked.";
    for (const ruleId of LINK_DATA_RULES) if (!partial.has(ruleId)) partial.set(ruleId, reason);
  }

  const render = siteDiagnostics.renderCheck;
  if (!render?.ran) {
    skip(["javascript-dependent-content"], ({
      "no-browser": "No headless browser was available to render pages.",
      "failed": `Rendering pages failed${render?.error ? ` (${render.error})` : ""}.`,
      "nothing-to-render": "No page was fetched as HTML, so there was nothing to render.",
    })[render?.reason] || "JavaScript rendering was not checked on this crawl.");
  }

  // A check that produced a finding ran, whatever the conditions above say.
  for (const ruleId of firedRuleIds) notEvaluated.delete(ruleId);
  const inCatalogOrder = (map) =>
    catalog.filter((rule) => map.has(rule.id)).map((rule) => ({ ruleId: rule.id, reason: map.get(rule.id) }));
  return { notEvaluated: inCatalogOrder(notEvaluated), partial: inCatalogOrder(partial), pagesNotAudited };
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
  // False for a URL-list crawl: there is no start page whose links the list's
  // pages are "clicks" from, so no click depth and no deep-page.
  clickDepthFromStart = true,
  // Whether external links were requested at all, and whether robots.txt was
  // obeyed (a crawl that ignores it fetches disallowed pages instead of
  // reporting them). Both only decide what `coverage` says was evaluated.
  externalLinksChecked = true,
  robotsRespected = true,
  // Pages in `results` whose links and resources are not in the edge lists (a
  // resumed run reloading rows stored before edges were kept).
  pagesMissingLinkData = 0,
  // robots.txt was read as Googlebot too, so "blocked" can be reported for
  // Google even on a crawl that ignored robots.txt itself.
  googlebotRobotsChecked = false,
}) {
  const findings = [];
  // Dedupe ids in a Set rather than scanning `findings` on every add(). The scan
  // was O(n²): measured 3.6s at 50k findings versus 11ms here, all of it on the
  // worker's event loop at the end of every crawl.
  const findingIds = new Set();
  const allInternalResults = results.filter((result) => result.scope !== "External");
  // Responses that refused the crawler are not the site's pages, so every check
  // below runs without them: looked up as a link, canonical, hreflang or
  // redirect target, a refused URL is "not crawled" — can't verify, don't guess
  // — exactly like a URL the crawl never reached.
  const refusals = crawlRefusals(allInternalResults, startUrl);
  const { refused } = refusals;
  const index = createResultIndex(results.filter((result) => !refused.has(result.url)), startUrl);
  const internalResults = allInternalResults.filter((result) => !refused.has(result.url));
  const htmlResults = internalResults.filter((result) =>
    result.contentType?.includes("text/html"),
  );
  const redirectTraces = new Map(
    internalResults
      .map((result) => [result.url, redirectTrace(result, index)])
      .filter(([, trace]) => trace),
  );
  const redirectTerminalFailures = new Map(
    [...redirectTraces]
      .map(([url, trace]) => [
        url,
        redirectTerminalFailure(trace, index),
      ])
      .filter(([, failure]) => failure),
  );
  const redirectTerminalSuitabilityIssues = new Map(
    [...redirectTraces]
      .filter(([url]) => !redirectTerminalFailures.has(url))
      .map(([url, trace]) => [
        url,
        redirectTerminalSuitability(trace, index),
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
      issueKey: issueKeyOf(ruleId, url, targetUrl),
      ruleId,
      // The crawler stops reading at MAX_BODY_BYTES and records bodyTruncated
      // on the result. Without carrying it here, a count measured on the first
      // 5MB of a 14.4MB document is published as though it were complete —
      // iana.org's /domains/idn-tables reported 3,830 nameless anchors against
      // an actual 11,113. The cap is correct; the silence about it was not.
      ...(source && source.bodyTruncated ? { sourceTruncated: true } : {}),
      // The response refused the crawler: listed, not counted in Site Health,
      // and never grouped as a template-wide defect.
      ...(extra.crawlRefused ? { crawlRefused: true } : {}),
      title: definition.title,
      description: definition.description,
      recommendation: extra.recommendation || definition.recommendation,
      severity: definition.severity,
      priority: definition.priority,
      category: definition.category,
      // 'site' | 'template' | 'page' | 'resource' — a page×check matrix can't
      // represent a whole-site finding (sitemap/robots config, HSTS, llms.txt)
      // without either double-counting it per host or dropping it. Defaults
      // to 'page' for the ~86 catalog entries that genuinely are about one
      // page; only the handful of real exceptions carry an explicit value.
      scope: definition.scope || "page",
      detection: definition.detection,
      url,
      targetUrl,
      detail,
      statusCode: extra.statusCode ?? source.status ?? 0,
      detectedValue: extra.detectedValue ?? "",
      recommendedValue: extra.recommendedValue ?? "",
      // Raw evidence for root-cause grouping's "missing-property" family —
      // separate from detectedValue because that column is a display
      // string (bulleted, human-facing) that isn't safe to re-parse as a
      // grouping key. Empty for every other rule.
      evidenceKey: extra.evidenceKey ?? "",
      reviewStatus: "Needs review",
      reviewerNotes: "",
      automated: definition.detection === "Automatic",
    });
  };

  // Sitemap entries keyed by the URL the crawler fetched them under, so an
  // http:// <loc> on an https site is matched to the page it names — the
  // crawler crawled it from that entry — instead of reading "missing from every
  // sitemap". Entries written with the wrong scheme are kept for their own
  // finding.
  const sitemapsByPage = new Map();
  const httpSitemapEntries = new Map();
  for (const [loc, sitemaps] of Object.entries(sitemapMembership)) {
    const key = index.identity(loc);
    if (!key) continue;
    const merged = sitemapsByPage.get(key) || new Set();
    for (const sitemap of sitemaps || []) merged.add(sitemap);
    sitemapsByPage.set(key, merged);
    if (loc.startsWith("http:") && key.startsWith("https:")) {
      const entries = httpSitemapEntries.get(key) || [];
      entries.push({ loc, sitemaps: [...(sitemaps || [])] });
      httpSitemapEntries.set(key, entries);
    }
  }

  // ── Incoming internal links, per page ─────────────────────────────────────
  // DISTINCT linking pages, not <a> elements. The crawler's own count
  // (inlinkCounts) added one per element: a nav link and its footer twin were
  // two inlinks, a nofollow link counted, and a redirect hop counted as a link
  // from the redirecting URL — so "only one incoming internal link" missed the
  // pages it exists to find. A link to a redirect credits the redirect's
  // destination too, the page it actually delivers the visitor to.
  // `followInlinks` counts only links a search engine follows: not rel=nofollow
  // and not on a page whose robots directives say nofollow.
  const linkingPages = new Map();
  const followLinkingPages = new Map();
  // The same followable links, from each page: the graph click depth walks.
  const followLinksFrom = new Map();
  const creditLink = (map, targetUrl, sourceUrl) => {
    const set = map.get(targetUrl) || new Set();
    set.add(sourceUrl);
    map.set(targetUrl, set);
  };
  const refusedIndex = refused.size
    ? createResultIndex(allInternalResults.filter((result) => refused.has(result.url)), startUrl)
    : null;
  for (const edge of linkEdges) {
    if (!edge.internal) continue;
    const source = index.get(edge.sourceUrl);
    // A refused page is not audited, but how many pages link to it is still
    // true, and is what the URL table shows for it.
    const target = index.get(edge.targetUrl) || refusedIndex?.get(edge.targetUrl);
    if (!source || !target) continue;
    const followable =
      !(edge.nofollow || linkRelTokens(edge).has("nofollow")) &&
      !isNofollow(resultRobotsDirectives(source));
    const destinations = [target.url];
    const trace = redirectTraces.get(target.url);
    if (trace && !trace.loop && !trace.limitReached) {
      const destination = index.get(trace.targetUrl);
      if (destination) destinations.push(destination.url);
    }
    for (const url of destinations) {
      if (url === source.url) continue;
      creditLink(linkingPages, url, source.url);
      if (followable) {
        creditLink(followLinkingPages, url, source.url);
        creditLink(followLinksFrom, source.url, url);
      }
    }
  }
  // A page that sends the visitor on with a meta refresh or Refresh header
  // links to its destination as surely as an <a> does (Google treats an
  // instant refresh like a redirect), so that destination is not an orphan.
  for (const result of internalResults) {
    if (result.status < 200 || result.status >= 300) continue;
    const refresh = declarativeRefresh(result);
    if (!refresh || refresh.isReload) continue;
    const destination = index.get(refresh.url);
    if (!destination || destination.url === result.url) continue;
    creditLink(linkingPages, destination.url, result.url);
    if (!isNofollow(resultRobotsDirectives(result))) {
      creditLink(followLinkingPages, destination.url, result.url);
      creditLink(followLinksFrom, result.url, destination.url);
    }
  }

  // ── Click depth ────────────────────────────────────────────────────────────
  // The fewest followable links from the start page, found by a breadth-first
  // walk of the link graph. The crawler's own `depth` is the order it found a
  // page in, and it queued every sitemap URL at depth 1, so on a site with a
  // sitemap nearly every page read as one click from home. A redirect is not a
  // click: its destination is as deep as the link to it. A page no followable
  // link reaches has no click depth (null), rather than a guessed one.
  const clickDepths = new Map();
  const clickParents = new Map();
  if (clickDepthFromStart) {
    const queue = [];
    const visit = (url, depth, parent) => {
      if (clickDepths.has(url)) return;
      clickDepths.set(url, depth);
      if (parent) clickParents.set(url, parent);
      queue.push(url);
      const trace = redirectTraces.get(url);
      if (trace && !trace.loop && !trace.limitReached) {
        const destination = index.get(trace.targetUrl);
        if (destination) visit(destination.url, depth, url);
      }
    };
    const root = index.get(startUrl);
    if (root) visit(root.url, 0, null);
    for (let at = 0; at < queue.length; at += 1) {
      const url = queue[at];
      for (const next of followLinksFrom.get(url) || []) visit(next, clickDepths.get(url) + 1, url);
    }
  }
  const clickDepthOf = (url) => (clickDepths.has(url) ? clickDepths.get(url) : null);
  const clickPath = (url) => {
    const path = [url];
    for (let at = url; clickParents.has(at); ) {
      at = clickParents.get(at);
      path.unshift(at);
    }
    return path;
  };
  // ── Soft 404s ──────────────────────────────────────────────────────────────
  // Pages that answer 200 but are the site's "not found" page: the same body as
  // the crawler's probe of a URL that cannot exist, or titled like an error page
  // with almost nothing on it. Kept out of the duplicate checks below — five
  // soft 404s share a title because they are one error page, and that is one
  // problem, reported once per URL as soft-404.
  const missingPageProbe = siteDiagnostics.missingPageProbe || null;
  const softNotFound = new Map(); // url -> detail
  for (const result of htmlResults) {
    if (result.status !== 200 || result.url === startUrl) continue;
    if (missingPageProbe?.hash && result.hash === missingPageProbe.hash) {
      softNotFound.set(
        result.url,
        "Returns 200 with the same page the site serves for a URL that does not exist",
      );
      continue;
    }
    const wording = [result.title, result.h1].find(readsLikeNotFound);
    if (wording && (Number(result.words) || 0) < SOFT_404_MAX_WORDS) {
      softNotFound.set(
        result.url,
        `Returns 200, reads "${String(wording).slice(0, 120)}" and has only ${Number(result.words) || 0} words`,
      );
    }
  }

  const inlinksOf = (url) => linkingPages.get(url)?.size || 0;
  const followInlinksOf = (url) => followLinkingPages.get(url)?.size || 0;

  // A refused page keeps its status finding, so the URLs are listed, but says
  // what happened: the server refused the crawler, and nothing was learned
  // about the page itself.
  for (const result of allInternalResults) {
    if (!refused.has(result.url) || result.isAsset) continue;
    const reason = refused.get(result.url);
    const refusal = {
      detail: result.status === RATE_LIMIT_STATUS
        ? `The server rate-limited the crawler (${reason}); the page itself was not audited.`
        : `The server refused the crawler (${reason}); the page itself was not audited.`,
      detectedValue: reason,
      crawlRefused: true,
    };
    if (result.status >= 500) add("page-5xx", result, refusal);
    else if (result.status >= 400) add("page-4xx", result, refusal);
  }

  for (const result of internalResults) {
    const isHtml = result.contentType?.includes("text/html");
    const inSitemaps = [...(sitemapsByPage.get(index.identity(result.url)) || [])];
    // Whole directive tokens that apply to CrawlScope or Googlebot — never a
    // substring test, which read max-image-preview:none as noindex + nofollow.
    const directives = resultRobotsDirectives(result);
    const hasNoindex = isNoindex(directives);
    const hasNofollow = isNofollow(directives);

    // Page-level status checks are for pages. A broken image, stylesheet or
    // script is reported on the pages that load it (see the resource-edge loop
    // below), which is where someone has to go to fix it; filing it as a "page
    // returning 4XX" on the file's own URL named nothing to open.
    const brokenAsset = result.isAsset && (result.status >= 400 || !result.status);
    if (!brokenAsset && result.status >= 500 && result.status < 600) {
      add("page-5xx", result, {
        detail: result.statusText,
        detectedValue: `HTTP ${result.status}${
          result.statusText ? ` ${result.statusText}` : ""
        }`,
      });
    } else if (!brokenAsset && result.status >= 400 && result.status < 500) {
      add("page-4xx", result);
    }
    if (!result.status && result.statusText !== "Blocked by robots.txt") {
      if (!result.isAsset) add("crawl-failure", result, { detail: result.statusText });
      if (/altname|certificate.*name|cert.*hostname/i.test(result.statusText)) {
        add("ssl-certificate-name", result, { detail: result.statusText });
      }
      if (/sni|unrecognized.?name/i.test(result.statusText)) {
        add("sni-unsupported", result, { detail: result.statusText });
      }
    }

    // Blocked means blocked for Googlebot: that is what keeps a page out of
    // Google. robots.txt is read for both. A URL closed to CrawlScope alone was
    // not fetched (the crawl obeys its own group) but is open to Google, so it
    // is not reported, only counted as not audited (coverage); one closed to
    // Googlebot alone was fetched and audited, and is reported.
    if (result.statusText === "Blocked by robots.txt") {
      if (result.googlebotAllowed !== true) {
        add(result.isAsset ? "blocked-resource" : "robots-blocked", result,
          result.googlebotAllowed === false
            ? { detail: "robots.txt disallows this URL for Googlebot, and for CrawlScope." }
            : {});
      }
    } else if (result.googlebotDisallowed) {
      add(result.isAsset ? "blocked-resource" : "robots-blocked", result, {
        detail: "robots.txt disallows this URL for Googlebot. It is open to CrawlScope, so it was still audited.",
      });
    }

    if (inSitemaps.length) {
      const refresh = declarativeRefresh(result);
      const declarativeRedirect = redirectDestination(result);
      const terminalFailure = redirectTerminalFailures.get(result.url);
      const terminalSuitability =
        redirectTerminalSuitabilityIssues.get(result.url);
      // Canonical to another page — not merely to this page's own http://
      // spelling, which canonical-to-http reports; sending the sitemap to the
      // http:// URL would be the wrong fix.
      const canonicalMismatch = Boolean(result.canonical) && !index.same(result.canonical, result.url);
      if (
        result.status !== 200 ||
        result.indexability !== "Indexable" ||
        canonicalMismatch ||
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
            canonicalMismatch,
          }),
        });
      }
      if (isRedirectStatus(result.status)) add("sitemap-redirect", result);
      for (const entry of httpSitemapEntries.get(index.identity(result.url)) || []) {
        add("sitemap-http-url", result, {
          targetUrl: entry.loc,
          detail: `Listed as ${entry.loc} in ${entry.sitemaps.join(", ")}; the site is served over HTTPS`,
          detectedValue: entry.loc,
        });
      }
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
      add("sitemap-missing-indexable", result, {
        detail:
          "Indexable HTML page returning 200, absent from every sitemap discovered for this site",
        detectedValue: "(not in any discovered sitemap)",
      });
    }

    const robotsDirective = result.robots || (hasNoindex && hasNofollow ? "noindex, nofollow" : hasNoindex ? "noindex" : "nofollow");
    if (hasNoindex && hasNofollow) add("noindex-nofollow", result, { detectedValue: robotsDirective });
    else if (hasNoindex) add("noindex", result, { detectedValue: robotsDirective });
    else if (hasNofollow) add("nofollow-page", result, { detectedValue: robotsDirective });

    if (
      !crawlTruncated &&
      isHtml &&
      result.status === 200 &&
      result.url !== startUrl &&
      result.fromSitemap &&
      inlinksOf(result.url) === 0
    ) {
      add("orphan-page", result);
    }
    if (
      !crawlTruncated &&
      isHtml &&
      result.status === 200 &&
      result.url !== startUrl &&
      followInlinksOf(result.url) === 1
    ) {
      add("single-inlink", result, {
        detectedValue: [...(followLinkingPages.get(result.url) || [])][0] || "",
      });
    }
    const clickDepth = clickDepthOf(result.url);
    if (isHtml && result.status >= 200 && result.status < 300 && clickDepth > 3) {
      add("deep-page", result, {
        detail: `${clickDepth} clicks from the start page`,
        // The shortest route in, which is where a shortcut link would go.
        detectedValue: clickPath(result.url).join(" -> "),
      });
    }

    const redirectDetectedValue = result.redirectUrl ? `${result.status} -> ${result.redirectUrl}` : `HTTP ${result.status}`;
    if ([301, 308].includes(result.status)) add("permanent-redirect", result, { detectedValue: redirectDetectedValue });
    if ([302, 303, 307].includes(result.status)) add("temporary-redirect", result, { detectedValue: redirectDetectedValue });
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
        // Every hop, which is what has to be collapsed into one redirect —
        // not just how many there are.
        detectedValue: trace.path.join(" -> "),
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
          const target = index.get(refresh.url);
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
      // A deliberately noindexed page won't appear in search results, so how
      // its title, description, headings, viewport, Open Graph tags or word
      // count would look there has no SEO consequence. Flagging them is noise
      // on top of the noindex finding itself — the one thing worth reviewing on
      // the /cart, /login and tag pages sites noindex on purpose. Speed,
      // security, redirects and links are still checked below.
      if (!hasNoindex) {
        // Previously only caught by crawler.js's live quickIssues() pass, which
        // never gets re-run once findings replace it after the crawl completes
        // — a page missing its <title> silently lost this finding entirely at
        // that point, rather than just losing its category/description.
        if (!result.title) {
          // Same URL-slug fallback suggestH1 uses — there's no existing title
          // to trim, so this is a starting point to hand-refine, not a
          // finished recommendation.
          const slugTitle = humanizeUrlSlug(result.url);
          add("title-missing", result, slugTitle ? { recommendedValue: slugTitle } : {});
        }
        if (result.titleCount > 1) {
          add("title-multiple", result, { detectedValue: result.titleCount });
        }
        if (result.title && result.titleLength < TITLE_MIN_LENGTH) {
          add("title-short", result, {
            detail: `${result.titleLength} characters`,
            detectedValue: result.title,
          });
        }
        if (result.titleLength > 60) {
          add("title-long", result, {
            detail: `${result.titleLength} characters`,
            detectedValue: result.title,
            recommendedValue: suggestTitle(result.title),
          });
        }
        if (!result.metaDescription) {
          // Both of these carried an empty detail and detectedValue, so 484
          // identical rows on one crawl told a developer nothing about which page
          // to open or what was actually observed there.
          add("meta-missing", result, {
            detail: "No <meta name=\"description\"> on this page",
            detectedValue: "(absent)",
            recommendedValue: suggestMetaDescription(result),
          });
        } else if (result.metaLength > 160) {
          add("meta-long", result, {
            detail: `${result.metaLength} characters`,
            detectedValue: result.metaDescription,
            recommendedValue: `Needs a manual rewrite — current description is ${result.metaLength} characters (target 150-160). Trim to the most important sentence rather than cutting mid-sentence.`,
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
          add("h1-title-duplicate", result, { detectedValue: `Title and H1 both read "${result.title.trim()}"` });
        }
      }
      // Explicitly empty only: a result stored before the crawler read the
      // attribute has no htmlLang at all, which is not the same thing. The
      // same goes for charset and doctype below.
      if (result.htmlLang === "") add("html-lang-missing", result);
      if (result.charsetDeclared === false) add("charset-missing", result);
      if (result.doctypeDeclared === false) add("doctype-missing", result);

      // Weight and compression of the HTML itself (the resource checks cover
      // scripts and stylesheets).
      const htmlBytes = Number(result.decodedSize) || 0;
      if (result.bodyTruncated || htmlBytes > HTML_TOO_LARGE_BYTES) {
        add("html-too-large", result, {
          detail: result.bodyTruncated
            ? "Larger than 5 MB: the crawler stopped reading there"
            : `${(htmlBytes / 1_048_576).toFixed(1)} MB of HTML`,
          detectedValue: result.bodyTruncated ? "> 5 MB" : `${(htmlBytes / 1_048_576).toFixed(1)} MB`,
        });
      }
      const encoding = String(result.contentEncoding || "").trim().toLowerCase();
      if (htmlBytes >= HTML_COMPRESSION_MIN_BYTES && (!encoding || encoding === "identity")) {
        add("html-uncompressed", result, {
          detectedValue: `${(htmlBytes / 1024).toFixed(1)} KB sent with no Content-Encoding`,
        });
      }
      if (Number(result.anchorCount) > TOO_MANY_LINKS) {
        add("too-many-links", result, {
          detail: `${Number(result.anchorCount).toLocaleString("en-US")} links on the page`,
          detectedValue: result.anchorCount,
        });
      }

      // The URL itself.
      let parsedUrl = null;
      try {
        parsedUrl = new URL(result.url);
      } catch {
        parsedUrl = null;
      }
      if (parsedUrl) {
        if (result.url.length > URL_MAX_LENGTH) {
          add("url-too-long", result, { detail: `${result.url.length} characters`, detectedValue: result.url.length });
        }
        if (parsedUrl.pathname.includes("_")) add("url-underscore", result, { detectedValue: parsedUrl.pathname });
        const parameters = [...parsedUrl.searchParams.keys()].length;
        if (parameters > URL_MAX_PARAMETERS) {
          add("url-too-many-parameters", result, { detail: `${parameters} query parameters`, detectedValue: parsedUrl.search });
        }
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
        !hasNoindex &&
        result.textHtmlRatio > 0 &&
        result.textHtmlRatio <= 0.1 &&
        result.words > 0 &&
        result.words < 200
      ) {
        add("low-text-html-ratio", result, {
          detectedValue: Number(result.textHtmlRatio.toFixed(3)),
        });
      }
      if (!hasNoindex && result.words > 0 && result.words < 200) {
        add("low-word-count", result, { detectedValue: `${result.words} words` });
      }
      const openGraphMissing = result.openGraphMissing || [];
      const openGraphInvalidUrls = result.openGraphInvalidUrls || [];
      if (!hasNoindex && openGraphMissing.length) {
        add("open-graph-incomplete", result, {
          detail: `Missing required properties: ${openGraphMissing.join(", ")}`,
          detectedValue: openGraphMissing.map((property) => `• ${property}`).join("\n"),
          // Root-cause grouping's "missing-property" family needs the raw,
          // sorted set — the bullet-joined detectedValue above is for
          // display and isn't safe to re-parse (order isn't guaranteed
          // stable across every caller, and the "• " prefix would leak
          // into the signature).
          evidenceKey: [...openGraphMissing].sort().join(","),
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
      for (const schemaError of hasNoindex ? [] : result.schemaErrors || []) {
        add("schema-error", result, {
          detail: schemaError,
          detectedValue: schemaError,
        });
      }
      if (result.responseTime > 1000) {
        // No `detail` here on purpose: this rule's own Excel sheet drops the
        // "Target / Related URL" column entirely (report-writer.js) rather
        // than carry a stray value in a column headed for a different kind
        // of URL. Raw milliseconds — matching the crawl-time "Time" column
        // in the UI — not seconds rounded to 2 decimals, which silently
        // dropped precision; the report's own numFmt handles display.
        add("slow-page", result, {
          detectedValue: Math.round(result.responseTime),
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
          detectedValue: `${(result.size / 1024).toFixed(1)} KB`,
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

    const hasSelfReference = result.hreflangs.some((entry) => index.same(entry.url, result.url));
    if (!hasSelfReference) add("hreflang-missing-self", result);

    // One language code for two pages: search engines cannot tell which one
    // it means and may ignore the set.
    const pagesByLang = new Map();
    for (const entry of result.hreflangs) {
      const pages = pagesByLang.get(entry.lang) || new Map();
      pages.set(index.identity(entry.url) || entry.url, entry.url);
      pagesByLang.set(entry.lang, pages);
    }
    for (const [lang, pages] of pagesByLang) {
      if (pages.size < 2) continue;
      add("hreflang-conflict", result, {
        detail: `hreflang="${lang}" points at ${pages.size} different URLs: ${[...pages.values()].join(", ")}`,
        detectedValue: lang,
      });
    }
    if (!pagesByLang.has("x-default")) add("hreflang-x-default-missing", result);

    for (const entry of result.hreflangs) {
      if (index.same(entry.url, result.url)) continue;
      const target = index.get(entry.url);
      // Can't verify a return tag on a page we never crawled — that's a
      // separate, weaker signal than a confirmed one-way link, so it's left
      // alone rather than guessed at.
      if (!target) continue;
      // An alternate has to be a live, indexable, self-canonical page, or the
      // annotation points search engines at something they will not index.
      // When it is not, that is the finding — "does not link back" would blame
      // the page for its target being broken.
      const targetProblem = hreflangTargetProblem(target, index);
      if (targetProblem) {
        add("hreflang-target-invalid", result, {
          targetUrl: entry.url,
          detail: `The hreflang="${entry.lang}" alternate ${targetProblem}`,
          detectedValue: entry.lang,
        });
        continue;
      }
      const pointsBack = (target.hreflangs || []).some((t) => index.same(t.url, result.url));
      if (!pointsBack) {
        add("hreflang-missing-return", result, {
          targetUrl: entry.url,
          detail: `${entry.url} does not link back to this page via hreflang`,
        });
      }
    }
  }

  for (const result of internalResults) {
    if (result.status !== 200) continue;
    // Two canonicals that disagree are no canonical: search engines drop both
    // and choose for themselves. <head> tags and the Link header count alike.
    if (result.canonicals?.length > 1) {
      add("multiple-canonical", result, {
        detail: `${result.canonicals.length} different canonical URLs: ${result.canonicals.join(", ")}`,
        detectedValue: result.canonicals.join(", "),
      });
    }
    // A canonical in <body> is ignored, so it does nothing — and when it is the
    // page's only one, whoever put it there believes the page has a canonical.
    if (result.canonicalsOutsideHead?.length) {
      add("canonical-outside-head", result, {
        detail: result.canonicals?.length
          ? `A canonical tag in <body> is ignored; the one in <head> applies (${result.canonicalsOutsideHead.join(", ")})`
          : `The page's only canonical tag is in <body>, where search engines ignore it (${result.canonicalsOutsideHead.join(", ")})`,
        detectedValue: result.canonicalsOutsideHead.join(", "),
      });
    }
  }

  for (const result of internalResults) {
    if (result.status !== 200 || !result.canonical || result.canonical === result.url) {
      continue;
    }
    // An https page declaring an http:// canonical asks search engines to
    // prefer the insecure URL. Reported on its own — the crawler fetches
    // http:// URLs on this host as https, so the lookup below would otherwise
    // land on the page itself and call it a chain.
    if (result.url.startsWith("https:") && result.canonical.startsWith("http:")) {
      add("canonical-to-http", result, {
        targetUrl: result.canonical,
        detail: index.same(result.canonical, result.url)
          ? "The canonical is this page's own URL on http://"
          : `The canonical points at an http:// URL: ${result.canonical}`,
        detectedValue: result.canonical,
      });
    }
    if (index.same(result.canonical, result.url)) continue;
    const target = index.get(result.canonical);
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
    } else if (target.canonical && !index.same(target.canonical, target.url)) {
      add("canonical-chain", result, {
        targetUrl: result.canonical,
        detail: `${result.canonical} canonicalizes to a different URL (${target.canonical}) instead of itself`,
      });
    } else {
      if (isNoindex(resultRobotsDirectives(target))) {
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
      const target = index.get(url);
      if (!target) continue; // uncrawled target — can't verify, don't guess
      if (target.status >= 400 || !target.status) {
        add("pagination-link-broken", result, {
          targetUrl: url,
          detail: `rel="${direction}" target returns ${target.status || "no response"}`,
        });
      }
    }

    if (result.canonical && !index.same(result.canonical, result.url)) {
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
      if (
        !value ||
        !isPreferredIndexablePage(result, index) ||
        !isEligible(result) ||
        softNotFound.has(result.url)
      ) {
        continue;
      }
      const group = groups.get(value) || [];
      group.push(result);
      groups.set(value, group);
    }
    for (const unsortedGroup of groups.values()) {
      if (unsortedGroup.length < 2) continue;
      const group = [...unsortedGroup].sort((a, b) => a.url.localeCompare(b.url));
      if (isReciprocalHreflangGroup(group, index)) continue;
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
      !isPreferredIndexablePage(result, index) ||
      softNotFound.has(result.url) ||
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
    if (isReciprocalHreflangGroup(group, index)) continue;

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
    const source = index.get(edge.sourceUrl);
    // The page the crawler fetched for this link — for an http:// href on an
    // https site, its https equivalent (the edge keeps the href as written).
    const target = index.get(edge.targetUrl);
    if (!source) continue;
    const relTokens = linkRelTokens(edge);
    const isNofollow = edge.nofollow || relTokens.has("nofollow");

    if (edge.internal) {
      const targetTrace = target && redirectTraces.get(target.url);
      const targetTerminalFailure =
        target && redirectTerminalFailures.get(target.url);
      const targetTerminalSuitability =
        target && redirectTerminalSuitabilityIssues.get(target.url);
      // A target the crawler declined to fetch out of its own robots.txt
      // compliance is not a dead link — the crawler chose not to check it,
      // the same way it wouldn't fetch a genuinely disallowed page. That's
      // already its own, milder finding (`robots-blocked`/`blocked-resource`,
      // fired once per target above, not once per linking page); folding it
      // into "broken" here mislabeled a polite no-fetch as a defect and, on a
      // shared nav/footer link, inflated one blocked URL into a finding on
      // every single page that links to it.
      const targetRobotsBlocked = target?.statusText === "Blocked by robots.txt";
      if (target && !targetRobotsBlocked && (target.status >= 400 || !target.status)) {
        add("broken-internal-links", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: target.status
            ? `HTTP ${target.status}${target.statusText ? ` ${target.statusText}` : ""}`
            : `Could not be fetched (${target.statusText || "no response"})`,
          detectedValue: linkTextEvidence(edge),
        });
      } else if (targetTerminalFailure) {
        add("broken-internal-links", source, {
          targetUrl: edge.targetUrl,
          statusCode: targetTerminalFailure.statusCode,
          detail: `Link target's ${targetTerminalFailure.relationshipDetail}. Path: ${targetTerminalFailure.pathEvidence}`,
          detectedValue: linkTextEvidence(edge),
        });
      }
      const targetRedirect = redirectDestination(target);
      if (targetTrace?.loop) {
        const evidence = `Redirect loop: ${targetTrace.path.join(" -> ")}`;
        add("link-to-redirect", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: evidence,
          detectedValue: evidence,
        });
      } else if (targetTrace?.limitReached) {
        const evidence = `Exceeds Fetch's ${MAX_FETCH_REDIRECTS}-redirect limit: ${redirectLimitEvidence(targetTrace)}`;
        add("link-to-redirect", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: evidence,
          detectedValue: evidence,
        });
      } else if (targetTerminalSuitability) {
        const evidence = `Link target's ${targetTerminalSuitability.relationshipDetail}. Path: ${targetTerminalSuitability.pathEvidence}`;
        add("link-to-redirect", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: evidence,
          detectedValue: evidence,
        });
      } else if (
        !targetTerminalFailure &&
        target &&
        isRedirectStatus(target.status)
      ) {
        const evidence = target.redirectLocationIssue
          ? redirectLocationIssueDetail(target)
          : `Target redirects (${target.status}) to ${target.redirectUrl}`;
        add("link-to-redirect", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: evidence,
          detectedValue: evidence,
        });
      } else if (!targetTerminalFailure && targetRedirect) {
        const targetRefresh = declarativeRefresh(target);
        const evidence = `${declarativeRefreshLabel(targetRefresh)} to ${targetRedirect}`;
        add("link-to-redirect", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: evidence,
          detectedValue: evidence,
        });
      }
      if (isNofollow) {
        add("internal-nofollow-link", source, {
          targetUrl: edge.targetUrl,
          // An icon-only or image link legitimately has no anchor text — show
          // the rel value instead of leaving the reviewer looking at a blank
          // cell with no way to tell what was actually detected.
          detectedValue: edge.anchorText || `(no visible link text) rel="${[...relTokens].join(" ") || "nofollow"}"`,
        });
      }
      // Keyed by the page, not the href: http:// and https:// links to one
      // page are links to the same page.
      const targetKey = target?.url || index.identity(edge.targetUrl) || edge.targetUrl;
      const statuses = incomingFollow.get(targetKey) || { nofollowFrom: new Set(), dofollowFrom: new Set() };
      (isNofollow ? statuses.nofollowFrom : statuses.dofollowFrom).add(edge.sourceUrl);
      incomingFollow.set(targetKey, statuses);
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

      if (REFUSED_EXTERNAL_STATUS[target?.status]) {
        // Refusal, not absence: bot protection, rate limiting and login walls
        // answer a crawler this way while the page is live for visitors.
        const label = REFUSED_EXTERNAL_STATUS[target.status];
        add("external-403", source, {
          targetUrl: edge.targetUrl,
          statusCode: target.status,
          detail: `The crawler received HTTP ${target.status} (${label}); this proves request refusal, not that the destination is missing.`,
          detectedValue: `HTTP ${target.status} (${label})`,
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
      // Evidence about the http:// URL itself, when it was fetched as written
      // (another host); otherwise what the crawl fetched in its place.
      const exactTarget = index.exact(edge.targetUrl);
      const evidence = httpLinkEvidence(
        edge,
        exactTarget,
        !exactTarget && target && target.url !== edge.targetUrl ? target : null,
      );
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
    add("external-nofollow", index.get(sourceUrl) || { url: sourceUrl }, {
      detail: `${genericCount} of ${policy.total} external links (${percentage}%) use generic rel="nofollow" without sponsored or ugc qualification.`,
      detectedValue: `${genericCount}/${policy.total} external links (${percentage}%); examples: ${examples.join(" | ")}`,
    });
  }

  for (const [url, statuses] of incomingFollow) {
    if (statuses.nofollowFrom.size && statuses.dofollowFrom.size) {
      const nofollowExample = [...statuses.nofollowFrom][0];
      const dofollowExample = [...statuses.dofollowFrom][0];
      add("mixed-incoming-follow", index.get(url) || { url }, {
        detectedValue: `${statuses.nofollowFrom.size} nofollow link(s) (e.g. from ${nofollowExample}), ${statuses.dofollowFrom.size} dofollow link(s) (e.g. from ${dofollowExample})`,
      });
    }
  }

  for (const edge of resourceEdges) {
    const source = index.get(edge.sourceUrl) || { url: edge.sourceUrl };
    const resource = index.get(edge.targetUrl);
    const resourceFailure = resource && redirectTerminalFailures.get(resource.url);
    if (
      resource &&
      resource.scope !== "External" &&
      resource.statusText !== "Blocked by robots.txt" &&
      (resource.status >= 400 || !resource.status || resourceFailure)
    ) {
      const status = resourceFailure ? resourceFailure.statusCode : resource.status;
      add(BROKEN_RESOURCE_RULE[resourceKind(edge)], source, {
        targetUrl: edge.targetUrl,
        statusCode: status,
        detail: resourceFailure
          ? `Redirects to a broken destination: ${resourceFailure.pathEvidence}`
          : status
            ? `HTTP ${status}${resource.statusText ? ` ${resource.statusText}` : ""}`
            : `Could not be fetched (${resource.statusText || "no response"})`,
        detectedValue: edge.elementHint || `${edge.tag || "resource"} via ${edge.sourceAttribute || "URL"}`,
      });
    }
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
    // The catalog's own recommendation text is a generic "yoursite.com"
    // placeholder (it has to be — the catalog is shared across every crawl);
    // override it here with the actual crawled domain so the report tells
    // someone what to paste, not what to search-and-replace first.
    const sitemapUrl = new URL("/sitemap.xml", startUrl).href;
    add("sitemap-robots-config", { url: siteDiagnostics.robotsUrl || startUrl }, {
      detail: siteDiagnostics.sitemapConfigIssue,
      recommendation:
        `Add a "Sitemap: ${sitemapUrl}" line to robots.txt pointing at the live sitemap, ` +
        "and confirm the sitemap itself returns a 200 response.",
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
  if (refusals.refused.size) {
    const breakdown = [...refusals.statusCounts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `${reason} ×${count}`)
      .join(", ");
    const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const what = [
      refusals.refusedPages ? `${refusals.refusedPages} of ${plural(refusals.pageResponses, "page")}` : "",
      refusals.refusedFiles ? plural(refusals.refusedFiles, "file") : "",
    ].filter(Boolean).join(" and ");
    add("crawl-blocked", { url: startUrl }, {
      detail:
        `The site answered the crawler with a refusal instead of the content for ${what} (${breakdown})` +
        `${refusals.startRefused ? ", including the start page" : ""}. ` +
        "Those URLs were not audited and are left out of Site Health.",
      detectedValue: breakdown,
    });
  }
  // A sitemap past the protocol's 50 MB / 50,000-URL limits is rejected by
  // search engines; one finding per file, on the file.
  for (const limit of siteDiagnostics.sitemapLimits || []) {
    add("sitemap-too-large", { url: limit.url }, {
      detail: `${limit.url} ${limit.detail}.`,
      detectedValue: limit.detail,
    });
  }
  // Entries on another host (www vs the bare domain, a staging host) are
  // ignored by search engines and were skipped by the crawl without a word;
  // the pages they meant to list then read as missing from every sitemap.
  const offHost = siteDiagnostics.sitemapOffHost;
  if (offHost?.count) {
    const hosts = (offHost.hosts || []).map(([host, count]) => `${host} (${count.toLocaleString("en-US")})`).join(", ");
    add("sitemap-off-host", { url: siteDiagnostics.robotsUrl || startUrl }, {
      detail:
        `${offHost.count.toLocaleString("en-US")} sitemap ${offHost.count === 1 ? "entry is" : "entries are"} on ` +
        `${(offHost.hosts || []).length === 1 ? "another host" : "other hosts"}: ${hosts}. ` +
        "Search engines ignore them, and the crawl skipped them.",
      detectedValue: (offHost.samples || []).join(", "),
    });
  }
  // Without this the audit of a client-rendered site reads as clean: one page,
  // no links, nothing broken. The absence of findings WAS the finding. A
  // refused start page has no links either, but that is the refusal, reported
  // above, not a client-rendered site.
  if (siteDiagnostics.renderingIssue && !refusals.startRefused) {
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
  for (const [url, detail] of softNotFound) {
    add("soft-404", index.get(url) || { url }, { detail, detectedValue: index.get(url)?.title || "" });
  }
  // A probe answered with a bot check says how the firewall treats the crawler,
  // not how the site treats a missing URL.
  if (missingPageProbe && missingPageProbe.status && !readsLikeChallenge(missingPageProbe)) {
    const status = missingPageProbe.status;
    if (missingPageProbe.redirected) {
      add("soft-404-site", { url: startUrl }, {
        targetUrl: missingPageProbe.url,
        statusCode: status,
        detail: `A URL that cannot exist (${missingPageProbe.url}) redirected to ${missingPageProbe.finalUrl} instead of returning 404.`,
        detectedValue: `redirect -> ${missingPageProbe.finalUrl} (HTTP ${status})`,
      });
    } else if (status >= 200 && status < 300) {
      add("soft-404-site", { url: startUrl }, {
        targetUrl: missingPageProbe.url,
        statusCode: status,
        detail: `A URL that cannot exist (${missingPageProbe.url}) returned HTTP ${status}${
          missingPageProbe.title ? ` with the page "${missingPageProbe.title}"` : ""
        } instead of 404.`,
        detectedValue: `HTTP ${status}`,
      });
    }
  }
  // JavaScript changing what a page shows (render-check.js): one site-wide
  // finding naming the sampled pages it changed and how.
  const render = siteDiagnostics.renderCheck;
  const changedByScript = render?.ran ? (render.pages || []).filter((entry) => entry.differences?.length) : [];
  if (changedByScript.length) {
    const clip = (text) => {
      const value = String(text || "").replace(/\s+/g, " ").trim();
      return value.length > 60 ? `${value.slice(0, 59)}…` : value;
    };
    const describe = (difference) => {
      switch (difference.kind) {
        case "links":
        case "words":
          return `${difference.kind} ${Number(difference.raw).toLocaleString("en-US")} → ${Number(difference.rendered).toLocaleString("en-US")}`;
        case "canonical":
          return `canonical ${difference.raw} → ${difference.rendered}`;
        default:
          return `${difference.kind} "${clip(difference.raw) || "none"}" → "${clip(difference.rendered) || "none"}"`;
      }
    };
    const pathOf = (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.pathname}${parsed.search}`;
      } catch {
        return url;
      }
    };
    const examples = changedByScript
      .slice(0, 3)
      .map((entry) => `${pathOf(entry.url)}: ${entry.differences.map(describe).join(", ")}`);
    add("javascript-dependent-content", { url: startUrl }, {
      detail:
        `JavaScript changes what ${changedByScript.length} of ${render.sampled} rendered page${render.sampled === 1 ? "" : "s"} ` +
        `show, compared with the HTML the server sends. ${examples.join("; ")}.`,
      detectedValue: [...new Set(changedByScript.flatMap((entry) => entry.differences.map((d) => d.kind)))].join(", "),
    });
  }

  const www = siteDiagnostics.wwwResolve;
  if (www?.servesContent) {
    const home = (() => {
      try {
        return new URL("/", startUrl).href;
      } catch {
        return startUrl;
      }
    })();
    add("www-resolve", { url: startUrl }, {
      targetUrl: www.url,
      statusCode: www.status,
      detail:
        `${www.url} answers HTTP ${www.status} instead of redirecting to ${home}.` +
        (www.canonical && index.same(www.canonical, home)
          ? " Its canonical points here, which lets search engines merge the two, but visitors and links still split between them."
          : ""),
      detectedValue: `HTTP ${www.status}`,
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

  // Checked by hostname, not just the seed URL: the catalog entry for this
  // rule promises "some subdomains do not instruct browsers to use HTTPS
  // automatically," but a root-only check can never actually see a
  // subdomain — it would only ever fire (or not) for whatever host the crawl
  // started on. One representative 200-status HTTPS response per distinct
  // hostname is enough to know whether that host sends the header.
  const hstsCheckedHosts = new Map();
  for (const result of internalResults) {
    if (!result.url.startsWith("https:") || result.status !== 200) continue;
    let host;
    try {
      host = new URL(result.url).hostname;
    } catch {
      continue;
    }
    if (!hstsCheckedHosts.has(host)) hstsCheckedHosts.set(host, result);
  }
  for (const [host, sample] of hstsCheckedHosts) {
    if (!sample.strictTransportSecurity) {
      add("hsts-missing", sample, { detectedValue: `${host} — checked via ${sample.url}` });
    }
  }

  // Every check above has finished adding findings — collapse before this
  // point sees them once, not per rule, and before enrichedResults'
  // per-page .issues lists get built (a template-tagged finding is excluded
  // from those the same way a site-scoped one already is).
  collapseTemplateFindings(findings, htmlResults.length);
  const rootCauseGroups = buildRootCauseGroups(findings);

  const findingsByUrl = new Map();
  for (const finding of findings) {
    const list = findingsByUrl.get(finding.url) || [];
    list.push(finding);
    findingsByUrl.set(finding.url, list);
  }
  const enrichedResults = results.map((result) => ({
    ...result,
    ...(result.scope === "External"
      ? {}
      : {
          inlinks: inlinksOf(result.url),
          followInlinks: followInlinksOf(result.url),
          clickDepth: clickDepthOf(result.url),
        }),
    // Not audited: Site Health leaves it out of the pages it is taken over.
    ...(refused.has(result.url) ? { crawlRefused: true } : {}),
    pageCategory: categorizePage(result),
    issues: (findingsByUrl.get(result.url) || []).map((finding) => ({
      id: finding.ruleId,
      label: finding.title,
      severity: finding.severity,
      category: finding.category,
    })),
  }));

  return {
    findings,
    results: enrichedResults,
    catalog,
    // Which problem to fix first: one ordering, with a reason per rule, that
    // the report, the workbook and the email all use (rule-order.js).
    ruleOrder: ruleOrder(findings, enrichedResults, { startUrl }),
    // Which checks this crawl could not run, or ran on part of the site, so
    // "no findings" is not read as "passed".
    coverage: crawlCoverage({
      firedRuleIds: new Set(findings.map((finding) => finding.ruleId)),
      crawlTruncated,
      sitemapsChecked,
      externalLinksChecked,
      robotsRespected,
      clickDepthFromStart,
      siteDiagnostics,
      startUrl,
      pagesMissingLinkData,
      googlebotRobotsChecked,
      closedToCrawlScopeOnly: allInternalResults.filter(
        (result) => result.statusText === "Blocked by robots.txt" && result.googlebotAllowed === true,
      ).length,
    }),
    mediaLibrary: buildMediaLibrary(results, resourceEdges),
    // Internal HTML pages only — the same universe every other page-level
    // metric in this build uses (see healthMetrics's own htmlResults filter
    // client-side), so "N of M pages" reads consistently everywhere.
    integrations: buildIntegrations(htmlResults),
    // One row per distinct root cause, not per occurrence — see
    // buildRootCauseGroups above. Every finding also carries its own
    // rootCauseGroupId/groupMemberCount for anything that needs to go the
    // other direction (which group does this one row belong to).
    rootCauseGroups,
  };
}

module.exports = {
  buildFindings,
  issueKeyOf,
  catalog,
  evidenceSignature,
  groupFixType,
  buildRootCauseGroups,
  categorizePage,
};
