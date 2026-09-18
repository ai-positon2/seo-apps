import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
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
const WorkspacesPage = lazy(() => import('./pages/WorkspacesPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const RunsPage = lazy(() => import('./pages/RunsPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const ContentResearchPage = lazy(() => import('./pages/ContentResearchPage'));
const KeywordResearchPage = lazy(() => import('./pages/KeywordResearchPage'));
const KeywordResearchPublicPage = lazy(() => import('./pages/KeywordResearchPublicPage'));
const KnowledgeBasePage = lazy(() => import('./pages/KnowledgeBasePage'));
const KBEditorPage = lazy(() => import('./pages/KBEditorPage'));
const CreateKBPage = lazy(() => import('./pages/CreateKBPage'));
const ModuleAuditPage = lazy(() => import('./pages/ModuleAuditPage'));
const ClientFeedbackPage = lazy(() => import('./pages/ClientFeedbackPage'));
const ArticleRecommendationPage = lazy(() => import('./pages/ArticleRecommendationPage'));
const ImageAltAuditPage = lazy(() => import('./pages/ImageAltAuditPage'));
const AgentReadinessAuditPage = lazy(() => import('./pages/AgentReadinessAuditPage'));
const AgentReadinessSummaryPage = lazy(() => import('./pages/AgentReadinessSummaryPage'));
const SeoGeoAuditPage = lazy(() => import('./pages/SeoGeoAuditPage'));
const AiVisibilityPage = lazy(() => import('./pages/AiVisibilityPage'));
const AiVisibilityLitePage = lazy(() => import('./pages/AiVisibilityLitePage'));
const ContentEnhancementPage = lazy(() => import('./pages/ContentEnhancementPage'));
const ArticleEnhancementPage = lazy(() => import('./pages/ArticleEnhancementPage'));
const ArticleEnhancementLitePage = lazy(() => import('./pages/ArticleEnhancementLitePage'));
const LocationPageBuilderPage = lazy(() => import('./pages/LocationPageBuilderPage'));
const LocationPageDetailPage = lazy(() => import('./pages/LocationPageDetailPage'));
const LocationServiceWizardPage = lazy(() => import('./pages/LocationServiceWizardPage'));
const GentleDentalPagesPage = lazy(() => import('./pages/GentleDentalPagesPage'));
const ClearBehavioralHealthPage = lazy(() => import('./pages/ClearBehavioralHealthPage'));
const RobotsMonitorPage = lazy(() => import('./pages/RobotsMonitorPage'));
const MarketPotentialPage = lazy(() => import('./pages/MarketPotentialPage'));
const CompetitorAnalysisDashboardPage = lazy(() => import('./pages/CompetitorAnalysisDashboardPage'));
const ContentArchitectPage = lazy(() => import('./pages/ContentArchitectPage'));
const ContentArchitectProjectPage = lazy(() => import('./pages/ContentArchitectProjectPage'));
const CrawlScopePage = lazy(() => import('./pages/CrawlScopePage'));
const CrawlScopeRunPage = lazy(() => import('./pages/CrawlScopeRunPage'));

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

export default function App() {
  const { authState, hasProfile } = useAuth();

  if (authState === 'loading') {
    return <div style={{ height: '100vh', background: 'var(--bg)' }} />;
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
          <Route path="/location-page-builder" element={<GentleDentalPagesPage />} />
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
      </Routes>
      </ToastProvider>
    </ThemeProvider>
  );
}
