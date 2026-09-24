"use strict";

// ── URL identity: one spelling per page ─────────────────────────────────────
//
// The crawler fetches every URL in a normalized form (normalizeUrl) and, for
// the crawled host, under the crawl's own scheme — an http:// link on an https
// site is fetched as https (crawler.js#_canonicalScheme). Evidence, though, is
// recorded as it was WRITTEN: a link edge keeps its http:// href, a redirect
// keeps its raw Location, a sitemap entry its <loc>, a canonical its href.
//
// Looking results up by the written form therefore missed whenever the two
// differed — a broken page behind an http:// link was never reported broken, a
// redirect whose Location carried a tracking parameter ended its chain early,
// and an http:// sitemap entry was reported "missing from every sitemap".
// createUrlIdentity() gives the analyzer the exact key the crawler fetched
// under, without rewriting the evidence itself.

// ── URL canonicalization ────────────────────────────────────────────────────
// Every one of these produces a DIFFERENT string for the SAME page, and each
// distinct string costs one slot of maxUrls and shows up as duplicate content.
// A page linked with six campaign tags is one page, not six.
const TRACKING_PARAMS = new Set([
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ttclid",
  "twclid",
  "yclid",
  "_ga",
  "_gl",
  "ref",
  "ref_src",
  "referrer",
  "mkt_tok",
  "hsa_acc",
  "hsa_cam",
  "hsa_grp",
  "hsa_ad",
  "hsa_src",
  "hsa_tgt",
  "hsa_kw",
  "hsa_mt",
  "hsa_net",
  "hsa_ver",
  "vero_id",
  "vero_conv",
  "s_kwcid",
  "ef_id",
  "trk",
  "trkCampaign",
]);

// Session identifiers rotate per visitor, so leaving them in makes the SAME page
// look like an unbounded family of new pages and never converges.
const SESSION_PARAMS = new Set([
  "jsessionid",
  "phpsessid",
  "aspsessionid",
  "asp.net_sessionid",
  "sessionid",
  "session_id",
  "sid",
  "zenid",
  "oscsid",
  "cfid",
  "cftoken",
  "_sid",
]);

// Path-parameter form of the same thing: /page;jsessionid=ABC123
const SESSION_PATH_PARAM = /;(?:jsessionid|phpsessid|sid|cfid|cftoken)=[^;/?#]*/gi;

function isDroppableParam(name) {
  const lower = name.toLowerCase();
  return (
    lower.startsWith("utm_") ||
    lower.startsWith("pk_") ||
    lower.startsWith("mtm_") ||
    TRACKING_PARAMS.has(lower) ||
    SESSION_PARAMS.has(lower)
  );
}

function decodeParamName(pair) {
  const raw = pair.split("=")[0].replace(/\+/g, " ");
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed percent-escape is still a parameter name; use it verbatim
    // rather than losing the whole URL to a decode error.
    return raw;
  }
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
    if (SESSION_PATH_PARAM.test(parsed.pathname)) {
      // Regexes with /g carry lastIndex across calls; reset before reuse.
      SESSION_PATH_PARAM.lastIndex = 0;
      parsed.pathname = parsed.pathname.replace(SESSION_PATH_PARAM, "");
    }
    SESSION_PATH_PARAM.lastIndex = 0;

    // Pairs are filtered and sorted as RAW strings rather than round-tripped
    // through URLSearchParams, because URLSearchParams re-serializes in
    // form-encoded form (a space becomes "+", not "%20") and would change the
    // bytes actually sent to the origin.
    const rawQuery = parsed.search.slice(1);
    if (rawQuery) {
      const kept = rawQuery
        .split("&")
        .filter(Boolean)
        .filter((pair) => !isDroppableParam(decodeParamName(pair)))
        .sort();
      parsed.search = kept.length ? `?${kept.join("&")}` : "";
    } else {
      // WHATWG keeps a bare "?" in href, so "/page" and "/page?" would other-
      // wise dedupe as two separate pages.
      parsed.search = "";
    }
    return parsed.href;
  } catch {
    return null;
  }
}

// Query parameters a crawl was told do not make a different page (the crawl
// option removeParameters: sort orders, filters, view modes), removed the way
// tracking parameters are. Names compare without case; "*" removes them all.
function parameterRemover(names = []) {
  const list = (names || []).map((name) => String(name).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return (url) => url;
  const all = list.includes("*");
  const removed = new Set(list);
  return (url) => {
    if (!url || !url.includes("?")) return url;
    try {
      const parsed = new URL(url);
      const kept = all
        ? []
        : parsed.search.slice(1).split("&").filter(Boolean)
          .filter((pair) => !removed.has(decodeParamName(pair).toLowerCase()));
      parsed.search = kept.length ? `?${kept.join("&")}` : "";
      return parsed.href;
    } catch {
      return url;
    }
  };
}

/**
 * The key a URL was (or would have been) crawled under, for a crawl anchored at
 * `startUrl`: normalized, and on the crawled host moved to the crawl's scheme
 * and stripped of the parameters the crawl was told to remove. With no start
 * URL (list mode, which fetches URLs exactly as given) only the normalization
 * applies — the same rule crawler.js follows.
 *
 * @param {string} startUrl the crawl's final (post-redirect) start URL
 * @param {{ removeParameters?: string[], includeSubdomains?: boolean }} [options]
 *   the crawl's own options: parameters are removed from the URLs the crawl
 *   treats as internal (crawler.js#_inScope), and only those
 * @returns {(url: string) => string} "" for anything that is not an http(s) URL
 */
function createUrlIdentity(startUrl = "", { removeParameters = [], includeSubdomains = false } = {}) {
  const removeFrom = parameterRemover(removeParameters);
  let scheme = "";
  let hostname = "";
  try {
    if (startUrl) {
      const parsed = new URL(startUrl);
      scheme = parsed.protocol;
      hostname = parsed.hostname.toLowerCase();
    }
  } catch {
    scheme = "";
  }
  const root = hostname.replace(/^www\./, "");
  const internal = (host) =>
    host === hostname || (includeSubdomains && (host === root || host.endsWith(`.${root}`)));
  return (url) => {
    const normalized = normalizeUrl(url || "");
    if (!normalized) return "";
    if (!scheme) return normalized;
    const parsed = new URL(normalized);
    if (!internal(parsed.hostname)) return normalized;
    // The scheme moves only on the crawled host itself, as crawler.js#_canonicalScheme.
    if (parsed.hostname === hostname) parsed.protocol = scheme;
    return removeFrom(parsed.href);
  };
}

module.exports = { normalizeUrl, createUrlIdentity, parameterRemover };
