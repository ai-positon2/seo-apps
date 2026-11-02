// ── What the assistant is allowed to know ───────────────────────────────────
//
// The chat answers "strictly from this project's data", so this file decides
// what that data is. Everything comes from the readers the dashboard already
// uses, through the caller's own project access:
//
//   project     overview.buildOverview: every module's score, headline, evidence
//   priorities  insights.buildInsights: the ranked fix list (the backlog)
//   summary     insights.executive: the verdict, standing and confidence
//   module      moduleDetail.buildModuleDetail for the report on screen
//   screen      the explainer copy the client resolved for that report — the
//               same calc/why/good text its info icons print, worked examples
//               included, so "how is this calculated" quotes the icon exactly
//
// Every source is optional. One that fails is named in `missing` rather than
// failing the answer: a CMO asking about the Tech Audit should still get an
// answer when the competitor reader is down.
//
// Size is capped. Module details carry every finding and page, which is far more
// than a question needs, so arrays are cut to their first few items and long
// strings are trimmed, with the cut said out loud ("… 312 more").

const overview = require('../projects/overview');
const insights = require('../projects/insights');
const moduleDetail = require('../projects/moduleDetail');
const projectStore = require('../projects/store');
const { SCREENS, SCREEN_MODULE, TOOL_PATH, isScreen, moduleReportPath } = require('./screens');
const { methodologyFor } = require('./methodology');
const { buildWorking } = require('./working');

const MAX_ARRAY_ITEMS = 12;
const MAX_STRING = 400;
const MAX_DEPTH = 6;
const MAX_TOP_ACTIONS = 20;
const MAX_SECTION_CHARS = 24000;
// The working is the one section a deep question needs in full — every rule
// and its points — so it gets a bigger budget than the summaries.
const MAX_WORKING_CHARS = 70000;

// Keys that are plumbing, not evidence. Dropped so the budget goes on figures.
const DROP_KEYS = new Set(['capabilities', 'generatedAt', 'createdBy', 'cost', 'pendingPhase', 'dependsOn']);

/**
 * A JSON-safe copy small enough to put in a prompt: arrays cut to their first
 * MAX_ARRAY_ITEMS, strings to MAX_STRING, depth to MAX_DEPTH.
 */
function compact(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : '[…]';
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY_ITEMS).map((v) => compact(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) head.push(`… ${value.length - MAX_ARRAY_ITEMS} more`);
    return head;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROP_KEYS.has(k) || v === undefined || typeof v === 'function') continue;
    out[k] = compact(v, depth + 1);
  }
  return out;
}

/** JSON for the prompt, cut to a character budget. */
function section(value, max = MAX_SECTION_CHARS) {
  const text = JSON.stringify(compact(value));
  return text.length > max ? `${text.slice(0, max)}… [cut for length]` : text;
}

function moduleSummary(m) {
  return {
    key: m.key,
    label: m.label,
    status: m.status,
    scored: Boolean(m.scored),
    score: m.score ?? null,
    headline: m.headline || null,
    detail: m.detail || null,
    metric: m.metric || null,
    note: m.note || null,
    evidence: m.evidence || null,
    lastRunAt: m.lastRunAt || m.completedAt || null,
    reportPath: moduleReportPath(m),
  };
}

// The report on screen can show a different headline from its dashboard card:
// one page of a multi-page SEO & GEO audit, or a report recomputed from its
// checks while the card keeps the stored figure. Said once, up front, so "our
// score" means the one the reader is looking at.
function scoreOnScreen(screen, working, card) {
  if (!screen || !working) return null;
  const shown = typeof working.overall === 'number' ? working.overall
    : typeof working.score === 'number' ? working.score : null;
  if (shown === null) return null;
  const cardScore = typeof card?.score === 'number' ? card.score : null;
  const lines = [`This ${SCREENS[screen]} report shows ${shown}. "Our score" / "the score" on this screen means ${shown}.`];
  if (cardScore !== null && cardScore !== shown) {
    // SEO & GEO and Agent Readiness cards average every audited page or scan.
    lines.push(screen === 'seogeo' || screen === 'agent'
      ? `The dashboard card shows ${cardScore}: the average over all audited ${screen === 'seogeo' ? 'pages' : 'scans'}, while ${shown} is the ${screen === 'seogeo' ? 'page' : 'scan'} open here. Give both when the reader asks about "the" score, saying which is which.`
      : `The dashboard card for this module shows ${cardScore}, a stored figure that differs from this report's ${shown}. Quote ${shown}; mention ${cardScore} only if the reader asks about the dashboard or the difference.`);
  }
  return lines.join('\n');
}

// On the Tech Audit screen a fix-list item can be an error that costs the
// health score nothing (found only on unscored URLs). Without its points beside
// it, "errors first" reads as "hurts the score most".
function techPointsByRule(screen, working) {
  if (screen !== 'tech' || !Array.isArray(working?.rules)) return null;
  return new Map(working.rules.filter((r) => r.rule).map((r) => [String(r.rule).toLowerCase(), r.points]));
}

function withScorePoints(summary, action, points) {
  if (!points || !(action.moduleKey === 'technical' || action.module === 'technical' || action.moduleLabel === 'Tech Audit')) return summary;
  const p = points.get(String(action.title || '').toLowerCase());
  return p === undefined ? summary : { ...summary, pointsLostOnTechScore: p };
}

function actionSummary(a) {
  return {
    title: a.title,
    module: a.moduleLabel,
    severity: a.severity,
    priority: a.priority,
    pagesAffected: a.pageCount,
    scope: a.scope,
    effort: a.effortHint || null,
    basis: a.basisLine || null,
    recommendation: a.recommendation || null,
    recommendedValue: a.recommendedValue || null,
    examplePages: (a.pages || []).slice(0, 3),
  };
}

// ── Screen copy from the client ─────────────────────────────────────────────
//
// The one input the server does not own. It is the client's rendering of our
// own explainer text, so the worst a tampered copy can do is mislead the person
// who tampered with it — still, it is size-limited, reduced to plain strings,
// and labelled in the prompt as reference data rather than instructions.

const COPY_FIELDS = ['t', 's', 'why', 'good', 'calc', 'src', 'next'];
const MAX_COPY_ENTRIES = 40;
const MAX_COPY_STRING = 1500;

const str = (v) => (typeof v === 'string' ? v.slice(0, MAX_COPY_STRING) : null);

function sanitizeScreenCopy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const explainers = (Array.isArray(raw.explainers) ? raw.explainers : [])
    .slice(0, MAX_COPY_ENTRIES)
    .map((e) => {
      if (!e || typeof e !== 'object') return null;
      const out = { key: str(e.key) };
      for (const f of COPY_FIELDS) {
        const v = f === 'next' && e.next && typeof e.next === 'object' ? e.next.label : e[f];
        const s = str(v);
        if (s) out[f] = s;
      }
      return out.t ? out : null;
    })
    .filter(Boolean);
  const legend = (Array.isArray(raw.legend) ? raw.legend : [])
    .slice(0, MAX_COPY_ENTRIES)
    .map((r) => (r && typeof r === 'object' && str(r.term)
      ? { term: str(r.term), line: str(r.line), ex: str(r.ex) }
      : null))
    .filter(Boolean);
  if (!explainers.length && !legend.length) return null;
  return { explainers, legend };
}

// ── Links the assistant may offer ───────────────────────────────────────────
//
// Built here, from routes the app already has, and handed both to the model
// (as the only links it may write) and to the client (as the only links it
// will render). A link the model invents is shown as plain text.

const EXTRA_LINKS = [
  { label: 'Market Potential', path: '/market-potential' },
  { label: 'Keyword Research', path: '/keyword-research' },
  { label: 'Projects', path: '/projects' },
];

function allowedLinks(modules = []) {
  const seen = new Set();
  const links = [];
  const add = (label, path) => {
    if (!path || typeof path !== 'string' || !path.startsWith('/') || seen.has(path)) return;
    seen.add(path);
    links.push({ label, path });
  };
  add('Project overview', '/');
  for (const m of modules) {
    add(`${m.label} report`, moduleReportPath(m));
    add(m.label, m.toolPath);
  }
  for (const [screen, path] of Object.entries(TOOL_PATH)) add(SCREENS[screen], path);
  for (const l of EXTRA_LINKS) add(l.label, l.path);
  return links;
}

// ── Assembly ────────────────────────────────────────────────────────────────

const DEFAULT_DEPS = {
  buildOverview: (access) => overview.buildOverview({ access }),
  buildInsights: (access) => insights.buildInsights({ access }),
  buildExecutiveSummary: (input) => insights.executive.buildExecutiveSummary(input),
  buildModuleDetail: async (access, moduleKey) => moduleDetail.buildModuleDetail({
    access,
    moduleKey,
    domains: await projectStore.listDomains(access.project.id),
  }),
};

async function settle(name, promise, missing) {
  try {
    return await promise;
  } catch (e) {
    console.warn(`[reportChat] ${name} unavailable:`, e.message);
    missing.push(name);
    return null;
  }
}

/**
 * @param {object} input
 * @param {object} input.access      projectAccess.requireProject(…, 'view') context
 * @param {string?} input.screen     a key of SCREENS, or null on any other page
 * @param {object?} input.screenCopy the client's resolved explainers and legend
 * @param {object} [input.deps]      the readers, swappable in tests
 * @returns {Promise<{ screen, screenName, links, missing, sections }>}
 */
async function buildChatContext({ access, screen = null, screenCopy = null, deps = DEFAULT_DEPS }) {
  const known = isScreen(screen) ? screen : null;
  const moduleKey = known ? SCREEN_MODULE[known] || null : null;
  const missing = [];

  const [overviewData, built, detail] = await Promise.all([
    settle('project overview', deps.buildOverview(access), missing),
    settle('fix list', deps.buildInsights(access), missing),
    moduleKey ? settle(`${SCREENS[known]} detail`, deps.buildModuleDetail(access, moduleKey), missing) : null,
  ]);

  let summary = null;
  if (overviewData && built) {
    try {
      summary = deps.buildExecutiveSummary({ overview: overviewData, backlog: built.backlog });
    } catch (e) {
      console.warn('[reportChat] executive summary unavailable:', e.message);
      missing.push('executive summary');
    }
  }

  const modules = overviewData?.modules || [];
  const actions = built?.backlog?.actions || [];
  const copy = known ? sanitizeScreenCopy(screenCopy) : null;

  const sections = [];
  sections.push(['PROJECT', section({
    name: access.project.name,
    url: access.project.url || null,
    composite: overviewData?.composite || null,
    crawlStatus: overviewData?.crawlStatus || null,
    notes: overviewData?.notes || null,
  })]);
  sections.push(['MODULES', section(modules.map(moduleSummary))]);
  if (summary) {
    sections.push(['EXECUTIVE_SUMMARY', section({
      verdict: summary.verdict,
      standing: summary.standing,
      priorities: summary.priorities,
      leverage: summary.leverage,
      confidence: summary.confidence,
      issues: summary.issues,
    })]);
  }
  const working = known ? buildWorking(known, screenCopy?.working) : null;
  if (built) {
    const points = techPointsByRule(known, working);
    sections.push(['FIXES_RANKED', section({
      ranking: built.backlog.ranking,
      totals: built.backlog.totals,
      top: actions.slice(0, MAX_TOP_ACTIONS).map((a) => withScorePoints(actionSummary(a), a, points)),
      moreNotShown: Math.max(0, actions.length - MAX_TOP_ACTIONS),
    })]);
  }
  // How every score here is calculated, at the level of weights, caps and
  // rounding — and the report's own per-item inputs to that calculation.
  sections.push(['SCORING_METHOD', methodologyFor(known)]);
  const onScreen = scoreOnScreen(known, working, modules.find((m) => m.key === moduleKey));
  if (onScreen) sections.push(['SCORE_ON_SCREEN', onScreen]);
  if (working) {
    const text = JSON.stringify(working);
    sections.push(['REPORT_ON_SCREEN_WORKING', text.length > MAX_WORKING_CHARS ? `${text.slice(0, MAX_WORKING_CHARS)}… [cut for length]` : text]);
  }
  if (detail) sections.push(['REPORT_ON_SCREEN_DATA', section(detail)]);
  if (copy) sections.push(['REPORT_ON_SCREEN_EXPLAINERS', section(copy, MAX_SECTION_CHARS)]);

  return {
    screen: known,
    screenName: known ? SCREENS[known] : null,
    links: allowedLinks(modules),
    missing,
    sections,
  };
}

module.exports = {
  buildChatContext,
  sanitizeScreenCopy,
  scoreOnScreen,
  techPointsByRule,
  withScorePoints,
  allowedLinks,
  compact,
  MAX_ARRAY_ITEMS,
  MAX_STRING,
};
