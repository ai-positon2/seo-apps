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

// Whole-string match of a glob whose only wildcard is `*`. Patterns used to
// compile to a RegExp with `.*` per star, and "*a*a*a*a*a*a*a*a*b" then
// backtracked for tens of seconds on one URL, stalling every crawl sharing the
// process. This walk is O(text × glob): on a mismatch it only ever moves back
// to the most recent `*`. Shared with the robots.txt matcher in crawler.js.
function globMatches(text, glob) {
  let t = 0;
  let g = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (g < glob.length && glob[g] === "*") {
      star = g;
      g += 1;
      resume = t;
    } else if (g < glob.length && glob[g] === text[t]) {
      g += 1;
      t += 1;
    } else if (star !== -1) {
      g = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === "*") g += 1;
  return g === glob.length;
}

// Compiled to a glob with the implied wildcards written out: an unanchored
// pattern may start anywhere, and one without `$` may end anywhere.
function compilePattern(pattern) {
  const anchored = pattern.startsWith("/");
  const ends = pattern.endsWith("$");
  const body = (ends ? pattern.slice(0, -1) : pattern).replace(/\*+/g, "*");
  const glob = `${anchored ? "" : "*"}${body}${ends ? "" : "*"}`;
  return { test: (text) => globMatches(text, glob) };
}

// The last path segment of a page URL rather than a folder: "/en/home.html"
// stands for the folder "/en/", or scoping a crawl to it kept only itself.
const PAGE_FILE = /\.(?:s?html?|php\d?|aspx?|jsp|cfm|cgi|pl)$/i;

// The folder a start URL stands for: its path, as a folder.
function folderOf(url) {
  const path = new URL(url).pathname;
  if (path.endsWith("/")) return path;
  if (PAGE_FILE.test(path)) return path.slice(0, path.lastIndexOf("/") + 1);
  return `${path}/`;
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

module.exports = { createScopeRules, folderOf, compilePattern, globMatches };
