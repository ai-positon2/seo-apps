import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SectionHeader } from '../ui/SectionHeader';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { DataTable } from '../ui/DataTable';
import { ProgressSteps } from '../ui/ProgressSteps';
import { useToast } from '../ui/Toast';
import ModuleRuns from '../components/ModuleRuns';
import HubSpokeReport, { healthVariant } from '../components/contentArchitect/HubSpokeReport';
import { ca } from '../lib/contentArchitectApi';
import { useActiveProjectId } from '../lib/activeProject';
import { useActiveProject } from '../lib/useActiveProject';
import { projectsApi } from '../lib/projectsApi';

const DISCOVER_STEPS = [
  { id: 'sitemap', label: 'Find sitemap' },
  { id: 'crawl-fallback', label: 'Crawl fallback' },
  { id: 'patterns', label: 'Group patterns' },
  { id: 'classify', label: 'Classify page types' },
];

const ANALYZE_STEPS = [
  { id: 'crawl', label: 'Read pages' },
  { id: 'linkgraph', label: 'Map internal links' },
  { id: 'cluster', label: 'Group into topics' },
  { id: 'naming', label: 'Name clusters' },
  { id: 'hubs', label: 'Select hub pages' },
  { id: 'diagnostics', label: 'Run diagnostics' },
  { id: 'relevance', label: 'Assess freshness' },
];

const CLASSIFICATION_META = {
  article: { label: 'Article', variant: 'success' },
  service: { label: 'Service', variant: 'info' },
  location: { label: 'Location', variant: 'info' },
  exclude: { label: 'Exclude', variant: 'danger' },
  static: { label: 'Static', variant: 'neutral' },
  // Staff, team, provider and leadership pages. Its own category rather than
  // folding into Article, which is what a bare {slug} pattern with no other
  // signal used to default to — see PEOPLE_TERMS in patternClassifier.js.
  people: { label: 'People', variant: 'neutral' },
  // Genuinely unclassifiable: neither the keyword rules nor the AI pass could
  // place the pattern. Site-specific page types don't get their own category —
  // that list would never stop growing — so they land here, unchecked by
  // default, for the user to glance at rather than being auto-included.
  unknown: { label: 'Other', variant: 'warning' },
};

const VERTICAL_OPTIONS = ['dental', 'healthcare', 'legal', 'saas', 'ecommerce', 'home-services', 'other'];

// Short nouns for the exclusion codes informationalSelection.js records, for a
// one-line "Left out: 216 location · 77 service · 121 people" summary. The full
// labels, and every URL, are in the Excel "Excluded" tab.
const LEFT_OUT_NOUNS = {
  location: 'location',
  service: 'service & product',
  people: 'people',
  listing: 'listing',
  news: 'news & events',
  media: 'podcast & video',
  other: 'other',
  not_indexable: 'noindex',
  canonical_elsewhere: 'canonicalised',
  canonical_to_homepage: 'canonical to homepage',
  parameterised: 'parameterised',
  paginated: 'paginated',
  duplicate: 'duplicate',
  other_language: 'other language',
  utility: 'form & confirmation',
  homepage: 'homepage',
  unknown: 'unclassified',
  unclassified: 'unjudged',
  not_checked: 'not yet checked',
};

function leftOutLine(excludedByReason = [], shown = 5) {
  const reasons = excludedByReason || [];
  const head = reasons.slice(0, shown).map((r) => `${r.count} ${LEFT_OUT_NOUNS[r.code] || String(r.label || r.code).toLowerCase()}`);
  const restCount = reasons.slice(shown).reduce((sum, r) => sum + (Number(r.count) || 0), 0);
  if (restCount) head.push(`${restCount} more`);
  return head.join(' · ');
}

export default function ContentArchitectProjectPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [activeProjectId, setActiveProjectId] = useActiveProjectId();

  const [project, setProject] = useState(null);
  const [screen, setScreen] = useState('loading'); // loading | discovering | patterns | analyzing | results
  const [steps, setSteps] = useState({});
  const [error, setError] = useState(null);
  const [patterns, setPatterns] = useState([]);
  const [vertical, setVertical] = useState(null);
  const [discoverMeta, setDiscoverMeta] = useState(null);
  const [saving, setSaving] = useState(false);
  const [analyzeSteps, setAnalyzeSteps] = useState({});
  const [analysis, setAnalysis] = useState(null);
  // Which pages/topics in the current analysis already have a completed
  // Enhance/Recommend run — refetched whenever the analysis changes (a new
  // suggested topic needs checking too), never blocking the report itself.
  const [actionStatus, setActionStatus] = useState({ enhancedUrls: {}, recommendedTopics: {} });
  const [exportingFormat, setExportingFormat] = useState(null);
  const [competitorsText, setCompetitorsText] = useState('');
  const [savingCompetitors, setSavingCompetitors] = useState(false);
  const esRef = useRef(null);
  const startedRef = useRef(false);

  useEffect(() => () => esRef.current?.close(), []);

  useEffect(() => {
    if (!analysis) return;
    let cancelled = false;
    ca.getActionStatus(id).then((status) => { if (!cancelled) setActionStatus(status); }).catch(() => {});
    return () => { cancelled = true; };
  }, [analysis, id]);

  // Set once here, reused automatically by every "Suggest spokes" click after
  // this — not re-asked per suggestion request.
  // One competitor list per client (docs/design-audit/02-plan-one-client.md):
  // an analysis with none of its own starts from its project's competitors,
  // instead of asking for domains the project already holds.
  const { project: platformProject } = useActiveProject();
  const projectCompetitors = (platformProject?.id && platformProject.id === project?.platformProjectId
    ? (platformProject.competitors || []) : [])
    .map((c) => (typeof c === 'string' ? c : c?.host || c?.domain || c?.normalized_origin || ''))
    .map((c) => String(c).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  const competitorsFromProject = !(project?.competitors || []).length && projectCompetitors.length > 0;
  useEffect(() => {
    const own = project?.competitors || [];
    setCompetitorsText((own.length ? own : projectCompetitors).join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, projectCompetitors.join(',')]);

  async function saveCompetitors() {
    setSavingCompetitors(true);
    try {
      const competitors = competitorsText.split(',').map((s) => s.trim()).filter(Boolean);
      const updated = await ca.setCompetitors(id, competitors);
      setProject(updated);
      toast.add({ title: 'Competitors saved', description: 'Used automatically by "Suggest new spokes".' });
    } catch (e) {
      toast.add({ title: 'Save failed', description: e.message, variant: 'danger' });
    } finally {
      setSavingCompetitors(false);
    }
  }

  useEffect(() => {
    if (project?.platformProjectId && activeProjectId
      && activeProjectId !== project.platformProjectId) navigate('/content-architect');
  }, [activeProjectId, project?.platformProjectId, navigate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const proj = await ca.getProject(id);
        if (cancelled) return;
        setProject(proj);
        if (proj.platformProjectId) {
          if (!activeProjectId) setActiveProjectId(proj.platformProjectId);
          const existingAnalysis = await ca.getFullAnalysis(id).catch(() => null);
          if (cancelled) return;
          if (existingAnalysis) {
            setAnalysis(existingAnalysis);
            setScreen('results');
          } else {
            navigate('/content-architect', { replace: true });
          }
          return;
        }
        if (proj.workflowState === 'created') {
          if (!startedRef.current) { startedRef.current = true; startDiscovery(); }
        } else {
          setVertical(proj.vertical);
          const existing = await ca.getPatterns(id).catch(() => null);
          setPatterns(existing || []);
          const existingAnalysis = await ca.getFullAnalysis(id).catch(() => null);
          if (existingAnalysis) {
            setAnalysis(existingAnalysis);
            setScreen('results');
          } else {
            // Discovery finished (or was interrupted) without ever reaching a
            // saved analysis — most likely the tab closed mid auto-run. Land
            // in the pattern editor so "Confirm Patterns" can kick the
            // pipeline off again, rather than showing nothing.
            setScreen('patterns');
          }
        }
      } catch (e) {
        if (cancelled) return;
        // No such analysis — or one this user may not see, which the server
        // answers identically. Every way here is a link: the dashboard card, the
        // module panel, a bookmark. Before 0032 some of those ids named a file on
        // another machine that no longer has it, so the link outlived its
        // report. The tool page reconnects the active project and says what to
        // do next; an error with a Retry that retries the same missing id does not.
        if (e.status === 404) {
          navigate('/content-architect', { replace: true, state: { missingAnalysis: true } });
          return;
        }
        setError(e.message);
      }
    })();
    return () => { cancelled = true; esRef.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function refreshProjectAnalysis() {
    try {
      await projectsApi.connectContentArchitect(project.platformProjectId, { retry: true });
      navigate('/content-architect');
    } catch (e) {
      toast.add({ title: 'Could not start analysis', description: e.message, variant: 'danger' });
    }
  }

  async function startDiscovery() {
    setScreen('discovering');
    setError(null);
    setSteps({});
    try {
      const { token } = await ca.discoverInit(id);
      const es = new EventSource(ca.discoverStreamUrl(id, token));
      esRef.current = es;
      es.addEventListener('step', (e) => {
        const d = JSON.parse(e.data);
        setSteps((prev) => ({ ...prev, [d.id]: { status: d.status, message: d.message } }));
      });
      es.addEventListener('ready', (e) => {
        const d = JSON.parse(e.data);
        setPatterns(d.patterns);
        setVertical(d.vertical);
        setDiscoverMeta(d);
        // No manual confirmation gate — discovery flows straight into
        // analysis using the classifier's own pattern selection. Anyone who
        // wants to change what's included can still do so from the results
        // screen's "Edit Pattern Selection".
        runAnalysisFor(d.patterns, d.vertical);
      });
      es.addEventListener('fail', (e) => {
        const d = JSON.parse(e.data);
        setError(d.message);
      });
      es.addEventListener('done', () => es.close());
      es.onerror = () => es.close();
    } catch (e) {
      setError(e.message);
    }
  }

  function toggleIncluded(pattern) {
    setPatterns((prev) => prev.map((p) => (p.pattern === pattern ? { ...p, included: !p.included } : p)));
  }

  // Saves the given pattern selection, then runs full analysis directly — no
  // intermediate draft-clustering preview to click through. Used both right
  // after discovery (automatically) and from the pattern editor's "Confirm
  // Patterns" button (manually, after an edit).
  async function runAnalysisFor(patternsArg, verticalArg) {
    setSaving(true);
    try {
      await ca.savePatterns(id, patternsArg.map((p) => ({ pattern: p.pattern, included: p.included })), verticalArg);
    } catch (e) {
      toast.add({ title: 'Save failed', description: e.message, variant: 'danger' });
      setSaving(false);
      setScreen('patterns');
      return;
    }
    setSaving(false);
    await startAnalysis();
  }

  function confirmPatterns() {
    return runAnalysisFor(patterns, vertical);
  }

  async function startAnalysis() {
    setScreen('analyzing');
    setError(null);
    setAnalyzeSteps({});
    try {
      const { token } = await ca.analyzeInit(id);
      const es = new EventSource(ca.analyzeStreamUrl(id, token));
      esRef.current = es;
      es.addEventListener('step', (e) => {
        const d = JSON.parse(e.data);
        setAnalyzeSteps((prev) => ({ ...prev, [d.id]: d.message }));
      });
      es.addEventListener('ready', async () => {
        try {
          const full = await ca.getFullAnalysis(id);
          setAnalysis(full);
          setScreen('results');
        } catch (e) {
          setError(e.message);
          setScreen('patterns');
        }
      });
      es.addEventListener('fail', (e) => {
        const d = JSON.parse(e.data);
        setError(d.message);
        setScreen('patterns');
      });
      es.addEventListener('done', () => es.close());
      es.onerror = () => es.close();
    } catch (e) {
      setError(e.message);
      setScreen('patterns');
    }
  }

  async function downloadExport(format) {
    setExportingFormat(format);
    try {
      const { blob, filename } = await ca.exportFile(id, format);
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
      setExportingFormat(null);
    }
  }

  const totalUrls = patterns.reduce((sum, p) => sum + p.count, 0);
  const selectedUrls = patterns.filter((p) => p.included).reduce((sum, p) => sum + p.count, 0);

  const progressSteps = DISCOVER_STEPS
    .filter((s) => steps[s.id])
    .map((s) => ({ label: s.label, status: steps[s.id]?.status === 'done' ? 'done' : 'active' }));

  const lastSeenAnalyzeIndex = ANALYZE_STEPS.reduce((last, s, i) => (analyzeSteps[s.id] !== undefined ? i : last), -1);
  const currentAnalyzeStageId = lastSeenAnalyzeIndex >= 0 ? ANALYZE_STEPS[lastSeenAnalyzeIndex].id : null;
  const analyzeProgressSteps = ANALYZE_STEPS.map((s, i) => ({
    label: s.label,
    status: i < lastSeenAnalyzeIndex ? 'done' : i === lastSeenAnalyzeIndex ? 'active' : 'pending',
  }));

  const pageById = useMemo(() => new Map((analysis?.pages || []).map((p) => [p.id, p])), [analysis]);
  const estimatedCount = analysis?.pages.filter((p) => p.estimated).length || 0;
  const meanHealth = analysis?.clusters.length
    ? Math.round(analysis.clusters.reduce((s, c) => s + (c.health || 0), 0) / analysis.clusters.length)
    : 0;

  const orphanCount = analysis?.pages.filter((p) => (p.flags || []).includes('orphan')).length || 0;
  const totalSpokes = analysis?.clusters.reduce((s, c) => s + c.spokeIds.length, 0) || 0;
  const pctUnassigned = analysis
    ? Math.round((100 * analysis.unassignedPages.length) / Math.max(1, analysis.pages.length))
    : 0;

  // A project-linked analysis clusters only the crawl's informational pages and
  // records what it left out. Said next to the page count, because "12 pages
  // analysed" on a 590-page site reads as a broken crawl unless it says why.
  const selectionSummary = analysis?.selection?.summary || null;
  const leftOut = selectionSummary ? leftOutLine(selectionSummary.excludedByReason) : '';

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <SectionHeader
        eyebrow="Build · Content Architect"
        title={project?.name || 'Loading…'}
        subtitle={project?.domain}
        actions={<Button variant="secondary" onClick={() => navigate('/content-architect')}>All Projects</Button>}
      />

      {error && (
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: 'var(--danger)', flex: 1, fontSize: 13 }}>{error}</span>
            <Button variant="secondary" size="sm" onClick={project?.platformProjectId ? () => navigate('/content-architect') : startDiscovery}>Retry</Button>
          </div>
        </Card>
      )}

      {screen === 'loading' && !error && <EmptyState title="Loading project…" />}

      {screen === 'discovering' && (
        <Card>
          <div style={{ marginBottom: 16 }}>
            <ProgressSteps steps={progressSteps.length ? progressSteps : [{ label: 'Starting…', status: 'active' }]} layout="vertical" />
          </div>
          {Object.entries(steps).map(([k, v]) => (
            <div key={k} style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>{v.message}</div>
          ))}
        </Card>
      )}

      {screen === 'patterns' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {discoverMeta?.capped && (
            <Card style={{ background: 'var(--warning-soft)' }}>
              <div style={{ fontSize: 13 }}>
                Hit the <strong>{discoverMeta.capReason}</strong> limit while reading the sitemap — results may be a partial sample.
              </div>
            </Card>
          )}
          {discoverMeta?.skippedSitemaps?.length > 0 && (
            <Card>
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                Skipped {discoverMeta.skippedSitemaps.length} sitemap file(s) that couldn't be read (media sitemaps, broken links, etc.) — this is normal.
              </div>
            </Card>
          )}

          <Card>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Detected vertical:</span>
                <select
                  value={vertical || 'other'}
                  onChange={(e) => setVertical(e.target.value)}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 'var(--r-md)', border: '1px solid var(--border-strong)', background: 'var(--card)', color: 'var(--text)' }}
                >
                  {VERTICAL_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  Analyzing {selectedUrls.toLocaleString()} of {totalUrls.toLocaleString()} URLs
                </span>
                {/* Only reachable once an analysis exists — this screen is
                    otherwise a step the pipeline passes straight through, with
                    nothing to go back to. */}
                {analysis && (
                  <Button variant="secondary" size="sm" onClick={() => setScreen('results')} disabled={saving}>
                    Cancel
                  </Button>
                )}
                <Button size="sm" onClick={confirmPatterns} loading={saving} disabled={saving}>
                  {saving ? 'Saving…' : analysis ? 'Confirm & Re-run Analysis' : 'Confirm Patterns'}
                </Button>
              </div>
            </div>
          </Card>

          <DataTable
            columns={[
              {
                key: 'included', label: '', sortable: false, width: 40,
                render: (v, row) => (
                  <input type="checkbox" checked={!!v} onChange={() => toggleIncluded(row.pattern)} style={{ cursor: 'pointer' }} />
                ),
              },
              { key: 'pattern', label: 'Pattern', mono: true },
              { key: 'count', label: 'Count', align: 'right' },
              {
                key: 'classification', label: 'Classification',
                render: (v) => {
                  const meta = CLASSIFICATION_META[v] || { label: v, variant: 'neutral' };
                  return <Badge variant={meta.variant}>{meta.label}</Badge>;
                },
              },
              {
                key: 'examples', label: 'Examples', sortable: false, maxWidth: 380, wrap: true,
                render: (v) => (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {(v || []).map((u) => <span key={u} style={{ fontSize: 11, color: 'var(--text-3)' }}>{u}</span>)}
                  </div>
                ),
              },
            ]}
            rows={patterns.map((p) => ({ id: p.pattern, ...p }))}
            striped
            emptyText="No patterns found."
          />

        </div>
      )}

      {screen === 'analyzing' && (
        <Card>
          <div style={{ marginBottom: 16 }}>
            <ProgressSteps steps={analyzeProgressSteps} layout="vertical" />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {analyzeSteps[currentAnalyzeStageId] || 'Starting…'}
          </div>
        </Card>
      )}

      {screen === 'results' && analysis && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Mean health and the run's own controls. The report below is about
              individual clusters; this is the one figure that is about the site,
              plus what you can do to the analysis as a whole. */}
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <HealthDonut value={meanHealth} />
                <div style={{ maxWidth: 520 }}>
                  {/* Every figure the four KPI boxes used to carry. They moved
                      here so the report's own four tiles stay a summary of hub
                      state rather than becoming one of eight numbers. */}
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{analysis.pages.length} pages analysed</span>
                    <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{analysis.clusters.length} clusters</span>
                    <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{totalSpokes} spokes mapped</span>
                    <span style={{ fontSize: 12.5, color: analysis.unassignedPages.length ? 'var(--text)' : 'var(--text-2)' }}>
                      {analysis.unassignedPages.length} unassigned ({pctUnassigned}%)
                    </span>
                    {analysis.orphanDetectionWithheld ? (
                      <span style={{ fontSize: 12.5, color: 'var(--text-2)' }} title="The crawl did not cover the whole site, so a page with no inbound link may be linked from a page it never fetched.">
                        orphans not assessed
                      </span>
                    ) : (
                      <span style={{ fontSize: 12.5, color: orphanCount ? 'var(--danger)' : 'var(--text-2)' }}>
                        {orphanCount} orphaned
                      </span>
                    )}
                  </div>
                  {selectionSummary ? (
                    <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 6 }}>
                      Informational pages only: {selectionSummary.analysedPageCount} of {selectionSummary.crawledPageCount} found in its sitemaps and listings.
                      {leftOut ? ` Left out: ${leftOut}.` : ''}
                    </div>
                  ) : project?.platformProjectId ? (
                    <div role="note" style={{ fontSize: 11.5, color: 'var(--warning)', marginTop: 6 }}>
                      This analysis includes every crawled page. Re-run it to cluster informational pages only.
                    </div>
                  ) : null}
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                    {estimatedCount > 0
                      ? `${estimatedCount} page(s) were estimated from their URL rather than crawled.`
                      : 'Every page in this selection was fully crawled.'}
                  </div>
                  {/* The health number appears on every row below, so what it
                      measures is said once, here, rather than nowhere. */}
                  <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 6, maxWidth: 460 }}>
                    <strong>Health</strong> (0-100, averaged across clusters) scores whether a cluster has a hub page, how well that hub covers the topic, a healthy spoke count, internal link density, and how many clicks its pages sit from the homepage.
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!project?.platformProjectId && <Button variant="secondary" size="sm" onClick={() => setScreen('patterns')}>Edit Pattern Selection</Button>}
                <Button variant="secondary" size="sm" onClick={project?.platformProjectId ? refreshProjectAnalysis : startAnalysis} loading={screen === 'analyzing'}>Re-run Analysis</Button>
                <Button size="sm" onClick={() => downloadExport('xlsx')} loading={exportingFormat === 'xlsx'} disabled={!!exportingFormat}>
                  Download Excel
                </Button>
                <Button variant="secondary" size="sm" onClick={() => downloadExport('md')} loading={exportingFormat === 'md'} disabled={!!exportingFormat}>
                  Download Markdown
                </Button>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Competitor domains:</span>
              <input
                type="text"
                value={competitorsText}
                onChange={(e) => setCompetitorsText(e.target.value)}
                placeholder="competitor1.com, competitor2.com"
                style={{ flex: '1 1 260px', minWidth: 200, fontSize: 12, padding: '5px 8px', borderRadius: 'var(--r-md)', border: '1px solid var(--border-strong)', background: 'var(--card)', color: 'var(--text)' }}
              />
              <Button variant="secondary" size="sm" onClick={saveCompetitors} loading={savingCompetitors}>Save</Button>
              <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                {competitorsFromProject
                  ? 'Filled in from this client’s competitor list. Save to use them for "Suggest new spokes" below.'
                  : 'Set once — used automatically by "Suggest new spokes" below, no need to re-enter.'}
              </span>
            </div>
          </Card>

          {analysis.crawlMeta?.sampled && (
            <Card style={{ background: 'var(--warning-soft)' }}>
              <div style={{ fontSize: 12 }}>
                This site's confirmed selection was large enough to trigger sampling — only {analysis.crawlMeta.sampleSize} pages were fully crawled for real content;
                the rest were grouped by URL alone. See the Summary tab in the download for the exact breakdown.
              </div>
            </Card>
          )}

          <HubSpokeReport
            analysis={analysis}
            pageById={pageById}
            navigate={navigate}
            projectId={id}
            siteName={project?.name}
            actionStatus={actionStatus}
            onSuggestions={(clusterId, result) => setAnalysis((prev) => ({
              ...prev,
              spokeSuggestionsByCluster: { ...(prev.spokeSuggestionsByCluster || {}), [clusterId]: result },
            }))}
          />

          <div style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center' }}>
            For the full retire/refresh reasoning, excluded-page detail, and every column, download the Excel above.
          </div>
        </div>
      )}

      {/* Scoped to this project: the run label the server records is `project <id>`. */}
      <ModuleRuns
        toolId="content-architect"
        title="Runs for this project"
        search={`project ${id}`}
        scopeNote="URL discovery, draft clustering, full analysis and exports for this project"
      />
    </div>
  );
}

function HealthDonut({ value }) {
  const color = `var(--${healthVariant(value)})`;
  return (
    <div style={{
      position: 'relative', width: 88, height: 88, flexShrink: 0, borderRadius: '50%',
      background: `conic-gradient(${color} ${value * 3.6}deg, var(--border) 0)`,
    }}>
      <div style={{
        position: 'absolute', inset: 6, borderRadius: '50%', background: 'var(--card)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
      }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', lineHeight: 1 }}>{value}</span>
        <span style={{ fontSize: 9, letterSpacing: '.08em', color: 'var(--text-3)' }}>HEALTH</span>
      </div>
    </div>
  );
}
