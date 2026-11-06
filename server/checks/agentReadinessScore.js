// ── Agent Readiness: the overall score ──────────────────────────────────────
//
// One pure scoring function, shared by the audit route (fresh runs, both the
// plain and the streaming path, the quick-win projection, the PDF) and by the
// project read paths that re-score stored runs (modules/projects/moduleEvidence.js).
// No I/O and no heavy requires, so the dashboard can load it without pulling
// in the browser and LLM clients the route needs. The client mirrors it once,
// in client/src/lib/agentReadinessReport.js.
//
// The score measures future readiness, but most of the standards it checks
// for cannot be adopted yet, so pooling every check's points left most sites
// near the bottom for things nobody can do. The checks sit in three tiers:
//
//   core    letting AI tools reach and find the content — AI bot rules,
//           robots.txt, sitemap. Worth 70 of the 100.
//   now     the rest of what any site can ship today — Link headers and every
//           on-page check that ran. Worth 20.
//   future  emerging standards: barely adopted (markdown negotiation, content
//           signals), only relevant to sites with public APIs (API catalog,
//           OAuth discovery and protected resource), or still drafts (MCP
//           server cards, agent skills, WebMCP, Web Bot Auth). Worth 10.
//
// score = round(70 × coreEarned ÷ coreMax + 20 × nowEarned ÷ nowMax
//               + 10 × futureEarned ÷ futureMax)
//
// Within a tier a check keeps its relative weight (WEIGHTS for the site-level
// checks, maxScore/score for on-page checks, which can earn partial credit).
// A tier with nothing to score (max 0) hands its points to the other tiers in
// proportion to their points, so the score is always out of 100. Moving a
// check between tiers is a one-line change to READINESS_TIERS.

// Relative weights of the site-level (HTTP) checks. webbotauth = 0: it is
// informational, so it counts in neither earned nor max.
const WEIGHTS = {
  robots: 7, sitemap: 7, linkheaders: 6,
  markdown: 10,
  aibots: 11, contentsignals: 9, webbotauth: 0,
  apicatalog: 8, oauth: 8, oauthresource: 8, mcp: 10, agentskills: 10, webmcp: 6,
};

// Ordered. A check not listed in any tier is treated as 'now'.
const READINESS_TIERS = [
  { key: 'core', label: 'Core access', points: 70, ids: ['aibots', 'robots', 'sitemap'] },
  {
    key: 'now', label: 'Other checks you can do today', points: 20,
    ids: [
      'linkheaders',
      // On-page checks (scored only when they ran)
      'captcha', 'cookie_banner', 'js_rendering', 'form_labels', 'input_type',
      'autocomplete', 'vague_buttons', 'interactive_divs', 'schema_action', 'schema_search',
    ],
  },
  {
    key: 'future', label: 'Emerging standards', points: 10,
    ids: [
      'markdown', 'contentsignals', 'apicatalog', 'oauth', 'oauthresource',
      'mcp', 'agentskills', 'webmcp', 'webbotauth',
    ],
  },
];
const TIER_POINTS = Object.fromEntries(READINESS_TIERS.map((t) => [t.key, t.points]));
const CORE_POINTS = TIER_POINTS.core;
const NOW_POINTS = TIER_POINTS.now;
const FUTURE_POINTS = TIER_POINTS.future;

// The methodology sentence stored with every Agent Readiness score. Versioned:
// the dashboard compares two runs only when their basis matches
// (overview.js moduleChanges), so this method change reads as "scoring method
// updated", not as the site improving. moduleRunners and streamingAudit use it.
const SCORE_BASIS = 'the agent readiness audit v5 (70 points for core access — AI bot rules, '
  + 'robots.txt, sitemap — 20 for the other checks any site can do today — Link headers, '
  + 'on-page checks — 10 for emerging standards; '
  + 'allow-all robots counts for AI bots, WebMCP detected in the page, no SearchAction)';
const SCORE_BASIS_MARK = 'agent readiness audit v5';

/** 'core', 'now' or 'future'. A check not listed is treated as 'now'. */
function tierOf(id) {
  const t = READINESS_TIERS.find((tier) => tier.ids.includes(id));
  return t ? t.key : 'now';
}
// Older name, kept for callers.
const groupOf = tierOf;

// HTTP checks come either as the route's raw map { id: { status } } or as the
// report's list [{ id, status }].
function asList(checks) {
  if (Array.isArray(checks)) return checks;
  if (checks && typeof checks === 'object') {
    return Object.entries(checks).map(([id, c]) => ({ ...(c || {}), id }));
  }
  return [];
}

/**
 * The overall score and how it was made.
 *
 * A check that was not scored — absent from the report, or marked `olderRule`
 * (scored with an older rule and not re-checked) — is left out of both earned
 * and max. Advisory checks keep today's treatment: webbotauth weighs 0, and a
 * flag-only on-page check that did not pass earns 0 of its points.
 *
 * @returns {{ score: number|null, exact: number|null, core: { earned, max, points },
 *            now: { earned, max, points }, future: { earned, max, points } }}
 */
function readinessScore({ httpChecks, onPageChecks } = {}) {
  const tiers = Object.fromEntries(READINESS_TIERS.map((t) => [t.key, { earned: 0, max: 0 }]));

  for (const c of asList(httpChecks)) {
    if (!c || !c.id || c.olderRule) continue;
    const weight = WEIGHTS[c.id];
    if (!Number.isFinite(weight)) continue;
    const g = tiers[tierOf(c.id)];
    g.max += weight;
    if (c.status === 'pass') g.earned += weight;
  }

  for (const c of Array.isArray(onPageChecks) ? onPageChecks : []) {
    if (!c || c.olderRule) continue;
    const max = Number(c.maxScore);
    if (!Number.isFinite(max) || max <= 0) continue;
    const earned = Math.max(0, Math.min(max, Number(c.score) || 0));
    const g = tiers[tierOf(c.id)];
    g.max += max;
    g.earned += earned;
  }

  // A tier with nothing to score hands its points to the others, in
  // proportion to their own points.
  const activePoints = READINESS_TIERS.reduce((sum, t) => sum + (tiers[t.key].max > 0 ? t.points : 0), 0);
  const out = {};
  let exact = 0;
  for (const t of READINESS_TIERS) {
    const g = tiers[t.key];
    const points = g.max > 0 ? (t.points * 100) / activePoints : 0;
    out[t.key] = { ...g, points };
    if (g.max > 0) exact += points * (g.earned / g.max);
  }
  if (!activePoints) return { score: null, exact: null, ...out };
  return { score: Math.round(exact), exact, ...out };
}

/**
 * How many score points one check is worth: its points ÷ its tier's max ×
 * the tier's share of 100. `breakdown` is a readinessScore() result.
 */
function scorePointsFor(breakdown, id, points) {
  const g = breakdown?.[tierOf(id)];
  if (!g || !g.max || !Number.isFinite(points)) return 0;
  return (points / g.max) * g.points;
}

/**
 * "Fixing this week's quick wins would take you to N/100".
 *
 * The report re-scored with every failing quick-effort check passed (an
 * on-page check at its full points). Only status 'fail' counts: an 'info'
 * check is an advisory flag, not a failure, and fixing it promises nothing.
 * `httpChecks` must carry `effort` (the report's list does; the route passes
 * describeHttpChecks()).
 */
function quickWinProjection({ httpChecks, onPageChecks } = {}) {
  let count = 0;
  const http = asList(httpChecks).map((c) => {
    if (c?.status !== 'fail' || c.effort !== 'quick') return c;
    count += 1;
    return { ...c, status: 'pass' };
  });
  const onPage = (Array.isArray(onPageChecks) ? onPageChecks : []).map((c) => {
    if (c?.status !== 'fail' || c.effort !== 'quick') return c;
    count += 1;
    return { ...c, score: c.maxScore || 0 };
  });
  const { score } = readinessScore({ httpChecks: http, onPageChecks: onPage });
  return { quickWinScore: score === null ? null : Math.min(100, score), quickWinCount: count };
}

// How future-ready the site is for AI agents. The protocols this measures are
// new, so few sites score high yet; the names say where a site stands on that
// path, not whether search engines can see it ("Not Indexed" was printed on
// sites Google indexes fine). The steps sit on the platform's bands (80 / 60).
function levelFromScore(score) {
  if (score >= 90) return 'Level 4 — Agent native';
  if (score >= 80) return 'Level 3 — Future-ready';
  if (score >= 60) return 'Level 2 — Getting ready';
  if (score >= 40) return 'Level 1 — Early steps';
  return 'Level 0 — Not started';
}

/** The `site.scoring` block a report carries: the three tiers' numbers. */
function scoringSummary(breakdown) {
  return {
    coreEarned: breakdown.core.earned, coreMax: breakdown.core.max, corePoints: breakdown.core.points,
    nowEarned: breakdown.now.earned, nowMax: breakdown.now.max, nowPoints: breakdown.now.points,
    futureEarned: breakdown.future.earned, futureMax: breakdown.future.max, futurePoints: breakdown.future.points,
  };
}

/**
 * A stored report (the route's result object: { site, checks, onPageChecks })
 * scored with the current formula, on read.
 *
 * Reports stored before the split kept a score under the old formula; their
 * checks are all here, so the score, level and quick-win projection are worked
 * out again rather than re-running a paid audit. Returned unchanged (the same
 * object) when it lacks the check detail, was refused, or has no score.
 */
function rescoreStoredReport(report) {
  if (!report || typeof report !== 'object' || !report.site || typeof report.site !== 'object') return report;
  if (report.blocked || report.site.blocked) return report;
  if (report.site.score === null || report.site.score === undefined) return report;
  if (!Array.isArray(report.checks) || !report.checks.length) return report;
  // A report the page has already marked "not re-checked" (the client's
  // reconcileStoredReport) carries the score the server gave it on read;
  // re-scoring it here would print a different number from the screen.
  if (report.checks.some((c) => c?.olderRule)) return report;
  const breakdown = readinessScore({ httpChecks: report.checks, onPageChecks: report.onPageChecks });
  if (breakdown.score === null) return report;
  return {
    ...report,
    site: {
      ...report.site,
      score: breakdown.score,
      level: levelFromScore(breakdown.score),
      scoring: scoringSummary(breakdown),
      ...quickWinProjection({ httpChecks: report.checks, onPageChecks: report.onPageChecks }),
    },
  };
}

module.exports = {
  WEIGHTS,
  READINESS_TIERS,
  TIER_POINTS,
  CORE_POINTS,
  NOW_POINTS,
  FUTURE_POINTS,
  SCORE_BASIS,
  SCORE_BASIS_MARK,
  tierOf,
  groupOf,
  readinessScore,
  scorePointsFor,
  quickWinProjection,
  levelFromScore,
  scoringSummary,
  rescoreStoredReport,
};
