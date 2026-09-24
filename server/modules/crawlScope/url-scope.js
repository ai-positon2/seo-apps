"use strict";

// ── What part of a site a crawl covers ──────────────────────────────────────
//
// A crawl used to be the whole host or nothing. These are the rules that make
// it one section, the way Semrush's and Ahrefs' crawl settings do:
//
//   include patterns  a URL must match one of them;
//   exclude patterns  a URL matching any of them is left out;
//   folder            only URLs whose path starts with the start URL's path.
//
// Patterns follow robots.txt, the syntax SEO people already write: a pattern
// starting with "/" matches from the start of the path, anything else matches
// anywhere in the path and query, "*" matches any run of characters and a
// final "$" anchors the end. They are matched against the path and query both
// as crawled (percent-encoded) and decoded, so "/blog/café/*" means what it
// says.
//
// The start page is never left out (crawler.js exempts the seed and its
// redirects): it is where the links into the section are found.

const escapeRegex = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

function compilePattern(pattern) {
  const anchored = pattern.startsWith("/");
  const ends = pattern.endsWith("$");
  const body = ends ? pattern.slice(0, -1) : pattern;
  const source = body.split("*").map(escapeRegex).join(".*");
  return new RegExp(`${anchored ? "^" : ""}${source}${ends ? "$" : ""}`);
}

// The folder a start URL stands for: its path, as a folder.
function folderOf(url) {
  const path = new URL(url).pathname;
  return path.endsWith("/") ? path : `${path}/`;
}

/**
 * @param {{ includePatterns?: string[], excludePatterns?: string[], folder?: string }} rules
 * @returns {{ active: boolean, allows: (url: string) => boolean, folder: string }}
 */
function createScopeRules({ includePatterns = [], excludePatterns = [], folder = "" } = {}) {
  const include = includePatterns.map(compilePattern);
  const exclude = excludePatterns.map(compilePattern);
  const active = include.length > 0 || exclude.length > 0 || Boolean(folder);
  const allows = (url) => {
    if (!active) return true;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const raw = `${parsed.pathname}${parsed.search}`;
    let decoded = raw;
    try {
      decoded = decodeURI(raw);
    } catch {
      // A malformed escape: match the crawled form only.
    }
    const matches = (regex) => regex.test(raw) || (decoded !== raw && regex.test(decoded));
    if (folder && !parsed.pathname.startsWith(folder) && `${parsed.pathname}/` !== folder) return false;
    if (include.length && !include.some(matches)) return false;
    return !exclude.some(matches);
  };
  return { active, allows, folder };
}

module.exports = { createScopeRules, folderOf, compilePattern };
