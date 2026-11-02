// ── Which report a chat question is about ───────────────────────────────────
//
// The server's copy of three maps from client/src/components/explain/
// explainScreens.js and lib/moduleReportRoute.js. Copied rather than imported
// because the client files are ES modules and this server is CommonJS; the
// test in __tests__/screens.test.js imports the client originals and fails the
// moment the two disagree, so a renamed screen or route cannot drift silently.

/** Screen key → the name a reader sees. */
const SCREENS = {
  overview: 'Overview',
  tech: 'Tech Audit',
  seogeo: 'SEO & GEO',
  agent: 'Agent Readiness',
  aivisLite: 'AI Visibility',
  aivis: 'AI Visibility',
  comp: 'Competitor Research',
  hub: 'Hub and Spoke',
};

/** Dashboard module key → the screen its report is. */
const MODULE_SCREEN = {
  technical: 'tech',
  hub_spoke: 'hub',
  competitor: 'comp',
  seo_geo: 'seogeo',
  ai_visibility_lite: 'aivisLite',
  ai_visibility: 'aivis',
  agent_readiness: 'agent',
};

/** Screen → its dashboard module, or null for the overview. */
const SCREEN_MODULE = Object.fromEntries(
  Object.entries(MODULE_SCREEN).map(([moduleKey, screen]) => [screen, moduleKey]),
);

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

const isScreen = (screen) => typeof screen === 'string' && Object.hasOwn(SCREENS, screen);

/** Same answer as the client's moduleReportRoute(module).path. */
function moduleReportPath(module) {
  const ref = module.key === 'technical' ? (module.runId || null) : (module.reportRef || null);
  if (ref) {
    if (module.key === 'technical') return `/crawl-scope/runs/${ref}`;
    if (module.key === 'hub_spoke') return `/content-architect/${ref}`;
    if (module.key === 'competitor') return `/competitor-analysis?client=${ref}`;
  }
  return module.toolPath || null;
}

module.exports = { SCREENS, MODULE_SCREEN, SCREEN_MODULE, TOOL_PATH, isScreen, moduleReportPath };
