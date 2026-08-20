import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { SectionHeader } from '../ui/SectionHeader';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Field } from '../ui/Field';
import { Card } from '../ui/Card';
import { Tabs } from '../ui/Tabs';
import { Drawer } from '../ui/Drawer';
import { EmptyState } from '../ui/EmptyState';
import { MetricCard } from '../ui/MetricCard';
import { useToast } from '../ui/Toast';
import { ct } from '../lib/competitorTrackerApi';
import { hasUsablePageSpeed } from '../components/competitorAnalysisDashboard/utils';
import OverviewTab from '../components/competitorAnalysisDashboard/OverviewTab';
import PageSpeedTab from '../components/competitorAnalysisDashboard/PageSpeedTab';
import BacklinkTab from '../components/competitorAnalysisDashboard/BacklinkTab';
import ContentAnalysisTab from '../components/competitorAnalysisDashboard/ContentAnalysisTab';
import DiscoverCompetitorsModal from '../components/competitorAnalysisDashboard/DiscoverCompetitorsModal';
import ModuleRuns from '../components/ModuleRuns';

const EMPTY_CLIENT_FORM = { name: '', domain: '', country: 'United States', brandName: '' };

function TabLoadingSpinner() {
  return (
    <>
      <style>{'@keyframes spin-tab { to { transform: rotate(360deg); } }'}</style>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}
           strokeLinecap="round" style={{ animation: 'spin-tab 0.8s linear infinite', color: 'var(--warning)' }}>
        <path d="M21 12a9 9 0 11-9-9" />
      </svg>
    </>
  );
}

export default function CompetitorAnalysisDashboardPage() {
  const toast = useToast();

  const [meta, setMeta] = useState(null);
  const [clients, setClients] = useState([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [client, setClient] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [loadingDashboard, setLoadingDashboard] = useState(false);
  const [running, setRunning] = useState(false);
  const [runningClientId, setRunningClientId] = useState(null);
  const [pageSpeedRunning, setPageSpeedRunning] = useState(false);
  const [pageSpeedRunningClientId, setPageSpeedRunningClientId] = useState(null);
  const [contentAnalysis, setContentAnalysis] = useState(null);
  const [contentAnalysisRunning, setContentAnalysisRunning] = useState(false);
  const [regeneratingTopPages, setRegeneratingTopPages] = useState(false);
  const [regeneratingSitemap, setRegeneratingSitemap] = useState(false);
  const [savingMapping, setSavingMapping] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_CLIENT_FORM);
  const [savedClient, setSavedClient] = useState(null); // client being edited, once persisted
  const [savingClient, setSavingClient] = useState(false);
  const [newCompetitor, setNewCompetitor] = useState({ domain: '', label: '' });
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const pollRef = useRef(null);
  const pageSpeedPollRef = useRef(null);
  const contentAnalysisPollRef = useRef(null);
  const autoPageSpeedFiredRef = useRef(new Set()); // clientIds already self-healed this session

  const TABS = useMemo(() => [
    { key: 'overview', label: 'Overview' },
    { key: 'backlinks', label: 'Authority' },
    { key: 'contentAnalysis', label: 'Content Analysis' },
    {
      key: 'pagespeed',
      label: 'Page Speed',
      badge: (pageSpeedRunning && pageSpeedRunningClientId === selectedClientId) ? <TabLoadingSpinner /> : null,
    },
  ], [pageSpeedRunning, pageSpeedRunningClientId, selectedClientId]);

  const refreshClients = useCallback(async (selectId) => {
    const { clients: list } = await ct.clients();
    setClients(list);
    if (selectId) setSelectedClientId(selectId);
    else if (!selectId && list.length && !list.find((c) => c.id === selectedClientId)) {
      setSelectedClientId(list[0].id);
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDashboard = useCallback(async (clientId) => {
    if (!clientId) { setClient(null); setSnapshot(null); return; }
    setLoadingDashboard(true);
    try {
      const data = await ct.dashboard(clientId);
      setClient(data.client);
      setSnapshot(data.snapshot);
    } catch (e) {
      toast.add({ title: 'Failed to load dashboard', description: e.message, variant: 'danger' });
    } finally {
      setLoadingDashboard(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadContentAnalysis = useCallback(async (clientId) => {
    if (!clientId) { setContentAnalysis(null); return; }
    try {
      const data = await ct.contentAnalysis(clientId);
      setContentAnalysis(data.contentAnalysis);
    } catch {
      setContentAnalysis(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    ct.meta().then(setMeta).catch(() => {});
    refreshClients();
    return () => {
      clearInterval(pollRef.current);
      clearInterval(pageSpeedPollRef.current);
      clearInterval(contentAnalysisPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadDashboard(selectedClientId);
    loadContentAnalysis(selectedClientId);
  }, [selectedClientId, loadDashboard, loadContentAnalysis]);

  // Self-heal for snapshots saved before Page Speed became a background job
  // (or where every domain genuinely failed last time) — fires the
  // cache-respecting background refresh at most once per client per page
  // session, not on every render.
  useEffect(() => {
    if (!snapshot || !selectedClientId || !meta?.pageSpeedEnabled) return;
    if (running && runningClientId === selectedClientId) return;
    if (pageSpeedRunning && pageSpeedRunningClientId === selectedClientId) return;
    if (autoPageSpeedFiredRef.current.has(selectedClientId)) return;
    const domains = snapshot.domains || [];
    if (domains.length && !hasUsablePageSpeed(domains)) {
      autoPageSpeedFiredRef.current.add(selectedClientId);
      triggerBackgroundPageSpeed(selectedClientId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, selectedClientId, meta]);

  function startPolling(clientId) {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await ct.runStatus(clientId);
        if (status.status === 'done') {
          clearInterval(pollRef.current);
          setRunning(false);
          setRunningClientId(null);
          toast.add({ title: 'Analysis complete', variant: 'success' });
          loadDashboard(clientId);
          triggerBackgroundPageSpeed(clientId);
        } else if (status.status === 'error') {
          clearInterval(pollRef.current);
          setRunning(false);
          setRunningClientId(null);
          toast.add({ title: 'Analysis failed', description: status.error, variant: 'danger' });
        }
      } catch { /* transient — keep polling */ }
    }, 1200);
  }

  async function handleRun() {
    if (!selectedClientId) return;
    if (running && runningClientId === selectedClientId) return;
    if (pageSpeedRunning && pageSpeedRunningClientId === selectedClientId) return;
    setRunning(true);
    setRunningClientId(selectedClientId);
    try {
      await ct.run(selectedClientId);
      startPolling(selectedClientId);
    } catch (e) {
      setRunning(false);
      setRunningClientId(null);
      toast.add({ title: 'Could not start run', description: e.message, variant: 'danger' });
    }
  }

  function startPageSpeedPolling(clientId) {
    clearInterval(pageSpeedPollRef.current);
    pageSpeedPollRef.current = setInterval(async () => {
      try {
        const status = await ct.runPageSpeedStatus(clientId);
        if (status.status === 'done') {
          clearInterval(pageSpeedPollRef.current);
          setPageSpeedRunning(false);
          setPageSpeedRunningClientId(null);
          toast.add({ title: 'Page Speed refreshed', variant: 'success' });
          loadDashboard(clientId);
        } else if (status.status === 'error') {
          clearInterval(pageSpeedPollRef.current);
          setPageSpeedRunning(false);
          setPageSpeedRunningClientId(null);
          toast.add({ title: 'Page Speed refresh failed', description: status.error, variant: 'danger' });
        }
      } catch { /* transient — keep polling */ }
    }, 1200);
  }

  // Refreshes only Core Web Vitals for the current client — spends no
  // SEMrush units, independent of (and mutually exclusive with) the main
  // "Run Analysis" action. `force` defaults true (explicit user click always
  // bypasses the 7-day cache).
  async function handleRunPageSpeed() {
    if (!selectedClientId) return;
    if (running && runningClientId === selectedClientId) return;
    if (pageSpeedRunning && pageSpeedRunningClientId === selectedClientId) return;
    setPageSpeedRunning(true);
    setPageSpeedRunningClientId(selectedClientId);
    try {
      await ct.runPageSpeed(selectedClientId);
      startPageSpeedPolling(selectedClientId);
    } catch (e) {
      setPageSpeedRunning(false);
      setPageSpeedRunningClientId(null);
      toast.add({ title: 'Could not start Page Speed refresh', description: e.message, variant: 'danger' });
    }
  }

  // Fires automatically after a successful "Run Analysis" (cache-respecting
  // — does NOT force-refetch domains whose Page Speed is already fresh) and
  // once per session if an existing snapshot has no usable Page Speed at all
  // (see the self-heal effect below). Deliberately does not toast on failure
  // to start — the main run already succeeded and its own toast already fired.
  async function triggerBackgroundPageSpeed(clientId) {
    if (!meta?.pageSpeedEnabled) return;
    if (pageSpeedRunning && pageSpeedRunningClientId === clientId) return;
    setPageSpeedRunning(true);
    setPageSpeedRunningClientId(clientId);
    try {
      await ct.runPageSpeed(clientId, { force: false });
      startPageSpeedPolling(clientId);
    } catch (e) {
      setPageSpeedRunning(false);
      setPageSpeedRunningClientId(null);
      console.warn('Could not auto-start Page Speed refresh', e);
    }
  }

  // Builds and downloads a PDF report from the already-cached snapshot —
  // synchronous, no live SEMrush/PageSpeed calls, just a server-side render.
  async function handleExportReport() {
    if (!selectedClientId || exporting) return;
    setExporting(true);
    try {
      const { blob, filename } = await ct.exportReport(selectedClientId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.add({ title: 'Export failed', description: e.message, variant: 'danger' });
    } finally {
      setExporting(false);
    }
  }

  function startContentAnalysisPolling(clientId) {
    clearInterval(contentAnalysisPollRef.current);
    contentAnalysisPollRef.current = setInterval(async () => {
      try {
        const status = await ct.runContentAnalysisStatus(clientId);
        if (status.status === 'done') {
          clearInterval(contentAnalysisPollRef.current);
          setContentAnalysisRunning(false);
          toast.add({ title: 'Content Analysis complete', variant: 'success' });
          loadContentAnalysis(clientId);
        } else if (status.status === 'error') {
          clearInterval(contentAnalysisPollRef.current);
          setContentAnalysisRunning(false);
          toast.add({ title: 'Content Analysis failed', description: status.error, variant: 'danger' });
        }
      } catch { /* transient — keep polling */ }
    }, 1200);
  }

  // Content Analysis (top-pages content mix + sitemap structure) is a third
  // independent action — its own SEMrush sub-budget for Part 1 only, unrelated
  // to the main dashboard run or the Page Speed refresh.
  async function handleRunContentAnalysis() {
    if (!selectedClientId || contentAnalysisRunning) return;
    setContentAnalysisRunning(true);
    try {
      await ct.runContentAnalysis(selectedClientId);
      startContentAnalysisPolling(selectedClientId);
    } catch (e) {
      setContentAnalysisRunning(false);
      toast.add({ title: 'Could not start Content Analysis', description: e.message, variant: 'danger' });
    }
  }

  async function handleRegenerateTopPagesSummary() {
    if (!selectedClientId || regeneratingTopPages) return;
    setRegeneratingTopPages(true);
    try {
      const data = await ct.regenerateTopPagesSummary(selectedClientId);
      setContentAnalysis(data.contentAnalysis);
    } catch (e) {
      toast.add({ title: 'Could not regenerate summary', description: e.message, variant: 'danger' });
    } finally {
      setRegeneratingTopPages(false);
    }
  }

  async function handleRegenerateSitemapSummary() {
    if (!selectedClientId || regeneratingSitemap) return;
    setRegeneratingSitemap(true);
    try {
      const data = await ct.regenerateSitemapSummary(selectedClientId);
      setContentAnalysis(data.contentAnalysis);
    } catch (e) {
      toast.add({ title: 'Could not regenerate summary', description: e.message, variant: 'danger' });
    } finally {
      setRegeneratingSitemap(false);
    }
  }

  // Save folder-mapping edits — recomputes counts server-side (no crawl/GPT)
  // and returns the updated analysis, which we swap in so charts refresh.
  async function handleSaveMapping(edits) {
    if (!selectedClientId || savingMapping) return;
    setSavingMapping(true);
    try {
      const data = await ct.updateContentAnalysisMapping(selectedClientId, edits);
      setContentAnalysis(data.contentAnalysis);
      toast.add({ title: 'Folder mapping updated', variant: 'success' });
    } catch (e) {
      toast.add({ title: 'Could not update mapping', description: e.message, variant: 'danger' });
    } finally {
      setSavingMapping(false);
    }
  }

  function openAddClient() {
    setForm(EMPTY_CLIENT_FORM);
    setSavedClient(null);
    setDrawerOpen(true);
  }

  function openEditClient() {
    if (!client) return;
    setForm({ name: client.name, domain: client.domain, country: client.country, brandName: client.brandName });
    setSavedClient(client);
    setDrawerOpen(true);
  }

  async function handleSaveClient() {
    if (!form.name.trim() || !form.domain.trim()) {
      toast.add({ title: 'Name and domain are required', variant: 'danger' });
      return;
    }
    setSavingClient(true);
    try {
      const result = savedClient
        ? await ct.updateClient(savedClient.id, form)
        : await ct.createClient(form);
      setSavedClient(result.client);
      const list = await refreshClients(result.client.id);
      if (result.client.id === selectedClientId) loadDashboard(selectedClientId);
      if (!list.find((c) => c.id === selectedClientId)) setSelectedClientId(result.client.id);
      toast.add({ title: 'Client saved', variant: 'success' });
    } catch (e) {
      toast.add({ title: 'Failed to save client', description: e.message, variant: 'danger' });
    } finally {
      setSavingClient(false);
    }
  }

  async function handleDeleteClient() {
    if (!savedClient) return;
    if (!window.confirm(`Delete ${savedClient.name}? This removes its saved data too.`)) return;
    try {
      await ct.deleteClient(savedClient.id);
      setDrawerOpen(false);
      setSelectedClientId('');
      await refreshClients();
      toast.add({ title: 'Client deleted', variant: 'success' });
    } catch (e) {
      toast.add({ title: 'Failed to delete client', description: e.message, variant: 'danger' });
    }
  }

  async function handleAddCompetitor() {
    if (!savedClient || !newCompetitor.domain.trim()) return;
    if (savedClient.competitors.length >= maxCompetitors) return;
    try {
      await ct.addCompetitor(savedClient.id, newCompetitor);
      const { clients: list } = await ct.clients();
      setClients(list);
      setSavedClient(list.find((c) => c.id === savedClient.id));
      setNewCompetitor({ domain: '', label: '' });
      if (savedClient.id === selectedClientId) loadDashboard(selectedClientId);
    } catch (e) {
      toast.add({ title: 'Failed to add competitor', description: e.message, variant: 'danger' });
    }
  }

  async function handleRemoveCompetitor(competitorId) {
    if (!savedClient) return;
    try {
      await ct.removeCompetitor(savedClient.id, competitorId);
      const { clients: list } = await ct.clients();
      setClients(list);
      setSavedClient(list.find((c) => c.id === savedClient.id));
      if (savedClient.id === selectedClientId) loadDashboard(selectedClientId);
    } catch (e) {
      toast.add({ title: 'Failed to remove competitor', description: e.message, variant: 'danger' });
    }
  }

  const usedUnits = snapshot?.usedUnits;
  const capUnits = snapshot?.capUnits ?? meta?.capUnits;
  const skipped = snapshot?.skipped || [];
  const maxCompetitors = meta?.maxCompetitors ?? 4;
  const atCompetitorLimit = (savedClient?.competitors?.length ?? 0) >= maxCompetitors;

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1280, margin: '0 auto' }}>
      <SectionHeader
        eyebrow="Optimize"
        title="Competitor Analysis"
        subtitle="Track a client against its competitors — SEMrush data and keyword gaps in one dashboard."
        actions={(
          <>
            {client && <Button variant="secondary" onClick={openEditClient}>Manage Client</Button>}
            <Button variant="secondary" onClick={openAddClient}>Add Client</Button>
            {client && (
              <Button
                variant="secondary"
                onClick={handleExportReport}
                loading={exporting}
                disabled={!snapshot || (running && runningClientId === selectedClientId)}
              >
                {exporting ? 'Generating…' : 'Download Report'}
              </Button>
            )}
            <Button
              variant="primary"
              onClick={handleRun}
              loading={running && runningClientId === selectedClientId}
              disabled={!selectedClientId || (pageSpeedRunning && pageSpeedRunningClientId === selectedClientId)}
            >
              {running && runningClientId === selectedClientId ? 'Running…' : 'Run Analysis'}
            </Button>
          </>
        )}
      />

      <Card
        style={{
          marginBottom: 20,
          background: meta?.liveDataSource ? 'var(--success-soft)' : 'var(--warning-soft)',
          border: `1px solid ${meta?.liveDataSource ? 'var(--success)' : 'var(--warning)'}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text)' }}>
          {meta?.liveDataSource ? (
            <>
              <Badge variant="success">Live data</Badge>
              <span>
                Pulling real SEMrush data. Every run is hard-capped at 10,000 SEMrush units — competitors
                beyond that cap are skipped, not fetched.
              </span>
            </>
          ) : (
            <>
              <Badge variant="warning">Simulated data</Badge>
              <span>
                SEMrush isn't connected yet — every number here is generated by a mock data provider so the
                dashboard and keyword-gap pipeline can be built and tested with zero API spend. Swapping in
                live SEMrush later is a change to one file (the data provider), not this page.
              </span>
            </>
          )}
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 260 }}>
          <Field
            as="select"
            label="Client"
            value={selectedClientId}
            onChange={(e) => setSelectedClientId(e.target.value)}
          >
            <option value="" disabled>Select a client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Field>
        </div>

        {client && (
          <div style={{ fontSize: 13, color: 'var(--text-2)', paddingBottom: 8 }}>
            {client.domain} · {client.competitors.length}/{maxCompetitors} competitors
            {meta && ` · ${meta.estimatedCostPerDomain.toLocaleString()} ${meta.liveDataSource ? 'SEMrush' : 'simulated'} units/domain (10,000-unit cap per run)`}
          </div>
        )}
      </div>

      {snapshot && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
          <MetricCard label="Last Run" value={new Date(snapshot.capturedAt).toLocaleString()} />
          <MetricCard
            label={meta?.liveDataSource ? 'SEMrush Units Used' : 'Simulated Units Used'}
            value={`${usedUnits.toLocaleString()} / ${capUnits.toLocaleString()}`}
            deltaVariant={skipped.length ? 'warning' : 'success'}
            delta={skipped.length ? `${skipped.length} skipped` : 'All fetched'}
          />
          <MetricCard label="Domains Analyzed" value={snapshot.domains.length} />
        </div>
      )}

      {skipped.length > 0 && (
        <Card style={{ marginBottom: 20, background: 'var(--danger-soft)', border: '1px solid var(--danger)' }}>
          <div style={{ fontSize: 13, color: 'var(--text)' }}>
            <strong>Budget cap reached this run.</strong> {skipped.length} competitor{skipped.length === 1 ? '' : 's'} weren't
            fetched to stay under the 10,000-unit-per-run limit: {skipped.join(', ')}.
          </div>
        </Card>
      )}

      {!selectedClientId ? (
        <EmptyState
          title="No client selected"
          description="Add a client and its competitors to start tracking."
          action={<Button variant="primary" onClick={openAddClient}>Add Client</Button>}
        />
      ) : !snapshot && !contentAnalysis && !loadingDashboard ? (
        <EmptyState
          title="No analysis yet"
          description="Run an analysis to populate this dashboard with (simulated) SEMrush data."
          action={<Button variant="primary" onClick={handleRun} loading={running && runningClientId === selectedClientId}>Run Analysis</Button>}
        />
      ) : (
        <>
          <Tabs tabs={TABS} active={activeTab} onChange={setActiveTab} />
          <div style={{ marginTop: 20 }}>
            {activeTab === 'overview' && <OverviewTab snapshot={snapshot} />}
            {activeTab === 'pagespeed' && (
              <PageSpeedTab
                snapshot={snapshot}
                running={pageSpeedRunning && pageSpeedRunningClientId === selectedClientId}
                disabled={running && runningClientId === selectedClientId}
                onRun={handleRunPageSpeed}
                pageSpeedEnabled={!!meta?.pageSpeedEnabled}
              />
            )}
            {activeTab === 'backlinks' && <BacklinkTab snapshot={snapshot} />}
            {activeTab === 'contentAnalysis' && (
              <ContentAnalysisTab
                contentAnalysis={contentAnalysis}
                running={contentAnalysisRunning}
                onRun={handleRunContentAnalysis}
                regeneratingTopPages={regeneratingTopPages}
                onRegenerateTopPages={handleRegenerateTopPagesSummary}
                regeneratingSitemap={regeneratingSitemap}
                onRegenerateSitemap={handleRegenerateSitemapSummary}
                onSaveMapping={handleSaveMapping}
                savingMapping={savingMapping}
              />
            )}
          </div>
        </>
      )}

      {/* Run history: scoped to the selected client when there is one, so the
          panel answers "what have we run for this client, and when?" */}
      <ModuleRuns
        toolId="competitor-analysis"
        search={selectedClientId ? `client ${selectedClientId}` : ''}
        scopeNote={client ? `Runs for ${client.name}` : ''}
      />

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={savedClient ? 'Manage Client' : 'Add Client'}
        footer={(
          <>
            {savedClient && <Button variant="danger" onClick={handleDeleteClient} style={{ marginRight: 'auto' }}>Delete Client</Button>}
            <Button variant="secondary" onClick={() => setDrawerOpen(false)}>Close</Button>
            <Button variant="primary" onClick={handleSaveClient} loading={savingClient}>Save</Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Client Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme Dental" />
          <Field label="Domain" required value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="acmedental.com" />
          <Field label="Country" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="United States" />
          <Field label="Brand Name" helper="Used for branded-keyword counting" value={form.brandName} onChange={(e) => setForm({ ...form, brandName: e.target.value })} placeholder="Acme" />

          {savedClient && (
            <>
              <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                Competitors ({savedClient.competitors.length}/{maxCompetitors})
              </div>
              {savedClient.competitors.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No competitors added yet.</div>
              )}
              {savedClient.competitors.map((comp) => (
                <div key={comp.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>{comp.label} <span style={{ color: 'var(--text-3)' }}>({comp.domain})</span></span>
                  <Button variant="ghost" size="sm" onClick={() => handleRemoveCompetitor(comp.id)}>Remove</Button>
                </div>
              ))}
              {atCompetitorLimit ? (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  Maximum of {maxCompetitors} competitors reached. Remove one to add another.
                </div>
              ) : (
                <>
                  {meta?.liveDataSource && (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 12,
                    }}>
                      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        Don&apos;t know your competitors? Let SEMrush + AI suggest some
                        {meta?.discoveryCostUnits ? ` (up to ${meta.discoveryCostUnits.toLocaleString()} SEMrush units, separate from the 10,000-unit analysis cap)` : ''}.
                      </div>
                      <Button variant="secondary" size="sm" onClick={() => setDiscoverOpen(true)}>Find Competitors For Me</Button>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <Field label="Competitor Domain" value={newCompetitor.domain} onChange={(e) => setNewCompetitor({ ...newCompetitor, domain: e.target.value })} placeholder="competitor.com" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Field label="Label" value={newCompetitor.label} onChange={(e) => setNewCompetitor({ ...newCompetitor, label: e.target.value })} placeholder="Main Competitor" />
                    </div>
                    <Button variant="secondary" onClick={handleAddCompetitor}>Add</Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </Drawer>

      <DiscoverCompetitorsModal
        open={discoverOpen}
        onClose={() => setDiscoverOpen(false)}
        client={savedClient}
        maxSuggest={maxCompetitors - (savedClient?.competitors?.length ?? 0)}
        onConfirmed={async () => {
          const { clients: list } = await ct.clients();
          setClients(list);
          if (savedClient) setSavedClient(list.find((c) => c.id === savedClient.id));
          if (savedClient?.id === selectedClientId) loadDashboard(selectedClientId);
        }}
      />
    </div>
  );
}
