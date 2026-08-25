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

const STATE_LABELS = {
  created: 'Input',
  discovering: 'Discovering',
  patterns: 'Patterns Ready',
  analyzing: 'Analyzing',
  reviewing: 'Review',
  complete: 'Complete',
};
const STATE_VARIANTS = {
  created: 'neutral',
  discovering: 'info',
  patterns: 'brand',
  analyzing: 'info',
  reviewing: 'warning',
  complete: 'success',
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
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setProjects(await ca.projects());
      } catch (e) {
        toast.add({ title: 'Could not load projects', description: e.message, variant: 'danger' });
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        subtitle="Point it at a domain — it reads your sitemap, organizes your existing articles into topic clusters, and shows you what's missing."
      />

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

      <ModuleRuns toolId="content-architect" />
    </div>
  );
}
