// ── Run-tracking registry ───────────────────────────────────────────────────
// The single source of truth for what counts as a "run" in every module, keyed
// by the API mount it belongs to. server.js installs one trackRuns(...) per
// mount from this file, so coverage is auditable in one place instead of being
// scattered across twenty route files.
//
// Matcher fields
//   method    HTTP method (required).
//   path      string or RegExp, matched against the path WITHIN the mount
//             (e.g. '/run', /^\/stream\/[^/]+$/) — not the full URL.
//   action    what the user did: 'run' (default), 'export', 'discover', …
//             Distinguishes a report download from the analysis itself.
//   bridge    'init'   — POST that stores params and returns { token }; no run
//                        row of its own, its input is carried to the stream.
//             'stream' — the SSE request that does the work and gets the row.
//   deferred  the response returns before the work finishes; the module closes
//             the run itself via req.run.finish() / req.run.fail().
//   label     optional (ctx) => string for the runs list, when the input body
//             alone doesn't identify the run (e.g. ids live in the path).
//
// Deliberately NOT tracked, because they are reads, settings or setup rather
// than work a user would look for in a run history:
//   /api/modules, /api/audit, /api/kb-context, /api/semrush (balance),
//   /api/profile, /api/workspaces, /api/auth, /api/runs itself; every GET that
//   only lists or fetches stored results; and the sub-steps of a larger run
//   (/api/search + /api/scrape feed /api/analyze, which is the tracked run).

const STREAM_PATH = /^\/stream\/[^/]+$/;

// Both /init → /stream tools share this pair; the init half only stashes input.
const initStreamMatchers = (action = 'run') => [
  { method: 'POST', path: '/init', bridge: 'init', action },
  { method: 'GET', path: STREAM_PATH, bridge: 'stream', action },
];

const RUN_TRACKING = {
  // ── Research ──────────────────────────────────────────────────────────────
  'keyword-research': {
    toolId: 'keyword-research',
    matchers: initStreamMatchers(),
  },

  'article-recommendation': {
    toolId: 'article-recommendation',
    matchers: initStreamMatchers(),
  },

  // Content Research drives /api/search → /api/scrape → /api/analyze from one
  // screen. The analysis is the run; the two fetch steps that feed it are not
  // separately meaningful, so only /analyze and the export are tracked.
  'content-research': {
    toolId: 'content-research',
    matchers: [
      { method: 'POST', path: '/', action: 'run' },
    ],
  },
  'content-research-export': {
    toolId: 'content-research',
    matchers: [
      { method: 'POST', path: '/docx', action: 'export' },
    ],
  },

  'market-potential': {
    toolId: 'market-potential',
    matchers: [
      { method: 'POST', path: '/compare', action: 'run' },
      { method: 'POST', path: '/summary', action: 'summary' },
    ],
  },

  // The competitor dashboard/tracker. All three of its runs return immediately
  // and finish in the background, so all three are deferred.
  'competitor-tracker': {
    toolId: 'competitor-analysis',
    matchers: [
      { method: 'POST', path: /^\/clients\/([^/]+)\/run$/, action: 'run', deferred: true,
        label: ({ match }) => `client ${match[1]}` },
      { method: 'POST', path: /^\/clients\/([^/]+)\/run-pagespeed$/, action: 'page-speed', deferred: true,
        label: ({ match }) => `client ${match[1]}` },
      { method: 'POST', path: /^\/clients\/([^/]+)\/content-analysis\/run$/, action: 'content-analysis', deferred: true,
        label: ({ match }) => `client ${match[1]}` },
      { method: 'POST', path: /^\/clients\/([^/]+)\/discover-competitors$/, action: 'discover',
        label: ({ match }) => `client ${match[1]}` },
      { method: 'POST', path: /^\/clients\/([^/]+)\/export$/, action: 'export',
        label: ({ match }) => `client ${match[1]}` },
    ],
  },

  // The standalone competitor report builder (SEO team only). /run and
  // /run-manual kick off a jobStore pipeline that outlives the response —
  // closed out from jobStore when the job reaches a terminal status.
  'competitor-analysis-report': {
    toolId: 'competitor-analysis-report',
    matchers: [
      { method: 'POST', path: '/discover', action: 'discover' },
      { method: 'POST', path: '/run', action: 'run', deferred: true },
      { method: 'POST', path: '/run-manual', action: 'run-manual', deferred: true },
      { method: 'GET', path: /^\/export\/[^/]+$/, action: 'export' },
    ],
  },

  // ── Optimize ──────────────────────────────────────────────────────────────
  'article-enhancement': {
    toolId: 'article-enhancement',
    matchers: [
      ...initStreamMatchers(),
      { method: 'POST', path: '/export/docx', action: 'export' },
    ],
  },

  'article-enhancement-lite': {
    toolId: 'article-enhancement-lite',
    matchers: [
      ...initStreamMatchers(),
      { method: 'POST', path: '/export/docx', action: 'export' },
    ],
  },

  'on-page-audit': {
    toolId: 'on-page-audit',
    matchers: [
      { method: 'POST', path: '/run', action: 'run', deferred: true },
    ],
  },

  // Serves both the full SEO & GEO Audit page and the Snapshot page — same
  // engine, same endpoint, so both land under this tool.
  'seo-geo-audit': {
    toolId: 'seo-geo-audit',
    matchers: [
      { method: 'POST', path: '/run', action: 'run' },
    ],
  },

  'agent-readiness-audit': {
    toolId: 'agent-readiness-audit',
    matchers: [
      { method: 'POST', path: '/', action: 'run' },
      { method: 'POST', path: '/stream', action: 'run' },
      { method: 'POST', path: '/pdf', action: 'export' },
    ],
  },

  'image-alt-audit': {
    toolId: 'image-alt-audit',
    matchers: [
      ...initStreamMatchers(),
      { method: 'GET', path: /^\/download\/[^/]+$/, action: 'export' },
    ],
  },

  'content-enhancement': {
    toolId: 'content-enhancement',
    matchers: [
      { method: 'POST', path: '/run', action: 'run' },
    ],
  },

  // ── Build ─────────────────────────────────────────────────────────────────
  // Keyword and content generation both return a token and do the work on the
  // shared /stream endpoint, so the action ('keywords' vs 'content') is set on
  // the init matcher and carried across the bridge.
  'location-page-builder': {
    toolId: 'location-page-builder',
    matchers: [
      { method: 'POST', path: /^\/pages\/([^/]+)\/keywords\/run$/, bridge: 'init', action: 'keywords',
        label: ({ match }) => `page ${match[1]}` },
      { method: 'POST', path: /^\/pages\/([^/]+)\/content\/run$/, bridge: 'init', action: 'content',
        label: ({ match }) => `page ${match[1]}` },
      { method: 'GET', path: STREAM_PATH, bridge: 'stream', action: 'run' },
      { method: 'POST', path: /^\/pages\/([^/]+)\/qa$/, action: 'qa',
        label: ({ match }) => `page ${match[1]}` },
      { method: 'POST', path: /^\/pages\/([^/]+)\/content\/regen-field$/, action: 'regen-field',
        label: ({ match }) => `page ${match[1]}` },
      { method: 'POST', path: '/wizard/generate', action: 'wizard' },
    ],
  },

  // KB edits are explicit, button-driven saves (no auto-save), so one row per
  // save is a useful trail of who changed which knowledge base, and why.
  'knowledge-base': {
    toolId: 'knowledge-base',
    matchers: [
      { method: 'POST', path: '/', action: 'create' },
      { method: 'PUT', path: /^\/([^/]+)$/, action: 'save',
        label: ({ match, input }) => (input?.changeNote ? `${match[1]} — ${input.changeNote}` : match[1]) },
      { method: 'DELETE', path: /^\/([^/]+)$/, action: 'delete',
        label: ({ match }) => match[1] },
      { method: 'PATCH', path: /^\/([^/]+)\/toggle$/, action: 'toggle',
        label: ({ match }) => match[1] },
    ],
  },

  // ── Monitor ───────────────────────────────────────────────────────────────
  'robots-monitor': {
    toolId: 'robots-monitor',
    matchers: [
      { method: 'POST', path: '/run', action: 'run', deferred: true, label: () => 'manual run' },
    ],
  },
};

// Tool ids the app tracks, for the runs page's tool filter.
const TRACKED_TOOL_IDS = [...new Set(Object.values(RUN_TRACKING).map(c => c.toolId))].sort();

module.exports = { RUN_TRACKING, TRACKED_TOOL_IDS };
