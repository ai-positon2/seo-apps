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
import { ca } from '../lib/contentArchitectApi';

const DISCOVER_STEPS = [
  { id: 'sitemap', label: 'Find sitemap' },
  { id: 'crawl-fallback', label: 'Crawl fallback' },
  { id: 'patterns', label: 'Group patterns' },
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

function healthVariant(score) {
  if (score >= 70) return 'success';
  if (score >= 40) return 'warning';
  return 'danger';
}

const HUB_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'needs-work', label: 'Needs work' },
  { key: 'no-hub', label: 'No hub page' },
];

function spokeStatusFor(page) {
  const flags = page.flags || [];
  if (flags.includes('orphan')) return { label: 'Orphaned', variant: 'danger', fix: 'no inbound links — add links from the hub or sibling spokes' };
  if (flags.includes('thin-or-stale')) return { label: 'Thin', variant: 'warning', fix: 'thin content — expand or refresh' };
  if (flags.includes('buried')) return { label: 'Buried', variant: 'neutral', fix: 'buried deep — reduce clicks from the homepage' };
  return { label: 'Healthy', variant: 'success', fix: null };
}

// Three highest-value fixes, computed from the real analysis rather than
// fixed content — only includes a move when its underlying condition
// actually applies, so a healthy site can show fewer than three (or none).
function buildPriorityMoves(analysis) {
  if (!analysis) return [];
  const moves = [];

  const gapClusters = analysis.clusters.filter((c) => c.isGap);
  if (gapClusters.length > 0) {
    const top = [...gapClusters].sort((a, b) => b.spokeIds.length - a.spokeIds.length).slice(0, 2);
    const body = gapClusters.length === 1
      ? `${gapClusters[0].name} has ${gapClusters[0].spokeIds.length} spoke${gapClusters[0].spokeIds.length === 1 ? '' : 's'} with no page to tie them together.`
      : `${gapClusters.length} clusters have spokes but no parent page. ${top.map((c) => c.name).join(' and ')} `
        + `${top.length > 1 ? 'are the largest opportunities' : 'is the largest opportunity'}.`;
    moves.push({
      title: `Write ${gapClusters.length} missing hub page${gapClusters.length === 1 ? '' : 's'}`,
      body, chipLabel: 'High impact', chipVariant: 'info',
    });
  }

  if (analysis.unassignedPages.length > 0) {
    const pct = Math.round((100 * analysis.unassignedPages.length) / Math.max(1, analysis.pages.length));
    moves.push({
      title: `Rescue ${analysis.unassignedPages.length} unassigned page${analysis.unassignedPages.length === 1 ? '' : 's'}`,
      body: `${pct}% of the site belongs to no cluster. Assign, merge or retire before commissioning anything new.`,
      chipLabel: 'Highest effort', chipVariant: 'danger',
    });
  }

  const orphanCount = analysis.pages.filter((p) => (p.flags || []).includes('orphan')).length;
  if (orphanCount > 0) {
    moves.push({
      title: `Link ${orphanCount} orphaned page${orphanCount === 1 ? '' : 's'}`,
      body: 'Capable pages with zero inbound internal links. A day of linking work, no new content required.',
      chipLabel: 'Quick win', chipVariant: 'success',
    });
  }

  return moves.slice(0, 3).map((m, i) => ({ ...m, n: String(i + 1).padStart(2, '0') }));
}

const CLASSIFICATION_META = {
  article: { label: 'Article', variant: 'success' },
  service: { label: 'Service', variant: 'info' },
  location: { label: 'Location', variant: 'info' },
  exclude: { label: 'Exclude', variant: 'danger' },
  static: { label: 'Static', variant: 'neutral' },
  unknown: { label: 'Unknown', variant: 'warning' },
};

const VERTICAL_OPTIONS = ['dental', 'healthcare', 'legal', 'saas', 'ecommerce', 'home-services', 'other'];

export default function ContentArchitectProjectPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [project, setProject] = useState(null);
  const [screen, setScreen] = useState('loading'); // loading | discovering | patterns | clusters | analyzing | results
  const [steps, setSteps] = useState({});
  const [error, setError] = useState(null);
  const [patterns, setPatterns] = useState([]);
  const [vertical, setVertical] = useState(null);
  const [discoverMeta, setDiscoverMeta] = useState(null);
  const [saving, setSaving] = useState(false);
  const [clusterResult, setClusterResult] = useState(null);
  const [clustering, setClustering] = useState(false);
  const [showUnassigned, setShowUnassigned] = useState(false);
  const [analyzeSteps, setAnalyzeSteps] = useState({});
  const [analysis, setAnalysis] = useState(null);
  const [exportingFormat, setExportingFormat] = useState(null);
  const [selectedClusterId, setSelectedClusterId] = useState(null);
  const [hubFilter, setHubFilter] = useState('all');
  const esRef = useRef(null);
  const startedRef = useRef(false);

  useEffect(() => () => esRef.current?.close(), []);

  useEffect(() => {
    (async () => {
      try {
        const proj = await ca.getProject(id);
        setProject(proj);
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
            return;
          }
          const existingClusters = await ca.getClusters(id).catch(() => null);
          if (existingClusters) {
            setClusterResult(existingClusters);
            setScreen('clusters');
          } else {
            setScreen('patterns');
          }
        }
      } catch (e) {
        setError(e.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
        setScreen('patterns');
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

  async function confirmPatterns() {
    setSaving(true);
    try {
      await ca.savePatterns(id, patterns.map((p) => ({ pattern: p.pattern, included: p.included })), vertical);
      setSaving(false);
      setClustering(true);
      setScreen('clusters');
      const result = await ca.computeDraftClusters(id);
      setClusterResult(result);
    } catch (e) {
      toast.add({ title: 'Save failed', description: e.message, variant: 'danger' });
      setScreen('patterns');
    } finally {
      setSaving(false);
      setClustering(false);
    }
  }

  async function recomputeClusters() {
    setClustering(true);
    try {
      const result = await ca.computeDraftClusters(id);
      setClusterResult(result);
    } catch (e) {
      toast.add({ title: 'Clustering failed', description: e.message, variant: 'danger' });
    } finally {
      setClustering(false);
    }
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
          setScreen('clusters');
        }
      });
      es.addEventListener('fail', (e) => {
        const d = JSON.parse(e.data);
        setError(d.message);
        setScreen('clusters');
      });
      es.addEventListener('done', () => es.close());
      es.onerror = () => es.close();
    } catch (e) {
      setError(e.message);
      setScreen('clusters');
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
  const sortedClusters = useMemo(
    () => [...(analysis?.clusters || [])].sort((a, b) => (a.health || 0) - (b.health || 0)),
    [analysis]
  );
  const filteredClusters = useMemo(() => sortedClusters.filter((c) => (
    hubFilter === 'no-hub' ? c.isGap : hubFilter === 'needs-work' ? c.health < 60 : true
  )), [sortedClusters, hubFilter]);
  const estimatedCount = analysis?.pages.filter((p) => p.estimated).length || 0;
  const meanHealth = analysis?.clusters.length
    ? Math.round(analysis.clusters.reduce((s, c) => s + (c.health || 0), 0) / analysis.clusters.length)
    : 0;
  const gapCount = analysis?.clusters.filter((c) => c.isGap).length || 0;
  const orphanCount = analysis?.pages.filter((p) => (p.flags || []).includes('orphan')).length || 0;
  const totalSpokes = analysis?.clusters.reduce((s, c) => s + c.spokeIds.length, 0) || 0;
  const pctUnassigned = analysis
    ? Math.round((100 * analysis.unassignedPages.length) / Math.max(1, analysis.pages.length))
    : 0;
  const insightSentence = !analysis || !analysis.clusters.length
    ? 'No clusters were found for this selection.'
    : gapCount === 0 && orphanCount === 0
      ? 'Structure looks solid — every cluster has a hub, and no pages are orphaned.'
      : `${gapCount} of ${analysis.clusters.length} cluster${analysis.clusters.length === 1 ? '' : 's'} `
        + `${gapCount === 1 ? 'has' : 'have'} no hub page, and ${orphanCount} page${orphanCount === 1 ? '' : 's'} `
        + `link${orphanCount === 1 ? 's' : ''} to nothing.`;
  const selectedCluster = selectedClusterId && selectedClusterId !== 'unassigned'
    ? analysis?.clusters.find((c) => c.id === selectedClusterId) || null
    : null;
  const priorityMoves = useMemo(() => buildPriorityMoves(analysis), [analysis]);

  useEffect(() => {
    if (analysis) setSelectedClusterId(analysis.clusters.length ? sortedClusters[0].id : (analysis.unassignedPages.length ? 'unassigned' : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis]);

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
            <Button variant="secondary" size="sm" onClick={startDiscovery}>Retry</Button>
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
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                Analyzing {selectedUrls.toLocaleString()} of {totalUrls.toLocaleString()} URLs
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

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={confirmPatterns} loading={saving} disabled={saving}>
              {saving ? 'Saving…' : 'Confirm Patterns'}
            </Button>
          </div>
        </div>
      )}

      {screen === 'clusters' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card style={{ background: 'var(--warning-soft)' }}>
            <div style={{ fontSize: 13 }}>
              <strong>Draft — based on URLs only.</strong> These clusters come from slug text alone, with mechanical names (no page content read yet, no AI naming). Checkpoint 3+ will crawl actual page content and improve both grouping and naming.
            </div>
          </Card>

          <Card>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ fontSize: 13 }}>
                {clustering ? 'Clustering…' : clusterResult ? (
                  <>
                    <strong>{clusterResult.clusters.length}</strong> clusters ·{' '}
                    <strong>{clusterResult.unassigned.length}</strong> unassigned
                    {' '}({Math.round((100 * clusterResult.unassigned.length) / Math.max(1, clusterResult.clusters.reduce((s, c) => s + c.urls.length, 0) + clusterResult.unassigned.length))}%)
                  </>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" size="sm" onClick={() => setScreen('patterns')}>Edit Pattern Selection</Button>
                <Button variant="secondary" size="sm" onClick={recomputeClusters} loading={clustering} disabled={clustering}>
                  Recompute
                </Button>
                <Button size="sm" onClick={startAnalysis} disabled={clustering || !clusterResult}>
                  Run Full Analysis →
                </Button>
              </div>
            </div>
          </Card>

          <Card style={{ background: 'var(--info-soft)' }}>
            <div style={{ fontSize: 12 }}>
              "Run Full Analysis" reads every confirmed page's actual content, builds a real internal link graph, names clusters with AI, and picks a hub page for each topic. Takes a few minutes depending on site size.
            </div>
          </Card>

          {clustering && !clusterResult && <EmptyState title="Clustering…" description="Slug-only draft clustering — no network calls, should only take a moment." />}

          {clusterResult && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
              {clusterResult.clusters.map((c, i) => (
                <Card key={i}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                    <strong style={{ fontSize: 14 }}>{c.name}</strong>
                    <Badge variant="warning">Draft</Badge>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>
                    {c.urls.length} pages · mean similarity {c.meanSimilarity.toFixed(2)}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 220, overflowY: 'auto' }}>
                    {c.urls.map((u) => (
                      <div key={u} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-2)' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u}>
                          {u.replace(project?.domain || '', '')}
                        </span>
                        {c.dualClusterUrls?.includes(u) && <Badge variant="info" style={{ flexShrink: 0 }}>dual</Badge>}
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          )}

          {clusterResult?.unassigned?.length > 0 && (
            <Card>
              <button
                onClick={() => setShowUnassigned((v) => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 13, fontWeight: 600, color: 'var(--text)' }}
              >
                {showUnassigned ? '▾' : '▸'} Unassigned ({clusterResult.unassigned.length})
              </button>
              {showUnassigned && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 10, maxHeight: 400, overflowY: 'auto' }}>
                  {clusterResult.unassigned.map((u) => (
                    <span key={u} style={{ fontSize: 11, color: 'var(--text-3)' }}>{u.replace(project?.domain || '', '')}</span>
                  ))}
                </div>
              )}
            </Card>
          )}
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <HealthDonut value={meanHealth} />
                <div style={{ maxWidth: 480 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4 }}>{insightSentence}</div>
                  <div style={{ display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{analysis.pages.length} pages analyzed</span>
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{analysis.clusters.length} clusters</span>
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{totalSpokes} spokes mapped</span>
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 6, maxWidth: 460 }}>
                    <strong>Health</strong> (0–100, averaged across clusters) scores whether a cluster has a hub page, how well that hub covers the topic, a healthy spoke count, internal link density, and how many clicks its pages sit from the homepage.
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button variant="secondary" size="sm" onClick={() => setScreen('clusters')}>Back to Draft</Button>
                <Button variant="secondary" size="sm" onClick={startAnalysis} loading={screen === 'analyzing'}>Re-run Analysis</Button>
                <Button size="sm" onClick={() => downloadExport('xlsx')} loading={exportingFormat === 'xlsx'} disabled={!!exportingFormat}>
                  Download Excel
                </Button>
                <Button variant="secondary" size="sm" onClick={() => downloadExport('md')} loading={exportingFormat === 'md'} disabled={!!exportingFormat}>
                  Download Markdown
                </Button>
              </div>
            </div>
          </Card>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <KpiBox label="Pages analysed" value={analysis.pages.length} note={estimatedCount > 0 ? `${estimatedCount} estimated, not crawled` : 'all fully crawled'} />
            <KpiBox label="Clusters" value={analysis.clusters.length} note={gapCount ? `${gapCount} without a hub` : 'every cluster has a hub'} tone={gapCount ? 'warning' : null} />
            <KpiBox label="Unassigned" value={analysis.unassignedPages.length} note={`${pctUnassigned}% of the site`} tone={pctUnassigned > 20 ? 'danger' : null} />
            <KpiBox label="Orphaned pages" value={orphanCount} note="no inbound internal links" tone={orphanCount ? 'danger' : null} />
          </div>

          {priorityMoves.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)', marginBottom: 10 }}>DO THESE FIRST</div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${priorityMoves.length}, minmax(0, 1fr))`, gap: 12 }}>
                {priorityMoves.map((m) => (
                  <Card key={m.n}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)' }}>{m.n}</span>
                      <Badge variant={m.chipVariant}>{m.chipLabel}</Badge>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>{m.title}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{m.body}</div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {analysis.crawlMeta?.sampled && (
            <Card style={{ background: 'var(--warning-soft)' }}>
              <div style={{ fontSize: 12 }}>
                This site's confirmed selection was large enough to trigger sampling — only {analysis.crawlMeta.sampleSize} pages were fully crawled for real content;
                the rest were grouped by URL alone. See the Summary tab in the download for the exact breakdown.
              </div>
            </Card>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 340px) minmax(0, 1fr)', gap: 16, alignItems: 'flex-start' }}>
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', color: 'var(--text-3)' }}>CLUSTERS · {analysis.clusters.length}</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {HUB_FILTERS.map((f) => (
                    <button
                      key={f.key}
                      onClick={() => setHubFilter(f.key)}
                      style={{
                        cursor: 'pointer', fontSize: 11, fontWeight: 500, padding: '5px 10px', borderRadius: 'var(--r-pill)',
                        border: hubFilter === f.key ? '1px solid var(--primary)' : '1px solid var(--border)',
                        background: hubFilter === f.key ? 'var(--primary-soft)' : 'transparent',
                        color: hubFilter === f.key ? 'var(--primary-text)' : 'var(--text-3)',
                      }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ maxHeight: 560, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {filteredClusters.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedClusterId(c.id)}
                    style={{
                      textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6, padding: 12,
                      borderRadius: 'var(--r-md)',
                      border: selectedClusterId === c.id ? '1px solid var(--primary)' : '1px solid var(--border)',
                      background: selectedClusterId === c.id ? 'var(--primary-soft)' : 'var(--surface)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: `var(--${healthVariant(c.health)})`, flexShrink: 0 }}>{c.health}</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${c.health}%`, borderRadius: 2, background: `var(--${healthVariant(c.health)})` }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{c.spokeIds.length} spokes</span>
                      <Badge variant={c.isGap ? 'danger' : 'success'}>{c.isGap ? 'No hub' : 'Hub live'}</Badge>
                    </div>
                  </button>
                ))}
                {filteredClusters.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 4px' }}>No clusters match this filter.</div>
                )}

                {analysis.unassignedPages.length > 0 && (
                  <button
                    onClick={() => setSelectedClusterId('unassigned')}
                    style={{
                      textAlign: 'left', cursor: 'pointer', marginTop: 4, padding: 12, borderRadius: 'var(--r-md)', display: 'flex', flexDirection: 'column', gap: 4,
                      border: selectedClusterId === 'unassigned' ? '1px solid var(--primary)' : '1px dashed var(--border)',
                      background: selectedClusterId === 'unassigned' ? 'var(--primary-soft)' : 'transparent',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Unassigned pages</span>
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{pctUnassigned}%</span>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{analysis.unassignedPages.length} pages belong to no cluster</span>
                  </button>
                )}
              </div>
            </Card>

            <Card style={{ minHeight: 360 }}>
              {selectedClusterId === 'unassigned' ? (
                <UnassignedPanel pages={analysis.unassignedPages} />
              ) : selectedCluster ? (
                <ClusterDetailPanel cluster={selectedCluster} pageById={pageById} />
              ) : (
                <EmptyState title="No cluster selected" description="Pick a cluster from the list on the left." />
              )}
            </Card>
          </div>

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

function KpiBox({ label, value, note, tone }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px',
      borderRadius: 'var(--r-md)', background: 'var(--card)', border: '1px solid var(--border)',
    }}>
      <span style={{ fontSize: 10, letterSpacing: '.06em', color: 'var(--text-3)' }}>{label.toUpperCase()}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color: tone ? `var(--${tone})` : 'var(--text)' }}>{value}</span>
      {note && <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{note}</span>}
    </div>
  );
}

// ── Enhance ─────────────────────────────────────────────────────────────────
//
// Hub and Spoke identifies the pages; Enhance Existing Article is what you do
// about them. They were two tools with no path between them: you read a spoke
// URL here, went to the sidebar, found the enhancer, and pasted the URL back in.
//
// The content type carries over because it changes what the enhancer does — a
// hub is a navigational page judged on how well it covers and links a topic, a
// spoke is long-form judged on depth. Sending every page over as "article" would
// have the enhancer rewrite a hub as if it were one.
//
// Both values land as ordinary initial state on the other side, so they stay
// editable: this is a prefill, not a lock.
function enhanceHref(url, contentType) {
  return `/article-enhancement?url=${encodeURIComponent(url)}&contentType=${contentType}`;
}

function EnhanceButton({ url, contentType, navigate, style }) {
  if (!url) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); navigate(enhanceHref(url, contentType)); }}
      title={`Open this ${contentType === 'hub' ? 'hub' : 'page'} in Enhance Existing Article`}
      style={{
        fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)', background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px',
        cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap', ...style,
      }}
    >
      Enhance
    </button>
  );
}

function ClusterDetailPanel({ cluster: c, pageById }) {
  const navigate = useNavigate();
  const hub = c.hubPageId ? pageById.get(c.hubPageId) : null;
  const spokes = c.spokeIds.map((sid) => pageById.get(sid)).filter(Boolean);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 19, fontWeight: 600, color: 'var(--text)' }}>{c.name}</h3>
            <Badge variant={c.isGap ? 'danger' : 'success'}>{c.isGap ? 'No hub page' : 'Hub page live'}</Badge>
            {c.ambiguous && <Badge variant="warning">Ambiguous hub</Badge>}
          </div>
          {c.description && <p style={{ margin: 0, fontSize: 13, color: 'var(--text-3)', maxWidth: 640 }}>{c.description}</p>}
        </div>
        <Badge variant={healthVariant(c.health)} style={{ fontSize: 13, padding: '4px 12px', height: 'auto', flexShrink: 0 }}>Health {c.health}/100</Badge>
      </div>

      {c.isGap ? (
        <div style={{ padding: 14, borderRadius: 'var(--r-md)', border: '1px solid var(--danger)', background: 'var(--danger-soft)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Suggested new page: {c.gapSuggestion?.title}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{c.gapSuggestion?.slug}</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
            Would tie together {spokes.length} existing page{spokes.length === 1 ? '' : 's'} below.
          </div>
        </div>
      ) : hub && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 'var(--r-md)', border: '1px solid var(--warning)', background: 'var(--warning-soft)' }}>
          <Badge variant="warning">HUB</Badge>
          <a href={hub.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {hub.title || hub.url}
          </a>
          {hub.wordCount ? <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto', flexShrink: 0 }}>{hub.wordCount.toLocaleString()} words</span> : null}
          <EnhanceButton
            url={hub.url}
            contentType="hub"
            navigate={navigate}
            style={hub.wordCount ? undefined : { marginLeft: 'auto' }}
          />
        </div>
      )}

      <div>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', color: 'var(--text-3)' }}>SPOKES · {spokes.length}</span>
        {spokes.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>No spoke pages in this cluster.</div>
        ) : (
          <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--border)', overflow: 'hidden', marginTop: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 90px 100px 92px', gap: 12, padding: '8px 14px', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)' }}>SPOKE PAGE</span>
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)' }}>WORDS</span>
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)' }}>STATUS</span>
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)' }}>ACTION</span>
            </div>
            {spokes.map((s, i) => {
              const st = spokeStatusFor(s);
              return (
                <div
                  key={s.id}
                  style={{
                    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 90px 100px 92px', gap: 12, padding: '10px 14px', alignItems: 'center',
                    borderBottom: i < spokes.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <a href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--text)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title || s.url}
                    </a>
                    <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                      {st.fix || `${s.inboundLinkCount || 0} inbound link${s.inboundLinkCount === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{s.wordCount ? s.wordCount.toLocaleString() : '—'}</span>
                  <Badge variant={st.variant}>{st.label}</Badge>
                  {/* A spoke is long-form, so it goes over as an article. */}
                  <EnhanceButton url={s.url} contentType="article" navigate={navigate} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function UnassignedPanel({ pages }) {
  return (
    <div>
      <h3 style={{ margin: 0, fontSize: 19, fontWeight: 600, color: 'var(--text)' }}>Unassigned pages</h3>
      <p style={{ margin: '4px 0 14px', fontSize: 13, color: 'var(--text-3)' }}>
        {pages.length} page{pages.length === 1 ? '' : 's'} didn't clear the similarity bar for any cluster — each shows the cluster it came closest to.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 480, overflowY: 'auto' }}>
        {pages.map((p) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)' }}>
            <a href={p.url} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.title || p.url}
            </a>
            {p.nearestCluster && (
              <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
                closest: {p.nearestCluster.clusterName} ({Math.round(p.nearestCluster.similarity * 100)}%)
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
