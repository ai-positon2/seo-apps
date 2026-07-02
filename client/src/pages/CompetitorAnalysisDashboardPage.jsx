import { useState, useEffect, useCallback, useRef } from 'react';
import { SectionHeader, Tabs, Button, Field, EmptyState, useToast } from '../ui';
import { ct } from '../lib/competitorTrackerApi';
import { ClientConfigDrawer } from '../components/competitorTracker/ClientConfigDrawer';
import { CreditsGauge } from '../components/competitorTracker/CreditsGauge';
import { OverviewTab } from '../components/competitorAnalysisDashboard/OverviewTab';
import { PageSpeedTab } from '../components/competitorAnalysisDashboard/PageSpeedTab';
import { KeywordRankingTab } from '../components/competitorAnalysisDashboard/KeywordRankingTab';
import { BrandedTab } from '../components/competitorAnalysisDashboard/BrandedTab';
import { BacklinkTab } from '../components/competitorAnalysisDashboard/BacklinkTab';
import { AIVisibilityTab } from '../components/competitorAnalysisDashboard/AIVisibilityTab';
import { fmtDate } from '../components/competitorAnalysisDashboard/utils';

const TABS = [
  { key: 'overview', label: 'Overall Analysis' },
  { key: 'pageSpeed', label: 'Page Speed' },
  { key: 'keywordRanking', label: 'Keyword Ranking' },
  { key: 'branded', label: 'Branded' },
  { key: 'backlink', label: 'Off-page Metrics' },
  { key: 'aiVisibility', label: 'AI Visibility' },
];

export default function CompetitorAnalysisDashboardPage() {
  const { add: addToast } = useToast();
  const [clients, setClients] = useState([]);
  const [selectedClientId, setSelectedClientId] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingClient, setEditingClient] = useState(null);
  const [running, setRunning] = useState(false);
  const pollRef = useRef(null);

  const showToast = useCallback(({ title, description, variant }) => {
    addToast({ title, description, variant: variant === 'danger' ? 'danger' : variant || 'success' });
  }, [addToast]);

  const loadClients = useCallback(async () => {
    try {
      const list = await ct.clients();
      setClients(list);
      if (!selectedClientId && list.length > 0) setSelectedClientId(list[0].id);
      return list;
    } catch (e) {
      setError(e.message);
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDashboard = useCallback(async (clientId) => {
    if (!clientId) { setDashboard(null); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const data = await ct.dashboard(clientId);
      setDashboard(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadClients(); }, [loadClients]);
  useEffect(() => { loadDashboard(selectedClientId); }, [selectedClientId, loadDashboard]);

  useEffect(() => {
    ct.runStatus().then(s => setRunning(s.isRunning)).catch(() => {});
  }, []);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function pollRunStatus() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await ct.runStatus();
        if (!status.isRunning) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setRunning(false);
          showToast({ title: 'Refresh complete' });
          loadDashboard(selectedClientId);
        }
      } catch {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setRunning(false);
      }
    }, 4000);
  }

  async function handleRefreshNow() {
    try {
      await ct.triggerRun();
      setRunning(true);
      showToast({ title: 'Refresh started', description: 'This can take a minute or two.' });
      pollRunStatus();
    } catch (e) {
      showToast({ title: 'Could not start refresh', description: e.message, variant: 'danger' });
    }
  }

  function handleClientSaved(client) {
    loadClients().then(() => {
      setSelectedClientId(client.id);
      setEditingClient(null);
    });
  }

  function handleClientDeleted(clientId) {
    loadClients().then(list => {
      if (selectedClientId === clientId) {
        setSelectedClientId(list[0]?.id || null);
      }
    });
  }

  const selectedClient = clients.find(c => c.id === selectedClientId);
  const snapshot = dashboard?.snapshot;
  const insights = dashboard?.insights || {};
  const domains = snapshot?.domains || [];

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto', width: '100%', padding: '24px' }}>
      <SectionHeader
        eyebrow="Competitor Analysis"
        title="Competitor Analysis Dashboard"
        subtitle={snapshot ? `Data as of ${fmtDate(snapshot.capturedAt)}` : 'Full competitive picture across SEO, content, and backlinks'}
        actions={
          <>
            <CreditsGauge />
            <Button variant="secondary" onClick={() => { setEditingClient(null); setDrawerOpen(true); }}>+ Add Client</Button>
          </>
        }
      />

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <div style={{ minWidth: 240 }}>
          <Field
            as="select"
            label="Client"
            value={selectedClientId || ''}
            onChange={e => setSelectedClientId(e.target.value)}
          >
            {clients.length === 0 && <option value="">No clients yet</option>}
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Field>
        </div>

        {selectedClient && (
          <>
            <Button variant="secondary" onClick={() => { setEditingClient(selectedClient); setDrawerOpen(true); }}>
              Edit Client
            </Button>
            <Button onClick={handleRefreshNow} loading={running}>
              {running ? 'Refreshing…' : 'Refresh Now'}
            </Button>
            {snapshot && (
              <>
                <Button variant="ghost" onClick={() => window.open(ct.exportCsvUrl(selectedClientId), '_blank')}>
                  Export CSV
                </Button>
                <Button variant="ghost" onClick={() => window.open(ct.exportPdfUrl(selectedClientId), '_blank')}>
                  Export PDF
                </Button>
              </>
            )}
          </>
        )}
      </div>

      {clients.length === 0 && !loading && (
        <EmptyState
          title="No clients yet"
          description="Add a client and up to 3 competitors to start tracking their competitive picture."
          action={<Button onClick={() => setDrawerOpen(true)}>+ Add Client</Button>}
        />
      )}

      {selectedClient && loading && (
        <div style={{ padding: '64px 0', textAlign: 'center', fontSize: 14, color: 'var(--text-3)' }}>Loading…</div>
      )}

      {selectedClient && !loading && error && (
        <div style={{ padding: '16px', background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 'var(--r-lg)', color: 'var(--danger)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {selectedClient && !loading && !error && !snapshot && (
        <EmptyState
          title="No data yet"
          description="Run a refresh to pull SEMrush and PageSpeed data for this client and its competitors."
          action={<Button onClick={handleRefreshNow} loading={running}>{running ? 'Refreshing…' : 'Refresh Now'}</Button>}
        />
      )}

      {selectedClient && !loading && snapshot && (
        <>
          {snapshot.budgetExceeded && snapshot.skipped?.length > 0 && (
            <div style={{
              marginBottom: 16,
              padding: '10px 14px',
              background: 'var(--warning-soft)',
              border: '1px solid var(--warning)',
              borderRadius: 'var(--r-lg)',
              fontSize: 12,
              color: 'var(--text-2)',
            }}>
              Daily SEMrush credit cap was reached during the last refresh — {snapshot.skipped.join(', ')} weren't updated. They'll be picked up on the next run.
            </div>
          )}

          <Tabs tabs={TABS} active={activeTab} onChange={setActiveTab} />
          <div style={{ marginTop: 20 }}>
            {activeTab === 'overview' && <OverviewTab snapshot={snapshot} insight={insights.overall} />}
            {activeTab === 'pageSpeed' && <PageSpeedTab snapshot={snapshot} insight={insights.pageSpeed} />}
            {activeTab === 'keywordRanking' && <KeywordRankingTab snapshot={snapshot} insight={insights.keywordRanking} />}
            {activeTab === 'branded' && <BrandedTab snapshot={snapshot} insight={insights.branded} />}
            {activeTab === 'backlink' && <BacklinkTab snapshot={snapshot} insight={insights.backlink} />}
            {activeTab === 'aiVisibility' && (
              <AIVisibilityTab
                clientId={selectedClientId}
                domains={domains}
                aiVisibility={dashboard.aiVisibility}
                insight={insights.aiVisibility}
                showToast={showToast}
                onSaved={() => loadDashboard(selectedClientId)}
              />
            )}
          </div>
        </>
      )}

      <ClientConfigDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        client={editingClient}
        onSaved={handleClientSaved}
        onDeleted={handleClientDeleted}
      />
    </div>
  );
}
