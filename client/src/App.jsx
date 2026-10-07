import { Routes, Route, Navigate, useLocation, useParams, matchRoutes, createRoutesFromChildren } from 'react-router-dom';
import { lazy, useEffect } from 'react';
import { getToolByPath } from './toolsMeta';
import { notifyRouteChange } from './lib/agentRunSignal';
import { ThemeProvider } from './components/ThemeContext';
import { ToastProvider } from './ui/Toast';
import { useAuth } from './context/AuthContext';
import MacWindow from './components/MacWindow';
import LoginPage from './pages/LoginPage';
import ProfileSetupPage from './pages/ProfileSetupPage';

// Every page below is fetched on first navigation rather than shipped in the
// entry bundle. MacWindow already wraps <Outlet /> in <Suspense> (see the note
// above RouteFallback there, which describes routes as code-split); this is the
// half that was never done, so those boundaries had nothing to wait on and the
// whole app -- 36 pages, an Excel writer, a Word writer, a markdown editor and a
// US state map -- was one 3.1 MB chunk that every visitor parsed before the
// login screen could paint.
//
// LoginPage and ProfileSetupPage stay static on purpose: they render above
// <Routes>, outside every Suspense boundary, so a lazy one would throw a promise
// with nothing to catch it -- and the unauthenticated path is the last place to
// add a round trip.
// A lazy page that also exposes its loader, so preloadRoute() below can start
// the chunk download before the page is first rendered.
function page(load) {
  return Object.assign(lazy(load), { preload: load });
}

const WorkspacesPage = page(() => import('./pages/WorkspacesPage'));
const ProjectsPage = page(() => import('./pages/ProjectsPage'));
const AdminPage = page(() => import('./pages/AdminPage'));
const RunsPage = page(() => import('./pages/RunsPage'));
const HomePage = page(() => import('./pages/HomePage'));
const ContentResearchPage = page(() => import('./pages/ContentResearchPage'));
const KeywordResearchPage = page(() => import('./pages/KeywordResearchPage'));
const KeywordResearchPublicPage = page(() => import('./pages/KeywordResearchPublicPage'));
const KnowledgeBasePage = page(() => import('./pages/KnowledgeBasePage'));
const KBEditorPage = page(() => import('./pages/KBEditorPage'));
const CreateKBPage = page(() => import('./pages/CreateKBPage'));
const ModuleAuditPage = page(() => import('./pages/ModuleAuditPage'));
const ClientFeedbackPage = page(() => import('./pages/ClientFeedbackPage'));
const ArticleRecommendationPage = page(() => import('./pages/ArticleRecommendationPage'));
const ContentWriterPage = page(() => import('./pages/ContentWriterPage'));
const ImageAltAuditPage = page(() => import('./pages/ImageAltAuditPage'));
const AgentReadinessAuditPage = page(() => import('./pages/AgentReadinessAuditPage'));
const AgentReadinessSummaryPage = page(() => import('./pages/AgentReadinessSummaryPage'));
const SeoGeoAuditPage = page(() => import('./pages/SeoGeoAuditPage'));
const AiVisibilityPage = page(() => import('./pages/AiVisibilityPage'));
const AiVisibilityLitePage = page(() => import('./pages/AiVisibilityLitePage'));
const ContentEnhancementPage = page(() => import('./pages/ContentEnhancementPage'));
const ArticleEnhancementPage = page(() => import('./pages/ArticleEnhancementPage'));
const ArticleEnhancementLitePage = page(() => import('./pages/ArticleEnhancementLitePage'));
const LocationPageBuilderPage = page(() => import('./pages/LocationPageBuilderPage'));
const LocationPageDetailPage = page(() => import('./pages/LocationPageDetailPage'));
const LocationServiceWizardPage = page(() => import('./pages/LocationServiceWizardPage'));
const GentleDentalPagesPage = page(() => import('./pages/GentleDentalPagesPage'));
const LocationPagesHomePage = page(() => import('./pages/LocationPagesHomePage'));
const ClearBehavioralHealthPage = page(() => import('./pages/ClearBehavioralHealthPage'));
const RobotsMonitorPage = page(() => import('./pages/RobotsMonitorPage'));
const MarketPotentialPage = page(() => import('./pages/MarketPotentialPage'));
const CompetitorAnalysisDashboardPage = page(() => import('./pages/CompetitorAnalysisDashboardPage'));
const ContentArchitectPage = page(() => import('./pages/ContentArchitectPage'));
const ContentArchitectProjectPage = page(() => import('./pages/ContentArchitectProjectPage'));
const CrawlScopePage = page(() => import('./pages/CrawlScopePage'));
const CrawlScopeRunPage = page(() => import('./pages/CrawlScopeRunPage'));

// Keeps the parent Intelligence Platform shell's URL + breadcrumb in sync with
// the tool the user navigates to here. The shell embeds us in a cross-origin
// iframe, so it can't read our location — we push it on every route change.
function RouteBridge() {
  const location = useLocation();
  useEffect(() => {
    const tool = getToolByPath(location.pathname);
    if (tool) notifyRouteChange(tool.id, tool.label, location.pathname);
  }, [location.pathname]);
  return null;
}

// Sends /crawl-scope/runs/:id/review to that run's report, preserving the id.
function CrawlScopeReviewRedirect() {
  const { id } = useParams();
  return <Navigate to={`/crawl-scope/runs/${id}`} replace />;
}

// Defined once, outside App, so preloadRoute() matches against exactly the
// routes <Routes> renders.
const routeTree = (
  <Route element={<MacWindow />}>
    <Route path="/" element={<HomePage />} />
    <Route path="/content-research" element={<ContentResearchPage />} />
    <Route path="/keyword-research" element={<KeywordResearchPage />} />
    <Route path="/keyword-research-public" element={<KeywordResearchPublicPage />} />
    <Route path="/kb" element={<KnowledgeBasePage />} />
    <Route path="/kb/new" element={<CreateKBPage />} />
    <Route path="/kb/audit" element={<ModuleAuditPage />} />
    <Route path="/kb/feedback/new" element={<ClientFeedbackPage />} />
    <Route path="/kb/:id" element={<KBEditorPage />} />
    <Route path="/article-recommendation" element={<ArticleRecommendationPage />} />
    <Route path="/content-writer" element={<ContentWriterPage />} />
    <Route path="/image-alt-audit" element={<ImageAltAuditPage />} />
    <Route path="/agent-readiness-audit" element={<AgentReadinessAuditPage />} />
    <Route path="/agent-readiness-audit/summary" element={<AgentReadinessSummaryPage />} />
    <Route path="/seo-geo-audit" element={<SeoGeoAuditPage />} />
    <Route path="/ai-visibility" element={<AiVisibilityPage />} />
    {/* The API-based sibling. The homepage card points here; the scraped
        module above keeps its own route, its sidebar entry and every
        bookmark that already exists. */}
    <Route path="/ai-visibility-lite" element={<AiVisibilityLitePage />} />
    <Route path="/content-enhancement" element={<ContentEnhancementPage />} />
    <Route path="/article-enhancement" element={<ArticleEnhancementPage />} />
    <Route path="/article-enhancement-lite" element={<ArticleEnhancementLitePage />} />
    {/* This module is used for Gentle Dental, so the Gentle Dental page
        list is the front door. The Neuro Wellness pipeline keeps its own
        dashboard at /neuro rather than being removed — it is a separate
        page_object shape with its own detail view and approval flow. */}
    <Route path="/location-page-builder" element={<LocationPagesHomePage />} />
    <Route path="/location-page-builder/wizard" element={<LocationServiceWizardPage />} />
    {/* Kept so existing links and bookmarks still resolve. */}
    <Route path="/location-page-builder/gentle-dental-pages" element={<GentleDentalPagesPage />} />
    <Route path="/location-page-builder/neuro" element={<LocationPageBuilderPage />} />
    {/* Template-driven clients (docs/ybh-ls-pages.md). One route per
        brand, all rendering the same wizard with a different client id —
        the brand's own facts and budgets are data, not a code path. */}
    <Route path="/location-page-builder/clear-behavioral-health" element={<ClearBehavioralHealthPage />} />
    <Route path="/location-page-builder/:id" element={<LocationPageDetailPage />} />
    <Route path="/robots-monitor" element={<RobotsMonitorPage />} />
    <Route path="/market-potential" element={<MarketPotentialPage />} />
    <Route path="/competitor-analysis" element={<CompetitorAnalysisDashboardPage />} />
    <Route path="/content-architect" element={<ContentArchitectPage />} />
    <Route path="/content-architect/:id" element={<ContentArchitectProjectPage />} />
    <Route path="/crawl-scope" element={<CrawlScopePage />} />
    <Route path="/crawl-scope/runs/:id" element={<CrawlScopeRunPage />} />
    {/* Issue review used to be a screen of its own: the same findings,
        the same four statuses, reached by a button beside the report. The
        triage now happens in the row on an issue's own page inside the
        report, so the old address lands on the report rather than 404ing
        for anyone holding a bookmark. */}
    <Route
      path="/crawl-scope/runs/:id/review"
      element={<CrawlScopeReviewRedirect />}
    />
    <Route path="/workspaces" element={<WorkspacesPage />} />
    <Route path="/projects" element={<ProjectsPage />} />
    {/* Rendered for anyone; the page itself only shows controls after
        /api/admin answers, and every admin route re-checks the grant. */}
    <Route path="/admin" element={<AdminPage />} />
    <Route path="/runs" element={<RunsPage />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Route>
);

/**
 * Starts downloading the page chunk for `pathname` without rendering it.
 *
 * App renders no route until /api/auth/verify answers, so a lazy page's chunk
 * was only requested after that round trip. main.jsx calls this before mount so
 * the two run side by side; lazy() then finds the module already loading.
 */
export function preloadRoute(pathname) {
  const matches = matchRoutes(createRoutesFromChildren(routeTree), pathname);
  const leaf = matches?.[matches.length - 1]?.route.element?.type;
  // A failed preload is not an error worth surfacing: lazy() retries the import
  // on render, and ChunkErrorBoundary handles it there if it fails again.
  leaf?.preload?.().catch(() => {});
}

export default function App() {
  const { authState, hasProfile, checkAuth } = useAuth();

  // Same markup as the splash in index.html, so the hand-over from "JavaScript
  // still downloading" to "checking your session" does not blink. It also
  // stays up while a check that got no answer (rate-limited, server down,
  // offline) is retried — those used to drop the user on the sign-in page.
  if (authState === 'loading' || authState === 'reconnecting') {
    return (
      <div className="app-splash app-splash--shown" role="status" aria-live="polite">
        <span className="app-splash-name">SEO Studio</span>
        <span className="app-splash-note">{authState === 'loading' ? 'Loading…' : 'Reconnecting…'}</span>
      </div>
    );
  }

  // A minute of retries with no answer. Not the sign-in page: nothing says the
  // session is gone, and signing in again would hit the same unreachable server.
  // AuthContext keeps retrying in the background and moves on by itself if the
  // server comes back; the button just asks now.
  if (authState === 'unreachable') {
    return (
      <ThemeProvider>
        <div className="app-splash app-splash--shown" role="alert">
          <span className="app-splash-name">SEO Studio</span>
          <span className="app-splash-note" style={{ maxWidth: 320, textAlign: 'center', lineHeight: 1.5 }}>
            We can't reach SEO Studio right now. Check your connection, then try again.
          </span>
          <button
            type="button"
            onClick={() => { checkAuth(); }}
            style={{
              marginTop: 6,
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </ThemeProvider>
    );
  }

  if (authState === 'unauthenticated') {
    return (
      <ThemeProvider>
        <LoginPage />
      </ThemeProvider>
    );
  }

  if (!hasProfile) {
    return (
      <ThemeProvider>
        <ProfileSetupPage />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <ToastProvider>
      <RouteBridge />
      <Routes>
        {routeTree}
      </Routes>
      </ToastProvider>
    </ThemeProvider>
  );
}
