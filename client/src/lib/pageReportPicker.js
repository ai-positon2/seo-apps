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
  // The future-readiness levels (from 2026-11), on the 80 / 60 bands.
  'future-ready': 'pos',
  'getting ready': 'warn',
  'early steps': 'neg',
  'not started': 'neg',
  // SEO & GEO bands on the shared 80 / 60 scale.
  'needs attention': 'warn',
  'at risk': 'neg',
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

// ── When a report cannot be shown ────────────────────────────────────────────
//
// The bar used to have one word for every way a report could be missing:
// 'none', which the pages read as "nothing stored, show the input form". A page
// whose audit failed, or whose stored report would not load, therefore left the
// PREVIOUS page's report on screen under the new page's name (Agent Readiness)
// or swapped it for a blank new-audit form (SEO & GEO). These say what happened
// instead, in words a reader can act on.

/**
 * A failure in plain words.
 *
 * `kind` is whose failure it is: 'page' — the audited site refused or broke
 * (the reason stored on a failed page or run) — or 'fetch' — our own request
 * for the stored report failed. The same "HTTP 503" means different things in
 * each, and only one of them is the client's site to fix.
 */
export function plainFailure(message, { kind = 'page', status = null } = {}) {
  const text = String(message || '');
  if (kind === 'fetch') {
    if (status === 404 || /not found/i.test(text)) return 'This page’s stored report is no longer available.';
    if (status === 401 || status === 403) return 'You no longer have access to this client’s reports.';
    return 'We couldn’t open this report just now.';
  }
  if (/\b(401|403|429)\b|forbidden|too many requests|rate.?limit|refused|blocked|captcha|challenge|bot protection/i.test(text)) {
    return 'The site blocked our check of this page. Allow our crawler (or wait for its rate limit to reset), then try again.';
  }
  if (/timed? ?out|timeout|ETIMEDOUT|took too long/i.test(text)) return 'The site took too long to respond.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|could not resolve|getaddrinfo/i.test(text)) {
    return 'The page’s address could not be reached.';
  }
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable/i.test(text)) {
    return 'The site returned a server error when we checked this page.';
  }
  if (/\b404\b|not found/i.test(text)) return 'The page was not found on the site (404).';
  return 'This page couldn’t be audited.';
}

/** True for a run that ended without a report — failed, or stopped. */
export function runDidNotFinish(run) {
  return Boolean(run) && ['failed', 'cancelled'].includes(run.status);
}

/**
 * Which page the bar should select.
 *
 * The address (?page=<pageRunId>) wins when it names a page of this run, so a
 * reload or a shared link opens the page it was on; then the current choice;
 * then the first page audited.
 */
export function pickSelection(pages, { wanted = null, current = null } = {}) {
  const list = pages || [];
  if (wanted && list.some((p) => p.pageRunId === wanted)) return wanted;
  if (current && list.some((p) => p.pageRunId === current)) return current;
  return defaultPage(list)?.pageRunId || null;
}

/**
 * What to show for a page still in its audit, or null for one that is done.
 * Picking such a page used to leave the previous page's report on screen.
 */
export function pendingPage(page) {
  if (!page || !['queued', 'running'].includes(page.status)) return null;
  return {
    url: page.url || null,
    status: page.status,
    reason: page.status === 'queued'
      ? 'This page is queued for its audit. Its report appears here when it finishes.'
      : 'This page is being audited now. Its report appears here when it finishes.',
  };
}
