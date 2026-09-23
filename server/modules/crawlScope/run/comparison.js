// ── This crawl against the last one ─────────────────────────────────────────
// Findings are matched across crawls by issue key (analyzer.js issueKeyOf:
// rule, page, target), never by id, which also hashes the detail and so moves
// whenever a count in it does.

const { issueKeyOf } = require("../analyzer");

const keyOf = (finding) =>
  finding.issueKey || issueKeyOf(finding.ruleId, finding.url || "", finding.targetUrl || "");

/**
 * New, fixed and persisting issues, overall and per rule. An issue is one
 * issue key: a rule that fires twice for one page and target counts once.
 *
 * @param {object[]} current  this crawl's findings
 * @param {object[]} previous the previous crawl's findings (ruleId, url, targetUrl, [issueKey])
 */
function compareRuns(current, previous) {
  const keyed = (list) => {
    const byKey = new Map();
    for (const finding of list) {
      const key = keyOf(finding);
      if (!byKey.has(key)) byKey.set(key, finding.ruleId);
    }
    return byKey;
  };
  const now = keyed(current);
  const before = keyed(previous);
  const totals = { new: 0, fixed: 0, persisting: 0 };
  const byRule = {};
  const bump = (ruleId, kind) => {
    byRule[ruleId] = byRule[ruleId] || { new: 0, fixed: 0, persisting: 0 };
    byRule[ruleId][kind] += 1;
    totals[kind] += 1;
  };
  for (const [key, ruleId] of now) bump(ruleId, before.has(key) ? "persisting" : "new");
  for (const [key, ruleId] of before) if (!now.has(key)) bump(ruleId, "fixed");
  return { totals, byRule };
}

// Only a reviewer's "False positive" carries over: it says the rule is wrong
// about this page, which stays true until the page changes. "Resolved" does not
// — an issue that is back is not resolved — and "Confirmed issue" is left for a
// reviewer to confirm again against the new crawl.
const CARRIED_STATUS = "False positive";

/**
 * The previous crawl's false-positive reviews, re-addressed to the findings of
 * this crawl that are the same issues.
 *
 * @param {object[]} current  this crawl's findings (id, ruleId, url, targetUrl, issueKey)
 * @param {object[]} previous the previous crawl's findings (id, ...)
 * @param {object[]} reviews  the previous crawl's crawl_finding_reviews rows
 * @returns {{ findingId, ruleId, reviewStatus, reviewerNotes, reviewedBy }[]}
 */
function carriedReviews(current, previous, reviews) {
  const keyByPreviousId = new Map(previous.map((finding) => [finding.id, keyOf(finding)]));
  const dismissed = new Map();
  for (const review of reviews) {
    if (review.review_status !== CARRIED_STATUS) continue;
    const key = keyByPreviousId.get(review.finding_id);
    if (key && !dismissed.has(key)) dismissed.set(key, review);
  }
  if (!dismissed.size) return [];
  const carried = [];
  const seen = new Set();
  for (const finding of current) {
    const review = dismissed.get(keyOf(finding));
    if (!review || seen.has(finding.id)) continue;
    seen.add(finding.id);
    const notes = String(review.reviewer_notes || "").trim();
    carried.push({
      findingId: finding.id,
      ruleId: finding.ruleId,
      reviewStatus: CARRIED_STATUS,
      reviewerNotes: `${notes ? `${notes} ` : ""}(Carried over from the previous crawl.)`,
      reviewedBy: review.reviewed_by || null,
    });
  }
  return carried;
}

module.exports = { compareRuns, carriedReviews, CARRIED_STATUS };
