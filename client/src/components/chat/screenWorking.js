// ── Each report's working, for the report assistant ─────────────────────────
//
// What a report hands the assistant so it can rebuild a score from its parts:
// the per-item inputs the score was computed from, picked out of the data the
// report already has loaded. Each report passes one of these to its Legend as
// `working={() => xWorking(...)}`; it runs only when a question is asked.
//
// The server prices each item with the scorer's own constants
// (server/modules/reportChat/working.js); this side only collects inputs.
// Tech Audit is the exception: that score is computed here, in
// crawlHelpers.healthMetrics, so its per-rule cost (metrics.ruleLoss) comes
// computed.

const MAX_RULES = 200;
const BAND_KEY = { Errors: 'error', Warnings: 'warning', Notices: 'notice' };
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Tech Audit: EVERY rule the report lists, with the points it cost — zero
 * included. A rule found only on URLs the score leaves out (redirects, error
 * pages, files, site-wide settings) is listed on screen but costs nothing, and
 * leaving it out of the working made the assistant price it itself and
 * conclude the score must be computed some other way.
 */
export function techWorking({ metrics, breakdown = [], groups = [] }) {
  if (!metrics) return null;
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const lossById = new Map((metrics.ruleLoss || []).map((r) => [`${r.severity}|${r.ruleId}`, r]));
  const listedPages = (g) => (g ? new Set(g.urls || []).size || g.pages || 0 : null);

  const rules = [
    ...(metrics.ruleLoss || []).map((r) => ({ ...r, listed: listedPages(groupById.get(r.ruleId)) })),
    // Listed on screen, never on a scored page.
    ...groups
      .filter((g) => g.severity in { error: 1, warning: 1, notice: 1 } && !lossById.has(`${g.severity}|${g.id}`))
      .map((g) => ({ ruleId: g.id, severity: g.severity, pages: 0, cappedPages: 0, points: 0, listed: listedPages(g) })),
  ];
  return {
    score: metrics.health,
    pagesScored: metrics.htmlCount,
    // healthScoreBreakdown rows carry the bar's rounded points; the exact loss
    // each bar rounds is metrics.bandLoss.
    bands: breakdown.map((b) => {
      const severity = BAND_KEY[b.label] || null;
      return { severity, exactPoints: severity ? n(metrics.bandLoss?.[severity]) : null, barShows: b.points, pages: b.pages };
    }),
    rules: rules.slice(0, MAX_RULES).map((r) => ({
      rule: groupById.get(r.ruleId)?.label || r.ruleId,
      ruleId: r.ruleId,
      severity: r.severity,
      pagesAffected: r.pages,
      urlsListedInReport: r.listed,
      pagesCapped: r.cappedPages,
      occurrences: groupById.get(r.ruleId)?.count ?? null,
      points: r.points,
    })),
    rulesNotListed: Math.max(0, rules.length - MAX_RULES),
  };
}

/** SEO & GEO: the page's areas and every check with its status. */
export function seoGeoWorking({ findings, scores, breakdown = [] }) {
  if (!findings) return null;
  return {
    url: findings.meta?.url || null,
    pageIntent: findings.meta?.page_intent || null,
    overall: n(scores?.overall),
    composite: n(scores?.composite),
    cap: scores?.cap || null,
    sides: {
      seo: scores?.seo ? { score: scores.seo.score, composite: scores.seo.composite, cap: scores.seo.cap } : null,
      geo: scores?.geo ? { score: scores.geo.score, composite: scores.geo.composite, cap: scores.geo.cap } : null,
    },
    areas: breakdown,
    checks: (findings.checks || []).map((c) => ({
      id: c.id, category: c.category, name: c.name, status: c.status, severity: c.severity,
    })),
  };
}

/** Agent Readiness: every check with its status and points. */
export function agentWorking(result) {
  if (!result) return null;
  return {
    site: result.site,
    cats: result.cats,
    httpChecks: (result.checks || []).map((c) => ({ id: c.id, label: c.label, cat: c.cat, status: c.status })),
    onPageChecks: (result.onPageChecks || []).map((c) => ({
      id: c.id, label: c.label, cat: c.cat, status: c.status, maxScore: c.maxScore, score: c.score,
    })),
  };
}

const metric = (m) => (m && typeof m === 'object' ? (m.value ?? null) : m ?? null);
// A rate as the report prints it ("32%"), never its raw ratio: 0.32 sent bare
// reads as 0.32% as easily as 32%. Counts and scores stay numbers.
const shown = (m) => (m && typeof m === 'object' ? (m.display ?? m.value ?? null) : m ?? null);

/** AI Visibility (API-based): the score's four readings and what fed them. */
export function aivisLiteWorking(report) {
  if (!report) return null;
  return {
    score: metric(report.headline?.score),
    answersMeasured: report.meta?.answersMeasured ?? null,
    competitorsTracked: Math.max(0, (report.brands || []).length - 1),
    scoreBreakdown: report.headline?.scoreBreakdown || [],
    brands: (report.brands || []).map((b) => ({
      name: b.name, you: Boolean(b.isClient), answersMeasured: b.answers, answersNamingIt: b.named,
      namedRate: shown(b.namedRate), shareOfMentions: shown(b.shareOfMentions), averageMentionPosition: metric(b.mentionRank),
    })),
    byEngine: (report.byEngine || []).map((e) => ({
      engine: e.engine, answers: e.answers, measured: e.measured, named: e.named,
      namedRate: shown(e.namedRate), groundedRate: shown(e.groundedRate),
    })),
    byQuestion: (report.byQuestion || []).map((q) => ({
      question: q.text || q.prompt || null, intent: q.intent || null, state: q.state,
      answers: q.answers ?? null, measured: q.measured ?? null, named: q.named ?? null, namedRate: shown(q.namedRate),
    })),
    sentiment: report.sentiment ? {
      analysed: report.sentiment.analysed, positive: report.sentiment.positive,
      neutral: report.sentiment.neutral, negative: report.sentiment.negative, score: metric(report.sentiment.score),
    } : null,
    gaps: (report.gaps?.rows || []).map((g) => ({
      domain: g.domain, sourceType: g.sourceType, answers: g.answers, namedCompetitor: g.namedCompetitor,
      namedYou: g.namedYou, answersUsingItShare: metric(g.retrievedPct), gapScore: metric(g.gapScore),
    })),
  };
}

/** AI Visibility (scraped): the headline figures and the share-of-voice rows. */
export function aivisWorking({ kpis, meta, shareOfVoice }) {
  if (!kpis) return null;
  return {
    visibility: shown(kpis.visibility),
    sentiment: { value: metric(kpis.sentiment), note: kpis.sentiment?.note || null },
    averagePosition: metric(kpis.position),
    shareOfVoice: shown(kpis.shareOfVoice),
    engines: (kpis.engines || []).map((e) => ({ engine: e.engine, measured: e.measured, visibility: shown(e) })),
    answersCaptured: meta?.captures ?? null,
    promptsMeasured: meta?.promptsMeasured ?? null,
    period: meta?.period ?? null,
    shareOfVoiceRows: (shareOfVoice?.rows || []).map((r) => ({
      brand: r.name, you: Boolean(r.isClient), mentions: metric(r.mentions), share: shown(r),
    })),
    totalMentions: metric(shareOfVoice?.totalMentions),
    mentionsOfUntrackedBrands: metric(shareOfVoice?.otherMentions),
  };
}

/** Competitor Research: every tracked domain's figures. */
export function compWorking({ snapshot }) {
  if (!snapshot) return null;
  return {
    trafficScore: snapshot.trafficScore || null,
    domains: (snapshot.domains || []).map((d) => ({
      domain: d.domain,
      isClient: Boolean(d.isClient),
      traffic: n(Number(d.domainRank?.organicTraffic)),
      keywords: n(Number(d.domainRank?.organicKeywords)),
      authority: n(Number(d.authorityScore)),
      backlinks: n(Number(d.backlinks?.totalBacklinks)),
    })),
  };
}

/** Hub and Spoke: every cluster with the inputs its health is built from. */
export function hubWorking({ clusters = [], pageById }) {
  const page = (id) => (pageById && id ? pageById.get(id) : null);
  return {
    clusters: clusters.map((c) => {
      const memberIds = [...(c.hubPageId ? [c.hubPageId] : []), ...(c.spokeIds || [])];
      const members = memberIds.map(page).filter(Boolean);
      const depths = members.map((p) => p.depth).filter((d) => typeof d === 'number' && Number.isFinite(d));
      const flags = members.flatMap((p) => p.flags || []);
      return {
        name: c.name,
        health: c.health,
        status: c.isGap ? 'Hub missing' : c.ambiguous ? 'Hub unclear' : c.hubSuggestion ? 'Existing page suggested as hub' : 'Hub found',
        isGap: Boolean(c.isGap),
        ambiguous: Boolean(c.ambiguous),
        hubConfidence: c.hubConfidence ?? null,
        hubUrl: page(c.hubPageId)?.url || c.referenceIndexUrl || null,
        // A suggested existing hub is the cluster's hub page; this says why.
        hubSuggestionReason: c.hubSuggestion?.reason || null,
        missingHubSuggestion: c.isGap ? (c.gapSuggestion?.title || null) : null,
        members: memberIds.length,
        meanDepth: depths.length ? depths.reduce((s, d) => s + d, 0) / depths.length : null,
        orphaned: flags.filter((f) => f === 'orphan').length,
        thin: flags.filter((f) => f === 'thin-or-stale').length,
        buried: flags.filter((f) => f === 'buried').length,
      };
    }),
  };
}
