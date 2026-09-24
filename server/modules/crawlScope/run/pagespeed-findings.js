"use strict";

// ── Core Web Vitals findings from PageSpeed Insights ────────────────────────
//
// PageSpeed Insights results were stored on each checked page (data.pagespeed)
// and shown as numbers, but never became findings, so a page failing Core Web
// Vitals for real users was an issue nowhere: not in the list, the score or
// the export.
//
// PSI arrives after a crawl is analysed — sampled in the background once it
// completes, or run on one page from the report — so these findings are added
// to the stored run when the data does (refreshPageSpeedFindings), replacing
// whatever an earlier PSI result produced.
//
// Real-user data (the Chrome UX Report) decides, mobile first, since that is
// what Google measures. Data for the page itself gives a finding on the page;
// data only for the whole origin (the page has too little traffic of its own)
// gives one site-wide finding per metric. With no real-user data at all, the
// Lighthouse lab run decides, and the finding says it was one simulated visit.

const { findingFor } = require("../analyzer");
const repo = require("../db/repo");
const { ruleOrder, mergeRuleOrder } = require("../rule-order");
const { aggregateFindings, severityCounts } = require("./finding-rollup");
const { carriedReviews } = require("./comparison");

const CWV_RULES = ["cwv-lcp-poor", "cwv-inp-poor", "cwv-cls-poor"];
const METRICS = [
  { key: "lcp", ruleId: "cwv-lcp-poor", name: "Largest Contentful Paint (LCP)" },
  { key: "inp", ruleId: "cwv-inp-poor", name: "Interaction to Next Paint (INP)" },
  { key: "cls", ruleId: "cwv-cls-poor", name: "Cumulative Layout Shift (CLS)" },
];
// Google's "poor" thresholds, for the lab fallback. INP has no lab measure.
const LAB_POOR = { lcp: 4_000, cls: 0.25 };

function fieldFor(pagespeed) {
  const mobile = pagespeed?.mobile?.field;
  if (mobile?.metrics) return { ...mobile, device: "mobile" };
  const desktop = pagespeed?.desktop?.field;
  if (desktop?.metrics) return { ...desktop, device: "desktop" };
  return null;
}

function labValue(pagespeed, key) {
  const lab = pagespeed?.mobile;
  if (!lab) return null;
  if (key === "lcp") return typeof lab.lcpMs === "number" ? lab.lcpMs : null;
  if (key === "cls") {
    const value = Number.parseFloat(lab.cls);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/**
 * @param {{ url: string, pagespeed: object }[]} rows pages with a PSI result
 * @returns {object[]} findings, in analyzer.js's shape
 */
function pageSpeedFindings(rows) {
  const findings = [];
  const siteWide = new Set();
  for (const { url, pagespeed } of rows) {
    if (!pagespeed || pagespeed.dataUnavailable) continue;
    const field = fieldFor(pagespeed);
    if (field) {
      for (const metric of METRICS) {
        if (field.metrics[metric.key] !== "SLOW") continue;
        if (field.scope === "origin") {
          // Origin data describes every page on the scheme and host, so the
          // finding sits on the site's root, once however many pages had it.
          const siteUrl = new URL("/", url).href;
          const key = `${metric.ruleId}|${siteUrl}`;
          if (siteWide.has(key)) continue;
          siteWide.add(key);
          findings.push(findingFor(metric.ruleId, { url: siteUrl }, {
            scope: "site",
            detail:
              `Real users across the whole site (Chrome UX Report, ${field.device}) have a poor ${metric.name}. ` +
              "The pages checked have too little traffic of their own for page-level data.",
            detectedValue: `Poor (real users, ${field.device}, whole site)`,
          }));
        } else {
          findings.push(findingFor(metric.ruleId, { url }, {
            detail: `Real users on this page (Chrome UX Report, ${field.device}) have a poor ${metric.name}.`,
            detectedValue: `Poor (real users, ${field.device})`,
          }));
        }
      }
      continue;
    }
    for (const metric of METRICS) {
      const value = labValue(pagespeed, metric.key);
      if (value === null || !(metric.key in LAB_POOR) || value <= LAB_POOR[metric.key]) continue;
      const shown = metric.key === "lcp" ? `${(value / 1000).toFixed(1)} s` : value.toFixed(2);
      const limit = metric.key === "lcp" ? "4 s" : "0.25";
      // The measurement is in detectedValue, not the detail: the detail is part
      // of the finding's id, which should not move each time the page is
      // re-checked and the number wobbles.
      findings.push(findingFor(metric.ruleId, { url }, {
        detail:
          `One simulated mobile visit (Lighthouse) measured ${metric.name} in Google's "poor" range, above ${limit}. ` +
          "There is no real-user data for this page yet, so this is an estimate.",
        detectedValue: `${shown} (lab, mobile)`,
      }));
    }
  }
  return findings.filter(Boolean);
}

const FINISHED = new Set(["completed", "stopped"]);
const plural = (count, word) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;
// What PageSpeed Insights can check: a live internal HTML page
// (run/manager.js pickPageSpeedSample picks from the same set).
const checkable = (page) =>
  !page.isAsset && page.scope !== "External" && page.status === 200 &&
  String(page.contentType || "").includes("text/html");

/**
 * Recompute the run's Core Web Vitals findings from every PageSpeed Insights
 * result stored on its pages, and replace the previous set: the instances, the
 * per-rule rollup, and the run summary's counts, order and coverage, in one
 * transaction with the run row locked.
 *
 * Only for a finished run. A crawl still running writes its whole summary when
 * it completes, and calls this then for any page checked in the meantime.
 *
 * @returns {Promise<{ findings: object[], checked: number } | null>} null when
 *   there was nothing to do
 */
async function refreshPageSpeedFindings(db, runId) {
  return db.tx(async (t) => {
    const run = await repo.lockRun(t, runId);
    if (!run || !FINISHED.has(run.status)) return null;
    const rows = await repo.listRunPageSpeed(t, run.id);
    if (!rows.length) return null;

    const findings = pageSpeedFindings(rows);
    const removed = await repo.replaceRuleFindings(
      t, run.id, run.owner, CWV_RULES, findings, aggregateFindings(findings, run.owner, run.id),
    );

    const summary = { ...(run.summary || {}) };
    const added = severityCounts(findings);
    const counts = { ...(summary.counts || {}) };
    for (const severity of Object.keys(added)) counts[severity] = (counts[severity] || 0) + added[severity];
    let removedTotal = 0;
    for (const row of removed) {
      counts[row.severity] = Math.max(0, (counts[row.severity] || 0) - row.count);
      removedTotal += row.count;
    }
    summary.counts = counts;
    summary.findingsCount = Math.max(0, (Number(summary.findingsCount) || 0) - removedTotal + findings.length);

    const pages = await repo.listRunPageFacts(t, run.id);
    // A run analysed before the shared ordering existed has none, and gets
    // none here: an ordering of three rules would put them above every other.
    if (Array.isArray(summary.ruleOrder)) {
      const startUrl = pages.find((page) => page.clickDepth === 0)?.url || run.url;
      summary.ruleOrder = mergeRuleOrder(summary.ruleOrder, CWV_RULES, ruleOrder(findings, pages, { startUrl }));
    }

    // Say how much of the site these checks saw: every PageSpeed-checkable page
    // or only some, or none when every check came back without data.
    const checked = rows.filter((row) => row.pagespeed && !row.pagespeed.dataUnavailable).length;
    const eligible = pages.filter(checkable).length;
    const coverage = summary.coverage || { notEvaluated: [], partial: [], pagesNotAudited: [] };
    const others = (entries) => (entries || []).filter((entry) => !CWV_RULES.includes(entry.ruleId));
    const entries = (reason) => CWV_RULES.map((ruleId) => ({ ruleId, reason }));
    summary.coverage = {
      ...coverage,
      notEvaluated: [
        ...others(coverage.notEvaluated),
        ...(checked ? [] : entries(`PageSpeed Insights returned no data for the ${plural(rows.length, "page")} it was asked about.`)),
      ],
      partial: [
        ...others(coverage.partial),
        ...(checked && checked < eligible
          ? entries(`Checked on the ${plural(checked, "page")} with a PageSpeed Insights result, of ${eligible.toLocaleString("en-US")} crawled.`)
          : []),
      ],
    };
    await repo.updateRun(t, run.id, { summary });

    // A reviewer's "False positive" on the last crawl carries over, as for
    // every other finding (run/comparison.js). These findings arrive after the
    // crawl's own comparison ran, so they are carried here.
    if (findings.length && !Array.isArray(run.options?.urls)) {
      const previous = await repo.previousComparableRun(t, run);
      if (previous) {
        // One after the other: both are on the transaction's one connection.
        const previousFindings = await repo.listRunIssueRows(t, previous.id);
        const previousReviews = await repo.listFindingReviews(t, previous.id);
        await repo.insertCarriedReviews(
          t, run.id, run.owner,
          carriedReviews(findings, previousFindings.filter((f) => CWV_RULES.includes(f.ruleId)), previousReviews),
        );
      }
    }
    return { findings, checked };
  });
}

module.exports = { pageSpeedFindings, refreshPageSpeedFindings, CWV_RULES };
