"use strict";

// ── Robots directives (meta robots / X-Robots-Tag), parsed into tokens ───────
//
// Shared by the crawler, which decides a page's indexability as it fetches it,
// and the analyzer, which reports noindex / nofollow. Both used to test the raw
// string with `includes("noindex") || includes("none")`, so:
//
//   * `max-image-preview:none` — an indexable page asking for small image
//     previews — was reported as noindex AND nofollow;
//   * `X-Robots-Tag: otherbot: noindex` — addressed to some other crawler — was
//     reported as noindex, although the bot-aware parser below already existed
//     and was simply overruled by the substring test.
//
// The audit answers "how will Google treat this page?", so a directive applies
// when it is addressed to every crawler, to CrawlScope itself, or to Googlebot.

// Directives whose value follows a colon. Without this list "max-snippet:-1"
// reads exactly like a "<user agent>: <directives>" prefix.
const VALUED_DIRECTIVES = new Set([
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
  "unavailable_after",
]);

// The product token of a User-Agent: its first "/"- or space-delimited word,
// lowercased — what a robots group or an X-Robots-Tag prefix is matched against.
function robotsProductToken(userAgent = "") {
  const token = String(userAgent).trim().split(/[\s/]+/)[0] || "";
  return token.toLowerCase();
}

function agentTokens(agents) {
  const list = Array.isArray(agents) ? agents : [agents];
  return new Set(list.map(robotsProductToken).filter(Boolean));
}

// One comma-separated entry, possibly carrying several space- or semicolon-
// separated directives ("noindex nofollow" is common, if non-standard).
function directivesInEntry(entry) {
  const colon = entry.indexOf(":");
  if (colon > 0) {
    const name = entry.slice(0, colon).trim().toLowerCase();
    if (VALUED_DIRECTIVES.has(name)) {
      // The value keeps its case for unavailable_after's date; the key does not.
      return [{ token: `${name}:${entry.slice(colon + 1).trim().toLowerCase()}`, name, value: entry.slice(colon + 1).trim() }];
    }
  }
  return entry
    .split(/[\s;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((token) => ({ token, name: token, value: "" }));
}

/**
 * The set of robots directives in `value` that apply to any of `agents`.
 *
 * `value` is a meta robots content attribute, an X-Robots-Tag header, or several
 * of them joined with ", " (which is also how undici joins repeated headers).
 * A "<agent>: ..." prefix addresses the directives after it, up to the next
 * such prefix, to that agent alone.
 *
 * @param {string} value
 * @param {string|string[]} agents user-agent strings or product tokens
 * @returns {Set<string>} lowercased directive tokens, e.g. "noindex",
 *   "max-image-preview:none"; "noindex" is added for a past unavailable_after
 */
function robotsDirectivesFor(value, agents = []) {
  const tokens = agentTokens(agents);
  const directives = new Set();
  let addressedToUs = true;

  for (const part of String(value || "").split(",")) {
    let entry = part.trim();
    if (!entry) continue;

    const colon = entry.indexOf(":");
    const prefix = colon > 0 ? entry.slice(0, colon).trim().toLowerCase() : "";
    const isAgentPrefix = colon > 0 && prefix && !/\s/.test(prefix) && !VALUED_DIRECTIVES.has(prefix);
    if (isAgentPrefix) {
      addressedToUs = tokens.has(prefix);
      entry = entry.slice(colon + 1).trim();
      if (!entry) continue;
    }
    if (!addressedToUs) continue;

    for (const directive of directivesInEntry(entry)) {
      directives.add(directive.token);
      // unavailable_after in the past is a noindex as of that moment.
      if (directive.name === "unavailable_after") {
        const when = Date.parse(directive.value);
        if (Number.isFinite(when) && when <= Date.now()) directives.add("noindex");
      }
    }
  }
  return directives;
}

const isNoindex = (directives) => directives.has("noindex") || directives.has("none");
const isNofollow = (directives) => directives.has("nofollow") || directives.has("none");

// The agents the audit evaluates for: the crawler's own product token plus
// Googlebot, whose treatment of the page is what an SEO audit reports.
function auditAgents(userAgent) {
  return [robotsProductToken(userAgent) || "crawlscope", "googlebot"];
}

/**
 * The directives recorded on a crawl result. Results produced by this version
 * of the crawler carry `robotsDirectives`; anything older (or hand-built) only
 * has the raw `robots` string, which is tokenised the same way.
 */
function resultRobotsDirectives(result, agents = ["crawlscope", "googlebot"]) {
  if (Array.isArray(result?.robotsDirectives)) return new Set(result.robotsDirectives);
  return robotsDirectivesFor(result?.robots || "", agents);
}

module.exports = {
  robotsDirectivesFor,
  robotsProductToken,
  auditAgents,
  resultRobotsDirectives,
  isNoindex,
  isNofollow,
};
