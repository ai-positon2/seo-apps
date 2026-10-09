// ── Keyword Research: the state machine behind every Keyword Research view ────
//
// The standalone page (/keyword-research) and the compact panel inside Content
// Architect's Hub & Spoke report both run the same backend pipeline
// (server/routes/keywordResearch.js: POST /init, then an SSE stream). This file
// is everything about that run that is not React: how each stream event
// changes the state, the 2-primary / 10-secondary editing rules, the source
// pool and its tiers, the copy-as-table output, the Content Writer handoff and
// the snapshot saved per topic. Pure and dependency-free, so it is tested with
// the node runner (__tests__/keywordResearchModel.test.js) and the two views
// cannot drift apart.

export const MAX_PRIMARY = 2;
export const MAX_SECONDARY = 10;

// Display order. `seed` only appears when the run started from a topic
// (Content Architect); `scoring` is emitted by the server between the
// SEMrush and shortlist stages.
export const STEP_CONFIG = [
  { id: 'seed',        label: 'Seed Keyword',     desc: 'Turning the topic into a search keyword' },
  { id: 'variants',    label: 'Query Variants',   desc: 'Expanding across intent variants' },
  { id: 'search',      label: 'SERP Analysis',    desc: 'Fetching top pages for all queries' },
  { id: 'url_scoring', label: 'URL Scoring',      desc: 'Selecting best competitor pages' },
  { id: 'semrush',     label: 'SEMrush Keywords', desc: 'Pulling competitor rankings' },
  { id: 'scoring',     label: 'Keyword Scoring',  desc: 'Rating each keyword against the seed' },
  { id: 'analysis',    label: 'AI Shortlisting',  desc: 'Filtering & ranking keywords' },
  { id: 'validation',  label: 'Quality Check',    desc: 'Verifying primary & secondary keyword match quality' },
];

// "All source keywords" tiers: how many of the selected competitor pages rank
// for a keyword.
export const POOL_TIERS = [
  { id: 'core',      label: 'Core',      desc: 'Appears across 3+ competitor pages', color: 'var(--primary)', headerBg: 'var(--primary-soft)', test: (k) => (k.urlFrequency || 0) >= 3 },
  { id: 'relevant',  label: 'Relevant',  desc: 'Appears across 2 competitor pages',  color: 'var(--info)',    headerBg: 'var(--info-soft)',    test: (k) => (k.urlFrequency || 0) === 2 },
  { id: 'discovery', label: 'Discovery', desc: 'Unique to a single competitor page', color: 'var(--text-3)',  headerBg: 'var(--surface)',      test: (k) => (k.urlFrequency || 0) <= 1 },
];

export function keyOf(kw) {
  return String(kw?.keyword || '').trim().toLowerCase();
}

export function initialState({ keyword = '', intent = 'commercial' } = {}) {
  return {
    keyword,
    intent: intent === 'informational' ? 'informational' : 'commercial',
    seed: null,          // { keyword, fromTopic, source } when derived from a topic
    running: false,
    started: false,
    steps: {},
    lastStep: null,      // the most recent step event, for a one-line progress read
    queries: [],
    urls: [],
    totalQueries: 0,
    urlData: {},
    result: null,
    primary: [],
    secondary: [],
    allKeywords: [],
    error: '',
    cachedAt: null,      // when the shown result is a saved run being replayed
  };
}

/**
 * The next state after one action. Stream events arrive as
 * { type: <SSE event name>, data }; editing and lifecycle actions use the
 * other types below.
 */
export function reduce(state, action) {
  const d = action.data || {};
  switch (action.type) {
    // ── lifecycle ──
    case 'setKeyword': return { ...state, keyword: action.value };
    case 'setIntent': return { ...state, intent: action.value === 'informational' ? 'informational' : 'commercial' };
    case 'reset': return { ...initialState({ keyword: state.keyword, intent: state.intent }) };
    case 'start': return { ...initialState({ keyword: state.keyword, intent: state.intent }), started: true, running: true };
    case 'error': return { ...state, error: action.message || 'Something went wrong.', running: false };
    case 'hydrate': return hydrate(state, action.saved);

    // ── stream events ──
    case 'step':
      return {
        ...state,
        steps: { ...state.steps, [d.id]: { status: d.status, message: d.message } },
        lastStep: { id: d.id, status: d.status, message: d.message },
      };
    case 'seed': return { ...state, seed: { keyword: d.keyword, fromTopic: d.fromTopic, source: d.source }, keyword: d.keyword || state.keyword };
    case 'variants': return { ...state, queries: d.queries || [] };
    case 'urls': return { ...state, urls: d.urls || [], totalQueries: d.totalQueries || 0 };
    case 'url_status':
      return { ...state, urlData: { ...state.urlData, [d.url]: { status: 'loading', keywords: [], title: d.title } } };
    case 'url_keywords':
      return { ...state, urlData: { ...state.urlData, [d.url]: { status: d.status, keywords: d.keywords || [], title: d.title, error: d.error } } };
    case 'allKeywords': return { ...state, allKeywords: d.keywords || [] };
    case 'result':
      return { ...state, result: d, primary: (d.primary || []).slice(0, MAX_PRIMARY), secondary: (d.secondary || []).slice(0, MAX_SECONDARY) };
    case 'fail': return { ...state, error: d.message || 'Research failed.' };
    // The server replayed a saved run for this same seed, intent and client
    // rather than re-rolling it (routes/keywordResearch.js resultKey).
    case 'cached': return { ...state, cachedAt: d.at || 'earlier' };
    case 'done': return { ...state, running: false };
    case 'connectionLost': return { ...state, running: false, error: state.error || 'Connection lost. Please try again.' };

    // ── editing (caps: 2 primary, 10 secondary) ──
    case 'removePrimary': return { ...state, primary: state.primary.filter((_, i) => i !== action.index) };
    case 'removeSecondary': return { ...state, secondary: state.secondary.filter((_, i) => i !== action.index) };
    case 'addPrimary':
      if (state.primary.length >= MAX_PRIMARY || isSelected(state, action.kw)) return state;
      return { ...state, primary: [...state.primary, action.kw] };
    case 'addSecondary':
      if (state.secondary.length >= MAX_SECONDARY || isSelected(state, action.kw)) return state;
      return { ...state, secondary: [...state.secondary, action.kw] };
    case 'toPrimary': {
      const kw = state.secondary[action.index];
      if (!kw || state.primary.length >= MAX_PRIMARY) return state;
      return { ...state, primary: [...state.primary, kw], secondary: state.secondary.filter((_, i) => i !== action.index) };
    }
    case 'toSecondary': {
      const kw = state.primary[action.index];
      if (!kw || state.secondary.length >= MAX_SECONDARY) return state;
      return { ...state, secondary: [...state.secondary, kw], primary: state.primary.filter((_, i) => i !== action.index) };
    }
    default: return state;
  }
}

function isSelected(state, kw) {
  const k = keyOf(kw);
  return [...state.primary, ...state.secondary].some((x) => keyOf(x) === k);
}

/**
 * The "All source keywords" pool: the full scored candidate list, plus any
 * selected keyword the model phrased differently from its candidate entry,
 * minus whatever is currently selected — removing a pick makes it reappear.
 */
export function availableKeywords(state) {
  const selected = new Set([...state.primary, ...state.secondary].map(keyOf));
  const pool = new Map();
  for (const k of state.allKeywords) pool.set(keyOf(k), k);
  for (const k of [...state.primary, ...state.secondary]) if (!pool.has(keyOf(k))) pool.set(keyOf(k), k);
  return [...pool.values()].filter((k) => !selected.has(keyOf(k)));
}

/**
 * Where a running pipeline is, as { index, total, label, message } — the steps
 * this run will show (the seed step only when the run started from a topic)
 * and the one the server last reported. Null before the first step event.
 */
export function progressOf(state) {
  if (!state.lastStep) return null;
  const withSeed = Boolean(state.seed || state.steps.seed);
  const shown = STEP_CONFIG.filter((s) => s.id !== 'seed' || withSeed);
  const at = shown.findIndex((s) => s.id === state.lastStep.id);
  return {
    index: at + 1,
    total: shown.length,
    label: shown[at]?.label || state.lastStep.id,
    message: state.lastStep.message || '',
  };
}

/** The pool split into tiers, each sorted by volume, empty tiers dropped. */
export function poolByTier(state) {
  const available = availableKeywords(state);
  return POOL_TIERS
    .map((tier) => ({ ...tier, keywords: available.filter(tier.test).sort((a, b) => (b.volume || 0) - (a.volume || 0)) }))
    .filter((tier) => tier.keywords.length > 0);
}

// ── Output ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The current picks as a table in two forms: tab-separated (pastes as columns
 * in Excel/Sheets) and an HTML <table> (pastes as a real table in
 * Word/Docs/email). Null when nothing is picked.
 */
export function buildCopyTable(primary, secondary) {
  const rows = [
    ...primary.map((kw) => ({ type: 'Primary', keyword: kw.keyword, volume: kw.volume || 0 })),
    ...secondary.map((kw) => ({ type: 'Secondary', keyword: kw.keyword, volume: kw.volume || 0 })),
  ];
  if (!rows.length) return null;
  const header = ['Type', 'Keyword', 'Volume'];
  const tsv = [header.join('\t'), ...rows.map((r) => [r.type, r.keyword, r.volume].join('\t'))].join('\n');
  const html = `<table><thead><tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.keyword)}</td><td>${r.volume}</td></tr>`).join('')
  }</tbody></table>`;
  return { tsv, html };
}

/**
 * Content Writer handoff. Primary #1 is the article's keyword; every other
 * pick travels as a secondary keyword rather than being dropped. `origin`
 * ({ caProjectId, clusterId, topic }) marks an article started from the Hub &
 * Spoke report, which lists it beside that topic.
 */
export function buildContentWriterUrl({ primary, secondary, client, origin }) {
  const params = new URLSearchParams({ keyword: primary[0]?.keyword || '' });
  const rest = [...primary.slice(1), ...secondary].map((k) => k.keyword).filter(Boolean).join(', ');
  if (rest) params.set('secondary', rest);
  if (client) params.set('client', client);
  if (origin?.caProjectId && origin.clusterId && origin.topic) {
    params.set('ca', origin.caProjectId);
    params.set('cluster', origin.clusterId);
    params.set('topic', origin.topic);
  }
  return `/content-writer?${params.toString()}`;
}

/** The origin a /content-writer URL carries, or null. */
export function originFromParams(params) {
  const caProjectId = params.get('ca');
  const clusterId = params.get('cluster');
  const topic = params.get('topic');
  return caProjectId && clusterId && topic ? { tool: 'content-architect', caProjectId, clusterId, topic } : null;
}

// ── Saving a run ────────────────────────────────────────────────────────────

/** What is kept for a finished run — everything the views render. */
export function snapshot(state) {
  return {
    keyword: state.keyword,
    intent: state.intent,
    seed: state.seed,
    steps: state.steps,
    queries: state.queries,
    urls: state.urls,
    totalQueries: state.totalQueries,
    urlData: state.urlData,
    allKeywords: state.allKeywords,
    result: state.result,
  };
}

export function selectionOf(state) {
  return { primary: state.primary, secondary: state.secondary };
}

/** Restore a saved { result: snapshot, selection } as a finished run. */
export function hydrate(state, saved) {
  const snap = saved?.result;
  if (!snap?.result) return state;
  const sel = saved.selection || {};
  return {
    ...initialState({ keyword: snap.keyword || state.keyword, intent: snap.intent || saved.intent || state.intent }),
    seed: snap.seed || null,
    started: true,
    steps: snap.steps || {},
    queries: snap.queries || [],
    urls: snap.urls || [],
    totalQueries: snap.totalQueries || 0,
    urlData: snap.urlData || {},
    allKeywords: snap.allKeywords || [],
    result: snap.result,
    primary: (Array.isArray(sel.primary) ? sel.primary : snap.result.primary || []).slice(0, MAX_PRIMARY),
    secondary: (Array.isArray(sel.secondary) ? sel.secondary : snap.result.secondary || []).slice(0, MAX_SECONDARY),
  };
}

// ── Display helpers ─────────────────────────────────────────────────────────

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

export function hostAndPath(url) {
  try { const p = new URL(url); return p.hostname + (p.pathname !== '/' ? p.pathname : ''); } catch { return url; }
}

/** 1234 → "1.2k", 800 → "800". */
export function shortVolume(v) {
  if (!(v > 0)) return '';
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}
