import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { getToolByPath } from './toolsMeta';
import { notifyRouteChange } from './lib/agentRunSignal';
import { ThemeProvider } from './components/ThemeContext';
import { ToastProvider } from './ui/Toast';
import MacWindow from './components/MacWindow';
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
import SeoGeoSnapshotPage from './pages/SeoGeoSnapshotPage';
import ContentEnhancementPage from './pages/ContentEnhancementPage';
import ArticleEnhancementPage from './pages/ArticleEnhancementPage';
import ArticleEnhancementLitePage from './pages/ArticleEnhancementLitePage';
import LocationPageBuilderPage from './pages/LocationPageBuilderPage';
import LocationPageDetailPage from './pages/LocationPageDetailPage';
import LocationServiceWizardPage from './pages/LocationServiceWizardPage';
import ClearBehavioralWizardPage from './pages/ClearBehavioralWizardPage';
import CbhFeedbackRulesPage from './pages/CbhFeedbackRulesPage';
import GentleDentalPagesPage from './pages/GentleDentalPagesPage';
import LocationPageBuilderHubPage from './pages/LocationPageBuilderHubPage';
import RobotsMonitorPage from './pages/RobotsMonitorPage';
import OnPageAuditPage from './pages/OnPageAuditPage';
import MarketPotentialPage from './pages/MarketPotentialPage';
import CompetitorAnalysisDashboardPage from './pages/CompetitorAnalysisDashboardPage';
import ContentArchitectPage from './pages/ContentArchitectPage';
import ContentArchitectProjectPage from './pages/ContentArchitectProjectPage';

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
          <Route path="/seo-geo-snapshot" element={<SeoGeoSnapshotPage />} />
          <Route path="/content-enhancement" element={<ContentEnhancementPage />} />
          <Route path="/article-enhancement" element={<ArticleEnhancementPage />} />
          <Route path="/article-enhancement-lite" element={<ArticleEnhancementLitePage />} />
          {/* The front door is a client picker. It used to be the Gentle
              Dental page list, which was fine while dental was the only client
              in the module and hid Clear Behavioral Health completely once it
              was not. The Neuro Wellness pipeline keeps its own dashboard at
              /neuro rather than being removed — it is a separate page_object
              shape with its own detail view and approval flow. */}
          <Route path="/location-page-builder" element={<LocationPageBuilderHubPage />} />
          <Route path="/location-page-builder/wizard" element={<LocationServiceWizardPage />} />
          <Route path="/location-page-builder/gentle-dental" element={<GentleDentalPagesPage />} />
          <Route path="/location-page-builder/clear-behavioral" element={<ClearBehavioralWizardPage />} />
          <Route path="/location-page-builder/clear-behavioral/feedback-rules" element={<CbhFeedbackRulesPage />} />
          {/* Kept so existing links and bookmarks still resolve. */}
          <Route path="/location-page-builder/gentle-dental-pages" element={<GentleDentalPagesPage />} />
          <Route path="/location-page-builder/neuro" element={<LocationPageBuilderPage />} />
          {/* LAST: a bare segment here is a Neuro page id, so every named
              sub-route above must be declared before it. */}
          <Route path="/location-page-builder/:id" element={<LocationPageDetailPage />} />
          <Route path="/robots-monitor" element={<RobotsMonitorPage />} />
          <Route path="/on-page-audit" element={<OnPageAuditPage />} />
          <Route path="/market-potential" element={<MarketPotentialPage />} />
          <Route path="/competitor-analysis" element={<CompetitorAnalysisDashboardPage />} />
          <Route path="/content-architect" element={<ContentArchitectPage />} />
          <Route path="/content-architect/:id" element={<ContentArchitectProjectPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      </ToastProvider>
    </ThemeProvider>
  );
}
