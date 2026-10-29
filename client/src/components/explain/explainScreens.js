// ── Which screen an explainer lives on, and where "Open …" goes ─────────────
//
// Kept apart from the copy so the copy can ask "which screen is this module
// on?" without the two importing each other.

import { moduleReportRoute } from '../../lib/moduleReportRoute.js';

/** Screen key → the name the popover kicker and the legend title use. */
export const SCREENS = {
  overview: 'Overview',
  tech: 'Tech Audit',
  seogeo: 'SEO & GEO',
  agent: 'Agent Readiness',
  aivisLite: 'AI Visibility',
  aivis: 'AI Visibility',
  comp: 'Competitor Research',
  hub: 'Hub and Spoke',
};

/** The icons each screen carries, in reading order. */
export const EXPLAINER_KEYS_BY_SCREEN = {
  overview: ['exec', 'trend', 'priorities', 'radar',
    'm_technical', 'm_hub', 'm_competitor', 'm_seogeo', 'm_aivis', 'm_agent'],
  tech: ['t_health', 't_lost', 't_html', 't_issues', 't_first', 't_triaged'],
  seogeo: ['g_score', 'g_seo', 'g_geo', 'g_verdict', 'g_platforms', 'g_wins', 'g_counts'],
  agent: ['a_score', 'a_sub', 'a_brief', 'a_checks'],
  aivisLite: ['l_score', 'l_named', 'l_share', 'l_cited', 'l_rank', 'l_grounded', 'l_engines',
    'l_brands', 'l_weak', 'l_gaps'],
  aivis: ['v_stand', 'v_visibility', 'v_sentiment', 'v_position', 'v_sov', 'v_models', 'v_gaps', 'v_weak'],
  comp: ['c_score', 'c_traffic', 'c_keywords', 'c_authority', 'c_backlinks', 'c_mix'],
  hub: ['h_clusters', 'h_healthy', 'h_hubs', 'h_unclear', 'h_table'],
};

const SCREEN_OF = Object.fromEntries(
  Object.entries(EXPLAINER_KEYS_BY_SCREEN).flatMap(([screen, keys]) => keys.map((k) => [k, screen])),
);

export const screenOf = (key) => SCREEN_OF[key] || null;

/** Dashboard module key → the screen its report is. */
export const MODULE_SCREEN = {
  technical: 'tech',
  hub_spoke: 'hub',
  competitor: 'comp',
  seo_geo: 'seogeo',
  ai_visibility_lite: 'aivisLite',
  ai_visibility: 'aivis',
  agent_readiness: 'agent',
};

const TOOL_PATH = {
  overview: '/',
  tech: '/crawl-scope',
  seogeo: '/seo-geo-audit',
  agent: '/agent-readiness-audit',
  aivisLite: '/ai-visibility-lite',
  aivis: '/ai-visibility',
  comp: '/competitor-analysis',
  hub: '/content-architect',
};

/**
 * Where "Open {Module} →" goes. On the overview the module card is in hand, and
 * its own report route is the one to follow — the same one the card itself
 * links to — rather than the tool's front page.
 */
export function nextRoute(screen, ctx = {}) {
  const cards = ctx.module ? [ctx.module] : (ctx.modules || []);
  const card = cards.find((m) => MODULE_SCREEN[m.key] === screen);
  const fromCard = card ? moduleReportRoute(card).path : null;
  return fromCard || TOOL_PATH[screen] || '/';
}
