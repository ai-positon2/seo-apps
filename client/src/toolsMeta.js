// Status tags shown next to a tool's name (sidebar) and on its card (home).
// A tool with no `tag` shows nothing. Single source of truth for both surfaces.
//
// What a reader SEES is `badge`: one quiet word, the same for every maturity
// level. Eleven of sixteen menu items used to carry a coloured "Internal",
// "Beta" or "Testing" pill, which told a first-time visitor the whole product
// was unfinished and had stopped telling the team anything. The precise status
// (`label`) is kept and shown as the pill's tooltip, so nothing is lost.
const QUIET = { bg: 'color-mix(in srgb, var(--text-3) 16%, transparent)', fg: 'var(--text-2)' };
export const TAGS = {
  beta:     { label: 'Beta',             short: 'Beta', badge: 'Beta', ...QUIET },
  internal: { label: 'Internal Only',    short: 'Beta', badge: 'Beta', ...QUIET },
  testing:  { label: 'Internal Testing', short: 'Beta', badge: 'Beta', ...QUIET },
  soon:     { label: 'Coming Soon',      short: 'Soon', badge: 'Soon', ...QUIET },
};

export const TOOL_GROUPS = [
  {
    label: 'Research',
    tools: [
      { id: 'keyword-research',       path: '/keyword-research',       label: 'Keyword Research',       icon: '🔍' },
      { id: 'content-research',       path: '/content-research',       label: 'Content Research',       icon: '📄', tag: 'internal' },
      { id: 'article-recommendation', path: '/article-recommendation', label: 'Article Recommendation', icon: '📰' },
      { id: 'market-potential',       path: '/market-potential',       label: 'Market Potential',       icon: '🗺️', tag: 'beta' },
      { id: 'competitor-analysis',    path: '/competitor-analysis',    label: 'Competitor Analysis',    icon: '🆚', tag: 'beta' },
    ],
  },
  {
    label: 'Optimize',
    tools: [
      { id: 'article-enhancement',    path: '/article-enhancement',    label: 'Enhance Existing Article', icon: '✍️', tag: 'internal' },
      { id: 'article-enhancement-lite', path: '/article-enhancement-lite', label: 'Article Enhancer', icon: '📝', hidden: true },
      { id: 'ai-visibility-lite',     path: '/ai-visibility-lite',     label: 'AI Visibility',          icon: '📡', tag: 'beta' },
      // The scraped module. Hidden from the sidebar for now (still fully
      // reachable at its own route, and still the entry overview.js's
      // MODULES registry needs — see that file's own comment on why deleting
      // it broke the in-flight-run poll). Not a removal — just off the nav
      // until it's wanted again.
      { id: 'ai-visibility',          path: '/ai-visibility',          label: 'AI Visibility (scraped)', icon: '🛰️', tag: 'beta', hidden: true },
      { id: 'seo-geo-audit',          path: '/seo-geo-audit',          label: 'SEO & GEO Audit',        icon: '🌐', tag: 'beta' },
      { id: 'agent-readiness-audit',  path: '/agent-readiness-audit',  label: 'Agent Readiness Audit',  icon: '🤖' },
      { id: 'image-alt-audit',        path: '/image-alt-audit',        label: 'Image Alt Tag Audit',    icon: '🖼️', tag: 'beta' },
    ],
  },
  {
    label: 'Build',
    tools: [
      { id: 'content-writer', path: '/content-writer', label: 'Content Writer', icon: '✍' },
      { id: 'location-page-builder',  path: '/location-page-builder',  label: 'Location + Service Pages', icon: '📍', tag: 'testing' },
      { id: 'content-architect',      path: '/content-architect',      label: 'Content Architect',      icon: '🗺️', tag: 'testing' },
      { id: 'knowledge-base',         path: '/kb',                     label: 'Knowledge Base',         icon: '📚', tag: 'internal' },
    ],
  },
  {
    label: 'Monitor',
    tools: [
      { id: 'crawl-scope',            path: '/crawl-scope',            label: 'Site Crawler',           icon: '🕷️', tag: 'testing' },
    ],
  },
];

export const ALL_TOOLS = TOOL_GROUPS.flatMap(g => g.tools);

// What the sidebar walks: same groups, minus the tools marked `hidden` (and
// minus any group left empty by that). `hidden: true` takes a tool out of the
// nav while leaving its route, its page title and its run-history label
// intact — it stays reachable by URL, it just isn't advertised.
export const NAV_GROUPS = TOOL_GROUPS
  .map(g => ({ ...g, tools: g.tools.filter(t => !t.hidden) }))
  .filter(g => g.tools.length > 0);

export function getToolByPath(pathname) {
  return ALL_TOOLS.find(t => pathname === t.path || pathname.startsWith(t.path + '/'));
}
