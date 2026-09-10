import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { SectionHeader } from '../ui/SectionHeader';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Field } from '../ui/Field';
import { useToast } from '../ui/Toast';
import ModuleRuns from '../components/ModuleRuns';
import { ca } from '../lib/contentArchitectApi';
import { projectsApi } from '../lib/projectsApi';
import { useActiveProjectId } from '../lib/activeProject';

const STATE_LABELS = {
  created: 'Input',
  discovering: 'Discovering',
  patterns: 'Patterns Ready',
  analyzing: 'Analyzing',
  reviewing: 'Review',
  complete: 'Complete',
  analyzed: 'Ready',
  waiting_for_crawl: 'Waiting for crawl',
  queued: 'Queued',
  failed: 'Failed',
  insufficient_data: 'Not enough pages',
  not_started: 'Not started',
};
const STATE_VARIANTS = {
  created: 'neutral',
  discovering: 'info',
  patterns: 'brand',
  analyzing: 'info',
  reviewing: 'warning',
  complete: 'success',
  analyzed: 'success',
  waiting_for_crawl: 'info',
  queued: 'info',
  failed: 'danger',
  insufficient_data: 'warning',
  not_started: 'warning',
};

function CreateProjectCard({ onCreate, creating }) {
  const [domain, setDomain] = useState('');
  const [error, setError] = useState(null);

  async function submit() {
    if (!domain.trim()) return;
    setError(null);
    try {
      await onCreate(domain.trim());
      setDomain('');
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Card title="New Project">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field
          label="Domain"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="example.com"
          error={error}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={submit} loading={creating} disabled={!domain.trim() || creating}>
            {creating ? 'Checking domain…' : 'Create Project'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function ContentArchitectPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [activeProjectId] = useActiveProjectId();
  const [connectionResult, setConnection] = useState(null);
  const connection = connectionResult?.project.platformProjectId === activeProjectId ? connectionResult : null;
  const [connectionError, setConnectionError] = useState(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (activeProjectId) return undefined;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await ca.projects();
        if (!cancelled) setProjects(list);
      } catch (e) {
        if (!cancelled) toast.add({ title: 'Could not load projects', description: e.message, variant: 'danger' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return undefined;
    let cancelled = false;
    let timer;
    let connected = false;
    setConnection(null);
    setConnectionError(null);
    async function refresh() {
      try {
        const result = connected
          ? await projectsApi.contentArchitect(activeProjectId)
          : await projectsApi.connectContentArchitect(activeProjectId);
        if (cancelled) return;
        connected = true;
        setConnection(result);
        setConnectionError(null);
      } catch (e) {
        if (!cancelled) setConnectionError(e.message);
      }
      if (!cancelled) timer = setTimeout(() => refresh(), 5000);
    }
    refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeProjectId, retryVersion]);

  async function retryAnalysis() {
    const projectId = activeProjectId;
    setCreating(true);
    try {
      await projectsApi.connectContentArchitect(projectId, { retry: true });
      setRetryVersion((v) => v + 1);
    } catch (e) {
      toast.add({ title: 'Could not start analysis', description: e.message, variant: 'danger' });
    } finally {
      setCreating(false);
    }
  }

  async function handleCreate(domain) {
    setCreating(true);
    try {
      const project = await ca.createProject(domain);
      navigate(`/content-architect/${project.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id, e) {
    e.stopPropagation();
    try {
      await ca.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (e2) {
      toast.add({ title: 'Delete failed', description: e2.message, variant: 'danger' });
    }
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <SectionHeader
        eyebrow="Build"
        title="Content Architect"
        subtitle={activeProjectId
          ? 'Automatically organizes your project’s crawled pages into topic clusters and shows what’s missing.'
          : "Point it at a domain — it reads your sitemap, organizes your existing articles into topic clusters, and shows you what's missing."}
      />

      {activeProjectId ? (
        <Card title={connection?.project.name || 'Content Architect for your project'}>
          {connectionError && <div role="alert" style={{ color: 'var(--danger)', marginBottom: 12 }}>{connectionError}</div>}
          {connection ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span>{connection.project.domain}</span>
                <Badge variant={STATE_VARIANTS[connection.state] || 'neutral'}>
                  {STATE_LABELS[connection.state] || connection.state}
                </Badge>
              </div>
              <div style={{ color: 'var(--text-2)', fontSize: 13 }}>{connection.note}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {connection.ready && <Button onClick={() => navigate(`/content-architect/${connection.project.id}`)}>Open analysis</Button>}
                {connection.canStartRun && ['failed', 'cancelled', 'insufficient_data', 'not_started'].includes(connection.state) && (
                  <Button variant="secondary" onClick={retryAnalysis} loading={creating}>Retry analysis</Button>
                )}
                <Button variant="secondary" onClick={() => navigate('/')}>View project</Button>
              </div>
            </div>
          ) : <EmptyState title={connectionError ? 'Could not connect this project' : 'Setting up Content Architect…'} />}
        </Card>
      ) : <>
      <div style={{ marginBottom: 24, maxWidth: 480 }}>
        <CreateProjectCard onCreate={handleCreate} creating={creating} />
      </div>

      {loading ? (
        <EmptyState title="Loading projects…" />
      ) : projects.length === 0 ? (
        <EmptyState title="No projects yet" description="Create one above to get started." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {projects.map((p) => (
            <Card key={p.id} interactive onClick={() => navigate(`/content-architect/${p.id}`)}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{p.name}</div>
                <Badge variant={STATE_VARIANTS[p.workflowState] || 'neutral'}>{STATE_LABELS[p.workflowState] || p.workflowState}</Badge>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>{p.domain}</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{new Date(p.createdAt).toLocaleDateString()}</span>
                <Button variant="ghost" size="sm" onClick={(e) => handleDelete(p.id, e)}>Delete</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      </>}

      <ModuleRuns toolId="content-architect" />
    </div>
  );
}
