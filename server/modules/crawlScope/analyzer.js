const crypto = require("node:crypto");
const catalog = require("./issue-catalog.json");
const integrationCatalog = require("./integration-catalog.json");
const {
  isRedirectStatus,
  redirectLocationIssueDetail,
} = require("./http-redirect");

const catalogById = new Map(catalog.map((definition) => [definition.id, definition]));

// HTTP 429 is the site throttling the crawler ("slow down"), not a statement
// about the page. A result still at 429 after the crawler's retries was never
// checked, so no rule may treat it as broken: it is reported once, as a
// crawl-failure, and left out of every "status >= 400 means broken" test.
const isRateLimited = (result) => Boolean(result) && result.status === 429;

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

// Titles commonly carry a "Page Name | Brand" or "Page Name - Brand" suffix.
// Trimming to the primary segment first keeps the brand off the chopping
// block, so a long title shrinks by dropping boilerplate before it starts
// cutting the part that actually identifies the page.
const TITLE_SEGMENT_SEPARATOR = /\s*[|–—-]\s*/;

function primaryTitleSegment(title) {
  return String(title || "")
    .split(TITLE_SEGMENT_SEPARATOR)[0]
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
//
// "The segment before the separator" assumes topic-first titles. A brand-first
// title ("Brand | Dentists in North Carolina", typical of a homepage) would be
// cut to the bare brand, so segments that recur across the site's titles
// (`brandSegments`, from brandTitleSegments) are skipped when choosing one.
function suggestTitle(title, brandSegments = new Set()) {
  const trimmed = String(title || "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= 60) return trimmed;
  const segments = trimmed
    .split(TITLE_SEGMENT_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const primary =
    segments.find((segment) => !brandSegments.has(segment.toLowerCase())) ||
    primaryTitleSegment(trimmed);
  if (primary.length >= 30 && primary.length <= 60) return primary;
  return `Needs a manual rewrite — current title is ${trimmed.length} characters (target 50-60). Keep the primary topic and brand; don't just shorten this one.`;
}

// Title segments shared by a large share of the site's titles: the brand
// suffix (or prefix), not any one page's topic. At least 3 titles, so a pair
// of pages that happen to share a segment does not become "the brand".
function brandTitleSegments(htmlResults) {
  const counts = new Map();
  let titled = 0;
  for (const result of htmlResults) {
    const segments = new Set(
      String(result.title || "")
        .split(TITLE_SEGMENT_SEPARATOR)
        .map((segment) => segment.trim().toLowerCase())
        .filter(Boolean),
    );
    if (!segments.size) continue;
    titled += 1;
    if (segments.size < 2) continue;
    for (const segment of segments) counts.set(segment, (counts.get(segment) || 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(titled * 0.3));
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([segment]) => segment));
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
}) {
  if (terminalFailure) {
    return `Remove this URL from the sitemap — its redirect path ends at a broken destination (${terminalFailure.detail}). Fix or redirect the destination first, then add back a URL that returns 200.`;
  }
  if (terminalSuitability) {
    return `Update the sitemap entry — this redirect ends at a non-indexable or non-canonical page (${terminalSuitability.detail}). Point the sitemap at the actual indexable canonical URL instead.`;
  }
  // Checked before the status: a disallowed URL is never fetched, so its
  // status is 0, and "returns HTTP no response" sent readers looking for an
  // outage on a page that serves 200 to a browser.
  if (result.statusText === "Blocked by robots.txt") {
    return "Remove this URL from the sitemap, or unblock it in robots.txt if it should be indexed. The sitemap asks search engines to crawl a URL that robots.txt forbids them to fetch.";
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

  if (terminal.status >= 400 && !isRateLimited(terminal)) {
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

// A later page of a paginated listing: ?page=3, ?paged=2, Webflow's
// ?<collection-id>_page=2, a /page/2/ path segment, or any page that declares
// rel=prev. Recognised from the URL as well as the link element because
// Webflow emits no rel=prev/next at all. `p` is deliberately not a page
// parameter: WordPress uses ?p=123 for a post id.
const PAGINATION_QUERY_PARAM = /^(?:page|paged|pg|pagenum|pageno|page_number|[\w]+[_-]page)$/i;

function isPaginatedListingPage(result) {
  if (result.paginationPrev) return true;
  let parsed;
  try {
    parsed = new URL(result.url);
  } catch {
    return false;
  }
  for (const [name, value] of parsed.searchParams) {
    if (PAGINATION_QUERY_PARAM.test(name) && /^\d+$/.test(value)) return true;
  }
  return /\/page\/\d+\/?$/i.test(parsed.pathname);
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

// ── Checks this crawl could not run ──────────────────────────────────────
// A rule with no findings is only "clean" if it looked at something. These
// are the ones that could not: the inlink-graph rules are switched off on a
// truncated crawl (buildFindings' crawlTruncated gate), and the asset rules
// only read internal assets, of which a site serving everything from a CDN
// has none. Reports keep them out of "N of M checks clean" rather than
// telling a client an unrun check passed. The conditions mirror each rule's
// own eligibility test below; change one and change the other.
const isScriptAsset = (result) =>
  (result.contentType || "").includes("javascript") || /\.m?js(?:$|\?)/i.test(result.url);
const isStyleAsset = (result) =>
  (result.contentType || "").includes("css") || /\.css(?:$|\?)/i.test(result.url);

function notEvaluatedRules({ results = [], crawlTruncated = false } = {}) {
  const notEvaluated = [];
  if (crawlTruncated) {
    const reason =
      "Switched off on a truncated crawl: inlink counts from part of a site do not describe the site.";
    notEvaluated.push({ ruleId: "orphan-page", reason }, { ruleId: "single-inlink", reason });
  }
  // HTML documents discovered through a resource element are not assets.
  const assets = results.filter(
    (result) =>
      result.scope !== "External" &&
      result.isAsset &&
      !(result.contentType || "").includes("html"),
  );
  const fetched = assets.filter((result) => result.status === 200);
  if (!assets.length) {
    notEvaluated.push({
      ruleId: "blocked-resource",
      reason: "No internal resource files (CSS, JavaScript, images, documents) were found to check.",
    });
  }
  if (!assets.some(isScriptAsset)) {
    notEvaluated.push({ ruleId: "broken-javascript", reason: "No internal JavaScript files were fetched." });
  }
  if (!fetched.some((result) => isScriptAsset(result) || isStyleAsset(result))) {
    for (const ruleId of ["asset-uncached", "asset-unminified", "asset-uncompressed"]) {
      notEvaluated.push({ ruleId, reason: "No internal CSS or JavaScript files were fetched." });
    }
  }
  if (!fetched.some((result) => (result.contentType || "").startsWith("image/"))) {
    notEvaluated.push({ ruleId: "image-oversized", reason: "No internal images were fetched." });
  }
  return notEvaluated;
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
  const brandSegments = brandTitleSegments(
    htmlResults.filter((result) => result.status >= 200 && result.status < 300),
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
      // The crawler stops reading at MAX_BODY_BYTES and records bodyTruncated
      // on the result. Without carrying it here, a count measured on the first
      // 5MB of a 14.4MB document is published as though it were complete —
      // iana.org's /domains/idn-tables reported 3,830 nameless anchors against
      // an actual 11,113. The cap is correct; the silence about it was not.
      ...(source && source.bodyTruncated ? { sourceTruncated: true } : {}),
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

  for (const result of internalResults) {
    const isHtml = result.contentType?.includes("text/html");
    // The headers arrived but none of the body did (a read timeout or reset):
    // the page's content is unknown, so no rule may judge it. A partially read
    // body is still evaluated, and its findings carry sourceTruncated.
    const bodyUnread = Boolean(result.bodyError) && !(result.decodedSize > 0);
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
    } else if (isRateLimited(result)) {
      // The site throttled the crawl and was still refusing after the
      // retries: the page was not checked, which is what crawl-failure says.
      // Reporting it as a 4xx called working pages broken (M2).
      add("crawl-failure", result, {
        detail: "Rate limited: the site answered HTTP 429 Too Many Requests after the crawler's retries, so this page was not checked",
      });
    } else if (result.status >= 400 && result.status < 500) {
      add("page-4xx", result);
    }
    if (bodyUnread && result.status >= 200 && result.status < 300) {
      add("crawl-failure", result, {
        detail: `The server answered HTTP ${result.status}, but the page body could not be read (${result.bodyError}), so its content was not checked`,
      });
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
      !isRateLimited(result) &&
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
      // A plain HTTP redirect is exactly what sitemap-redirect reports, so it
      // is not reported a second time here. sitemap-incorrect-url keeps the
      // redirects whose destination is broken or unsuitable: that is extra
      // information, and "replace it with the destination" would be wrong.
      const plainRedirect =
        isRedirectStatus(result.status) && !terminalFailure && !terminalSuitability;
      if (
        !plainRedirect &&
        // A rate-limited entry was not checked (see isRateLimited), so it is
        // not known to be incorrect; its crawl-failure already reports it.
        !isRateLimited(result) &&
        (result.status !== 200 ||
          result.indexability !== "Indexable" ||
          (result.canonical && result.canonical !== result.url) ||
          declarativeRedirect)
      ) {
        add("sitemap-incorrect-url", result, {
          detail:
            terminalFailure
              ? `${terminalFailure.relationshipDetail}. Path: ${terminalFailure.pathEvidence}`
              : terminalSuitability
                ? `${terminalSuitability.relationshipDetail}. Path: ${terminalSuitability.pathEvidence}`
              : result.statusText === "Blocked by robots.txt"
                ? "Disallowed by robots.txt, so it was not fetched"
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
      if (isRedirectStatus(result.status)) {
        add("sitemap-redirect", result, {
          targetUrl: result.redirectUrl || "",
          detectedValue: result.redirectUrl
            ? `${result.status} -> ${result.redirectUrl}`
            : `HTTP ${result.status}`,
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
      !bodyUnread &&
      result.status === 200 &&
      result.indexability === "Indexable" &&
      !redirectDestination(result) &&
      // A sitemap lists canonical URLs only. A page whose canonical names
      // another URL (a filter or tracking-parameter variant, /home -> /)
      // belongs out of it; `indexability` alone ignores the canonical (M3).
      (!result.canonical || result.canonical === result.url) &&
      // Later pages of a listing are reached through the listing's own
      // pagination links and are normally left out of a sitemap, so their
      // absence is not something to fix. On brushandfloss.com they were 37 of
      // the 38 errors this rule raised. Their duplicated titles and
      // descriptions are still reported by the duplicate rules.
      !isPaginatedListingPage(result)
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
        detectedValue: trace.hops,
      });
    }

    // status < 300 (not < 400): a 3xx response is a redirect stub with no real
    // page content — evaluating it for title/meta/word-count/etc. produces
    // false positives on every redirected URL (confirmed via calibration:
    // position2.com's sitemap has ~55 double-slash URLs that 308-redirect,
    // and every one of them was being flagged for "missing meta description"
    // and "low word count" despite having no actual page to evaluate).
    if (isHtml && result.status >= 200 && result.status < 300 && !bodyUnread) {
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
      // Previously only caught by crawler.js's live quickIssues() pass, which
      // never gets re-run once findings replace it after the crawl completes
      // — a page missing its <title> silently lost this finding entirely at
      // that point, rather than just losing its category/description.
      if (!result.title) {
        // Same URL-slug fallback suggestH1 uses — there's no existing title
        // to trim, so this is a starting point to hand-refine, not a
        // finished recommendation.
        const slugTitle = humanizeUrlSlug(result.url);
        add("title-missing", result, {
          // Empty and absent look the same in `title` but not in view-source:
          // a CMS template with an unbound title field renders <title></title>,
          // and without saying so the finding reads as wrong to whoever checks.
          detectedValue: result.titleCount > 0 ? "<title> present but empty" : "No <title> element",
          ...(slugTitle ? { recommendedValue: slugTitle } : {}),
        });
      }
      if (result.titleCount > 1) {
        add("title-multiple", result, { detectedValue: result.titleCount });
      }
      if (result.titleLength > 60) {
        add("title-long", result, {
          detail: `${result.titleLength} characters`,
          detectedValue: result.title,
          recommendedValue: suggestTitle(result.title, brandSegments),
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
      // A deliberately noindexed page won't appear in search results, so its
      // content quality — H1, word count, text-to-HTML ratio, Open Graph tags
      // — has no SEO consequence. Flagging it here is just noise on top of
      // the noindex finding itself, which is the one thing worth reviewing.
      if (!hasNoindex && !result.h1Count) {
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
        // open-graph-description-missing only runs once the required
        // properties are complete, so a page missing both had its missing
        // og:description reported nowhere. Named here as recommended, and kept
        // out of evidenceKey so root-cause grouping still keys on the required set.
        const recommendedMissing = result.openGraphDescriptionMissing ? ["og:description"] : [];
        add("open-graph-incomplete", result, {
          detail:
            `Missing required properties: ${openGraphMissing.join(", ")}` +
            (recommendedMissing.length
              ? `. Also missing: ${recommendedMissing.map((property) => `${property} (recommended)`).join(", ")}`
              : ""),
          detectedValue: [
            ...openGraphMissing.map((property) => `• ${property}`),
            ...recommendedMissing.map((property) => `• ${property} (recommended)`),
          ].join("\n"),
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
      for (const schemaError of result.schemaErrors || []) {
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
    } else if ((target.status >= 400 || !target.status) && !isRateLimited(target)) {
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
      if ((target.status >= 400 || !target.status) && !isRateLimited(target)) {
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
      // A target the crawler declined to fetch out of its own robots.txt
      // compliance is not a dead link — the crawler chose not to check it,
      // the same way it wouldn't fetch a genuinely disallowed page. That's
      // already its own, milder finding (`robots-blocked`/`blocked-resource`,
      // fired once per target above, not once per linking page); folding it
      // into "broken" here mislabeled a polite no-fetch as a defect and, on a
      // shared nav/footer link, inflated one blocked URL into a finding on
      // every single page that links to it.
      const targetRobotsBlocked = target?.statusText === "Blocked by robots.txt";
      // Same for a target the site rate-limited: not checked, so not broken.
      if (
        target &&
        !targetRobotsBlocked &&
        !isRateLimited(target) &&
        (target.status >= 400 || !target.status)
      ) {
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
      const statuses = incomingFollow.get(edge.targetUrl) || { nofollowFrom: new Set(), dofollowFrom: new Set() };
      (isNofollow ? statuses.nofollowFrom : statuses.dofollowFrom).add(edge.sourceUrl);
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
      } else if (target && !isRateLimited(target) && (target.status >= 400 || !target.status)) {
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
    if (statuses.nofollowFrom.size && statuses.dofollowFrom.size) {
      const nofollowExample = [...statuses.nofollowFrom][0];
      const dofollowExample = [...statuses.dofollowFrom][0];
      add("mixed-incoming-follow", resultByUrl.get(url) || { url }, {
        detectedValue: `${statuses.nofollowFrom.size} nofollow link(s) (e.g. from ${nofollowExample}), ${statuses.dofollowFrom.size} dofollow link(s) (e.g. from ${dofollowExample})`,
      });
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
    notEvaluated: notEvaluatedRules({ results, crawlTruncated }),
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
  notEvaluatedRules,
  catalog,
  evidenceSignature,
  groupFixType,
  buildRootCauseGroups,
  categorizePage,
};
