require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
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
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// General rate limit: 20 requests per minute.
// Skips routers that have their own (higher) limiter, so the call-heavy
// Location Page Builder + KB editor aren't throttled by the global cap.
//
// A router missing from this list keeps its own limiter but is ALSO capped at
// 20/min here, and the global cap wins — which is what happened to
// /api/ai-visibility: it was mounted with lpbLimiter (300/min) and silently
// throttled to 20 anyway. Adding a router below without adding it here gives it
// a limit it does not actually get.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
  skip: (req) => {
    const u = req.originalUrl || req.url || '';
    return u.startsWith('/api/location-page-builder') || u.startsWith('/api/kb') || u.startsWith('/api/modules') || u.startsWith('/api/audit') || u.startsWith('/api/market-potential') || u.startsWith('/api/competitor-tracker') || u.startsWith('/api/content-architect') || u.startsWith('/api/crawl-scope') || u.startsWith('/api/ai-visibility') || u.startsWith('/api/runs') || u.startsWith('/api/projects') || u.startsWith('/api/admin');
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
app.use('/api/crawl-scope',             lpbLimiter, requireAuth, track('crawl-scope'), crawlScopeRoutes);
// No track() wrapper: this is a project module, so its runs are recorded in
// project_module_runs by moduleEvidence rather than in the tool-run table.
app.use('/api/ai-visibility',           lpbLimiter, requireAuth, aiVisibilityRoutes);
app.use('/api/semrush',                 requireAuth, semrushRoutes);
app.use('/api/profile',                 requireAuth, profileRoutes);
app.use('/api/workspaces',              requireAuth, workspaceRoutes);
app.use('/api/runs',                    kbLimiter, requireAuth, runsRoutes);
// Workspace-owned projects (PRD §18.2). Chatty like the other dashboard mounts —
// the home screen loads the project list plus one overview per selected project
// — so it takes the higher limiter rather than the 20/min global one.
app.use('/api/projects',                lpbLimiter, requireAuth, projectsRoutes);
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
app.use(express.static(clientBuild));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuild, 'index.html'));
});

// ── Platform administrator bootstrap (PRD §7.3, AC-002) ──────────────────────
// Idempotent: migration 0011 seeds the same grant, and this re-asserts it on
// every boot so a database restored from an older dump still ends up with an
// administrator. The grant is linked to the person's app_users row at their
// next authenticated login (routes/auth.js), which is the only moment both the
// verified email and the user id are known.
if (require('./services/supabase').isSupabaseConfigured()) {
  platformAdmin.ensureBootstrapGrants()
    .then(({ seeded, skipped }) => {
      if (seeded.length) console.log(`[platformAdmin] Bootstrap grant created for: ${seeded.join(', ')}`);
      if (skipped.length) console.log(`[platformAdmin] Bootstrap grant already present for: ${skipped.join(', ')}`);
    })
    .catch(err => console.error('[platformAdmin] Bootstrap failed:', err.message));
} else {
  console.log('[platformAdmin] Bootstrap skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
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

if (require('./services/supabase').isSupabaseConfigured()) {
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
// Requires Supabase: with no database there is nothing to claim, so it stays
// down rather than logging a failure every poll.
const CRAWLSCOPE_WORKER = (process.env.CRAWLSCOPE_WORKER || 'in-process').toLowerCase();
let crawlScopeWorker = null;
if (CRAWLSCOPE_WORKER === 'in-process') {
  if (require('./services/supabase').isSupabaseConfigured()) {
    try {
      crawlScopeWorker = require('./modules/crawlScope/worker').startLoops({ manageProcess: false });
    } catch (err) {
      console.error('[crawlScope] Worker failed to start:', err.message);
    }
  } else {
    console.log('[crawlScope] Worker not started — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
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
  if (require('./services/supabase').isSupabaseConfigured()) {
    try {
      moduleWorkerHandle = require('./services/moduleWorker').startLoops({
        executors: require('./services/moduleExecutors'),
      });
    } catch (err) {
      console.error('[moduleWorker] Failed to start:', err.message);
    }
  } else {
    console.log('[moduleWorker] Not started — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
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
  console.log(`   APP_USERNAME:      ${process.env.APP_USERNAME ? '✓' : '✗ missing'}`);
  console.log(`   JWT_SECRET:        ${process.env.JWT_SECRET ? '✓' : '✗ missing'}`);
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
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — draining…`);
  const force = setTimeout(() => {
    console.log('Drain timed out; exiting anyway.');
    process.exit(0);
  }, 15000);
  force.unref();
  try {
    // The in-process worker, and the manual runs the API executes itself.
    if (crawlScopeWorker) await crawlScopeWorker.stop();
    if (crawlScopeRoutes.manager) await crawlScopeRoutes.manager.shutdown();
  } catch (err) {
    console.error('[shutdown]', err.message);
  }
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
