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
const teamInsightsRoutes = require('./routes/teamInsights');
const competitorAnalysisRoutes = require('./routes/competitorAnalysis');
const agentReadinessAuditRoutes = require('./routes/agentReadinessAudit');
const seoGeoAuditRoutes = require('./routes/seoGeoAudit');
const contentEnhancementRoutes = require('./routes/contentEnhancement');
const articleEnhancementRoutes = require('./routes/articleEnhancement');
const locationPageBuilderRoutes = require('./routes/locationPageBuilder');
const robotsMonitorRoutes = require('./modules/robotsMonitor/routes');
const hubSpokeRoutes = require('./modules/hubSpoke/routes');
const onPageAuditRoutes = require('./modules/onPageAudit/routes');
const marketPotentialRoutes = require('./modules/marketPotential/routes');
const competitorTrackerRoutes = require('./modules/competitorTracker/routes');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// General rate limit: 20 requests per minute.
// Skips routers that have their own (higher) limiter, so the call-heavy
// Location Page Builder + KB editor aren't throttled by the global cap.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
  skip: (req) => {
    const u = req.originalUrl || req.url || '';
    return u.startsWith('/api/location-page-builder') || u.startsWith('/api/kb') || u.startsWith('/api/modules') || u.startsWith('/api/audit') || u.startsWith('/api/market-potential');
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
app.use('/api/kb',                     kbLimiter, requireAuth, kbRoutes);
app.use('/api/modules',                kbLimiter, requireAuth, modulesRoutes);
app.use('/api/audit',                  kbLimiter, requireAuth, auditRoutes);
app.use('/api/kb-context',             kbLimiter, requireAuth, kbContextRoutes);
app.use('/api/keyword-research',       requireAuth, keywordResearchRoutes);
app.use('/api/article-recommendation', requireAuth, articleRecommendationRoutes);
app.use('/api/image-alt-audit',        requireAuth, imageAltAuditRoutes);
app.use('/api/agent-readiness-audit',  requireAuth, agentReadinessAuditRoutes);
app.use('/api/seo-geo-audit',          requireAuth, seoGeoAuditRoutes);
app.use('/api/content-enhancement',     requireAuth, contentEnhancementRoutes);
app.use('/api/article-enhancement',    requireAuth, articleEnhancementRoutes);
app.use('/api/location-page-builder',   lpbLimiter, requireAuth, locationPageBuilderRoutes);
app.use('/api/robots-monitor',          lpbLimiter, requireAuth, robotsMonitorRoutes);
app.use('/api/hub-spoke',               lpbLimiter, requireAuth, hubSpokeRoutes);
app.use('/api/on-page-audit',           lpbLimiter, requireAuth, onPageAuditRoutes);
app.use('/api/market-potential',        lpbLimiter, requireAuth, marketPotentialRoutes);
app.use('/api/competitor-tracker',      lpbLimiter, requireAuth, competitorTrackerRoutes);

// ── SEO team only ────────────────────────────────────────────────────────────
app.use('/api/search',              requireSeo, searchRoutes);
app.use('/api/scrape',              requireSeo, scrapeRoutes);
app.use('/api/analyze',             requireSeo, analyzeRoutes);
app.use('/api/export',              requireSeo, exportRoutes);
app.use('/api/team-insights',       requireSeo, teamInsightsRoutes);
app.use('/api/competitor-analysis', requireSeo, competitorAnalysisRoutes);


// ── Platform auto-login (Position2 Intelligence Platform) ────────────────────
// Intercepts any page load carrying ?pt=<PLATFORM_TOKEN>, sets the JWT session
// cookie server-side, then redirects to the clean URL — all before React renders.
const _jwt = require('jsonwebtoken');
app.use((req, res, next) => {
  const pt = req.query.pt;
  const platformToken = process.env.PLATFORM_TOKEN;
  if (pt && platformToken && pt === platformToken && !req.path.startsWith('/api/')) {
    const secret  = process.env.JWT_SECRET || 'seo-automation-fallback-secret';
    const role    = process.env.PLATFORM_DEFAULT_ROLE || 'seo';
    const token   = _jwt.sign({ username: 'platform_embed', role }, secret, { expiresIn: '7d' });
    const ss      = ((process.env.COOKIE_SAME_SITE || process.env.COOKIE_SAMESITE || 'lax')).toLowerCase();
    const secure  = ss === 'none' ? true : process.env.NODE_ENV !== 'development';
    res.cookie('seo_session', token, { httpOnly: true, secure, sameSite: ss, maxAge: 604800000 });
    const rest    = Object.entries(req.query).filter(([k]) => k !== 'pt').map(([k,v]) => k+'='+v).join('&');
    return res.redirect(302, req.path + (rest ? '?' + rest : ''));
  }
  next();
});

// ── Serve React frontend ─────────────────────────────────────────────────────
const clientBuild = path.join(__dirname, '../client/dist');
app.use(express.static(clientBuild));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuild, 'index.html'));
});

// ── Module schedulers ────────────────────────────────────────────────────────
require('./modules/hubSpoke/store').init().catch(err => {
  console.error('[HubSpoke] Store init failed:', err.message);
});

require('./modules/onPageAudit/store').init().catch(err => {
  console.error('[OnPageAudit] Store init failed:', err.message);
});

require('./modules/marketPotential/store').init().catch(err => {
  console.error('[MarketPotential] Store init failed:', err.message);
});

require('./modules/robotsMonitor/monitorStore').init().then(() => {
  require('./modules/robotsMonitor/monitorScheduler').init().catch(err => {
    console.error('[RobotsMonitor] Scheduler init failed:', err.message);
  });
}).catch(err => {
  console.error('[RobotsMonitor] Store init failed:', err.message);
});

require('./modules/competitorTracker/store').init().then(() => {
  require('./modules/competitorTracker/scheduler').init().catch(err => {
    console.error('[CompetitorTracker] Scheduler init failed:', err.message);
  });
}).catch(err => {
  console.error('[CompetitorTracker] Store init failed:', err.message);
});

const server = app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`   GOOGLE_API_KEY:    ${process.env.GOOGLE_API_KEY ? '✓' : '✗ missing'}`);
  console.log(`   GOOGLE_CX:         ${process.env.GOOGLE_CX ? '✓' : '✗ missing'}`);
  console.log(`   OPENAI_API_KEY:    ${process.env.OPENAI_API_KEY ? '✓' : '✗ missing'}`);
  console.log(`   SEMRUSH_API_KEY:   ${process.env.SEMRUSH_API_KEY ? '✓' : '✗ missing'}`);
  console.log(`   APP_USERNAME:      ${process.env.APP_USERNAME ? '✓' : '✗ missing'}`);
  console.log(`   JWT_SECRET:        ${process.env.JWT_SECRET ? '✓' : '✗ missing'}`);
  console.log(`   GOOGLE_SHEETS_ID:  ${process.env.GOOGLE_SHEETS_ID ? '✓' : '✗ missing (team insights disabled)'}`);
  console.log(`   GOOGLE_PSI_KEY:    ${process.env.GOOGLE_PSI_API_KEY ? '✓' : '○ optional (PageSpeed)'}`);

});

server.timeout = 180000;
