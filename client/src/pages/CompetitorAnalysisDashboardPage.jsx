import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Field } from '../ui/Field';
import { Tabs } from '../ui/Tabs';
import { Drawer } from '../ui/Drawer';
import { EmptyState } from '../ui/EmptyState';
import { useToast } from '../ui/Toast';
import { ct } from '../lib/competitorTrackerApi';
import OverviewTab from '../components/competitorAnalysisDashboard/OverviewTab';
import PageSpeedTab from '../components/competitorAnalysisDashboard/PageSpeedTab';
import BacklinkTab from '../components/competitorAnalysisDashboard/BacklinkTab';
import ContentAnalysisTab from '../components/competitorAnalysisDashboard/ContentAnalysisTab';
import DiscoverCompetitorsModal from '../components/competitorAnalysisDashboard/DiscoverCompetitorsModal';
import { useSearchParams } from 'react-router-dom';
import ModuleRuns from '../components/ModuleRuns';
import { useActiveProjectId } from '../lib/activeProject';
import { projectsApi, countryLabel, isModuleInFlight } from '../lib/projectsApi';

const EMPTY_CLIENT_FORM = { name: '', domain: '', country: 'United States', brandName: '' };

// ── This tool's clients, and the app's projects ─────────────────────────────
//
// Competitor Analysis keeps its own client list in a JSON file on the server,
// with its own ids, no workspace scoping and no link to a project. The header's
// client switcher drives something else entirely: `activeProjectId`, a row in
// crawl_projects. Two registries, both called "client", neither aware of the
// other.
//
// So this page defaulted to the first record in its own file, and the header
// could say "Palo Alto Networks" over a dashboard reading Gentle Dental — whose
// project had since been DELETED, which the file never heard about because a
// Supabase delete cannot cascade into it.
//
// The two are matched on the one thing they both know: the host. Nothing is
// written to make the link — no migration, no id column — because the file store
// is on its way out, and a page that reads the join at render time is easier to
// delete later than a schema that encodes it.
const hostKey = (value) => String(value || '')
  .toLowerCase()
  .replace(/^https?:\/\//, '')
  .replace(/^www\./, '')
  .replace(/\/.*$/, '')
  .trim();

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

/** The pill in the data-source band. */
function SourcePill({ tone, children }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', flexShrink: 0, whiteSpace: 'nowrap',
        fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
        padding: '3px 9px', borderRadius: 999,
        background: tone === 'live' ? 'var(--primary)' : 'var(--viz-warn)',
        color: 'var(--text-on-primary)',
      }}
    >
      {children}
    </span>
  );
}

/**
 * One figure about the run itself, not about a domain.
 *
 * On --surface rather than --card: these three sit above the tab strip and
 * describe the run that produced everything below it. As cards they read as the
 * first row of results, which is what made "Last Run" look like a metric.
 */
function RunStat({ label, value, badge, badgeTone }) {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 6, padding: '18px 20px',
        borderRadius: 10, background: 'var(--surface)',
      }}
    >
      <span
        style={{
          fontSize: 10.5, fontFamily: 'var(--font-mono)', fontWeight: 500,
          textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)',
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 22, fontWeight: 700, lineHeight: 1.15, color: 'var(--text)',
            letterSpacing: '-0.02em',
          }}
        >
          {value}
        </span>
        {badge && (
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', padding: '2px 8px',
              borderRadius: 999, fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 500,
              background: badgeTone === 'warn'
                ? 'color-mix(in srgb, var(--viz-warn) 20%, transparent)'
                : 'color-mix(in srgb, var(--primary) 20%, transparent)',
              color: badgeTone === 'warn' ? 'var(--viz-warn)' : 'var(--primary-text)',
            }}
          >
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}

export default function CompetitorAnalysisDashboardPage() {
  const toast = useToast();

  const [meta, setMeta] = useState(null);
  const [clients, setClients] = useState([]);
  // Until the first client read answers, every empty state below would be a
  // guess — and the page used to guess "No client selected", then "No data
  // yet", before the real dashboard arrived.
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState('');

  // The client the header is pointing at, and the projects it resolves against.
  const [activeProjectId] = useActiveProjectId();
  const [projects, setProjects] = useState(null);
  const [settingUpFromProject, setSettingUpFromProject] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  useEffect(() => {
    projectsApi.list()
      .then((d) => setProjects(d.projects || []))
      // Not fatal. Without the project list nothing can be matched, so the page
      // falls back to naming this tool's own clients — which is what it did
      // before there were projects at all.
      .catch(() => setProjects([]));
  }, []);
  const activeProject = useMemo(() => {
    if (!projects?.length) return null;
    return projects.find((p) => p.id === activeProjectId) || projects[0];
  }, [projects, activeProjectId]);
  const activeProjectHost = hostKey(
    activeProject?.primaryDomain?.host || activeProject?.legacyUrl || activeProject?.url,
  );
  // ?client=<id> selects that client on arrival. A project audit mirrors its
  // client into this module's store and links here with its id, so opening the
  // module from the dashboard lands on that project's comparison rather than on
  // whichever client happens to be first.
  const [searchParams] = useSearchParams();
  const requestedClientId = searchParams.get('client');
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
    // A requested id is honoured only when it exists. Internal callers pass ids
    // they just created, but a ?client= from a link can be stale — selecting it
    // blind would show an empty dashboard for a client that is not there.
    const requested = selectId && list.find((c) => c.id === selectId) ? selectId : null;
    if (requested) setSelectedClientId(requested);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Is a project-side comparison already under way? ───────────────────────
  //
  // `competitor` runs on the module queue, and competitorAutostart puts it there
  // the moment a project's domains are set up — so the common case for a project
  // with no client here is not "nobody has started this", it is "it started a
  // minute ago and has not landed yet". Offering "Set up from project" then is
  // worse than saying nothing: the run already exists, and pressing the button
  // creates a second client for the same domain that the finishing run will not
  // write into.
  //
  // Polled rather than pushed, because the run is executed by a worker in
  // another process and this page has no channel to it. Only while something is
  // in flight — once it settles the timer stops.
  const [projectRunStatus, setProjectRunStatus] = useState(null);
  const wasInFlight = useRef(false);

  useEffect(() => {
    const projectId = activeProject?.id;
    if (!projectId) {
      setProjectRunStatus(null);
      wasInFlight.current = false;
      return undefined;
    }

    let cancelled = false;
    let timer = null;

    const read = async () => {
      let status = null;
      try {
        const data = await projectsApi.overview(projectId);
        if (cancelled) return;
        status = (data.modules || []).find((m) => m.key === 'competitor')?.status || null;
      } catch {
        // Not fatal, and not worth an error state: this only decides which of
        // two empty states to show. Treated as "nothing in flight".
        if (cancelled) return;
      }

      setProjectRunStatus(status);

      if (isModuleInFlight(status)) {
        wasInFlight.current = true;
        timer = setTimeout(read, 10_000);
        return;
      }

      // It was running and now it is not: the run mirrors its client and
      // snapshot into this tool's store as it closes, so re-read rather than
      // leaving the reader on an empty page next to a finished run.
      if (wasInFlight.current) {
        wasInFlight.current = false;
        refreshClients().catch(() => {});
      }
    };

    read();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [activeProject?.id, refreshClients]);

  const projectRunInFlight = isModuleInFlight(projectRunStatus);

  // The client for whoever the header is showing.
  const linkedClient = useMemo(() => {
    if (!activeProjectHost) return null;
    return clients.find((c) => hostKey(c.domain) === activeProjectHost) || null;
  }, [clients, activeProjectHost]);

  // Clients this tool holds that no project claims. Kept reachable rather than
  // hidden — the file store predates projects and may hold work nobody has
  // migrated — but never selected on the page's own initiative, which is what
  // put a deleted client's dashboard under another client's name.
  const unlinkedClients = useMemo(() => {
    if (!projects) return [];
    const known = new Set(
      projects.map((p) => hostKey(p.primaryDomain?.host || p.legacyUrl || p.url)).filter(Boolean),
    );
    return clients.filter((c) => !known.has(hostKey(c.domain)));
  }, [clients, projects]);

  // Follow the header. This replaced a fallback to `list[0]` — the first record
  // in a JSON file, in insertion order, with no relationship to anything the
  // reader had chosen.
  //
  // An explicit ?client= wins, because that is somebody linking to one specific
  // comparison. Otherwise: the matched client, or nothing at all. Nothing is the
  // important case — showing a different client's numbers under the active
  // project's name is worse than showing none, and the empty state below says
  // which project has no analysis and offers to create it.
  //
  // Picking an unlinked client by hand sticks — it was deliberate — but only
  // until the header moves. Switching project and keeping the previous choice on
  // screen is the contradiction this whole change exists to remove.
  //
  // A ?client= that does not resolve is IGNORED rather than obeyed. It used to
  // suppress this effect by its mere presence, so a link carrying a client id
  // that no longer exists — every link minted before this tool's store was last
  // reset — left the page permanently unselected: refreshClients rightly refused
  // to select a missing id, and this rightly deferred to a link that was never
  // going to resolve. Between the two, nothing chose anything, and the reader
  // got "no analysis yet" next to a dropdown naming the analysis that was
  // sitting there. Deferring only to a link that actually resolves keeps the
  // deep link authoritative without letting a dead one disable the fallback.
  const requestedClientExists = Boolean(
    requestedClientId && clients.some((c) => c.id === requestedClientId),
  );
  const lastProjectRef = useRef(null);
  useEffect(() => {
    if (requestedClientExists) return;
    if (!projects) return;                     // still resolving; hold
    const projectChanged = lastProjectRef.current !== (activeProject?.id || null);
    lastProjectRef.current = activeProject?.id || null;
    setSelectedClientId((current) => {
      const heldByHand = current && unlinkedClients.some((c) => c.id === current);
      if (heldByHand && !projectChanged) return current;
      return linkedClient?.id || '';
    });
  }, [linkedClient, projects, requestedClientExists, unlinkedClients, activeProject?.id]);

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
    // A requested client is honoured only if it exists; a stale id falls back to
    // the normal first-client behaviour rather than showing an empty dashboard.
    refreshClients(requestedClientId || undefined)
      .catch(() => {})
      .finally(() => setClientsLoaded(true));
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

  // There used to be a "self-heal" effect here that started a PageSpeed refresh
  // whenever a client was opened without usable Page Speed data. Opening a
  // report must not start work: the Page Speed tab's Refresh button does it on
  // request, and a completed "Run Analysis" still refreshes it (see below).

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
  // — does NOT force-refetch domains whose Page Speed is already fresh), and
  // only then: opening a client never starts it. Deliberately does not toast
  // on failure to start — the main run already succeeded and its own toast
  // already fired.
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

  async function handleReclassifyTopPages() {
    if (!selectedClientId || reclassifying) return;
    setReclassifying(true);
    try {
      const data = await ct.reclassifyTopPages(selectedClientId);
      setContentAnalysis(data.contentAnalysis);
      const c = data.contentAnalysis?.topPages?.classifier;
      toast.add({
        title: 'Page types updated',
        description: c ? `${c.classified} of ${c.of} pages classified by ${c.model}.` : undefined,
        variant: 'success',
      });
    } catch (e) {
      toast.add({ title: 'Could not re-classify the pages', description: e.message, variant: 'danger' });
    } finally {
      setReclassifying(false);
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

  // ── Set this tool up from the project it is already looking at ────────────
  //
  // The project knows its primary domain, its market and its competitors —
  // Project Setup collected all three, and this tool was asking for them again
  // through Add Client. So the button fills them in rather than the reader.
  //
  // Competitors are added one call each because that is the API the store
  // exposes, and capped at the tool's own limit: the project can hold more than
  // this module accepts, and createClient would reject the surplus one at a time
  // with a message about a limit the reader never chose.
  const projectCompetitors = (activeProject?.competitors || [])
    .map((c) => c.host)
    .filter(Boolean);

  // Does this tool's competitor list differ from the project's? Compared as
  // bare hosts, and only up to this tool's own limit.
  const [syncingCompetitors, setSyncingCompetitors] = useState(false);
  const bareHost = (d) => hostKey(d).replace(/^www\./, '');
  const wantedHosts = projectCompetitors.slice(0, maxCompetitors).map(bareHost);
  const haveHosts = (client?.competitors || []).map((c) => bareHost(c.domain));
  const competitorDrift = wantedHosts.length > 0 && (
    wantedHosts.some((h) => !haveHosts.includes(h)) || haveHosts.some((h) => !wantedHosts.includes(h))
  );

  async function syncCompetitorsFromProject() {
    if (!client || syncingCompetitors) return;
    setSyncingCompetitors(true);
    const failed = [];
    try {
      // Remove first, so adding never trips the per-client limit.
      for (const comp of client.competitors || []) {
        if (!wantedHosts.includes(bareHost(comp.domain))) {
          // eslint-disable-next-line no-await-in-loop
          try { await ct.removeCompetitor(client.id, comp.id); } catch (e) { failed.push(`${comp.domain} (${e.message})`); }
        }
      }
      for (const host of wantedHosts) {
        if (!haveHosts.includes(host)) {
          // eslint-disable-next-line no-await-in-loop
          try { await ct.addCompetitor(client.id, { domain: host, label: host }); } catch (e) { failed.push(`${host} (${e.message})`); }
        }
      }
      await loadDashboard(client.id);
      toast.add({
        title: failed.length ? 'Competitors partly updated' : 'Now using the project’s competitors',
        description: failed.length
          ? `Not changed: ${failed.join(', ')}.`
          : 'Run an analysis to pull fresh data for them.',
        variant: failed.length ? 'warning' : 'success',
      });
    } finally {
      setSyncingCompetitors(false);
    }
  }

  async function setUpFromProject() {
    if (!activeProject || settingUpFromProject) return;
    const domain = activeProject.primaryDomain?.host
      || hostKey(activeProject.legacyUrl || activeProject.url);
    if (!domain) {
      toast.add({
        title: 'This project has no primary domain',
        description: 'Set one in project settings and come back — there is nothing to analyse without it.',
        variant: 'danger',
      });
      return;
    }
    setSettingUpFromProject(true);
    try {
      const { client: created } = await ct.createClient({
        name: activeProject.name,
        domain,
        country: countryLabel(activeProject.countryCode) || 'United States',
        brandName: activeProject.name,
      });
      const wanted = projectCompetitors.slice(0, maxCompetitors);
      const failed = [];
      for (const host of wanted) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await ct.addCompetitor(created.id, { domain: host, label: host });
        } catch (e) {
          // One rejected competitor must not throw away the client that was just
          // created, or the next attempt hits "domain already exists".
          failed.push(`${host} (${e.message})`);
        }
      }
      await refreshClients(created.id);
      toast.add({
        title: `Competitor analysis set up for ${activeProject.name}`,
        description: failed.length
          ? `${wanted.length - failed.length} of ${wanted.length} competitors added. Not added: ${failed.join(', ')}.`
          : `${wanted.length} competitor${wanted.length === 1 ? '' : 's'} carried over. Run an analysis to pull SEMrush data.`,
        variant: failed.length ? 'warning' : 'success',
      });
    } catch (e) {
      toast.add({ title: 'Could not set it up', description: e.message, variant: 'danger' });
    } finally {
      setSettingUpFromProject(false);
    }
  }

  // Nothing on screen yet: no stored snapshot, no content analysis, and not
  // mid-load. The same condition the "No analysis yet" branch below uses.
  const nothingToShow = !snapshot && !contentAnalysis && !loadingDashboard;
  // Still working out what to show: the client list or the project list has
  // not answered, or the selected client's dashboard is loading for the first
  // time (a reload of an already-shown dashboard keeps it on screen).
  const resolving = !clientsLoaded || projects === null
    || (Boolean(selectedClientId) && loadingDashboard && !snapshot);

  return (
    <div className="ca-report">
      {/* Drawn here rather than with ui/SectionHeader, which puts the title at
          22px. This report's title is 28px, matching the other four report
          pages; bending the shared component to hit that would have moved every
          other screen in the app. */}
      <div
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          gap: 20, flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span
            style={{
              fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
              fontWeight: 600, color: 'var(--primary-text)',
            }}
          >
            Optimize
          </span>
          <h1
            style={{
              margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em',
              color: 'var(--text)',
            }}
          >
            Competitor Analysis
          </h1>
          <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
            Track a client against its competitors — SEMrush data and keyword gaps in one dashboard.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
        </div>
      </div>

      {/* Where the numbers come from, and what it costs. Tinted with the
          accent for live data and the warning colour for simulated, rather than
          the success/warning pair it used: "live" is not an achievement and
          green read as one. The band is the first thing above the figures
          because on a simulated run every figure below it is invented. */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px',
          borderRadius: 10,
          background: meta?.liveDataSource
            ? 'color-mix(in srgb, var(--primary) 10%, var(--card))'
            : 'color-mix(in srgb, var(--viz-warn) 12%, var(--card))',
          border: `1px solid ${meta?.liveDataSource
            ? 'color-mix(in srgb, var(--primary) 40%, var(--border))'
            : 'color-mix(in srgb, var(--viz-warn) 45%, var(--border))'}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.4 }}>
          {meta?.liveDataSource ? (
            <>
              <SourcePill tone="live">Live data</SourcePill>
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
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 260 }}>
          {/* The header's client switcher is the control now, so this names
              what it chose rather than offering a second, contradicting one.
              It stays a select only while this tool holds clients no project
              claims — otherwise there is nothing to choose between. */}
          <Field
            as="select"
            label="Client"
            value={selectedClientId}
            onChange={(e) => setSelectedClientId(e.target.value)}
          >
            {!linkedClient && (
              <option value="" disabled>{resolving ? 'Loading…' : 'No analysis for this project'}</option>
            )}
            {linkedClient && (
              <option value={linkedClient.id}>
                {activeProject?.name || linkedClient.name}
              </option>
            )}
            {unlinkedClients.length > 0 && (
              <optgroup label="Not linked to a project">
                {unlinkedClients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
            )}
          </Field>
        </div>

        {client && (
          <div style={{ fontSize: 13, color: 'var(--text-2)', paddingBottom: 8 }}>
            {client.domain} · {client.competitors.length}/{maxCompetitors} competitors
            {meta && ` · ${meta.estimatedCostPerDomain.toLocaleString()} ${meta.liveDataSource ? 'SEMrush' : 'simulated'} units/domain (10,000-unit cap per run)`}
          </div>
        )}
      </div>

      {/* One competitor list per client (docs/design-audit/02-plan-one-client.md).
          This tool keeps its own list, and it had drifted from the project's —
          Home named three competitors while this page compared a fourth. Say so,
          and offer the project's list; nothing is fetched until the next run. */}
      {client && linkedClient && client.id === linkedClient.id && competitorDrift && (
        <div
          role="status"
          style={{
            margin: '12px 0 4px', padding: '10px 14px', borderRadius: 'var(--r-md)',
            border: '1px solid var(--border)', background: 'var(--surface)',
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 13,
          }}
        >
          <span style={{ flex: '1 1 320px', color: 'var(--text-2)' }}>
            These competitors differ from {activeProject?.name}’s own list
            ({projectCompetitors.slice(0, maxCompetitors).join(', ')}), which the dashboard and other tools use.
          </span>
          <Button size="sm" variant="secondary" loading={syncingCompetitors} onClick={syncCompetitorsFromProject}>
            Use the project’s competitors
          </Button>
        </div>
      )}

      {snapshot && (
        <div className="ca-runstats">
          <RunStat label="Last Run" value={new Date(snapshot.capturedAt).toLocaleString()} />
          <RunStat
            label={meta?.liveDataSource ? 'SEMrush Units Used' : 'Simulated Units Used'}
            value={`${usedUnits.toLocaleString()} / ${capUnits.toLocaleString()}`}
            badge={skipped.length ? `${skipped.length} skipped` : 'All fetched'}
            badgeTone={skipped.length ? 'warn' : 'ok'}
          />
          <RunStat label="Domains Analyzed" value={snapshot.domains.length} />
        </div>
      )}

      {skipped.length > 0 && (
        <div
          style={{
            padding: '14px 18px', borderRadius: 10,
            background: 'color-mix(in srgb, var(--viz-neg) 12%, var(--card))',
            border: '1px solid color-mix(in srgb, var(--viz-neg) 45%, var(--border))',
          }}
        >
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
            <strong>Budget cap reached this run.</strong> {skipped.length} competitor{skipped.length === 1 ? '' : 's'} weren't
            fetched to stay under the 10,000-unit-per-run limit: {skipped.join(', ')}.
          </div>
        </div>
      )}

      {resolving ? (
        <EmptyState title="Loading competitor analysis…" description="Reading this client’s latest comparison." />
      ) : nothingToShow && activeProject && projectRunInFlight ? (
        // A comparison is already on the queue or executing for this project, so
        // this is a wait, not a setup step. Naming the state beats an empty page
        // that reads as "nothing has ever happened here", and it withholds the
        // button rather than inviting a duplicate client for the same domain.
        //
        // Keyed on "there is nothing to show", NOT on "no client is selected".
        // Those differ in the ordinary case: the project-side run CREATES the
        // client first and only stores the snapshot when it finishes, so for most
        // of the run a client is selected and empty. Gated on selection, this
        // panel could never appear then, and the reader was offered Run Analysis
        // for the comparison already running — the duplicate spend this exists to
        // prevent, just one branch further down.
        <EmptyState
          title={`Competitor analysis for ${activeProject.name} is being generated`}
          description={
            (projectRunStatus === 'queued'
              ? 'The run is queued and starts as soon as a worker picks it up. '
              : 'SEMrush data is being pulled for this project and its competitors. ')
            + 'This page updates by itself when the analysis lands — there is nothing to press.'
          }
        />
      ) : !selectedClientId && activeProject ? (
        // Named, and offered. The page used to answer this by quietly showing
        // whichever client came first in the file — so the header said one
        // client and the dashboard reported another's traffic.
        <EmptyState
          title={`No competitor analysis for ${activeProject.name} yet`}
          description={
            activeProject.primaryDomain?.host
              ? `Set it up from this project: ${activeProject.primaryDomain.host}`
                + (projectCompetitors.length
                  ? ` and the ${Math.min(projectCompetitors.length, maxCompetitors)} competitor`
                    + `${Math.min(projectCompetitors.length, maxCompetitors) === 1 ? '' : 's'} already stored on it`
                    + ` (${projectCompetitors.slice(0, maxCompetitors).join(', ')}).`
                  : '. No competitors are stored on this project yet, so add them here afterwards.')
              : 'This project has no primary domain set, so there is nothing to analyse yet.'
          }
          action={(
            <Button
              variant="primary"
              onClick={setUpFromProject}
              loading={settingUpFromProject}
              disabled={!activeProject.primaryDomain?.host}
            >
              Set up from project
            </Button>
          )}
        />
      ) : !selectedClientId ? (
        <EmptyState
          title="No client selected"
          description="Add a client and its competitors to start tracking."
          action={<Button variant="primary" onClick={openAddClient}>Add Client</Button>}
        />
      ) : nothingToShow ? (
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
                onReclassify={handleReclassifyTopPages}
                reclassifying={reclassifying}
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
