"use strict";

// ── Which problems to fix first ──────────────────────────────────────────────
//
// One ordering for the report, the Excel workbook and the email, computed once
// when a crawl is analysed and stored with the run. They used to disagree —
// severity then page count, priority then occurrences, severity then count —
// and none of them asked WHICH pages: a broken link in the global navigation
// ranked like one on a deep tag page, and a missing title on the homepage like
// one on a paginated archive.
//
// The order, and it is the same for every surface:
//   1. severity (errors, then warnings, then notices);
//   2. site-wide problems (a site setting, or a template on most pages) before
//      problems on particular pages;
//   3. how much the affected pages matter, summed over them (pageWeight);
//   4. how many times the rule fired; then the rule id, so ties never reorder.
//
// Each rule also gets one sentence saying what put it there.

const SEVERITY_RANK = { error: 0, warning: 1, notice: 2, info: 3 };
// "The site's most-linked pages": the top tenth of pages by followed incoming
// links, at least one and at most twenty.
const KEY_PAGE_SHARE = 0.1;
const KEY_PAGE_MAX = 20;

const isAuditedPage = (result) =>
  result &&
  result.scope !== "External" &&
  !result.isAsset &&
  !result.crawlRefused &&
  String(result.contentType || "").includes("html");

/**
 * How much one page matters to the site, from what the crawl measured about it:
 * how many pages link to it (log-scaled, so the navigation's targets lead
 * without drowning everything else), how few clicks it is from the start page,
 * whether it can be indexed at all, and whether it is the start page.
 */
function pageWeight(result, startUrl = "") {
  const inlinks = Math.max(0, Number(result?.followInlinks ?? result?.inlinks) || 0);
  const depth = Number.isFinite(result?.clickDepth) ? result.clickDepth : null;
  const linked = 1 + Math.log2(1 + inlinks);
  const reach = depth === null ? 0.5 : 1 / (1 + 0.5 * depth);
  const indexable = result?.indexability === "Indexable" ? 1 : 0.5;
  const home = result?.url === startUrl ? 2 : 1;
  return linked * reach * indexable * home;
}

function reasonFor({ siteWide, scopes, pages, onHome, keyPages, htmlPages }) {
  if (scopes.has("site")) return "Site-wide: one setting affects every page.";
  if (siteWide) return `On most pages (${pages} of ${htmlPages}): one template or setting causes it.`;
  const count = `On ${pages} page${pages === 1 ? "" : "s"}`;
  if (pages === 1 && onHome) return `${count}, the homepage.`;
  const parts = [];
  if (onHome) parts.push("the homepage");
  if (keyPages) parts.push(`${keyPages} of the site's most-linked pages`);
  return parts.length ? `${count}, including ${parts.join(" and ")}.` : `${count}.`;
}

/**
 * @param {object[]} findings the analyzer's findings (ruleId, severity, scope, url)
 * @param {object[]} results  crawl results with followInlinks and clickDepth
 * @param {{ startUrl?: string }} [options]
 * @returns {{ ruleId, rank, severity, siteWide, importance, pages, count, reason }[]}
 */
function ruleOrder(findings, results, { startUrl = "" } = {}) {
  const pages = (results || []).filter(isAuditedPage);
  const weightOf = new Map(pages.map((result) => [result.url, pageWeight(result, startUrl)]));
  const others = pages.filter((result) => result.url !== startUrl);
  const keyCount = Math.min(KEY_PAGE_MAX, Math.max(1, Math.ceil(others.length * KEY_PAGE_SHARE)));
  const keyPages = new Set(
    others
      .filter((result) => (Number(result.followInlinks ?? result.inlinks) || 0) > 0)
      .sort((a, b) =>
        (Number(b.followInlinks ?? b.inlinks) || 0) - (Number(a.followInlinks ?? a.inlinks) || 0) ||
        String(a.url).localeCompare(String(b.url)))
      .slice(0, keyCount)
      .map((result) => result.url),
  );

  const byRule = new Map();
  for (const finding of findings || []) {
    const entry = byRule.get(finding.ruleId) || {
      ruleId: finding.ruleId,
      severity: finding.severity,
      scopes: new Set(),
      urls: new Set(),
      count: 0,
    };
    entry.count += 1;
    entry.scopes.add(finding.scope || "page");
    if (finding.url) entry.urls.add(finding.url);
    byRule.set(finding.ruleId, entry);
  }

  const rows = [...byRule.values()].map((entry) => {
    const siteWide = entry.scopes.has("site") || entry.scopes.has("template");
    let importance = 0;
    let keys = 0;
    for (const url of entry.urls) {
      // A URL that is not an audited page (a file, robots.txt) still counts,
      // at the weight of a page nothing is known about.
      importance += weightOf.get(url) ?? 0.5;
      if (keyPages.has(url)) keys += 1;
    }
    return {
      ruleId: entry.ruleId,
      severity: entry.severity,
      siteWide,
      importance: Math.round(importance * 100) / 100,
      pages: entry.urls.size,
      count: entry.count,
      reason: reasonFor({
        siteWide,
        scopes: entry.scopes,
        pages: entry.urls.size,
        onHome: Boolean(startUrl) && entry.urls.has(startUrl),
        keyPages: keys,
        htmlPages: pages.length,
      }),
    };
  });

  rows.sort(compareRows);
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function compareRows(a, b) {
  return (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
    Number(b.siteWide) - Number(a.siteWide) ||
    b.importance - a.importance ||
    b.count - a.count ||
    String(a.ruleId).localeCompare(String(b.ruleId));
}

/**
 * A stored ordering with some rules' rows replaced — for findings added to a
 * run after it was analysed (Core Web Vitals from PageSpeed Insights) — and
 * re-ranked by the same rules, so they take their place instead of trailing.
 *
 * @param {object[]|null} order  the run's stored ordering
 * @param {string[]} ruleIds     the rules being replaced
 * @param {object[]} rows        ruleOrder() rows for those rules' new findings
 */
function mergeRuleOrder(order, ruleIds, rows) {
  const replaced = new Set(ruleIds);
  const kept = (order || []).filter((row) => !replaced.has(row.ruleId));
  return [...kept, ...rows.filter((row) => replaced.has(row.ruleId))]
    .sort(compareRows)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

// A rule's place in an ordering, for sorting things keyed by rule; rules the
// ordering does not know sort after every rule it does.
function rankLookup(order) {
  const ranks = new Map((order || []).map((row) => [row.ruleId, row.rank]));
  return (ruleId) => ranks.get(ruleId) ?? Number.MAX_SAFE_INTEGER;
}

module.exports = { ruleOrder, mergeRuleOrder, pageWeight, rankLookup };
