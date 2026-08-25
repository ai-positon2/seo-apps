// Status tags shown next to a tool's name (sidebar) and on its card (home).
// Same visual language as the original "Beta" pill, one distinct color each.
// A tool with no `tag` shows nothing. Single source of truth for both surfaces.
// `label` is the full text (cards, which have room); `short` is the compact
// form used in the width-constrained sidebar so tool names aren't over-truncated.
export const TAGS = {
  beta:     { label: 'Beta',             short: 'Beta',     bg: 'rgba(59,130,246,0.20)',  fg: '#60a5fa' },
  internal: { label: 'Internal Only',    short: 'Internal', bg: 'rgba(245,158,11,0.20)',  fg: '#fbbf24' },
  testing:  { label: 'Internal Testing', short: 'Testing',  bg: 'rgba(168,85,247,0.22)',  fg: '#c084fc' },
  soon:     { label: 'Coming Soon',      short: 'Soon',     bg: 'rgba(148,163,184,0.22)', fg: '#cbd5e1' },
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
      { id: 'article-enhancement-lite', path: '/article-enhancement-lite', label: 'Article Enhancer', icon: '📝' },
      { id: 'on-page-audit',          path: '/on-page-audit',          label: 'On-Page SEO Audit',      icon: '🔎', tag: 'soon' },
      { id: 'seo-geo-audit',          path: '/seo-geo-audit',          label: 'SEO & GEO Audit',        icon: '🌐', tag: 'beta' },
      { id: 'seo-geo-snapshot',       path: '/seo-geo-snapshot',       label: 'SEO & GEO Snapshot',     icon: '📊', tag: 'beta' },
      { id: 'agent-readiness-audit',  path: '/agent-readiness-audit',  label: 'Agent Readiness Audit',  icon: '🤖' },
      { id: 'image-alt-audit',        path: '/image-alt-audit',        label: 'Image Alt Tag Audit',    icon: '🖼️', tag: 'beta' },
    ],
  },
  {
    label: 'Build',
    tools: [
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

export function getToolByPath(pathname) {
  return ALL_TOOLS.find(t => pathname === t.path || pathname.startsWith(t.path + '/'));
}
