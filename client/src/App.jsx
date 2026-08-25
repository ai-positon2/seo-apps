import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { getToolByPath } from './toolsMeta';
import { notifyRouteChange } from './lib/agentRunSignal';
import { ThemeProvider } from './components/ThemeContext';
import { ToastProvider } from './ui/Toast';
import { useAuth } from './context/AuthContext';
import MacWindow from './components/MacWindow';
import LoginPage from './pages/LoginPage';
import ProfileSetupPage from './pages/ProfileSetupPage';
import WorkspacesPage from './pages/WorkspacesPage';
import ProjectsPage from './pages/ProjectsPage';
import AdminPage from './pages/AdminPage';
import RunsPage from './pages/RunsPage';
import HomePage from './pages/HomePage';
import ContentResearchPage from './pages/ContentResearchPage';
import KeywordResearchPage from './pages/KeywordResearchPage';
import KeywordResearchPublicPage from './pages/KeywordResearchPublicPage';
import KnowledgeBasePage from './pages/KnowledgeBasePage';
import KBEditorPage from './pages/KBEditorPage';
import CreateKBPage from './pages/CreateKBPage';
import ModuleAuditPage from './pages/ModuleAuditPage';
import ClientFeedbackPage from './pages/ClientFeedbackPage';
import ArticleRecommendationPage from './pages/ArticleRecommendationPage';
import ImageAltAuditPage from './pages/ImageAltAuditPage';
import AgentReadinessAuditPage from './pages/AgentReadinessAuditPage';
import AgentReadinessSummaryPage from './pages/AgentReadinessSummaryPage';
import SeoGeoAuditPage from './pages/SeoGeoAuditPage';
import ContentEnhancementPage from './pages/ContentEnhancementPage';
import ArticleEnhancementPage from './pages/ArticleEnhancementPage';
import ArticleEnhancementLitePage from './pages/ArticleEnhancementLitePage';
import LocationPageBuilderPage from './pages/LocationPageBuilderPage';
import LocationPageDetailPage from './pages/LocationPageDetailPage';
import LocationServiceWizardPage from './pages/LocationServiceWizardPage';
import GentleDentalPagesPage from './pages/GentleDentalPagesPage';
import RobotsMonitorPage from './pages/RobotsMonitorPage';
import MarketPotentialPage from './pages/MarketPotentialPage';
import CompetitorAnalysisDashboardPage from './pages/CompetitorAnalysisDashboardPage';
import ContentArchitectPage from './pages/ContentArchitectPage';
import ContentArchitectProjectPage from './pages/ContentArchitectProjectPage';
import CrawlScopePage from './pages/CrawlScopePage';
import CrawlScopeRunPage from './pages/CrawlScopeRunPage';
import CrawlScopeReviewPage from './pages/CrawlScopeReviewPage';

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
          <Route path="/content-enhancement" element={<ContentEnhancementPage />} />
          <Route path="/article-enhancement" element={<ArticleEnhancementPage />} />
          <Route path="/article-enhancement-lite" element={<ArticleEnhancementLitePage />} />
          <Route path="/location-page-builder" element={<LocationPageBuilderPage />} />
          <Route path="/location-page-builder/wizard" element={<LocationServiceWizardPage />} />
          <Route path="/location-page-builder/gentle-dental-pages" element={<GentleDentalPagesPage />} />
          <Route path="/location-page-builder/:id" element={<LocationPageDetailPage />} />
          <Route path="/robots-monitor" element={<RobotsMonitorPage />} />
          <Route path="/market-potential" element={<MarketPotentialPage />} />
          <Route path="/competitor-analysis" element={<CompetitorAnalysisDashboardPage />} />
          <Route path="/content-architect" element={<ContentArchitectPage />} />
          <Route path="/content-architect/:id" element={<ContentArchitectProjectPage />} />
          <Route path="/crawl-scope" element={<CrawlScopePage />} />
          <Route path="/crawl-scope/runs/:id" element={<CrawlScopeRunPage />} />
          <Route path="/crawl-scope/runs/:id/review" element={<CrawlScopeReviewPage />} />
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
