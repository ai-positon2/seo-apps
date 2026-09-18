require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { router: authRouter, requireAuth, requireSeo } = require('./routes/auth');
const searchRoutes = require('./routes/search');
const scrapeRoutes = require('./routes/scrape');
const analyzeRoutes = require('./routes/analyze');
const exportRoutes = require('./routes/export');
const keywordResearchRoutes = require('./routes/keywordResearch');
const kbRoutes = require('./routes/kb');
const modulesRoutes = require('./routes/modules');
const auditRoutes = require('./routes/audit');
const kbContextRoutes = require('./routes/kbContext');
const articleRecommendationRoutes = require('./routes/articleRecommendation');
const imageAltAuditRoutes = require('./routes/imageAltAudit');
const competitorAnalysisRoutes = require('./routes/competitorAnalysis');
const agentReadinessAuditRoutes = require('./routes/agentReadinessAudit');
const seoGeoAuditRoutes = require('./routes/seoGeoAudit');
const contentEnhancementRoutes = require('./routes/contentEnhancement');
const articleEnhancementRoutes = require('./routes/articleEnhancement');
const articleEnhancementLiteRoutes = require('./routes/articleEnhancementLite');
const locationPageBuilderRoutes = require('./routes/locationPageBuilder');
const robotsMonitorRoutes = require('./modules/robotsMonitor/routes');
const aiVisibilityRoutes = require('./modules/aiVisibility/routes');
const aiVisibilityLiteRoutes = require('./modules/aiVisibilityLite/routes');
const onPageAuditRoutes = require('./modules/onPageAudit/routes');
const marketPotentialRoutes = require('./modules/marketPotential/routes');
const competitorAnalysisTrackerRoutes = require('./modules/competitorAnalysis/routes');
const contentArchitectRoutes = require('./modules/contentArchitect/routes');
const crawlScopeRoutes = require('./modules/crawlScope/api/routes');
const semrushRoutes = require('./routes/semrush');
const profileRoutes = require('./routes/profile');
const workspaceRoutes = require('./routes/workspaces');
const runsRoutes = require('./routes/runs');
const projectsRoutes = require('./modules/projects/routes');
const adminRoutes = require('./routes/admin');
const platformAdmin = require('./services/platformAdmin');
const { trackRuns } = require('./middleware/runTracking');
const { RUN_TRACKING } = require('./config/runTracking');
const runStore = require('./services/runStore');

// Run tracking for one API mount — see server/config/runTracking.js for which
// endpoints of which module count as a run. Installed after requireAuth on
// every mount, so a run row always carries the user and workspace behind it.
const track = (mountKey) => trackRuns(RUN_TRACKING[mountKey]);

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());

// Responses shipped uncompressed until here: the client bundle is ~3.1 MB of
// JavaScript, and the crawl report's findings JSON runs to megabytes on a large
// run (see crawlScope/db/repo.js, which measured 2.0 MB / 9.8 s for a 500-page
// crawl). Mounted before the route mounts and before express.static below, so
// it covers both the API and the bundle.
//
// The filter is the load-bearing part, not boilerplate. text/event-stream is
// absent from mime-db, so compressible() falls through to its ^text/ regex and
// reports SSE as compressible -- and gzip then buffers until its window fills,
// which stalls a live-progress stream and releases it in one burst at the end.
// This server has twelve SSE endpoints (crawlScope/api/sse.js, contentArchitect
// x2, agentReadinessAudit, articleEnhancement, articleEnhancementLite,
// articleRecommendation, competitorAnalysis, imageAltAudit, keywordResearch,
// locationPageBuilder, seoGeoAudit), so the default filter would regress twelve
// screens at once. Sniffing the response Content-Type is how
// middleware/runTracking.js already recognises a stream.
app.use(compression({
  filter: (req, res) => (
    String(res.getHeader('Content-Type') || '').includes('text/event-stream')
      ? false
      : compression.filter(req, res)
  ),
}));
// NOTE: express.json() is deliberately NOT registered here. It is mounted after
// the rate limiter below, so a 20 MB body from an unauthenticated caller is
// counted and rejected before Express spends memory and CPU parsing it.

// General rate limit: 20 requests per minute.
// Skips routers that have their own (higher) limiter, so the call-heavy
// Location Page Builder + KB editor aren't throttled by the global cap.
//
// A router missing from this list keeps its own limiter but is ALSO capped at
// 20/min here, and the global cap wins — which is what happened to
// /api/ai-visibility: it was mounted with lpbLimiter (300/min) and silently
// throttled to 20 anyway. Adding a router below without adding it here gives it
// a limit it does not actually get.
// One list instead of a hand-maintained `||` chain. Every mount below that takes
// kbLimiter or lpbLimiter MUST appear here, or the global 20/min cap silently
// wins over the higher limit it was given — which is exactly what had happened to
// /api/robots-monitor and /api/on-page-audit: both were mounted with lpbLimiter
// (300/min) and were still being throttled to 20/min, because only this list is
// consulted. Holding it as data at least puts the prefixes next to the limiter
// each one is claiming; the drift itself is still only prevented by keeping this
// list in step with the mounts below, so add the prefix here when you add a
// mount that takes kbLimiter or lpbLimiter.
const OWN_LIMITER_PREFIXES = [
  '/api/kb',                     // kbLimiter — editor auto-saves
  '/api/modules',                // kbLimiter
  '/api/audit',                  // kbLimiter
  '/api/kb-context',             // kbLimiter
  '/api/location-page-builder',  // lpbLimiter — dashboard + wizard + SSE
  '/api/robots-monitor',         // lpbLimiter
  '/api/on-page-audit',          // lpbLimiter
  '/api/market-potential',       // lpbLimiter
  '/api/competitor-tracker',     // lpbLimiter
  '/api/content-architect',      // lpbLimiter
  '/api/crawl-scope',            // lpbLimiter
  '/api/ai-visibility',          // lpbLimiter
  '/api/ai-visibility-lite',     // lpbLimiter
  '/api/projects',               // lpbLimiter — home loads list + per-project overview
  '/api/runs',                   // kbLimiter
  '/api/admin',                  // kbLimiter
];

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
  skip: (req) => {
    const u = req.originalUrl || req.url || '';
    return OWN_LIMITER_PREFIXES.some((prefix) => u.startsWith(prefix));
  },
});

// KB rate limit: 100 requests per minute (editor auto-saves)
const kbLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many KB requests. Please slow down.' }
});

// Location Page Builder: dashboard + wizard + entity CRUD + SSE are chatty.
const lpbLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests to the page builder. Please slow down a moment.' }
});

app.use('/api/', limiter);

// Body parsing happens *after* rate limiting, so an unauthenticated flood of
// 20 MB JSON bodies is throttled at the limiter instead of being parsed first.
// The generous limit itself is kept: the KB editor, the SEMrush upload parser
// and the article/content enhancement routes all post large documents.
app.use(express.json({ limit: '20mb' }));

// ── Public routes (no auth required) ────────────────────────────────────────
app.use('/api/auth', authRouter);
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── Protected routes (JWT cookie required on every request) ─────────────────
// ── Extended team + SEO team (all authenticated users) ──────────────────────
app.use('/api/kb',                     kbLimiter, requireAuth, track('knowledge-base'), kbRoutes);
app.use('/api/modules',                kbLimiter, requireAuth, modulesRoutes);
app.use('/api/audit',                  kbLimiter, requireAuth, auditRoutes);
app.use('/api/kb-context',             kbLimiter, requireAuth, kbContextRoutes);
app.use('/api/keyword-research',       requireAuth, track('keyword-research'), keywordResearchRoutes);
app.use('/api/article-recommendation', requireAuth, track('article-recommendation'), articleRecommendationRoutes);
app.use('/api/image-alt-audit',        requireAuth, track('image-alt-audit'), imageAltAuditRoutes);
app.use('/api/agent-readiness-audit',  requireAuth, track('agent-readiness-audit'), agentReadinessAuditRoutes);
app.use('/api/seo-geo-audit',          requireAuth, track('seo-geo-audit'), seoGeoAuditRoutes);
app.use('/api/content-enhancement',    requireAuth, track('content-enhancement'), contentEnhancementRoutes);
app.use('/api/article-enhancement',    requireAuth, track('article-enhancement'), articleEnhancementRoutes);
app.use('/api/article-enhancement-lite', requireAuth, track('article-enhancement-lite'), articleEnhancementLiteRoutes);
app.use('/api/location-page-builder',   lpbLimiter, requireAuth, track('location-page-builder'), locationPageBuilderRoutes);
app.use('/api/robots-monitor',          lpbLimiter, requireAuth, track('robots-monitor'), robotsMonitorRoutes);
app.use('/api/on-page-audit',           lpbLimiter, requireAuth, track('on-page-audit'), onPageAuditRoutes);
app.use('/api/market-potential',        lpbLimiter, requireAuth, track('market-potential'), marketPotentialRoutes);
app.use('/api/competitor-tracker',      lpbLimiter, requireAuth, track('competitor-tracker'), competitorAnalysisTrackerRoutes);
app.use('/api/content-architect',       lpbLimiter, requireAuth, track('content-architect'), contentArchitectRoutes);
// Emailed report downloads. Deliberately OUTSIDE requireAuth: the link lands in
// a scheduled-report email and is opened from a mail client with no session,
// which is exactly what the Supabase Storage signed URL used to provide. The
// token stands in for that — it is signed with JWT_SECRET, carries a `purpose`
// that no other route accepts, names ONE report path, and expires. It grants a
// single file and nothing else, so it can never be presented as a session.
app.get('/api/crawl-scope-report/:token', lpbLimiter, async (req, res) => {
  const report = require('./modules/crawlScope/run/report');
  const storedPath = report.verifyReportToken(req.params.token);
  if (!storedPath) {
    return res.status(403).json({ error: 'This download link is invalid or has expired.' });
  }
  try {
    const buffer = await report.readReport(storedPath);
    if (!buffer) return res.status(404).json({ error: 'That report is no longer stored.' });
    res.setHeader('Content-Type', report.XLSX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="CrawlScope-SEO-Audit.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error('[crawlScope] report download failed:', err.message);
    res.status(500).json({ error: 'Could not read that report.' });
  }
});

app.use('/api/crawl-scope',             lpbLimiter, requireAuth, track('crawl-scope'), crawlScopeRoutes);
// No track() wrapper: this is a project module, so its runs are recorded in
// project_module_runs by moduleEvidence rather than in the tool-run table.
app.use('/api/ai-visibility',           lpbLimiter, requireAuth, aiVisibilityRoutes);
// The API-based sibling. Mounted on its own path with its own router so the two
// modules share nothing but the metric functions they both import.
app.use('/api/ai-visibility-lite',      lpbLimiter, requireAuth, aiVisibilityLiteRoutes);
app.use('/api/semrush',                 requireAuth, semrushRoutes);
app.use('/api/profile',                 requireAuth, profileRoutes);
app.use('/api/workspaces',              requireAuth, workspaceRoutes);
app.use('/api/runs',                    kbLimiter, requireAuth, runsRoutes);
// Workspace-owned projects (PRD §18.2). Chatty like the other dashboard mounts —
// the home screen loads the project list plus one overview per selected project
// — so it takes the higher limiter rather than the 20/min global one.
// track('projects') records project CREATION only (see config/runTracking.js).
// The module runs under this mount keep their own record in project_module_runs;
// the matcher does not fire for them, and a request with no matcher passes
// straight through without the middleware wrapping anything.
app.use('/api/projects',                lpbLimiter, requireAuth, track('projects'), projectsRoutes);
// Platform administration (PRD §18.7). requireAuth establishes *who*; the router
// itself re-checks the persisted platform-admin grant on every request.
app.use('/api/admin',                   kbLimiter, requireAuth, adminRoutes);

// ── SEO team only ────────────────────────────────────────────────────────────
app.use('/api/search',              requireSeo, searchRoutes);
app.use('/api/scrape',              requireSeo, scrapeRoutes);
app.use('/api/analyze',             requireSeo, track('content-research'), analyzeRoutes);
app.use('/api/export',              requireSeo, track('content-research-export'), exportRoutes);
app.use('/api/competitor-analysis', requireSeo, track('competitor-analysis-report'), competitorAnalysisRoutes);


// ── Session minting ─────────────────────────────────────────────────────────
// There is exactly one way to obtain a session: the Google flow in
// routes/auth.js. A shared-token interceptor used to sit here, turning any page
// load carrying ?pt=<PLATFORM_TOKEN> into a seven-day session before React
// rendered. It was removed: a credential that travels in a URL ends up in
// browser history, referrer headers, access logs and shared links, and it
// granted the privileged role to whoever held it.

// ── Serve React frontend ─────────────────────────────────────────────────────
const clientBuild = path.join(__dirname, '../client/dist');
// Vite writes content-hashed filenames into dist/assets, so those are safe to
// cache forever: a new build produces new names rather than new contents at the
// same name. index.html is NOT hashed and is served from this same directory,
// so it deliberately keeps express.static's default (max-age=0) -- caching the
// shell would pin a browser to an old build's asset names indefinitely.
app.use(express.static(clientBuild, {
  setHeaders: (res, filePath) => {
    // Normalised first: express.static hands back a native path, so this is
    // backslash-separated on Windows and '/'-separated in the container.
    if (filePath.replace(/\\/g, "/").includes("/assets/")) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// A missing /assets/* file is a 404, not the SPA shell -- the same reasoning as
// the /api guard below, and for code-split routes it matters more. After a
// deploy, a tab holding the previous index.html requests chunk filenames that
// no longer exist; without this they fall through to the catch-all and come
// back as index.html with HTTP 200 and Content-Type text/html, which surfaces
// in the browser as an opaque module parse error instead of a plain 404.
// client/src/components/ChunkErrorBoundary.jsx handles the recovery; this makes
// the cause diagnosable.
app.use('/assets', (req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

// No favicon is referenced by index.html, so browsers request /favicon.ico on
// every cold load and the catch-all answered each one with the whole of
// index.html at HTTP 200. Registered after express.static so a real favicon
// added to the build still wins.
app.get('/favicon.ico', (req, res) => res.status(204).end());

// An unmatched /api/* path is a 404 — not the SPA shell. Reached by the catch-all
// below, a mistyped, renamed or removed endpoint answered index.html with HTTP
// 200, so the client's `res.ok` was true and `res.json()` then threw
// "Unexpected token '<'". That turns a plainly readable 404 into a parse error
// with no hint of which call was wrong, and it hides dead endpoints from the
// client entirely. Registered after every /api mount, so it only sees genuine misses.
app.use('/api', (req, res) => {
  res.status(404).json({
    error: `Unknown API endpoint: ${req.method} ${(req.originalUrl || '').split('?')[0]}`,
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuild, 'index.html'));
});

// ── Error handler ────────────────────────────────────────────────────────────
// Express needs a 4-argument middleware to treat this as the error handler, and
// there was none: a route that threw synchronously, or called next(err), fell
// through to Express's default handler, which answers a full HTML stack trace.
// On an /api call that means the client again gets HTML where it expects JSON,
// and the stack — absolute paths, module layout, sometimes query values — is
// echoed to whoever made the request. Must stay last.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  // A body that was too large or malformed is the caller's problem, and saying so
  // is more useful than "Internal server error".
  const isClientError = status >= 400 && status < 500;
  console.error('[error]', req.method, req.originalUrl, '->', status, err.message);
  if (status >= 500) console.error(err.stack);

  if (res.headersSent) return; // response already streaming (SSE, file download)

  res.status(status).json({
    error: isClientError
      ? (err.message || 'Bad request.')
      // Never the stack, and never err.message for a 500: these can carry
      // connection strings and upstream credentials.
      : 'Internal server error.',
  });
});

// ── Platform administrator bootstrap (PRD §7.3, AC-002) ──────────────────────
// Idempotent: migration 0011 seeds the same grant, and this re-asserts it on
// every boot so a database restored from an older dump still ends up with an
// administrator. The grant is linked to the person's app_users row at their
// next authenticated login (routes/auth.js), which is the only moment both the
// verified email and the user id are known.
if (require('./services/db').isDatabaseConfigured()) {
  platformAdmin.ensureBootstrapGrants()
    .then(({ seeded, skipped }) => {
      if (seeded.length) console.log(`[platformAdmin] Bootstrap grant created for: ${seeded.join(', ')}`);
      if (skipped.length) console.log(`[platformAdmin] Bootstrap grant already present for: ${skipped.join(', ')}`);
    })
    .catch(err => console.error('[platformAdmin] Bootstrap failed:', err.message));
} else {
  console.log('[platformAdmin] Bootstrap skipped — DATABASE_URL not set.');
}

// ── Workspace purge sweeper (PRD §3.3.4, phase 2) ───────────────────────────
// Workspaces past their grace period are destroyed here and nowhere else.
//
// Hourly rather than on a fixed daily time: a purge date can fall at any hour,
// and a once-a-day sweep means data survives up to 24 hours past the window it
// was promised to be deleted in. Hourly bounds that overshoot to an hour.
//
// The first sweep is delayed past boot so a restart loop cannot turn into a
// purge loop, and so a deploy does not spend its first second deleting data.
const workspaceLifecycle = require('./services/workspaceLifecycle');
const PURGE_SWEEP_MS = 60 * 60 * 1000;
const PURGE_FIRST_DELAY_MS = 5 * 60 * 1000;

function startPurgeSweeper() {
  const runSweep = async () => {
    try {
      const result = await workspaceLifecycle.sweep();
      // Silent when there is nothing due — an hourly "nothing to do" line buries
      // the ones that matter. Anything that actually happened is logged.
      if (result.due) {
        console.log(
          `[purge] ${result.purged} purged, ${result.skipped} skipped, `
          + `${result.failed} failed of ${result.due} due`,
        );
      }
    } catch (e) {
      console.error('[purge] sweep failed:', e.message);
    }
  };

  const first = setTimeout(runSweep, PURGE_FIRST_DELAY_MS);
  const interval = setInterval(runSweep, PURGE_SWEEP_MS);
  first.unref();
  interval.unref();
}

if (require('./services/db').isDatabaseConfigured()) {
  startPurgeSweeper();
  console.log('   PURGE SWEEPER:     hourly (first sweep in 5 min)');
}

// ── Module schedulers ────────────────────────────────────────────────────────
require('./modules/onPageAudit/store').init().catch(err => {
  console.error('[OnPageAudit] Store init failed:', err.message);
});

require('./modules/marketPotential/store').init().catch(err => {
  console.error('[MarketPotential] Store init failed:', err.message);
});

require('./modules/competitorAnalysis/store').init().catch(err => {
  console.error('[CompetitorAnalysis] Store init failed:', err.message);
});

// Sweeps expired rows out of the shared `cache` table (nothing else deletes
// them — TTL is applied on read). Enforces the 180-day SEMrush retention.
try {
  require('./jobs/cachePurge').init();
} catch (err) {
  console.error('[CachePurge] Scheduler init failed:', err.message);
}

// Watches how close the database is to its size cap. The cap is real and
// hard: when it was hit, the only symptom was an unrelated insert failing
// ("could not extend file because project size limit has been exceeded"), and
// nothing had warned. Read-only — it reports, it never deletes.
try {
  require('./services/dbCapacity').init();
} catch (err) {
  console.error('[DbCapacity] Watch init failed:', err.message);
}

require('./modules/robotsMonitor/monitorStore').init().then(() => {
  require('./modules/robotsMonitor/monitorScheduler').init().catch(err => {
    console.error('[RobotsMonitor] Scheduler init failed:', err.message);
  });
}).catch(err => {
  console.error('[RobotsMonitor] Store init failed:', err.message);
});

// ── CrawlScope worker ────────────────────────────────────────────────────────
// CrawlScope arrived from a standalone app where the scheduler + crawl executor
// were their own Railway service (`npm run worker`, no HTTP port). Both ways of
// running it are supported here:
//
//   in-process (default) — the loops start below, in this process, the same way
//     robotsMonitor's scheduler already runs. Nothing extra to deploy.
//   separate service     — set CRAWLSCOPE_WORKER=external and run
//     `npm run worker --prefix server` as its own process. The run-claiming is
//     already replica-safe (worker_id + the (project, slot) unique constraint),
//     so this is the path to scale crawling independently of the web process.
//
// Off entirely with CRAWLSCOPE_WORKER=off — the API still serves stored runs and
// manual crawls, but nothing scheduled will fire.
//
// Requires the database: with none configured there is nothing to claim, so it
// stays down rather than logging a failure every poll.
const CRAWLSCOPE_WORKER = (process.env.CRAWLSCOPE_WORKER || 'in-process').toLowerCase();
let crawlScopeWorker = null;
if (CRAWLSCOPE_WORKER === 'in-process') {
  if (require('./services/db').isDatabaseConfigured()) {
    try {
      crawlScopeWorker = require('./modules/crawlScope/worker').startLoops({ manageProcess: false });
    } catch (err) {
      console.error('[crawlScope] Worker failed to start:', err.message);
    }
  } else {
    console.log('[crawlScope] Worker not started — DATABASE_URL not set.');
  }
} else {
  console.log(`[crawlScope] Worker not started in this process (CRAWLSCOPE_WORKER=${CRAWLSCOPE_WORKER}).`);
}

// ── Module run worker (queue + scheduler + reaper) ───────────────────────────
// The same three loops CrawlScope runs, over `project_module_runs` (0019).
// AI Visibility is the reason it exists: ~2,800 captures a day cannot be done
// serially in one process, and headless Chrome must not share a dyno with
// request handling.
//
//   in-process (default) — fine for development and low volume.
//   external             — set MODULE_WORKER=external and run
//     `npm run module-worker --prefix server` as its own service. Claiming is
//     a compare-and-swap, so replicas are safe.
//   off                  — nothing scheduled fires; the API still serves
//     stored runs and manual ones.
const MODULE_WORKER = (process.env.MODULE_WORKER || 'in-process').toLowerCase();
let moduleWorkerHandle = null;
if (MODULE_WORKER === 'in-process') {
  if (require('./services/db').isDatabaseConfigured()) {
    try {
      moduleWorkerHandle = require('./services/moduleWorker').startLoops({
        executors: require('./services/moduleExecutors'),
      });
    } catch (err) {
      console.error('[moduleWorker] Failed to start:', err.message);
    }
  } else {
    console.log('[moduleWorker] Not started — DATABASE_URL not set.');
  }
} else {
  console.log(`[moduleWorker] Not started in this process (MODULE_WORKER=${MODULE_WORKER}).`);
}

// ── Stale run sweeper ────────────────────────────────────────────────────────
// A run whose process died mid-flight (deploy, crash) would sit at 'running'
// forever. Swept on boot and hourly so the run history only ever shows
// genuinely in-flight work as running.
const STALE_RUN_SWEEP_MS = 60 * 60 * 1000;
function sweepStaleRuns() {
  runStore.sweepStaleRuns({ olderThanMinutes: 120 }).then(count => {
    if (count) console.log(`[runs] Closed ${count} stale run(s) left at 'running'.`);
  });

  // Project module runs too (project_module_runs, migration 0012). These matter
  // more than the generic ones now that POST /api/projects/:id/audit returns
  // 202 and keeps working after the response: a deploy mid-audit leaves rows at
  // 'running', and a module card stuck on "Running…" forever is a worse lie than
  // one that says the run failed.
  //
  // No cutoff is passed: each run records its own deadline from its page budget
  // when it opens. This used to say "30 minutes, because the slowest module
  // measured is under a minute" — true when every module audited one page, and
  // false the moment three of them started auditing the whole crawl. A healthy
  // 10-page SEO & GEO run takes ~22 minutes.
  require('./modules/projects/moduleEvidence')
    .sweepStaleRuns()
    .then((count) => {
      if (count) console.log(`[projects] Failed ${count} abandoned module run(s).`);
    })
    .catch((e) => console.error('[projects] module run sweep failed:', e.message));
}
sweepStaleRuns();
setInterval(sweepStaleRuns, STALE_RUN_SWEEP_MS).unref();

const server = app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`   GOOGLE_API_KEY:    ${process.env.GOOGLE_API_KEY ? '✓' : '✗ missing'}`);
  console.log(`   GOOGLE_CX:         ${process.env.GOOGLE_CX ? '✓' : '✗ missing'}`);
  console.log(`   OPENAI_API_KEY:    ${process.env.OPENAI_API_KEY ? '✓' : '✗ missing'}`);
  console.log(`   ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✓' : '○ optional (Claude Sonnet 5 in Article Enhancer)'}`);
  console.log(`   GEMINI_API_KEY:    ${process.env.GEMINI_API_KEY ? '✓' : '○ optional (Gemini 3.5 Flash in Article Enhancer)'}`);
  console.log(`   SEMRUSH_API_KEY:   ${process.env.SEMRUSH_API_KEY ? '✓' : '✗ missing'}`);
  // APP_USERNAME was reported here until it was the last trace of the removed
  // shared-token login. Nothing read it, no file documented it, and the check
  // could therefore only ever print "✗ missing" — telling every operator their
  // configuration was incomplete and sending them to look for a variable that
  // does not exist. Removed rather than documented: there is nothing to set.
  console.log(`   JWT_SECRET:        ${process.env.JWT_SECRET ? '✓' : '✗ missing'}`);
  console.log(`   DATAFORSEO:        ${process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD ? '✓' : '○ optional (AI Visibility surfaces, Market Potential)'}`);
  console.log(`   GOOGLE_PSI_KEY:    ${process.env.GOOGLE_PSI_API_KEY ? '✓' : '○ optional (PageSpeed)'}`);
  console.log(`   RESEND_API_KEY:    ${process.env.RESEND_API_KEY ? '✓' : '○ optional (CrawlScope report email)'}`);
  console.log(`   CRAWLSCOPE_WORKER: ${CRAWLSCOPE_WORKER}${crawlScopeWorker ? ` (${crawlScopeWorker.workerId})` : ''}`);
  console.log(`   PLATFORM_ADMIN:    ${platformAdmin.bootstrapEmails().join(', ')}`);

});

server.timeout = 180000;

// ── Graceful shutdown ────────────────────────────────────────────────────────
// A CrawlScope crawl can run for many minutes. Killed mid-flight its run row
// sits at 'running' until the reaper reclaims it — recoverable, but it wastes
// the work and re-crawls the site. Draining on SIGTERM lets in-flight crawls
// finish or check-point first. The timeout is the backstop: the platform's stop
// grace window is short, and hanging past it just turns into SIGKILL anyway.
// The drain budget has to fit inside the force-exit, and it did not: the worker's
// own stop drains for up to WORKER_SHUTDOWN_DRAIN_MS (15s) and the API's manager
// for another 20s by default — 35s of draining behind a 15s force-exit, so the
// checkpoint work the drain exists to finish was reliably killed halfway. Rather
// than push the force-exit past the platform's SIGKILL grace (~30s), the drains
// are given explicit budgets that add up to less than it.
const SHUTDOWN_FORCE_MS = Number(process.env.SHUTDOWN_FORCE_MS) || 28_000;
const API_MANAGER_DRAIN_MS = Number(process.env.API_MANAGER_DRAIN_MS) || 11_000;

let shuttingDown = false;
// exitCode is a parameter because not every drain is a success. A SIGTERM is an
// orderly stop and exits 0; a crash must exit non-zero or the platform reads a
// failed boot as a clean one — `listen EADDRINUSE` drained and reported success,
// which is exactly the signal a deploy needs to see fail.
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — draining…`);
  const force = setTimeout(() => {
    console.log('Drain timed out; exiting anyway.');
    process.exit(exitCode);
  }, SHUTDOWN_FORCE_MS);
  force.unref();

  // First, stop taking on new work. This is synchronous and instant, and it was
  // missing entirely: the claim loop kept polling for queued runs throughout the
  // drain, so a shutting-down process could claim a fresh module run seconds
  // before exiting and strand it at 'running' until the reaper found it.
  try {
    if (moduleWorkerHandle) moduleWorkerHandle.stop();
  } catch (err) {
    console.error('[shutdown] moduleWorker:', err.message);
  }

  try {
    // The in-process worker, and the manual runs the API executes itself.
    if (crawlScopeWorker) await crawlScopeWorker.stop();
    if (crawlScopeRoutes.manager) {
      await crawlScopeRoutes.manager.shutdown({ timeoutMs: API_MANAGER_DRAIN_MS });
    }
  } catch (err) {
    console.error('[shutdown]', err.message);
  }
  server.close(() => process.exit(exitCode));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Last-resort process handlers ─────────────────────────────────────────────
// Without these, Node's default for an unhandled rejection is to terminate the
// process: one forgotten `.catch()` anywhere in a crawl, capture or LLM call
// took the whole server down and every in-flight request with it, leaving no
// record of which promise was responsible. Logging and continuing is the right
// trade for a rejection — the process is still coherent.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});

// An uncaught exception is different: state after one is genuinely unknown, so
// the process drains and leaves rather than serving from a corrupt state. The
// platform restarts it, and the run sweepers reconcile whatever was in flight.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
  // A listen failure happens before anything is serving, so there is nothing to
  // drain and no reason to hold the platform's start window open: fail fast and
  // loudly, which is what an EADDRINUSE or a bad port needs to do.
  if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
    console.error(`[uncaughtException] cannot bind port ${PORT} — exiting.`);
    process.exit(1);
  }
  shutdown('uncaughtException', 1).catch(() => process.exit(1));
});
