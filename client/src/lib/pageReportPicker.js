// ── Rules the per-page report picker runs on ─────────────────────────────────
//
// SEO & GEO, On-Page and Agent Readiness store a report per crawled page, so
// their report views need a page switcher. Three of its decisions are claims
// about the data rather than styling, and they live here so they can be tested:
//
//   1. which page is shown first
//   2. what order the others are offered in
//   3. whether a score gets a colour, and which
//
// Plain ES module code, no JSX: the server's test suite loads it directly, the
// same way it loads moduleReportRoute.js.

/**
 * Which band each module puts a score in — using the module's OWN vocabulary.
 *
 * SEO & GEO bands its scores (server/checks/seoGeoChecks.js, SCORE_BANDS) and
 * agent readiness assigns a level (agentReadinessAudit.js, levelFromScore), so
 * "is 62 bad?" is a question those modules have already answered. Colouring by a
 * threshold picked in the UI instead would be inventing a judgement the audit
 * never made — the same thing PRD §6.2 rules out for scores themselves.
 */
export const BAND_TONE = {
  // SEO & GEO
  excellent: 'pos',
  good: 'pos',
  'needs work': 'warn',
  poor: 'neg',
  critical: 'neg',
  // Agent readiness — stored as "Level 3 — Agent Ready", matched on the name.
  'agent native': 'pos',
  'agent ready': 'pos',
  'ai aware': 'warn',
  'basic web presence': 'neg',
  'not indexed': 'neg',
};

/**
 * The tone for a module's band, or null when there is nothing to go on.
 *
 * Null is the important return: On-Page has no rubric and therefore no band, and
 * a band this map does not recognise means a module changed its vocabulary. Both
 * render untinted. A guess would read as a verdict.
 */
export function bandTone(band) {
  if (!band) return null;
  const text = String(band).toLowerCase();
  const key = Object.keys(BAND_TONE).find((k) => text.includes(k));
  return key ? BAND_TONE[key] : null;
}

/** True when a page has a score to show — 0 is a score, null is not. */
export function isScored(page) {
  return page ? page.score !== null && page.score !== undefined : false;
}

/**
 * Worst first: the order somebody fixing things reads in.
 *
 * Unscored and failed pages sort LAST. They are not good, they are unmeasured,
 * and floating them to the top on a `Number(null) === 0` would bury the pages
 * that actually scored badly under pages nobody managed to audit.
 */
export function orderWorstFirst(pages) {
  return [...(pages || [])].sort((a, b) => {
    const sa = isScored(a) ? Number(a.score) : Infinity;
    const sb = isScored(b) ? Number(b.score) : Infinity;
    if (sa !== sb) return sa - sb;
    return (a.ordinal ?? 0) - (b.ordinal ?? 0);
  });
}

/**
 * The page to open first: the first one audited.
 *
 * Pages are audited shallowest-first, so this is the homepage. Opening on the
 * worst-scoring page instead would be more useful and more disorienting — you
 * would land somewhere you did not choose, several levels deep, with no sense of
 * where you are. The picker is sorted worst-first; the landing page is home.
 */
export function defaultPage(pages) {
  if (!pages?.length) return null;
  return [...pages].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))[0];
}

/** The part of a URL that tells one page of a site from another. */
export function pathOf(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') return '/ (home)';
    return u.pathname + (u.search || '');
  } catch {
    // Not parseable — show what we were given rather than nothing.
    return String(url);
  }
}
